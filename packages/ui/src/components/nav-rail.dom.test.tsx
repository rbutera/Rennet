// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, mount } from "../test/dom";
import { NavRail } from "./nav-rail";

function handlers() {
  return {
    onBack: vi.fn(),
    onForward: vi.fn(),
    onHome: vi.fn(),
    onProjects: vi.fn(),
  };
}

describe("NavRail", () => {
  it("disables Back at the root and enables it when history is available", () => {
    const callbacks = handlers();
    const { getByRole, rerender } = mount(
      <NavRail canBack={false} canForward={false} {...callbacks} />,
    );

    const back = getByRole("button", { name: "Back" });
    expect((back as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(back);
    expect(callbacks.onBack).not.toHaveBeenCalled();

    rerender(<NavRail canBack canForward={false} {...callbacks} />);
    expect((getByRole("button", { name: "Back" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("fires each navigation handler exactly once", () => {
    const callbacks = handlers();
    const { getByRole } = mount(<NavRail canBack canForward {...callbacks} />);

    fireEvent.click(getByRole("button", { name: "Back" }));
    fireEvent.click(getByRole("button", { name: "Forward" }));
    fireEvent.click(getByRole("button", { name: "Home" }));
    fireEvent.click(getByRole("button", { name: "Projects" }));

    expect(callbacks.onBack).toHaveBeenCalledOnce();
    expect(callbacks.onForward).toHaveBeenCalledOnce();
    expect(callbacks.onHome).toHaveBeenCalledOnce();
    expect(callbacks.onProjects).toHaveBeenCalledOnce();
  });
});
