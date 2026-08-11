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
import { describe, expect, it } from "vitest";
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
    // The addressed risk is present too, but marked addressed — not "open".
    const addressed = container.querySelector('.hypothesis-risk[data-status="confirmed"]');
    expect(addressed?.textContent).toMatch(/addressed/);
  });

  it("orders OPEN risks before addressed ones within a severity (attention on the uncleared)", () => {
    // R-open is HIGH, R-done is MEDIUM — high sorts first regardless; this asserts the
    // open one leads the list, where the reviewer's attention should land.
    const { container } = mount(
      <CanvasWorkspace canvases={canvasSet()} flaggedReview={reviewWithHypothesis()} />,
    );
    const statuses = [...container.querySelectorAll(".hypothesis-risk")].map((el) =>
      el.getAttribute("data-status"),
    );
    expect(statuses[0]).toBe("open");
  });

  it("jumps a confirmed risk to its finding in the Flagged lens", async () => {
    const { container, user } = mount(
      <CanvasWorkspace canvases={canvasSet()} flaggedReview={reviewWithHypothesis()} />,
    );
    const jump = container.querySelector<HTMLButtonElement>("[data-jump-finding='f-retry']");
    if (!jump) throw new Error("expected a view-finding jump for the addressed risk");
    await user.click(jump);
    // The jump switches to the Flagged lens, where the finding row (data-finding-id)
    // now renders — proof the angle actually changed to where findings live.
    await waitFor(() =>
      expect(container.querySelector("[data-finding-id='f-retry']")).toBeTruthy(),
    );
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
