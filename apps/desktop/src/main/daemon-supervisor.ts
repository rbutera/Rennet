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
  type DaemonShutdownAck,
  type DaemonVerdict,
  type EnsureWslDaemonDeps,
  ensureWslDaemon,
  findHealthyDaemon,
  type ProcessState,
  processState,
  readDaemonFile,
  removeDaemonFile,
  requestDaemonShutdown,
  SHUTDOWN_ACK_TIMEOUT_MS,
  type SpawnDaemonOptions,
  type StopSidecarOutcome,
  spawnDaemon,
  stopSidecar,
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

/**
 * dataDir → the TAIL of that data dir's daemon-lifecycle chain, so a START and a STOP for one
 * dataDir never interleave. Without it `stopOwnedDaemon` could probe `absent` while an
 * `ensureDaemon` was mid-spawn and report "stopped" — and the spawn it never saw would then
 * hand a LIVE bundle-backed daemon to the platform installer, which is the one thing
 * `prepareOwnedDaemonForUpdate` exists to prevent. Concurrent ensures still FOLD (one probe,
 * one spawn) via `hostInFlight`; this chain only orders starts against stops.
 */
const hostOps = new Map<string, Promise<unknown>>();

/**
 * Run `op` after whatever is already queued for `dataDir`, and leave it as the new tail. The
 * predecessor is awaited SETTLED-EITHER-WAY: `ensureDaemon` genuinely rejects (the skew cap, a
 * probe that throws), and that rejection must not wedge every later stop — a data dir whose
 * daemon refuses to start still has to be quittable and still has to release the installer.
 */
function chainDaemonOp<T>(
  ops: Map<string, Promise<unknown>>,
  dataDir: string,
  op: () => Promise<T>,
): Promise<T> {
  const prior = (ops.get(dataDir) ?? Promise.resolve()).then(
    () => undefined,
    () => undefined,
  );
  // `next` is returned to the caller, so its rejection is always someone's to handle.
  const next = prior.then(op);
  ops.set(dataDir, next);
  return next;
}

/** The per-dataDir op chain, injectable so a test gets a fresh one. */
export interface DaemonOpQueueOverride {
  readonly ops?: Map<string, Promise<unknown>>;
}

/**
 * The part of a spawned daemon's `ChildProcess` this module uses (#820): has it exited, and
 * tell me when it does. Narrow on purpose — a test drives it with an EventEmitter.
 */
export interface DaemonChild {
  readonly pid?: number;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  once(event: "exit", listener: () => void): unknown;
  off(event: "exit", listener: () => void): unknown;
}

/**
 * dataDir → the daemon THIS app instance spawned. Keeping the handle is load-bearing twice
 * over, and discarding it at the spawn site is what stranded the 0.6.5 → 0.7.0 update (#820):
 *
 * - Node reaps a child through its process handle. With the handle gone, the daemon that
 *   exited cleanly on SIGTERM stayed a ZOMBIE — and a zombie answers `kill(pid, 0)` as alive
 *   for as long as its parent lives, so the stop's pid probe could never see it go.
 * - `exit` on the handle is the only unambiguous "that process is gone" a supervisor can get.
 *   A probe cannot tell a zombie from a live daemon; the child's own exit event can.
 *
 * Only an instance that spawned the daemon has an entry. A daemon inherited from an earlier
 * instance belongs to launchd (which reaps it instantly), and the stop falls back to watching
 * the claim and the process state.
 */
const hostChildren = new Map<string, DaemonChild>();

/** The dataDir → spawned-child map, injectable so a test gets a fresh one. */
export interface DaemonChildOverride {
  readonly children?: Map<string, DaemonChild>;
}

/** The spawn seam returns `unknown`; keep it only when it really is a child process handle. */
function asDaemonChild(value: unknown): DaemonChild | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<DaemonChild>;
  if (typeof candidate.once !== "function" || typeof candidate.off !== "function") return undefined;
  return "exitCode" in candidate ? (candidate as DaemonChild) : undefined;
}

/**
 * Resolve once the child has exited, or false if it has not within `timeoutMs`. An already
 * exited child answers immediately: `exit` fires once, and a handle that has already fired it
 * would otherwise hang here for the whole budget.
 */
function waitForChildExit(child: DaemonChild, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolvePromise) => {
    const settle = (exited: boolean): void => {
      clearTimeout(timer);
      child.off("exit", onExit);
      resolvePromise(exited);
    };
    const onExit = (): void => settle(true);
    const timer = setTimeout(() => settle(false), timeoutMs);
    timer.unref?.();
    child.once("exit", onExit);
  });
}

export interface StopOwnedDaemonDeps {
  readonly probe: (dataDir: string) => Promise<DaemonVerdict>;
  readonly removeClaim: (dataDir: string, expectedPid: number) => boolean;
  readonly readClaim: (dataDir: string) => DaemonInfo | null;
  /** Ask the daemon to shut itself down over its own wire; the ack names the pid that heard it. */
  readonly requestShutdown: (
    wsPort: number,
    timeoutMs: number,
  ) => Promise<DaemonShutdownAck | null>;
  /** The child handle for a daemon THIS instance spawned, if it spawned one. */
  readonly childFor: (dataDir: string) => DaemonChild | undefined;
  /** Wait (bounded) for a spawned child to exit; true once it has. */
  readonly waitForChildExit: (child: DaemonChild, timeoutMs: number) => Promise<boolean>;
  /** Running / zombie / gone — never plain signal-0, which calls a zombie alive. */
  readonly processState: (pid: number) => ProcessState;
  readonly kill: (pid: number, signal: "SIGTERM" | "SIGKILL") => void;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly warn: (message: string) => void;
  /** Bound on each poll for an INHERITED daemon's claim + process to clear. */
  readonly timeoutMs: number;
  /** Bound on the `POST /shutdown` ack. */
  readonly ackTimeoutMs: number;
  /** Bound on waiting for an acknowledged daemon to exit; it may be draining a turn. */
  readonly exitTimeoutMs: number;
  /** Stop the owned T3 Code sidecar AFTER the daemon (t3code-sidecar-chat). */
  readonly stopSidecar: (dataDir: string) => Promise<StopSidecarOutcome>;
}

export type StopOwnedDaemonOutcome =
  | { readonly kind: "stopped" }
  | { readonly kind: "failed"; readonly message: string };

/**
 * Stop the OWNED daemon the same way `rennet stop` does (tray "Quit completely",
 * design D3): HEALTH-VERIFY the claim first, then ASK the daemon to shut down over its own
 * wire, and wait for the process to actually go. It NEVER signals an unverified pid: a stale
 * claim is never killed, so tray Quit can never take down a process it could not verify. A
 * dead stale pid is removed; a live stale pid blocks update installation because it could
 * still be the bundle-backed daemon holding the app open.
 *
 * The ladder, in order (#820):
 *   1. `POST /shutdown`. An ack whose pid matches the claim means that process heard it and
 *      is going — the daemon's graceful stop, so in-flight turns persist as resumable
 *      `interrupted` exactly as under SIGTERM.
 *   2. Wait for it to be GONE: the `exit` event of the child we spawned when we have one
 *      (which is also what makes Node reap it, so no zombie survives), or the claim clearing
 *      AND the pid no longer running when the daemon was inherited from an earlier instance.
 *   3. No ack, or an acked daemon that did not go: SIGTERM, wait again; then SIGKILL, wait again.
 *
 * No claim/absent ⇒ nothing to stop. A pid that races to gone (ESRCH) is success. Only after
 * the whole ladder does it fail, and the failure names the state it actually found — exited
 * but unreaped, still running, or the claim still naming that pid — never a disjunction of
 * the two, which sent the first look at #820 to the wrong half. Complete quit still exits
 * regardless, while update application refuses to hand a live process to the installer.
 */
export function stopOwnedDaemon(
  dataDir: string,
  overrides: Partial<StopOwnedDaemonDeps> & DaemonOpQueueOverride = {},
): Promise<StopOwnedDaemonOutcome> {
  // Queued behind any in-flight ensure for this dataDir (and ahead of any that arrives while
  // this runs), so the probe below can never miss a spawn that is already underway.
  return chainDaemonOp(overrides.ops ?? hostOps, dataDir, () =>
    stopOwnedDaemonOnce(dataDir, overrides),
  );
}

async function stopOwnedDaemonOnce(
  dataDir: string,
  overrides: Partial<StopOwnedDaemonDeps> = {},
): Promise<StopOwnedDaemonOutcome> {
  const deps: StopOwnedDaemonDeps = {
    stopSidecar,
    probe: findHealthyDaemon,
    removeClaim: removeDaemonFile,
    readClaim: readDaemonFile,
    requestShutdown: requestDaemonShutdown,
    childFor: (dir) => hostChildren.get(dir),
    waitForChildExit,
    processState,
    kill: (pid, signal) => {
      process.kill(pid, signal);
    },
    now: Date.now,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    warn: console.warn,
    timeoutMs: 5_000,
    ackTimeoutMs: SHUTDOWN_ACK_TIMEOUT_MS,
    exitTimeoutMs: 10_000,
    ...overrides,
  };
  const outcome = await stopDaemonProcess(dataDir, deps);
  // The sidecar goes AFTER the daemon has interrupted its own turns (and, on a clean
  // shutdown, has already signalled its child); this reaps whatever survived.
  await stopOwnedSidecar(dataDir, deps);
  return outcome;
}

async function stopDaemonProcess(
  dataDir: string,
  deps: StopOwnedDaemonDeps,
): Promise<StopOwnedDaemonOutcome> {
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
    // A zombie here is not a live daemon: it holds no port and no bundle, so it does not
    // block the installer. Only a RUNNING unverifiable pid does.
    if (deps.processState(verdict.claim.pid) === "running") {
      const message = `rennet: daemon claim pid ${verdict.claim.pid} is still alive but could not be health-verified; refusing to signal it or start the installer`;
      deps.warn(message);
      return { kind: "failed", message };
    }
    deps.removeClaim(dataDir, verdict.claim.pid);
    return { kind: "stopped" };
  }
  // healthy | incompatible: the probe verified this pid/port IS our daemon — safe to command.
  const claim = verdict.claim;
  const child = deps.childFor(dataDir);

  // 1. Ask the daemon to stop itself. The ack is the evidence a signal never gave us: THIS
  //    pid heard the command. An ack from another pid means the port moved on us, so it is
  //    not evidence about `claim.pid` and the ladder falls through to the signals.
  const ack = await deps.requestShutdown(claim.wsPort, deps.ackTimeoutMs);
  const acknowledged = ack?.pid === claim.pid;
  if (acknowledged && (await daemonExited(dataDir, claim.pid, child, deps, deps.exitTimeoutMs))) {
    deps.removeClaim(dataDir, claim.pid);
    return { kind: "stopped" };
  }

  // 2. It did not answer, or answered and did not go. Signal it, hardest last.
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    try {
      deps.kill(claim.pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") {
        deps.removeClaim(dataDir, claim.pid); // raced to gone between probe and signal.
        return { kind: "stopped" };
      }
      const message = `rennet: failed to signal owned daemon pid ${claim.pid}: ${(error as Error).message}`;
      deps.warn(message);
      return { kind: "failed", message };
    }
    if (await daemonExited(dataDir, claim.pid, child, deps, deps.timeoutMs)) {
      deps.removeClaim(dataDir, claim.pid);
      return { kind: "stopped" };
    }
  }

  const asked = acknowledged
    ? "acknowledged a shutdown request, then SIGTERM and SIGKILL"
    : "did not acknowledge a shutdown request, then took SIGTERM and SIGKILL";
  const message = `rennet: owned daemon pid ${claim.pid} ${asked}, and ${describeDaemonState(dataDir, claim.pid, deps)}`;
  deps.warn(message);
  return { kind: "failed", message };
}

/**
 * Has that daemon's process actually gone? With a child handle the answer is its `exit`
 * event — the only signal that separates a live daemon from a zombie, and the wait that makes
 * Node reap the zombie. Without one (a daemon inherited from an earlier app instance, which
 * launchd owns and reaps) the answer is the pair the claim and the process state make: the
 * claim no longer names it AND it is not running.
 */
async function daemonExited(
  dataDir: string,
  pid: number,
  child: DaemonChild | undefined,
  deps: StopOwnedDaemonDeps,
  timeoutMs: number,
): Promise<boolean> {
  if (child) return deps.waitForChildExit(child, timeoutMs);
  const deadline = deps.now() + timeoutMs;
  for (;;) {
    const claimCleared = deps.readClaim(dataDir)?.pid !== pid;
    if (claimCleared && deps.processState(pid) !== "running") return true;
    if (deps.now() >= deadline) return false;
    await deps.sleep(100);
  }
}

/** Say which thing is actually true, so the first look at a failure starts in the right place. */
function describeDaemonState(dataDir: string, pid: number, deps: StopOwnedDaemonDeps): string {
  const state = deps.processState(pid);
  const process =
    state === "zombie"
      ? "it has exited but has not been reaped"
      : state === "running"
        ? "it is still running"
        : "its process is gone";
  const claimed = deps.readClaim(dataDir)?.pid === pid ? ", and daemon.json still names it" : "";
  return `${process}${claimed}`;
}

/**
 * The sidecar step (t3code-sidecar-chat, 2.6): after the daemon has had its turn, stop the
 * owned T3 Code sidecar the same way — verified pid only, SIGTERM, bounded wait, claim
 * cleared. A daemon that shut down cleanly already signalled its own child; this reaps a
 * survivor of a daemon crash. A sidecar that will not exit is logged and left for the next
 * start; the app still exits.
 */
async function stopOwnedSidecar(dataDir: string, deps: StopOwnedDaemonDeps): Promise<void> {
  try {
    const outcome = await deps.stopSidecar(dataDir);
    if (outcome.kind === "timeout") {
      deps.warn(
        `rennet: sent SIGTERM to owned T3 sidecar pid ${outcome.pid} but it is still running; the next start will reap it`,
      );
    }
  } catch (error) {
    deps.warn(
      `rennet: failed to stop the owned T3 sidecar: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Stop the owned daemon before the installer replaces the bundle it runs from; throws on a
 *  stop that could not be verified. Serialized against `ensureDaemon` through `stopOwnedDaemon`. */
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
  /** Ask a skewed daemon to shut itself down before reaching for a signal (#820). */
  readonly requestShutdown: (
    wsPort: number,
    timeoutMs: number,
  ) => Promise<DaemonShutdownAck | null>;
  readonly kill: (pid: number, signal: "SIGTERM") => void;
  readonly readClaim: (dataDir: string) => DaemonInfo | null;
  readonly execPath: string;
  readonly entryPath: string;
  readonly serverVersion: string;
  readonly env: NodeJS.ProcessEnv;
  readonly warn: (message: string) => void;
}

export interface EnsureDaemonOverrides
  extends Partial<DaemonSupervisorDeps>,
    DaemonOpQueueOverride,
    DaemonChildOverride {
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
 *
 * Folding is conditional on the `hostOps` tail: an ensure that arrives after a stop was queued
 * must NOT join the ensure that stop is waiting for, or it would resolve with a port the stop
 * then kills.
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
 * two spawns, and serialized against `stopOwnedDaemon` for the same dataDir (see `hostOps`).
 */
export async function ensureDaemon(
  dataDir: string,
  overrides: EnsureDaemonOverrides = {},
): Promise<number> {
  const inFlight = overrides.inFlight ?? hostInFlight;
  const ops = overrides.ops ?? hostOps;
  const pending = inFlight.get(dataDir);
  // Fold onto the in-flight ensure only while it is STILL the chain tail. Once a stop has been
  // queued behind it the tail has moved, and folding would hand this caller a port the stop is
  // about to kill — so it queues a fresh ensure behind that stop instead, and probes after it.
  if (pending && ops.get(dataDir) === pending) return pending;
  // Queued behind any in-flight stop/prepare for this dataDir, so an ensure can never spawn a
  // daemon into the middle of an installer handoff.
  const started = chainDaemonOp(ops, dataDir, () => ensureDaemonOnce(dataDir, overrides));
  inFlight.set(dataDir, started);
  try {
    return await started;
  } finally {
    // Only if it is still ours: a later ensure that refused to fold owns the entry now, and
    // clearing that one would stop a third caller from folding onto the ensure actually running.
    if (inFlight.get(dataDir) === started) inFlight.delete(dataDir);
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
    requestShutdown: requestDaemonShutdown,
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
  const children = overrides.children ?? hostChildren;
  // Restart a skewed daemon, but only while restarts remain: ask it to shut down over its own
  // wire (the same command the tray and the installer handoff send, #820), SIGTERM only if it
  // will not answer, wait (bounded) for its claim to clear, then let the caller spawn. Past the
  // cap this throws instead of respawning, so a daemon that keeps coming back skewed cannot storm.
  const restartSkewedDaemon = async (pid: number, wsPort: number): Promise<void> => {
    const spent = skewRestarts.get(dataDir) ?? 0;
    if (spent >= SKEW_RESTART_LIMIT) {
      throw new Error(
        `rennet: the daemon for ${dataDir} came back on a mismatched version ${SKEW_RESTART_LIMIT} times; not restarting it again (see ${join(dataDir, "daemon.log")})`,
      );
    }
    skewRestarts.set(dataDir, spent + 1);
    const ack = await deps.requestShutdown(wsPort, SHUTDOWN_ACK_TIMEOUT_MS);
    if (ack?.pid !== pid) {
      try {
        deps.kill(pid, "SIGTERM");
      } catch {
        // Already gone — the next spawn overwrites the stale claim.
      }
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
      await restartSkewedDaemon(verdict.claim.pid, verdict.claim.wsPort);
    } else if (verdict.kind === "incompatible") {
      // D3/D10: the shell owns the newer bundle, so it restarts — no ceremony, just a log.
      deps.warn(
        `rennet: daemon protocol ${verdict.identity.protocolVersion} is incompatible (${verdict.reason}); restarting the bundled daemon`,
      );
      await restartSkewedDaemon(verdict.claim.pid, verdict.claim.wsPort);
    }

    // KEEP the child handle (#820). Node reaps a child through its process handle, so the
    // discarded one here is why a stopped daemon lingered as a zombie that `kill(pid, 0)`
    // called alive; it is also the only thing that can tell the stop path the daemon is
    // really gone. The entry drops when the process exits.
    const child = asDaemonChild(
      deps.spawn({
        dataDir,
        execPath: deps.execPath,
        entryPath: deps.entryPath,
        serverVersion: deps.serverVersion,
        env: spawnEnv,
      }),
    );
    if (child) {
      children.set(dataDir, child);
      child.once("exit", () => {
        if (children.get(dataDir) === child) children.delete(dataDir);
      });
    }
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
