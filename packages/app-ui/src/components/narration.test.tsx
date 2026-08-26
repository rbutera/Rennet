import type { ReviewNarration } from "@rennet/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { demoCanvases, demoNarration } from "../canvas/fixtures";
import { createViewStore } from "../canvas/store";
import { NarrationPanel } from "./narration";
import { CanvasWorkspace } from "./workspace";

describe("NarrationPanel (issue #70)", () => {
  it("renders the one-line then the paragraph account (narrative first)", () => {
    const html = renderToStaticMarkup(
      <NarrationPanel
        altitude="Roll-up"
        placement={{ status: "narrated", oneLine: "the headline", paragraph: "the detail" }}
      />,
    );
    expect(html).toContain("the headline");
    expect(html).toContain("the detail");
    expect(html).toContain('data-status="narrated"');
  });

  it("renders an honest PENDING state — never a silent blank, never a spinner", () => {
    const html = renderToStaticMarkup(
      <NarrationPanel altitude="Cohort" placement={{ status: "pending" }} />,
    );
    expect(html).toContain("Narration pending");
    expect(html).toContain('data-status="pending"');
  });

  it("renders an honest FAILED state", () => {
    const html = renderToStaticMarkup(
      <NarrationPanel altitude="Cohort" placement={{ status: "failed" }} />,
    );
    expect(html).toContain("Narration unavailable");
    expect(html).toContain('data-status="failed"');
  });
});

describe("CanvasWorkspace — narration at the matching altitude", () => {
  it("shows the roll-up account at the default (roll-up) zoom", () => {
    const html = renderToStaticMarkup(
      <CanvasWorkspace canvases={demoCanvases()} narration={demoNarration()} />,
    );
    // The demo roll-up one-line is present at roll-up zoom.
    expect(html).toContain("A ten-part change");
  });

  it("shows the cohort's account when zoomed into that cohort", () => {
    const store = createViewStore({
      angle: "decisions",
      zoom: { level: "cohort", cohortKey: "cohort:c1" },
    });
    const html = renderToStaticMarkup(
      <CanvasWorkspace canvases={demoCanvases()} narration={demoNarration()} store={store} />,
    );
    // The c1 cohort's narrated account (its title leads its one-line).
    expect(html).toContain("Establish the review store schema");
    expect(html).toContain("narration-panel");
  });

  it("shows an honest pending line for a cohort whose account has not landed", () => {
    // The demo leaves the last cohort (cohort:c10) pending on purpose.
    const store = createViewStore({
      angle: "decisions",
      zoom: { level: "cohort", cohortKey: "cohort:c10" },
    });
    const html = renderToStaticMarkup(
      <CanvasWorkspace canvases={demoCanvases()} narration={demoNarration()} store={store} />,
    );
    expect(html).toContain("Narration pending");
  });

  it("renders nothing (never a permanent-pending lie) when the narration subsystem is entirely absent", () => {
    const empty: ReviewNarration | undefined = undefined;
    const html = renderToStaticMarkup(
      <CanvasWorkspace canvases={demoCanvases()} narration={empty} />,
    );
    // An ABSENT narration prop is not a per-node gap — it means the narration
    // subsystem was never wired for this render (version skew / demo shell). The
    // live pipeline ALWAYS delivers a ReviewNarration (buildReviewNarration returns
    // one for every outcome), so on the real path a node gap resolves to an honest
    // `pending` (see narration-logic.test.ts). But when the WHOLE object is absent,
    // a permanent "Narration pending" panel would be a lie — nothing is pending
    // because nothing is coming. The honest surface renders no panel and never
    // crashes. (The never-blank floor is a promise about a DELIVERED narration.)
    expect(html).not.toContain("narration-panel");
    expect(html).not.toContain("Narration pending");
  });
});
