import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { demoCanvases } from "../canvas/fixtures";
import { createViewStore } from "../canvas/store";
import { DecisionsCanvas } from "./decisions";
import { FlatCanvas } from "./flat";
import { AnnotationMark, ProposalMark } from "./l3";
import { LensSwitcher } from "./lens";
import { CanvasWorkspace } from "./workspace";

const noop = () => undefined;

function countOccurrences(html: string, needle: string): number {
  return html.split(needle).length - 1;
}

describe("LensSwitcher — six canvases, blast-radius is overlay only", () => {
  it("renders exactly six selectable canvas tabs and a separate overlay toggle", () => {
    const html = renderToStaticMarkup(
      <LensSwitcher
        angle="decisions"
        overlayOn={false}
        scheme="dark"
        onSelectAngle={noop}
        onToggleOverlay={noop}
        onToggleScheme={noop}
      />,
    );
    expect(countOccurrences(html, 'role="tab"')).toBe(6);
    // Blast radius is a toggle (aria-pressed), never a sixth tab.
    expect(html).toContain("Blast radius");
    expect(html).toContain('aria-pressed="false"');
    expect(html).not.toContain('role="tab" aria-selected="false">Blast');
  });
});

describe("DecisionsCanvas — roll-up, honest counts, no truncation", () => {
  const canvas = demoCanvases().decisions;

  it("collapses cohorts by default, showing honest counts and no decision rows", () => {
    const html = renderToStaticMarkup(
      <DecisionsCanvas
        canvas={canvas}
        expandedCohorts={{}}
        onToggleCohort={noop}
        onApproveScope={noop}
        onSelectElement={noop}
      />,
    );
    // Ten cohorts, each honest "12 decisions"; none expanded, so no decision rows.
    expect(countOccurrences(html, "12 decisions")).toBe(10);
    expect(countOccurrences(html, 'class="decision"')).toBe(0);
  });

  it("renders every one of 120 decisions with zero truncation when expanded", () => {
    const expanded = Object.fromEntries(
      canvas.layers.analysis.cohorts.map((cohort) => [cohort.cohortKey, true]),
    );
    const html = renderToStaticMarkup(
      <DecisionsCanvas
        canvas={canvas}
        expandedCohorts={expanded}
        onToggleCohort={noop}
        onApproveScope={noop}
        onSelectElement={noop}
      />,
    );
    expect(canvas.layers.analysis.elements).toHaveLength(120);
    expect(countOccurrences(html, 'class="decision"')).toBe(120);
  });

  it("paints the blast-radius cohort amber when the overlay is ON (overlay, not a queue)", () => {
    const html = renderToStaticMarkup(
      <DecisionsCanvas
        canvas={canvas}
        overlayOn={true}
        expandedCohorts={{}}
        onToggleCohort={noop}
        onApproveScope={noop}
        onSelectElement={noop}
      />,
    );
    // c8 is painted in the fixture overlay.
    expect(html).toContain("cohort is-blast");
  });

  it("paints NO amber when the overlay is OFF — it follows the toggle (#35 F1)", () => {
    const html = renderToStaticMarkup(
      <DecisionsCanvas
        canvas={canvas}
        overlayOn={false}
        expandedCohorts={{}}
        onToggleCohort={noop}
        onApproveScope={noop}
        onSelectElement={noop}
      />,
    );
    expect(html).not.toContain("cohort is-blast");
  });
});

describe("FlatCanvas — empty-but-honest", () => {
  it("says an empty claims angle is empty, not unchecked", () => {
    const html = renderToStaticMarkup(
      <FlatCanvas
        canvas={demoCanvases().claims}
        overlayOn={false}
        onApproveScope={noop}
        onSelectElement={noop}
      />,
    );
    expect(html).toContain("empty, not unchecked");
  });

  it("lists spec requirements", () => {
    const html = renderToStaticMarkup(
      <FlatCanvas
        canvas={demoCanvases().spec}
        overlayOn={false}
        onApproveScope={noop}
        onSelectElement={noop}
      />,
    );
    expect(html).toContain("The review survives a force-push");
  });
});

describe("L3 marks — visually distinct as the agent's hand", () => {
  it("annotations carry the L3 marker and are pinnable", () => {
    const html = renderToStaticMarkup(
      <AnnotationMark
        annotation={{
          annotationId: "a",
          target: "t",
          kind: "callout",
          body: "note",
          pinned: false,
        }}
        onPin={noop}
        onClear={noop}
      />,
    );
    expect(html).toContain('data-l3="annotation"');
    expect(html).toContain("l3-callout");
  });

  it("proposals render accept / edit / dismiss next to their target", () => {
    const html = renderToStaticMarkup(
      <ProposalMark
        proposal={{
          proposalId: "p",
          kind: "disposition",
          target: "a.ts",
          payload: "approve it",
          status: "pending",
        }}
        onAccept={noop}
        onEdit={noop}
        onChangeDraft={noop}
        onDismiss={noop}
      />,
    );
    expect(html).toContain('data-l3="proposal"');
    expect(html).toContain(">Accept<");
    expect(html).toContain(">Edit<");
    expect(html).toContain(">Dismiss<");
  });
});

describe("CanvasWorkspace — the six canvases, on screen", () => {
  it("renders the decisions canvas by default with its lens switcher", () => {
    const html = renderToStaticMarkup(
      <CanvasWorkspace canvases={demoCanvases()} store={createViewStore()} />,
    );
    expect(html).toContain("canvas-app");
    expect(countOccurrences(html, 'role="tab"')).toBe(6);
    expect(html).toContain("decisions-canvas");
    expect(html).toContain('data-scheme="dark"');
  });

  it("switches to a flat canvas for a lens with no dedicated view", () => {
    // "claims" has no dedicated lens (flagged/noise/decisions/spec do), so it falls
    // through to the FlatCanvas. ("spec" is now exhaustive — the viewer for a change or
    // the explicit no-change empty state; see the spec-angle empty-state test.)
    const store = createViewStore({ angle: "claims" });
    const html = renderToStaticMarkup(<CanvasWorkspace canvases={demoCanvases()} store={store} />);
    expect(html).toContain("flat-claims");
    expect(html).not.toContain("decisions-canvas");
  });

  it("renders an honest empty Spec angle for no change — never a fixture, never the flat diff", () => {
    const store = createViewStore({ angle: "spec" });
    // No `openSpecChange` prop: the review touches no OpenSpec change.
    const html = renderToStaticMarkup(<CanvasWorkspace canvases={demoCanvases()} store={store} />);
    expect(html).toContain("openspec-empty");
    expect(html).toContain("No OpenSpec change in this review");
    // The two failure modes this closes: no structured viewer (its `ospec-*` markup),
    // and no silent FlatCanvas fall-through.
    expect(html).not.toContain("ospec-");
    expect(html).not.toContain("flat-spec");
  });
});

describe("CanvasWorkspace — the l3-strip is demoted to a navigating index (issue #77)", () => {
  it("renders marks as an index (jump-list), never the old strip; orphans surface in the tray", () => {
    const html = renderToStaticMarkup(
      <CanvasWorkspace canvases={demoCanvases()} store={createViewStore()} />,
    );
    // The strip that HOUSED marks is gone; the index that NAVIGATES to them is present.
    expect(html).not.toContain('class="l3-strip"');
    expect(html).toContain('class="l3-index"');
    // A placeable mark (the demo annotation on a real hunk c6-h1) is a jump button.
    expect(html).toContain("l3-index-jump");
    expect(html).toContain('data-jump="ann-1"');
    // An unplaceable mark (the demo proposal targets a bare path, not an anchor)
    // surfaces in the orphan tray, visibly — never silently dropped into a list.
    expect(html).toContain("l3-orphan-tray");
    expect(html).toContain('data-orphan-mark="prop-1"');
  });
});
