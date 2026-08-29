import type {
  HarnessDescriptor,
  HarnessEvent,
  HarnessPort,
  HarnessSession,
  SessionOutcome,
  SessionSpec,
} from "@rennet/core";
import { mintSession } from "@rennet/core";
import type { SessionModel } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import {
  type SessionCursorStore,
  SessionTurnLoop,
  type TurnLoopDeps,
  type TurnRow,
} from "./turn-loop";

// ── Fakes ────────────────────────────────────────────────────────────────────

/** An in-memory cursor store — the file-backed `SessionStore` shape, no disk. */
function memoryStore(seed?: SessionModel): SessionCursorStore & { get(id: string): SessionModel } {
  const map = new Map<string, SessionModel>();
  if (seed) map.set(seed.id, seed);
  return {
    load: (id) => map.get(id),
    save: (session) => {
      map.set(session.id, session);
    },
    get: (id) => {
      const s = map.get(id);
      if (!s) throw new Error(`no session ${id}`);
      return s;
    },
  };
}

interface FakePortOptions {
  /** The completed outcome to emit; defaults to a cursor-bearing success. */
  readonly outcome?: (spec: SessionSpec, turn: number) => SessionOutcome;
  /** Resolve each turn's createSession only when the returned trigger fires,
   *  so a test can hold a turn open and prove serialization. */
  readonly gate?: () => Promise<void>;
  /** Events yielded on the stream BEFORE the terminal `session.ended` (e.g. a
   *  harness `compact_boundary`), so a test can prove mid-stream row emission. */
  readonly prelude?: (turn: number) => readonly HarnessEvent[];
}

function fakePort(onSpec: (spec: SessionSpec) => void, options: FakePortOptions = {}): HarnessPort {
  let turn = 0;
  const descriptor = { id: "claude-code" } as unknown as HarnessDescriptor;
  return {
    descriptor,
    health: () => Promise.resolve({ state: "ready", version: "test" }),
    createSession: async (spec: SessionSpec): Promise<HarnessSession> => {
      onSpec(spec);
      const n = ++turn;
      if (options.gate) await options.gate();
      const outcome: SessionOutcome = options.outcome
        ? options.outcome(spec, n)
        : {
            status: "completed",
            finalText: "ok",
            harnessSessionId: `harness-${n}`,
            lastAssistantMessageAnchor: `anchor-${n}`,
          };
      const events: HarnessEvent[] = [
        ...(options.prelude?.(n) ?? []),
        { kind: "session.ended", outcome } as unknown as HarnessEvent,
      ];
      return {
        id: `sess-${n}`,
        harness: "claude-code",
        events: {
          async *[Symbol.asyncIterator]() {
            for (const e of events) yield e;
          },
        },
        send: () => Promise.resolve("turn"),
        interrupt: () => Promise.resolve(),
        close: () => Promise.resolve(),
      };
    },
  };
}

const spec = (session: SessionModel): Omit<SessionSpec, "resume"> => ({
  cwd: `/repo/${session.id}`,
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("SessionTurnLoop: resume contract on the injected port (task 2.4)", () => {
  it("hands the port the persisted cursor's harnessSessionId when resuming a reloaded session", async () => {
    // A session already carrying a cursor, loaded fresh from the store (the
    // restart-reattach path cluster 8's E2E exercises): the very first turn must
    // resume that exact id, not start a new conversation.
    const store = memoryStore({
      ...mintSession("proj", { id: () => "s1", now: () => 1 }),
      harnessCursor: {
        harnessSessionId: "persisted-77",
        lastAssistantMessageAnchor: "a",
        turnCount: 9,
      },
    });
    const specs: SessionSpec[] = [];
    const loop = new SessionTurnLoop({
      port: fakePort((s) => specs.push(s)),
      store,
      buildSpec: spec,
    });

    await loop.runTurn("s1", "resume me");
    // RED-proof: if the loop dropped `planResume`, this reddens — the port would
    // see no resume pointer and the harness would start a new conversation.
    expect(specs[0]?.resume).toEqual({ harnessSessionId: "persisted-77" });
  });
});

describe("SessionTurnLoop: cursor persistence (task 2.2)", () => {
  it("persists the harness-reported cursor after a completed turn", async () => {
    const session = mintSession("proj", { id: () => "s1", now: () => 1 });
    const store = memoryStore(session);
    const specs: SessionSpec[] = [];
    const loop = new SessionTurnLoop({
      port: fakePort((s) => specs.push(s)),
      store,
      buildSpec: spec,
    });

    const { session: after } = await loop.runTurn("s1", "hi");

    expect(after.harnessCursor).toEqual({
      harnessSessionId: "harness-1",
      lastAssistantMessageAnchor: "anchor-1",
      turnCount: 1,
    });
    // Persisted, not just returned.
    expect(store.get("s1").harnessCursor?.harnessSessionId).toBe("harness-1");
  });

  it("resumes the next turn from the persisted cursor and increments turnCount", async () => {
    const session = mintSession("proj", { id: () => "s1", now: () => 1 });
    const store = memoryStore(session);
    const specs: SessionSpec[] = [];
    const loop = new SessionTurnLoop({
      port: fakePort((s) => specs.push(s)),
      store,
      buildSpec: spec,
    });

    await loop.runTurn("s1", "one");
    const { session: after } = await loop.runTurn("s1", "two");

    // Turn 2's spec carried turn 1's harness session id as the resume pointer.
    expect(specs[1]?.resume).toEqual({ harnessSessionId: "harness-1" });
    expect(after.harnessCursor?.turnCount).toBe(2);
    // First turn had no cursor yet, so it resumed nothing.
    expect(specs[0]?.resume).toBeUndefined();
  });

  it("re-passes options (buildSpec) fresh every turn", async () => {
    const session = mintSession("proj", { id: () => "s1", now: () => 1 });
    const store = memoryStore(session);
    let builds = 0;
    const loop = new SessionTurnLoop({
      port: fakePort(() => undefined),
      store,
      buildSpec: (s) => {
        builds += 1;
        return { cwd: `/repo/${s.id}`, model: `m${builds}` };
      },
    });

    await loop.runTurn("s1", "one");
    await loop.runTurn("s1", "two");

    expect(builds).toBe(2);
  });

  it("does not advance the cursor when the harness reports no resume point", async () => {
    const session = mintSession("proj", { id: () => "s1", now: () => 1 });
    const store = memoryStore(session);
    const loop = new SessionTurnLoop({
      port: fakePort(() => undefined, {
        outcome: () => ({ status: "completed", finalText: "ok" }),
      }),
      store,
      buildSpec: spec,
    });

    const { session: after } = await loop.runTurn("s1", "hi");
    expect(after.harnessCursor).toBeUndefined();
  });

  it("returns the failed outcome without advancing the cursor", async () => {
    const session = mintSession("proj", { id: () => "s1", now: () => 1 });
    const store = memoryStore(session);
    const loop = new SessionTurnLoop({
      port: fakePort(() => undefined, {
        outcome: () => ({
          status: "failed",
          error: {
            class: "overloaded",
            origin: "provider",
            message: "busy",
            retryable: true,
            retryableSource: "inferred",
            nativeCode: null,
          },
        }),
      }),
      store,
      buildSpec: spec,
    });

    const { session: after, outcome } = await loop.runTurn("s1", "hi");
    expect(outcome.status).toBe("failed");
    expect(after.harnessCursor).toBeUndefined();
  });
});

describe("SessionTurnLoop: cursor persistence does not lose concurrent writes (finding 2)", () => {
  // A whole-record write (addThread/archive) is NOT routed through the turn-loop
  // serializer; it lands directly on the store. If the loop saved the pre-turn
  // snapshot it captured at load, that write would be erased. The loop must reload
  // the latest record and apply a cursor-only update.
  const someThread = {
    threadId: "t-mid",
    anchor: {
      type: "code",
      ref: { patchsetId: "ps-1", path: "a.ts", side: "head", startLine: 1, endLine: 1 },
    },
    ask: {
      intent: "rework",
      exitLane: "dispatch-round",
      provenance: "board:flagged",
      lifecycle: "dispatched",
    },
  } as unknown as SessionModel["threads"][number];

  it("preserves an addThread that lands mid-turn (completed path)", async () => {
    const session = mintSession("proj", { id: () => "s1", now: () => 1 });
    const store = memoryStore(session);
    const loop = new SessionTurnLoop({
      // The gate runs inside createSession — AFTER #runOnce already captured its
      // pre-turn snapshot at load — so this simulates a concurrent whole-record
      // write landing while the turn is in flight.
      port: fakePort(() => undefined, {
        gate: () => {
          store.save({ ...store.get("s1"), threads: [someThread] });
          return Promise.resolve();
        },
      }),
      store,
      buildSpec: spec,
    });

    const { session: after } = await loop.runTurn("s1", "hi");

    // RED-proof: saving the stale pre-turn snapshot would drop the thread. The
    // cursor advanced AND the concurrent thread survived.
    expect(after.harnessCursor?.harnessSessionId).toBe("harness-1");
    expect(after.threads).toHaveLength(1);
    expect(store.get("s1").threads).toHaveLength(1);
    expect(store.get("s1").harnessCursor?.harnessSessionId).toBe("harness-1");
  });

  it("does not resurrect an archive that lands mid-turn", async () => {
    const session = mintSession("proj", { id: () => "s1", now: () => 1 });
    const store = memoryStore(session);
    const loop = new SessionTurnLoop({
      port: fakePort(() => undefined, {
        gate: () => {
          store.save({ ...store.get("s1"), archivedAt: 12345 });
          return Promise.resolve();
        },
      }),
      store,
      buildSpec: spec,
    });

    await loop.runTurn("s1", "hi");

    // The archive stamp survived the cursor persist — the session is not resurrected.
    expect(store.get("s1").archivedAt).toBe(12345);
    expect(store.get("s1").harnessCursor?.harnessSessionId).toBe("harness-1");
  });
});

describe("SessionTurnLoop: serialization per session (task 2.2)", () => {
  it("runs two turns for one session serially — the second starts only after the first resolves", async () => {
    const session = mintSession("proj", { id: () => "s1", now: () => 1 });
    const store = memoryStore(session);
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((r) => {
      releaseFirst = r;
    });
    let call = 0;
    const loop = new SessionTurnLoop({
      port: fakePort(() => undefined, {
        gate: () => {
          call += 1;
          order.push(`start-${call}`);
          // Only the first turn blocks; the second runs freely once it starts.
          return call === 1 ? firstGate : Promise.resolve();
        },
      }),
      store,
      buildSpec: spec,
    });

    const p1 = loop.runTurn("s1", "one");
    const p2 = loop.runTurn("s1", "two");

    // Let microtasks flush: the second turn must NOT have started while the first holds.
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(["start-1"]);

    releaseFirst();
    await Promise.all([p1, p2]);
    expect(order).toEqual(["start-1", "start-2"]);
  });

  it("keeps the queue alive after a rejected turn (a failed turn does not wedge the session)", async () => {
    const session = mintSession("proj", { id: () => "s1", now: () => 1 });
    const store = memoryStore(session);
    let call = 0;
    const loop = new SessionTurnLoop({
      port: fakePort(() => undefined, {
        gate: () => {
          call += 1;
          return call === 1 ? Promise.reject(new Error("boom")) : Promise.resolve();
        },
      }),
      store,
      buildSpec: spec,
    });

    await expect(loop.runTurn("s1", "one")).rejects.toThrow("boom");
    // The next turn still runs — the tail swallowed the rejection.
    const { outcome } = await loop.runTurn("s1", "two");
    expect(outcome.status).toBe("completed");
  });

  it("does not serialize turns across different sessions", async () => {
    const a = mintSession("proj", { id: () => "a", now: () => 1 });
    const b = mintSession("proj", { id: () => "b", now: () => 1 });
    const map = new Map<string, SessionModel>([
      ["a", a],
      ["b", b],
    ]);
    const store: SessionCursorStore = {
      load: (id) => map.get(id),
      save: (s) => {
        map.set(s.id, s);
      },
    };
    const started: string[] = [];
    let releaseA!: () => void;
    const aGate = new Promise<void>((r) => {
      releaseA = r;
    });
    const loop = new SessionTurnLoop({
      port: fakePort((s) => started.push(s.cwd), {
        gate: () => (started.length === 1 ? aGate : Promise.resolve()),
      }),
      store,
      buildSpec: spec,
    });

    const pa = loop.runTurn("a", "one");
    const pb = loop.runTurn("b", "two");
    await Promise.resolve();
    await Promise.resolve();
    // B started even though A is still held — different sessions do not serialize.
    expect(started).toEqual(["/repo/a", "/repo/b"]);
    releaseA();
    await Promise.all([pa, pb]);
  });
});

describe("SessionTurnLoop: compaction surfaced honestly (task 3.1)", () => {
  it("emits exactly one compact_boundary row carrying the harness's own figures", async () => {
    const session = mintSession("proj", { id: () => "s1", now: () => 1 });
    const store = memoryStore(session);
    const rows: TurnRow[] = [];
    const loop = new SessionTurnLoop({
      port: fakePort(() => undefined, {
        prelude: () => [
          {
            kind: "compact_boundary",
            trigger: "auto",
            preTokens: 180_000,
            postTokens: 42_000,
          } as unknown as HarnessEvent,
        ],
      }),
      store,
      buildSpec: spec,
      emit: (_sessionId, r) => rows.push(r),
    });

    const { outcome } = await loop.runTurn("s1", "hi");

    expect(outcome.status).toBe("completed");
    // Exactly one row, carrying the harness's own trigger + pre/post token counts.
    expect(rows).toEqual([
      { kind: "compact_boundary", trigger: "auto", preTokens: 180_000, postTokens: 42_000 },
    ]);
  });

  it("carries only the figures the harness reported — an absent post_tokens stays absent", async () => {
    const session = mintSession("proj", { id: () => "s1", now: () => 1 });
    const store = memoryStore(session);
    const rows: TurnRow[] = [];
    const loop = new SessionTurnLoop({
      port: fakePort(() => undefined, {
        // A manual compaction where the harness gave no post_tokens figure.
        prelude: () => [{ kind: "compact_boundary", trigger: "manual" } as unknown as HarnessEvent],
      }),
      store,
      buildSpec: spec,
      emit: (_sessionId, r) => rows.push(r),
    });

    await loop.runTurn("s1", "hi");

    // No fabricated zero: the row omits the token counts the harness never gave.
    expect(rows).toEqual([{ kind: "compact_boundary", trigger: "manual" }]);
  });
});

describe("SessionTurnLoop: resume-vanished fallback (task 2.3)", () => {
  // A session whose cursor names a harness transcript the CLI no longer has.
  const withStaleCursor = (): SessionModel => ({
    ...mintSession("proj", { id: () => "s1", now: () => 1 }),
    harnessCursor: { harnessSessionId: "gone", lastAssistantMessageAnchor: "old", turnCount: 4 },
  });

  // The harness's terminal resume-refusal, mapped by the real adapter: the SDK
  // `error_during_execution` subtype preserved as nativeCode (B09 F4).
  const resumeRefused: SessionOutcome = {
    status: "failed",
    error: {
      class: "invalid-request",
      origin: "harness",
      message: "No conversation found with session ID: gone",
      retryable: false,
      retryableSource: "inferred",
      nativeCode: "error_during_execution",
    },
  };

  it("rebuilds context on a fresh session and re-mints the cursor from turn 1", async () => {
    const store = memoryStore(withStaleCursor());
    const rows: TurnRow[] = [];
    // Resumed turn is refused (vanished transcript); the fresh turn (no resume) succeeds.
    const loop = new SessionTurnLoop({
      port: fakePort(() => undefined, {
        outcome: (s) =>
          s.resume !== undefined
            ? resumeRefused
            : {
                status: "completed",
                finalText: "ok",
                harnessSessionId: "fresh-h",
                lastAssistantMessageAnchor: "fresh-a",
              },
      }),
      store,
      buildSpec: spec,
      emit: (_sessionId, r) => rows.push(r),
    });

    const { session: after, outcome, contextRebuilt } = await loop.runTurn("s1", "hi");

    expect(contextRebuilt).toBe(true);
    expect(outcome.status).toBe("completed");
    // Honest row surfaced to the reader.
    expect(rows).toEqual([
      {
        kind: "context_rebuilt",
        reason: "the harness no longer has this conversation's transcript",
      },
    ]);
    // Fresh conversation: new harness session id, turnCount reset to 1 (not 5).
    expect(after.harnessCursor).toEqual({
      harnessSessionId: "fresh-h",
      lastAssistantMessageAnchor: "fresh-a",
      turnCount: 1,
    });
    // Boards/threads/claim untouched — the loop never writes them (only the cursor moved).
    expect(after.threads).toEqual([]);
    expect(after.projectId).toBe("proj");
    expect(store.get("s1").harnessCursor?.harnessSessionId).toBe("fresh-h");
  });

  it("keeps a vanished resume attempt distinct while its successful retry owns the public turn id", async () => {
    const store = memoryStore(withStaleCursor());
    const captured: Parameters<NonNullable<TurnLoopDeps["recordTranscript"]>>[0][] = [];
    const loop = new SessionTurnLoop({
      port: fakePort(() => undefined, {
        outcome: (s) =>
          s.resume !== undefined
            ? resumeRefused
            : {
                status: "completed",
                finalText: "ok",
                harnessSessionId: "fresh-h",
                lastAssistantMessageAnchor: "fresh-a",
              },
      }),
      store,
      buildSpec: spec,
      recordTranscript: (input) => captured.push(input),
    });

    const result = await loop.runTurn("s1", "hi", { transcriptTurnId: "public-turn" });

    expect(result.contextRebuilt).toBe(true);
    expect(captured.map(({ turnId }) => turnId)).toEqual([
      "public-turn::resume-vanished",
      "public-turn",
    ]);
    expect(
      captured[0]?.events.some(
        (event) => event.kind === "session.ended" && event.outcome.status === "failed",
      ),
    ).toBe(true);
  });

  it("keeps the public turn id when a normal resumed turn succeeds", async () => {
    const store = memoryStore(withStaleCursor());
    const specs: SessionSpec[] = [];
    const captured: Parameters<NonNullable<TurnLoopDeps["recordTranscript"]>>[0][] = [];
    const loop = new SessionTurnLoop({
      port: fakePort((turnSpec) => specs.push(turnSpec)),
      store,
      buildSpec: spec,
      recordTranscript: (input) => captured.push(input),
    });

    await loop.runTurn("s1", "hi", { transcriptTurnId: "public-turn" });

    expect(specs[0]?.resume).toEqual({ harnessSessionId: "gone" });
    expect(captured.map(({ turnId }) => turnId)).toEqual(["public-turn"]);
  });

  it("does not rebuild when the resumed turn merely fails transiently (not vanished)", async () => {
    const store = memoryStore(withStaleCursor());
    const rows: TurnRow[] = [];
    const overloaded: SessionOutcome = {
      status: "failed",
      error: {
        class: "overloaded",
        origin: "provider",
        message: "busy",
        retryable: true,
        retryableSource: "inferred",
        nativeCode: null,
      },
    };
    const loop = new SessionTurnLoop({
      port: fakePort(() => undefined, { outcome: () => overloaded }),
      store,
      buildSpec: spec,
      emit: (_sessionId, r) => rows.push(r),
    });

    const { outcome, contextRebuilt } = await loop.runTurn("s1", "hi");
    expect(outcome.status).toBe("failed");
    expect(contextRebuilt).toBeUndefined();
    expect(rows).toEqual([]);
    // The stale cursor is left intact — a transient failure is not a vanish.
    expect(store.get("s1").harnessCursor?.harnessSessionId).toBe("gone");
  });

  it("does not replay a resumed prompt after a generic execution failure", async () => {
    const store = memoryStore(withStaleCursor());
    const specs: SessionSpec[] = [];
    const executionFailed: SessionOutcome = {
      status: "failed",
      error: {
        class: "invalid-request",
        origin: "harness",
        message: "tool completed before the response stream failed",
        retryable: false,
        retryableSource: "inferred",
        nativeCode: "error_during_execution",
      },
    };
    const loop = new SessionTurnLoop({
      port: fakePort((turnSpec) => specs.push(turnSpec), { outcome: () => executionFailed }),
      store,
      buildSpec: spec,
    });

    const { outcome, contextRebuilt } = await loop.runTurn("s1", "stage this", {
      inProcessTools: [],
    });

    expect(outcome).toBe(executionFailed);
    expect(contextRebuilt).toBeUndefined();
    expect(specs).toHaveLength(1);
    expect(specs[0]?.resume).toEqual({ harnessSessionId: "gone" });
    expect(store.get("s1").harnessCursor?.harnessSessionId).toBe("gone");
  });

  it("does not treat a model_not_found resume failure as vanished (F4 narrowing)", async () => {
    const store = memoryStore(withStaleCursor());
    const rows: TurnRow[] = [];
    // `model_not_found` ALSO maps to the invalid-request class, but carries a
    // different native code — it must NOT trigger the transcript-rebuild path.
    const modelNotFound: SessionOutcome = {
      status: "failed",
      error: {
        class: "invalid-request",
        origin: "adapter",
        message: "model not found",
        retryable: false,
        retryableSource: "inferred",
        nativeCode: "model_not_found",
      },
    };
    const loop = new SessionTurnLoop({
      port: fakePort(() => undefined, { outcome: () => modelNotFound }),
      store,
      buildSpec: spec,
      emit: (_sessionId, r) => rows.push(r),
    });

    const { outcome, contextRebuilt } = await loop.runTurn("s1", "hi");
    expect(outcome.status).toBe("failed");
    expect(contextRebuilt).toBeUndefined();
    expect(rows).toEqual([]);
    // The cursor is NOT dropped — a bad-model failure is a real failure, not a vanish.
    expect(store.get("s1").harnessCursor?.harnessSessionId).toBe("gone");
  });

  it("persists the dropped cursor before retrying, so a failed retry does not leave the stale pointer (F4)", async () => {
    const store = memoryStore(withStaleCursor());
    const failedFresh: SessionOutcome = {
      status: "failed",
      error: {
        class: "overloaded",
        origin: "provider",
        message: "busy",
        retryable: true,
        retryableSource: "inferred",
        nativeCode: null,
      },
    };
    const loop = new SessionTurnLoop({
      // Resume refused (vanished); the fresh retry ALSO fails (transiently).
      port: fakePort(() => undefined, {
        outcome: (s) => (s.resume !== undefined ? resumeRefused : failedFresh),
      }),
      store,
      buildSpec: spec,
    });

    const { contextRebuilt } = await loop.runTurn("s1", "hi");
    expect(contextRebuilt).toBe(true);
    // RED-proof: without the pre-retry persist, the stale "gone" cursor would
    // survive on disk and next turn would resume the vanished transcript again.
    expect(store.get("s1").harnessCursor).toBeUndefined();
  });
});

describe("SessionTurnLoop: display-transcript capture (issue-set B)", () => {
  it("hands recordTranscript the turn's full events with the spec cwd", async () => {
    const store = memoryStore(mintSession("proj", { id: () => "s1", now: () => 1 }));
    const toolEvents: HarnessEvent[] = [
      { kind: "thinking.message", text: "planning" } as unknown as HarnessEvent,
      {
        kind: "tool.started",
        call: {
          id: "c1",
          name: "Read",
          input: { file_path: "/repo/s1/a.ts" },
          parentToolCallId: null,
          kind: "read",
        },
      } as unknown as HarnessEvent,
      {
        kind: "tool.output",
        callId: "c1",
        ok: true,
        output: null,
        text: "ok",
      } as unknown as HarnessEvent,
    ];
    const captured: Array<{ sessionId: string; cwd: string; events: readonly HarnessEvent[] }> = [];
    const loop = new SessionTurnLoop({
      port: fakePort(() => undefined, { prelude: () => toolEvents }),
      store,
      buildSpec: spec,
      recordTranscript: (input) => captured.push(input),
    });

    await loop.runTurn("s1", "hi");
    expect(captured).toHaveLength(1);
    expect(captured[0]?.sessionId).toBe("s1");
    expect(captured[0]?.cwd).toBe("/repo/s1");
    // The tool events plus the terminal session.ended reached the sink.
    expect(captured[0]?.events.map((e) => e.kind)).toEqual([
      "thinking.message",
      "tool.started",
      "tool.output",
      "session.ended",
    ]);
  });
});
