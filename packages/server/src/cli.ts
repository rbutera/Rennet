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
//   benchmarks  aggregate the local benchmark archive into the committed docs data
//           (#731) — deterministic: same records + same provenance ⇒ same bytes.
// It reuses the exact supervision helpers the desktop shell uses — no reimplemented
// protocol-compat or claim logic to drift.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { arch, cpus, platform } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { type GenerateResult, ProjectSnapshotGenerator, snapshotStoreFor } from "@rennet/adapters";
import {
  benchmarkExportText,
  buildBenchmarkExport,
  materializeSnapshot,
  queryFileOverview,
  queryProjectMap,
} from "@rennet/core";
import type { BenchmarkRun, ProjectSnapshotManifest } from "@rennet/protocol";
import { PROTOCOL_VERSION, parseSessionFrame } from "@rennet/protocol";
import { WebSocket } from "ws";
import { createStageTimer, isMapBenchmarkStage } from "./benchmark-recorder";
import { createBenchmarkRecording } from "./benchmark-store";
import { defaultDataDir, runDaemon } from "./daemon";
import { readDaemonFile, removeDaemonFile } from "./daemon-file";
import { findHealthyDaemon } from "./supervise";
import { type StopSidecarOutcome, stopSidecar } from "./t3/sidecar";

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
  /** Stop the owned T3 Code sidecar after the daemon (t3code-sidecar-chat). Defaults to the real one. */
  readonly stopSidecar?: (dataDir: string) => Promise<StopSidecarOutcome>;
}

const defaultDeps: CliDeps = {
  probe: findHealthyDaemon,
  kill: (pid, signal) => {
    process.kill(pid, signal);
  },
  stopSidecar,
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
  "  rennet map     [path] [--base <ref>] [--json <file>] [--projects-dir <dir>] [--data-dir <dir>]   build & store the repo map",
  "  rennet benchmarks export [--out <file>] [--data-dir <dir>] [--revision <rev>] [--timestamp <iso>]   write the docs benchmark data",
  "",
  "The data dir defaults to $RENNET_USER_DATA, then the platform user-data path.",
  "`rennet map` needs no daemon: it builds the Repo Map for the repository at <path>",
  "(default: the current directory) and stores it under ~/.rennet/projects/.",
  "on your installed harnesses — model choice is the Model Council's.",
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
      const dataDir = parsed["data-dir"] ?? env.RENNET_USER_DATA ?? defaultDataDir();
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
      const dataDir = parsed["data-dir"] ?? env.RENNET_USER_DATA ?? defaultDataDir();
      return devices(dataDir, parsed.revoke, io, deps);
    }
    case "map": {
      let parsed: {
        values: {
          base?: string;
          json?: string;
          "projects-dir"?: string;
          "data-dir"?: string;
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
            "data-dir": { type: "string" },
          },
        });
        if (parsed.positionals.length > 1) throw new Error("expected at most one repository path");
      } catch (error) {
        io.err(`rennet map: ${error instanceof Error ? error.message : String(error)}`);
        io.err("Usage: rennet map [path] [--base <ref>] [--json <file>] [--projects-dir <dir>]");
        return 2;
      }
      return buildMap(
        parsed.positionals[0] ?? process.cwd(),
        {
          base: parsed.values.base,
          json: parsed.values.json,
          projectsDir: parsed.values["projects-dir"],
          dataDir: parsed.values["data-dir"] ?? env.RENNET_USER_DATA,
        },
        io,
      );
    }
    case "benchmarks": {
      let parsed: {
        values: {
          out?: string;
          "data-dir"?: string;
          revision?: string;
          machine?: string;
          timestamp?: string;
        };
        positionals: string[];
      };
      try {
        parsed = parseArgs({
          args: [...rest],
          allowPositionals: true,
          strict: true,
          options: {
            out: { type: "string" },
            "data-dir": { type: "string" },
            revision: { type: "string" },
            machine: { type: "string" },
            timestamp: { type: "string" },
          },
        });
      } catch (error) {
        io.err(`rennet benchmarks: ${error instanceof Error ? error.message : String(error)}`);
        io.err("Usage: rennet benchmarks export [--out <file>] [--data-dir <dir>]");
        return 2;
      }
      const action = parsed.positionals[0] ?? "export";
      if (action !== "export") {
        io.err(`rennet benchmarks: unknown action '${action}' (expected 'export')`);
        return 2;
      }
      return exportBenchmarks(
        {
          dataDir: parsed.values["data-dir"] ?? env.RENNET_USER_DATA ?? defaultDataDir(),
          out: parsed.values.out ?? join(process.cwd(), "docs", "data", "benchmarks.json"),
          revision: parsed.values.revision,
          machine: parsed.values.machine,
          timestamp: parsed.values.timestamp,
        },
        io,
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
  return values["data-dir"] ?? env.RENNET_USER_DATA ?? defaultDataDir();
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
  const code = await stopDaemon(dataDir, io, deps);
  // The sidecar step comes after the daemon (t3code-sidecar-chat, 2.6): a clean daemon
  // shutdown already signalled its child; this reaps a survivor and clears its claim.
  try {
    const sidecar = await (deps.stopSidecar ?? stopSidecar)(dataDir);
    if (sidecar.kind === "stopped") io.out("stopped T3 sidecar");
    if (sidecar.kind === "timeout") {
      io.err(
        `sent SIGTERM to T3 sidecar pid ${sidecar.pid} but it is still running; the next start will reap it`,
      );
    }
  } catch (error) {
    io.err(
      `failed to stop the T3 sidecar: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return code;
}

async function stopDaemon(dataDir: string, io: CliIo, deps: CliDeps): Promise<number> {
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
    dataDir?: string;
  },
  io: CliIo,
): Promise<number> {
  const root = resolve(repoPath);
  const store = opts.projectsDir ? snapshotStoreFor(opts.projectsDir) : snapshotStoreFor();
  const generator = new ProjectSnapshotGenerator({ store });
  // The daemonless map build records the same benchmark run the daemon's does (#731 9.2):
  // it runs the SAME generator over the same stage boundaries, so excluding it would mean
  // the one Repo Map path a developer can run reproducibly is the one that never measures
  // itself. Gated by the same default-on setting as every other producer.
  const benchmarks = createBenchmarkRecording(opts.dataDir ?? defaultDataDir());
  const timer = createStageTimer(Date.now);
  const mapFrom = Date.now();
  let generated: {
    readonly manifest: ProjectSnapshotManifest;
    readonly fileCount: number;
    readonly symbolCount: number;
    readonly referenceCount: number;
    readonly extractedSymbolShards: number;
    readonly reusedSymbolShards: number;
  };
  try {
    const result: GenerateResult = await generator.generate(root, {
      explicitBaseRef: opts.base,
      onProgress: (progress) => {
        if (isMapBenchmarkStage(progress.stage)) timer.enter(progress.stage);
        io.out(`${progress.note}${progress.detail ? ` (${progress.detail})` : ""}`);
      },
    });
    generated = {
      manifest: result.manifest,
      fileCount: result.fileCount,
      symbolCount: result.symbolCount,
      referenceCount: result.referenceCount,
      extractedSymbolShards: result.extractedSymbolShards,
      reusedSymbolShards: result.reusedSymbolShards,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    recordMapBenchmark(
      benchmarks.record,
      timer,
      basename(root) || root,
      root,
      "failed",
      reason,
      undefined,
      mapFrom,
    );
    io.err(`rennet map: ${reason}`);
    return 1;
  }
  const { manifest } = generated;
  recordMapBenchmark(
    benchmarks.record,
    timer,
    basename(root) || root,
    manifest.repoKey,
    "complete",
    undefined,
    manifest.baseOid,
  );
  io.out(
    `map built: ${manifest.baseRef} @ ${manifest.baseOid.slice(0, 12)} — ${generated.fileCount} files, ${generated.symbolCount} symbols, ${generated.referenceCount} references`,
  );
  io.out(
    `  shards: ${generated.extractedSymbolShards} extracted, ${generated.reusedSymbolShards} reused`,
  );
  io.out(`  stored: ${store.paths(manifest.repoKey).mapDir}`);
  if (opts.json) {
    const materialized = materializeSnapshot(manifest, (digest) =>
      store.loadShard(manifest.repoKey, digest),
    );
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
 * The developer-run benchmark export (#731 9.7, design D8 consumer 3). Reads the local
 * archive, aggregates it into the committed docs artifact, and writes it. Rai runs this
 * against his own dogfood data and reviews the diff before committing — the export writes
 * a file, it does not publish anything.
 *
 * DETERMINISTIC, and the claim is now exactly true rather than nearly: the aggregation is
 * pure (`buildBenchmarkExport`), every list is sorted on declared order, and the export's
 * stamp is DERIVED FROM THE ARCHIVE — the end of its newest run — rather than read off the
 * wall clock. Re-running over an unchanged archive therefore produces byte-identical
 * output and an empty diff. It used to call `new Date()` here, which meant every re-export
 * differed in its `exportedAt` no matter what the measurements said; the file claimed
 * byte-identity while the one field that could not be identical sat at the top of it.
 *
 * `--timestamp <iso>` overrides, for a caller who wants to state the stamp explicitly. The
 * fresh clock survives only as the last fallback, for an archive whose newest run predates
 * nothing — and it is the only branch on this path that is not reproducible.
 */
async function exportBenchmarks(
  opts: {
    readonly dataDir: string;
    readonly out: string;
    readonly revision?: string;
    readonly machine?: string;
    readonly timestamp?: string;
  },
  io: CliIo,
): Promise<number> {
  const { store } = createBenchmarkRecording(opts.dataDir);
  // The archive cap is deliberately generous: the export is a considered, occasional act
  // over the whole local history, not a live panel read.
  const { runs, skipped } = store.read(100_000);
  for (const line of skipped) {
    io.err(`rennet benchmarks: skipped a damaged archive line — ${line}`);
  }
  if (runs.length === 0) {
    io.err(`rennet benchmarks: no recorded runs in ${join(opts.dataDir, "benchmarks.jsonl")}`);
    io.err("Run a review or process a project with benchmark recording on, then export.");
    return 1;
  }
  let revision = opts.revision;
  if (revision === undefined) {
    try {
      revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    } catch {
      io.err("rennet benchmarks: could not read the revision; pass --revision <rev>");
      return 1;
    }
  }
  let exportedAt: string;
  if (opts.timestamp !== undefined) {
    const stated = new Date(opts.timestamp);
    if (Number.isNaN(stated.getTime())) {
      io.err(`rennet benchmarks: --timestamp '${opts.timestamp}' is not a date`);
      return 2;
    }
    exportedAt = stated.toISOString();
  } else {
    // The end of the newest recorded run: a real instant, taken from the data being
    // exported, and the same one on every re-export of that data.
    const newest = runs.reduce(
      (latest, run) => Math.max(latest, run.startedAtMs + run.durationMs),
      0,
    );
    exportedAt = newest > 0 ? new Date(newest).toISOString() : new Date().toISOString();
  }
  const exported = buildBenchmarkExport({
    runs,
    provenance: {
      exportedAt,
      machine: opts.machine ?? `${platform()} ${arch()}, ${cpus().length} cores`,
      revision,
    },
  });
  mkdirSync(dirname(opts.out), { recursive: true });
  writeFileSync(opts.out, benchmarkExportText(exported), "utf8");
  io.out(
    `benchmarks exported: ${runs.length} runs → ${exported.stages.length} stage rows across ${exported.runs.length} (kind, mode) groups`,
  );
  io.out(`  provenance: ${exported.provenance.machine} @ ${exported.provenance.revision}`);
  io.out(`  written: ${opts.out}`);
  return 0;
}

/**
 * Archive one daemonless map build. Shared by the success and failure legs so a build that
 * DIED is recorded as a failed run carrying the stages it reached — a map path that only
 * archived its successes would hide the builds that take longest, which are the ones that
 * fall over.
 *
 * `producer: "cli-map"` is the stage-set identity, and it is load-bearing rather than
 * bookkeeping: `rennet map` HAS NO SCOUT PASS. Without the label, a `resolve` row with no
 * `scout` row beside it reads as a lost measurement, when here it means there was never
 * one — and the docs page, which aggregates, cannot tell those apart from the stage list.
 * The honest answer is to say which pipeline recorded the run, not to invent a scout row.
 */
function recordMapBenchmark(
  record: (run: BenchmarkRun) => void,
  timer: ReturnType<typeof createStageTimer>,
  label: string,
  repoKey: string,
  outcome: "complete" | "failed",
  failure?: string,
  revision?: string,
  from?: number,
): void {
  const stages = timer.finish();
  const total = stages.find((stage) => stage.stage === "total");
  // Recorded even with no stage at all: a build that died before its first measured
  // boundary is a failed run with an empty stage list, which says so. Dropping it made
  // the earliest failures — the ones that never got going — invisible.
  const startedAtMs = total?.startedAtMs ?? from ?? Date.now();
  record({
    version: 1,
    id: `${repoKey}:${startedAtMs}`,
    kind: "repo-map",
    producer: "cli-map",
    subject: { label, repoKey, ...(revision === undefined ? {} : { revision }) },
    startedAtMs,
    durationMs: total?.durationMs ?? 0,
    outcome,
    ...(failure === undefined ? {} : { failure }),
    stages,
  });
}
