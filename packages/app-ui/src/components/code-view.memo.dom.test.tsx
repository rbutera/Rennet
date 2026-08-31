// @vitest-environment happy-dom
//
// perf-audit §5 H5: `buildRowRegistry` walks the WHOLE diff, and it used to run in
// CodeView's render body — so every scroll frame re-split and re-walked the patch,
// which is exactly the cost the windowing exists to avoid. The registrar is the seam:
// wrap it, count the calls, and assert the count does not move when the diff does not.
import { describe, expect, it, vi } from "vitest";
import type { Mark } from "../canvas/registrar";
import { fireEvent, mount, waitFor } from "../test/dom";
import { CodeView } from "./code-view";

const probe = vi.hoisted(() => ({ builds: 0, renders: 0 }));

vi.mock("../canvas/registrar", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../canvas/registrar")>();
  return {
    ...actual,
    buildRowRegistry: (input: Parameters<typeof actual.buildRowRegistry>[0]) => {
      probe.builds += 1;
      return actual.buildRowRegistry(input);
    },
  };
});

function bigDiff(lines: number): string {
  const rows = [`@@ -1,${lines} +1,${lines} @@`];
  for (let index = 1; index <= lines; index += 1) rows.push(`+  const value${index} = ${index};`);
  return rows.join("\n");
}

/** Resolve after the coalesced scroll frame has definitely run (and its successor). */
function nextFrames(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

const BASE = { path: "src/big.ts", rowHeight: 18, viewportHeight: 480 } as const;

// One occurrence over the whole synthetic hunk, and a mark on its second added line —
// row 2, well inside the initial window, so its card renders on every CodeView render.
const OCC_WHOLE = [[{ id: "H", oldStart: 1, oldLines: 400, newStart: 1, newLines: 400 }]];
const MARKS = [
  {
    markId: "m1",
    markKind: "annotation",
    anchor: "rennet:hunk/H#L2@additions",
    body: "the agent's hand",
  },
] as const satisfies readonly Mark[];
const countRender = () => {
  probe.renders += 1;
  return null;
};

describe("CodeView — the registry is built from the diff, not from every render", () => {
  it("re-renders without rebuilding, and rebuilds when the diff changes", () => {
    probe.builds = 0;
    const diff = bigDiff(400);
    const { rerender } = mount(<CodeView {...BASE} diff={diff} />);
    expect(probe.builds).toBe(1);

    rerender(<CodeView {...BASE} diff={diff} />);
    rerender(<CodeView {...BASE} diff={diff} />);
    rerender(<CodeView {...BASE} diff={diff} focusNonce={3} />);
    expect(probe.builds).toBe(1);

    // Positive control: the counter is live and the memo is keyed on the real input —
    // a different diff MUST rebuild, or the assertion above is vacuous.
    rerender(<CodeView {...BASE} diff={bigDiff(200)} />);
    expect(probe.builds).toBe(2);
  });

  it("scrolling re-windows the rows without re-parsing the diff", async () => {
    probe.builds = 0;
    const { container } = mount(<CodeView {...BASE} diff={bigDiff(400)} />);
    const scrollEl = container.querySelector<HTMLElement>(".code-view-scroll");
    if (!scrollEl) throw new Error("scroll container did not mount");
    expect(probe.builds).toBe(1);

    fireEvent.scroll(scrollEl, { target: { scrollTop: 3600 } });
    // The control against a vacuous pass: the scroll has to have MOVED the window
    // before "no rebuild" says anything. A deep row is painted and row 0 recycles out.
    await waitFor(() =>
      expect(Number(scrollEl.getAttribute("data-window-start"))).toBeGreaterThan(0),
    );
    expect(container.querySelector('[data-raw-index="200"]')).not.toBeNull();
    expect(container.querySelector('[data-raw-index="0"]')).toBeNull();

    expect(probe.builds).toBe(1);
  });

  it("a scroll inside the current window re-renders nothing at all", async () => {
    // The probe is `renderMarkCard`: CodeView calls it while rendering the mark's home
    // row, so counting the calls counts the component's renders. Asserting on
    // `data-window-start` alone could NOT fail here — an unchanged window paints the
    // same attribute whether React re-rendered or bailed out.
    const { container } = mount(
      <CodeView
        {...BASE}
        diff={bigDiff(400)}
        hunkOccurrences={OCC_WHOLE}
        marks={MARKS}
        renderMarkCard={countRender}
      />,
    );
    const scrollEl = container.querySelector<HTMLElement>(".code-view-scroll");
    if (!scrollEl) throw new Error("scroll container did not mount");
    expect(container.querySelector("[data-mark-card]")).not.toBeNull();
    const paintedAtRest = scrollEl.getAttribute("data-rendered-rows");
    const rendersAtRest = probe.renders;

    // Under one row of travel: the painted slice would be identical, so the coalesced
    // update returns the current value and React skips the render. The wait is real —
    // two whole frames pass, so the update has had its chance to land.
    fireEvent.scroll(scrollEl, { target: { scrollTop: 7 } });
    await nextFrames();
    expect(probe.renders).toBe(rendersAtRest);
    expect(scrollEl.getAttribute("data-rendered-rows")).toBe(paintedAtRest);

    // Positive control: one FULL row of travel changes the painted slice, so it does
    // render — the assertion above is about the bail-out, not about a component that
    // stopped responding. (18px keeps the mark's row on screen so the probe can see it.)
    fireEvent.scroll(scrollEl, { target: { scrollTop: 18 } });
    await waitFor(() => expect(probe.renders).toBeGreaterThan(rendersAtRest));
    expect(scrollEl.getAttribute("data-rendered-rows")).not.toBe(paintedAtRest);
  });
});
