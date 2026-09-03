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
}

export interface TurnOutcome extends TurnSettlement {
  readonly turnId: string;
  readonly state: Exclude<OrchestrationLatestTurnState, "running">;
  readonly thread: OrchestrationThread;
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
  readonly startTurn: (input: StartTurnInput) => Promise<void>;
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
    options?: { readonly signal?: AbortSignal; readonly settlementGraceMs?: number },
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
    startTurn: async (input) => {
      await dispatch({
        type: "thread.turn.start",
        ...stamp(),
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
    waitForTurnSettled: async (threadId, options = {}) => {
      const iterator = subscribeThread(threadId)[Symbol.asyncIterator]();
      const abort = new Promise<never>((_, reject) => {
        options.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true,
        });
      });
      // The lifecycle transition and the `turn.settled` activity are two writes; the
      // lifecycle one can land first. This is how long we keep reading for the activity
      // AFTER the turn has settled before answering without it.
      const graceMs = options.settlementGraceMs ?? 3_000;
      try {
        let thread: OrchestrationThread | undefined;
        let settledAtMs: number | undefined;
        for (;;) {
          const next = await Promise.race([iterator.next(), abort]);
          if (next.done)
            throw new Error(`T3 thread ${threadId} stream ended before the turn settled`);
          const item = next.value;
          if (item.kind === "snapshot") thread = item.snapshot.thread;
          // Events do not carry the whole projection; re-read on the ones that end a turn.
          if (item.kind === "event" && /turn|session|settled|activity/.test(item.event.type)) {
            thread = await readThread(threadId);
          }
          const latest = thread?.latestTurn;
          if (!latest || latest.state === "running") continue;
          const settlement = readTurnSettlement(thread as OrchestrationThread, latest.turnId);
          settledAtMs ??= Date.now();
          if (settlement === undefined && Date.now() - settledAtMs < graceMs) continue;
          return {
            turnId: latest.turnId,
            state: latest.state,
            thread: thread as OrchestrationThread,
            ...(settlement ?? {}),
          };
        }
      } finally {
        await iterator.return?.();
      }
    },
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

/**
 * The settled turn's own facts, off the `turn.settled` activity the sidecar appends when
 * a turn completes. `undefined` means the activity has not landed (or the provider did
 * not report), which the caller distinguishes from "landed with nothing in it".
 */
export function readTurnSettlement(
  thread: OrchestrationThread,
  turnId: string,
): TurnSettlement | undefined {
  for (let i = thread.activities.length - 1; i >= 0; i -= 1) {
    const activity = thread.activities[i];
    if (activity?.kind !== "turn.settled" || activity.turnId !== turnId) continue;
    const payload = activity.payload;
    if (payload === null || typeof payload !== "object") return {};
    const record = payload as Record<string, unknown>;
    const number = (key: string): number | undefined =>
      typeof record[key] === "number" ? (record[key] as number) : undefined;
    const durationMs = number("durationMs");
    const totalCostUsd = number("totalCostUsd");
    const errorMessage = typeof record.errorMessage === "string" ? record.errorMessage : undefined;
    return {
      ...(record.structuredOutput === undefined
        ? {}
        : { structuredOutput: record.structuredOutput }),
      ...(durationMs === undefined ? {} : { durationMs }),
      ...(record.usage === undefined ? {} : { usage: record.usage }),
      ...(totalCostUsd === undefined ? {} : { totalCostUsd }),
      ...(errorMessage === undefined ? {} : { errorMessage }),
    };
  }
  return undefined;
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
