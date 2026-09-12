// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { mount } from "../test/dom";
import { RennetBrandMark } from "./brand-mark";

/** Every `url(#id)` reference the mark's own drawing makes. */
function fragmentRefs(svg: Element): string[] {
  const refs: string[] = [];
  for (const node of svg.querySelectorAll("*")) {
    for (const attr of node.getAttributeNames()) {
      const match = /^url\(#(.+)\)$/.exec(node.getAttribute(attr) ?? "");
      const id = match?.[1];
      if (id) refs.push(id);
    }
  }
  return refs;
}

describe("RennetBrandMark", () => {
  it("draws the liquid sphere square, on the authored 100-grid", () => {
    const { container } = mount(<RennetBrandMark size={16} />);
    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
    // The colour sphere's own viewBox. The retired wheel was "0 0 128.131244 71.738503";
    // this assertion is what refuses it coming back.
    expect(svg?.getAttribute("viewBox")).toBe("0 0 100 100");
    // Square: the mark no longer has an intrinsic ratio to multiply by.
    expect(svg?.getAttribute("width")).toBe("16");
    expect(svg?.getAttribute("height")).toBe(svg?.getAttribute("width"));
    // aria-hidden by default (decorative)
    expect(svg?.getAttribute("aria-hidden")).toBe("true");
    expect(svg?.getAttribute("role")).toBeNull();
  });

  it("is width-equals-height at any size", () => {
    for (const size of [14, 16, 24, 72, 100]) {
      const { container, unmount } = mount(<RennetBrandMark size={size} />);
      const svg = container.querySelector("svg");
      expect(svg?.getAttribute("width")).toBe(String(size));
      expect(svg?.getAttribute("height")).toBe(String(size));
      unmount();
    }
  });

  it("carries the colour gradients rather than a scheme-swapped single ink", () => {
    const { container } = mount(<RennetBrandMark size={16} />);
    const svg = container.querySelector("svg");
    if (!svg) throw new Error("no mark");
    // One linear body gradient, a radial shade and a radial highlight, clipped to the disc.
    expect(svg.querySelectorAll("lineargradient, linearGradient").length).toBe(1);
    expect(svg.querySelectorAll("radialgradient, radialGradient").length).toBe(2);
    expect(svg.querySelectorAll("clippath, clipPath").length).toBe(1);
    expect(svg.querySelectorAll("rect").length).toBe(3);
    expect(svg.innerHTML).toContain("#f3b437");
    // The colour mark does not swap with the scheme: nothing in it is inked by the token.
    expect(svg.innerHTML).not.toContain("--rn-mark-ink");
    // Every url(#…) the drawing makes resolves to a def this instance actually rendered.
    for (const id of fragmentRefs(svg)) {
      expect(svg.querySelector(`[id="${id}"]`)).not.toBeNull();
    }
  });

  it("gives each mounted instance its own gradient ids", () => {
    const { container } = mount(
      <div>
        <RennetBrandMark size={16} />
        <RennetBrandMark size={24} />
      </div>,
    );
    const [first, second] = Array.from(container.querySelectorAll("svg"));
    if (!first || !second) throw new Error("expected two mounted marks");
    const idsOf = (svg: Element) =>
      Array.from(svg.querySelectorAll("[id]"), (node) => node.getAttribute("id") ?? "");
    const a = idsOf(first);
    const b = idsOf(second);
    expect(a.length).toBe(4);
    expect(b.length).toBe(4);
    // Two instances on one page: a shared id would make the second point at the first's
    // defs and lose its fill entirely when the first unmounts.
    expect(a.filter((id) => b.includes(id))).toEqual([]);
    // And each instance references only its OWN defs.
    for (const id of fragmentRefs(second)) expect(a).not.toContain(id);
  });

  it("exposes an accessible name when given a title", () => {
    const { container } = mount(<RennetBrandMark size={16} title="Rennet" />);
    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("role")).toBe("img");
    expect(svg?.getAttribute("aria-label")).toBe("Rennet");
    expect(svg?.getAttribute("aria-hidden")).toBeNull();
    expect(container.querySelector("title")?.textContent).toBe("Rennet");
  });
});
