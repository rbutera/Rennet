// @vitest-environment happy-dom
//
// The hypothesis reading frame (issue #178/#181): mounted in the CanvasWorkspace
// from the flagged review's committed hypothesis + its predicted-risk cross-check.
// This proves the frame actually reaches the screen (the #178 gap was that it was
// built and tested as a pure fold but mounted NOWHERE), that an OPEN risk surfaces
// as the anti-rubber-stamp payoff (#181), that a confirmed risk jumps to its
// finding in the Flagged lens, that it collapses, and that a review with no
// hypothesis shows no frame.
import type { Canvas, CanvasAngle, FlaggedReview, ReviewHypothesis } from "@rennet/types";
import { CANVAS_ANGLES } from "@rennet/types";
import { describe, expect, it, vi } from "vitest";
import { mount, waitFor } from "../test/dom";
import { CanvasWorkspace } from "./workspace";

function canvasSet(): Record<CanvasAngle, Canvas> {
  const one = (angle: CanvasAngle): Canvas => ({
    canvasId: `cid-${angle}`,
    reviewId: "r",
    patchsetId: "p",
    angle,
    layers: {
      substrate: { chunks: [] },
      analysis: { elements: [], cohorts: [], readingOrder: [] },
      disposition: { dispositions: [] },
      annotation: { annotations: [], proposals: [] },
    },
    overlay: [],
  });
  return Object.fromEntries(CANVAS_ANGLES.map((angle) => [angle, one(angle)])) as Record<
    CanvasAngle,
    Canvas
  >;
}

const HYPOTHESIS: ReviewHypothesis = {
  domain: "per-org rate limiting",
  scope: { inScope: ["the token bucket"], outOfScope: ["the metrics registry"] },
  designExpectation: "one refill-on-read bucket per org, behind a RateStore interface",
  risks: [
    {
      riskId: "R-open",
      statement: "an unbounded fail-open lets any org scrape during a store outage",
      severity: "high",
      disconfirmer: "check the fail-open bound",
    },
    {
      riskId: "R-done",
      statement: "the retry-after header unit is ambiguous",
      severity: "medium",
      disconfirmer: "check seconds vs milliseconds",
    },
  ],
  repoContextPresent: true,
};

// A flagged review carrying the hypothesis + a cross-check: R-done is addressed by
// finding f-retry, R-open is predicted-but-unflagged (the open gap the human checks).
function reviewWithHypothesis(): FlaggedReview {
  return {
    status: "ok",
    findings: [
      {
        findingId: "f-retry",
        anchor: "rennet:hunk/retry-1",
        summary: "the retry-after header is emitted in milliseconds, not seconds",
        severity: "medium",
        agreement: { kind: "concur", agree: 2, total: 2 },
      },
    ],
    crossChecks: [
      { riskId: "R-done", status: "confirmed", findingIds: ["f-retry"] },
      { riskId: "R-open", status: "open", findingIds: [] },
    ],
    hypothesis: HYPOTHESIS,
  };
}

describe("CanvasWorkspace — the hypothesis reading frame (#178/#181)", () => {
  it("mounts the frame from the flagged review's hypothesis, showing domain + design", () => {
    const { container, getByText } = mount(
      <CanvasWorkspace canvases={canvasSet()} flaggedReview={reviewWithHypothesis()} />,
    );
    expect(container.querySelector(".hypothesis-panel")).toBeTruthy();
    expect(getByText("per-org rate limiting")).toBeTruthy();
    expect(getByText(/one refill-on-read bucket per org/)).toBeTruthy();
  });

  it("surfaces an OPEN predicted-but-unflagged risk (the #181 anti-rubber-stamp payoff)", () => {
    const { container } = mount(
      <CanvasWorkspace canvases={canvasSet()} flaggedReview={reviewWithHypothesis()} />,
    );
    const open = container.querySelector('.hypothesis-risk[data-status="open"]');
    expect(open).toBeTruthy();
    expect(open?.textContent).toMatch(/unbounded fail-open/);
    expect(open?.textContent).toMatch(/check yourself/);
    // A matched risk is present too — but rendered as a WEAK "possibly related"
    // pointer (the match is lexical, not a resolution), NEVER "addressed" (P0-1).
    const related = container.querySelector('.hypothesis-risk[data-status="confirmed"]');
    expect(related?.textContent).toMatch(/possibly related/);
    expect(container.textContent ?? "").not.toMatch(/addressed/);
  });

  it("orders an OPEN risk before a matched one at the SAME severity (status tiebreak, not riskId)", () => {
    // BOTH risks are HIGH, so the severity sort is a tie and the STATUS tiebreak decides.
    // riskId order alone would put R-a (confirmed) first; open-before-confirmed must
    // override that so the uncleared risk leads. (Red-proof: drop the open-before-confirmed
    // comparator in buildHypothesisFrame and this flips to ["confirmed","open"].)
    const sameSeverity: FlaggedReview = {
      status: "ok",
      findings: [
        {
          findingId: "f1",
          anchor: "rennet:hunk/h1",
          summary: "a finding",
          severity: "high",
          agreement: { kind: "concur", agree: 1, total: 1 },
        },
      ],
      crossChecks: [
        { riskId: "R-a", status: "confirmed", findingIds: ["f1"] },
        { riskId: "R-b", status: "open", findingIds: [] },
      ],
      hypothesis: {
        domain: "d",
        scope: { inScope: [], outOfScope: [] },
        designExpectation: "e",
        risks: [
          { riskId: "R-a", statement: "a matched risk", severity: "high", disconfirmer: "x" },
          { riskId: "R-b", statement: "an open risk", severity: "high", disconfirmer: "y" },
        ],
        repoContextPresent: true,
      },
    };
    const { container } = mount(
      <CanvasWorkspace canvases={canvasSet()} flaggedReview={sameSeverity} />,
    );
    const statuses = [...container.querySelectorAll(".hypothesis-risk")].map((el) =>
      el.getAttribute("data-status"),
    );
    expect(statuses).toEqual(["open", "confirmed"]);
  });

  it("jumps a related risk to its finding row AND scrolls THAT row into view", async () => {
    // Spy on the real scrollIntoView and capture which element it was called on, so the
    // test proves the jump SCROLLS the target row — not merely that the row exists after
    // the angle switch. (Red-proof: replace `scrollIntoView` with a bare query in
    // jumpToFinding and `scrolled` stays empty, failing the toContain.)
    const scrolled: Element[] = [];
    const spy = vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(function (
      this: Element,
    ) {
      scrolled.push(this);
    });
    try {
      const { container, user } = mount(
        <CanvasWorkspace canvases={canvasSet()} flaggedReview={reviewWithHypothesis()} />,
      );
      const jump = container.querySelector<HTMLButtonElement>("[data-jump-finding='f-retry']");
      if (!jump) throw new Error("expected a view-finding jump for the matched risk");
      await user.click(jump);
      await waitFor(() => {
        const row = container.querySelector("[data-finding-id='f-retry']");
        expect(row).toBeTruthy();
        expect(scrolled).toContain(row);
      });
    } finally {
      spy.mockRestore();
    }
  });

  it("warns when EVERY risk is only a lexical match — '0 open' must not read as all-clear (P0-1)", () => {
    // All risks confirmed (0 open). Without the caveat, "0 open · N related" could read
    // as "nothing to worry about"; the honest reading is "weak overlap for everything,
    // verified nothing." (Red-proof: remove the caveat block and this reddens.)
    const allMatched: FlaggedReview = {
      status: "ok",
      findings: [
        {
          findingId: "f1",
          anchor: "rennet:hunk/h1",
          summary: "a finding",
          severity: "high",
          agreement: { kind: "concur", agree: 1, total: 1 },
        },
      ],
      crossChecks: [{ riskId: "R1", status: "confirmed", findingIds: ["f1"] }],
      hypothesis: {
        domain: "d",
        scope: { inScope: [], outOfScope: [] },
        designExpectation: "e",
        risks: [{ riskId: "R1", statement: "the only risk", severity: "high", disconfirmer: "x" }],
        repoContextPresent: true,
      },
    };
    const { container } = mount(
      <CanvasWorkspace canvases={canvasSet()} flaggedReview={allMatched} />,
    );
    const caveat = container.querySelector(".hypothesis-all-related");
    expect(caveat).toBeTruthy();
    expect(caveat?.textContent).toMatch(/none was verified/i);
  });

  it("shows NO all-matched caveat while any risk is still open", () => {
    // reviewWithHypothesis has an open risk → the "0 open" caveat must not appear.
    const { container } = mount(
      <CanvasWorkspace canvases={canvasSet()} flaggedReview={reviewWithHypothesis()} />,
    );
    expect(container.querySelector(".hypothesis-all-related")).toBeNull();
  });

  it("collapses the frame with the terse chrome toggle (narrative-first, never a trap)", async () => {
    const { container, user } = mount(
      <CanvasWorkspace canvases={canvasSet()} flaggedReview={reviewWithHypothesis()} />,
    );
    expect(container.querySelector(".hypothesis-frame")).toBeTruthy();
    const toggle = container.querySelector<HTMLButtonElement>(".hypothesis-panel-toggle");
    if (!toggle) throw new Error("expected the collapse toggle");
    await user.click(toggle);
    expect(container.querySelector(".hypothesis-frame")).toBeNull();
    // The panel + its counts remain (the toggle stays reachable).
    expect(container.querySelector(".hypothesis-panel")).toBeTruthy();
  });

  it("keys the collapse choice BY REVIEW: A's collapse does not leak into B (#240)", async () => {
    // The workspace stays MOUNTED across reviews (app.tsx does not remount it), so a
    // single collapse boolean would carry review A's choice into review B. Rerender the
    // SAME mounted component with a new reviewId to prove the choice is per-review.
    const { container, user, rerender } = mount(
      <CanvasWorkspace
        canvases={canvasSet()}
        reviewId="A"
        flaggedReview={reviewWithHypothesis()}
      />,
    );
    // A starts expanded; collapse it.
    expect(container.querySelector(".hypothesis-frame")).toBeTruthy();
    const toggle = container.querySelector<HTMLButtonElement>(".hypothesis-panel-toggle");
    if (!toggle) throw new Error("expected the collapse toggle");
    await user.click(toggle);
    expect(container.querySelector(".hypothesis-frame")).toBeNull(); // A collapsed

    // Switch to an UNSEEN review B on the same mounted workspace — it must start
    // EXPANDED. (Red-proof: with one `useState(true)` boolean, B stays collapsed here.)
    rerender(
      <CanvasWorkspace
        canvases={canvasSet()}
        reviewId="B"
        flaggedReview={reviewWithHypothesis()}
      />,
    );
    expect(container.querySelector(".hypothesis-frame")).toBeTruthy(); // B expanded

    // Return to A — its own collapsed choice is restored.
    rerender(
      <CanvasWorkspace
        canvases={canvasSet()}
        reviewId="A"
        flaggedReview={reviewWithHypothesis()}
      />,
    );
    expect(container.querySelector(".hypothesis-frame")).toBeNull(); // A still collapsed

    // A REGENERATE (a fresh canvas set under the SAME reviewId) keeps A's choice.
    rerender(
      <CanvasWorkspace
        canvases={canvasSet()}
        reviewId="A"
        flaggedReview={reviewWithHypothesis()}
      />,
    );
    expect(container.querySelector(".hypothesis-frame")).toBeNull(); // still collapsed
  });

  it("shows NO frame when the review carries no hypothesis (pre-#178 shape)", () => {
    const noHypothesis: FlaggedReview = {
      status: "ok",
      findings: [],
    };
    const { container } = mount(
      <CanvasWorkspace canvases={canvasSet()} flaggedReview={noHypothesis} />,
    );
    expect(container.querySelector(".hypothesis-panel")).toBeNull();
  });

  it("shows NO frame for a failed flagged review", () => {
    const failed: FlaggedReview = { status: "failed", reason: "both seats down" };
    const { container } = mount(<CanvasWorkspace canvases={canvasSet()} flaggedReview={failed} />);
    expect(container.querySelector(".hypothesis-panel")).toBeNull();
  });
});
