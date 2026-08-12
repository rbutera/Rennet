// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { demoCanvases } from "../canvas/fixtures";
import { fireEvent, mount } from "../test/dom";
import { CanvasWorkspace } from "./workspace";

describe("CanvasWorkspace navigation shortcuts", () => {
  it("does not rotate the active lens for a modified bracket key from a focused descendant", () => {
    const { container, getByRole } = mount(<CanvasWorkspace canvases={demoCanvases()} />);
    const activeLens = () => container.querySelector(".lens-tab.is-active")?.textContent;
    const focusedTab = getByRole("tab", { name: "Decisions" });
    focusedTab.focus();

    expect(activeLens()).toBe("Decisions");
    fireEvent.keyDown(focusedTab, { key: "[", metaKey: true });

    expect(activeLens()).toBe("Decisions");
  });
});
