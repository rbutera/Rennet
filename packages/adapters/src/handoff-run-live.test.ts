import type {
  HarnessDescriptor,
  HarnessEvent,
  HarnessHealth,
  HarnessPort,
  HarnessSession,
  SessionSpec,
  TurnInput,
} from "@rennet/core";
import { describe, expect, it } from "vitest";
import {
  claudeHandoffRunPort,
  HANDOFF_DENIED_TOOLS,
  HANDOFF_WRITE_TOOLS,
} from "./handoff-run-live";

/** A fake session that records the spec and yields a scripted event stream. */
class FakeSession implements HarnessSession {
  readonly id = "s1";
  readonly harness = "claude-code";
  closed = false;
  constructor(private readonly script: HarnessEvent[]) {}
  get events(): AsyncIterable<HarnessEvent> {
    const script = this.script;
    return {
      async *[Symbol.asyncIterator](): AsyncIterator<HarnessEvent> {
        for (const event of script) yield event;
      },
    };
  }
  send(_input: TurnInput): Promise<string> {
    return Promise.resolve("t1");
  }
  interrupt(): Promise<void> {
    return Promise.resolve();
  }
  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
}

function endedEvent(outcome: unknown): HarnessEvent {
  return { kind: "session.ended", outcome } as unknown as HarnessEvent;
}

/** A fake harness port that records the last spec it was asked to create a session for. */
function fakePort(events: HarnessEvent[]): {
  port: HarnessPort;
  lastSpec: () => SessionSpec | null;
} {
  let last: SessionSpec | null = null;
  const port: HarnessPort = {
    descriptor: {} as HarnessDescriptor,
    health: () => Promise.resolve({ state: "ready", version: "2.1.0" } as HarnessHealth),
    createSession: (spec: SessionSpec) => {
      last = spec;
      return Promise.resolve(new FakeSession(events));
    },
  };
  return { port, lastSpec: () => last };
}

describe("claudeHandoffRunPort", () => {
  it("creates a WRITE-enabled session with exec/network DENIED (git push unreachable)", async () => {
    const { port, lastSpec } = fakePort([endedEvent({ status: "completed", finalText: "did it" })]);
    await claudeHandoffRunPort(port)({ cwd: "/repo", prompt: "do the thing" });
    const spec = lastSpec();
    expect(spec?.readOnly).toBe(false);
    expect(spec?.allowedTools).toEqual(HANDOFF_WRITE_TOOLS);
    expect(spec?.disallowedTools).toEqual(HANDOFF_DENIED_TOOLS);
    // The one that could push MUST be denied and MUST NOT be allowed.
    expect(spec?.disallowedTools).toContain("Bash");
    expect(spec?.allowedTools).not.toContain("Bash");
  });

  it("returns the completed final text (with usage when reported)", async () => {
    const { port } = fakePort([
      endedEvent({
        status: "completed",
        finalText: "addressed 2 changes",
        usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, reasoning: null, total: 3 },
      }),
    ]);
    const outcome = await claudeHandoffRunPort(port)({ cwd: "/repo", prompt: "p" });
    expect(outcome.status).toBe("completed");
    if (outcome.status === "completed") {
      expect(outcome.finalText).toBe("addressed 2 changes");
      expect(outcome.usage?.total).toBe(3);
    }
  });

  it("maps an error frame to an honest failure, never a fabricated success", async () => {
    const { port } = fakePort([
      { kind: "error", error: { message: "overloaded" } } as unknown as HarnessEvent,
    ]);
    const outcome = await claudeHandoffRunPort(port)({ cwd: "/repo", prompt: "p" });
    expect(outcome).toEqual({ status: "failed", reason: "overloaded" });
  });

  it("fails honestly when the session throws on construction", async () => {
    const port: HarnessPort = {
      descriptor: {} as HarnessDescriptor,
      health: () => Promise.resolve({ state: "ready", version: "2.1.0" } as HarnessHealth),
      createSession: () => Promise.reject(new Error("spawn failed")),
    };
    const outcome = await claudeHandoffRunPort(port)({ cwd: "/repo", prompt: "p" });
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") expect(outcome.reason).toContain("spawn failed");
  });

  it("fails when the stream ends with no terminal frame", async () => {
    const { port } = fakePort([]);
    const outcome = await claudeHandoffRunPort(port)({ cwd: "/repo", prompt: "p" });
    expect(outcome).toEqual({
      status: "failed",
      reason: "the handoff turn ended without a terminal frame",
    });
  });
});
