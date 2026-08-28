import type { HarnessEvent, SessionOutcome } from "@rennet/core";
import type { SessionTranscriptRow } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import { createTranscriptCapture, turnLoopRunPort } from "./turn-capture";
import type { TurnResult } from "./turn-loop";

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
    const capture = createTranscriptCapture(store, undefined, HOME);
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

  it("R19: the repo root, the home dir, and a stray absolute path never reach the store", () => {
    const store = sink();
    const capture = createTranscriptCapture(store, undefined, HOME);
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

    const serialized = JSON.stringify(store.appended);
    expect(serialized).not.toContain(REPO);
    expect(serialized).not.toContain(HOME);
    expect(serialized).toContain("<acme>/src/a.ts");
    expect(serialized).toContain("~/.zshrc");
    // An absolute path under neither root is redacted rather than left whole.
    expect(serialized).toContain("<path>");
  });

  it("a refused append is surfaced, never raised into the coding turn", () => {
    const refusal = new Error("refusing to append over unread history");
    const store = sink(refusal);
    const seen: unknown[] = [];
    const capture = createTranscriptCapture(store, (error) => seen.push(error), HOME);
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
