// The `rennet` CLI (issue #379, design D8) — the daemon's second client, proving the
// protocol is real by driving it from a terminal with no window in sight.
// `node:util` parseArgs, no prompts, honest exit codes:
//   serve   run the daemon in the FOREGROUND (dev / power tool; the packaged app spawns
//           its own detached daemon and never depends on this). It resolves the T3 Code
//           sidecar bundle exactly as `daemon-main.ts` does (#875), so a review captured
//           through this daemon has the backend its board seats need.
//   status  read the daemon.json claim and probe /healthz; print pid/port/versions.
//   stop    ask the claimed daemon to shut down over its own wire (SIGTERM if it cannot
//           answer) and wait (bounded) for the claim to disappear.
//   pair    mint a device pairing code on the running daemon.
//   devices list or revoke paired devices on the running daemon.
//   map     build & store the Repo Map for a repository — daemonless, the same
//           generator `project.process` runs, persisting to ~/.rennet/projects/.
//   benchmarks  aggregate the local benchmark archive into the committed docs data
//           (#731) — deterministic: same records + same provenance ⇒ same bytes.
// It reuses the exact supervision helpers the desktop shell uses — no reimplemented
// protocol-compat or claim logic to drift.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
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
import type {
  BenchmarkRun,
  CommandOutput,
  LensKind,
  ProjectSnapshotManifest,
  SessionFrame,
  SessionPreparation,
  SidebarSession,
} from "@rennet/protocol";
import {
  currentGenerationId,
  LENS_KINDS,
  newCommandId,
  PROTOCOL_VERSION,
  parseSessionFrame,
} from "@rennet/protocol";
import { WebSocket } from "ws";
import { createStageTimer, isMapBenchmarkStage } from "./benchmark-recorder";
import { createBenchmarkRecording } from "./benchmark-store";
import {
  buildCaptureFailureDocument,
  buildReviewDocument,
  foldPreparationLines,
  lensDraftLines,
  parseReviewTarget,
  REVIEW_USAGE,
  type ReviewOutcome,
  resolvePrTarget,
  reviewCliUnsupportedMessage,
  reviewDocumentPath,
} from "./cli-review";
import { defaultDataDir, runDaemon } from "./daemon";
import { readDaemonFile, removeDaemonFile } from "./daemon-file";
import { findHealthyDaemon, requestDaemonShutdown } from "./supervise";
import { resolveSidecarBundle, type StopSidecarOutcome, stopSidecar } from "./t3/sidecar";

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
  /** Ask the daemon to shut itself down over its own wire (#820). Defaults to the real POST. */
  readonly requestShutdown?: typeof requestDaemonShutdown;
  /** Stop the owned T3 Code sidecar after the daemon (t3code-sidecar-chat). Defaults to the real one. */
  readonly stopSidecar?: (dataDir: string) => Promise<StopSidecarOutcome>;
}

const defaultDeps: CliDeps = {
  probe: findHealthyDaemon,
  kill: (pid, signal) => {
    process.kill(pid, signal);
  },
  requestShutdown: requestDaemonShutdown,
  stopSidecar,
};

/** `serve`'s usage line, one string so the flags cannot drift between HELP and the error. */
const SERVE_USAGE = "Usage: rennet serve [--data-dir <dir>] [--ui-dist <dir>] [--t3-bundle <file>]";

const HELP = [
  "rennet — the local review daemon",
  "",
  "Usage:",
  "  rennet serve   [--data-dir <dir>] [--ui-dist <dir>] [--t3-bundle <file>]   run the daemon in the foreground",
  "  rennet status  [--data-dir <dir>]   report the daemon's health",
  "  rennet stop    [--data-dir <dir>]   stop the running daemon",
  "  rennet pair    [--data-dir <dir>]   mint a device pairing code (5-minute TTL)",
  "  rennet devices [--revoke <id>] [--data-dir <dir>]   list or revoke paired devices",
  "  rennet review  <base>..<head> [path] | --pr <n> [path] [--out <file>] [--timeout <s>] [--data-dir <dir>]   review a range or PR over the daemon",
  "  rennet map     [path] [--base <ref>] [--json <file>] [--projects-dir <dir>] [--data-dir <dir>]   build & store the repo map",
  "  rennet benchmarks export [--out <file>] [--data-dir <dir>] [--revision <rev>] [--timestamp <iso>]   write the docs benchmark data",
  "",
  "The data dir defaults to $RENNET_USER_DATA, then the platform user-data path.",
  "`rennet serve` resolves the T3 Code sidecar the board lenses run on from --t3-bundle,",
  "then $RENNET_T3_BUNDLE, then the vendored build; it warns and serves on without one.",
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
      let parsed: { "data-dir"?: string; "ui-dist"?: string; "t3-bundle"?: string };
      try {
        parsed = parseArgs({
          args: [...rest],
          allowPositionals: false,
          strict: true,
          options: {
            "data-dir": { type: "string" },
            "ui-dist": { type: "string" },
            "t3-bundle": { type: "string" },
          },
        }).values;
      } catch (error) {
        io.err(`rennet serve: ${error instanceof Error ? error.message : String(error)}`);
        io.err(SERVE_USAGE);
        return 2;
      }
      const dataDir = parsed["data-dir"] ?? env.RENNET_USER_DATA ?? defaultDataDir();
      return serve(
        dataDir,
        parsed["ui-dist"] ?? defaultUiDist(),
        // The SAME fallback `daemon-main.ts` has (#875). Without it `serve` built a
        // DaemonConfig with no `t3BundlePath` at all, the sidecar supervisor went
        // `degraded`, and every board seat failed on "the vendored T3 Code server bundle
        // is not built" — at the far end of a review rather than at startup. The two
        // process entries now resolve the sidecar the same way, from the same flag and
        // the same `RENNET_T3_BUNDLE`.
        parsed["t3-bundle"] ?? resolveSidecarBundle(env),
        io,
        env,
        deps,
      );
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
    case "review":
      return review(rest, io, env, deps);
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
 * the server bundle. The standalone `rennet` CLI has no such sibling — its bundle is
 * `packages/server/dist/rennet.cjs` and nothing builds a browser bundle next to it — so
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

/**
 * What `serve` says when it could not find a T3 Code server bundle (#875).
 *
 * It STARTS anyway. Refusing to run the daemon over a missing sidecar was the other
 * option this issue put on the table, and it is the wrong one: `serve` is also how you
 * read a captured review, pair a device, list devices and serve the browser UI, none of
 * which touch the sidecar, and taking all of that away to protect the reviewer from one
 * subsystem is a lockdown, not a fix. What was actually wrong was WHEN the reviewer found
 * out — twenty minutes into a generation, in five failed lanes. So the daemon comes up and
 * the CLI says the thing at second zero, in the terminal the operator is already looking
 * at, naming the two ways to fix it. `daemon.status` carries the same reason to a client.
 */
export const NO_SIDECAR_WARNING = [
  "warning: no T3 Code server bundle found, so this daemon has no chat sidecar.",
  "         Board lenses run on it and nothing else, so every review this daemon captures",
  "         will finish with failed lanes. Point at a built bundle with --t3-bundle <file>",
  "         or RENNET_T3_BUNDLE, or build it with `pnpm nx build t3code-server`.",
].join("\n");

/** Run the daemon in the foreground; resolves never (the process lives until a signal). */
async function serve(
  dataDir: string,
  uiDist: string | undefined,
  t3BundlePath: string | undefined,
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
    t3BundlePath,
  };
  const daemon = await runDaemon(config);
  io.out(
    `rennet daemon listening on ${daemon.info.host ?? "127.0.0.1"}:${daemon.info.wsPort} (pid ${daemon.info.pid}, v${daemon.info.version})`,
  );
  io.out(`data dir: ${config.dataDir}`);
  if (config.t3BundlePath) io.out(`T3 sidecar bundle: ${config.t3BundlePath}`);
  else io.err(NO_SIDECAR_WARNING);
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
  // Ask over the daemon's own wire first (#820). The ack says which pid heard the command,
  // so a stop is no longer a signal sent into the dark; SIGTERM stays for a daemon that
  // cannot answer (one older than the route, or one too wedged to reply).
  const ack = await (deps.requestShutdown ?? requestDaemonShutdown)(claim.wsPort);
  const acknowledged = ack?.pid === claim.pid;
  if (!acknowledged) {
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
  io.err(
    acknowledged
      ? `pid ${claim.pid} acknowledged the shutdown but daemon.json still names it after 5s`
      : `sent SIGTERM to pid ${claim.pid} but daemon.json is still present after 5s`,
  );
  return 1;
}

/** A daemon-not-healthy verdict, put into the words `rennet pair` prints (D9). */
function unhealthyDaemonMessage(kind: "absent" | "stale" | "incompatible"): string {
  return kind === "absent"
    ? "the daemon is not running (start it with `rennet serve`)"
    : `daemon not usable: ${kind}`;
}

/** A long-lived loopback socket to the daemon: correlated `invoke`s and every push frame. */
interface CliSocket {
  /** Send one command and resolve its output, or reject on an rpcError / closed socket. */
  invoke(command: string, input: unknown): Promise<unknown>;
  /** Subscribe to every parsed push frame (the CLI is `private`, so frames arrive raw). Returns an unsubscribe. */
  onFrame(listener: (frame: SessionFrame) => void): () => void;
  /** The handshake's feature flags (headless-review-cli D11), captured from the `serverInfo` frame. */
  readonly features: Readonly<Record<string, boolean>>;
  /** The daemon's own version from the `serverInfo` frame, for a truthful capability refusal. */
  readonly serverVersion: string;
  /** Close the socket. Idempotent from the caller's side. */
  close(): void;
}

/**
 * Open ONE loopback WS connection to the running daemon and keep it open (design D10). The
 * CLI is a LOOPBACK client, so it is `private` (full contract, no token) and it receives
 * the raw push frames (`lensDraft`, `roundProgress`) a review streams. `cliInvoke` is one
 * `invoke` + `close` over this; the review driver keeps the socket for the whole run so the
 * frames arrive on it. Rejects if no healthy daemon answers within 10 s.
 */
async function openCliSocket(dataDir: string, deps: CliDeps): Promise<CliSocket> {
  const verdict = await deps.probe(dataDir);
  if (verdict.kind !== "healthy") {
    throw new Error(unhealthyDaemonMessage(verdict.kind));
  }
  const url = `ws://127.0.0.1:${verdict.identity.wsPort}`;
  return await new Promise<CliSocket>((resolveSocket, rejectSocket) => {
    const socket = new WebSocket(url);
    const listeners = new Set<(frame: SessionFrame) => void>();
    const pending = new Map<
      string,
      { resolve: (value: unknown) => void; reject: (error: Error) => void }
    >();
    let ready = false;
    let counter = 0;
    // The handshake facts (headless-review-cli D11), captured from the `serverInfo` frame before
    // this promise resolves, then read through the getters below so `api` stays a readonly view.
    let capturedFeatures: Record<string, boolean> = {};
    let capturedVersion = "";
    const openTimer = setTimeout(() => {
      socket.close();
      rejectSocket(new Error("timed out waiting for the daemon"));
    }, 10_000);
    const api: CliSocket = {
      invoke(command, input) {
        return new Promise<unknown>((resolveCall, rejectCall) => {
          const requestId = `cli-${Date.now()}-${counter++}`;
          pending.set(requestId, { resolve: resolveCall, reject: rejectCall });
          socket.send(JSON.stringify({ type: "request", requestId, command, input }));
        });
      },
      onFrame(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      get features() {
        return capturedFeatures;
      },
      get serverVersion() {
        return capturedVersion;
      },
      close() {
        socket.close();
      },
    };
    socket.on("open", () => {
      socket.send(
        JSON.stringify({
          type: "hello",
          clientId: `cli-${Date.now()}`,
          clientType: "rennet-cli",
          protocolVersion: PROTOCOL_VERSION,
        }),
      );
    });
    socket.on("message", (data) => {
      let frame: SessionFrame;
      try {
        frame = parseSessionFrame(JSON.parse(data.toString()));
      } catch {
        return;
      }
      if (frame.type === "serverInfo") {
        if (!ready) {
          // Capture the capability record and version BEFORE resolving, so the driver reading
          // `socket.features` sees the handshake facts the moment it holds the socket (D11).
          capturedFeatures = frame.features;
          capturedVersion = frame.version;
          ready = true;
          clearTimeout(openTimer);
          resolveSocket(api);
        }
        return;
      }
      if (frame.type === "response") {
        const call = pending.get(frame.requestId);
        if (call) {
          pending.delete(frame.requestId);
          call.resolve(frame.output);
        }
        return;
      }
      if (frame.type === "rpcError") {
        const call = pending.get(frame.requestId);
        if (call) {
          pending.delete(frame.requestId);
          call.reject(new Error(frame.message));
        }
        return;
      }
      for (const listener of listeners) listener(frame);
    });
    socket.on("error", (error) => {
      if (!ready) {
        clearTimeout(openTimer);
        rejectSocket(error instanceof Error ? error : new Error(String(error)));
      }
    });
    socket.on("close", () => {
      clearTimeout(openTimer);
      for (const call of pending.values()) call.reject(new Error("the daemon connection closed"));
      pending.clear();
    });
  });
}

/**
 * Invoke ONE command on the running daemon over a short-lived loopback WS connection
 * (issue #380), keeping `cliInvoke`'s original signature and its 10 s ceiling. It is
 * `openCliSocket` + one `invoke` + `close`; `pair` and `devices` are unchanged callers.
 * Resolves the command output, or throws on an rpcError / closed socket / timeout.
 */
async function cliInvoke(
  dataDir: string,
  deps: CliDeps,
  command: string,
  input: unknown,
): Promise<unknown> {
  const socket = await openCliSocket(dataDir, deps);
  try {
    return await new Promise<unknown>((resolveCall, rejectCall) => {
      const timer = setTimeout(
        () => rejectCall(new Error("timed out waiting for the daemon")),
        10_000,
      );
      socket.invoke(command, input).then(
        (output) => {
          clearTimeout(timer);
          resolveCall(output);
        },
        (error) => {
          clearTimeout(timer);
          rejectCall(error instanceof Error ? error : new Error(String(error)));
        },
      );
    });
  } finally {
    socket.close();
  }
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

// ── `rennet review` (headless-review-cli, issue #379 / #71) ──────────────────
// The daemon's second client for the review path: open a session over the same `session.mint`
// front door the desktop uses, print the preparation as the daemon reports it, and write the
// settled boards to a stable path a `tail -1` can read.

/** The desktop's preparation-poll cadence (`PREPARATION_POLL_MS`); the record is small (D6). */
const PREPARATION_POLL_MS = 400;

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function gitTrim(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

/** The head the range's empty head resolves to: the checked-out branch, else the literal HEAD (D3). */
function resolveCurrentBranch(toplevel: string): string {
  try {
    const branch = gitTrim(toplevel, ["symbolic-ref", "--short", "-q", "HEAD"]);
    return branch === "" ? "HEAD" : branch;
  } catch {
    return "HEAD";
  }
}

/** Does this project contain the repository at `toplevelReal` (by path / openPath / included repos)? */
function projectContains(
  project: { path: string; openPath: string; includedRepoPaths?: readonly string[] },
  toplevelReal: string,
): boolean {
  const candidates = [project.path, project.openPath, ...(project.includedRepoPaths ?? [])];
  return candidates.some((candidate) => {
    try {
      return realpathSync(candidate) === toplevelReal;
    } catch {
      return candidate === toplevelReal;
    }
  });
}

/**
 * Resolve the project the repository belongs to, adding it with the daemon's own discover +
 * add flow when nothing contains it yet (D5), and saying so on stdout. Returns its id.
 */
async function resolveProjectId(
  socket: CliSocket,
  toplevel: string,
  toplevelReal: string,
  io: CliIo,
): Promise<string> {
  const listed = (await socket.invoke("projects.list", {})) as CommandOutput<"projects.list">;
  const existing = listed.projects.find((project) => projectContains(project, toplevelReal));
  if (existing !== undefined) return existing.id;
  // Grant read-only access to the toplevel before discovering it: the same grant the
  // desktop's picker makes, exposed to a headless client by `repository.choose`'s explicit
  // `path` (#379). This is the daemon's access rule, not a gate the CLI is inventing.
  await socket.invoke("repository.choose", { path: toplevel });
  const discovered = (await socket.invoke("project.discover", {
    commandId: newCommandId(),
    path: toplevel,
    kind: "repo",
    source: "local",
  })) as CommandOutput<"project.discover">;
  const added = (await socket.invoke("projects.add", {
    commandId: newCommandId(),
    discovery: discovered.discovery,
    includedRepos: discovered.discovery.repos.map((repo) => repo.name),
    primaryBranch: discovered.discovery.primaryBranch,
  })) as CommandOutput<"projects.add">;
  io.out(`added ${added.project.name} as a project`);
  return added.project.id;
}

interface PollResult {
  readonly outcome: ReviewOutcome;
  readonly reviewId: string | undefined;
  readonly reason?: string;
  readonly settledAtMs: number;
}

function terminalResult(
  preparation: SessionPreparation | undefined,
  reviewId: string | undefined,
): PollResult | null {
  if (preparation === undefined) {
    return { outcome: "settled", reviewId, settledAtMs: Date.now() };
  }
  if (preparation.status === "failed") {
    return {
      outcome: "failed",
      reviewId: preparation.reviewId ?? reviewId,
      reason: preparation.reason,
      settledAtMs: Date.now(),
    };
  }
  if (preparation.status === "cancelled") {
    return {
      outcome: "cancelled",
      reviewId: preparation.reviewId ?? reviewId,
      reason: "the preparation was cancelled",
      settledAtMs: Date.now(),
    };
  }
  return null;
}

/**
 * Watch a session's preparation to a settled/failed/cancelled state (or the timeout), printing
 * one line per record transition and one per `lensDraft` write, each stamped with the seconds
 * since `startedAtMs` (D6). A timeout does NOT cancel the daemon's preparation (D9): the loop
 * just stops and the caller writes what settled.
 */
async function pollPreparation(
  socket: CliSocket,
  sessionId: string,
  initial: SessionPreparation | undefined,
  initialReviewId: string | undefined,
  startedAtMs: number,
  timeoutMs: number,
  io: CliIo,
): Promise<PollResult> {
  let reviewId = initialReviewId;
  const unsubscribe = socket.onFrame((frame) => {
    if (frame.type !== "lensDraft") return;
    if (reviewId !== undefined && frame.reviewId !== reviewId) return;
    for (const line of lensDraftLines(frame.event, Date.now() - startedAtMs)) io.out(line);
  });
  try {
    let previous = initial;
    if (previous?.status === "drafting") reviewId = previous.reviewId;
    for (const line of foldPreparationLines(undefined, previous, Date.now() - startedAtMs)) {
      io.out(line);
    }
    const deadline = startedAtMs + timeoutMs;
    while (true) {
      const done = terminalResult(previous, reviewId);
      if (done) return done;
      if (Date.now() > deadline) {
        return {
          outcome: "timeout",
          reviewId,
          reason: `timed out after ${Math.round(timeoutMs / 1000)}s; the daemon is still preparing this review`,
          settledAtMs: Date.now(),
        };
      }
      await sleep(PREPARATION_POLL_MS);
      const listed = (await socket.invoke("session.list", {})) as CommandOutput<"session.list">;
      const row = listed.sessions.find((session) => session.id === sessionId);
      if (row?.reviewId !== undefined) reviewId = row.reviewId;
      const next = row?.preparation;
      if (next?.status === "drafting") reviewId = next.reviewId;
      for (const line of foldPreparationLines(previous, next, Date.now() - startedAtMs)) {
        io.out(line);
      }
      previous = next;
    }
  } finally {
    unsubscribe();
  }
}

/**
 * Read the settled review and write its document (D7). Prints the reason on stderr for a
 * non-`settled` outcome, then the document's absolute path as the final stdout line. Returns
 * `0` on `settled`, `1` otherwise; `1` too if the document could not be written.
 */
async function writeReviewDocument(input: {
  socket: CliSocket;
  reviewId: string;
  sessionId: string;
  projectId: string;
  dataDir: string;
  out?: string;
  requestedHead: string;
  outcome: ReviewOutcome;
  reason?: string;
  startedAtMs: number;
  settledAtMs: number;
  io: CliIo;
}): Promise<number> {
  const { socket, reviewId, io } = input;
  const loaded = (await socket.invoke("review.load", {
    commandId: newCommandId(),
    reviewId,
  })) as CommandOutput<"review.load">;
  const rounds = (await socket.invoke("session.rounds", {
    reviewId,
  })) as CommandOutput<"session.rounds">;
  const generation = currentGenerationId(rounds.records, loaded.review.activePatchsetId);
  const boards = {} as Record<LensKind, CommandOutput<"board.read">>;
  for (const lens of LENS_KINDS) {
    boards[lens] = (await socket.invoke("board.read", {
      reviewId,
      generation,
      lens,
    })) as CommandOutput<"board.read">;
  }
  const document = buildReviewDocument({
    review: loaded.review,
    sessionId: input.sessionId,
    projectId: input.projectId,
    requestedHead: input.requestedHead,
    rounds: rounds.records,
    boards,
    outcome: input.outcome,
    reason: input.reason,
    startedAtMs: input.startedAtMs,
    settledAtMs: input.settledAtMs,
  });
  const path =
    input.out !== undefined ? resolve(input.out) : reviewDocumentPath(input.dataDir, reviewId);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  } catch (error) {
    io.err(
      `rennet review: could not write the document: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }
  if (input.reason !== undefined) io.err(`rennet review: ${input.reason}`);
  io.out(path);
  return input.outcome === "settled" ? 0 : 1;
}

/**
 * Write the capture-stage FAILURE document (c). When the capture stage fails before a review id
 * exists (repository resolution or change capture never produced a review), `writeReviewDocument`
 * cannot run (it loads a review by id). This writes a minimal failure document keyed by the SESSION
 * id, so an automated caller always finds a `<dataDir>/reviews/<id>.json` with the failure outcome
 * and reason rather than nothing to parse. Prints the reason on stderr and the absolute path as the
 * final stdout line; returns a non-zero exit.
 */
export function writeCaptureFailureDocument(input: {
  sessionId: string;
  projectId: string;
  dataDir: string;
  out?: string;
  outcome: Exclude<ReviewOutcome, "settled">;
  reason: string;
  startedAtMs: number;
  settledAtMs: number;
  io: CliIo;
}): number {
  const { io } = input;
  const document = buildCaptureFailureDocument({
    sessionId: input.sessionId,
    projectId: input.projectId,
    outcome: input.outcome,
    reason: input.reason,
    startedAtMs: input.startedAtMs,
    settledAtMs: input.settledAtMs,
  });
  const path =
    input.out !== undefined
      ? resolve(input.out)
      : reviewDocumentPath(input.dataDir, input.sessionId);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  } catch (error) {
    io.err(
      `rennet review: could not write the document: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }
  io.err(`rennet review: ${input.reason}`);
  io.out(path);
  return 1;
}

/** The mint input for a resolved target: the branch/base for a range, or the PR row's fields. */
type MintInput = {
  projectId: string;
  commandId: string;
  branch: string;
  base?: string;
  prNumber?: number;
  repository?: string;
  forgeRepository?: CommandOutput<"project.detail">["prs"][number]["forgeRepository"];
  replacesSessionId?: string;
};

/**
 * `rennet review`: open a session for the target over the daemon, print the preparation as it
 * happens, and write the settled boards. See headless-review-cli's design for the reattach,
 * exit-code and document rules.
 */
async function review(
  argv: readonly string[],
  io: CliIo,
  env: NodeJS.ProcessEnv,
  deps: CliDeps,
): Promise<number> {
  const target = parseReviewTarget(argv);
  if (target.kind === "usage") {
    io.err(`rennet review: ${target.message}`);
    io.err(REVIEW_USAGE);
    return 2;
  }
  // Resolve once at the definition so a relative `--data-dir` (or relative `RENNET_USER_DATA`)
  // reaches the socket path AND the default review-document path as an absolute location; an
  // already-absolute dataDir resolves to itself, so the daemon's own default is unchanged (f).
  const dataDir = resolve(target.dataDir ?? env.RENNET_USER_DATA ?? defaultDataDir());

  // Probe + connect FIRST, so the daemon-absent message is the first output (D9).
  let socket: CliSocket;
  try {
    socket = await openCliSocket(dataDir, deps);
  } catch (error) {
    io.err(`rennet review: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  try {
    return await driveReview(socket, target, dataDir, io);
  } finally {
    socket.close();
  }
}

async function driveReview(
  socket: CliSocket,
  target: Exclude<ReturnType<typeof parseReviewTarget>, { kind: "usage" }>,
  dataDir: string,
  io: CliIo,
): Promise<number> {
  // Connect-time capability gate (headless-review-cli D11). A daemon that predates the review
  // seam never advertises `review-cli` and its `repository.identify` is an unknown command, so
  // it would review against the wrong repo or base silently. Refuse loudly, naming the minimum
  // version, BEFORE resolving the project (which would add a project to that daemon's store).
  const unsupported = reviewCliUnsupportedMessage(socket.features, socket.serverVersion);
  if (unsupported !== undefined) {
    io.err(`rennet review: ${unsupported}`);
    return 1;
  }

  const repoPath = resolve(target.path ?? process.cwd());
  let toplevel: string;
  try {
    toplevel = gitTrim(repoPath, ["rev-parse", "--show-toplevel"]);
  } catch (error) {
    io.err(`rennet review: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  let toplevelReal: string;
  try {
    toplevelReal = realpathSync(toplevel);
  } catch {
    toplevelReal = toplevel;
  }

  const projectId = await resolveProjectId(socket, toplevel, toplevelReal, io);

  // The DAEMON resolves the checkout to its canonical `owner/name` (headless-review-cli D11): the
  // CLI never parses the origin remote, so a `.git` suffix or a case difference cannot fork the
  // claim. Both arms use this identity, so a workspace's several repos never collapse onto the
  // wrong one. Single-repo: it resolves to the one identity the capture already used.
  const standing = (await socket.invoke("repository.identify", {
    path: toplevel,
  })) as CommandOutput<"repository.identify">;

  let requestedHead: string;
  let mintInput: MintInput;
  if (target.kind === "range") {
    requestedHead = target.head !== "" ? target.head : resolveCurrentBranch(toplevel);
    mintInput = {
      projectId,
      commandId: newCommandId(),
      branch: requestedHead,
      base: target.base,
      repository: standing.repository,
      ...(standing.forgeRepository === undefined
        ? {}
        : { forgeRepository: standing.forgeRepository }),
    };
  } else {
    const detail = (await socket.invoke("project.detail", {
      projectId,
      prStates: ["open", "merged", "closed"],
    })) as CommandOutput<"project.detail">;
    // Scope `--pr <n>` to the standing repository (headless-review-cli D11): a bare number is
    // unique only within one repo, so a project-wide `prs.find` can open a sibling repo's PR.
    // The full standing identity (with forgeRepository) is passed so a same-slug cross-forge
    // collision is decided by forge, not name.
    const resolution = resolvePrTarget(detail.prs, target.number, standing);
    if (resolution.kind === "not-listed") {
      io.err(
        detail.authUnavailable !== undefined
          ? `rennet review: pull request #${target.number} could not be listed (${detail.authUnavailable})`
          : `rennet review: pull request #${target.number} is not listed for this project`,
      );
      return 1;
    }
    if (resolution.kind === "ambiguous") {
      io.err(
        `rennet review: pull request #${target.number} is not this checkout's (${standing.repository}); it names ${resolution.candidates.join(", ")}. Run rennet review from the repository whose PR you mean.`,
      );
      return 1;
    }
    const row = resolution.row;
    requestedHead = row.branch;
    mintInput = {
      projectId,
      commandId: newCommandId(),
      branch: row.branch,
      prNumber: row.number,
      repository: row.repository,
      ...(row.forgeRepository === undefined ? {} : { forgeRepository: row.forgeRepository }),
    };
  }

  const minted = (await socket.invoke("session.mint", mintInput)) as CommandOutput<"session.mint">;
  let startedAtMs = Date.now();
  if (minted.session === null) {
    io.err("rennet review: the daemon minted no session");
    return 1;
  }
  let row: SidebarSession = minted.session;

  if (minted.reattached) {
    const preparation = row.preparation;
    // A live preparation: attach to it exactly as if this run had minted it.
    if (preparation?.status !== "capturing" && preparation?.status !== "drafting") {
      const settled = await resolveReattach(socket, row, requestedHead, toplevel, mintInput, io);
      if (settled.kind === "fast") {
        return writeReviewDocument({
          socket,
          reviewId: settled.reviewId,
          sessionId: row.id,
          projectId,
          dataDir,
          out: target.out,
          requestedHead,
          outcome: "settled",
          startedAtMs,
          settledAtMs: Date.now(),
          io,
        });
      }
      if (settled.kind === "error") return 1;
      row = settled.row;
      startedAtMs = Date.now();
    }
  }

  const result = await pollPreparation(
    socket,
    row.id,
    row.preparation,
    row.reviewId,
    startedAtMs,
    target.timeoutMs,
    io,
  );
  if (result.reviewId === undefined) {
    // The capture stage failed before a review id existed (repository resolution or change
    // capture). `writeReviewDocument` cannot run (there is no review to load), so write a minimal
    // failure document keyed by the session id, so an automated caller finds a document to parse
    // rather than nothing (c). A `settled` outcome that produced no review is an anomaly, recorded
    // as `failed`; a timeout/cancellation keeps its own honest outcome.
    return writeCaptureFailureDocument({
      sessionId: row.id,
      projectId,
      dataDir,
      out: target.out,
      outcome: result.outcome === "settled" ? "failed" : result.outcome,
      reason: result.reason ?? "the preparation produced no review",
      startedAtMs,
      settledAtMs: result.settledAtMs,
      io,
    });
  }
  return writeReviewDocument({
    socket,
    reviewId: result.reviewId,
    sessionId: row.id,
    projectId,
    dataDir,
    out: target.out,
    requestedHead,
    outcome: result.outcome,
    reason: result.reason,
    startedAtMs,
    settledAtMs: result.settledAtMs,
    io,
  });
}

type ReattachResolution =
  | { kind: "fast"; reviewId: string }
  | { kind: "poll"; row: SidebarSession }
  | { kind: "error" };

/**
 * Decide what a reattach to a NON-running session means (D8): a settled review at the requested
 * head is a fast exit; a boards-stage failure with a review is retried; a moved head or a
 * failed capture mints a successor with `replacesSessionId`, saying which session was archived.
 */
async function resolveReattach(
  socket: CliSocket,
  row: SidebarSession,
  requestedHead: string,
  toplevel: string,
  mintInput: MintInput,
  io: CliIo,
): Promise<ReattachResolution> {
  const preparation = row.preparation;
  if (row.reviewId !== undefined) {
    const loaded = (await socket.invoke("review.load", {
      commandId: newCommandId(),
      reviewId: row.reviewId,
    })) as CommandOutput<"review.load">;
    const active = loaded.review.patchsets.find(
      (patchset) => patchset.id === loaded.review.activePatchsetId,
    );
    const currentHeadOid = active?.repository.headOid;
    let requestedHeadOid: string | undefined;
    try {
      requestedHeadOid = gitTrim(toplevel, ["rev-parse", "--verify", `${requestedHead}^{commit}`]);
    } catch {
      requestedHeadOid = undefined;
    }
    const headMatches =
      requestedHeadOid !== undefined &&
      currentHeadOid !== undefined &&
      currentHeadOid === requestedHeadOid;
    if (headMatches && preparation === undefined) {
      io.out(`already reviewed at ${requestedHead}; reusing the settled boards`);
      return { kind: "fast", reviewId: row.reviewId };
    }
    if (headMatches && preparation?.status === "failed" && preparation.reviewId !== undefined) {
      const retried = (await socket.invoke("session.retryPreparation", {
        sessionId: row.id,
        commandId: newCommandId(),
      })) as CommandOutput<"session.retryPreparation">;
      if (retried.session === null) {
        io.err("rennet review: the daemon could not retry the preparation");
        return { kind: "error" };
      }
      return { kind: "poll", row: retried.session };
    }
  }
  // A moved head, a failed capture, or a cancelled preparation: mint a successor that archives
  // this session and captures the requested range afresh (D8).
  const successor = (await socket.invoke("session.mint", {
    ...mintInput,
    commandId: newCommandId(),
    replacesSessionId: row.id,
  })) as CommandOutput<"session.mint">;
  if (successor.session === null) {
    io.err("rennet review: the daemon minted no successor session");
    return { kind: "error" };
  }
  io.out(`archived ${row.id}; captured a fresh review`);
  return { kind: "poll", row: successor.session };
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
