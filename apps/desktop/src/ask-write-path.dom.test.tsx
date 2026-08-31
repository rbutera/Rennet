// @vitest-environment happy-dom
//
// The reviewer's work reaches the daemon — the three exits, driven from a REAL surface
// against the REAL command router.
//
// The defect this pins: eleven `ask.*` handlers, the projection, the fold and the durable
// log all existed and were tested, and NOTHING in the client called any of them but
// `ask.setVerdictOverride`. The reviewer's asks lived in the renderer's `review` store slice
// and nowhere else, so every exit that reads `askLog.readProjection(reviewId)` — which is all
// three of them, and nothing else — read an EMPTY log:
//
//   • `publish.compose(mode:"review")` could not carry the reviewer's staged line comment into
//     the exact post descriptor. The team-reviewer Post exit silently lost the requested change.
//   • `round.dispatch` folded an empty projection into an empty work order and dispatched
//     nothing.
//   • `review.reviseSpan` answered "That ask is no longer staged." for every ask.
//   • And a reload lost the lot.
//
// Every test below drives the SAME `<CodeBlock>` the review surface renders, clicks its real
// "Request Changes" affordance, and then asks the daemon what it has. The harm is asserted
// FIRST in each case — the exit's broken answer on an empty log — and then again after the
// click, so each test carries its own positive control: the before-assertion is the exact
// failure this change fixes, and it would still hold after the click if the write path
// regressed. No assertion here is satisfied by "a mutation fired".
//
// This file lives in apps/desktop because that is the only layer permitted to import both
// @rennet/server and @rennet/app-ui (the dependency arrows forbid the two reals meeting
// anywhere else) — the same reason `ws-contract.test.ts` lives here. Nothing is stubbed on
// the path under test: the dispatch is `createDispatch`, the log is the file-backed
// `AskLogStore`, the fold and the composers are core's. Only the ports OUTSIDE the path (the
// review store, the publish port, the round kick, the rework turn) are injected, so the gate
// makes no live call and nothing egresses.
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AskLogStore, buildGitHubReviewRequest } from "@rennet/adapters";
import { BridgeProvider, CodeBlock, HandoffView, useAskLog, useRennetStore } from "@rennet/app-ui";
import type { ForgePublishPort, ForgeReviewPost } from "@rennet/core";
import type { CommandName, CommandOutput, RennetBridge, Review } from "@rennet/protocol";
import { createDispatch, type DispatchDeps } from "@rennet/server";
import { cleanup, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// happy-dom reports a Linux-like platform; the review surfaces are written for the desktop
// app's primary platform and user-event's chords follow it.
Object.defineProperty(globalThis.navigator, "platform", {
  configurable: true,
  value: "MacIntel",
});

const PATH = "packages/core/src/x.ts";
const CODE = "const a = 1\nconst b = 2\nconst c = 3";
const ASK_BODY = "rename the export";
const ASK_ID = `${PATH}:2:RIGHT`;

/** The teammate PR the Post exit posts to — the one exit that needs a real post target. */
const POST_TARGET = {
  repo: { forge: "github", owner: "rbutera", name: "rennet-egress-sandbox" },
  number: 1,
  forgeRef: "PR_kwSANDBOX1",
  headOid: "deadbeefcafe0001",
};

const patchsets = [{ id: "ps-1", createdAt: "", truncated: false, files: [] }];

/** A teammate's pull request: the Post-review exit's mode. */
const PR_REVIEW = {
  id: "review-pr",
  repositoryRoot: "/repo",
  activePatchsetId: "ps-1",
  retrospective: false,
  postTarget: POST_TARGET,
  patchsets,
  dispositions: [],
  status: "current",
} as unknown as Review;

/** The reviewer's own branch: the round exit's mode (a work order, not a post). */
const OWN_REVIEW = {
  id: "review-own",
  repositoryRoot: "/repo",
  activePatchsetId: "ps-1",
  retrospective: false,
  patchsets,
  dispositions: [],
  status: "current",
} as unknown as Review;

const REVIEWS = [PR_REVIEW, OWN_REVIEW];

/** A publish port that RECORDS real posts, so a test can assert nothing egressed. */
function recordingPublishPort(): ForgePublishPort & { posts: ForgeReviewPost[] } {
  const posts: ForgeReviewPost[] = [];
  return {
    posts,
    capabilities: {
      supportsThreadResolution: true,
      supportsBatchedReview: true,
      supportsMultiLineAnchors: true,
      supportsFileLevelThreads: true,
      requiresReviewVerdictInBody: false,
    },
    buildReviewRequest: (post) => buildGitHubReviewRequest(post),
    findExistingReview: () => Promise.resolve(null),
    publishReview: (post) => {
      posts.push(post);
      return Promise.resolve({ reviewRef: "PRR_test", url: "https://x/1", reused: false });
    },
  };
}

const dirs: string[] = [];
let dispatch: (name: CommandName, input: unknown) => Promise<unknown>;
let publishPort: ReturnType<typeof recordingPublishPort>;
let dispatchRound: ReturnType<typeof vi.fn>;

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "rennet-ask-write-"));
  dirs.push(dir);
  publishPort = recordingPublishPort();
  dispatchRound = vi.fn(() => Promise.resolve());
  dispatch = createDispatch({
    askLog: new AskLogStore(dir),
    service: { reviewById: (id: string) => REVIEWS.find((r) => r.id === id) },
    publishPortFor: (repository: Parameters<DispatchDeps["publishPortFor"]>[0]) =>
      repository.forge === "github" ? publishPort : undefined,
    raiseAttention: () => "att-1",
    dispatchRound,
    draftReviewOpener: () =>
      Promise.resolve({
        status: "drafted",
        opener: "This review is grounded in the active patchset and its staged asks.",
        model: "test-model",
      }),
    // The rework's one-shot turn, stubbed at the model boundary only — everything between
    // the command and the durable `ask.edit` it lands is the real thing.
    reworkSpan: () => Promise.resolve({ status: "refined", refined: "renameExport", model: "t" }),
  } as unknown as DispatchDeps) as unknown as typeof dispatch;
  // A fresh renderer starts with a clean slice; the durable log is what carries anything over.
  useRennetStore.getState().reviewActions.resetReview();
});

afterEach(() => {
  cleanup();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** The bridge the surfaces write through: every invoke lands on the real command router. */
function bridge(): RennetBridge {
  return {
    invoke: (name: CommandName, input: unknown) => dispatch(name, input),
  } as unknown as RennetBridge;
}

/** The review surface, bound to its durable ask log exactly as `ReviewWorkspace` binds it. */
function ReviewSurface({ reviewId }: { readonly reviewId: string }) {
  useAskLog(reviewId);
  return <CodeBlock code={CODE} path={PATH} startLine={1} />;
}

function EditableReviewSurface({ review }: { readonly review: Review }) {
  useAskLog(review.id);
  return <HandoffView review={review} />;
}

function mountSurface(reviewId: string) {
  const view = render(
    <BridgeProvider bridge={bridge()}>
      <ReviewSurface reviewId={reviewId} />
    </BridgeProvider>,
  );
  return { ...view, user: userEvent.setup() };
}

function mountEditableSurface(review: Review) {
  const view = render(
    <BridgeProvider bridge={bridge()}>
      <EditableReviewSurface review={review} />
    </BridgeProvider>,
  );
  return { ...view, user: userEvent.setup() };
}

async function stageEditableAsk(review: Review, body: string) {
  await dispatch("ask.stage", {
    sessionId: review.id,
    ask: {
      id: ASK_ID,
      anchor: `${PATH}:2`,
      type: "request-change",
      body,
      side: "RIGHT",
    },
  });
}

async function saveEditedAsk(review: Review, original: string, edited: string) {
  const view = mountEditableSurface(review);
  expect(await view.findByText(original)).toBeTruthy();
  await view.user.click(view.getByRole("button", { name: /Edit/ }));
  const editor = view.getByRole("textbox");
  await view.user.clear(editor);
  await view.user.type(editor, edited);
  await view.user.click(view.getByRole("button", { name: "Save" }));

  await vi.waitFor(async () => {
    const read = (await dispatch("ask.read", { sessionId: review.id })) as {
      projection: { stagedAsks: Record<string, { body: string }> };
    };
    expect(read.projection.stagedAsks[ASK_ID]?.body).toBe(edited);
  });
  return view;
}

/** Drive the real affordance: comment on line 2 and request changes there. */
async function requestChangesOnLine2(view: ReturnType<typeof mountSurface>, reviewId: string) {
  await view.user.click(view.getByLabelText("Comment on line 2"));
  await view.user.type(view.getByPlaceholderText("Leave a comment on this line…"), ASK_BODY);
  await view.user.click(view.getByText("Request Changes"));
  // The write is fire-and-forget from the click handler; wait for the DAEMON to hold it.
  const sessionId = reviewId;
  await vi.waitFor(async () => {
    const read = (await dispatch("ask.read", { sessionId })) as {
      projection: { stagedAsks: Record<string, unknown> };
    };
    expect(Object.keys(read.projection.stagedAsks)).toHaveLength(1);
  });
}

type Composed = Extract<CommandOutput<"publish.compose">, { status: "review" }>;

describe("harm 1 — the Post exit composes the reviewer's exact outbound artifact", () => {
  it("keeps a grounded zero-ask approval valid, then carries the staged requested change", async () => {
    const reviewId = PR_REVIEW.id;

    // A zero-ask review is still a real authored review: its grounded opener proposes approval.
    const empty = (await dispatch("publish.compose", {
      commandId: randomUUID(),
      reviewId,
      mode: "review",
    })) as Composed;
    expect(empty.status).toBe("review");
    expect(empty.artifact.comments).toEqual([]);
    expect(empty.artifact.bodyNotes).toEqual([]);
    expect(empty.post.event).toBe("APPROVE");
    await expect(
      dispatch("publish.review", {
        commandId: randomUUID(),
        reviewId,
        artifact: empty.artifact,
        post: empty.post,
        payload: empty.payload,
        compositionId: empty.compositionId,
      }),
    ).resolves.toMatchObject({ dryRun: true });

    // The reviewer requests changes on line 2 of the real code surface.
    const view = mountSurface(reviewId);
    await requestChangesOnLine2(view, reviewId);

    // The compose now carries what they wrote, on the line they wrote it on.
    const composed = (await dispatch("publish.compose", {
      commandId: randomUUID(),
      reviewId,
      mode: "review",
    })) as Composed;
    expect(composed.artifact.comments).toEqual([
      { path: PATH, line: 2, side: "RIGHT", type: "request-change", body: ASK_BODY },
    ]);
    expect(composed.post.event).toBe("REQUEST_CHANGES");

    // And the exit completes: the preview builds the exact outbound request rather than
    // refusing. `dryRun` defaults true, so nothing leaves the machine.
    const preview = (await dispatch("publish.review", {
      commandId: randomUUID(),
      reviewId,
      artifact: composed.artifact,
      post: composed.post,
      payload: composed.payload,
      compositionId: composed.compositionId,
    })) as { dryRun: boolean; request: { requests: { body: unknown }[] } };
    expect(preview.dryRun).toBe(true);
    expect(JSON.stringify(preview.request)).toContain(ASK_BODY);
    expect(publishPort.posts).toHaveLength(0);
  });
});

describe("harm 2 — a dispatched round carries the reviewer's asks", () => {
  it("goes from an empty, undispatched work order to one that names what was asked", async () => {
    const reviewId = OWN_REVIEW.id;

    // THE HARM: nothing addressed, so the round refuses to dispatch and no worker is kicked.
    const before = (await dispatch("round.dispatch", { reviewId })) as {
      dispatched: boolean;
      workOrder: { tasks?: unknown[]; body?: string };
    };
    expect(before.dispatched).toBe(false);
    expect(dispatchRound).not.toHaveBeenCalled();

    const view = mountSurface(reviewId);
    await requestChangesOnLine2(view, reviewId);

    // The same command now composes a real work order and kicks the round once.
    const after = (await dispatch("round.dispatch", { reviewId })) as {
      dispatched: boolean;
      workOrder: unknown;
    };
    expect(after.dispatched).toBe(true);
    // The reviewer's own words are IN the order the coding agent receives — not merely a
    // non-empty order, and not a count.
    expect(JSON.stringify(after.workOrder)).toContain(ASK_BODY);
    expect(dispatchRound).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(dispatchRound.mock.calls[0])).toContain(ASK_BODY);
  });
});

describe("harm 4 — Save Edit changes the canonical outbound draft", () => {
  const original = "rename the export";
  const edited = "rename the export and preserve the public alias";

  it("persists the edit and feeds the exact bytes into teammate preview and post", async () => {
    await stageEditableAsk(PR_REVIEW, original);
    const before = (await dispatch("publish.compose", {
      commandId: randomUUID(),
      reviewId: PR_REVIEW.id,
      mode: "review",
    })) as Composed;
    expect(before.artifact.comments[0]?.body).toBe(original);
    expect(before.artifact.comments[0]?.body).not.toBe(edited);

    const view = await saveEditedAsk(PR_REVIEW, original, edited);
    expect(view.getByText(edited)).toBeTruthy();
    expect(view.queryByText(original)).toBeNull();

    const composed = (await dispatch("publish.compose", {
      commandId: randomUUID(),
      reviewId: PR_REVIEW.id,
      mode: "review",
    })) as Composed;
    expect(composed.artifact.comments[0]?.body).toBe(edited);
    expect(composed.artifact.comments[0]?.body).not.toBe(original);
    const expectedThread = `**Requested change** — ${edited}`;
    expect(composed.post.threads[0]?.body).toBe(expectedThread);
    expect(composed.post.threads[0]?.body).not.toBe(original);

    const preview = (await dispatch("publish.review", {
      commandId: randomUUID(),
      reviewId: PR_REVIEW.id,
      artifact: composed.artifact,
      post: composed.post,
      payload: composed.payload,
      compositionId: composed.compositionId,
    })) as { dryRun: boolean; request: unknown };
    expect(preview.dryRun).toBe(true);
    expect(JSON.stringify(preview.request)).toContain(expectedThread);
    expect(publishPort.posts).toHaveLength(0);

    view.unmount();
    useRennetStore.getState().reviewActions.resetReview();
    expect(useRennetStore.getState().review.stagedAsks).toEqual({});
    const reloaded = mountEditableSurface(PR_REVIEW);
    expect(await reloaded.findByText(edited)).toBeTruthy();
    expect(reloaded.queryByText(original)).toBeNull();
  });

  it("feeds the exact edited bytes into the local-agent work order", async () => {
    await stageEditableAsk(OWN_REVIEW, original);
    await saveEditedAsk(OWN_REVIEW, original, edited);

    const result = (await dispatch("round.dispatch", { reviewId: OWN_REVIEW.id })) as {
      dispatched: boolean;
      workOrder: { tasks: readonly { asks: readonly { instruction: string }[] }[] };
    };
    expect(result.dispatched).toBe(true);
    const instructions = result.workOrder.tasks.flatMap((task) =>
      task.asks.map((ask) => ask.instruction),
    );
    expect(instructions).toEqual([edited]);
    expect(instructions).not.toContain(original);
    const dispatched = dispatchRound.mock.calls[0]?.[0] as {
      workOrder: { tasks: readonly { asks: readonly { instruction: string }[] }[] };
    };
    expect(
      dispatched.workOrder.tasks.flatMap((task) => task.asks.map((ask) => ask.instruction)),
    ).toEqual([edited]);
  });
});

describe("harm 3 — a staged ask is revisable", () => {
  it("goes from 'That ask is no longer staged.' to a rework that lands on the durable ask", async () => {
    const reviewId = OWN_REVIEW.id;
    const askId = ASK_ID;

    // THE HARM: the ask the reviewer is looking at does not exist as far as the daemon knows.
    const before = (await dispatch("review.reviseSpan", {
      commandId: randomUUID(),
      reviewId,
      askId,
      span: "export",
      instruction: "name the export",
    })) as { status: string; reason?: string };
    expect(before).toEqual({ status: "unavailable", reason: "That ask is no longer staged." });

    const view = mountSurface(reviewId);
    await requestChangesOnLine2(view, reviewId);

    const after = (await dispatch("review.reviseSpan", {
      commandId: randomUUID(),
      reviewId,
      askId,
      span: "export",
      instruction: "name the export",
    })) as { status: string; reworkedBody?: string };
    expect(after.status).toBe("reworked");
    expect(after.reworkedBody).toBe("rename the renameExport");
    // The rework wrote through the same one write path, so the durable ask carries it.
    const read = (await dispatch("ask.read", { sessionId: reviewId })) as {
      projection: { stagedAsks: Record<string, { body: string }> };
    };
    expect(read.projection.stagedAsks[askId]?.body).toBe("rename the renameExport");
  });
});

describe("a reload keeps the reviewer's work", () => {
  it("re-renders the comment the reviewer left, from the daemon, after the renderer is thrown away", async () => {
    const reviewId = OWN_REVIEW.id;
    const first = mountSurface(reviewId);
    await requestChangesOnLine2(first, reviewId);
    expect(first.getByLabelText("Edit comment on line 2")).toBeTruthy();

    // RELOAD: the renderer goes away and its store comes back clean, which is exactly what a
    // fresh `createRennetStore()` gives a reloaded window. Asserted, not assumed — this is the
    // control that makes the remount below non-vacuous.
    first.unmount();
    useRennetStore.getState().reviewActions.resetReview();
    expect(useRennetStore.getState().review.stagedAsks).toEqual({});
    expect(useRennetStore.getState().review.codeComments).toEqual({});

    const second = mountSurface(reviewId);
    // The surface rehydrates from `ask.read`: the line reads as commented again, and the
    // staged ask is back in the slice with the body the reviewer typed.
    await vi.waitFor(() => expect(second.getByLabelText("Edit comment on line 2")).toBeTruthy());
    expect(useRennetStore.getState().review.stagedAsks[ASK_ID]).toMatchObject({
      anchor: `${PATH}:2`,
      type: "request-change",
      body: ASK_BODY,
    });
    expect(useRennetStore.getState().review.codeComments[PATH]?.[2]).toBe(ASK_BODY);
  });
});
