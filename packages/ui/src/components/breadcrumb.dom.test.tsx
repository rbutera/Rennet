// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { crumb as deriveCrumb, type Surface } from "../nav/history";
import { fireEvent, mount, within } from "../test/dom";
import { Breadcrumb } from "./breadcrumb";

const stack: Surface[] = [
  { kind: "projects" },
  { kind: "project", projectId: "orbital" },
  { kind: "review", reviewId: "feat/rate-limiting" },
  { kind: "draft", reviewId: "feat/rate-limiting" },
];

describe("Breadcrumb", () => {
  it("renders one ordered button per surface and ascends from an ancestor", () => {
    const onAscend = vi.fn();
    const { getByRole } = mount(<Breadcrumb crumb={deriveCrumb(stack)} onAscend={onAscend} />);
    const breadcrumb = getByRole("navigation", { name: "Breadcrumb" });
    const buttons = within(breadcrumb).getAllByRole("button");

    expect(buttons).toHaveLength(stack.length);
    expect(buttons.map((button) => button.textContent?.trim())).toEqual([
      "Projects",
      "orbital",
      "feat/rate-limiting",
      "Draft",
    ]);

    fireEvent.click(buttons[1] as HTMLButtonElement);
    expect(onAscend).toHaveBeenCalledOnce();
    expect(onAscend).toHaveBeenCalledWith(1);
  });

  it("marks the last segment current and does not ascend from it", () => {
    const onAscend = vi.fn();
    const { getByRole } = mount(<Breadcrumb crumb={deriveCrumb(stack)} onAscend={onAscend} />);
    const breadcrumb = getByRole("navigation", { name: "Breadcrumb" });
    const current = within(breadcrumb).getByRole("button", { name: "Draft" });

    expect(current.getAttribute("aria-current")).toBe("page");
    expect((current as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(current);
    expect(onAscend).not.toHaveBeenCalled();
  });
});
