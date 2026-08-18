// The `rennet` CLI (issue #379, design D8) — the daemon's second client, proving the
// protocol is real by driving it from a terminal with no window in sight. Three
// subcommands, `node:util` parseArgs, no prompts, honest exit codes:
//   serve   run the daemon in the FOREGROUND (dev / power tool; the packaged app spawns
//           its own detached daemon and never depends on this).
//   status  read the daemon.json claim and probe /healthz; print pid/port/versions.
//   stop    SIGTERM the claimed pid and wait (bounded) for the claim to disappear.
// It reuses the exact supervision helpers the desktop shell uses — no reimplemented
// protocol-compat or claim logic to drift.

import { parseArgs } from "node:util";
import { PROTOCOL_VERSION, parseSessionFrame } from "@rennet/protocol";
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
  "  rennet serve   [--data-dir <dir>]   run the daemon in the foreground",
  "  rennet status  [--data-dir <dir>]   report the daemon's health",
  "  rennet stop    [--data-dir <dir>]   stop the running daemon",
  "  rennet pair    [--data-dir <dir>]   mint a device pairing code (5-minute TTL)",
  "  rennet devices [--revoke <id>] [--data-dir <dir>]   list or revoke paired devices",
  "",
  "The data dir defaults to $RENNET_USER_DATA, then the platform user-data path.",
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
    case "serve":
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
      if (subcommand === "serve") return serve(dataDir, io, env, deps);
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

/** Run the daemon in the foreground; resolves never (the process lives until a signal). */
async function serve(
  dataDir: string,
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
