import type {
  HarnessDescriptor,
  HarnessEvent,
  HarnessHealth,
  HarnessPort,
  HarnessSession,
  SessionOutcome,
  SessionSpec,
  TurnInput,
} from "@rennet/core";
import type { Hunk } from "@rennet/types";
import { describe, expect, it } from "vitest";
import {
  createVerificationFileReader,
  createVerificationTurn,
  DEFAULT_VERIFICATION_CONTEXT_LINES,
} from "./finding-verification-backend";

// ── The real-file reader (hermetic: an injected read, no disk) ──────────────────

function hunk(overrides: Partial<Hunk> & { id: string; filePath: string }): Hunk {
  return {
    fileStatus: "modified",
    oldStart: 1,
    oldLines: 1,
    newStart: 1,
    newLines: 1,
    addedLines: [],
    deletedLines: [],
    contextLines: [],
    changedLoc: 1,
    ...overrides,
  };
}

const FILE = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join("\n");

describe("createVerificationFileReader (#179)", () => {
  it("returns the real window around a hunk — MORE than the offered hunk", async () => {
    const read = createVerificationFileReader({
      hunks: [hunk({ id: "h1", filePath: "src/a.ts", newStart: 100, newLines: 3 })],
      repositoryRoot: "/repo",
      readFile: () => FILE,
      contextLines: 10,
    });
    const window = await read("rennet:hunk/h1");
    expect(window).toBeDefined();
    expect(window?.path).toBe("src/a.ts");
    // 100 - 10 context .. (100 + 3 - 1) + 10 = lines 90..112.
    expect(window?.startLine).toBe(90);
    expect(window?.endLine).toBe(112);
    expect(window?.text).toContain("line 100");
    expect(window?.text).toContain("line 90");
    expect(window?.text).toContain("line 112");
  });

  it("clamps the window to the file bounds", async () => {
    const read = createVerificationFileReader({
      hunks: [hunk({ id: "h1", filePath: "a.ts", newStart: 1, newLines: 1 })],
      repositoryRoot: "/repo",
      readFile: () => "only one line",
      contextLines: DEFAULT_VERIFICATION_CONTEXT_LINES,
    });
    const window = await read("rennet:hunk/h1");
    expect(window?.startLine).toBe(1);
    expect(window?.endLine).toBe(1);
    expect(window?.text).toBe("only one line");
  });

  it("returns undefined for an unknown hunk (fail-closed → core caveats it)", async () => {
    const read = createVerificationFileReader({
      hunks: [hunk({ id: "h1", filePath: "a.ts" })],
      repositoryRoot: "/repo",
      readFile: () => FILE,
    });
    expect(await read("rennet:hunk/nope")).toBeUndefined();
    expect(await read("not-an-anchor")).toBeUndefined();
  });

  it("refuses an unsafe file path (path escape) fail-closed", async () => {
    const read = createVerificationFileReader({
      hunks: [hunk({ id: "h1", filePath: "../../etc/passwd" })],
      repositoryRoot: "/repo",
      readFile: () => "secret",
    });
    expect(await read("rennet:hunk/h1")).toBeUndefined();
  });

  it("returns undefined when the file cannot be read", async () => {
    const read = createVerificationFileReader({
      hunks: [hunk({ id: "h1", filePath: "a.ts" })],
      repositoryRoot: "/repo",
      readFile: () => undefined,
    });
    expect(await read("rennet:hunk/h1")).toBeUndefined();
  });
});

// ── The fresh verification session over a scripted fake HarnessPort ─────────────

function endedEvent(outcome: SessionOutcome): HarnessEvent {
  return {
    seq: 1,
    harness: "claude-code",
    sessionId: "s1",
    turnId: "t1",
    receivedAt: 0,
    native: {},
    kind: "session.ended",
    outcome,
  };
}

interface FakeState {
  spec?: SessionSpec;
  sent: TurnInput[];
  closed: boolean;
}

function fakePort(events: HarnessEvent[], state: FakeState): HarnessPort {
  return {
    descriptor: { id: "claude-code" } as unknown as HarnessDescriptor,
    health(): Promise<HarnessHealth> {
      return Promise.resolve({ state: "ready", version: "2.1.0" });
    },
    createSession(spec: SessionSpec): Promise<HarnessSession> {
      state.spec = spec;
      const session: HarnessSession = {
        id: "s1",
        harness: "claude-code",
        events: {
          async *[Symbol.asyncIterator](): AsyncIterator<HarnessEvent> {
            for (const event of events) yield event;
          },
        },
        send(input: TurnInput): Promise<string> {
          state.sent.push(input);
          return Promise.resolve("t1");
        },
        interrupt: () => Promise.resolve(),
        close(): Promise<void> {
          state.closed = true;
          return Promise.resolve();
        },
      };
      return Promise.resolve(session);
    },
  };
}

describe("createVerificationTurn (#179)", () => {
  it("emits the structured body of a completed turn, constrained to the verify schema", async () => {
    const body = { verifications: [{ ref: "f1", verdict: "reproduced", evidence: "e" }] };
    const state: FakeState = { sent: [], closed: false };
    const port = fakePort(
      [endedEvent({ status: "completed", finalText: "ok", structuredOutput: body })],
      state,
    );
    const turn = createVerificationTurn(port, { cwd: "/repo", model: "claude-opus-4-8" });
    const result = await turn("verify this");
    expect(result).toEqual({ status: "emitted", body });
    // A fresh, read-only, schema-constrained session on the requested (different) seat.
    expect(state.spec?.readOnly).toBe(true);
    expect(state.spec?.outputSchema).toBeDefined();
    expect(state.spec?.model).toBe("claude-opus-4-8");
    expect(state.sent).toHaveLength(1);
    expect(state.closed).toBe(true);
  });

  it("threads real token usage when the terminal frame carries it", async () => {
    const usage = {
      input: 50,
      output: 10,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: null,
      total: 60,
    };
    const state: FakeState = { sent: [], closed: false };
    const port = fakePort(
      [
        endedEvent({
          status: "completed",
          finalText: "ok",
          structuredOutput: { verifications: [] },
          usage,
        }),
      ],
      state,
    );
    const turn = createVerificationTurn(port, { cwd: "/repo" });
    const result = await turn("verify");
    expect(result.status).toBe("emitted");
    if (result.status === "emitted") expect(result.tokens).toEqual(usage);
  });

  it("maps a completed turn WITHOUT structured output to a failure (core → inconclusive)", async () => {
    const state: FakeState = { sent: [], closed: false };
    const port = fakePort([endedEvent({ status: "completed", finalText: "no json" })], state);
    const turn = createVerificationTurn(port, { cwd: "/repo" });
    const result = await turn("verify");
    expect(result.status).toBe("failed");
    expect(state.closed).toBe(true);
  });

  it("maps a failed outcome to a turn failure", async () => {
    const state: FakeState = { sent: [], closed: false };
    const port = fakePort(
      [
        endedEvent({
          status: "failed",
          error: {
            class: "upstream",
            origin: "provider",
            message: "boom",
            retryable: true,
            retryableSource: "inferred",
            nativeCode: "server_error",
          },
        }),
      ],
      state,
    );
    const turn = createVerificationTurn(port, { cwd: "/repo" });
    const result = await turn("verify");
    expect(result).toEqual({ status: "failed", message: "boom" });
  });
});
