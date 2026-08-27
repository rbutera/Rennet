// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useRennetStore } from "../store";
import { act, fireEvent, mount } from "../test/dom";
import { CodeBlock } from "./code-block";

const CODE = "const a = 1\nconst b = 2\nconst c = 3";
const PATH = "packages/core/src/x.ts";

// CodeBlock reads/writes the singleton review slice directly (no bridge). Reset it
// between tests so the "same store across remounts" case is the ONLY shared state.
beforeEach(() => useRennetStore.getState().reviewActions.resetReview());

function stateOf(line: number, container: HTMLElement): string | null {
  return container.querySelector(`[data-line="${line}"]`)?.getAttribute("data-line-state") ?? null;
}

describe("CodeBlock — the one code surface", () => {
  it("clicking a line's comment button opens the editor; Save writes review.codeComments", async () => {
    const { getByLabelText, getByPlaceholderText, getByText, container, user } = mount(
      <CodeBlock code={CODE} path={PATH} startLine={10} />,
    );
    await user.click(getByLabelText("Comment on line 11"));
    await user.type(getByPlaceholderText("Leave a comment on this line…"), "off by one");
    await user.click(getByText("Save"));
    expect(useRennetStore.getState().review.codeComments[PATH]?.[11]).toBe("off by one");
    expect(stateOf(11, container)).toBe("comment");
  });

  it("a saved comment persists its glyph across a remount of the same store", () => {
    useRennetStore.getState().reviewActions.setCodeComment(PATH, 10, "note");
    const first = mount(<CodeBlock code={CODE} path={PATH} startLine={10} />);
    expect(first.getByLabelText("Edit comment on line 10")).toBeTruthy();
    first.unmount();
    const second = mount(<CodeBlock code={CODE} path={PATH} startLine={10} />);
    expect(second.getByLabelText("Edit comment on line 10")).toBeTruthy();
  });

  it("Request Changes saves the comment AND stages a request-change ask; the line reads danger red", async () => {
    const { getByLabelText, getByPlaceholderText, getByText, container, user } = mount(
      <CodeBlock code={CODE} path={PATH} startLine={1} />,
    );
    await user.click(getByLabelText("Comment on line 2"));
    await user.type(getByPlaceholderText("Leave a comment on this line…"), "rename");
    await user.click(getByText("Request Changes"));
    expect(useRennetStore.getState().review.codeComments[PATH]?.[2]).toBe("rename");
    expect(useRennetStore.getState().review.stagedAsks[`${PATH}:2`]).toEqual({
      anchor: `${PATH}:2`,
      type: "request-change",
      body: "rename",
    });
    expect(stateOf(2, container)).toBe("ask");
    // The real danger-red class rides the row, not just the synthetic state attr.
    expect(container.querySelector('[data-line="2"]')?.className).toContain("bg-destructive/25");
  });

  it("a highlight paints the real evidence-green class; the + button is hover-only until used", () => {
    const { container } = mount(
      <CodeBlock code={CODE} path={PATH} startLine={1} highlightLines={[2]} />,
    );
    const cited = container.querySelector('[data-line="2"]');
    const plain = container.querySelector('[data-line="1"]');
    expect(stateOf(2, container)).toBe("cited");
    expect(stateOf(1, container)).toBe("plain");
    // Evidence green rides the cited row; the plain row carries no green.
    expect(cited?.className).toContain("bg-green/15");
    expect(plain?.className).not.toContain("bg-green/15");
    // A commentless line reveals its + button only on hover (hidden until group-hover).
    const plainButton = plain?.querySelector("button");
    expect(plainButton?.className).toContain("hidden");
    expect(plainButton?.className).toContain("group-hover:flex");
  });

  it("Copy copies the code, shows its confirmation, and clears it after the 1.5s timeout", async () => {
    vi.useFakeTimers();
    try {
      const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
      const { getByText } = mount(<CodeBlock code={CODE} path={PATH} />);
      // The async act flushes the clipboard microtask so setCopied(true) applies.
      await act(async () => {
        fireEvent.click(getByText("Copy"));
      });
      expect(writeText).toHaveBeenCalledWith(CODE);
      expect(getByText("Copied")).toBeTruthy();
      // The 1.5s timeout must actually clear the confirmation back to "Copy".
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1500);
      });
      expect(getByText("Copy")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("the header path is an inert label by default, and a nav button when onOpenPath is passed", async () => {
    const plain = mount(<CodeBlock code={CODE} path={PATH} />);
    expect(plain.getByText(PATH).tagName).toBe("SPAN");
    plain.unmount();

    const onOpenPath = vi.fn();
    const { getByText, user } = mount(
      <CodeBlock code={CODE} path={PATH} onOpenPath={onOpenPath} />,
    );
    const pathButton = getByText(PATH);
    expect(pathButton.tagName).toBe("BUTTON");
    await user.click(pathButton);
    expect(onOpenPath).toHaveBeenCalledWith(PATH);
  });

  it("renders the counterpart button exactly when passed, and calls onView", async () => {
    const onView = vi.fn();
    const without = mount(<CodeBlock code={CODE} path={PATH} />);
    expect(without.queryByText("View test")).toBeNull();
    without.unmount();
    const { getByText, user } = mount(
      <CodeBlock
        code={CODE}
        path={PATH}
        counterpart={{ label: "View test", path: "x.test.ts", onView }}
      />,
    );
    await user.click(getByText("View test"));
    expect(onView).toHaveBeenCalledTimes(1);
  });
});
