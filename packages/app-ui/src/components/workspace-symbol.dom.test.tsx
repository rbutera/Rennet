// @vitest-environment happy-dom
//
// The symbol inspector driven through the REAL CanvasWorkspace (Rai, wireframes #11):
// pin, then navigate the same name twice with the lookups still in flight, and prove
// each response settles its OWN history entry. This is the concurrent-same-name race
// the review flagged: identifying a response by NAME alone let the oldest response
// complete the newest entry. It is driven end-to-end (click → dispatch → state → DOM),
// not over a hand-built fixture, because that is where the bug lived.
import type { SymbolInspection } from "@rennet/types";
import { describe, expect, it } from "vitest";
import { demoCanvases } from "../canvas/fixtures";
import { createViewStore } from "../canvas/store";
import { act, fireEvent, mount, waitFor } from "../test/dom";
import { CanvasWorkspace } from "./workspace";

// A tiny diff whose added line carries a clickable function identifier.
const DIFF = [
  "@@ -1,3 +1,3 @@ export function renderReview()",
  "   const review = loadReview();",
  "-  return renderMetadataCards(review);",
  "+  return renderCodeView(review);",
].join("\n");

function diffFor() {
  return {
    path: "packages/ui/src/review.ts",
    paths: ["packages/ui/src/review.ts"],
    diff: DIFF,
    hunkOccurrences: [],
  };
}

/** A resolved inspection whose definition site path is a caller-chosen marker. */
function inspectionAt(path: string): SymbolInspection {
  return {
    name: "renderCodeView",
    definition: {
      status: "ok",
      sites: [{ path, line: 1, kind: "function", scope: null }],
      tier: { kind: "exact", method: "structural" },
    },
    references: { status: "ok", sites: [], truncated: false },
  };
}

describe("CanvasWorkspace — concurrent same-name symbol lookups (#11)", () => {
  it("settles each lookup on its OWN history entry, even resolved out of order", async () => {
    // Controllable lookups: each call parks its resolver so the test drives ordering.
    const resolvers: Array<(value: SymbolInspection) => void> = [];
    const symbolLookup = () => new Promise<SymbolInspection>((resolve) => resolvers.push(resolve));

    const store = createViewStore({
      angle: "decisions",
      selection: "dec-1-1",
      zoom: { level: "element", elementKey: "dec-1-1" },
    });
    const { container } = mount(
      <CanvasWorkspace
        canvases={demoCanvases()}
        store={store}
        diffFor={diffFor}
        symbolLookup={symbolLookup}
      />,
    );

    const token = container.querySelector<HTMLButtonElement>(
      '.rtok-symbol[data-symbol="renderCodeView"]',
    );
    if (!token) throw new Error("clickable symbol token did not mount");

    // Click → floating peek (req1, pending). Pin it. Click again → pinned push (req2).
    fireEvent.click(token);
    const pin = container.querySelector<HTMLButtonElement>(".symbol-inspector-pin");
    if (!pin) throw new Error("pin control did not mount");
    fireEvent.click(pin);
    fireEvent.click(token);

    const rail = () => container.querySelector(".diff-zoom-rail");
    // Two crumbs of the same name; the current (newest) entry is shown, still pending.
    await waitFor(() => {
      const crumbs = container.querySelectorAll(".symbol-crumb-name");
      expect(crumbs.length).toBe(2);
    });
    expect(resolvers).toHaveLength(2);
    expect(rail()?.textContent).toContain("Looking up");

    // Resolve the OLDER lookup first, with its own marker.
    await act(async () => {
      resolvers[0]?.(inspectionAt("OLDEST.ts"));
    });

    // The shown (newest) entry must NOT have adopted the older response.
    expect(rail()?.textContent).toContain("Looking up");
    expect(rail()?.textContent).not.toContain("OLDEST.ts");

    // Step back to the first crumb: THAT entry — and only it — carries the older result.
    const back = container.querySelector<HTMLButtonElement>(".symbol-nav-btn");
    if (!back) throw new Error("back button did not mount");
    fireEvent.click(back);
    await waitFor(() => expect(rail()?.textContent).toContain("OLDEST.ts"));

    // Forward to the newest crumb: still pending (the older response never leaked in).
    const fwd = container.querySelectorAll<HTMLButtonElement>(".symbol-nav-btn")[1];
    if (!fwd) throw new Error("forward button did not mount");
    fireEvent.click(fwd);
    expect(rail()?.textContent).toContain("Looking up");
    expect(rail()?.textContent).not.toContain("OLDEST.ts");

    // Now resolve the newer lookup: its OWN entry settles with its OWN marker.
    await act(async () => {
      resolvers[1]?.(inspectionAt("NEWEST.ts"));
    });
    await waitFor(() => expect(rail()?.textContent).toContain("NEWEST.ts"));
    expect(rail()?.textContent).not.toContain("OLDEST.ts");
  });
});
