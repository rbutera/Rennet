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
import { cleanup, fireEvent, mount, waitFor } from "../test/dom";
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

  it("HOLDS the reviewer's in-review override against later app-scheme changes", async () => {
    const { container, rerender } = mount(<CanvasWorkspace canvases={canvasSet()} scheme="dark" />);
    const app = () => container.querySelector(".canvas-app");
    await waitFor(() => expect(app()?.getAttribute("data-scheme")).toBe("dark"));

    // The reviewer explicitly toggles the in-review scheme (dark → bright room).
    const toggle = container.querySelector(".lens-scheme") as HTMLButtonElement;
    fireEvent.click(toggle);
    await waitFor(() => expect(app()?.getAttribute("data-scheme")).toBe("light"));

    // The app scheme now changes to dark — the override HOLDS (canvas stays light).
    rerender(<CanvasWorkspace canvases={canvasSet()} scheme="dark" />);
    // Give the sync effect a chance to (not) run.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(app()?.getAttribute("data-scheme")).toBe("light");
  });
});
