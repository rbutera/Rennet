// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { mount } from "../test/dom";
import { LineCommentEditor } from "./line-comment-editor";

// A bare host — the editor takes ONLY callbacks (no store, no bridge), which is what
// lets the SAME comment object mint from any surface (headline invariant).

describe("LineCommentEditor — the one editor", () => {
  it("Save with text calls onSave(text)", async () => {
    const onSave = vi.fn();
    const { getByPlaceholderText, getByText, user } = mount(
      <LineCommentEditor
        lineLabel="L42"
        initialText=""
        hasComment={false}
        onCancel={vi.fn()}
        onSave={onSave}
        onRequestChanges={vi.fn()}
      />,
    );
    await user.type(getByPlaceholderText("Leave a comment on this line…"), "needs a guard");
    await user.click(getByText("Save"));
    expect(onSave).toHaveBeenCalledWith("needs a guard");
  });

  it("Save with empty text clears via onSave(null)", async () => {
    const onSave = vi.fn();
    const { getByText, user } = mount(
      <LineCommentEditor
        lineLabel="L1"
        initialText=""
        hasComment={false}
        onCancel={vi.fn()}
        onSave={onSave}
        onRequestChanges={vi.fn()}
      />,
    );
    await user.click(getByText("Save"));
    expect(onSave).toHaveBeenCalledWith(null);
  });

  it("Delete shows only when a comment exists, and calls onSave(null)", async () => {
    const onSave = vi.fn();
    const bare = mount(
      <LineCommentEditor
        lineLabel="L1"
        initialText=""
        hasComment={false}
        onCancel={vi.fn()}
        onSave={vi.fn()}
        onRequestChanges={vi.fn()}
      />,
    );
    expect(bare.queryByText("Delete")).toBeNull();
    bare.unmount();

    const { getByText, user } = mount(
      <LineCommentEditor
        lineLabel="L1"
        initialText="old note"
        hasComment={true}
        onCancel={vi.fn()}
        onSave={onSave}
        onRequestChanges={vi.fn()}
      />,
    );
    await user.click(getByText("Delete"));
    expect(onSave).toHaveBeenCalledWith(null);
  });

  it("Request Changes calls onRequestChanges with trimmed text (and never with empty)", async () => {
    const onRequestChanges = vi.fn();
    const { getByPlaceholderText, getByText, user } = mount(
      <LineCommentEditor
        lineLabel="L7"
        initialText=""
        hasComment={false}
        onCancel={vi.fn()}
        onSave={vi.fn()}
        onRequestChanges={onRequestChanges}
      />,
    );
    // Empty → no call.
    await user.click(getByText("Request Changes"));
    expect(onRequestChanges).not.toHaveBeenCalled();
    await user.type(getByPlaceholderText("Leave a comment on this line…"), "  rename this  ");
    await user.click(getByText("Request Changes"));
    expect(onRequestChanges).toHaveBeenCalledWith("rename this");
  });

  it("Cancel button and Escape both call onCancel", async () => {
    const onCancel = vi.fn();
    const { getByPlaceholderText, getByText, user } = mount(
      <LineCommentEditor
        lineLabel="L7"
        initialText=""
        hasComment={false}
        onCancel={onCancel}
        onSave={vi.fn()}
        onRequestChanges={vi.fn()}
      />,
    );
    await user.click(getByText("Cancel"));
    expect(onCancel).toHaveBeenCalledTimes(1);
    getByPlaceholderText("Leave a comment on this line…").focus();
    await user.keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalledTimes(2);
  });
});
