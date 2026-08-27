import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AskLogStore } from "@rennet/adapters";
import {
  canonicalPrSubmissionPayload,
  type ForgePrSubmission,
  type ForgePrSubmissionOutcome,
} from "@rennet/core";
import type { Review } from "@rennet/protocol";
import { describe, expect, it, vi } from "vitest";
import { createDispatchRuntime, type DispatchDeps } from "./dispatch";
import { publishHandlers } from "./dispatch/publish";

// B11 cluster 5 (task 5.3) — PR-lane ripening. As each round lands, the own-branch PR
// draft re-composes (`publish.compose(mode:"pr")`) and re-raises publish-ready IDEMPOTENTLY
// (by derived id). `publish.submitPr`'s push+open-PR is unchanged and idempotent by head.

const REVIEW_ID = "review-1";
const OWN_BRANCH_REVIEW = {
  id: REVIEW_ID,
  repositoryRoot: "/repo",
  activePatchsetId: "ps-1",
  retrospective: false,
  // No postTarget ⇒ own-branch: it opens its OWN PR (mode "pr"), the ripening lane.
  patchsets: [
    {
      id: "ps-1",
      createdAt: "",
      truncated: false,
      files: [],
      repository: { root: "/repo", headRef: "feat/x", baseRef: "main" },
    },
  ],
  dispositions: [],
  status: "current",
} as unknown as Review;

function harness(extra: Partial<DispatchDeps> = {}) {
  const store = new AskLogStore(mkdtempSync(join(tmpdir(), "rennet-pr-ripening-")));
  const raiseAttention = vi.fn((_event: { family: string }) => "att-1" as string | undefined);
  const rt = createDispatchRuntime({
    askLog: store,
    allowedRoots: new Set(["/repo"]),
    service: { reviewById: (id: string) => (id === REVIEW_ID ? OWN_BRANCH_REVIEW : undefined) },
    raiseAttention,
    ...extra,
  } as unknown as DispatchDeps);
  return { store, raiseAttention, handlers: publishHandlers(rt) };
}

type ComposePr = {
  status: "pr";
  submission: ForgePrSubmission;
  payload: string;
  compositionId: string;
};

describe("PR-lane ripening (B11 5.2) — re-compose + re-raise publish-ready idempotently", () => {
  it("a re-compose of an own-branch review re-raises publish-ready with a STABLE derived id", async () => {
    const { raiseAttention, handlers } = harness();
    const compose = handlers["publish.compose"];

    const first = (await compose({
      commandId: randomUUID(),
      reviewId: REVIEW_ID,
      mode: "pr",
    })) as ComposePr;
    const second = (await compose({
      commandId: randomUUID(),
      reviewId: REVIEW_ID,
      mode: "pr",
    })) as ComposePr;

    // The derived composition id is stable across re-composes — the "idempotent by derived id"
    // property the ripening relies on (an unchanged draft re-raises the SAME publish-ready).
    expect(first.status).toBe("pr");
    expect(second.compositionId).toBe(first.compositionId);

    // Publish-ready was raised on BOTH composes with a byte-identical event, so an
    // idempotent-by-id attention sink coalesces them to one item (positive control below).
    const publishReadyEvents = raiseAttention.mock.calls
      .map(([e]) => e)
      .filter((e) => e.family === "publish-ready");
    expect(publishReadyEvents).toHaveLength(2);
    expect(publishReadyEvents[0]).toEqual(publishReadyEvents[1]);
  });

  it("submitPr opens ONE PR for a head and reuses it on re-submit (idempotent by head)", async () => {
    // A submit port modelling the real idempotency: the first open for a head creates the PR;
    // a second submit of the SAME head reuses it (reused: true), never a second PR.
    const openByHead = new Map<string, ForgePrSubmissionOutcome>();
    const submitPullRequest = vi.fn(async ({ headRef }: { headRef: string }) => {
      const existing = openByHead.get(headRef);
      if (existing) return { ...existing, reused: true };
      const opened = { url: `https://pr/${headRef}`, number: 42, reused: false } as const;
      openByHead.set(headRef, opened);
      return opened;
    });
    const { handlers } = harness({ submitPullRequest });
    const submitPr = handlers["publish.submitPr"];

    const submission: ForgePrSubmission = {
      title: "feat/x",
      body: "",
      base: "main",
      head: "feat/x",
      draft: true,
    };
    const payload = canonicalPrSubmissionPayload(submission);

    const first = (await submitPr({
      commandId: randomUUID(),
      reviewId: REVIEW_ID,
      submission,
      payload,
    })) as ForgePrSubmissionOutcome;
    const second = (await submitPr({
      commandId: randomUUID(),
      reviewId: REVIEW_ID,
      submission,
      payload,
    })) as ForgePrSubmissionOutcome;

    // Exactly one PR: the first opened it, the second reused it (same url + number).
    expect(first.reused).toBe(false);
    expect(second.reused).toBe(true);
    expect(second.url).toBe(first.url);
    expect(second.number).toBe(first.number);
    expect(openByHead.size).toBe(1);
  });
});
