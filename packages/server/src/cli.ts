// The `rennet` CLI (issue #379, design D8) — the daemon's second client, proving the
// protocol is real by driving it from a terminal with no window in sight.
// `node:util` parseArgs, no prompts, honest exit codes:
//   serve   run the daemon in the FOREGROUND (dev / power tool; the packaged app spawns
//           its own detached daemon and never depends on this).
//   status  read the daemon.json claim and probe /healthz; print pid/port/versions.
//   stop    SIGTERM the claimed pid and wait (bounded) for the claim to disappear.
//   pair    mint a device pairing code on the running daemon.
//   devices list or revoke paired devices on the running daemon.
//   map     build & store the Repo Map for a repository — daemonless, the same
//           generator `project.process` runs, persisting to ~/.rennet/projects/.
// It reuses the exact supervision helpers the desktop shell uses — no reimplemented
// protocol-compat or claim logic to drift.

import { existsSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  createClaudeHarness,
  enrichKnowledgeForRepo,
  type GenerateResult,
  KnowledgeStore,
  ProjectContextReader,
  ProjectSnapshotGenerator,
  type ProjectSnapshotStore,
  runKnowledgeDeltaForRepo,
  snapshotStoreFor,
} from "@rennet/adapters";
import { materializeSnapshot, queryFileOverview, queryProjectMap } from "@rennet/core";
import { PROTOCOL_VERSION, parseSessionFrame } from "@rennet/protocol";
import type { ProjectSnapshotManifest } from "@rennet/types";
import { WebSocket } from "ws";
import { defaultDataDir, runDaemon } from "./daemon";
import { readDaemonFile, removeDaemonFile } from "./daemon-file";
import { findHealthyDaemon } from "./supervise";

export interface CliIo {
  out(line: string): void;
  err(line: string): void;
}

const defaultIo: CliIo = {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
};

export interface CliDeps {
  readonly probe: typeof findHealthyDaemon;
  readonly kill: (pid: number, signal: "SIGTERM") => void;
}

const defaultDeps: CliDeps = {
  probe: findHealthyDaemon,
  kill: (pid, signal) => {
    process.kill(pid, signal);
  },
};

const HELP = [
  "rennet — the local review daemon",
  "",
  "Usage:",
  "  rennet serve   [--data-dir <dir>] [--ui-dist <dir>]   run the daemon in the foreground",
  "  rennet status  [--data-dir <dir>]   report the daemon's health",
  "  rennet stop    [--data-dir <dir>]   stop the running daemon",
  "  rennet pair    [--data-dir <dir>]   mint a device pairing code (5-minute TTL)",
  "  rennet devices [--revoke <id>] [--data-dir <dir>]   list or revoke paired devices",
  "  rennet map     [path] [--base <ref>] [--json <file>] [--projects-dir <dir>] [--enrich]   build & store the repo map",
  "",
  "The data dir defaults to $RENNET_USER_DATA, then the platform user-data path.",
  "`rennet map` needs no daemon: it builds the Repo Map for the repository at <path>",
  "(default: the current directory) and stores it under ~/.rennet/projects/.",
  "`--enrich` additionally runs the model-backed knowledge pass (initial or delta)",
  "through your installed Claude harness — one bounded turn, on your subscription.",
  "`--model <id>` picks the harness model for that turn (e.g. claude-sonnet-5).",
].join("\n");

/** Route argv to a subcommand. Returns a process exit code (serve never returns). */
export async function runCli(
  argv: readonly string[],
  io: CliIo = defaultIo,
  env: NodeJS.ProcessEnv = process.env,
  deps: CliDeps = defaultDeps,
): Promise<number> {
  const [subcommand, ...rest] = argv;
  switch (subcommand) {
    case "serve": {
      let parsed: { "data-dir"?: string; "ui-dist"?: string };
      try {
        parsed = parseArgs({
          args: [...rest],
          allowPositionals: false,
          strict: true,
          options: { "data-dir": { type: "string" }, "ui-dist": { type: "string" } },
        }).values;
      } catch (error) {
        io.err(`rennet serve: ${error instanceof Error ? error.message : String(error)}`);
        io.err("Usage: rennet serve [--data-dir <dir>] [--ui-dist <dir>]");
        return 2;
      }
      const dataDir =
        parsed["data-dir"] ?? env.RENNET_USER_DATA ?? defaultDataDir(process.platform, env);
      return serve(dataDir, parsed["ui-dist"] ?? defaultUiDist(), io, env, deps);
    }
    case "status":
    case "stop":
    case "pair": {
      let dataDir: string;
      try {
        dataDir = parseDataDir(rest, env);
      } catch (error) {
        io.err(`rennet ${subcommand}: ${error instanceof Error ? error.message : String(error)}`);
        io.err(`Usage: rennet ${subcommand} [--data-dir <dir>]`);
        return 2;
      }
      if (subcommand === "status") return status(dataDir, io, deps);
      if (subcommand === "pair") return pair(dataDir, io, deps);
      return stop(dataDir, io, deps);
    }
    case "devices": {
      let parsed: { "data-dir"?: string; revoke?: string };
      try {
        parsed = parseArgs({
          args: [...rest],
          allowPositionals: false,
          strict: true,
          options: { "data-dir": { type: "string" }, revoke: { type: "string" } },
        }).values;
      } catch (error) {
        io.err(`rennet devices: ${error instanceof Error ? error.message : String(error)}`);
        io.err("Usage: rennet devices [--revoke <id>] [--data-dir <dir>]");
        return 2;
      }
      const dataDir =
        parsed["data-dir"] ?? env.RENNET_USER_DATA ?? defaultDataDir(process.platform, env);
      return devices(dataDir, parsed.revoke, io, deps);
    }
    case "map": {
      let parsed: {
        values: {
          base?: string;
          json?: string;
          "projects-dir"?: string;
          enrich?: boolean;
          model?: string;
        };
        positionals: string[];
      };
      try {
        parsed = parseArgs({
          args: [...rest],
          allowPositionals: true,
          strict: true,
          options: {
            base: { type: "string" },
            json: { type: "string" },
            "projects-dir": { type: "string" },
            enrich: { type: "boolean" },
            model: { type: "string" },
          },
        });
        if (parsed.positionals.length > 1) throw new Error("expected at most one repository path");
      } catch (error) {
        io.err(`rennet map: ${error instanceof Error ? error.message : String(error)}`);
        io.err(
          "Usage: rennet map [path] [--base <ref>] [--json <file>] [--projects-dir <dir>] [--enrich] [--model <id>]",
        );
        return 2;
      }
      return buildMap(
        parsed.positionals[0] ?? process.cwd(),
        {
          base: parsed.values.base,
          json: parsed.values.json,
          projectsDir: parsed.values["projects-dir"],
          enrich: parsed.values.enrich === true,
          model: parsed.values.model,
        },
        io,
        env,
      );
    }
    case "-h":
    case "--help":
      io.out(HELP);
      return 0;
    case undefined:
      io.err(HELP);
      return 2;
    default:
      io.err(`rennet: unknown command '${subcommand}'`);
      io.err(HELP);
      return 2;
  }
}

function parseDataDir(argv: readonly string[], env: NodeJS.ProcessEnv): string {
  const { values } = parseArgs({
    args: [...argv],
    allowPositionals: false,
    strict: true,
    options: { "data-dir": { type: "string" } },
  });
  return values["data-dir"] ?? env.RENNET_USER_DATA ?? defaultDataDir(process.platform, env);
}

/**
 * The served browser UI (issue #381, design D2): by convention `dist/browser` sits beside
 * the server bundle. In the standalone `rennet` CLI (esbuild) import.meta.url is empty, so
 * this yields undefined and `rennet serve` is headless unless `--ui-dist` is passed; the
 * packaged app's own daemon (dist/server sibling) resolves its browser bundle directly.
 */
function defaultUiDist(): string | undefined {
  try {
    const url = import.meta.url;
    if (!url) return undefined;
    const candidate = resolve(dirname(fileURLToPath(url)), "../browser");
    return existsSync(candidate) ? candidate : undefined;
  } catch {
    return undefined;
  }
}

/** Run the daemon in the foreground; resolves never (the process lives until a signal). */
async function serve(
  dataDir: string,
  uiDist: string | undefined,
  io: CliIo,
  env: NodeJS.ProcessEnv,
  deps: CliDeps,
): Promise<number> {
  const verdict = await deps.probe(dataDir);
  if (verdict.kind === "healthy") {
    io.err(`already running (pid ${verdict.identity.pid}, port ${verdict.identity.wsPort})`);
    return 1;
  }
  const config = {
    dataDir,
    serverVersion: env.RENNET_SERVER_VERSION ?? "0.0.0-dev",
    env,
    uiDist,
  };
  const daemon = await runDaemon(config);
  io.out(
    `rennet daemon listening on ${daemon.info.host ?? "127.0.0.1"}:${daemon.info.wsPort} (pid ${daemon.info.pid}, v${daemon.info.version})`,
  );
  io.out(`data dir: ${config.dataDir}`);
  // Hold the process open: the WS listener + watchers keep the event loop alive, and the
  // SIGTERM/SIGINT handlers runDaemon installed call process.exit(0) on stop. The executor
  // never settles the promise on purpose — the process ends by signal, not by resolution.
  return new Promise<number>(() => undefined);
}

/** Read the claim, probe it, and print an honest verdict. Exit 0 only when running + compatible. */
async function status(dataDir: string, io: CliIo, deps: CliDeps): Promise<number> {
  const verdict = await deps.probe(dataDir);
  switch (verdict.kind) {
    case "healthy":
      io.out(
        `running (pid ${verdict.identity.pid}, ${verdict.identity.host ?? "127.0.0.1"}:${verdict.identity.wsPort}, v${verdict.identity.version}, protocol ${verdict.identity.protocolVersion})`,
      );
      return 0;
    case "incompatible":
      // D10: surface both sides, restart nothing — that policy belongs to the app that
      // owns the newer bundle, not the CLI.
      io.err(
        `running but protocol-incompatible: daemon protocol ${verdict.identity.protocolVersion} (v${verdict.identity.version}); ${verdict.reason}`,
      );
      return 1;
    case "stale":
      io.err(
        `stale pidfile (pid ${verdict.claim.pid} not responding on port ${verdict.claim.wsPort})`,
      );
      return 1;
    case "absent":
      io.out("not running");
      return 1;
  }
}

/** SIGTERM the claimed pid and wait (bounded) for the claim to clear. No prompt. */
async function stop(dataDir: string, io: CliIo, deps: CliDeps): Promise<number> {
  const verdict = await deps.probe(dataDir);
  if (verdict.kind === "absent") {
    io.out("not running");
    return 0;
  }
  if (verdict.kind === "stale") {
    const removed = removeDaemonFile(dataDir, verdict.claim.pid);
    io.out(
      removed
        ? `removed stale pidfile (pid ${verdict.claim.pid} was not a verified daemon)`
        : `stale pidfile changed before removal (pid ${verdict.claim.pid} was not signalled)`,
    );
    return 0;
  }
  const claim = verdict.claim;
  try {
    deps.kill(claim.pid, "SIGTERM");
  } catch (error) {
    // ESRCH: the pid is already gone — the claim is stale. Clear it and report success.
    if ((error as NodeJS.ErrnoException).code === "ESRCH") {
      removeDaemonFile(dataDir, claim.pid);
      io.out(`removed stale pidfile (pid ${claim.pid} was already gone)`);
      return 0;
    }
    io.err(`failed to signal pid ${claim.pid}: ${(error as Error).message}`);
    return 1;
  }
  // The daemon removes daemon.json on clean shutdown; poll for that as the done signal.
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (readDaemonFile(dataDir)?.pid !== claim.pid) {
      io.out(`stopped (pid ${claim.pid})`);
      return 0;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  io.err(`sent SIGTERM to pid ${claim.pid} but daemon.json is still present after 5s`);
  return 1;
}

/**
 * Invoke ONE command on the running daemon over a short-lived loopback WS connection
 * (issue #380). The CLI is a LOOPBACK client, so it is `private` — full contract, no
 * token — even when the daemon also binds a remote interface. A daemon bound to a
 * specific non-loopback host only (not `0.0.0.0`) is unreachable here; that is honest
 * (local admin then happens over that interface). Resolves the command output, or
 * throws on an rpcError / closed socket / timeout.
 */
async function cliInvoke(
  dataDir: string,
  deps: CliDeps,
  command: string,
  input: unknown,
): Promise<unknown> {
  const verdict = await deps.probe(dataDir);
  if (verdict.kind !== "healthy") {
    throw new Error(
      verdict.kind === "absent"
        ? "the daemon is not running (start it with `rennet serve`)"
        : `daemon not usable: ${verdict.kind}`,
    );
  }
  const url = `ws://127.0.0.1:${verdict.identity.wsPort}`;
  return await new Promise<unknown>((resolve, reject) => {
    const socket = new WebSocket(url);
    const requestId = `cli-${Date.now()}`;
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error("timed out waiting for the daemon"));
    }, 10_000);
    const done = (fn: () => void): void => {
      clearTimeout(timer);
      socket.close();
      fn();
    };
    socket.on("open", () => {
      socket.send(
        JSON.stringify({
          type: "hello",
          clientId: requestId,
          clientType: "rennet-cli",
          protocolVersion: PROTOCOL_VERSION,
        }),
      );
    });
    socket.on("message", (data) => {
      let frame: ReturnType<typeof parseSessionFrame>;
      try {
        frame = parseSessionFrame(JSON.parse(data.toString()));
      } catch {
        return;
      }
      if (frame.type === "serverInfo") {
        socket.send(JSON.stringify({ type: "request", requestId, command, input }));
        return;
      }
      if (frame.type === "response" && frame.requestId === requestId) {
        done(() => resolve(frame.output));
        return;
      }
      if (frame.type === "rpcError" && frame.requestId === requestId) {
        done(() => reject(new Error(frame.message)));
      }
    });
    socket.on("error", (error) => done(() => reject(error)));
    socket.on("close", () => {
      clearTimeout(timer);
    });
  });
}

/** Mint a pairing code from the running daemon and print it. The code is single-use, 5-minute TTL. */
async function pair(dataDir: string, io: CliIo, deps: CliDeps): Promise<number> {
  try {
    const output = (await cliInvoke(dataDir, deps, "pairing.mint", {})) as {
      code: string;
      expiresAt: string;
    };
    io.out(`pairing code: ${output.code}`);
    io.out(`expires: ${output.expiresAt}`);
    io.out("Enter this code on the device you are pairing. It works once, within 5 minutes.");
    return 0;
  } catch (error) {
    io.err(`rennet pair: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

/** List paired devices, or revoke one by id. */
async function devices(
  dataDir: string,
  revokeId: string | undefined,
  io: CliIo,
  deps: CliDeps,
): Promise<number> {
  try {
    const command = revokeId ? "pairing.revokeDevice" : "pairing.listDevices";
    const input = revokeId ? { deviceId: revokeId } : {};
    const output = (await cliInvoke(dataDir, deps, command, input)) as {
      devices: { deviceId: string; name: string; lastSeenAt: string; expiresAt: string }[];
    };
    if (revokeId) io.out(`revoked ${revokeId}`);
    if (output.devices.length === 0) {
      io.out("no paired devices");
      return 0;
    }
    for (const device of output.devices) {
      io.out(
        `${device.deviceId}  ${device.name}  last seen ${device.lastSeenAt}  expires ${device.expiresAt}`,
      );
    }
    return 0;
  } catch (error) {
    io.err(`rennet devices: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

/**
 * Build (or incrementally refresh) the Repo Map for a repository and persist it to the
 * local project store (`~/.rennet/projects/<escaped-path>/map/...` by default). This is
 * the exact generator the daemon's `project.process` runs — pure over git, no daemon, no
 * model, no project registration — so the CLI can mint a first on-disk map for any repo.
 * `--json` additionally exports the queryable ProjectMap (files, scopes, edges, entry
 * points, tests, ownership, conventions) plus per-file declared symbols.
 */
async function buildMap(
  repoPath: string,
  opts: {
    base?: string;
    json?: string;
    projectsDir?: string;
    enrich?: boolean;
    model?: string;
  },
  io: CliIo,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const root = resolve(repoPath);
  const store = opts.projectsDir ? snapshotStoreFor(opts.projectsDir) : snapshotStoreFor();
  const generator = new ProjectSnapshotGenerator({ store });
  let result: GenerateResult;
  try {
    result = await generator.generate(root, {
      explicitBaseRef: opts.base,
      onProgress: (progress) =>
        io.out(`${progress.note}${progress.detail ? ` (${progress.detail})` : ""}`),
    });
  } catch (error) {
    io.err(`rennet map: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  const manifest = result.manifest;
  io.out(
    `map built: ${manifest.baseRef} @ ${manifest.baseOid.slice(0, 12)} — ${result.fileCount} files, ${result.symbolCount} symbols, ${result.referenceCount} references`,
  );
  io.out(
    `  shards: ${result.extractedSymbolShards} extracted, ${result.reusedSymbolShards} reused`,
  );
  io.out(`  stored: ${store.paths(manifest.repoKey).mapDir}`);
  const knowledgeStore = new KnowledgeStore(store);
  if (opts.enrich) {
    const enrichExit = await enrichMap({
      store,
      knowledgeStore,
      manifest,
      root,
      io,
      env,
      model: opts.model,
    });
    if (enrichExit !== 0) return enrichExit;
  }
  if (opts.json) {
    const materialized = materializeSnapshot(manifest, (digest) => result.built.shards.get(digest));
    if (!materialized.ok) {
      io.err(`rennet map: could not materialize snapshot (${materialized.slots.join(", ")})`);
      return 1;
    }
    const projectMap = queryProjectMap(materialized.snapshot);
    const symbols: Record<string, unknown> = {};
    for (const file of projectMap.files) {
      const overview = queryFileOverview(materialized.snapshot, file.path);
      if (overview.ok && overview.overview.symbols.length > 0) {
        symbols[file.path] = overview.overview.symbols;
      }
    }
    const jsonPath = resolve(opts.json);
    writeFileSync(
      jsonPath,
      `${JSON.stringify(
        {
          repoKey: manifest.repoKey,
          baseRef: manifest.baseRef,
          baseOid: manifest.baseOid,
          fingerprint: manifest.fingerprint,
          map: projectMap,
          symbols,
          knowledge: knowledgeStore.loadLocal(manifest.repoKey),
        },
        null,
        2,
      )}\n`,
    );
    io.out(`  exported: ${jsonPath}`);
  }
  return 0;
}

/**
 * The `--enrich` leg: run the model-backed knowledge pass against the just-built
 * snapshot through the user's own Claude harness (their subscription, one bounded
 * turn — the same pass the daemon runs after a snapshot advance). Initial when no
 * prior set exists, delta when the prior set is pinned to an older OID, honest
 * no-op when the set is already current.
 */
async function enrichMap(input: {
  store: ProjectSnapshotStore;
  knowledgeStore: KnowledgeStore;
  manifest: ProjectSnapshotManifest;
  root: string;
  io: CliIo;
  env: NodeJS.ProcessEnv;
  model?: string;
}): Promise<number> {
  const { store, knowledgeStore, manifest, root, io, env, model } = input;
  const prior = knowledgeStore.loadLocal(manifest.repoKey);
  if (prior && prior.baseOid === manifest.baseOid) {
    io.out(`  knowledge: already current at this base OID (${prior.statements.length} statements)`);
    return 0;
  }
  io.out("Discovering the Claude harness");
  const { adapter, discovery } = await createClaudeHarness({ env });
  if (!adapter) {
    const health = discovery.health;
    const why =
      health.state === "unavailable"
        ? health.detail || health.reason
        : health.state === "degraded"
          ? health.reason
          : "unknown";
    io.err(`rennet map: no Claude harness available (${why})`);
    return 1;
  }
  const common = {
    reader: new ProjectContextReader(store),
    knowledgeStore,
    port: adapter,
    repoKey: manifest.repoKey,
    repoRoot: root,
    baseOid: manifest.baseOid,
    ...(model === undefined ? {} : { model }),
  };
  const outcome = prior
    ? await (async () => {
        io.out(
          `Running the knowledge delta pass (${prior.baseOid.slice(0, 12)} → ${manifest.baseOid.slice(0, 12)})`,
        );
        return runKnowledgeDeltaForRepo({ ...common, fromOid: prior.baseOid });
      })()
    : await (async () => {
        io.out("Running the initial knowledge enrichment (one model turn)");
        return enrichKnowledgeForRepo(common);
      })();
  if (outcome.status === "snapshot-unavailable") {
    io.err(`rennet map: snapshot unavailable for enrichment (${outcome.reason})`);
    return 1;
  }
  if (outcome.status === "no-prior-set") {
    // Unreachable: the delta leg only runs when a prior set was loaded.
    io.err("rennet map: knowledge delta found no prior set");
    return 1;
  }
  if (outcome.status === "skipped") {
    io.out("  knowledge: no changed paths touch the set; unchanged");
    return 0;
  }
  if (outcome.status !== "ok") {
    io.err(
      `rennet map: knowledge enrichment failed: ${outcome.result.failureReason ?? "the model turn did not complete"}`,
    );
    return 1;
  }
  const set = knowledgeStore.loadLocal(manifest.repoKey);
  io.out(`  knowledge: ${set?.statements.length ?? 0} statements minted`);
  return 0;
}
