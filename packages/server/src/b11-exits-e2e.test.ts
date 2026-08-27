import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AskLogStore, buildGitHubReviewRequest } from "@rennet/adapters";
import {
  canonicalReviewPayload,
  type ForgePublishPort,
  type ForgeReviewPost,
  foldAsks,
  mechanicalComposition,
  type ReviewCommentInput,
} from "@rennet/core";
import type { ComposedHandoffBundle, HandoffBundle, Review } from "@rennet/protocol";
import { describe, expect, it, vi } from "vitest";
import { createDispatchRuntime, type DispatchDeps } from "./dispatch";
import { askHandlers } from "./dispatch/ask";
import { publishHandlers } from "./dispatch/publish";
import { roundHandlers } from "./dispatch/round";

// ─────────────────────────────────────────────────────────────────────────────
// B11 packet E2E (cluster 6, tasks 6.2/6.3/6.4). Three whole timelines over the
// REAL durable store (`AskLogStore` on a temp dir) and the REAL dispatch handlers
// — every port injected, so the gate makes no live call. Each carries its OWN
// positive control: an assertion that MUST redden if the property regresses.
//
//   (a) Durable asks survive a kill+restart (the one write path is durable).
//   (b) A round work-order dispatched twice fires exactly ONE dispatch.
//   (c) A GitHub review composes + previews WITHOUT posting; the preview bytes ARE
//       the compose bytes.
// ─────────────────────────────────────────────────────────────────────────────

const SID = "review-1";

// ── (a) Durable asks survive reload ──────────────────────────────────────────

describe("B11 E2E (a) — durable asks survive a kill + restart (6.2)", () => {
  it("stages every ask kind, kills the host, and reloads the projection intact", async () => {
    const dir = mkdtempSync(join(tmpdir(), "b11-e2e-reload-"));
    // HOST 1 boots over the temp dir and stages the full spread through the REAL handlers
    // (the sole write path), not raw appends.
    const store1 = new AskLogStore(dir);
    const h1 = askHandlers(createDispatchRuntime({ askLog: store1 } as unknown as DispatchDeps));
    await h1["ask.stage"]({
      sessionId: SID,
      ask: { id: "a1", anchor: "src/x.ts:10", type: "request-change", body: "rename the export" },
    });
    await h1["ask.setLineComment"]({ sessionId: SID, path: "src/x.ts", line: 20, body: "nit" });
    await h1["ask.quoteOpen"]({
      sessionId: SID,
      threadId: "t1",
      thread: { anchor: "This reads well.", messages: [{ author: "user", text: "why here?" }] },
    });
    await h1["ask.setVerdictOverride"]({ sessionId: SID, verdict: "REQUEST_CHANGES" });
    const before = store1.readProjection(SID);

    // KILL + RESTART: a brand-new store over the SAME dir — nothing carried in memory, the
    // on-disk log is the only survivor. The reloaded projection equals the pre-kill one …
    const store2 = new AskLogStore(dir);
    expect(store2.readProjection(SID)).toEqual(before);
    // … and is non-vacuous — every collection rehydrated (not an empty projection that
    // "equals" a same-empty one).
    expect(before.stagedAsks.a1?.body).toBe("rename the export");
    expect(before.lineComments["src/x.ts"]?.["20"]).toBe("nit");
    expect(before.quoteThreads.t1?.messages).toHaveLength(1);
    expect(before.verdictOverride).toBe("REQUEST_CHANGES");

    // POSITIVE CONTROL: had the restart lost even ONE event, the folded projection would
    // NOT equal the intact one — so the equality above has teeth (it is not a tautology
    // over a fold that ignores the log).
    const droppedOneEvent = foldAsks(store2.read(SID).slice(0, -1));
    expect(droppedOneEvent).not.toEqual(before);
  });
});

// ── (b) Round dispatched twice → one dispatch ────────────────────────────────

const ROUND_REVIEW = {
  id: SID,
  repositoryRoot: "/repo",
  activePatchsetId: "ps-1",
  patchsets: [{ id: "ps-1", createdAt: "", truncated: false, files: [] }],
  dispositions: [],
  status: "current",
} as unknown as Review;

describe("B11 E2E (b) — dispatch a round work-order twice → exactly one dispatch (6.3)", () => {
  it("coalesces the identical re-dispatch, and re-fires only when the asks actually change", async () => {
    const dir = mkdtempSync(join(tmpdir(), "b11-e2e-round-"));
    const store = new AskLogStore(dir);
    const dispatchRound = vi.fn(() => Promise.resolve());
    const rt = createDispatchRuntime({
      askLog: store,
      service: { reviewById: (id: string) => (id === SID ? ROUND_REVIEW : undefined) },
      dispatchRound,
    } as unknown as DispatchDeps);
    const askH = askHandlers(rt);
    const dispatch = roundHandlers(rt)["round.dispatch"];

    // Stage one addressed ask, then dispatch the SAME asks twice.
    await askH["ask.stage"]({
      sessionId: SID,
      ask: { id: "a1", anchor: "src/x.ts:1", type: "request-change", body: "fix" },
    });
    await dispatch({ reviewId: SID });
    await dispatch({ reviewId: SID });

    // Exactly ONE kick for the identical work-order (idempotent by review + work-order digest).
    expect(dispatchRound).toHaveBeenCalledTimes(1);

    // POSITIVE CONTROL: coalescing is content-addressed, not a blind one-shot. Staging a NEW
    // ask changes the work-order digest, so a third dispatch DOES fire a second time — proving
    // the guard would let a genuinely-different round through (the assertion above is not
    // vacuously "always one").
    await askH["ask.stage"]({
      sessionId: SID,
      ask: { id: "a2", anchor: "src/y.ts:2", type: "request-change", body: "also fix" },
    });
    await dispatch({ reviewId: SID });
    expect(dispatchRound).toHaveBeenCalledTimes(2);
  });

  // ── (b') Coalescing survives a NONDETERMINISTIC composer (finding 3 / finding 10b) ──
  // The reproduced race: the live composer folds MODEL-authored titles/order into the
  // work-order digest, so it differs run-to-run. Keying idempotency on THAT digest let a
  // double-dispatch slip two real coding-agent runs through. This injects a composer whose
  // output digest is random every call, and proves the deterministic INPUT-digest key still
  // coalesces two identical dispatches to ONE compose + ONE kick.
  it("coalesces two identical dispatches to one, even with a nondeterministic live composer", async () => {
    const dir = mkdtempSync(join(tmpdir(), "b11-e2e-round-nd-"));
    const store = new AskLogStore(dir);
    const dispatchRound = vi.fn(() => Promise.resolve());
    // A live composer that returns the SAME asks but a RANDOM title + digest each call, so the
    // composed work-order digest is nondeterministic (exactly the model-authored composition).
    const composeBundle = vi.fn(async ({ bundle }: { bundle: HandoffBundle }) => {
      const floor = mechanicalComposition(bundle);
      const nonce = randomUUID();
      return {
        ...floor,
        tasks: floor.tasks.map((t) => ({ ...t, title: `group ${nonce}` })),
        digest: `nondeterministic-${nonce}`,
      } as ComposedHandoffBundle;
    });
    const rt = createDispatchRuntime({
      askLog: store,
      service: { reviewById: (id: string) => (id === SID ? ROUND_REVIEW : undefined) },
      dispatchRound,
      composeBundle,
    } as unknown as DispatchDeps);
    const askH = askHandlers(rt);
    const dispatch = roundHandlers(rt)["round.dispatch"];

    await askH["ask.stage"]({
      sessionId: SID,
      ask: { id: "a1", anchor: "src/x.ts:1", type: "request-change", body: "fix" },
    });
    // Fire two identical dispatches concurrently (a double-click / reconnect / retry).
    await Promise.all([dispatch({ reviewId: SID }), dispatch({ reviewId: SID })]);

    // The composer ran ONCE (coalescing is BEFORE composition) and the kick fired ONCE — the
    // nondeterministic composed digest never got a chance to fork the key.
    expect(composeBundle).toHaveBeenCalledTimes(1);
    expect(dispatchRound).toHaveBeenCalledTimes(1);
  });
});

// ── (c) Compose + preview a GitHub review, no post ───────────────────────────

const POST_TARGET = {
  repo: { forge: "github", owner: "rbutera", name: "rennet-egress-sandbox" },
  number: 1,
  forgeRef: "PR_kwSANDBOX1",
  headOid: "deadbeefcafe0001",
};

const REVIEW_WITH_PR = {
  id: SID,
  repositoryRoot: "/repo",
  activePatchsetId: "ps-1",
  retrospective: false,
  postTarget: POST_TARGET,
  patchsets: [{ id: "ps-1", createdAt: "", truncated: false, files: [] }],
  dispositions: [],
  status: "current",
} as unknown as Review;

/** A publish port that RECORDS real posts, so the E2E can assert nothing egressed. */
function recordingPublishPort(): ForgePublishPort & { posts: ForgeReviewPost[] } {
  const posts: ForgeReviewPost[] = [];
  return {
    posts,
    capabilities: {
      supportsThreadResolution: true,
      supportsBatchedReview: true,
      supportsMultiLineAnchors: true,
      supportsFileLevelThreads: true,
    },
    buildReviewRequest: (post) => buildGitHubReviewRequest(post),
    findExistingReview: () => Promise.resolve(null),
    publishReview: (post) => {
      posts.push(post);
      return Promise.resolve({ reviewRef: "PRR_test", url: "https://x/1", reused: false });
    },
  };
}

type ComposeReview = {
  status: "review";
  comments: ReviewCommentInput[];
  payload: string;
  verdict: string;
  compositionId: string;
};
type DryRun = { dryRun: boolean; outcome: unknown };

describe("B11 E2E (c) — compose + preview a GitHub review draft, nothing posts (6.4)", () => {
  it("previews the composed bytes without egress; a mutated payload fails the exact-preview", async () => {
    const dir = mkdtempSync(join(tmpdir(), "b11-e2e-compose-"));
    const store = new AskLogStore(dir);
    const publishPort = recordingPublishPort();
    const rt = createDispatchRuntime({
      askLog: store,
      service: { reviewById: (id: string) => (id === SID ? REVIEW_WITH_PR : undefined) },
      publishPort,
      raiseAttention: () => "att-1",
    } as unknown as DispatchDeps);
    const askH = askHandlers(rt);
    const publish = publishHandlers(rt);

    // Stage a code-anchored ask + a bare line comment — the two-strata line comments.
    await askH["ask.stage"]({
      sessionId: SID,
      ask: { id: "a1", anchor: "src/x.ts:10", type: "request-change", body: "rename the export" },
    });
    await askH["ask.setLineComment"]({ sessionId: SID, path: "src/a.ts", line: 3, body: "typo" });

    // Compose the review from the durable projection.
    const composed = (await publish["publish.compose"]({
      commandId: randomUUID(),
      reviewId: SID,
      mode: "review",
    })) as ComposeReview;
    expect(composed.status).toBe("review");
    expect(composed.comments.length).toBeGreaterThan(0);
    // The compose payload IS the canonical bytes of its own comments (the single source).
    expect(canonicalReviewPayload(composed.comments)).toBe(composed.payload);

    // Preview (dryRun defaults TRUE): builds the exact request, posts NOTHING.
    const dry = (await publish["publish.review"]({
      commandId: randomUUID(),
      reviewId: SID,
      target: POST_TARGET,
      comments: composed.comments,
      payload: composed.payload,
      verdict: composed.verdict,
      compositionId: composed.compositionId,
    })) as DryRun;
    expect(dry.dryRun).toBe(true);
    expect(dry.outcome).toBeNull();
    // NOTHING left the machine — the recording port saw zero real posts.
    expect(publishPort.posts).toHaveLength(0);

    // POSITIVE CONTROL: a mutated payload no longer re-derives from the comments, so the
    // exact-preview ("what you see is what leaves") fails CLOSED — even on dry-run.
    await expect(
      publish["publish.review"]({
        commandId: randomUUID(),
        reviewId: SID,
        target: POST_TARGET,
        comments: composed.comments,
        payload: `${composed.payload} tampered`,
        verdict: composed.verdict,
      }),
    ).rejects.toThrow(/does not match/);
    expect(publishPort.posts).toHaveLength(0);
  });
});
