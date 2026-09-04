// Probe-then-spawn supervision (issue #379, design D3). Two cooperating launchers — the
// desktop shell and the `rennet` CLI — converge on one healthy daemon with no handover
// protocol and no leader election (Orca paid 23 defects for endpoint-racing; Rennet does
// not have that problem). A launcher reads the `daemon.json` claim, probes `/healthz` to
// confirm it is alive and protocol-compatible, and spawns a fresh daemon when the claim is
// missing, stale, or unhealthy. Skew POLICY (restart vs report) belongs to the caller: the
// shell restarts, the CLI reports — this module only returns the verdict.

import { type ChildProcess, spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import {
  checkProtocolCompatibility,
  MIN_COMPATIBLE_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
} from "@rennet/protocol";
import { type DaemonInfo, readDaemonFile } from "./daemon-file";
import {
  type DaemonIdentity,
  type DaemonShutdownAck,
  daemonIdentitySchema,
  daemonShutdownAckSchema,
} from "./ws-listener";

/** How long to wait for a `/healthz` answer before treating the daemon as dead. */
const PROBE_TIMEOUT_MS = 500;

/**
 * How long to wait for the `POST /shutdown` ack before falling back to a signal (#820). Short:
 * the daemon writes the ack before it does any shutdown work, so a daemon that has not answered
 * in two seconds is one that cannot answer.
 */
export const SHUTDOWN_ACK_TIMEOUT_MS = 2_000;

/** The verdict a launcher acts on. `absent`/`stale` → spawn; `incompatible` → restart (shell) or report (CLI). */
export type DaemonVerdict =
  | { readonly kind: "healthy"; readonly identity: DaemonIdentity; readonly claim: DaemonInfo }
  | { readonly kind: "absent" }
  | { readonly kind: "stale"; readonly claim: DaemonInfo }
  | {
      readonly kind: "incompatible";
      readonly identity: DaemonIdentity;
      readonly claim: DaemonInfo;
      readonly reason: string;
    };

/** GET `/healthz` on the loopback listener; the validated identity, or null if it did not answer in time. */
export async function probeHealth(
  wsPort: number,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<DaemonIdentity | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${wsPort}/healthz`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const parsed = daemonIdentitySchema.safeParse(await res.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null; // connection refused, timeout, or torn body — the claim is not live.
  }
}

/**
 * Ask the daemon on `wsPort` to shut itself down (#820), and return what it acked — `null`
 * when nothing answered in time, when it answered something else, or when the route is not
 * there (a daemon older than this route 404s, which reads exactly like no ack: the caller
 * falls back to SIGTERM). The ack names the pid that heard the command, so a caller can
 * check it against the pid its claim named before waiting on that process.
 */
export async function requestDaemonShutdown(
  wsPort: number,
  timeoutMs: number = SHUTDOWN_ACK_TIMEOUT_MS,
): Promise<DaemonShutdownAck | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${wsPort}/shutdown`, {
      method: "POST",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const parsed = daemonShutdownAckSchema.safeParse(await res.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null; // refused, timed out, or a torn body — treat it as unacknowledged.
  }
}

/** Read the claim and probe it: is there a live, compatible daemon at this data dir? */
export async function findHealthyDaemon(dataDir: string): Promise<DaemonVerdict> {
  const claim = readDaemonFile(dataDir);
  if (!claim) return { kind: "absent" };

  const identity = await probeHealth(claim.wsPort);
  if (!identity) return { kind: "stale", claim };
  if (identity.pid !== claim.pid || identity.wsPort !== claim.wsPort) {
    return { kind: "stale", claim };
  }

  const compatibility = checkProtocolCompatibility(
    { version: PROTOCOL_VERSION, minCompatible: MIN_COMPATIBLE_PROTOCOL_VERSION },
    { version: identity.protocolVersion, minCompatible: identity.minCompatibleProtocolVersion },
  );
  if (!compatibility.compatible) {
    return { kind: "incompatible", identity, claim, reason: compatibility.reason };
  }
  return { kind: "healthy", identity, claim };
}

export interface SpawnDaemonOptions {
  readonly dataDir: string;
  /** The binary to run — the Electron executable (with ELECTRON_RUN_AS_NODE) when packaged. */
  readonly execPath: string;
  /** The bundled daemon entry (`dist/server/index.cjs`). */
  readonly entryPath: string;
  /** The server/app version to stamp into the claim (`app.getVersion()`). */
  readonly serverVersion?: string;
  /** Base environment; ELECTRON_RUN_AS_NODE is forced on so the Electron binary runs as Node. */
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Spawn the daemon detached, its stdio pinned to `<dataDir>/daemon.log`, and `unref`'d so it
 * outlives the launcher. Returns the child so the caller can read its pid; the daemon itself
 * publishes the claim once its listener is up (a launcher then polls `findHealthyDaemon`).
 */
export function spawnDaemon(options: SpawnDaemonOptions): ChildProcess {
  mkdirSync(options.dataDir, { recursive: true });
  const logFd = openSync(join(options.dataDir, "daemon.log"), "a");
  // `--host-bundle` is the entry we are launching: this IS the server bundle, and it is what
  // a WSL daemon update delivers into the distro (C17, #534). Passing it here means no shell
  // has to know the path twice.
  const args = [
    options.entryPath,
    "--data-dir",
    options.dataDir,
    "--host-bundle",
    options.entryPath,
  ];
  if (options.serverVersion) args.push("--server-version", options.serverVersion);

  let child: ChildProcess;
  try {
    child = spawn(options.execPath, args, {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: { ...(options.env ?? process.env), ELECTRON_RUN_AS_NODE: "1" },
    });
  } finally {
    closeSync(logFd);
  }
  child.unref();
  return child;
}

/** Poll `findHealthyDaemon` until it reports `healthy`, or throw after `timeoutMs`. */
export async function waitForHealthy(
  dataDir: string,
  options: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<Extract<DaemonVerdict, { kind: "healthy" }>> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const intervalMs = options.intervalMs ?? 100;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const verdict = await findHealthyDaemon(dataDir);
    if (verdict.kind === "healthy") return verdict;
    if (Date.now() >= deadline) {
      throw new Error(
        `daemon did not become healthy within ${timeoutMs}ms (last: ${verdict.kind})`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
