// The desktop shell as a supervisor + client (#379, design D3/D6). The shell no longer
// embeds the server: it finds a healthy daemon or spawns one, then connects the renderer
// to it over the same WS wire phase 2 established. Quitting the app leaves the daemon (and
// any running review turn) alive — that is the whole feature. On incompatible protocol skew
// the shell restarts the daemon with no dialog (Rule Zero; a personal product updates the
// daemon with the app); in-flight turns from the old daemon fold to `interrupted` via the
// existing lazy crash recovery.

import { join, resolve } from "node:path";
import {
  type DaemonInfo,
  type DaemonVerdict,
  findHealthyDaemon,
  readDaemonFile,
  removeDaemonFile,
  type SpawnDaemonOptions,
  spawnDaemon,
  waitForHealthy,
} from "@rennet/server";
import { app } from "electron";

/**
 * The bundled daemon entry to spawn. Packaged: the un-asar'd copy (forge `asarUnpack`), so
 * a plain Node process can load it from a real path. Dev: the sibling of the running main
 * bundle (`dist/main` → `dist/server`).
 */
export function resolveServerBundle(): string {
  if (app.isPackaged) {
    return join(`${app.getAppPath()}.unpacked`, "dist", "server", "index.cjs");
  }
  return resolve(__dirname, "../server/index.cjs");
}

/**
 * Whether this app owns a RUNNING daemon (drives the tray Quit label, tray-presence). The
 * daemon.json claim is "a claim to verify, never truth" (daemon-file.ts) — a health probe
 * confirms the process at that pid/port really is our daemon, so a stale claim whose pid was
 * reused by an unrelated process never reads as owned (review finding 5). Both `healthy` and
 * `incompatible` mean a verified live owned daemon (identity/port matched); `stale`/`absent`
 * mean nothing is owned here.
 */
export async function isOwnedDaemonRunning(
  dataDir: string,
  probe: (dataDir: string) => Promise<DaemonVerdict> = findHealthyDaemon,
): Promise<boolean> {
  const verdict = await probe(dataDir);
  return verdict.kind === "healthy" || verdict.kind === "incompatible";
}

export interface StopOwnedDaemonDeps {
  readonly probe: (dataDir: string) => Promise<DaemonVerdict>;
  readonly removeClaim: (dataDir: string, expectedPid: number) => boolean;
  readonly readClaim: (dataDir: string) => DaemonInfo | null;
  readonly kill: (pid: number, signal: "SIGTERM") => void;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly warn: (message: string) => void;
  readonly timeoutMs: number;
}

/**
 * Stop the OWNED daemon the same way `rennet stop` does (tray "Quit completely",
 * design D3): HEALTH-VERIFY the claim first, then SIGTERM only a pid the probe confirmed is
 * our daemon (which triggers its graceful shutdown — in-flight turns persist as resumable
 * `interrupted`), and poll — bounded — for the claim to clear. It NEVER signals an unverified
 * pid: a stale claim (dead pid, or a pid the OS reused for an unrelated process) is REMOVED,
 * not killed (review finding 2), so tray Quit can never take down someone else's process.
 * No claim/absent ⇒ nothing to stop. A pid that races to gone (ESRCH) is success. On timeout
 * it warns truthfully and returns — the caller exits regardless, exactly as `rennet stop`
 * exits after its bounded wait; the claim-file protocol keeps the next launch honest either way.
 */
export async function stopOwnedDaemon(
  dataDir: string,
  overrides: Partial<StopOwnedDaemonDeps> = {},
): Promise<void> {
  const deps: StopOwnedDaemonDeps = {
    probe: findHealthyDaemon,
    removeClaim: removeDaemonFile,
    readClaim: readDaemonFile,
    kill: (pid, signal) => {
      process.kill(pid, signal);
    },
    now: Date.now,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    warn: console.warn,
    timeoutMs: 5_000,
    ...overrides,
  };
  const verdict = await deps.probe(dataDir);
  if (verdict.kind === "absent") return; // nothing owned here — remote-only or already stopped.
  if (verdict.kind === "stale") {
    // The pid did not answer /healthz (dead, or reused by an unrelated process): remove the
    // claim, signal NOTHING. Mirrors `rennet stop`'s stale-pidfile branch.
    deps.removeClaim(dataDir, verdict.claim.pid);
    return;
  }
  // healthy | incompatible: the probe verified this pid/port IS our daemon — safe to signal.
  const claim = verdict.claim;
  try {
    deps.kill(claim.pid, "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") {
      deps.removeClaim(dataDir, claim.pid); // raced to gone between probe and signal.
      return;
    }
    deps.warn(
      `rennet: failed to signal owned daemon pid ${claim.pid}: ${(error as Error).message}`,
    );
    return;
  }
  const deadline = deps.now() + deps.timeoutMs;
  while (deps.now() < deadline) {
    if (deps.readClaim(dataDir)?.pid !== claim.pid) return; // claim cleared — clean stop.
    await deps.sleep(100);
  }
  deps.warn(
    `rennet: sent SIGTERM to owned daemon pid ${claim.pid} but daemon.json is still present after ${deps.timeoutMs}ms; exiting anyway`,
  );
}

/** Wait (bounded) for the signalled daemon to stop owning the claim after SIGTERM. */
async function waitForClaimGone(
  dataDir: string,
  expectedPid: number,
  readClaim: (dataDir: string) => DaemonInfo | null,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (readClaim(dataDir)?.pid === expectedPid && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
  }
}

export interface DaemonSupervisorDeps {
  readonly probe: (dataDir: string) => Promise<DaemonVerdict>;
  readonly spawn: (options: SpawnDaemonOptions) => unknown;
  readonly waitForHealthy: typeof waitForHealthy;
  readonly kill: (pid: number, signal: "SIGTERM") => void;
  readonly readClaim: (dataDir: string) => DaemonInfo | null;
  readonly execPath: string;
  readonly entryPath: string;
  readonly serverVersion: string;
  readonly env: NodeJS.ProcessEnv;
  readonly warn: (message: string) => void;
}

/**
 * Return the WS port of a healthy daemon for `dataDir`, spawning or skew-restarting one as
 * needed. The spawn runs the Electron binary as Node (`ELECTRON_RUN_AS_NODE`, detached,
 * logging to `<dataDir>/daemon.log`) so the packaged app needs no system Node.
 */
export async function ensureDaemon(
  dataDir: string,
  overrides: Partial<DaemonSupervisorDeps> = {},
): Promise<number> {
  const deps: DaemonSupervisorDeps = {
    probe: findHealthyDaemon,
    spawn: spawnDaemon,
    waitForHealthy,
    kill: (pid, signal) => {
      process.kill(pid, signal);
    },
    readClaim: readDaemonFile,
    execPath: process.execPath,
    entryPath: resolveServerBundle(),
    serverVersion: app.getVersion(),
    env: process.env,
    warn: console.warn,
    ...overrides,
  };
  const verdict = await deps.probe(dataDir);
  if (verdict.kind === "healthy") {
    if (verdict.identity.version === deps.serverVersion) return verdict.identity.wsPort;
    // The daemon updates WITH the app (the header doctrine) — but the protocol-only
    // check let a healthy OLDER daemon serve a freshly updated shell forever.
    // Field bug, lancelot 2026-08-19: a 0.2.14 daemon kept serving a 0.2.18 app,
    // so none of the shipped egress fixes were live and every project.detail
    // waited undici's 300s headers timeout ("5 minutes plus"). Same posture as
    // protocol skew: restart with no ceremony. In-flight turns fold to
    // `interrupted` via lazy crash recovery; reviews persist in sqlite.
    deps.warn(
      `rennet: daemon runs server ${verdict.identity.version} but the app ships ${deps.serverVersion}; restarting the bundled daemon`,
    );
    try {
      deps.kill(verdict.claim.pid, "SIGTERM");
    } catch {
      // Already gone — the next spawn overwrites the stale claim.
    }
    await waitForClaimGone(dataDir, verdict.claim.pid, deps.readClaim);
  }

  if (verdict.kind === "incompatible") {
    // D3/D10: the shell owns the newer bundle, so it restarts — no ceremony, just a log.
    deps.warn(
      `rennet: daemon protocol ${verdict.identity.protocolVersion} is incompatible (${verdict.reason}); restarting the bundled daemon`,
    );
    try {
      deps.kill(verdict.claim.pid, "SIGTERM");
    } catch {
      // Already gone — the next spawn overwrites the stale claim.
    }
    await waitForClaimGone(dataDir, verdict.claim.pid, deps.readClaim);
  }

  const spawnEnv: NodeJS.ProcessEnv = { ...deps.env };
  // The daemon resolves its own data dir from `--data-dir` (spawnDaemon passes it), so the
  // shell's RENNET_USER_DATA override must not double-apply from the inherited env.
  delete spawnEnv.RENNET_USER_DATA;
  // Give the daemon's libuv thread pool headroom from birth so the repo-watcher's
  // fs load cannot starve undici's DNS for GitHub (see daemon-main.ts). Setting it
  // at spawn guarantees it precedes the pool's first use; an explicit value wins.
  spawnEnv.UV_THREADPOOL_SIZE ??= "16";
  deps.spawn({
    dataDir,
    execPath: deps.execPath,
    entryPath: deps.entryPath,
    serverVersion: deps.serverVersion,
    env: spawnEnv,
  });
  const healthy = await deps.waitForHealthy(dataDir);
  return healthy.identity.wsPort;
}
