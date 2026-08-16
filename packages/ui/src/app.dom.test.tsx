// @vitest-environment happy-dom
//
// App-level SIGN → PUBLISH ENGINE wire (bead wire-sign-publish). Signing the paper
// no longer just clears the draft — it invokes the real `publish.review` command in
// DRY-RUN, which constructs the exact GitHub request and posts nothing, and the
// paper then shows the outcome. This mounts the WHOLE `RennetApp` over a fake
// `RennetBridge` that RECORDS the `publish.review` invocation, stages a disposition,
// walks frame → draft → paper, signs, and asserts the engine was called with the
// canonical review payload + derived verdict and that the dry-run outcome renders.
// The assertions are behavioural (the recorded command input; the rendered result),
// never a presence check.
import type { CommandInput, CommandOutput, RennetBridge } from "@rennet/protocol";
import type { FlaggedReview, Review } from "@rennet/types";
import { describe, expect, it } from "vitest";
import { RennetApp } from "./app";
import { reviewComments, reviewCommentsPayload } from "./canvas/publish";
import { fireEvent, mount, waitFor } from "./test/dom";

// A ready review with one changed, not-yet-disposed file, so ReviewWorkspace shows
// a "Mark read" button (the simplest staging path: `setFileRead` stages via the
// draft synchronously, before it awaits the bridge).
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

// A recording fake bridge: bootstrap / setDisposition / checkFreshness resolve the
// ready review; `publish.review` records its input and returns a well-formed
// dry-run output (nothing posted). The app never opens Canvases here.
function recordingBridge(
  ready: Review,
  flaggedReview: FlaggedReview = {
    status: "ok",
    findings: [],
    patchsetId: ready.activePatchsetId,
  },
): {
  bridge: RennetBridge;
  calls: CommandInput<"publish.review">[];
} {
  const calls: CommandInput<"publish.review">[] = [];
  const invoke = async (name: string, input: unknown): Promise<unknown> => {
    if (name === "app.bootstrap") return { review: ready, repositoryPresent: true };
    if (name === "flagged.review") return flaggedReview;
    if (name === "publish.review") {
      const publishInput = input as CommandInput<"publish.review">;
      calls.push(publishInput);
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

describe("RennetApp — the Sign button runs the real publish engine (wire-sign-publish)", () => {
  it("signs the paper by invoking publish.review with the canonical payload + verdict, and shows the dry-run outcome", async () => {
    const { bridge, calls } = recordingBridge(review);
    const { container, getByRole } = mount(<RennetApp bridge={bridge} />);

    // The review loads (app.bootstrap resolves) → the destination chrome renders.
    const destination = () => container.querySelector(".destination-frame");
    await waitFor(() => expect(destination()).not.toBeNull());

    // The AI review (Canvases) is the default landing; the "Mark read" staging path
    // lives in the Files view, one tab away. Switch to it.
    fireEvent.click(getByRole("tab", { name: "Files" }));

    // Stage a disposition: Mark read stages a "comment" toward the destination.
    fireEvent.click(getByRole("button", { name: "Mark read" }));
    await waitFor(() => expect(destination()?.getAttribute("data-staged-count")).toBe("1"));

    // `publish.review` is the OTHER-PR act. own-branch (the default) signs a PR
    // SUBMISSION via publish.submitPr and NEVER calls publish.review (issue #109 /
    // #257), so switch to the other-pr framing first to exercise the review wire.
    fireEvent.click(getByRole("tab", { name: "Review to post" }));
    await waitFor(() => expect(destination()?.getAttribute("data-mode")).toBe("other-pr"));

    // Frame → DRAFT → PAPER.
    const openDraft = container.querySelector<HTMLButtonElement>(".destination-open-draft");
    if (!openDraft) throw new Error("the open-draft control did not render");
    fireEvent.click(openDraft);
    await waitFor(() => expect(container.querySelector(".collation-canvas")).not.toBeNull());

    // The "Mark read" comment defaults to the orchestrator — blue/local, so it does
    // NOT publish (issue #109). STAGE it to the PR (ink) so signing legitimately
    // reaches the engine. The unstaged-comment-stays-local case is the contract the
    // staging suite (staging.test.ts) and app.staging-publish.dom.test.tsx assert;
    // this test is only about the sign→publish.review wire, so it publishes on
    // purpose by staging first.
    const stageBox = container.querySelector<HTMLInputElement>(".collation-item-stage-box");
    if (!stageBox) throw new Error("the stage toggle did not render");
    expect(stageBox.checked).toBe(false); // an unstaged comment starts with the orchestrator
    fireEvent.click(stageBox);
    await waitFor(() =>
      expect(container.querySelector<HTMLInputElement>(".collation-item-stage-box")?.checked).toBe(
        true,
      ),
    );

    const signDraft = container.querySelector<HTMLButtonElement>(".collation-sign");
    if (!signDraft) throw new Error("the draft sign control did not render");
    fireEvent.click(signDraft);
    await waitFor(() => expect(container.querySelector(".publish-sheet")).not.toBeNull());

    // Complete a real hold-to-sign on the paper (issue #21: a single keypress no
    // longer signs — the sign is a real egress, so it takes a deliberate HOLD). Real
    // timers here, so hold past the 800ms budget in wall-clock time.
    const sign = container.querySelector<HTMLButtonElement>(".publish-sheet-sign");
    if (!sign) throw new Error("the sign control did not render");
    fireEvent.mouseDown(sign);
    await new Promise((resolve) => setTimeout(resolve, 850));
    fireEvent.mouseUp(sign);

    // The publish engine was invoked exactly once, in DRY-RUN, with the canonical
    // review-comment payload and the derived verdict. RED-proof: point `onSign` back
    // at the old clear-the-draft stub → no `publish.review` call → this never
    // satisfies.
    await waitFor(() => expect(calls).toHaveLength(1));
    const staged = reviewComments([{ id: "src/x.ts", path: "src/x.ts", type: "comment", raw: "" }]);
    const publishCall = calls[0];
    if (!publishCall) throw new Error("publish.review was not invoked");
    expect(publishCall.dryRun).not.toBe(false); // dry-run default: never posts
    expect(publishCall.reviewId).toBe("review");
    expect(publishCall.verdict).toBe("COMMENT"); // a lone comment derives COMMENT
    expect(publishCall.payload).toBe(reviewCommentsPayload(staged));
    expect(publishCall.comments).toEqual([
      { path: "src/x.ts", side: "RIGHT", type: "comment", body: "" },
    ]);
    // The target is the local-capture preview carrying the REAL reviewed head.
    expect(publishCall.target.headOid).toBe("2222222222222222");

    // The paper shows the actual dry-run outcome, replacing the pre-sign notice.
    await waitFor(() => {
      const result = container.querySelector('[data-testid="publish-result"]');
      expect(result).not.toBeNull();
      expect(result?.getAttribute("data-dry-run")).toBe("true");
      expect(result?.textContent).toContain("COMMENT");
    });
  });

  it("feeds a patchset-bound flagged blocker through the live app into PublishSheet", async () => {
    const { bridge } = recordingBridge(review, {
      status: "ok",
      findings: [],
      patchsetId: "patch-one",
      blockingStates: [
        {
          reason: "binary",
          path: "assets/logo.png",
          detail: "assets/logo.png: binary file; its content was not ingested.",
        },
      ],
    });
    const { container, getByRole, getByText } = mount(<RennetApp bridge={bridge} />);

    const destination = () => container.querySelector(".destination-frame");
    await waitFor(() => expect(destination()).not.toBeNull());
    fireEvent.click(getByRole("tab", { name: "Files" }));
    fireEvent.click(getByRole("button", { name: "Mark read" }));
    await waitFor(() => expect(destination()?.getAttribute("data-staged-count")).toBe("1"));
    fireEvent.click(getByRole("tab", { name: "Review to post" }));
    await waitFor(() => expect(destination()?.getAttribute("data-mode")).toBe("other-pr"));

    const openDraft = container.querySelector<HTMLButtonElement>(".destination-open-draft");
    if (!openDraft) throw new Error("the open-draft control did not render");
    fireEvent.click(openDraft);
    await waitFor(() => expect(container.querySelector(".collation-canvas")).not.toBeNull());
    const stageBox = container.querySelector<HTMLInputElement>(".collation-item-stage-box");
    if (!stageBox) throw new Error("the stage toggle did not render");
    fireEvent.click(stageBox);
    const signDraft = container.querySelector<HTMLButtonElement>(".collation-sign");
    if (!signDraft) throw new Error("the draft sign control did not render");
    fireEvent.click(signDraft);

    await waitFor(() => {
      const disclosure = container.querySelector(".publish-sheet .flagged-blocked-ingestion");
      expect(disclosure).not.toBeNull();
      expect(disclosure?.getAttribute("role")).toBe("note");
    });
    expect(getByText("Not fully ingested")).toBeTruthy();
    expect(container.querySelector('[data-reason="binary"]')).toBeTruthy();
    expect(getByText(/binary file; its content was not ingested/)).toBeTruthy();
  });
});
