// @vitest-environment happy-dom
//
// The Decisions lens (issue #137): this mounts the real `DecisionsCanvas` over a
// canvas whose decision elements carry the rich detail, and drives the surface —
// evidence chips render (spec line / PR-body passage / hunk), a reconstructed why
// renders MARKED as reconstructed, a decision with no rationale renders on its
// evidence alone (never an invented reason), alternatives render, groups are
// labelled by theme, and the honest-empty vs failed-runner states render LOUDLY
// differently. There is NO evidenced/mechanical/contestable triage bucket in the
// rendered DOM. Assertions are behavioural (rendered text/classes), not presence-
// only.
import type { Canvas, DecisionsRunStatus } from "@rennet/types";
import { describe, expect, it, vi } from "vitest";
import { mount } from "../test/dom";
import { DecisionsCanvas } from "./decisions";

function baseCanvas(overrides: Partial<Canvas["layers"]["analysis"]>): Canvas {
  return {
    canvasId: "cid",
    reviewId: "rev",
    patchsetId: "ps",
    angle: "decisions",
    layers: {
      substrate: { chunks: [] },
      analysis: { elements: [], cohorts: [], readingOrder: [], ...overrides },
      disposition: { dispositions: [] },
      annotation: { annotations: [], proposals: [] },
    },
    overlay: [],
  };
}

/** A two-theme canvas: "Storage and state" and "Failure posture" (frame 08). */
function richCanvas(): Canvas {
  return baseCanvas({
    elements: [
      {
        elementKey: "e-store",
        docId: "d",
        anchor: "rennet:chunk/c1",
        kind: "decision",
        title: "Keyed the store per repo root",
        decision: {
          evidence: [
            { kind: "spec", label: "spec §2.1", detail: "survives a force-push" },
            { kind: "pr-body", label: "PR body", detail: "store under the common-dir" },
          ],
          why: { reconstructed: true, text: "branch-keying drops the review on a rename" },
          alternatives: ["key per branch ref"],
        },
      },
      {
        elementKey: "e-noreason",
        docId: "d",
        anchor: "rennet:chunk/c2",
        kind: "decision",
        title: "Left the import reorder in place",
        decision: { evidence: [], alternatives: [] },
      },
    ],
    cohorts: [
      { cohortKey: "cohort:c1", title: "Storage and state", elementKeys: ["e-store"] },
      { cohortKey: "cohort:c2", title: "Failure posture", elementKeys: ["e-noreason"] },
    ],
    readingOrder: ["cohort:c1", "cohort:c2"],
  });
}

const EXPANDED = { "cohort:c1": true, "cohort:c2": true };

function renderRich(runStatus?: DecisionsRunStatus) {
  return mount(
    <DecisionsCanvas
      canvas={richCanvas()}
      expandedCohorts={EXPANDED}
      onToggleCohort={vi.fn()}
      onApproveScope={vi.fn()}
      onSelectElement={vi.fn()}
      {...(runStatus ? { runStatus } : {})}
    />,
  );
}

describe("DecisionsCanvas — the decisions lens surface (issue #137)", () => {
  it("labels each group by its theme (the chunk title)", () => {
    const { getByText } = renderRich();
    expect(getByText("Storage and state")).toBeTruthy();
    expect(getByText("Failure posture")).toBeTruthy();
  });

  it("renders the evidence chips a decision was drawn from", () => {
    const { container, getByText } = renderRich();
    const kinds = [...container.querySelectorAll(".evidence-kind")].map((el) => el.textContent);
    expect(kinds).toContain("spec");
    expect(kinds).toContain("PR body");
    expect(getByText("survives a force-push")).toBeTruthy();
  });

  it("renders the reconstructed why MARKED as reconstructed", () => {
    const { container, getByText } = renderRich();
    const tag = container.querySelector(".decision-why-tag");
    expect(tag?.textContent).toMatch(/reconstructed/);
    expect(getByText(/branch-keying drops the review/)).toBeTruthy();
  });

  it("renders a decision with NO rationale on its evidence alone, never inventing one", () => {
    const { container } = renderRich();
    // The second decision has no `why`: the surface says so honestly.
    const none = container.querySelector(".decision-why-none");
    expect(none).toBeTruthy();
    expect(none?.textContent).toMatch(/none discerned/);
  });

  it("names the alternatives not taken where discernible", () => {
    const { getByText } = renderRich();
    expect(getByText("key per branch ref")).toBeTruthy();
  });

  it("carries NO evidenced / mechanical / contestable triage bucket into the DOM", () => {
    const { container } = renderRich();
    const text = (container.textContent ?? "").toLowerCase();
    expect(text).not.toContain("evidenced");
    expect(text).not.toContain("contestable");
    expect(text).not.toContain("mechanical");
  });

  it("renders an honest EMPTY state when the review ran and discerned nothing", () => {
    const { container, getByText } = mount(
      <DecisionsCanvas
        canvas={baseCanvas({})}
        expandedCohorts={{}}
        onToggleCohort={vi.fn()}
        onApproveScope={vi.fn()}
        onSelectElement={vi.fn()}
      />,
    );
    expect(container.querySelector(".decisions-empty")).toBeTruthy();
    expect(container.querySelector(".decisions-failed")).toBeNull();
    expect(getByText(/ran, it was not skipped/)).toBeTruthy();
  });

  it("renders a DISTINCT failed state for a runner that did not complete", () => {
    const { container, getByText } = renderRich({
      status: "failed",
      reason: "the extraction runner timed out",
    });
    expect(container.querySelector(".decisions-failed")).toBeTruthy();
    expect(container.querySelector(".decisions-empty")).toBeNull();
    expect(getByText(/Couldn't reconstruct decisions/)).toBeTruthy();
    expect(getByText(/the extraction runner timed out/)).toBeTruthy();
  });
});
