// WSL daemon runtime (change `wsl-daemon-runtime`, Group 2). Spawn / health / stop
// for a daemon running INSIDE a WSL distro, over `wsl.exe`. Mirrors the host
// supervisor's detached/unref spawn shape (`supervise.ts`) but differs on the two
// things a distro daemon forces:
//
//   - the host opens NO Windows-side log fd — the daemon writes its own `daemon.log`
//     in its distro-native data dir, so the spawn's stdio is `"ignore"`.
//   - health is decided ON THE PORT, never by reading the claim file across 9P.
//     The shell learns the port with ONE `wsl.exe … -e cat daemon.json` read, then
//     health-checks `http://localhost:<port>/healthz` (design.md Decisions 2 & 3).
//
// Every effect (spawner, `run`, `fetch`, clock) is INJECTED, so the whole path is
// unit-testable with no real distro or socket.

import { spawn } from "node:child_process";
import { type LocusCommand, locusCommand, type WslRunResult } from "@rennet/core";
import { daemonInfoSchema } from "./daemon-file";
import { type DaemonIdentity, daemonIdentitySchema } from "./ws-listener";

/** How long to wait for a `/healthz` answer before treating the daemon as dead. */
const PROBE_TIMEOUT_MS = 500;

/** Just the `fetch` surface `probeWslDaemonHealth` uses; the global `fetch` satisfies it. */
export type FetchLike = (
  url: string,
  init: { signal: AbortSignal },
) => Promise<{ readonly status: number; json(): Promise<unknown> }>;

/**
 * Executes a `LocusCommand` in the distro, resolving its stdout + exit code. The
 * injected runner MUST be bounded (its own per-call timeout) — `waitForWslDaemon`
 * enforces a deadline between polls, but a single `run` that hangs forever would
 * still stall it. Wave 3's desktop runner wraps `execa` with a timeout to honor this.
 */
export type WslRunner = (command: LocusCommand) => Promise<WslRunResult>;

/** Where a WSL daemon lives: which distro and its distro-native data dir. */
export interface WslDaemonLocation {
  readonly distro: string;
  /** Distro-native data dir the daemon owns (`daemon.json`, `daemon.log`). */
  readonly distroDataDir: string;
}

/** The child handle `spawnWslDaemon` needs: own its async `error`, then `unref`. */
export interface WslChild {
  on(event: "error", listener: (error: Error) => void): void;
  unref(): void;
}

export interface WslSpawnDeps {
  /** The spawner; defaults to `child_process.spawn`. Tests inject a recorder. */
  readonly spawn?: (
    file: string,
    args: readonly string[],
    options: { readonly detached: true; readonly stdio: "ignore" },
  ) => WslChild;
}

/**
 * Spawn the WSL daemon DETACHED and `unref`'d, `stdio: "ignore"` (the daemon owns
 * its own `daemon.log` inside the distro — the host opens no log fd). `launch` is a
 * `buildWslDaemonLaunch(...)` descriptor: `wsl.exe … -e <node> <bundle> serve …`.
 */
export function spawnWslDaemon(launch: LocusCommand, deps: WslSpawnDeps = {}): void {
  const spawner = deps.spawn ?? ((file, args, options) => spawn(file, args as string[], options));
  const child = spawner(launch.file, launch.args, { detached: true, stdio: "ignore" });
  // A detached child's async spawn failure (ENOENT: no wsl.exe, EACCES) would be an
  // UNHANDLED 'error' event — which terminates the host process. Own it here (the
  // wsl.exe pid is not useful for stopping the in-distro daemon, so we log, not throw).
  child.on("error", (error) => {
    console.error(`[wsl-daemon] failed to spawn ${launch.file}: ${error.message}`);
  });
  child.unref();
}

/**
 * Learn the daemon's port with the ONE 9P read this design permits: a single
 * `wsl.exe … -e cat <dataDir>/daemon.json`, parsed with `daemonInfoSchema`. Returns
 * `wsPort`, or `null` when the file is absent (non-zero exit) or unparseable. Steady-
 * state health never reads this file again — it goes to the port (`probeWslDaemonHealth`).
 */
export async function readWslDaemonPort(
  location: WslDaemonLocation,
  run: WslRunner,
): Promise<number | null> {
  const command = locusCommand({ kind: "wsl", distro: location.distro }, "cat", [
    `${location.distroDataDir}/daemon.json`,
  ]);
  const { stdout, code } = await run(command);
  if (code !== 0) return null;
  try {
    const parsed = daemonInfoSchema.safeParse(JSON.parse(stdout));
    return parsed.success ? parsed.data.wsPort : null;
  } catch {
    return null; // torn / non-JSON stdout.
  }
}

export interface WslHealthDeps {
  /** The fetch impl; defaults to the global `fetch`. Tests inject a fake. */
  readonly fetch?: FetchLike;
  readonly timeoutMs?: number;
}

/**
 * GET `http://localhost:<port>/healthz` — a WSL2 loopback listener is reachable from
 * Windows over `localhost` (spike-proven). Returns the validated identity (version +
 * protocol) on a 200, else `null` (non-200, refused, timed out, or torn body).
 */
export async function probeWslDaemonHealth(
  port: number,
  deps: WslHealthDeps = {},
): Promise<DaemonIdentity | null> {
  const doFetch = deps.fetch ?? fetch;
  try {
    const res = await doFetch(`http://localhost:${port}/healthz`, {
      signal: AbortSignal.timeout(deps.timeoutMs ?? PROBE_TIMEOUT_MS),
    });
    if (res.status !== 200) return null; // an identity-matching 200, not any 2xx.
    const parsed = daemonIdentitySchema.safeParse(await res.json());
    // The identity must claim the very port we probed — a mismatched wsPort means
    // this is not the daemon we think it is (stale forward, wrong process).
    if (!parsed.success || parsed.data.wsPort !== port) return null;
    return parsed.data;
  } catch {
    return null;
  }
}

export interface WslWaitDeps {
  readonly run: WslRunner;
  readonly fetch?: FetchLike;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly timeoutMs?: number;
  readonly intervalMs?: number;
  readonly probeTimeoutMs?: number;
}

/**
 * Poll `readWslDaemonPort` → `probeWslDaemonHealth` until the daemon answers healthy,
 * or throw at a bounded deadline (mirrors host `waitForHealthy`). Clock and sleep are
 * injected so the deadline path is testable without real time.
 */
export async function waitForWslDaemon(
  location: WslDaemonLocation,
  deps: WslWaitDeps,
): Promise<{ readonly port: number; readonly identity: DaemonIdentity }> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const timeoutMs = deps.timeoutMs ?? 10_000;
  const intervalMs = deps.intervalMs ?? 100;
  const deadline = now() + timeoutMs;
  // ACQUISITION loop: RE-READ the port every iteration until a probe answers healthy. The
  // "learn the port once" discipline is for STEADY-STATE health (the caller already holds a
  // port and hits `/healthz` directly, never re-reading the claim over 9P). Acquisition is
  // different: a version-skew restart brings the daemon back on a NEW ephemeral port, so a
  // port cached from the dying daemon would be polled fruitlessly until the deadline. Reading
  // `daemon.json` each pass costs one 9P read per interval — cheap, and only while starting up.
  for (;;) {
    const port = await readWslDaemonPort(location, deps.run);
    if (port !== null) {
      const identity = await probeWslDaemonHealth(port, {
        fetch: deps.fetch,
        timeoutMs: deps.probeTimeoutMs,
      });
      if (identity) return { port, identity };
    }
    if (now() >= deadline) {
      throw new Error(
        `WSL daemon in "${location.distro}" did not become healthy within ${timeoutMs}ms`,
      );
    }
    await sleep(intervalMs);
  }
}

/**
 * Stop a WSL daemon by signalling its pid INSIDE the distro: `wsl.exe … -e kill <pid>`.
 * Version-skew RESTART orchestration (stop-then-respawn) is composed in Wave 3's
 * supervisor from this stop plus the identity `probeWslDaemonHealth`/`waitForWslDaemon`
 * already return.
 */
export async function stopWslDaemon(
  target: { readonly distro: string; readonly pid: number },
  run: WslRunner,
): Promise<void> {
  const { code } = await run(
    locusCommand({ kind: "wsl", distro: target.distro }, "kill", [String(target.pid)]),
  );
  if (code !== 0) {
    throw new Error(
      `could not stop WSL daemon pid ${target.pid} in "${target.distro}" (kill exited ${code})`,
    );
  }
}
