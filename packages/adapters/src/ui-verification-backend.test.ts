import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { describe, expect, it } from "vitest";
import {
  createUiVerificationTurn,
  readUiEvidence,
  resolveUiEvidenceDir,
} from "./ui-verification-backend";

interface FakeState {
  spec?: SessionSpec;
  sent: TurnInput[];
  closed: boolean;
}

function endedEvent(outcome: SessionOutcome): HarnessEvent {
  return {
    seq: 3,
    harness: "claude-code",
    sessionId: "s1",
    turnId: "t1",
    receivedAt: 0,
    native: {},
    kind: "session.ended",
    outcome,
  };
}

function toolStartedExec(callId: string, command: string): HarnessEvent {
  return {
    seq: 1,
    harness: "claude-code",
    sessionId: "s1",
    turnId: "t1",
    receivedAt: 0,
    native: {},
    kind: "tool.started",
    call: { id: callId, name: "Bash", input: { command }, parentToolCallId: null, kind: "exec" },
  };
}

function toolOutputEvent(callId: string, ok: boolean, text: string): HarnessEvent {
  return {
    seq: 2,
    harness: "claude-code",
    sessionId: "s1",
    turnId: "t1",
    receivedAt: 0,
    native: {},
    kind: "tool.output",
    callId,
    ok,
    output: {},
    text,
  };
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

const RAN_BODY = {
  mounted: true,
  method: "storybook",
  attempted: "storybook",
  screenshots: [{ path: "app.png", label: "App" }],
  observations: [],
};

describe("createUiVerificationTurn (#183)", () => {
  it("opens a fresh schema-constrained session and emits the structured body", async () => {
    const state: FakeState = { sent: [], closed: false };
    const port = fakePort(
      [endedEvent({ status: "completed", finalText: "ok", structuredOutput: RAN_BODY })],
      state,
    );
    const turn = createUiVerificationTurn(port, { cwd: "/repo", model: "claude-opus-4-8" });
    const result = await turn("mount this");
    expect(result).toEqual({ status: "emitted", body: RAN_BODY });
    expect(state.spec?.outputSchema).toBeDefined();
    expect(state.spec?.model).toBe("claude-opus-4-8");
    expect(state.sent).toHaveLength(1);
    expect(state.closed).toBe(true);
  });

  it("threads the observed exec commands as proof the mount ran (#259)", async () => {
    const state: FakeState = { sent: [], closed: false };
    const port = fakePort(
      [
        toolStartedExec("c1", "pnpm storybook"),
        toolOutputEvent("c1", true, "storybook ready on :6006"),
        endedEvent({ status: "completed", finalText: "ok", structuredOutput: RAN_BODY }),
      ],
      state,
    );
    const turn = createUiVerificationTurn(port, { cwd: "/repo" });
    const result = await turn("mount this");
    if (result.status !== "emitted") throw new Error("expected emitted");
    expect(result.execution?.commands).toEqual([
      { command: "pnpm storybook", ok: true, outputTail: "storybook ready on :6006" },
    ]);
  });

  it("a completed turn without structured output is a failure (core → unavailable)", async () => {
    const state: FakeState = { sent: [], closed: false };
    const port = fakePort([endedEvent({ status: "completed", finalText: "no json" })], state);
    const turn = createUiVerificationTurn(port, { cwd: "/repo" });
    const result = await turn("mount");
    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error("expected failed");
    expect(result.message).toMatch(/verify-ui/);
    expect(state.closed).toBe(true);
  });
});

describe("resolveUiEvidenceDir + readUiEvidence (#183)", () => {
  it("creates the review's evidence dir and reads a written screenshot as a data URL", async () => {
    const root = await mkdtemp(join(tmpdir(), "rennet-ui-ev-"));
    const dir = await resolveUiEvidenceDir(root, "review-1");
    // The dir now exists (mkdir -p) under <root>/<reviewId>/.
    const entries = await readdir(root);
    expect(entries).toContain("review-1");

    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // PNG magic
    await writeFile(join(dir, "shot.png"), png);
    const read = await readUiEvidence(root, "review-1", "shot.png");
    expect(read?.dataUrl).toBe(`data:image/png;base64,${png.toString("base64")}`);
  });

  it("returns null for a missing file and for an escaping path (fail-closed, never a crash)", async () => {
    const root = await mkdtemp(join(tmpdir(), "rennet-ui-ev-"));
    await resolveUiEvidenceDir(root, "review-1");
    expect(await readUiEvidence(root, "review-1", "does-not-exist.png")).toBeNull();
    // A path escaping the review's evidence directory is refused (not-found).
    expect(await readUiEvidence(root, "review-1", "../review-1/../../etc/passwd")).toBeNull();
    expect(await readUiEvidence(root, "review-1", "/etc/passwd")).toBeNull();
  });
});
