// The desktop shell as a supervisor + client (#379, design D3/D6). The shell no longer
// embeds the server: it finds a healthy daemon or spawns one, then connects the renderer
// to it over the same WS wire phase 2 established. Quitting the app leaves the daemon (and
// any running review turn) alive — that is the whole feature. On incompatible protocol skew
// the shell restarts the daemon with no dialog (Rule Zero; a personal product updates the
// daemon with the app); in-flight turns from the old daemon fold to `interrupted` via the
// existing lazy crash recovery.

import { join, resolve } from "node:path";
import { detectLocus } from "@rennet/core";
import {
  createWslRunner,
  type DaemonInfo,
  type DaemonVerdict,
  type EnsureWslDaemonDeps,
  ensureWslDaemon,
  findHealthyDaemon,
  readDaemonFile,
  removeDaemonFile,
  type SpawnDaemonOptions,
  spawnDaemon,
  waitForHealthy,
} from "@rennet/server";
import { app } from "electron";

// The bounded `wsl.exe` runner now lives beside `WslRunner` in @rennet/server — the daemon
// probes distro daemons for the settings surface (C17) with the same one. Re-exported so
// this module stays the shell's single WSL-supervision entry point.
export { createWslRunner } from "@rennet/server";

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
  readonly isAlive: (pid: number) => boolean;
  readonly kill: (pid: number, signal: "SIGTERM") => void;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly warn: (message: string) => void;
  readonly timeoutMs: number;
}

export type StopOwnedDaemonOutcome =
  | { readonly kind: "stopped" }
  | { readonly kind: "failed"; readonly message: string };

/**
 * Stop the OWNED daemon the same way `rennet stop` does (tray "Quit completely",
 * design D3): HEALTH-VERIFY the claim first, then SIGTERM only a pid the probe confirmed is
 * our daemon (which triggers its graceful shutdown — in-flight turns persist as resumable
 * `interrupted`), and poll — bounded — for the claim to clear. It NEVER signals an unverified
 * pid: a stale claim is never killed, so tray Quit can never take down a process it could not
 * verify. A dead stale pid is removed; a live stale pid blocks update installation because it
 * could still be the bundle-backed daemon holding the app open.
 * No claim/absent ⇒ nothing to stop. A pid that races to gone (ESRCH) is success. On timeout
 * it warns truthfully and returns a typed failure. Complete quit still exits regardless, while
 * update application refuses to hand a bundle-backed live process to the platform installer.
 */
export async function stopOwnedDaemon(
  dataDir: string,
  overrides: Partial<StopOwnedDaemonDeps> = {},
): Promise<StopOwnedDaemonOutcome> {
  const deps: StopOwnedDaemonDeps = {
    probe: findHealthyDaemon,
    removeClaim: removeDaemonFile,
    readClaim: readDaemonFile,
    isAlive: (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code !== "ESRCH";
      }
    },
    kill: (pid, signal) => {
      process.kill(pid, signal);
    },
    now: Date.now,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    warn: console.warn,
    timeoutMs: 5_000,
    ...overrides,
  };
  let verdict: DaemonVerdict;
  try {
    verdict = await deps.probe(dataDir);
  } catch (error) {
    const message = `rennet: failed to verify the owned daemon before stopping it: ${error instanceof Error ? error.message : String(error)}`;
    deps.warn(message);
    return { kind: "failed", message };
  }
  if (verdict.kind === "absent") return { kind: "stopped" };
  if (verdict.kind === "stale") {
    if (deps.isAlive(verdict.claim.pid)) {
      const message = `rennet: daemon claim pid ${verdict.claim.pid} is still alive but could not be health-verified; refusing to signal it or start the installer`;
      deps.warn(message);
      return { kind: "failed", message };
    }
    deps.removeClaim(dataDir, verdict.claim.pid);
    return { kind: "stopped" };
  }
  // healthy | incompatible: the probe verified this pid/port IS our daemon — safe to signal.
  const claim = verdict.claim;
  try {
    deps.kill(claim.pid, "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") {
      deps.removeClaim(dataDir, claim.pid); // raced to gone between probe and signal.
      return { kind: "stopped" };
    }
    const message = `rennet: failed to signal owned daemon pid ${claim.pid}: ${(error as Error).message}`;
    deps.warn(message);
    return { kind: "failed", message };
  }
  const deadline = deps.now() + deps.timeoutMs;
  while (deps.now() < deadline) {
    const claimCleared = deps.readClaim(dataDir)?.pid !== claim.pid;
    if (claimCleared && !deps.isAlive(claim.pid)) return { kind: "stopped" };
    await deps.sleep(100);
  }
  const message = `rennet: sent SIGTERM to owned daemon pid ${claim.pid} but its process or daemon.json is still present after ${deps.timeoutMs}ms`;
  deps.warn(message);
  return { kind: "failed", message };
}

export async function prepareOwnedDaemonForUpdate(
  dataDir: string,
  stop: (dataDir: string) => Promise<StopOwnedDaemonOutcome> = stopOwnedDaemon,
): Promise<void> {
  const outcome = await stop(dataDir);
  if (outcome.kind === "failed") throw new Error(outcome.message);
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

export interface EnsureDaemonOverrides extends Partial<DaemonSupervisorDeps> {
  /** dataDir → the IN-FLIGHT ensure for it (injectable so tests get a fresh one). */
  readonly inFlight?: Map<string, Promise<number>>;
  /** dataDir → skew restarts already spent this process (injectable so tests get a fresh one). */
  readonly skewRestarts?: Map<string, number>;
}

/**
 * dataDir → the IN-FLIGHT `ensureDaemon`, so two concurrent resolves (the renderer's
 * `resolveDaemonForPath` IPC is called per project open, and boot/apply-recovery call
 * `ensureDaemon` directly) fold into ONE probe-and-spawn instead of both reading `absent` and
 * both spawning a daemon that then races over daemon.json. The entry clears once settled, so a
 * later call re-probes — no cached port to go stale. Mirrors `wslInFlight` below.
 */
const hostInFlight = new Map<string, Promise<number>>();

/** dataDir → skew restarts spent this process; see `SKEW_RESTART_LIMIT`. */
const hostSkewRestarts = new Map<string, number>();

/**
 * How many CONSECUTIVE times one process will SIGTERM-and-respawn a version/protocol-skewed
 * daemon for the same dataDir. A daemon that keeps coming back skewed (a second installation
 * writing the same claim, a spawn that loses the race to it) would otherwise restart-storm
 * forever, killing a process and respawning per project open. At the cap the ensure fails
 * instead, and the failure already names `daemon.log`, where the real cause is.
 *
 * Consecutive, because the counter is cleared the moment an ensure resolves on a healthy
 * same-version daemon: the cap exists to stop a STORM, and a storm is a run of failures. One
 * skew today and another next week must not add up to a permanently unstartable data dir.
 */
export const SKEW_RESTART_LIMIT = 3;

/**
 * Return the WS port of a healthy daemon for `dataDir`, spawning or skew-restarting one as
 * needed. The spawn runs the Electron binary as Node (`ELECTRON_RUN_AS_NODE`, detached,
 * logging to `<dataDir>/daemon.log`) so the packaged app needs no system Node.
 *
 * Single-flighted per dataDir: concurrent callers join the running ensure rather than racing
 * two spawns.
 */
export async function ensureDaemon(
  dataDir: string,
  overrides: EnsureDaemonOverrides = {},
): Promise<number> {
  const inFlight = overrides.inFlight ?? hostInFlight;
  const pending = inFlight.get(dataDir);
  if (pending) return pending;
  const started = ensureDaemonOnce(dataDir, overrides);
  inFlight.set(dataDir, started);
  try {
    return await started;
  } finally {
    inFlight.delete(dataDir);
  }
}

async function ensureDaemonOnce(
  dataDir: string,
  overrides: EnsureDaemonOverrides = {},
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
  const skewRestarts = overrides.skewRestarts ?? hostSkewRestarts;
  // Restart a skewed daemon, but only while restarts remain: SIGTERM, wait (bounded) for its
  // claim to clear, then let the caller spawn. Past the cap this throws instead of respawning,
  // so a daemon that keeps coming back skewed cannot storm.
  const restartSkewedDaemon = async (pid: number): Promise<void> => {
    const spent = skewRestarts.get(dataDir) ?? 0;
    if (spent >= SKEW_RESTART_LIMIT) {
      throw new Error(
        `rennet: the daemon for ${dataDir} came back on a mismatched version ${SKEW_RESTART_LIMIT} times; not restarting it again (see ${join(dataDir, "daemon.log")})`,
      );
    }
    skewRestarts.set(dataDir, spent + 1);
    try {
      deps.kill(pid, "SIGTERM");
    } catch {
      // Already gone — the next spawn overwrites the stale claim.
    }
    await waitForClaimGone(dataDir, pid, deps.readClaim);
  };

  const spawnEnv: NodeJS.ProcessEnv = { ...deps.env };
  // The daemon resolves its own data dir from `--data-dir` (spawnDaemon passes it), so the
  // shell's RENNET_USER_DATA override must not double-apply from the inherited env.
  delete spawnEnv.RENNET_USER_DATA;
  // Give the daemon's libuv thread pool headroom from birth so the repo-watcher's
  // fs load cannot starve undici's DNS for GitHub (see daemon-main.ts). Setting it
  // at spawn guarantees it precedes the pool's first use; an explicit value wins.
  spawnEnv.UV_THREADPOOL_SIZE ??= "16";

  // One pass is "kill what is skewed, spawn ours, then PROVE what answered is ours". The proof
  // is the loop: a respawn that comes back skewed is another skewed daemon, not an answer, so it
  // is re-checked exactly like the one found at probe time and counted against the same cap.
  // Without the re-check the ensure resolved with whatever protocol-compatible daemon happened
  // to win the race — including the foreign installation whose skew triggered the restart — and
  // the renderer talked to it for the rest of the session.
  let verdict: DaemonVerdict = await deps.probe(dataDir);
  for (;;) {
    if (verdict.kind === "healthy") {
      if (verdict.identity.version === deps.serverVersion) {
        // A clean ensure ends the streak: the cap counts CONSECUTIVE skew restarts.
        skewRestarts.delete(dataDir);
        return verdict.identity.wsPort;
      }
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
      await restartSkewedDaemon(verdict.claim.pid);
    } else if (verdict.kind === "incompatible") {
      // D3/D10: the shell owns the newer bundle, so it restarts — no ceremony, just a log.
      deps.warn(
        `rennet: daemon protocol ${verdict.identity.protocolVersion} is incompatible (${verdict.reason}); restarting the bundled daemon`,
      );
      await restartSkewedDaemon(verdict.claim.pid);
    }

    deps.spawn({
      dataDir,
      execPath: deps.execPath,
      entryPath: deps.entryPath,
      serverVersion: deps.serverVersion,
      env: spawnEnv,
    });
    // `waitForHealthy` only ever answers `healthy` (it throws on protocol skew), so the one
    // thing left to check is the version — which the top of the loop does.
    verdict = await deps.waitForHealthy(dataDir);
  }
}

/** The WSL deps the shell hands `ensureWslDaemon`: this app's version + host bundle + the real runner. */
function defaultWslDeps(): EnsureWslDaemonDeps {
  return {
    serverVersion: app.getVersion(),
    hostBundlePath: resolveServerBundle(),
    run: createWslRunner(),
  };
}

/**
 * distro → the IN-FLIGHT ensure promise for that distro, so two concurrent project-opens on
 * the same distro fold into ONE `ensureWslDaemon` call. The entry is removed once settled, so a
 * later open re-ensures — no stale port cache (`ensureWslDaemon` self-short-circuits when a
 * healthy same-version daemon already runs, so re-ensuring is cheap and self-healing).
 */
const wslInFlight = new Map<string, Promise<number>>();

export interface DaemonForProjectDeps {
  /** The host-locus path — `ensureDaemon(dataDir)`, which single-flights per dataDir itself. */
  readonly ensureHostDaemon: (dataDir: string) => Promise<number>;
  /** The WSL orchestrator (packages/server); returns the distro daemon's port + identity. */
  readonly ensureWslDaemon: (
    distro: string,
    deps: EnsureWslDaemonDeps,
  ) => Promise<{ port: number }>;
  /** Build the WSL deps for a distro (version + host bundle + bounded runner). */
  readonly wslDeps: (distro: string) => EnsureWslDaemonDeps;
  /** The distro → in-flight ensure promise map (injectable so tests get a fresh one). */
  readonly inFlight: Map<string, Promise<number>>;
}

/**
 * Resolve the WS port that serves a project, SELECTED BY its execution locus (design D3/D4).
 *
 * - Host-locus: `ensureDaemon(dataDir)`, no WSL code runs. Concurrent opens fold into one
 *   ensure there (`hostInFlight`), the same way this seam folds concurrent WSL opens.
 * - WSL-locus: routes to the project's distro daemon via `ensureWslDaemon`, which itself
 *   self-short-circuits when a healthy same-version daemon already runs (so there is NO stale
 *   port cache to go wrong). Concurrent opens on the SAME distro fold into one in-flight ensure;
 *   the entry clears once settled so a later open re-ensures (self-healing). The renderer's
 *   bridge dials the port this returns; repo paths crossing into the distro are translated where
 *   they are spawned (adapters' `locusCommand` / `toDistroPath`), not here — this seam only
 *   resolves the port.
 *
 * The desktop main is deliberately thin here: the composed logic lives in the injectable-effect
 * `ensureWslDaemon` orchestrator (unit-tested in packages/server); the live end-to-end wiring is
 * validated by the lancelot field proof (Wave 6, deferred).
 */
export async function ensureDaemonForProject(
  projectPath: string,
  hostDataDir: string,
  overrides: Partial<DaemonForProjectDeps> = {},
): Promise<number> {
  const deps: DaemonForProjectDeps = {
    ensureHostDaemon: (dataDir) => ensureDaemon(dataDir),
    ensureWslDaemon,
    wslDeps: defaultWslDeps,
    inFlight: wslInFlight,
    ...overrides,
  };
  const locus = detectLocus(projectPath);
  if (locus.kind === "host") return deps.ensureHostDaemon(hostDataDir);
  const { distro } = locus;
  // Single-flight per distro: a concurrent open joins the running ensure; once it settles the
  // entry is dropped so the next open re-ensures against `ensureWslDaemon`'s own short-circuit.
  const pending = deps.inFlight.get(distro);
  if (pending) return pending;
  const promise = deps.ensureWslDaemon(distro, deps.wslDeps(distro)).then(({ port }) => port);
  deps.inFlight.set(distro, promise);
  try {
    return await promise;
  } finally {
    deps.inFlight.delete(distro);
  }
}
