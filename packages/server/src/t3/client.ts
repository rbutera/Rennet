// The daemon-side T3 Code RPC client (t3code-sidecar-chat, group 3).
//
// THE one Rennet-authored module that imports `effect` and `@t3tools/*`. Everything it
// exposes is a Promise or an AsyncIterable over plain data from the vendored contracts,
// so the rest of the daemon never sees an Effect. The wire is T3's own: Effect RPC over
// the sidecar's `/ws` WebSocket, JSON serialization, authenticated on the upgrade with
// the bearer the supervisor brokered (Node's `ws` can carry the header; a browser cannot,
// which is why T3's web client uses a ticket instead).
//
// The method set this module calls is checked at build time: the contracts and the
// sidecar are one vendored snapshot, so a fold that renames or drops a method fails the
// typecheck here, before it can ship.
//
// Docs: docs/developing/concepts/t3code-sidecar.md

import { randomUUID } from "node:crypto";
import {
  ApprovalRequestId,
  type ClientOrchestrationCommand,
  CommandId,
  MessageId,
  type ModelSelection,
  type OrchestrationCheckpointSummary,
  type OrchestrationLatestTurnState,
  type OrchestrationProjectShell,
  type OrchestrationThread,
  type OrchestrationThreadStreamItem,
  ProjectId,
  type ProviderApprovalDecision,
  ProviderInstanceId,
  type RuntimeMode,
  ThreadId,
  WsRpcGroup,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import * as Socket from "effect/unstable/socket/Socket";
import { WebSocket } from "ws";

export type { ModelSelection, OrchestrationThread, OrchestrationThreadStreamItem };

export interface T3ClientOptions {
  readonly wsUrl: string;
  readonly accessToken: string;
  readonly openTimeoutMs?: number;
}

export interface CreateThreadInput {
  readonly projectId: string;
  readonly title: string;
  readonly modelSelection: ModelSelection;
  /** Defaults to T3's full access, the posture Rule Zero mandates. */
  readonly runtimeMode?: RuntimeMode;
}

export interface StartTurnInput {
  readonly threadId: string;
  readonly text: string;
  readonly modelSelection?: ModelSelection;
  readonly runtimeMode?: RuntimeMode;
  /**
   * JSON Schema the turn's result must match, attached as the turn's
   * structured-output contract — never restated in the prompt text. On the Claude
   * provider the SDK fixes `outputFormat` when the session's query is built, so a
   * thread's FIRST turn decides the contract and a later turn asking for a
   * different one is refused by name rather than answered in the wrong shape.
   */
  readonly outputSchema?: unknown;
}

/** What the settled turn reported about itself, read off its `turn.settled` activity. */
export interface TurnSettlement {
  /** Present when the turn carried an output schema and the provider honoured it. */
  readonly structuredOutput?: unknown;
  /** The provider's own wall-clock duration for the turn, in milliseconds. */
  readonly durationMs?: number;
  /** The provider's raw usage record (Claude's SDK `usage`), unparsed. */
  readonly usage?: unknown;
  readonly totalCostUsd?: number;
  readonly errorMessage?: string;
  /**
   * T3's latest `context-window.updated` snapshot for the turn, unparsed. Codex reports
   * its tokens here and nothing on the settlement; the snapshot is the last request's
   * own figures. Absent when no snapshot landed for the turn.
   */
  readonly tokenUsage?: unknown;
  /**
   * The nearest earlier settled turn's usage on this thread. Claude's counter is
   * cumulative over the session, so a turn's own spend is the difference — read off the
   * thread itself, so a wait that starts fresh (a recreated runner, a restarted daemon)
   * subtracts the same as one that watched every turn.
   */
  readonly previousUsage?: { readonly usage: unknown; readonly totalCostUsd?: number };
}

export interface TurnOutcome extends TurnSettlement {
  readonly turnId: string;
  readonly state: Exclude<OrchestrationLatestTurnState, "running">;
  readonly thread: OrchestrationThread;
}

/** What `startTurn` saw before it dispatched, so the wait can tell the new turn from the last one. */
export interface TurnStart {
  /** The thread's latest turn when this one was requested; `null` on a fresh thread. */
  readonly previousTurnId: string | null;
  /** The start command's own stamp. A session error recorded before it is an earlier turn's. */
  readonly requestedAt: string;
}

export interface WaitForTurnOptions {
  readonly signal?: AbortSignal;
  readonly settlementGraceMs?: number;
  /** How long a requested turn may take to APPEAR before the wait gives up. */
  readonly startTimeoutMs?: number;
  /**
   * The start this wait belongs to. T3 flips `latestTurn` to `running` only when the
   * provider's `turn.started` is ingested, asynchronously after the start command has
   * replied, so the first snapshot after a repair still shows the PREVIOUS turn settled
   * with its `turn.settled` activity. Without this the wait answers at once with the old
   * turn's result and the new one runs unwatched.
   */
  readonly after?: TurnStart;
}

export interface TurnDiff {
  readonly turnId: string;
  readonly turnCount: number;
  /** Unified diff text for exactly that turn's checkpoint. */
  readonly diff: string;
  readonly files: OrchestrationCheckpointSummary["files"];
}

export interface T3Client {
  /** `server.probe`: the sidecar answers an authenticated RPC. */
  readonly probe: () => Promise<void>;
  /** The project whose `workspaceRoot` is this checkout, created when absent. */
  readonly ensureProject: (workspaceRoot: string, title: string) => Promise<string>;
  readonly createThread: (input: CreateThreadInput) => Promise<string>;
  /** Delete a thread and its transcript. A thread the sidecar no longer has is not an error. */
  readonly deleteThread: (threadId: string) => Promise<void>;
  readonly startTurn: (input: StartTurnInput) => Promise<TurnStart>;
  readonly interruptTurn: (threadId: string) => Promise<void>;
  readonly respondApproval: (
    threadId: string,
    requestId: string,
    decision: ProviderApprovalDecision,
  ) => Promise<void>;
  /** Snapshot first, then events, until the iterator is returned or the socket closes. */
  readonly subscribeThread: (threadId: string) => AsyncIterable<OrchestrationThreadStreamItem>;
  /** One projection of the thread as it stands. */
  readonly readThread: (threadId: string) => Promise<OrchestrationThread>;
  /**
   * Resolve when the thread's latest turn leaves `running`, carrying what that turn
   * reported about itself. The settlement facts ride a `turn.settled` activity the
   * sidecar appends beside the lifecycle transition, so once the turn is settled this
   * waits a bounded moment for that activity and then answers with what it has —
   * absent facts come back absent rather than made up.
   */
  readonly waitForTurnSettled: (
    threadId: string,
    options?: WaitForTurnOptions,
  ) => Promise<TurnOutcome>;
  readonly readTurnDiff: (threadId: string, turnId: string) => Promise<TurnDiff>;
  readonly close: () => Promise<void>;
}

const FULL_ACCESS: RuntimeMode = "full-access";

/** A provider instance plus model; built-in instance ids are the driver slugs (`claudeAgent`, `codex`). */
export const modelSelection = (instanceId: string, model: string): ModelSelection => ({
  instanceId: ProviderInstanceId.make(instanceId),
  model,
});

const makeWsClient = RpcClient.make(WsRpcGroup);
type WsClient =
  typeof makeWsClient extends Effect.Effect<infer Client, unknown, unknown> ? Client : never;

const nowIso = () => new Date().toISOString();

/** Open the socket, build the RPC client, and wrap it. Rejects if the upgrade is refused. */
export async function connectT3(options: T3ClientOptions): Promise<T3Client> {
  const scope = await Effect.runPromise(Scope.make());
  const webSocketConstructor = Layer.succeed(Socket.WebSocketConstructor)(
    (url: string, protocols?: string | Array<string>) =>
      new WebSocket(url, protocols, {
        headers: { authorization: `Bearer ${options.accessToken}` },
      }) as unknown as globalThis.WebSocket,
  );
  const protocolLayer = RpcClient.layerProtocolSocket().pipe(
    Layer.provide(
      Socket.layerWebSocket(options.wsUrl, {
        openTimeout: `${options.openTimeoutMs ?? 15_000} millis`,
      }).pipe(Layer.provide(webSocketConstructor)),
    ),
    Layer.provide(RpcSerialization.layerJson),
  );
  let client: WsClient;
  try {
    const context = await Effect.runPromise(Layer.build(protocolLayer).pipe(Scope.provide(scope)));
    client = await Effect.runPromise(
      makeWsClient.pipe(Effect.provide(context), Scope.provide(scope)),
    );
  } catch (error) {
    await Effect.runPromise(Scope.close(scope, Exit.void));
    throw error;
  }

  const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect);

  const dispatch = (command: ClientOrchestrationCommand) =>
    run(client["orchestration.dispatchCommand"](command));

  /** Every command carries its own fresh id and timestamp; the server mints turn ids. */
  const stamp = () => ({ commandId: CommandId.make(randomUUID()), createdAt: nowIso() });

  const readShellProjects = async (): Promise<ReadonlyArray<OrchestrationProjectShell>> => {
    const first = await run(
      client["orchestration.subscribeShell"]({}).pipe(Stream.take(1), Stream.runCollect),
    );
    const item = first[0];
    return item && item.kind === "snapshot" ? item.snapshot.projects : [];
  };

  const readThread = async (threadId: string): Promise<OrchestrationThread> => {
    const first = await run(
      client["orchestration.subscribeThread"]({ threadId: ThreadId.make(threadId) }).pipe(
        Stream.take(1),
        Stream.runCollect,
      ),
    );
    const item = first[0];
    if (item?.kind !== "snapshot") {
      throw new Error(`T3 thread ${threadId} sent no snapshot`);
    }
    return item.snapshot.thread;
  };

  const subscribeThread = (threadId: string): AsyncIterable<OrchestrationThreadStreamItem> =>
    toAsyncIterable(client["orchestration.subscribeThread"]({ threadId: ThreadId.make(threadId) }));

  const ensuringProjects = new Map<string, Promise<string>>();
  const api: T3Client = {
    probe: async () => {
      await run(client["server.probe"]({}));
    },
    ensureProject: (workspaceRoot, title) => {
      // Six seats ask for the same root within milliseconds (drive 1.6, 2026-09-03): a
      // read-then-create per caller raced into T3's "Active project already exists"
      // invariant and cost every seat its first attempt. One in-flight creation per root;
      // a create that still loses the race re-reads instead of failing.
      const inFlight = ensuringProjects.get(workspaceRoot);
      if (inFlight) return inFlight;
      const creating = (async () => {
        const existing = (await readShellProjects()).find((p) => p.workspaceRoot === workspaceRoot);
        if (existing) return existing.id;
        const projectId = ProjectId.make(randomUUID());
        try {
          await dispatch({ type: "project.create", ...stamp(), projectId, title, workspaceRoot });
          return projectId;
        } catch (error) {
          const again = (await readShellProjects()).find((p) => p.workspaceRoot === workspaceRoot);
          if (again) return again.id;
          throw error;
        }
      })().finally(() => ensuringProjects.delete(workspaceRoot));
      ensuringProjects.set(workspaceRoot, creating);
      return creating;
    },
    createThread: async (input) => {
      const threadId = ThreadId.make(randomUUID());
      await dispatch({
        type: "thread.create",
        ...stamp(),
        threadId,
        projectId: ProjectId.make(input.projectId),
        title: input.title,
        modelSelection: input.modelSelection,
        runtimeMode: input.runtimeMode ?? FULL_ACCESS,
        interactionMode: "default",
        // The checkout itself: T3 resolves cwd as `worktreePath ?? project.workspaceRoot`.
        branch: null,
        worktreePath: null,
      });
      return threadId;
    },
    deleteThread: async (threadId) => {
      await dispatch({
        type: "thread.delete",
        ...stamp(),
        threadId: ThreadId.make(threadId),
      });
    },
    startTurn: async (input) => {
      // Read before dispatching: the reply does not name the turn the server mints, and
      // the projection keeps showing the last turn until the provider reports the new one.
      const previousTurnId = (await readThread(input.threadId)).latestTurn?.turnId ?? null;
      const stamped = stamp();
      await dispatch({
        type: "thread.turn.start",
        ...stamped,
        threadId: ThreadId.make(input.threadId),
        message: {
          messageId: MessageId.make(randomUUID()),
          role: "user",
          text: input.text,
          attachments: [],
        },
        ...(input.modelSelection ? { modelSelection: input.modelSelection } : {}),
        ...(input.outputSchema === undefined ? {} : { outputSchema: input.outputSchema }),
        runtimeMode: input.runtimeMode ?? FULL_ACCESS,
        interactionMode: "default",
      });
      return { previousTurnId, requestedAt: stamped.createdAt };
    },
    interruptTurn: async (threadId) => {
      await dispatch({
        type: "thread.turn.interrupt",
        ...stamp(),
        threadId: ThreadId.make(threadId),
      });
    },
    respondApproval: async (threadId, requestId, decision) => {
      await dispatch({
        type: "thread.approval.respond",
        ...stamp(),
        threadId: ThreadId.make(threadId),
        requestId: ApprovalRequestId.make(requestId),
        decision,
      });
    },
    subscribeThread,
    readThread,
    waitForTurnSettled: (threadId, options) =>
      awaitTurnSettled(threadId, { subscribeThread, readThread }, options),
    readTurnDiff: async (threadId, turnId) => {
      const thread = await readThread(threadId);
      const checkpoint = thread.checkpoints.find((c) => c.turnId === turnId);
      if (!checkpoint)
        throw new Error(`T3 thread ${threadId} has no checkpoint for turn ${turnId}`);
      const toTurnCount = checkpoint.checkpointTurnCount;
      const result = await run(
        client["orchestration.getTurnDiff"]({
          threadId: ThreadId.make(threadId),
          fromTurnCount: Math.max(0, toTurnCount - 1),
          toTurnCount,
        }),
      );
      return { turnId, turnCount: toTurnCount, diff: result.diff, files: checkpoint.files };
    },
    close: async () => {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    },
  };
  return api;
}

/** The two reads the settle wait needs; the client supplies them over the socket, tests supply fakes. */
export interface TurnWaitDeps {
  readonly subscribeThread: (threadId: string) => AsyncIterable<OrchestrationThreadStreamItem>;
  readonly readThread: (threadId: string) => Promise<OrchestrationThread>;
}

/** `T3Client.waitForTurnSettled`, over its two reads. */
export async function awaitTurnSettled(
  threadId: string,
  deps: TurnWaitDeps,
  options: WaitForTurnOptions = {},
): Promise<TurnOutcome> {
  const signal = options.signal;
  if (signal?.aborted) throw new Error("aborted");
  const iterator = deps.subscribeThread(threadId)[Symbol.asyncIterator]();
  let onAbort: (() => void) | undefined;
  const abort = new Promise<never>((_, reject) => {
    onAbort = () => reject(new Error("aborted"));
    signal?.addEventListener("abort", onAbort);
  });
  // The lifecycle transition and the `turn.settled` activity are two writes; the
  // lifecycle one can land first. This is how long we keep reading for the activity
  // AFTER the turn has settled before answering without it — on a timer, because a
  // stream that goes quiet after the lifecycle write would otherwise hold the wait open
  // until something unrelated arrives.
  const graceMs = options.settlementGraceMs ?? 3_000;
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  let grace: Promise<typeof GRACE_OVER> | undefined;
  // A provider stream that dies BEFORE its turn registers (drive 1.6, 2026-09-03: every
  // Claude seat, "Claude runtime stream failed.") leaves no turn at all: T3 stops the
  // session with `lastError` and, by upstream design, emits no turn lifecycle. Waiting
  // on `latestTurn` alone then never returns and the lane spins forever. So a session
  // that has stopped or errored with no turn in flight settles the wait as a failed
  // turn carrying that error, and a turn that never appears at all gives up after
  // `startTimeoutMs` with a message that says so.
  const startTimeoutMs = options.startTimeoutMs ?? 120_000;
  const startedWaitingAt = Date.now();
  const after = options.after;
  /** The turn this wait is for: the latest one, unless it is the one already there at the start. */
  const currentTurn = (thread: OrchestrationThread | undefined) => {
    const latest = thread?.latestTurn;
    return latest && latest.turnId !== after?.previousTurnId ? latest : undefined;
  };
  const sessionFailure = (thread: OrchestrationThread | undefined): string | undefined => {
    const session = thread?.session;
    if (!session || session.activeTurnId !== null) return undefined;
    if (session.status !== "stopped" && session.status !== "error") return undefined;
    // Recorded before this turn was requested: an earlier turn's failure, not ours.
    if (after !== undefined && Date.parse(session.updatedAt) < Date.parse(after.requestedAt)) {
      return undefined;
    }
    return session.lastError ?? undefined;
  };
  const settledOutcome = (
    thread: OrchestrationThread,
    turnId: string,
    state: TurnOutcome["state"],
  ): TurnOutcome => ({ turnId, state, thread, ...(readTurnSettlement(thread, turnId) ?? {}) });
  try {
    let thread: OrchestrationThread | undefined;
    for (;;) {
      const next = await Promise.race([iterator.next(), abort, ...(grace ? [grace] : [])]);
      if (next === GRACE_OVER) {
        // The stream went quiet after the lifecycle settled: one last read, then answer
        // with what the projection holds. Absent facts come back absent.
        thread = await deps.readThread(threadId);
        const latest = currentTurn(thread);
        if (!latest || latest.state === "running") {
          throw new Error(`T3 thread ${threadId} lost its settled turn before it was read`);
        }
        return settledOutcome(thread, latest.turnId, latest.state);
      }
      if (next.done) throw new Error(`T3 thread ${threadId} stream ended before the turn settled`);
      const item = next.value;
      if (item.kind === "snapshot") thread = item.snapshot.thread;
      // Events do not carry the whole projection; re-read on the ones that end a turn.
      if (item.kind === "event" && /turn|session|settled|activity/.test(item.event.type)) {
        thread = await deps.readThread(threadId);
      }
      const latest = currentTurn(thread);
      if (!latest || latest.state === "running") {
        const failure = sessionFailure(thread);
        if (failure !== undefined && latest?.state !== "running") {
          return {
            turnId: latest?.turnId ?? `${threadId}:session`,
            state: "error",
            thread: thread as OrchestrationThread,
            errorMessage: failure,
          };
        }
        if (!latest && Date.now() - startedWaitingAt > startTimeoutMs) {
          throw new Error(
            `T3 thread ${threadId} never started the requested turn within ${Math.round(startTimeoutMs / 1000)} s (session ${thread?.session?.status ?? "unknown"})`,
          );
        }
        continue;
      }
      if (readTurnSettlement(thread as OrchestrationThread, latest.turnId) === undefined) {
        grace ??= new Promise((resolve) => {
          graceTimer = setTimeout(() => resolve(GRACE_OVER), graceMs);
        });
        continue;
      }
      return settledOutcome(thread as OrchestrationThread, latest.turnId, latest.state);
    }
  } finally {
    clearTimeout(graceTimer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
    await iterator.return?.();
  }
}

const GRACE_OVER = Symbol("settlement grace over");

/**
 * The settled turn's own facts, off the `turn.settled` activity the sidecar appends when
 * a turn completes. `undefined` means the activity has not landed (or the provider did
 * not report), which the caller distinguishes from "landed with nothing in it".
 */
export function readTurnSettlement(
  thread: OrchestrationThread,
  turnId: string,
): TurnSettlement | undefined {
  const activities = thread.activities;
  const settledAt = activities.findLastIndex(
    (activity) => activity.kind === "turn.settled" && activity.turnId === turnId,
  );
  if (settledAt === -1) return undefined;
  const record = asRecord(activities[settledAt]?.payload) ?? {};
  const number = (key: string): number | undefined =>
    typeof record[key] === "number" ? (record[key] as number) : undefined;
  const durationMs = number("durationMs");
  const totalCostUsd = number("totalCostUsd");
  const errorMessage = typeof record.errorMessage === "string" ? record.errorMessage : undefined;

  const otherSettlement = (i: number) => {
    const activity = activities[i];
    return activity?.kind === "turn.settled" && activity.turnId !== turnId ? activity : undefined;
  };
  // The nearest earlier settlement that carried usage; the nearest one at all bounds
  // this turn's span from below.
  let previousUsage: TurnSettlement["previousUsage"];
  let spanStart = -1;
  for (let i = settledAt - 1; i >= 0; i -= 1) {
    const earlier = asRecord(otherSettlement(i)?.payload);
    if (earlier === null) continue;
    if (spanStart === -1) spanStart = i;
    if (earlier.usage === undefined) continue;
    previousUsage = {
      usage: earlier.usage,
      ...(typeof earlier.totalCostUsd === "number" ? { totalCostUsd: earlier.totalCostUsd } : {}),
    };
    break;
  }
  let spanEnd = activities.length;
  for (let i = settledAt + 1; i < activities.length; i += 1) {
    if (otherSettlement(i) !== undefined) {
      spanEnd = i;
      break;
    }
  }
  // The latest context-window snapshot inside the span. Codex stamps its snapshots with
  // no turn id and emits them before the turn completes, so an unstamped one counts only
  // ahead of this turn's own settlement; a stamped one counts anywhere in the span.
  let tokenUsage: unknown;
  for (let i = spanEnd - 1; i > spanStart; i -= 1) {
    const activity = activities[i];
    if (activity?.kind !== "context-window.updated") continue;
    if (activity.turnId === turnId || (activity.turnId === null && i < settledAt)) {
      tokenUsage = activity.payload;
      break;
    }
  }
  return {
    ...(record.structuredOutput === undefined ? {} : { structuredOutput: record.structuredOutput }),
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(record.usage === undefined ? {} : { usage: record.usage }),
    ...(totalCostUsd === undefined ? {} : { totalCostUsd }),
    ...(errorMessage === undefined ? {} : { errorMessage }),
    ...(tokenUsage === undefined ? {} : { tokenUsage }),
    ...(previousUsage === undefined ? {} : { previousUsage }),
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

/** Drain an Effect stream into an AsyncIterable; returning the iterator interrupts the fiber. */
function toAsyncIterable<A, E>(stream: Stream.Stream<A, E>): AsyncIterable<A> {
  return {
    [Symbol.asyncIterator]() {
      const buffer: A[] = [];
      let done = false;
      let failure: unknown;
      let wake: (() => void) | null = null;
      const notify = () => {
        wake?.();
        wake = null;
      };
      const fiber = Effect.runFork(
        Stream.runForEach(stream, (item) =>
          Effect.sync(() => {
            buffer.push(item);
            notify();
          }),
        ).pipe(
          Effect.tapError((error) =>
            Effect.sync(() => {
              failure = error;
            }),
          ),
          Effect.ensuring(
            Effect.sync(() => {
              done = true;
              notify();
            }),
          ),
        ),
      );
      return {
        async next(): Promise<IteratorResult<A>> {
          for (;;) {
            const item = buffer.shift();
            if (item !== undefined) return { value: item, done: false };
            if (failure !== undefined) throw failure;
            if (done) return { value: undefined, done: true };
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
          }
        },
        async return(): Promise<IteratorResult<A>> {
          await Effect.runPromise(Fiber.interrupt(fiber));
          return { value: undefined, done: true };
        },
      };
    },
  };
}
