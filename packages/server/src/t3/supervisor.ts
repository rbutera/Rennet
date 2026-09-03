// The daemon-side owner of the T3 sidecar: one per data dir, started on first use,
// adopted from a previous daemon when it still answers, stopped with the daemon. The
// status it reports is what `daemon.status` carries to the connection bar: `off` until
// something asks for it, `starting` while it boots, `ready`, or `degraded` with the
// reason named. No Effect, no `@t3tools/*` here — see ./sidecar.ts for the process
// contract and ./client.ts for the RPC surface.

import type { T3Session, T3SidecarStatus } from "@rennet/protocol";
import {
  adoptSidecar,
  type ProviderBinaries,
  type RunningSidecar,
  readUpstreamCommit,
  removeSidecarClaim,
  spawnSidecar,
} from "./sidecar";

export interface T3SidecarSupervisorOptions {
  readonly dataDir: string;
  readonly env: NodeJS.ProcessEnv;
  /** The vendored server bundle; absent ⇒ the engine reports `degraded` with that reason. */
  readonly bundlePath: string | undefined;
  /** Absolute harness binaries from Rennet's own discovery, resolved at spawn time. */
  readonly resolveBinaries: () => Promise<ProviderBinaries>;
  readonly warn?: (message: string) => void;
}

export interface T3SidecarSupervisor {
  /** Adopt or spawn; single-flighted. Rejects when the sidecar cannot be brought up. */
  readonly ensure: () => Promise<RunningSidecar>;
  /** Broker a session for a client: the origin, the WS URL, the bearer, and a pairing URL for an embedded UI. */
  readonly session: () => Promise<T3Session>;
  readonly status: () => T3SidecarStatus;
  /** Synchronous teardown for the daemon's own shutdown path (no async budget there). */
  readonly stopSync: () => void;
}

export function createT3SidecarSupervisor(
  options: T3SidecarSupervisorOptions,
): T3SidecarSupervisor {
  const warn = options.warn ?? console.warn;
  const upstreamCommit = options.bundlePath ? readUpstreamCommit(options.bundlePath) : "unknown";
  let running: RunningSidecar | null = null;
  let inFlight: Promise<RunningSidecar> | null = null;
  let status: T3SidecarStatus = { state: "off", upstreamCommit, telemetry: "off" };

  const bringUp = async (): Promise<RunningSidecar> => {
    if (!options.bundlePath) {
      throw new Error(
        "the vendored T3 Code server bundle is not built (vendor/t3code/apps/server/dist/bin.mjs)",
      );
    }
    const adopted = await adoptSidecar(options.dataDir, upstreamCommit);
    if (adopted) return adopted;
    const binaries = await options.resolveBinaries();
    return spawnSidecar({
      dataDir: options.dataDir,
      bundlePath: options.bundlePath,
      upstreamCommit,
      env: options.env,
      binaries,
    });
  };

  const ensure = (): Promise<RunningSidecar> => {
    if (running) return Promise.resolve(running);
    if (inFlight) return inFlight;
    status = { state: "starting", upstreamCommit, telemetry: "off" };
    inFlight = bringUp()
      .then((result) => {
        running = result;
        status = { state: "ready", port: result.claim.port, upstreamCommit, telemetry: "off" };
        result.child?.once("exit", (code, signal) => {
          if (running === result) {
            running = null;
            status = {
              state: "degraded",
              detail: `sidecar exited (code ${code}, signal ${signal})`,
              upstreamCommit,
              telemetry: "off",
            };
          }
        });
        return result;
      })
      .catch((error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error);
        status = { state: "degraded", detail, upstreamCommit, telemetry: "off" };
        warn(`rennet: T3 sidecar unavailable: ${detail}`);
        throw error;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };

  const session = async (): Promise<T3Session> => {
    const sidecar = await ensure();
    const pairing = await mintPairingCredential(sidecar.origin, sidecar.credentials.accessToken);
    return {
      origin: sidecar.origin,
      wsUrl: `${sidecar.origin.replace(/^http/, "ws")}/ws`,
      accessToken: sidecar.credentials.accessToken,
      environmentId: sidecar.environment.environmentId,
      ...(pairing ? { pairingUrl: `${sidecar.origin}/pair#token=${pairing}` } : {}),
    };
  };

  const stopSync = (): void => {
    const current = running;
    running = null;
    status = { state: "off", upstreamCommit, telemetry: "off" };
    if (!current) return;
    // Only a sidecar this daemon spawned is signalled here; an adopted one belongs to the
    // out-of-process stop path (`rennet stop`, tray Quit), which verifies before signalling.
    if (current.child) {
      try {
        current.child.kill("SIGTERM");
      } catch {
        // already gone
      }
      removeSidecarClaim(options.dataDir, current.claim.pid);
    }
  };

  return { ensure, session, status: () => status, stopSync };
}

/** A short-lived pairing credential an embedded T3 UI can consume at `/pair#token=`. */
async function mintPairingCredential(origin: string, accessToken: string): Promise<string | null> {
  try {
    const res = await fetch(`${origin}/api/auth/pairing-token`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ label: "Rennet chat slot" }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { credential?: unknown };
    return typeof body.credential === "string" ? body.credential : null;
  } catch {
    return null;
  }
}
