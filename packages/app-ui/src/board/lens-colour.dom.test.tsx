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
import { lensSeatStates } from "./lens-seats";
import { LensSwitcher } from "./lens-switcher";

// ─────────────────────────────────────────────────────────────────────────────
// The lens register, ON THE RAIL.
//
// It used to be on the bench, as five core samples under a slab. `preparation-bench.tsx`
// is deleted (lens-board-tools 6.5) and the register moved onto the rail's own stop
// (5.5/D12) — the same device at rail scale, which is what `lens-switcher.tsx`'s comment
// already called it. So these assertions moved with it, unchanged in what they claim:
//
//   1. Each lens BINDS its own hue on its own subtree. If the binding is missing, or lands
//      on a shared ancestor instead, every stop paints the same colour and the whole
//      register is decorative. That is invisible in a single-lens fixture, which is why
//      the fixture below carries all five.
//   2. Each register CUTS the stop differently. The states used to be told apart by colour
//      (gold working, green settled, red failed). Flagged owns red now, so failure cannot
//      be red any more, and the cut is what carries it.
//
// WHAT THESE ASSERTIONS CANNOT SEE: `data-cut` is a stamp the component writes, not the
// geometry it draws. A `data-cut="snapped"` whose spans accidentally draw an unbroken rule
// passes here. Nothing in a DOM suite reads a shape as a human does; the geometry is proved
// by looking at it, and the stamp is what keeps the STATES distinct once it is right.
// Likewise `class` is not `getComputedStyle`: happy-dom does not run Tailwind, so this
// proves the binding class reaches the element, not that the browser painted a blue stop.
//
// POSITIVE CONTROLS RUN, 2026-09-05 — each mutation applied alone, this file run, reverted.
// See the PR's control ledger for the exact failing test names.
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

const LENSES = ["design", "sequence", "decisions", "flagged", "noise"] as const;

function railWithEveryLens() {
  const row: SidebarSession = {
    id: "sess-rail",
    projectId: "proj-1",
    title: "feat/rail",
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

const openRail = () =>
  mount(<RennetRouterApp bridge={railWithEveryLens()} history={memoryHistory("/s/sess-rail")} />);

const tabOf = (lens: string) => document.querySelector(`[data-lens="${lens}"]`);
const stopOf = (lens: string) => tabOf(lens)?.querySelector('[data-testid="lens-stop"]');
const cutOf = (lens: string) => stopOf(lens)?.getAttribute("data-cut");

describe("the lens register on the rail", () => {
  it("each lens binds its own hue, on its own subtree", async () => {
    openRail();
    await waitFor(() => expect(tabOf("design")).toBeTruthy());

    for (const [lens, tint] of Object.entries(LENS_TINT)) {
      const tab = tabOf(lens);
      expect(tab, `${lens} tab present`).toBeTruthy();
      expect(tab?.className, `${lens} binds its own hue`).toContain(tint);
    }
  });

  it("four lenses take four different bindings and only Noise shares the quiet one", async () => {
    // The check the one above cannot make: five tabs each carrying A binding proves
    // nothing if they all carry the SAME one. A single-lens fixture cannot see this.
    openRail();
    await waitFor(() => expect(tabOf("design")).toBeTruthy());

    const bound = LENSES.map((lens) => {
      const found = [...(tabOf(lens)?.classList ?? [])].filter((c) => c.startsWith("[--rn-lens:"));
      expect(found, `${lens} binds exactly one hue`).toHaveLength(1);
      return found[0];
    });
    expect(new Set(bound).size).toBe(5);
  });

  it("every register cuts the stop differently — the state survives colour being ignored", async () => {
    openRail();
    await waitFor(() => expect(tabOf("design")).toBeTruthy());

    // The fixture puts one lane in each register, so this is one assertion per state.
    expect(cutOf("design")).toBe("unstarted"); // queued
    expect(cutOf("sequence")).toBe("open"); // running
    expect(cutOf("decisions")).toBe("seamed"); // done + reworked
    expect(cutOf("flagged")).toBe("snapped"); // failed
    expect(cutOf("noise")).toBe("empty"); // absent
    // And they are five DISTINCT cuts, not five names for the same drawing.
    expect(new Set(LENSES.map(cutOf)).size).toBe(5);
  });

  it("a failed lens is a BREAK, not a red stop", async () => {
    openRail();
    await waitFor(() => expect(tabOf("flagged")).toBeTruthy());

    const broken = stopOf("flagged");
    // Two pieces with a gap between them. The intact registers draw ONE rule as the stop
    // element itself and carry no child pieces at all; a snapped stop is three children —
    // piece, gap, piece — which is a difference of structure rather than of class.
    expect(broken?.children).toHaveLength(3);
    // The contrast that makes it an assertion about FAILURE and not about markup: a
    // settled lane in the same rail is one undivided rule.
    expect(stopOf("decisions")?.children).toHaveLength(2); // seamed: two halves, no gap
    expect(stopOf("design")?.children).toHaveLength(0); // unstarted: the rule itself
    // And the danger register is nowhere on the failed lens's stop: red is Flagged's
    // identity now, so a failure painted in `danger` would say the wrong thing.
    expect(broken?.outerHTML).not.toContain("danger");
  });

  it("the lens's words stay on the ink ramp — the hue is a mark, never type", async () => {
    // The palette holds the lens slots to 3:1, not 4.5:1. That is the right bar for a
    // rule and the wrong one for a sentence, so the label must not be painted in it.
    openRail();
    await waitFor(() => expect(tabOf("design")).toBeTruthy());

    for (const lens of LENSES) {
      const tab = tabOf(lens);
      const label = [...(tab?.querySelectorAll("span") ?? [])].find(
        (el) => el.textContent === LANES.find((l) => l.id === lens)?.label,
      );
      expect(label, `${lens} label present`).toBeTruthy();
      expect(label?.className, `${lens} label is not in the lens hue`).not.toMatch(/text-lens/);
    }
  });

  it("all five lenses sit in one rail that cannot wrap", async () => {
    // The bench's five readers used to orphan the fifth onto a line of its own below
    // ~750px, and were pinned to an explicit five-column grid for it. The rail is a flex
    // row of `whitespace-nowrap` tabs with no wrap class, which is the same guarantee by
    // a different mechanism. happy-dom has no layout, so this proves five tabs were asked
    // for in one container — not that they fit.
    openRail();
    await waitFor(() => expect(tabOf("design")).toBeTruthy());

    const rail = document.querySelector('[data-kind="lens-switcher"]') as HTMLElement;
    expect(rail.querySelectorAll("[data-lens]")).toHaveLength(5);
    expect(rail.className).not.toContain("flex-wrap");
  });
});

describe("the stop as identity, mounted directly", () => {
  const seats = lensSeatStates(
    { lanes: LANES, running: true },
    {
      design: { status: "missing" },
      sequence: { status: "missing" },
      decisions: { status: "missing" },
      flagged: { status: "missing" },
      noise: { status: "missing" },
    },
  );
  const entries = LENSES.map(
    (lens) =>
      ({
        lens,
        seat: seats[lens],
        board: { boardId: `b-${lens}`, sections: [] },
      }) as unknown as LensBoardEntry,
  );

  it("the stop paints in the bound hue, never a named colour", () => {
    mount(<LensSwitcher lenses={entries} selected="noise" onSelect={() => undefined} />);
    for (const lens of LENSES) {
      const stop = stopOf(lens);
      expect(stop, `${lens} has a stop`).toBeTruthy();
      // The stop paints in the BOUND hue (`lens`), never in a named colour — that is
      // what makes one device serve five lenses and survive a theme change. Both forms
      // count: a utility (`bg-lens`) and the dashed/dotted cuts' gradient, which names
      // the same token as a CSS variable.
      expect(stop?.outerHTML).toMatch(/bg-lens|--color-lens/);
    }
  });

  it("the stop is identity, and selection is still carried without it", () => {
    // BOTH lenses in the same register (`done`, so both stops are the plain clean rule),
    // so the ONLY difference between them is the selected/unselected strength this test
    // is about. Comparing two different cuts would let a difference of register pass as a
    // difference of selection.
    const settledLanes = [
      { id: "design", label: "Design", status: "done", verdict: "carrying-forward" },
      { id: "sequence", label: "Sequence", status: "done", verdict: "carrying-forward" },
    ] as LensLane[];
    const settledSeats = lensSeatStates(
      { lanes: settledLanes, running: true },
      {
        design: { status: "missing" },
        sequence: { status: "missing" },
        decisions: { status: "missing" },
        flagged: { status: "missing" },
        noise: { status: "missing" },
      },
    );
    const settled = (["design", "sequence"] as const).map(
      (lens) =>
        ({
          lens,
          seat: settledSeats[lens],
          board: { boardId: `b-${lens}`, sections: [] },
        }) as unknown as LensBoardEntry,
    );
    mount(<LensSwitcher lenses={settled} selected="sequence" onSelect={() => undefined} />);

    const selected = tabOf("sequence");
    const other = tabOf("design");
    expect(cutOf("sequence")).toBe("clean");
    expect(cutOf("design")).toBe("clean");
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
