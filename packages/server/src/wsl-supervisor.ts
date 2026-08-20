// WSL daemon orchestrator (change `wsl-daemon-runtime`, Group 3). This is the
// integration seam: it COMPOSES the Wave 1-2 primitives (`core`'s home/bundle/node
// builders + this package's spawn/health/stop) into ONE "ensure a healthy WSL daemon
// for this distro" call, with EVERY effect injected. So the whole path is unit-testable
// with fakes — no real distro, socket, or clock — and the desktop main is a thin
// locus-select over it (the live wiring is validated by the lancelot field proof, Wave 6).
//
// Two runner shapes meet here: `core`'s `resolveWslNode` / home probe want a runner that
// resolves stdout (`Promise<string>`); Wave 2's `WslRunner` resolves `{stdout, code}`.
// The orchestrator takes ONE bounded `WslRunner` and derives the string adapter itself,
// so the desktop injects a single `execFile`-backed runner and nothing double-wraps it.

import {
  buildWslDaemonLaunch,
  buildWslHomeProbe,
  ensureWslBundleDelivered,
  type LocusCommand,
  parseWslHome,
  resolveWslNode,
  wslDaemonDataDir,
} from "@rennet/core";
import type { DaemonIdentity } from "./ws-listener";
import {
  type FetchLike,
  probeWslDaemonHealth,
  readWslDaemonPort,
  spawnWslDaemon,
  stopWslDaemon,
  type WslDaemonLocation,
  type WslRunner,
  type WslSpawnDeps,
  waitForWslDaemon,
} from "./wsl-daemon";

export interface EnsureWslDaemonDeps {
  /** The app/server version this shell ships. A healthy daemon on another version is restarted. */
  readonly serverVersion: string;
  /** The host bundle path delivered into the distro (a Windows path; `wslpath`-translated on copy). */
  readonly hostBundlePath: string;
  /**
   * The bounded runner: one `wsl.exe … -e <program> <argv>` exec → `{stdout, code}`. It MUST
   * carry its own per-call timeout — a `run` that hangs forever would stall the health wait.
   */
  readonly run: WslRunner;
  /** The detached spawner (defaults to `child_process.spawn` inside `spawnWslDaemon`). */
  readonly spawn?: WslSpawnDeps["spawn"];
  /** The `/healthz` fetch (defaults to the global `fetch`). */
  readonly fetch?: FetchLike;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly waitTimeoutMs?: number;
}

export interface WslDaemonHandle {
  readonly port: number;
  readonly identity: DaemonIdentity;
}

/** The current healthy daemon at the distro's published port, or `null` (absent / dead / torn). */
async function currentHealth(
  location: WslDaemonLocation,
  deps: EnsureWslDaemonDeps,
): Promise<WslDaemonHandle | null> {
  const port = await readWslDaemonPort(location, deps.run);
  if (port === null) return null;
  const identity = await probeWslDaemonHealth(port, { fetch: deps.fetch });
  return identity ? { port, identity } : null;
}

/**
 * Ensure a healthy daemon runs INSIDE `distro` and return its loopback port + identity.
 *
 * Flow: resolve the distro's `$HOME` (so the data dir + bundle path are distro-native),
 * then probe for an already-running daemon. A healthy daemon on the shell's own version
 * is reused as-is. Otherwise resolve the distro's Node, deliver the versioned bundle into
 * the distro's native fs, build the launch, and — for a VERSION-SKEW daemon (healthy but a
 * different version) — stop the old one by the pid its identity carries before spawning the
 * current bundle. Health is decided on the port, never across 9P (design.md Decisions 2/3).
 *
 * `WslNodeNotFoundError` (no Node in the distro) and `WslBundleDeliveryError` (copy failed)
 * are surfaced plainly — never swallowed — so the shell reports them instead of hanging.
 */
export async function ensureWslDaemon(
  distro: string,
  deps: EnsureWslDaemonDeps,
): Promise<WslDaemonHandle> {
  const { run, serverVersion } = deps;
  // Derive the stdout-only shape `core`'s probes want from the one bounded runner. Trust
  // stdout ONLY on a clean exit: a nonzero/timeout run may have flushed PARTIAL stdout that
  // must never be parsed as a valid $HOME or Node path (empty → parse → null → clear error,
  // never a half-read path fed to a spawn).
  const runString = async (command: LocusCommand): Promise<string> => {
    const { stdout, code } = await run(command);
    return code === 0 ? stdout : "";
  };

  const distroHome = parseWslHome(await runString(buildWslHomeProbe(distro)));
  if (!distroHome) {
    throw new Error(
      `Could not resolve $HOME in WSL distro "${distro}" (home probe was not absolute).`,
    );
  }
  const dataDir = wslDaemonDataDir(distroHome);
  const location: WslDaemonLocation = { distro, distroDataDir: dataDir };

  // A healthy daemon on our exact version needs nothing further — skip Node resolution and
  // delivery entirely (both cost interactive wsl.exe execs). Version skew falls through to
  // a stop-then-respawn below; absent / dead falls through to a plain spawn.
  const existing = await currentHealth(location, deps);
  if (existing && existing.identity.version === serverVersion) return existing;

  const nodePath = await resolveWslNode(distro, runString); // throws WslNodeNotFoundError
  const bundlePath = await ensureWslBundleDelivered(
    { distro, distroHome, version: serverVersion, hostBundlePath: deps.hostBundlePath },
    run,
  ); // throws WslBundleDeliveryError
  const launch = buildWslDaemonLaunch({ distro, nodePath, bundlePath, dataDir, serverVersion });

  if (existing) {
    // Healthy but version-skewed: stop the old daemon by the pid its identity carries, then
    // spawn the current bundle. In-flight turns fold to `interrupted`; reviews persist in sqlite
    // — the same no-ceremony restart the host supervisor performs (D3/D10, Rule Zero). WAIT
    // (bounded) for the old identity to actually disappear BEFORE spawning — mirroring the host
    // supervisor's `waitForClaimGone`, so the fresh daemon's claim never races the dying one's.
    await stopWslDaemon({ distro, pid: existing.identity.pid }, run);
    await waitForWslIdentityGone(location, existing.identity.pid, deps);
  }

  spawnWslDaemon(launch, deps.spawn ? { spawn: deps.spawn } : {});
  const handle = await waitForWslDaemon(location, {
    run,
    fetch: deps.fetch,
    now: deps.now,
    sleep: deps.sleep,
    timeoutMs: deps.waitTimeoutMs,
  });
  // A skew restart that somehow handed the OLD daemon back (stale claim, lost race) would
  // silently re-serve the wrong version — the exact lancelot field bug for the host path.
  // Confirm the identity we resolved is the version this shell ships.
  if (handle.identity.version !== serverVersion) {
    throw new Error(
      `WSL daemon in "${distro}" reports version ${handle.identity.version} after restart, expected ${serverVersion}.`,
    );
  }
  return handle;
}

/**
 * Wait (bounded) for the daemon at `location` to stop reporting `oldPid` — i.e. the old
 * daemon is gone (absent) or already replaced by a different pid. Mirrors the host
 * supervisor's `waitForClaimGone`; clock/sleep are injected so the deadline is testable
 * without real time. On timeout it falls through (the spawn overwrites the claim regardless).
 */
async function waitForWslIdentityGone(
  location: WslDaemonLocation,
  oldPid: number,
  deps: EnsureWslDaemonDeps,
): Promise<void> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const deadline = now() + (deps.waitTimeoutMs ?? 10_000);
  for (;;) {
    const current = await currentHealth(location, deps);
    if (!current || current.identity.pid !== oldPid) return;
    if (now() >= deadline) return;
    await sleep(50);
  }
}
