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
import { type SessionCursorStore, SessionTurnLoop, type TurnRow } from "./turn-loop";

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
      emit: (r) => rows.push(r),
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
      emit: (r) => rows.push(r),
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

  const invalidRequest: SessionOutcome = {
    status: "failed",
    error: {
      class: "invalid-request",
      origin: "harness",
      message: "no conversation found for resume id",
      retryable: false,
      retryableSource: "inferred",
      nativeCode: null,
    },
  };

  it("rebuilds context on a fresh session and re-mints the cursor from turn 1", async () => {
    const store = memoryStore(withStaleCursor());
    const rows: TurnRow[] = [];
    // Resumed turn fails invalid-request (vanished); the fresh turn (no resume) succeeds.
    const loop = new SessionTurnLoop({
      port: fakePort(() => undefined, {
        outcome: (s) =>
          s.resume !== undefined
            ? invalidRequest
            : {
                status: "completed",
                finalText: "ok",
                harnessSessionId: "fresh-h",
                lastAssistantMessageAnchor: "fresh-a",
              },
      }),
      store,
      buildSpec: spec,
      emit: (r) => rows.push(r),
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
      emit: (r) => rows.push(r),
    });

    const { outcome, contextRebuilt } = await loop.runTurn("s1", "hi");
    expect(outcome.status).toBe("failed");
    expect(contextRebuilt).toBeUndefined();
    expect(rows).toEqual([]);
    // The stale cursor is left intact — a transient failure is not a vanish.
    expect(store.get("s1").harnessCursor?.harnessSessionId).toBe("gone");
  });
});
