// @vitest-environment happy-dom
//
// LensSwitcher keyboard operability (audit, wave 3). The switcher announces a WAI-ARIA
// tab widget (role=tablist / role=tab), so a screen-reader user is told to drive it with
// the arrow keys. Before this wave the markup made that promise but no keyboard could keep
// it: every tab sat in the tab order and arrows did nothing. These tests mount the real
// component in a controlled harness and exercise the roving tabindex + arrow/Home/End
// movement, plus the unchanged click path.
import type { CanvasAngle } from "@rennet/types";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { fireEvent, mount } from "../test/dom";
import { LensSwitcher } from "./lens";

// CANVAS_ANGLES order: spec, sequence, decisions, noise, flagged.
const noop = () => undefined;
function Harness({ initial = "spec" as CanvasAngle }: { initial?: CanvasAngle }) {
  const [angle, setAngle] = useState<CanvasAngle>(initial);
  return (
    <LensSwitcher
      angle={angle}
      overlayOn={false}
      scheme="dark"
      onSelectAngle={setAngle}
      onToggleOverlay={noop}
      onToggleScheme={noop}
    />
  );
}

const tabs = (container: HTMLElement) => [
  ...container.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
];

describe("LensSwitcher — roving tabindex + arrow-key movement (a11y audit)", () => {
  it("puts exactly the active tab in the tab order (roving tabindex)", () => {
    const { container } = mount(<Harness initial="decisions" />);
    const t = tabs(container);
    expect(t).toHaveLength(5);
    // decisions is index 2 — it alone is tabbable; the rest are -1.
    expect(t.map((b) => b.tabIndex)).toEqual([-1, -1, 0, -1, -1]);
    expect(t[2]?.getAttribute("aria-selected")).toBe("true");
  });

  it("ArrowRight selects the next tab and moves focus to it (focus follows selection)", () => {
    const { container } = mount(<Harness initial="spec" />);
    const first = tabs(container)[0];
    first?.focus();
    fireEvent.keyDown(first as HTMLButtonElement, { key: "ArrowRight" });
    const t = tabs(container);
    expect(t[1]?.getAttribute("aria-selected")).toBe("true");
    expect(t.map((b) => b.tabIndex)).toEqual([-1, 0, -1, -1, -1]);
    expect(document.activeElement).toBe(t[1]);
  });

  it("ArrowLeft moves to the previous tab", () => {
    const { container } = mount(<Harness initial="decisions" />);
    const active = tabs(container)[2];
    active?.focus();
    fireEvent.keyDown(active as HTMLButtonElement, { key: "ArrowLeft" });
    expect(tabs(container)[1]?.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(tabs(container)[1]);
  });

  it("wraps at both ends (ArrowLeft from first → last, ArrowRight from last → first)", () => {
    const { container } = mount(<Harness initial="spec" />);
    fireEvent.keyDown(tabs(container)[0] as HTMLButtonElement, { key: "ArrowLeft" });
    expect(tabs(container)[4]?.getAttribute("aria-selected")).toBe("true"); // flagged
    fireEvent.keyDown(tabs(container)[4] as HTMLButtonElement, { key: "ArrowRight" });
    expect(tabs(container)[0]?.getAttribute("aria-selected")).toBe("true"); // spec
  });

  it("Home jumps to the first tab and End to the last", () => {
    const { container } = mount(<Harness initial="decisions" />);
    fireEvent.keyDown(tabs(container)[2] as HTMLButtonElement, { key: "End" });
    expect(tabs(container)[4]?.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(tabs(container)[4]);
    fireEvent.keyDown(tabs(container)[4] as HTMLButtonElement, { key: "Home" });
    expect(tabs(container)[0]?.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(tabs(container)[0]);
  });

  it("keeps the click path intact (pointer selection still works)", () => {
    const { container } = mount(<Harness initial="spec" />);
    fireEvent.click(tabs(container)[3] as HTMLButtonElement); // noise
    expect(tabs(container)[3]?.getAttribute("aria-selected")).toBe("true");
    expect(tabs(container).map((b) => b.tabIndex)).toEqual([-1, -1, -1, 0, -1]);
  });
});
