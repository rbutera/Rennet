// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useRennetStore } from "../store";
import { mount, waitFor } from "../test/dom";
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
  });

  it("line state follows the store: cited (green) for a highlight, plain otherwise", () => {
    const { container } = mount(
      <CodeBlock code={CODE} path={PATH} startLine={1} highlightLines={[2]} />,
    );
    expect(stateOf(2, container)).toBe("cited");
    expect(stateOf(1, container)).toBe("plain");
  });

  it("Copy copies the code and shows its confirmation", async () => {
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    const { getByText, user } = mount(<CodeBlock code={CODE} path={PATH} />);
    await user.click(getByText("Copy"));
    expect(writeText).toHaveBeenCalledWith(CODE);
    await waitFor(() => expect(getByText("Copied")).toBeTruthy());
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
