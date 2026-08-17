import { mkdir, mkdtemp, readdir, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
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
import { MAX_UI_EVIDENCE_BYTES } from "@rennet/types";
import { describe, expect, it } from "vitest";
import {
  beginUiEvidenceRun,
  completeUiEvidenceRun,
  createUiVerificationTurn,
  inspectUiEvidence,
  readUiEvidence,
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

describe("namespaced, confined UI evidence (#183)", () => {
  it("creates a patchset/run namespace and reads a regular screenshot as a data URL", async () => {
    const root = await mkdtemp(join(tmpdir(), "rennet-ui-ev-"));
    const run = await beginUiEvidenceRun(root, "review-1", "patchset-1", "run-1");

    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // PNG magic
    await writeFile(join(run.directory, "shot.png"), png);
    const read = await readUiEvidence(root, "review-1", `${run.namespace}/shot.png`);
    expect(read).toEqual({
      status: "ok",
      dataUrl: `data:image/png;base64,${png.toString("base64")}`,
    });
    expect(await inspectUiEvidence(run.directory, "shot.png")).toEqual({ status: "present" });
  });

  it("returns null for a missing file and for an escaping path (fail-closed, never a crash)", async () => {
    const root = await mkdtemp(join(tmpdir(), "rennet-ui-ev-"));
    await beginUiEvidenceRun(root, "review-1", "patchset-1", "run-1");
    expect(await readUiEvidence(root, "review-1", "does-not-exist.png")).toBeNull();
    // A path escaping the review's evidence directory is refused (not-found).
    expect(await readUiEvidence(root, "review-1", "../review-1/../../etc/passwd")).toBeNull();
    expect(await readUiEvidence(root, "review-1", "/etc/passwd")).toBeNull();
  });

  it("refuses a directory because evidence must be a regular file", async () => {
    const root = await mkdtemp(join(tmpdir(), "rennet-ui-ev-"));
    const run = await beginUiEvidenceRun(root, "review-1", "patchset-1", "run-1");
    await mkdir(join(run.directory, "folder.png"));
    expect(await inspectUiEvidence(run.directory, "folder.png")).toEqual({
      status: "not-found",
    });
    expect(await readUiEvidence(root, "review-1", `${run.namespace}/folder.png`)).toBeNull();
  });

  it("refuses a final-component symlink whose real path escapes the canonical review dir", async () => {
    const root = await mkdtemp(join(tmpdir(), "rennet-ui-ev-"));
    const outside = await mkdtemp(join(tmpdir(), "rennet-ui-outside-"));
    const run = await beginUiEvidenceRun(root, "review-1", "patchset-1", "run-1");
    const secret = join(outside, "secret.png");
    await writeFile(secret, "secret bytes");
    await symlink(secret, join(run.directory, "shot.png"));

    expect(await readUiEvidence(root, "review-1", `${run.namespace}/shot.png`)).toBeNull();
    expect(await inspectUiEvidence(run.directory, "shot.png")).toEqual({ status: "not-found" });
  });

  it("refuses an intermediate-directory symlink whose real path escapes", async () => {
    const root = await mkdtemp(join(tmpdir(), "rennet-ui-ev-"));
    const outside = await mkdtemp(join(tmpdir(), "rennet-ui-outside-"));
    const run = await beginUiEvidenceRun(root, "review-1", "patchset-1", "run-1");
    await writeFile(join(outside, "secret.png"), "secret bytes");
    await symlink(outside, join(run.directory, "linked"));

    expect(await readUiEvidence(root, "review-1", `${run.namespace}/linked/secret.png`)).toBeNull();
    expect(await inspectUiEvidence(run.directory, "linked/secret.png")).toEqual({
      status: "not-found",
    });
  });

  it("stats before reading and reports an oversized screenshot explicitly", async () => {
    const root = await mkdtemp(join(tmpdir(), "rennet-ui-ev-"));
    const run = await beginUiEvidenceRun(root, "review-1", "patchset-1", "run-1");
    const huge = join(run.directory, "huge.png");
    await writeFile(huge, "");
    await truncate(huge, MAX_UI_EVIDENCE_BYTES + 1);

    expect(await inspectUiEvidence(run.directory, "huge.png")).toEqual({ status: "oversized" });
    expect(await readUiEvidence(root, "review-1", `${run.namespace}/huge.png`)).toEqual({
      status: "oversized",
    });
  });

  it("isolates patchset bytes and lets a stale completion remove only its own run", async () => {
    const root = await mkdtemp(join(tmpdir(), "rennet-ui-ev-"));
    const oldRun = await beginUiEvidenceRun(root, "review-1", "patchset-A", "run-old");
    const currentRun = await beginUiEvidenceRun(root, "review-1", "patchset-A", "run-current");
    const otherPatchset = await beginUiEvidenceRun(root, "review-1", "patchset-B", "run-B");
    await Promise.all([
      writeFile(join(oldRun.directory, "app.png"), "old"),
      writeFile(join(currentRun.directory, "app.png"), "current"),
      writeFile(join(otherPatchset.directory, "app.png"), "other"),
    ]);

    await completeUiEvidenceRun(currentRun, true);
    await completeUiEvidenceRun(oldRun, true);
    await completeUiEvidenceRun(otherPatchset, true);

    expect(await readdir(currentRun.patchsetDir)).toEqual([basename(currentRun.directory)]);
    expect(await readUiEvidence(root, "review-1", `${currentRun.namespace}/app.png`)).toMatchObject(
      {
        status: "ok",
        dataUrl: expect.stringContaining(Buffer.from("current").toString("base64")) as string,
      },
    );
    expect(
      await readUiEvidence(root, "review-1", `${otherPatchset.namespace}/app.png`),
    ).toMatchObject({
      status: "ok",
      dataUrl: expect.stringContaining(Buffer.from("other").toString("base64")) as string,
    });
  });

  it("opportunistically bounds retained completed patchset namespaces", async () => {
    const root = await mkdtemp(join(tmpdir(), "rennet-ui-ev-"));
    let reviewDir = "";
    for (let index = 0; index < 6; index += 1) {
      const run = await beginUiEvidenceRun(
        root,
        "review-retention",
        `patchset-${index}`,
        `run-${index}`,
      );
      reviewDir = run.reviewDir;
      await writeFile(join(run.directory, "app.png"), `${index}`);
      await completeUiEvidenceRun(run, true);
    }
    const patchsets = (await readdir(reviewDir)).filter((entry) => entry.startsWith("patch-"));
    expect(patchsets).toHaveLength(4);
  });
});
