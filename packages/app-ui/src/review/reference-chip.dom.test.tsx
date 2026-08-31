// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { mount } from "../test/dom";
import { ReferenceChip } from "./reference-chip";

describe("ReferenceChip — the code-ref citation chip", () => {
  it("labels basename:line and titles the full path", () => {
    const { getByRole } = mount(
      <ReferenceChip path="packages/core/src/decompose.ts" startLine={42} />,
    );
    const button = getByRole("button");
    expect(button.textContent).toBe("decompose.ts:42");
    expect(button.getAttribute("title")).toBe("packages/core/src/decompose.ts");
  });

  it("labels a multi-line span as basename:start-end", () => {
    const { getByRole } = mount(<ReferenceChip path="a/b.ts" startLine={10} endLine={20} />);
    expect(getByRole("button").textContent).toBe("b.ts:10-20");
  });

  it("collapses a single-line span (endLine === startLine) to basename:line", () => {
    const { getByRole } = mount(<ReferenceChip path="a/b.ts" startLine={7} endLine={7} />);
    expect(getByRole("button").textContent).toBe("b.ts:7");
  });

  it("reflects active state via aria-pressed", () => {
    const { getByRole, rerender } = mount(<ReferenceChip path="a/b.ts" startLine={1} />);
    expect(getByRole("button").getAttribute("aria-pressed")).toBe("false");
    rerender(<ReferenceChip path="a/b.ts" startLine={1} active />);
    expect(getByRole("button").getAttribute("aria-pressed")).toBe("true");
  });

  it("calls onClick when clicked", async () => {
    const onClick = vi.fn();
    const { getByRole, user } = mount(
      <ReferenceChip path="a/b.ts" startLine={1} onClick={onClick} />,
    );
    await user.click(getByRole("button"));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("an explicit title overrides the default full-path title", () => {
    const { getByRole } = mount(
      <ReferenceChip path="a/b.ts" startLine={1} title="Hide a/b.ts:1" />,
    );
    expect(getByRole("button").getAttribute("title")).toBe("Hide a/b.ts:1");
  });
});
