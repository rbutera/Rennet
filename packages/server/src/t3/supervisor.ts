// The daemon-side owner of the T3 sidecar: one per data dir, started EAGERLY at daemon
// launch (#849), adopted from a previous daemon when it still answers, stopped with the
// daemon. The status it reports is what `daemon.status` carries to the connection bar:
// `off` before anything has started it, `starting` while it boots, `ready`, or `degraded`
// with the reason named. No Effect, no `@t3tools/*` here — see ./sidecar.ts for the
// process contract and ./client.ts for the RPC surface.

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
import { bindThread, sweepThreads, type ThreadBinding, type ThreadBindingKey } from "./threads";

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
  /**
   * Bring the sidecar up NOW, at daemon launch, instead of at the first `chat.t3Session`
   * (#849). Time-to-first-message is what this buys: adopt-or-spawn plus the bootstrap
   * exchange used to be paid at the moment a reviewer first looked at the chat dock.
   *
   * SYNCHRONOUS and void by design — the daemon's boot path must not await it and must
   * not be able to fail on it. Nothing is thrown and nothing is returned to reject: a
   * sidecar that cannot start leaves `status()` at `degraded` with the reason named,
   * which `daemon.status` already carries to the connection bar and the chat dock already
   * renders, and the next `ensure()` retries from scratch exactly as it did before.
   *
   * Idempotent, because `ensure` is single-flighted: a later caller joins this bring-up
   * rather than starting a second one. With no bundle path there is nothing to start, so
   * this returns without touching the status — `ensure()` still names the missing bundle
   * on demand, which is the honest answer for a build that has no sidecar to run.
   */
  readonly start: () => void;
  /** Adopt or spawn; single-flighted. Rejects when the sidecar cannot be brought up. */
  readonly ensure: () => Promise<RunningSidecar>;
  /** Broker a session for a client: the origin, the WS URL, the bearer, the environment id. */
  readonly session: () => Promise<T3Session>;
  readonly status: () => T3SidecarStatus;
  /**
   * The board server's process bearer as it stands in the CURRENT sidecar's environment
   * (`lens-board-tools` D8), or an empty string before one is running.
   *
   * A reader, not a value handed out once: a sidecar respawn within one daemon's life
   * replaces the environment every harness child inherits, and a board listener holding
   * the old bearer would refuse every seat of the new sidecar while they ran and billed.
   * An empty string matches no presented bearer, which is the correct answer when there is
   * no sidecar for a call to have come from.
   */
  readonly boardBearer: () => string;
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
    /** The session's bound workspace (session-bound-workspace) — the thread's cwd. */
    readonly worktreePath?: string;
    /** The branch that workspace has checked out; absent for a detached PR snapshot. */
    readonly branch?: string;
  }) => Promise<ThreadBinding>;
  /**
   * Archiving a session is the pruning act: delete every thread bound to any of these
   * session/review ids and drop the bindings. Never throws — a sidecar that is off has
   * nothing to delete and a thread it no longer has is already gone, and neither of those
   * may fail the archive the user asked for. Returns how many threads it deleted.
   *
   * Sweeps are SERIALIZED, and a thread whose delete failed is remembered in the bindings
   * file's `pendingDeletions` (out of the live bindings, so an un-archived session still
   * gets a fresh thread) and retried on the next call or the next successful `ensure`.
   * `forgetSession([])` is that retry and nothing else.
   */
  readonly forgetSession: (ids: readonly string[]) => Promise<number>;
  /** Synchronous teardown for the daemon's own shutdown path (no async budget there). */
  readonly stopSync: () => void;
}

/** The default model for a bound thread: T3's own default for its Claude driver. The composer changes it per thread. */
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
        // A sidecar that is back up is the moment to finish what the last archive could
        // not: every thread whose delete failed is retried here (review finding 2). Fire
        // and forget — `forgetSession` never throws, and nothing waits on the sweep.
        void forgetSession([]);
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

  const start = (): void => {
    // No bundle ⇒ nothing to bring up. `ensure()` still answers with the missing-bundle
    // reason when something asks, so this stays quiet rather than logging a failure at
    // every launch of a build that was never going to have a sidecar.
    if (!options.bundlePath) return;
    // The `.catch` belongs HERE, where the promise is floated, not at some later use
    // site: `ensure` already recorded the reason in `status` and warned, and nothing is
    // waiting on this promise, so an unhandled rejection is the only thing left to stop.
    void ensure().catch(() => undefined);
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
      ...(input.worktreePath === undefined ? {} : { worktreePath: input.worktreePath }),
      ...(input.branch === undefined ? {} : { branch: input.branch }),
    });

  // ONE sweep at a time (review finding 2). The bindings file is a read-modify-write over a
  // single JSON document, so two archives running at once would lose one another's edits —
  // and a lost edit here is a live binding pointing at a deleted thread.
  let sweeping: Promise<unknown> = Promise.resolve();
  const forgetSession: T3SidecarSupervisor["forgetSession"] = (ids) => {
    const run = sweeping.then(async () => {
      // The RPC client is resolved ONCE per sweep and its failure is remembered: a sidecar
      // that is off would otherwise be re-dialled per thread. Every row then defers rather
      // than being silently forgotten.
      let rpc: T3Client | null = null;
      let unreachable: unknown;
      return sweepThreads({
        dataDir: options.dataDir,
        ids,
        warn,
        deleteThread: async (threadId) => {
          if (unreachable !== undefined) throw unreachable;
          if (rpc === null) {
            try {
              rpc = await client();
            } catch (error) {
              unreachable = error;
              warn(
                `rennet: T3 sidecar unavailable, deferring thread deletions: ${describe(error)}`,
              );
              throw error;
            }
          }
          await rpc.deleteThread(threadId);
        },
      });
    });
    sweeping = run.catch(() => undefined);
    return run;
  };

  const session = async (): Promise<T3Session> => {
    const sidecar = await ensure();
    return {
      origin: sidecar.origin,
      wsUrl: `${sidecar.origin.replace(/^http/, "ws")}/ws`,
      accessToken: sidecar.credentials.accessToken,
      environmentId: sidecar.environment.environmentId,
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
    start,
    ensure,
    session,
    status: () => status,
    // Read off whatever sidecar is running RIGHT NOW. `running` is cleared when the child
    // exits, so between a crash and the next `ensure()` this is empty and no bearer
    // matches — which is honest: there is no sidecar for a call to have come from.
    boardBearer: () => running?.boardBearer ?? "",
    client,
    threadFor,
    forgetSession,
    stopSync,
  };
}
