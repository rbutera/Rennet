// @vitest-environment happy-dom
//
// Mounted coverage for the #11 symbol-inspector additions: the honest tier chip
// (exact vs guess, never fabricated), and the pin → mini-browser (breadcrumb, back /
// forward, and clicking a real neighbour symbol to re-look-it-up). These are
// interaction behaviours, so they belong in the DOM harness.
import type { SymbolInspection } from "@rennet/types";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, mount } from "../test/dom";
import { SymbolInspector } from "./symbol-inspector";

/** Index into a NodeList/array, failing loudly rather than returning `undefined`. */
function at<T>(list: ArrayLike<T>, index: number): T {
  const value = list[index];
  if (value === undefined) throw new Error(`no element at index ${index}`);
  return value;
}

const EXACT_INSPECTION: SymbolInspection = {
  name: "TokenBucket",
  definition: {
    status: "ok",
    sites: [{ path: "src/bucket.ts", line: 4, kind: "class", scope: "pkg" }],
    tier: { kind: "exact", method: "structural" },
  },
  references: {
    status: "ok",
    sites: [{ path: "src/use.ts", line: 9, scope: null }],
    truncated: false,
    tier: { kind: "guess", method: "textual" },
  },
  neighbors: {
    path: "src/bucket.ts",
    symbols: [
      { name: "TokenBucket", kind: "class", line: 4 },
      { name: "refill", kind: "function", line: 20 },
    ],
  },
};

const AMBIGUOUS_INSPECTION: SymbolInspection = {
  name: "Widget",
  definition: {
    status: "ok",
    sites: [
      { path: "a.ts", line: 1, kind: "class", scope: null },
      { path: "b.ts", line: 2, kind: "class", scope: null },
    ],
    tier: { kind: "guess", method: "structural", candidates: 2 },
  },
  references: { status: "ok", sites: [], truncated: false },
};

describe("SymbolInspector — tier chip (#11)", () => {
  it("labels a single structural definition `exact` and the textual references `guess`", () => {
    const { container } = mount(
      <SymbolInspector name="TokenBucket" inspection={EXACT_INSPECTION} onClose={vi.fn()} />,
    );
    const def = container.querySelector('[data-section="definition"] .symbol-tier');
    const ref = container.querySelector('[data-section="references"] .symbol-tier');
    if (!def || !ref) throw new Error("tier chips did not render");
    expect(def.getAttribute("data-tier")).toBe("exact");
    expect(def.getAttribute("data-method")).toBe("structural");
    expect(def.textContent).toContain("exact");
    expect(ref.getAttribute("data-tier")).toBe("guess");
    expect(ref.getAttribute("data-method")).toBe("textual");
    // The honesty guarantee at the surface: a textual reference chip never says exact.
    expect(ref.textContent).not.toContain("exact");
  });

  it("shows a candidate count when several structural declarations share the name", () => {
    const { container } = mount(
      <SymbolInspector name="Widget" inspection={AMBIGUOUS_INSPECTION} onClose={vi.fn()} />,
    );
    const def = container.querySelector('[data-section="definition"] .symbol-tier');
    if (!def) throw new Error("tier chip did not render");
    expect(def.getAttribute("data-tier")).toBe("guess");
    expect(def.textContent).toContain("2 candidates");
  });

  it("renders no tier chip for an empty answer (nothing to be confident about)", () => {
    const empty: SymbolInspection = {
      name: "gone",
      definition: { status: "ok", sites: [] },
      references: { status: "ok", sites: [], truncated: false },
    };
    const { container } = mount(
      <SymbolInspector name="gone" inspection={empty} onClose={vi.fn()} />,
    );
    expect(container.querySelector(".symbol-tier")).toBeNull();
  });
});

describe("SymbolInspector — pin + mini-browser (#11)", () => {
  it("shows a Pin control when a toggle is wired, and fires it", () => {
    const onTogglePin = vi.fn();
    const { container } = mount(
      <SymbolInspector
        name="TokenBucket"
        inspection={EXACT_INSPECTION}
        onClose={vi.fn()}
        onTogglePin={onTogglePin}
      />,
    );
    const pin = container.querySelector<HTMLButtonElement>(".symbol-inspector-pin");
    if (!pin) throw new Error("pin control did not render");
    expect(pin.textContent).toBe("Pin");
    fireEvent.click(pin);
    expect(onTogglePin).toHaveBeenCalledTimes(1);
  });

  it("renders no pin control when no toggle is wired (the plain floating peek)", () => {
    const { container } = mount(
      <SymbolInspector name="TokenBucket" inspection={EXACT_INSPECTION} onClose={vi.fn()} />,
    );
    expect(container.querySelector(".symbol-inspector-pin")).toBeNull();
    expect(container.querySelector(".symbol-crumb")).toBeNull();
  });

  it("when pinned, renders the breadcrumb chain with the current crumb marked", () => {
    const { container } = mount(
      <SymbolInspector
        name="BucketState"
        inspection={EXACT_INSPECTION}
        onClose={vi.fn()}
        pinned
        onTogglePin={vi.fn()}
        breadcrumb={["take", "RateStore.get", "BucketState"]}
        cursor={2}
        onCrumb={vi.fn()}
      />,
    );
    expect(container.querySelector(".symbol-inspector--pinned")).not.toBeNull();
    const crumbs = container.querySelectorAll(".symbol-crumb-name");
    expect([...crumbs].map((c) => c.textContent)).toEqual(["take", "RateStore.get", "BucketState"]);
    const current = container.querySelector(".symbol-crumb-name--current");
    expect(current?.textContent).toBe("BucketState");
    expect(current?.getAttribute("aria-current")).toBe("true");
  });

  it("wires back / forward to the cursor, disabling the unavailable direction", () => {
    const onBack = vi.fn();
    const onForward = vi.fn();
    // Mid-history: both directions available.
    const { container, rerender } = mount(
      <SymbolInspector
        name="mid"
        inspection={EXACT_INSPECTION}
        onClose={vi.fn()}
        pinned
        onTogglePin={vi.fn()}
        breadcrumb={["a", "mid", "c"]}
        cursor={1}
        onBack={onBack}
        onForward={onForward}
        canBack
        canForward
      />,
    );
    const nav = container.querySelectorAll<HTMLButtonElement>(".symbol-nav-btn");
    fireEvent.click(at(nav, 0));
    fireEvent.click(at(nav, 1));
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(onForward).toHaveBeenCalledTimes(1);

    // At the head of history: forward is disabled.
    rerender(
      <SymbolInspector
        name="c"
        inspection={EXACT_INSPECTION}
        onClose={vi.fn()}
        pinned
        onTogglePin={vi.fn()}
        breadcrumb={["a", "mid", "c"]}
        cursor={2}
        onBack={onBack}
        onForward={onForward}
        canBack
        canForward={false}
      />,
    );
    const buttons = container.querySelectorAll<HTMLButtonElement>(".symbol-nav-btn");
    expect(at(buttons, 0).disabled).toBe(false); // back
    expect(at(buttons, 1).disabled).toBe(true); // forward
  });

  it("clicking a crumb jumps the cursor to it (re-shows that name)", () => {
    const onCrumb = vi.fn();
    const { container } = mount(
      <SymbolInspector
        name="BucketState"
        inspection={EXACT_INSPECTION}
        onClose={vi.fn()}
        pinned
        onTogglePin={vi.fn()}
        breadcrumb={["take", "RateStore.get", "BucketState"]}
        cursor={2}
        onCrumb={onCrumb}
      />,
    );
    const crumbs = container.querySelectorAll<HTMLButtonElement>(".symbol-crumb-name");
    fireEvent.click(at(crumbs, 0)); // "take"
    expect(onCrumb).toHaveBeenCalledWith(0);
  });

  it("clicking a neighbour symbol re-looks-it-up via onNavigate; the current one is inert", () => {
    const onNavigate = vi.fn();
    const { container } = mount(
      <SymbolInspector
        name="TokenBucket"
        inspection={EXACT_INSPECTION}
        onClose={vi.fn()}
        pinned
        onTogglePin={vi.fn()}
        breadcrumb={["TokenBucket"]}
        cursor={0}
        onNavigate={onNavigate}
      />,
    );
    const rungs = container.querySelectorAll<HTMLButtonElement>(".symbol-neighbor");
    expect([...rungs].map((r) => r.querySelector(".symbol-neighbor-name")?.textContent)).toEqual([
      "TokenBucket",
      "refill",
    ]);
    // The inspected name is marked current and not clickable.
    const current = container.querySelector<HTMLButtonElement>(".symbol-neighbor--current");
    expect(current?.disabled).toBe(true);
    // A sibling re-runs the lookup.
    fireEvent.click(at(rungs, 1)); // "refill"
    expect(onNavigate).toHaveBeenCalledWith("refill");
  });

  it("shows the sibling mini-browser ONLY when pinned (the floating peek stays a peek)", () => {
    // Un-pinned: neighbours are present in the data but the peek does not show them.
    const floating = mount(
      <SymbolInspector
        name="TokenBucket"
        inspection={EXACT_INSPECTION}
        onClose={vi.fn()}
        onTogglePin={vi.fn()}
      />,
    );
    expect(floating.container.querySelector('[data-section="neighbors"]')).toBeNull();
    expect(floating.container.querySelector(".symbol-neighbor")).toBeNull();
    floating.unmount();

    // Pinned: the same inspection now surfaces the mini-browser.
    const pinned = mount(
      <SymbolInspector
        name="TokenBucket"
        inspection={EXACT_INSPECTION}
        onClose={vi.fn()}
        pinned
        onTogglePin={vi.fn()}
        breadcrumb={["TokenBucket"]}
        cursor={0}
        onNavigate={vi.fn()}
      />,
    );
    expect(pinned.container.querySelector('[data-section="neighbors"]')).not.toBeNull();
    expect(pinned.container.querySelectorAll(".symbol-neighbor").length).toBe(2);
  });
});
