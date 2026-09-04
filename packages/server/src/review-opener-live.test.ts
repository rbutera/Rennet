import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PublishCompositionStore } from "@rennet/adapters";
import {
  type CodexExecRequest,
  type CodexExecutor,
  emptyAskProjection,
  type HarnessEvent,
  type HarnessPort,
  type ReviewOpenerDraftInput,
  sessionContextRelativeDir,
} from "@rennet/core";
import type { PromptContextFile } from "@rennet/prompts";
import type { Patchset, Review } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import { sessionContextDir, writeSessionContext } from "./context-files";
import {
  claudeReviewOpenerPort,
  createLiveReviewOpenerPort,
  REVIEW_OPENER_OUTPUT_SCHEMA,
} from "./review-opener-live";

/**
 * A real repository root. The port WRITES the opener's context under it before the turn
 * (session-context-files 3.7), and the seat resolves the paths in its prompt against it —
 * so a fixture root that does not exist is a fixture that cannot exercise the turn.
 */
function repoRoot(): string {
  return mkdtempSync(join(tmpdir(), "rennet-opener-repo-"));
}

// The daemon's ONE context writer as this port sees it, keyed on the SESSION id — which
// is DELIBERATELY NOT the review id (`review-1`). A port that re-derived its directory
// from `review.id` would write, and point the seat, somewhere no assertion below looks
// (review finding 1).
const SESSION_ID = "sess-opener-7";
const recordContext = (review: Review, files: readonly PromptContextFile[]): string => {
  writeSessionContext(review.repositoryRoot, SESSION_ID, files);
  return sessionContextRelativeDir(SESSION_ID);
};

/** Read one of the files the port wrote for this review. */
function contextFile(root: string, name: string): string {
  return readFileSync(join(sessionContextDir(root, SESSION_ID), name), "utf8");
}

function review(root: string): Review {
  const patchset: Patchset = {
    id: "patch-1",
    createdAt: "2026-08-30T00:00:00.000Z",
    repository: {
      id: "repo",
      root,
      commonDir: join(root, ".git"),
      baseRef: "main",
      baseOid: "base",
      headOid: "head",
    },
    files: [
      {
        path: "src/retry.ts",
        status: "modified",
        additions: 1,
        deletions: 1,
        binary: false,
        patch: "@@ -1 +1 @@",
      },
    ],
    rawDiff: "@@ -1 +1 @@",
    byteLength: 12,
    truncated: false,
  };
  return {
    id: "review-1",
    repositoryRoot: root,
    patchsets: [patchset],
    activePatchsetId: patchset.id,
    dispositions: [],
    status: "current",
  };
}

function draft(verdict: ReviewOpenerDraftInput["verdict"]): ReviewOpenerDraftInput {
  return {
    verdict,
    boards: [],
    projection: {
      ...emptyAskProjection(),
      stagedAsks: {
        "ask-1": {
          id: "ask-1",
          anchor: "src/retry.ts:4",
          type: "request-change",
          body: "Reconcile the outcome before retrying.",
        },
      },
    },
    changedPaths: ["src/retry.ts"],
  };
}

function tempStore(): PublishCompositionStore {
  return new PublishCompositionStore(mkdtempSync(join(tmpdir(), "rennet-opener-live-")));
}

function executorReturning(
  opener: string,
  onRequest?: (request: CodexExecRequest) => void,
): CodexExecutor {
  return async (request) => {
    onRequest?.(request);
    return { output: { opener }, model: "gpt-5.6-luna-runtime" };
  };
}

function started(model: string): HarnessEvent {
  return {
    seq: 1,
    harness: "claude-code",
    sessionId: "session",
    turnId: "turn",
    receivedAt: 0,
    native: null,
    kind: "session.started",
    model,
    cwd: "/repo",
    tools: [],
    apiKeySource: null,
  } as HarnessEvent;
}

function completed(structuredOutput: unknown): HarnessEvent {
  return {
    seq: 2,
    harness: "claude-code",
    sessionId: "session",
    turnId: "turn",
    receivedAt: 0,
    native: null,
    kind: "session.ended",
    outcome: { status: "completed", finalText: "", structuredOutput },
  } as HarnessEvent;
}

function harnessClaudePort(
  events: readonly HarnessEvent[],
  close: () => Promise<void> = async () => undefined,
): HarnessPort {
  return {
    descriptor: {} as never,
    health: async () => ({}) as never,
    createSession: async (spec) => {
      expect(spec.ephemeral).toBe(true);
      expect(spec.outputSchema).toEqual(REVIEW_OPENER_OUTPUT_SCHEMA);
      return {
        id: "session",
        harness: "claude-code",
        events: (async function* () {
          for (const event of events) yield event;
        })(),
        send: async () => "turn" as never,
        interrupt: async () => undefined,
        close,
      } as never;
    },
  } as HarnessPort;
}

describe("createLiveReviewOpenerPort", () => {
  it("keeps a completed Claude result when ephemeral-session cleanup fails", async () => {
    const port = harnessClaudePort(
      [started("claude-haiku-runtime"), completed({ opener: "The retry boundary holds." })],
      async () => {
        throw new Error("close failed");
      },
    );

    await expect(claudeReviewOpenerPort(port, "/repo")("prompt")).resolves.toEqual({
      status: "emitted",
      opener: "The retry boundary holds.",
      model: "claude-haiku-runtime",
    });
  });

  it("routes the Codex seat, grounds the prompt, and reuses persisted bytes after restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "rennet-opener-restart-"));
    let firstCalls = 0;
    let seenRequest: CodexExecRequest | undefined;
    const first = createLiveReviewOpenerPort({
      writeContext: recordContext,
      claudePort: async () => null,
      codexExecutor: async () =>
        executorReturning("The retry path still needs outcome reconciliation.", (request) => {
          firstCalls += 1;
          seenRequest = request;
        }),
      readPrompt: async () => "Write in the reviewer's own voice.",
      store: new PublishCompositionStore(directory),
    });
    const root = repoRoot();
    const firstResult = await first({ review: review(root), draft: draft("REQUEST_CHANGES") });
    expect(firstResult).toEqual({
      status: "drafted",
      opener: "The retry path still needs outcome reconciliation.",
      model: "gpt-5.6-luna-runtime",
    });
    expect(firstCalls).toBe(1);
    expect(seenRequest?.model).toBe("gpt-5.6-luna");
    expect(seenRequest?.outputSchema).toEqual(REVIEW_OPENER_OUTPUT_SCHEMA);
    // The turn runs in the checkout, so a relative path in the prompt resolves.
    expect(seenRequest?.cwd).toBe(root);
    // The prompt NAMES the files; not one fact travels with it (3.7).
    expect(seenRequest?.prompt).toContain(".rennet/context/sess-opener-7/opener/review-facts.json");
    expect(seenRequest?.prompt).not.toContain(".rennet/context/review-1/");
    expect(seenRequest?.prompt).toContain(".rennet/context/sess-opener-7/opener/asks.json");
    expect(seenRequest?.prompt).not.toContain("REQUEST_CHANGES");
    expect(seenRequest?.prompt).not.toContain("Reconcile the outcome before retrying.");
    expect(seenRequest?.prompt).not.toContain("Write in the reviewer's own voice.");
    // ...and the facts are on the other end of those paths, written before the turn ran.
    expect(JSON.parse(contextFile(root, "opener/review-facts.json"))).toEqual({
      verdict: "REQUEST_CHANGES",
      changedPaths: ["src/retry.ts"],
    });
    expect(contextFile(root, "opener/asks.json")).toContain(
      "Reconcile the outcome before retrying.",
    );
    expect(contextFile(root, "opener/voice-rules.md")).toBe("Write in the reviewer's own voice.");
    // The index a reader who has never seen Rennet gets.
    expect(contextFile(root, "README.md")).toContain("opener/asks.json");

    let restartedCalls = 0;
    const restarted = createLiveReviewOpenerPort({
      writeContext: recordContext,
      claudePort: async () => null,
      codexExecutor: async () => {
        restartedCalls += 1;
        return executorReturning("A different nondeterministic retry.");
      },
      readPrompt: async () => "voice",
      store: new PublishCompositionStore(directory),
    });
    await expect(
      restarted({ review: review(root), draft: draft("REQUEST_CHANGES") }),
    ).resolves.toEqual(firstResult);
    expect(restartedCalls).toBe(0);
  });

  it("redrafts when the verdict changes because the evidence identity changes", async () => {
    const root = repoRoot();
    let calls = 0;
    const live = createLiveReviewOpenerPort({
      writeContext: recordContext,
      claudePort: async () => null,
      codexExecutor: async () => async (request) => {
        calls += 1;
        // The seat reads the verdict the way a real one does: from the file the prompt
        // names, resolved against the turn's cwd.
        const facts = JSON.parse(contextFile(root, "opener/review-facts.json")) as {
          verdict: string;
        };
        const verdict = facts.verdict === "APPROVE" ? "approval" : "comment";
        return { output: { opener: `Verdict-specific ${verdict} opener.` }, model: request.model };
      },
      readPrompt: async () => "voice",
      store: tempStore(),
    });
    const comment = await live({ review: review(root), draft: draft("COMMENT") });
    const approval = await live({ review: review(root), draft: draft("APPROVE") });
    expect(calls).toBe(2);
    expect(comment).toMatchObject({ opener: "Verdict-specific comment opener." });
    expect(approval).toMatchObject({ opener: "Verdict-specific approval opener." });
  });

  it("routes a Claude-only machine and records the actual runtime model", async () => {
    const live = createLiveReviewOpenerPort({
      writeContext: recordContext,
      claudePort: async () =>
        harnessClaudePort([
          started("claude-haiku-runtime"),
          completed({ opener: "The reviewed retry path now holds." }),
        ]),
      codexExecutor: async () => null,
      readPrompt: async () => "voice",
      store: tempStore(),
    });
    await expect(live({ review: review(repoRoot()), draft: draft("APPROVE") })).resolves.toEqual({
      status: "drafted",
      opener: "The reviewed retry path now holds.",
      model: "claude-haiku-runtime",
    });
  });

  it("returns honest unavailable and empty-output failures without persisting prose", async () => {
    const unavailable = createLiveReviewOpenerPort({
      writeContext: recordContext,
      claudePort: async () => null,
      codexExecutor: async () => null,
      readPrompt: async () => "voice",
      store: tempStore(),
    });
    await expect(
      unavailable({ review: review(repoRoot()), draft: draft("COMMENT") }),
    ).resolves.toMatchObject({ status: "unavailable" });

    const empty = createLiveReviewOpenerPort({
      writeContext: recordContext,
      claudePort: async () => null,
      codexExecutor: async () => executorReturning("   "),
      readPrompt: async () => "voice",
      store: tempStore(),
    });
    await expect(empty({ review: review(repoRoot()), draft: draft("COMMENT") })).resolves.toEqual({
      status: "failed",
      reason: "the review-opener drafter returned an empty opener",
      retryable: true,
    });
  });

  it("evicts a rejected voice prompt read so the next held-open retry can draft", async () => {
    let promptReads = 0;
    const live = createLiveReviewOpenerPort({
      writeContext: recordContext,
      claudePort: async () => null,
      codexExecutor: async () => executorReturning("The second attempt can draft."),
      readPrompt: async () => {
        promptReads += 1;
        if (promptReads === 1) throw new Error("temporary prompt read failure");
        return "voice";
      },
      store: tempStore(),
    });

    const root = repoRoot();
    await expect(live({ review: review(root), draft: draft("COMMENT") })).resolves.toMatchObject({
      status: "failed",
      retryable: true,
    });
    await expect(live({ review: review(root), draft: draft("COMMENT") })).resolves.toMatchObject({
      status: "drafted",
      opener: "The second attempt can draft.",
    });
    expect(promptReads).toBe(2);
  });
});
