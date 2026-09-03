// The daemon-side owner of the T3 sidecar: one per data dir, started on first use,
// adopted from a previous daemon when it still answers, stopped with the daemon. The
// status it reports is what `daemon.status` carries to the connection bar: `off` until
// something asks for it, `starting` while it boots, `ready`, or `degraded` with the
// reason named. No Effect, no `@t3tools/*` here — see ./sidecar.ts for the process
// contract and ./client.ts for the RPC surface.

import type { T3Session, T3SidecarStatus } from "@rennet/protocol";
import { connectT3, type ModelSelection, modelSelection, type T3Client } from "./client";
import {
  adoptSidecar,
  type ProviderBinaries,
  type RunningSidecar,
  readUpstreamCommit,
  removeSidecarClaim,
  spawnSidecar,
} from "./sidecar";
import {
  bindThread,
  findBindingsForSessions,
  removeBindings,
  type ThreadBinding,
  type ThreadBindingKey,
} from "./threads";

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
  /** The daemon's own RPC client over the sidecar socket, connected on first use. */
  readonly client: () => Promise<T3Client>;
  /** The T3 thread bound to (repository root, key), created on first use. */
  readonly threadFor: (input: {
    readonly repositoryRoot: string;
    readonly key: ThreadBindingKey;
    readonly title: string;
    /** The seat's council-routed model; absent ⇒ the sidecar's default. */
    readonly modelSelection?: ModelSelection;
    /** The owning session, recorded on a seat binding so archiving can find it. */
    readonly sessionId?: string;
  }) => Promise<ThreadBinding>;
  /**
   * Archiving a session is the pruning act: delete every thread bound to any of these
   * session/review ids and drop the bindings. Never throws — a sidecar that is off has
   * nothing to delete and a thread it no longer has is already gone, and neither of those
   * may fail the archive the user asked for. Returns how many threads it deleted.
   */
  readonly forgetSession: (ids: readonly string[]) => Promise<number>;
  /** Synchronous teardown for the daemon's own shutdown path (no async budget there). */
  readonly stopSync: () => void;
}

/** Rung one's default model: T3's own default for its Claude driver. The composer changes it per thread. */
const DEFAULT_MODEL = modelSelection("claudeAgent", "claude-sonnet-5");

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export function createT3SidecarSupervisor(
  options: T3SidecarSupervisorOptions,
): T3SidecarSupervisor {
  const warn = options.warn ?? console.warn;
  const upstreamCommit = options.bundlePath ? readUpstreamCommit(options.bundlePath) : "unknown";
  let running: RunningSidecar | null = null;
  let inFlight: Promise<RunningSidecar> | null = null;
  let rpc: Promise<T3Client> | null = null;
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

  const client = (): Promise<T3Client> => {
    if (rpc) return rpc;
    rpc = ensure()
      .then((sidecar) =>
        connectT3({
          wsUrl: `${sidecar.origin.replace(/^http/, "ws")}/ws`,
          accessToken: sidecar.credentials.accessToken,
        }),
      )
      .catch((error: unknown) => {
        rpc = null;
        throw error;
      });
    return rpc;
  };

  const threadFor: T3SidecarSupervisor["threadFor"] = async (input) =>
    bindThread({
      dataDir: options.dataDir,
      client: await client(),
      repositoryRoot: input.repositoryRoot,
      key: input.key,
      title: input.title,
      modelSelection: input.modelSelection ?? DEFAULT_MODEL,
      ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
    });

  const forgetSession: T3SidecarSupervisor["forgetSession"] = async (ids) => {
    const bindings = findBindingsForSessions(options.dataDir, ids);
    if (bindings.length === 0) return 0;
    // The bindings are dropped whatever the sidecar says. A binding pointing at a thread
    // nobody can reach is worse than none: it would rebind an archived session to a ghost.
    const threadIds = bindings.map((binding) => binding.threadId);
    let deleted = 0;
    try {
      const rpc = await client();
      for (const threadId of threadIds) {
        try {
          await rpc.deleteThread(threadId);
          deleted += 1;
        } catch (error) {
          warn(`rennet: T3 thread ${threadId} was not deleted: ${describe(error)}`);
        }
      }
    } catch (error) {
      warn(`rennet: T3 sidecar unavailable, dropping bindings only: ${describe(error)}`);
    }
    removeBindings(options.dataDir, threadIds);
    return deleted;
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
    const openRpc = rpc;
    rpc = null;
    void openRpc?.then((c) => c.close()).catch(() => undefined);
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

  return {
    ensure,
    session,
    status: () => status,
    client,
    threadFor,
    forgetSession,
    stopSync,
  };
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
