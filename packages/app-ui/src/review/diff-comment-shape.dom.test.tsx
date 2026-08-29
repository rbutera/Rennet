// @vitest-environment happy-dom
import type { PatchFile } from "@rennet/protocol";
import { beforeEach, describe, expect, it } from "vitest";
import { Router } from "wouter";
import { memoryHistory } from "../routes/history";
import { useRennetStore } from "../store";
import { mount } from "../test/dom";
import { CodeBlock } from "./code-block";
import { DiffView } from "./diff-view";

// The headline invariant (Objective E / packet V5): a comment left on a diff line is the
// IDENTICAL `review.codeComments[path][line]` object a comment left on a board excerpt is.
// Both surfaces write the SAME singleton store slice — so this test drives one comment from
// each surface against the same store and asserts they coincide in the same shape, and that
// a diff-line Request Changes stages the `${path}:${line}` ask exactly as code-block does.
beforeEach(() => useRennetStore.getState().reviewActions.resetReview());

const PATH = "packages/core/src/x.ts";
const PATCHSET_ID = "patchset-live";
const CODE = "const a = 1\nconst b = 2\nconst c = 3";
const FILE: PatchFile = {
  path: PATH,
  status: "modified",
  additions: 1,
  deletions: 1,
  // new-side line 1 = context, line 2 = added.
  binary: false,
  patch: ["@@ -1,2 +1,2 @@", " const a = 1", "-const b = 2", "+const b = 3"].join("\n"),
};

function mountDiff() {
  const history = memoryHistory("/s/x?view=diff");
  return mount(
    <Router hook={history.hook} searchHook={history.searchHook}>
      <DiffView files={[FILE]} patchsetId={PATCHSET_ID} />
    </Router>,
  );
}

describe("diff-line and board-excerpt comments are one object", () => {
  it("a comment from each surface lands in the identical review.codeComments[path][line] shape", async () => {
    // 1) Comment on a DIFF line (new-side line 2).
    const diff = mountDiff();
    await diff.user.click(diff.getByLabelText("Comment on line 2"));
    await diff.user.type(
      diff.getByPlaceholderText("Leave a comment on this line…"),
      "from the diff",
    );
    await diff.user.click(diff.getByText("Save"));
    diff.unmount();

    // 2) Comment on a BOARD code line (code-block line 3) — SAME singleton store, same path.
    const board = mount(<CodeBlock code={CODE} path={PATH} startLine={1} />);
    await board.user.click(board.getByLabelText("Comment on line 3"));
    await board.user.type(
      board.getByPlaceholderText("Leave a comment on this line…"),
      "from the board",
    );
    await board.user.click(board.getByText("Save"));

    // Both writes coincide in the ONE codeComments[path] object, keyed by line.
    expect(useRennetStore.getState().review.codeComments[PATH]).toEqual({
      2: "from the diff",
      3: "from the board",
    });
  });

  it("a diff-line Request Changes sets the comment AND stages the path:line ask", async () => {
    const diff = mountDiff();
    await diff.user.click(diff.getByLabelText("Comment on line 1"));
    await diff.user.type(diff.getByPlaceholderText("Leave a comment on this line…"), "guard this");
    await diff.user.click(diff.getByText("Request Changes"));
    expect(useRennetStore.getState().review.codeComments[PATH]?.[1]).toBe("guard this");
    expect(useRennetStore.getState().review.stagedAsks[`${PATH}:1:RIGHT`]).toEqual({
      id: `${PATH}:1:RIGHT`,
      anchor: `${PATH}:1`,
      type: "request-change",
      body: "guard this",
      side: "RIGHT",
      codeRef: {
        patchsetId: PATCHSET_ID,
        path: PATH,
        side: "head",
        startLine: 1,
        endLine: 1,
      },
    });
  });
});
