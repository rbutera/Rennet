import type {
  HarnessDescriptor,
  HarnessEvent,
  HarnessPort,
  HarnessSession,
  SessionOutcome,
  SessionSpec,
} from "@rennet/core";
import { mintSession } from "@rennet/core";
import type { SessionModel, SessionTranscriptRow } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import { createContextRebuiltEmit, createTranscriptCapture, turnLoopRunPort } from "./turn-capture";
import { SessionTurnLoop, type TurnResult } from "./turn-loop";

// The two seams that make the session turn loop's instantiation real (B10 cluster 6): the
// transcript-capture sink that lights up C07's `session.transcript` WRITE side, and the
// `HandoffRunPort` shim that runs the round's coding turn THROUGH the loop.

type BaseKeys = "seq" | "harness" | "sessionId" | "turnId" | "receivedAt" | "native";
type EventInput = HarnessEvent extends infer E
  ? E extends HarnessEvent
    ? Omit<E, BaseKeys>
    : never
  : never;
let seq = 0;
function ev(partial: EventInput): HarnessEvent {
  return {
    seq: seq++,
    harness: "claude-code",
    sessionId: "s1",
    turnId: "t1",
    receivedAt: 0,
    native: null,
    ...partial,
  } as HarnessEvent;
}

const REPO = "/hosts/nimbus/dev/acme";
const HOME = "/hosts/nimbus";

/** A recording transcript sink; `fail` makes `append` refuse (the corrupt-log path). */
function sink(fail?: Error) {
  const appended: { sessionId: string; rows: SessionTranscriptRow[] }[] = [];
  return {
    appended,
    append(sessionId: string, rows: readonly SessionTranscriptRow[]) {
      if (fail) throw fail;
      appended.push({ sessionId, rows: [...rows] });
    },
  };
}

describe("createTranscriptCapture — the WRITE side of session.transcript (C07)", () => {
  it("appends the turn's projected rows under the session id", () => {
    const store = sink();
    const capture = createTranscriptCapture(store);
    capture({
      sessionId: "sess-1",
      cwd: REPO,
      events: [
        ev({
          kind: "tool.started",
          call: {
            id: "c1",
            name: "Read",
            input: { file_path: `${REPO}/src/a.ts` },
            parentToolCallId: null,
            kind: "read",
          },
        }),
        ev({ kind: "text.message", text: "Renamed the export.", parentToolCallId: null }),
      ],
    });

    expect(store.appended).toHaveLength(1);
    const entry = store.appended[0];
    expect(entry?.sessionId).toBe("sess-1");
    const turn = entry?.rows.find((row) => row.kind === "turn");
    expect(turn).toBeDefined();
    if (turn?.kind !== "turn") throw new Error("expected a turn row");
    expect(turn.paragraphs).toEqual(["Renamed the export."]);
    expect(turn.preface?.[0]).toMatchObject({ kind: "action", label: "Read" });
  });

  it("stores host paths VERBATIM — the reviewer's own transcript is not redacted at rest", () => {
    const store = sink();
    const capture = createTranscriptCapture(store);
    capture({
      sessionId: "sess-1",
      cwd: REPO,
      events: [
        ev({
          kind: "tool.started",
          call: {
            id: "c1",
            name: "Bash",
            input: { command: `cat ${REPO}/src/a.ts ${HOME}/.zshrc /etc/hosts/passwd` },
            parentToolCallId: null,
            kind: "exec",
          },
        }),
        ev({ kind: "text.message", text: `wrote ${REPO}/src/a.ts`, parentToolCallId: null }),
      ],
    });

    // The harm this replaces: the sink used to run `redactAbsolutePaths(scrubRoots(...))` before
    // `append`, so the durable log kept `<acme>/src/a.ts`, `~/.zshrc` and `<path>` — a path the
    // reviewer could no longer click, copy, or grep, on their OWN machine. R19 is a rule about
    // what crosses the wire to a REMOTE client, and the wire enforces it (projection.test.ts's
    // `session.transcript` cases + remote-surface-e2e.test.ts). Put the write-time scrub back and
    // these three assertions go red.
    const serialized = JSON.stringify(store.appended);
    expect(serialized).toContain(`${REPO}/src/a.ts`);
    expect(serialized).toContain(`${HOME}/.zshrc`);
    expect(serialized).toContain("/etc/hosts/passwd");
    expect(serialized).not.toContain("<acme>");
    expect(serialized).not.toContain("<path>");
  });

  it("a refused append is surfaced, never raised into the coding turn", () => {
    const refusal = new Error("refusing to append over unread history");
    const store = sink(refusal);
    const seen: unknown[] = [];
    const capture = createTranscriptCapture(store, (error) => seen.push(error));
    expect(() =>
      capture({
        sessionId: "sess-1",
        cwd: REPO,
        events: [ev({ kind: "text.message", text: "hi", parentToolCallId: null })],
      }),
    ).not.toThrow();
    expect(seen).toEqual([refusal]);
  });
});

describe("turnLoopRunPort — the round's coding turn runs THROUGH the loop", () => {
  function loopReturning(outcome: SessionOutcome) {
    const calls: { sessionId: string; prompt: string }[] = [];
    return {
      calls,
      runTurn(sessionId: string, prompt: string): Promise<TurnResult> {
        calls.push({ sessionId, prompt });
        return Promise.resolve({ session: { id: sessionId } as TurnResult["session"], outcome });
      },
    };
  }

  it("drives the loop with the session id, and reports the completed turn's final text", async () => {
    const loop = loopReturning({
      status: "completed",
      finalText: "addressed 2 asks",
      usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, reasoning: null, total: 3 },
    });
    const outcome = await turnLoopRunPort(loop, "sess-1")({ cwd: REPO, prompt: "work order" });
    expect(loop.calls).toEqual([{ sessionId: "sess-1", prompt: "work order" }]);
    expect(outcome).toMatchObject({ status: "completed", finalText: "addressed 2 asks" });
    if (outcome.status !== "completed") throw new Error("expected completed");
    expect(outcome.usage?.total).toBe(3);
  });

  it("reports a failed turn honestly, never a fabricated success", async () => {
    const loop = loopReturning({
      status: "failed",
      error: {
        class: "protocol",
        origin: "adapter",
        message: "the harness stream ended without a terminal frame",
        retryable: false,
        retryableSource: "inferred",
        nativeCode: null,
      },
    });
    const outcome = await turnLoopRunPort(loop, "sess-1")({ cwd: REPO, prompt: "p" });
    expect(outcome).toEqual({
      status: "failed",
      reason: "the harness stream ended without a terminal frame",
    });
  });

  it("reports a cancelled turn as a failure with its own reason", async () => {
    const loop = loopReturning({ status: "cancelled", partial: true });
    const outcome = await turnLoopRunPort(loop, "sess-1")({ cwd: REPO, prompt: "p" });
    expect(outcome).toEqual({ status: "failed", reason: "the handoff turn was cancelled" });
  });
});

// ── The resume-vanished marker, end to end through the real loop ──────────────
//
// `context_rebuilt` is reachable ONLY now that resume is live: the loop synthesizes it when
// the CLI no longer has the conversation the persisted cursor points at. It is not a harness
// event, so the projector cannot produce it — an unwired `emit` means the transcript reads
// CONTINUOUS across a context loss, which is the surface claiming something it cannot know.

/** A port whose FIRST turn fails resume-vanished and whose second (fresh) turn completes. */
function resumeVanishedPort(specs: SessionSpec[]): HarnessPort {
  let turn = 0;
  return {
    descriptor: { id: "claude-code" } as unknown as HarnessDescriptor,
    health: () => Promise.resolve({ state: "ready", version: "test" }),
    createSession: (spec: SessionSpec): Promise<HarnessSession> => {
      specs.push(spec);
      const n = ++turn;
      const outcome: SessionOutcome =
        n === 1
          ? {
              status: "failed",
              error: {
                class: "invalid-request",
                origin: "harness",
                message: "no conversation found to resume",
                retryable: false,
                retryableSource: "inferred",
                nativeCode: "error_during_execution",
              },
            }
          : {
              status: "completed",
              finalText: "picked it back up",
              harnessSessionId: "harness-2",
              lastAssistantMessageAnchor: "anchor-2",
            };
      const events: HarnessEvent[] = [
        {
          kind: "text.message",
          text: n === 1 ? "before the loss" : "picked it back up",
          parentToolCallId: null,
        } as unknown as HarnessEvent,
        { kind: "session.ended", outcome } as unknown as HarnessEvent,
      ];
      return Promise.resolve({
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
      } as HarnessSession);
    },
  };
}

describe("createContextRebuiltEmit — a rebuilt context is never a continuous transcript", () => {
  it("lands a context-rebuilt row between the lost turn and the rebuilt one", async () => {
    const store = sink();
    const seeded: SessionModel = {
      ...mintSession(REPO, { id: () => "sess-1", now: () => 1 }),
      harnessCursor: { harnessSessionId: "gone", lastAssistantMessageAnchor: "a1", turnCount: 2 },
    };
    const sessions = new Map([["sess-1", seeded]]);
    const specs: SessionSpec[] = [];

    const loop = new SessionTurnLoop({
      port: resumeVanishedPort(specs),
      store: {
        load: (id) => sessions.get(id),
        save: (s) => {
          sessions.set(s.id, s);
        },
      },
      buildSpec: () => ({ cwd: REPO }),
      emit: createContextRebuiltEmit(store),
      recordTranscript: createTranscriptCapture(store),
    });

    const result = await loop.runTurn("sess-1", "carry on");
    expect(result.contextRebuilt).toBe(true);
    // The resumed turn ran first, then the fresh one — proving the loop really took the fallback.
    expect(specs[0]?.resume).toEqual({ harnessSessionId: "gone" });
    expect(specs[1]?.resume).toBeUndefined();

    // Every append, flattened in order: the reader's transcript as it will be read back.
    const rows = store.appended.flatMap((entry) => entry.rows);
    const kinds = rows.map((row) => row.kind);
    expect(kinds).toContain("context-rebuilt");
    // ORDER is the whole point: the marker sits between the lost turn and the rebuilt one, so
    // scrolling back cannot read as one unbroken conversation.
    const marker = kinds.indexOf("context-rebuilt");
    expect(kinds.slice(0, marker)).toContain("turn");
    expect(kinds.slice(marker + 1)).toContain("turn");
    // It is filed under the session it happened to, and says why.
    expect(store.appended.every((entry) => entry.sessionId === "sess-1")).toBe(true);
    const rebuilt = rows.find((row) => row.kind === "context-rebuilt");
    if (rebuilt?.kind !== "context-rebuilt") throw new Error("expected a context-rebuilt row");
    expect(rebuilt.reason).toMatch(/transcript/);
  });

  it("leaves compact_boundary alone — the projector already produces those rows", () => {
    const store = sink();
    createContextRebuiltEmit(store)("sess-1", { kind: "compact_boundary", trigger: "auto" });
    expect(store.appended).toEqual([]);
  });
});
