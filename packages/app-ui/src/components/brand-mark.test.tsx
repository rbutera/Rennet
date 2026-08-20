// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { mount } from "../test/dom";
import { RennetBrandMark } from "./brand-mark";

describe("RennetBrandMark", () => {
  it("renders the committed mark geometry at the requested height", () => {
    const { container } = mount(<RennetBrandMark size={16} />);
    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute("viewBox")).toBe("0 0 128.131244 71.738503");
    expect(svg?.getAttribute("height")).toBe("16");
    // aria-hidden by default (decorative)
    expect(svg?.getAttribute("aria-hidden")).toBe("true");
    expect(svg?.getAttribute("role")).toBeNull();
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
