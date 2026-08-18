// @vitest-environment happy-dom
//
// The review canvas follows the app-wide appearance scheme (wireframe #15). The
// document-root theming reaches every surface EXCEPT `.canvas-app`, which installs
// its own nested `data-scheme`; this makes that nested scheme FOLLOW the resolved
// app scheme (so a restored review and a live OS change re-theme the canvas too)
// until the reviewer takes explicit control with the in-review toggle.
import type { Canvas, CanvasAngle } from "@rennet/types";
import { CANVAS_ANGLES } from "@rennet/types";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, mount, waitFor } from "../test/dom";
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

afterEach(cleanup);

describe("CanvasWorkspace — the canvas follows the app scheme", () => {
  it("themes .canvas-app from the app scheme and FOLLOWS a later change (restored review / live OS flip)", async () => {
    const { container, rerender } = mount(<CanvasWorkspace canvases={canvasSet()} scheme="dark" />);
    const app = () => container.querySelector(".canvas-app");
    await waitFor(() => expect(app()).not.toBeNull());
    expect(app()?.getAttribute("data-scheme")).toBe("dark");

    // The resolved app scheme flips after mount (a delayed `settings.get`, or a
    // live OS `prefers-color-scheme` change) — the already-mounted canvas follows.
    rerender(<CanvasWorkspace canvases={canvasSet()} scheme="light" />);
    await waitFor(() => expect(app()?.getAttribute("data-scheme")).toBe("light"));
  });

  // The in-review scheme override (via the former lens-bar toggle) was removed per
  // wireframe #06/#08 — the theme toggle lives in the title bar, not the lens bar.
  // The scheme-follows-app behaviour above is the remaining contract.
});
