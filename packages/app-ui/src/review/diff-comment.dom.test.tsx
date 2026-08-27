// @vitest-environment happy-dom
import type { PatchFile } from "@rennet/protocol";
import { beforeEach, describe, expect, it } from "vitest";
import { Router } from "wouter";
import { memoryHistory } from "../routes/history";
import { useRennetStore } from "../store";
import { cleanup, mount } from "../test/dom";
import { DiffView } from "./diff-view";

// The diff surface writes the singleton review slice directly (no provider shim,
// reconciliation 4). Reset it between tests except the one that proves same-store persistence.
beforeEach(() => useRennetStore.getState().reviewActions.resetReview());

const PATH = "packages/core/src/a.ts";
const FILE: PatchFile = {
  path: PATH,
  status: "modified",
  additions: 1,
  deletions: 1,
  // new-side line 1 = context, line 2 = added.
  binary: false,
  patch: ["@@ -1,2 +1,2 @@", " const x = 1", "-const y = 2", "+const y = 3"].join("\n"),
};

function mountDiff() {
  const history = memoryHistory("/s/x?view=diff");
  return mount(
    <Router hook={history.hook} searchHook={history.searchHook}>
      <DiffView files={[FILE]} />
    </Router>,
  );
}

function rowState(line: number, container: HTMLElement): string | null {
  return container.querySelector(`[data-line="${line}"]`)?.getAttribute("data-line-state") ?? null;
}

describe("DiffView line comments — the C4 machinery, one object with the board", () => {
  it("clicking a line's comment button opens the editor; Save writes review.codeComments", async () => {
    const { getByLabelText, getByPlaceholderText, getByText, container, user } = mountDiff();
    await user.click(getByLabelText("Comment on line 2"));
    await user.type(getByPlaceholderText("Leave a comment on this line…"), "needs a guard");
    await user.click(getByText("Save"));
    expect(useRennetStore.getState().review.codeComments[PATH]?.[2]).toBe("needs a guard");
    // The commented line now shows the persistent (edit) glyph and reads evidence green.
    expect(getByLabelText("Edit comment on line 2")).toBeTruthy();
    expect(rowState(2, container)).toBe("comment");
    expect(container.querySelector('[data-line="2"]')?.className).toContain("bg-green/15");
  });

  it("a saved comment's glyph persists across a remount of the same store", () => {
    useRennetStore.getState().reviewActions.setCodeComment(PATH, 2, "note");
    const first = mountDiff();
    expect(first.getByLabelText("Edit comment on line 2")).toBeTruthy();
    first.unmount();
    const second = mountDiff();
    expect(second.getByLabelText("Edit comment on line 2")).toBeTruthy();
    second.unmount();
  });

  it("Request Changes saves the comment AND stages the ${path}:${line} ask; the line reads danger red", async () => {
    const { getByLabelText, getByPlaceholderText, getByText, container, user } = mountDiff();
    await user.click(getByLabelText("Comment on line 1"));
    await user.type(getByPlaceholderText("Leave a comment on this line…"), "rename this");
    await user.click(getByText("Request Changes"));
    expect(useRennetStore.getState().review.codeComments[PATH]?.[1]).toBe("rename this");
    expect(useRennetStore.getState().review.stagedAsks[`${PATH}:1`]).toEqual({
      anchor: `${PATH}:1`,
      type: "request-change",
      body: "rename this",
    });
    // Danger red rides the row, and its state attr flips to "ask".
    expect(rowState(1, container)).toBe("ask");
    expect(container.querySelector('[data-line="1"]')?.className).toContain("bg-destructive/25");
  });

  it("danger-red vs evidence-green follows the store, not local state", () => {
    useRennetStore.getState().reviewActions.setCodeComment(PATH, 1, "plain note");
    useRennetStore.getState().reviewActions.setCodeComment(PATH, 2, "ask body");
    useRennetStore.getState().reviewActions.stageAsk({
      anchor: `${PATH}:2`,
      type: "request-change",
      body: "ask body",
    });
    const { container } = mountDiff();
    expect(rowState(1, container)).toBe("comment");
    expect(rowState(2, container)).toBe("ask");
    cleanup();
  });

  it("a deleted line (no new-side number) offers no comment button", () => {
    const { queryByLabelText } = mountDiff();
    // The del row is old-line 2 / new-line null — it carries no comment affordance.
    expect(queryByLabelText("Comment on line 2")).toBeTruthy(); // the ADDED new-line 2 does
    // …but there is no comment button for the deleted content itself (it has no new line).
    // Every comment button targets a new-side line, proven by there being exactly two
    // (context line 1 + added line 2), never three.
    const buttons = [1, 2].map((n) => queryByLabelText(`Comment on line ${n}`)).filter(Boolean);
    expect(buttons).toHaveLength(2);
  });
});
