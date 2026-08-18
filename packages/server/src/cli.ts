// The `rennet` CLI (issue #379, design D8) — the daemon's second client, proving the
// protocol is real by driving it from a terminal with no window in sight. Three
// subcommands, `node:util` parseArgs, no prompts, honest exit codes:
//   serve   run the daemon in the FOREGROUND (dev / power tool; the packaged app spawns
//           its own detached daemon and never depends on this).
//   status  read the daemon.json claim and probe /healthz; print pid/port/versions.
//   stop    SIGTERM the claimed pid and wait (bounded) for the claim to disappear.
// It reuses the exact supervision helpers the desktop shell uses — no reimplemented
// protocol-compat or claim logic to drift.

import { resolveDaemonConfig, runDaemon } from "./daemon";
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

const HELP = [
  "rennet — the local review daemon",
  "",
  "Usage:",
  "  rennet serve   [--data-dir <dir>]   run the daemon in the foreground",
  "  rennet status  [--data-dir <dir>]   report the daemon's health",
  "  rennet stop    [--data-dir <dir>]   stop the running daemon",
  "",
  "The data dir defaults to $RENNET_USER_DATA, then the platform user-data path.",
].join("\n");

/** Route argv to a subcommand. Returns a process exit code (serve never returns). */
export async function runCli(
  argv: readonly string[],
  io: CliIo = defaultIo,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const [subcommand, ...rest] = argv;
  switch (subcommand) {
    case "serve":
      return serve(rest, io, env);
    case "status":
      return status(rest, io, env);
    case "stop":
      return stop(rest, io, env);
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

/** Run the daemon in the foreground; resolves never (the process lives until a signal). */
async function serve(argv: readonly string[], io: CliIo, env: NodeJS.ProcessEnv): Promise<number> {
  const config = resolveDaemonConfig(argv, env);
  const daemon = await runDaemon(config);
  io.out(
    `rennet daemon listening on 127.0.0.1:${daemon.info.wsPort} (pid ${daemon.info.pid}, v${daemon.info.version})`,
  );
  io.out(`data dir: ${config.dataDir}`);
  // Hold the process open: the WS listener + watchers keep the event loop alive, and the
  // SIGTERM/SIGINT handlers runDaemon installed call process.exit(0) on stop. The executor
  // never settles the promise on purpose — the process ends by signal, not by resolution.
  return new Promise<number>(() => undefined);
}

/** Read the claim, probe it, and print an honest verdict. Exit 0 only when running + compatible. */
async function status(argv: readonly string[], io: CliIo, env: NodeJS.ProcessEnv): Promise<number> {
  const { dataDir } = resolveDaemonConfig(argv, env);
  const verdict = await findHealthyDaemon(dataDir);
  switch (verdict.kind) {
    case "healthy":
      io.out(
        `running (pid ${verdict.identity.pid}, port ${verdict.identity.wsPort}, v${verdict.identity.version}, protocol ${verdict.identity.protocolVersion})`,
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
async function stop(argv: readonly string[], io: CliIo, env: NodeJS.ProcessEnv): Promise<number> {
  const { dataDir } = resolveDaemonConfig(argv, env);
  const claim = readDaemonFile(dataDir);
  if (!claim) {
    io.out("not running");
    return 0;
  }
  try {
    process.kill(claim.pid, "SIGTERM");
  } catch (error) {
    // ESRCH: the pid is already gone — the claim is stale. Clear it and report success.
    if ((error as NodeJS.ErrnoException).code === "ESRCH") {
      removeDaemonFile(dataDir);
      io.out(`removed stale pidfile (pid ${claim.pid} was already gone)`);
      return 0;
    }
    io.err(`failed to signal pid ${claim.pid}: ${(error as Error).message}`);
    return 1;
  }
  // The daemon removes daemon.json on clean shutdown; poll for that as the done signal.
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (!readDaemonFile(dataDir)) {
      io.out(`stopped (pid ${claim.pid})`);
      return 0;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  io.err(`sent SIGTERM to pid ${claim.pid} but daemon.json is still present after 5s`);
  return 1;
}
