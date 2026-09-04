// @vitest-environment happy-dom

import type { LensLane, SidebarSession } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import { RennetRouterApp } from "../routes/app";
import { memoryHistory } from "../routes/history";
import { mount, waitFor } from "../test/dom";
import { frontDoorHandlers } from "../test/fixtures/front-door";
import { MemoryBridge } from "../test/memory-bridge";
import type { LensBoardEntry } from "./board-data";
import { LENS_TINT } from "./lens-colour";
import { LensSwitcher } from "./lens-switcher";

// ─────────────────────────────────────────────────────────────────────────────
// The lens register, on the bench.
//
// Two things are asserted here that the unit test next door cannot reach, because both
// are about what lands in the DOM rather than what the mapping says:
//
//   1. Each lane BINDS its own hue on its own subtree. If the binding is missing, or
//      lands on a shared ancestor instead, every core sample paints the same colour
//      and the whole register is decorative. That is invisible in a screenshot review
//      of a single-lens fixture, which is why the fixture below carries all five.
//   2. Each register cuts the sample DIFFERENTLY. The bench's states used to be told
//      apart by colour (gold working, green settled, red failed) with a badge glyph as
//      the second statement. Flagged now owns red, so failure cannot be red any more,
//      and the cut is what carries it.
//
// WHAT THESE ASSERTIONS CANNOT SEE: `data-cut` is a stamp the component writes, not
// the geometry it draws. A `data-cut="snapped"` whose SVG accidentally draws an intact
// plug passes here. Nothing in a DOM suite can read a path's shape as a human does; the
// geometry is proved by looking at it, and the stamp is what keeps the STATES distinct
// once the geometry is right. Likewise `class` is not `getComputedStyle`: happy-dom
// does not run Tailwind, so this proves the binding class reaches the element, not that
// the browser painted a blue plug.
//
// POSITIVE CONTROLS RUN, 2026-09-04 — each mutation applied alone, this file run, then
// reverted:
//   1. `lensTint(lane.id)` dropped from the Reader's className
//        → 2 failed: "each lane binds its own hue" (all five lanes lost the class) and
//          "four lenses take four different bindings".
//   2. `data-cut` pinned to `"clean"` for every register
//        → 1 failed: "every register cuts the sample differently", at its FIRST
//          assertion (`expected 'clean' to be 'unstarted'`) rather than at the
//          set-size check — so that test reddens on the per-state stamps, not only on
//          the five-distinct-values summary.
//   3. `CoreSample`'s failed arm made to render the intact-wall branch (the `rect`)
//        → 1 failed: "a failed lane is a BREAK, not a red plug", on the wall count
//          (`expected …(1) to have a length of +0`).
//   4. the lens rail's stop given `bg-accent`/`bg-accent-line` instead of
//      `bg-lens`/`bg-lens-line`
//        → 2 failed: both rail tests.
// ─────────────────────────────────────────────────────────────────────────────

const LANES: LensLane[] = [
  { id: "design", label: "Design", status: "queued" },
  {
    id: "sequence",
    label: "Sequence",
    status: "running",
    latest: { kind: "tool", text: "reading src/a.ts", at: 1 },
  },
  { id: "decisions", label: "Decisions", status: "done", verdict: "reworked" },
  { id: "flagged", label: "Flagged", status: "failed", reason: "The seat produced no output." },
  { id: "noise", label: "Noise", status: "absent", reason: "Nothing safely skippable." },
] as LensLane[];

function benchWithEveryLens() {
  const row: SidebarSession = {
    id: "sess-bench",
    projectId: "proj-1",
    title: "feat/bench",
    target: "your-branch",
    createdAt: 0,
    preparation: { status: "drafting", reviewId: "rev-1", lanes: LANES },
  } as SidebarSession;
  return new MemoryBridge({
    ...frontDoorHandlers(),
    "session.list": () => ({ sessions: [row] }),
    "review.load": () => {
      throw new Error("Review not found");
    },
  } as never);
}

const rowOf = (id: string) => document.querySelector(`[data-row="${id}"]`);

describe("the lens register on the bench", () => {
  it("each lane binds its own hue, on its own subtree", async () => {
    mount(
      <RennetRouterApp bridge={benchWithEveryLens()} history={memoryHistory("/s/sess-bench")} />,
    );
    await waitFor(() => expect(rowOf("design")).toBeTruthy());

    for (const [lens, tint] of Object.entries(LENS_TINT)) {
      const row = rowOf(lens);
      expect(row, `${lens} lane present`).toBeTruthy();
      expect(row?.className, `${lens} binds its own hue`).toContain(tint);
    }
  });

  it("four lenses take four different bindings and only Noise shares the quiet one", async () => {
    // The check the one above cannot make: five lanes each carrying A binding proves
    // nothing if they all carry the SAME one. A single-lens fixture cannot see this.
    mount(
      <RennetRouterApp bridge={benchWithEveryLens()} history={memoryHistory("/s/sess-bench")} />,
    );
    await waitFor(() => expect(rowOf("design")).toBeTruthy());

    const bound = ["design", "sequence", "decisions", "flagged", "noise"].map((lens) => {
      const found = [...(rowOf(lens)?.classList ?? [])].filter((c) => c.startsWith("[--rn-lens:"));
      expect(found, `${lens} binds exactly one hue`).toHaveLength(1);
      return found[0];
    });
    expect(new Set(bound).size).toBe(5);
  });

  it("every register cuts the sample differently — the state survives colour being ignored", async () => {
    mount(
      <RennetRouterApp bridge={benchWithEveryLens()} history={memoryHistory("/s/sess-bench")} />,
    );
    await waitFor(() => expect(rowOf("design")).toBeTruthy());

    const cutOf = (lens: string) =>
      rowOf(lens)?.querySelector('[data-mark="core"]')?.getAttribute("data-cut");
    // The fixture puts one lane in each register, so this is one assertion per state.
    expect(cutOf("design")).toBe("unstarted"); // queued
    expect(cutOf("sequence")).toBe("open"); // running
    expect(cutOf("decisions")).toBe("seamed"); // done + reworked
    expect(cutOf("flagged")).toBe("snapped"); // failed
    expect(cutOf("noise")).toBe("empty"); // absent
    // And they are five DISTINCT cuts, not five names for the same drawing.
    expect(new Set(["design", "sequence", "decisions", "flagged", "noise"].map(cutOf)).size).toBe(
      5,
    );
  });

  it("a failed lane is a BREAK, not a red plug", async () => {
    mount(
      <RennetRouterApp bridge={benchWithEveryLens()} history={memoryHistory("/s/sess-bench")} />,
    );
    await waitFor(() => expect(rowOf("flagged")).toBeTruthy());

    const mark = rowOf("flagged")?.querySelector('[data-mark="core"]');
    // Two pieces and no intact wall. The intact registers draw the wall as a single
    // <rect>; a snapped sample has none, and has the two break paths instead.
    expect(mark?.querySelectorAll("rect")).toHaveLength(0);
    expect(mark?.querySelectorAll("path").length).toBe(2);
    // The contrast that makes it an assertion about FAILURE and not about SVG: a
    // settled lane in the same tree has the wall and no break paths.
    const settled = rowOf("decisions")?.querySelector('[data-mark="core"]');
    expect(settled?.querySelectorAll("rect")).toHaveLength(1);
    expect(settled?.querySelectorAll("path")).toHaveLength(0);
    // And the danger register is nowhere on the failed lane's mark: red is Flagged's
    // identity now, so a failure painted in `danger` would say the wrong thing.
    expect(mark?.innerHTML).not.toContain("danger");
  });

  it("the lane's words stay on the ink ramp — the hue is a mark, never type", async () => {
    // The palette holds the lens slots to 3:1, not 4.5:1. That is the right bar for a
    // rule and the wrong one for a sentence, so the label and the speech must not be
    // painted in it.
    mount(
      <RennetRouterApp bridge={benchWithEveryLens()} history={memoryHistory("/s/sess-bench")} />,
    );
    await waitFor(() => expect(rowOf("design")).toBeTruthy());

    for (const lens of ["design", "sequence", "decisions", "flagged", "noise"]) {
      const row = rowOf(lens);
      const speech = row?.querySelector("[data-speech]");
      expect(speech?.className, `${lens} speech is not in the lens hue`).not.toMatch(/text-lens/);
      const label = [...(row?.querySelectorAll("span") ?? [])].find(
        (el) => el.textContent === LANES.find((l) => l.id === lens)?.label,
      );
      expect(label, `${lens} label present`).toBeTruthy();
      expect(label?.className, `${lens} label is not in the lens hue`).not.toMatch(/text-lens/);
    }
  });

  it("the readers are one row, whatever the width — five lanes, five columns", async () => {
    // The old `flex-wrap basis-36` put the fifth reader on a line of its own below
    // ~750px. happy-dom has no layout, so the assertion is on the TEMPLATE that makes
    // wrapping impossible rather than on measured positions — which is also what this
    // cannot catch: it proves five columns were asked for, not that they fit.
    mount(
      <RennetRouterApp bridge={benchWithEveryLens()} history={memoryHistory("/s/sess-bench")} />,
    );
    await waitFor(() => expect(rowOf("design")).toBeTruthy());

    const readers = document.querySelector('[data-testid="bench-readers"]') as HTMLElement;
    expect(readers.style.gridTemplateColumns).toBe("repeat(5, minmax(0, 1fr))");
    expect(readers.className).not.toContain("flex-wrap");
  });
});

describe("the lens register on the rail", () => {
  const entries = ["design", "sequence", "decisions", "flagged", "noise"].map(
    (lens) =>
      ({ lens, board: { boardId: `b-${lens}`, sections: [] } }) as unknown as LensBoardEntry,
  );

  it("every tab binds its own hue, and its stop is that hue", () => {
    mount(<LensSwitcher lenses={entries} selected="flagged" onSelect={() => undefined} />);

    for (const [lens, tint] of Object.entries(LENS_TINT)) {
      const tab = document.querySelector(`[data-lens="${lens}"]`);
      expect(tab?.className, `${lens} tab binds its own hue`).toContain(tint);
      const stop = tab?.querySelector('[data-testid="lens-stop"]');
      expect(stop, `${lens} has a stop`).toBeTruthy();
      // The stop paints in the BOUND hue (`lens`), never in a named colour — that is
      // what makes one device serve five lenses and survive a theme change.
      expect(stop?.className).toMatch(/\bbg-lens(-line)?\b/);
    }
  });

  it("the stop is identity, and selection is still carried without it", () => {
    mount(<LensSwitcher lenses={entries} selected="flagged" onSelect={() => undefined} />);

    const selected = document.querySelector('[data-lens="flagged"]');
    const other = document.querySelector('[data-lens="design"]');
    // Full strength on the selected tab, dimmed on the rest — a difference of the SAME
    // hue, so a reader who cannot separate the five colours loses nothing.
    expect(selected?.querySelector('[data-testid="lens-stop"]')?.className).toContain("bg-lens");
    expect(selected?.querySelector('[data-testid="lens-stop"]')?.className).not.toContain(
      "bg-lens-line",
    );
    expect(other?.querySelector('[data-testid="lens-stop"]')?.className).toContain("bg-lens-line");
    // And selection is still stated three non-chromatic ways, exactly as before.
    expect(selected?.getAttribute("aria-selected")).toBe("true");
    expect(other?.getAttribute("aria-selected")).toBe("false");
    expect(selected?.className).toContain("bg-secondary");
    expect(other?.className).not.toContain("bg-secondary");
  });
});
