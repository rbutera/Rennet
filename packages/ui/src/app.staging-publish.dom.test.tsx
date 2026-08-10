// @vitest-environment happy-dom
//
// The STAGING CHOICE controls the PUBLISH PAYLOAD (issue #109). This mounts the
// whole `RennetApp` over a recording `RennetBridge`, walks a real disposition from
// the Files view into the collation draft, retypes/stages it through the draft
// canvas UI, signs the paper, and asserts EXACTLY what reaches (or never reaches)
// the `publish.review` engine.
//
// Before the fix, `app.tsx` built the paper AND the publish call from the FULL
// draft, so the ink/blue staging choice was cosmetic: an unstaged comment/question
// still entered the payload, and an approve-only draft ran an APPROVE dry run while
// the chrome said "Nothing to publish". The fix derives ONE `inkDraft =
// publishedItems(draft)` and routes both surfaces through it.
//
// These assertions are the CONTRACT — what the human staged == what publishes — read
// off the recorded engine input and the visible chrome, never off the new
// implementation. They also resolve the report's named contradiction: `staging.test.ts`
// says an unstaged default comment is blue/local, and the "unstaged comment stays
// local" case below now AGREES (it never reaches publish.review).
import type { CommandInput, CommandOutput, RennetBridge } from "@rennet/protocol";
import type { Review } from "@rennet/types";
import { describe, expect, it } from "vitest";
import { RennetApp } from "./app";
import { fireEvent, mount, waitFor } from "./test/dom";

// One ready review with a single changed, not-yet-disposed file — the simplest
// staging path: "Mark read" stages a neutral `comment` into the draft synchronously.
const review: Review = {
  id: "review",
  repositoryRoot: "/code/rennet",
  activePatchsetId: "patch-one",
  dispositions: [],
  status: "current",
  patchsets: [
    {
      id: "patch-one",
      createdAt: "2026-08-08T00:00:00.000Z",
      repository: {
        id: "repository",
        root: "/code/rennet",
        commonDir: "/code/rennet/.git",
        baseRef: "main",
        baseOid: "1111111111111111",
        headOid: "2222222222222222",
      },
      files: [
        {
          path: "src/x.ts",
          status: "modified",
          additions: 1,
          deletions: 0,
          binary: false,
          patch: "+const reviewed = true;",
        },
      ],
      rawDiff: "+const reviewed = true;",
      byteLength: 24,
      truncated: false,
    },
  ],
};

// A recording fake bridge: everything resolves the ready review; `publish.review`
// records its input and returns a well-formed dry-run output (nothing posted). The
// ONLY thing that ever pushes a call is a real sign of a non-empty ink subset.
function recordingBridge(ready: Review): {
  bridge: RennetBridge;
  calls: CommandInput<"publish.review">[];
} {
  const calls: CommandInput<"publish.review">[] = [];
  const invoke = async (name: string, input: unknown): Promise<unknown> => {
    if (name === "publish.review") {
      calls.push(input as CommandInput<"publish.review">);
      const output: CommandOutput<"publish.review"> = {
        dryRun: true,
        request: {
          endpoint: "https://api.github.com/graphql",
          method: "POST",
          body: { query: "mutation {}", variables: {} },
        },
        marker: "a".repeat(64),
        ledger: [],
        outcome: null,
      };
      return output;
    }
    return { review: ready };
  };
  return { bridge: { invoke: invoke as unknown as RennetBridge["invoke"] }, calls };
}

// Mount, mark the one file read (→ a `comment` in the draft), select the
// destination framing, and open the draft canvas so a single item is present and
// editable. Returns the RTL handle + the recorded publish calls.
//
// The mode is EXPLICIT (issue #109, own-branch half): `publish.review` is the
// OTHER-PR act, so the publish-payload assertions run in `other-pr`; `own-branch`
// previews a PR submission whose creation is the gated #21 act and never calls
// publish.review, and has its own tests below.
async function reachDraftCanvas(
  mode: "own-branch" | "other-pr" = "other-pr",
): Promise<ReturnType<typeof mount> & { calls: CommandInput<"publish.review">[] }> {
  const { bridge, calls } = recordingBridge(review);
  const handle = mount(<RennetApp bridge={bridge} />);
  const { container, getByRole } = handle;
  await waitFor(() => expect(container.querySelector(".destination-frame")).not.toBeNull());
  fireEvent.click(getByRole("tab", { name: "Files" }));
  fireEvent.click(getByRole("button", { name: "Mark read" }));
  await waitFor(() =>
    expect(container.querySelector(".destination-frame")?.getAttribute("data-staged-count")).toBe(
      "1",
    ),
  );
  // Select the destination framing (own-branch "Handoff bundle" / other-pr "Review
  // to post"); the collated data is identical, only the outbound act differs.
  fireEvent.click(
    getByRole("tab", { name: mode === "other-pr" ? "Review to post" : "Handoff bundle" }),
  );
  await waitFor(() =>
    expect(container.querySelector(".destination-frame")?.getAttribute("data-mode")).toBe(mode),
  );
  const openDraft = container.querySelector<HTMLButtonElement>(".destination-open-draft");
  if (!openDraft) throw new Error("the open-draft control did not render");
  fireEvent.click(openDraft);
  await waitFor(() => expect(container.querySelector(".collation-canvas")).not.toBeNull());
  return { ...handle, calls };
}

/** Retype the single draft item via the visible type <select>. */
function retype(
  container: HTMLElement,
  type: "approve" | "request-change" | "comment" | "question",
) {
  const select = container.querySelector<HTMLSelectElement>(".collation-item-type");
  if (!select) throw new Error("the item type select did not render");
  fireEvent.change(select, { target: { value: type } });
}

/** Toggle the single stageable item's stage checkbox (blue → ink). */
function toggleStage(container: HTMLElement) {
  const box = container.querySelector<HTMLInputElement>(".collation-item-stage-box");
  if (!box) throw new Error("the stage toggle did not render");
  fireEvent.click(box);
}

/** Freeze the draft into the paper (frame → draft → paper). */
async function openPaper(container: HTMLElement) {
  const signDraft = container.querySelector<HTMLButtonElement>(".collation-sign");
  if (!signDraft) throw new Error("the draft sign control did not render");
  fireEvent.click(signDraft);
  await waitFor(() => expect(container.querySelector(".publish-sheet")).not.toBeNull());
}

/** Attempt to sign the paper via the keyboard, exactly as a reviewer would. */
function signPaper(container: HTMLElement): HTMLButtonElement {
  const sign = container.querySelector<HTMLButtonElement>(".publish-sheet-sign");
  if (!sign) throw new Error("the paper sign control did not render");
  sign.focus();
  fireEvent.keyDown(sign, { key: "Enter" });
  return sign;
}

/** Flush pending microtasks so a would-be async publish call has a chance to land. */
async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const laneOf = (container: HTMLElement) =>
  container.querySelector(".collation-item")?.getAttribute("data-lane");
const publishCount = (container: HTMLElement) =>
  container.querySelector(".destination-frame")?.getAttribute("data-publish-count");
const rollupVerdict = (container: HTMLElement) =>
  container.querySelector(".collation-rollup-verdict")?.getAttribute("data-verdict");
const rollupLabel = (container: HTMLElement) =>
  container.querySelector(".collation-rollup-verdict")?.textContent?.trim();

// ── The LOCAL lanes: nothing travels, and signing is a no-op ──────────────────

describe("staging controls the publish payload (#109) — local dispositions never publish", () => {
  it("an unstaged comment stays local — it never enters the publish payload", async () => {
    const { container, calls } = await reachDraftCanvas(); // the Mark-read comment, unstaged
    expect(laneOf(container)).toBe("blue");
    expect(publishCount(container)).toBe("0");
    expect(rollupVerdict(container)).toBe("none");
    expect(rollupLabel(container)).toBe("Nothing to publish");

    await openPaper(container);
    expect(signPaper(container).disabled).toBe(true); // nothing to sign
    await flush();
    expect(calls).toHaveLength(0); // it never reached the engine
  });

  it("an unstaged question stays local — it never enters the publish payload", async () => {
    const { container, calls } = await reachDraftCanvas();
    retype(container, "question");
    await waitFor(() => expect(laneOf(container)).toBe("blue"));
    expect(publishCount(container)).toBe("0");
    expect(rollupLabel(container)).toBe("Nothing to publish");

    await openPaper(container);
    expect(signPaper(container).disabled).toBe(true);
    await flush();
    expect(calls).toHaveLength(0);
  });

  it("an approve-only draft shows 'Nothing to publish' AND does not run an APPROVE dry run", async () => {
    // The exact symptom #2: the chrome said "Nothing to publish" while the sign path
    // still derived and dry-ran an APPROVE. It must now do neither.
    const { container, calls } = await reachDraftCanvas();
    retype(container, "approve");
    await waitFor(() => expect(laneOf(container)).toBe("blue"));
    expect(publishCount(container)).toBe("0");
    expect(rollupLabel(container)).toBe("Nothing to publish");
    // Approve is a fixed lane: it has no stage toggle at all.
    expect(container.querySelector(".collation-item-stage-box")).toBeNull();

    await openPaper(container);
    expect(signPaper(container).disabled).toBe(true);
    await flush();
    expect(calls).toHaveLength(0); // no APPROVE dry run — the bug is closed
  });
});

// ── The INK lanes: exactly the staged set travels, with the derived verdict ────

describe("staging controls the publish payload (#109) — ink dispositions publish exactly", () => {
  it("a staged comment publishes as a COMMENT review", async () => {
    const { container, calls } = await reachDraftCanvas();
    toggleStage(container); // blue → ink
    await waitFor(() => expect(laneOf(container)).toBe("ink"));
    expect(publishCount(container)).toBe("1");
    expect(rollupLabel(container)).toBe("Comments");

    await openPaper(container);
    expect(signPaper(container).disabled).toBe(false);
    await waitFor(() => expect(calls).toHaveLength(1));
    const call = calls[0];
    if (!call) throw new Error("publish.review was not invoked");
    expect(call.dryRun).not.toBe(false);
    expect(call.verdict).toBe("COMMENT");
    expect(call.comments).toEqual([{ path: "src/x.ts", side: "RIGHT", type: "comment", body: "" }]);
  });

  it("a staged question publishes as a COMMENT review (a question never escalates)", async () => {
    const { container, calls } = await reachDraftCanvas();
    retype(container, "question");
    toggleStage(container);
    await waitFor(() => expect(laneOf(container)).toBe("ink"));
    expect(publishCount(container)).toBe("1");

    await openPaper(container);
    signPaper(container);
    await waitFor(() => expect(calls).toHaveLength(1));
    const call = calls[0];
    if (!call) throw new Error("publish.review was not invoked");
    expect(call.verdict).toBe("COMMENT");
    expect(call.comments).toEqual([
      { path: "src/x.ts", side: "RIGHT", type: "question", body: "" },
    ]);
  });

  it("a request-change always publishes and drives a REQUEST_CHANGES review", async () => {
    const { container, calls } = await reachDraftCanvas();
    retype(container, "request-change");
    // A request-change is a fixed ink lane — always travels, no toggle to move it.
    await waitFor(() => expect(laneOf(container)).toBe("ink"));
    expect(publishCount(container)).toBe("1");
    expect(container.querySelector(".collation-item-stage-box")).toBeNull();
    expect(rollupLabel(container)).toBe("Request changes");

    await openPaper(container);
    expect(signPaper(container).disabled).toBe(false);
    await waitFor(() => expect(calls).toHaveLength(1));
    const call = calls[0];
    if (!call) throw new Error("publish.review was not invoked");
    expect(call.verdict).toBe("REQUEST_CHANGES");
    expect(call.comments).toEqual([
      { path: "src/x.ts", side: "RIGHT", type: "request-change", body: "" },
    ]);
  });

  it("with two comments, staging only one publishes ONLY that one (the ink SUBSET, not the whole draft)", async () => {
    // Split the Mark-read comment into two sibling comments, stage exactly ONE, and
    // sign. The payload must carry the single staged comment — the whole point of
    // #109: what publishes is the ink subset of the draft, never the full draft.
    const { container, calls } = await reachDraftCanvas();
    const split = container.querySelector<HTMLButtonElement>(".collation-split");
    if (!split) throw new Error("the split control did not render");
    fireEvent.click(split);
    await waitFor(() => expect(container.querySelectorAll(".collation-item")).toHaveLength(2));

    // Stage the FIRST of the two — the second stays with the orchestrator (blue).
    toggleStage(container);
    await waitFor(() => expect(publishCount(container)).toBe("1"));
    expect(container.querySelector(".destination-frame")?.getAttribute("data-private-count")).toBe(
      "1",
    );

    await openPaper(container);
    signPaper(container);
    await waitFor(() => expect(calls).toHaveLength(1));
    const call = calls[0];
    if (!call) throw new Error("publish.review was not invoked");
    expect(call.verdict).toBe("COMMENT");
    expect(call.comments).toHaveLength(1); // ONLY the staged one, not both
    expect(call.comments).toEqual([{ path: "src/x.ts", side: "RIGHT", type: "comment", body: "" }]);
  });
});

// ── OWN-BRANCH: the default mode signs a PR submission, never review comments ──

const paperMode = (container: HTMLElement) =>
  container.querySelector(".publish-sheet")?.getAttribute("data-mode");
const paperPreview = (container: HTMLElement) =>
  container.querySelector('[data-testid="publish-preview"]')?.textContent ?? "";

describe("staging controls the publish payload (#109) — own-branch signs a submission, not a review", () => {
  it("own-branch preview is the PR SUBMISSION bytes — not review-comment bytes", async () => {
    // What the human previews IS what would leave. In own-branch that is a PR
    // submission (kind pr-submission), never a pr-review payload.
    const { container } = await reachDraftCanvas("own-branch");
    retype(container, "request-change"); // always ink → a non-empty handoff bundle
    await waitFor(() => expect(laneOf(container)).toBe("ink"));

    await openPaper(container);
    expect(paperMode(container)).toBe("own-branch");
    expect(paperPreview(container)).toContain("pr-submission");
    expect(paperPreview(container)).not.toContain("pr-review");
  });

  it("own-branch sign HANDS OFF and never calls publish.review (the own-branch trust half)", async () => {
    // The P1 this closes: own-branch used to fall back to publish.review, emitting
    // review comments the human never previewed. It must not — creating the PR is the
    // separate, gated #21 act that no command wires yet, so signing is an honest
    // handoff no-op that states the not-yet-wired step and sends nothing.
    const { container, calls } = await reachDraftCanvas("own-branch");
    retype(container, "request-change");
    await waitFor(() => expect(publishCount(container)).toBe("1"));

    await openPaper(container);
    expect(paperMode(container)).toBe("own-branch");
    expect(signPaper(container).disabled).toBe(false); // there IS a bundle to hand off
    await flush();

    // No review was ever posted — the whole point.
    expect(calls).toHaveLength(0);
    // The paper states the honest handoff outcome, not a dry-run review.
    const result = container.querySelector('[data-testid="publish-result"]');
    expect(result).not.toBeNull();
    expect(result?.getAttribute("data-outcome")).toBe("handoff");
    expect(result?.getAttribute("data-dry-run")).toBeNull(); // never a review dry run
    expect(result?.textContent).toContain("separate, gated step (#21)");
  });

  it("own-branch with an empty ink subset cannot sign (approve-only hands off nothing)", async () => {
    const { container, calls } = await reachDraftCanvas("own-branch");
    retype(container, "approve"); // approve never travels → empty bundle
    await waitFor(() => expect(publishCount(container)).toBe("0"));

    await openPaper(container);
    expect(paperMode(container)).toBe("own-branch");
    expect(signPaper(container).disabled).toBe(true);
    await flush();
    expect(calls).toHaveLength(0);
  });
});
