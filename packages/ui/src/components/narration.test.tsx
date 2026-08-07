import type { ReviewNarration } from "@rennet/types";
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

  it("falls back to an honest pending line when no narration is delivered at all", () => {
    const empty: ReviewNarration | undefined = undefined;
    const html = renderToStaticMarkup(
      <CanvasWorkspace canvases={demoCanvases()} narration={empty} />,
    );
    // Roll-up zoom with no narration prop → the panel is absent (nothing to show),
    // so the surface never crashes; the narration panel simply does not render.
    expect(html).not.toContain("narration-panel");
  });
});
