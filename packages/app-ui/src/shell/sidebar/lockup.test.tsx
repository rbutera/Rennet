// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { mount } from "../../test/dom";
import { RennetLockup } from "./lockup";

/** The authored lockup: mark 126x126 at 0,0 · gap 24 · wordmark 480.168x112 at 150,7. */
const FULL = "0 0 630.168 126";
const MARK = "0 0 126 126";
const WORDMARK = "150 7 480.168 112";

function box(container: Element): { viewBox: string; width: number; height: number } {
  const svg = container.querySelector("svg");
  if (!svg) throw new Error("no lockup");
  return {
    viewBox: svg.getAttribute("viewBox") ?? "",
    width: Number(svg.getAttribute("width")),
    height: Number(svg.getAttribute("height")),
  };
}

describe("RennetLockup", () => {
  it("draws the whole lockup on the authored 630.168x126 grid", () => {
    const { container } = mount(<RennetLockup size={16} />);
    const { viewBox, width, height } = box(container);
    // The retired lockup was "0 0 726.868 126" — a 222.703-wide wheel window. This is
    // what refuses it coming back.
    expect(viewBox).toBe(FULL);
    expect(height).toBe(16);
    expect(width).toBeCloseTo((16 * 630.168) / 126, 5);
    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("role")).toBe("img");
    expect(svg?.getAttribute("aria-label")).toBe("Rennet");
  });

  it("crops part=mark to the sphere's own square window", () => {
    const { container } = mount(<RennetLockup size={100} part="mark" />);
    const { viewBox, width, height } = box(container);
    expect(viewBox).toBe(MARK);
    // The mark part is square now, so the welcome's opening lands a disc, not a strip.
    expect(width).toBe(100);
    expect(height).toBe(100);
    const svg = container.querySelector("svg");
    if (!svg) throw new Error("no lockup");
    // It is the colour sphere: gradients, not a scheme-swapped ink.
    expect(svg.querySelectorAll("lineargradient, linearGradient").length).toBe(1);
    expect(svg.querySelectorAll("radialgradient, radialGradient").length).toBe(2);
    expect(svg.innerHTML).toContain("#f3b437");
    expect(svg.innerHTML).not.toContain("--rn-mark-ink");
    // Parts are decorative; the caller names the assembly.
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(svg.getAttribute("role")).toBeNull();
  });

  it("crops part=wordmark to the glyph window and keeps the scheme-swapped ink", () => {
    const { container } = mount(<RennetLockup size={100} part="wordmark" />);
    const { viewBox, width, height } = box(container);
    expect(viewBox).toBe(WORDMARK);
    expect(height).toBe(100);
    expect(width).toBeCloseTo((100 * 480.168) / 112, 5);
    const svg = container.querySelector("svg");
    if (!svg) throw new Error("no lockup");
    expect(svg.innerHTML).toContain("var(--rn-mark-ink)");
    // No sphere in this window, so no orphan defs referencing a mark that is not drawn.
    expect(svg.querySelectorAll("lineargradient, linearGradient").length).toBe(0);
    expect(svg.querySelectorAll("clippath, clipPath").length).toBe(0);
  });

  it("gives each mounted lockup its own sphere ids", () => {
    const { container } = mount(
      <div>
        <RennetLockup size={16} />
        <RennetLockup size={24} />
      </div>,
    );
    const [first, second] = Array.from(container.querySelectorAll("svg"));
    if (!first || !second) throw new Error("expected two mounted lockups");
    const idsOf = (svg: Element) =>
      Array.from(svg.querySelectorAll("[id]"), (node) => node.getAttribute("id") ?? "");
    const a = idsOf(first);
    const b = idsOf(second);
    expect(a.length).toBe(4);
    expect(a.filter((id) => b.includes(id))).toEqual([]);
  });

  it("places the two parts inside the whole, so the halves reassemble", () => {
    // The welcome animates mark and wordmark separately and expects them to line up with
    // the single drawing everywhere else asks for.
    const viewWindow = (spec: string) => {
      const [x, , w] = spec.split(" ").map(Number);
      if (x === undefined || w === undefined) throw new Error(`bad window: ${spec}`);
      return { x, w };
    };
    const markW = viewWindow(MARK).w;
    const { x: wx, w: wordW } = viewWindow(WORDMARK);
    const fullW = viewWindow(FULL).w;
    expect(wx).toBeGreaterThan(markW); // a real gap, not an overlap
    expect(wx - markW).toBe(24);
    expect(markW + 24 + wordW).toBeCloseTo(fullW, 5);
  });
});
