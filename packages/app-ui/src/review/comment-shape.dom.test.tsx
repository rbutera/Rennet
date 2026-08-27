// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { useRennetStore } from "../store";
import { mount } from "../test/dom";
import { CodeBlock } from "./code-block";
import { LineCommentEditor } from "./line-comment-editor";

// Headline invariant (verification 8.2): a comment created from a board excerpt (via
// CodeBlock's embedded LineCommentEditor) and a comment created from a diff line (the
// SAME editor, a diff-row host wiring, no CodeView needed) land in the IDENTICAL
// review.codeComments[path][line] shape in the SAME store.

const BOARD_PATH = "packages/core/src/board.ts";
const DIFF_PATH = "packages/core/src/diff.ts";
const CODE = "const a = 1\nconst b = 2\nconst c = 3";

beforeEach(() => useRennetStore.getState().reviewActions.resetReview());

describe("headline invariant — one comment shape from every surface", () => {
  it("a board-excerpt comment and a diff-line comment land in the same store shape", async () => {
    // Surface 1: the board excerpt — CodeBlock owns the editor and the store wiring.
    const board = mount(<CodeBlock code={CODE} path={BOARD_PATH} startLine={40} />);
    await board.user.click(board.getByLabelText("Comment on line 41"));
    await board.user.type(
      board.getByPlaceholderText("Leave a comment on this line…"),
      "board note",
    );
    await board.user.click(board.getByText("Save"));

    // Surface 2: a diff line — the SAME LineCommentEditor, wired exactly as a diff-row
    // host wires it (onSave → setCodeComment), against the SAME singleton store.
    const { setCodeComment } = useRennetStore.getState().reviewActions;
    const diff = mount(
      <LineCommentEditor
        lineLabel="L88"
        initialText=""
        hasComment={false}
        onCancel={() => undefined}
        onSave={(text) => {
          if (text !== null) setCodeComment(DIFF_PATH, 88, text);
        }}
        onRequestChanges={() => undefined}
      />,
    );
    await diff.user.type(diff.getByPlaceholderText("Leave a comment on this line…"), "diff note");
    await diff.user.click(diff.getByText("Save"));

    const comments = useRennetStore.getState().review.codeComments;
    const boardComment = comments[BOARD_PATH]?.[41];
    const diffComment = comments[DIFF_PATH]?.[88];
    // Both wrote a string body under their own path→line key — one shape, two surfaces.
    expect(boardComment).toBe("board note");
    expect(diffComment).toBe("diff note");
    expect(typeof boardComment).toBe(typeof diffComment);
    // The store shape is path → line → string, identical for both entries.
    expect(comments[BOARD_PATH]).toEqual({ 41: "board note" });
    expect(comments[DIFF_PATH]).toEqual({ 88: "diff note" });
  });
});
