// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRennetStore } from "../store";
import { act, mount } from "../test/dom";
import { ProseSelectionLayer } from "./selection-toolbar";

const PROSE = "The decomposition must preserve every hunk boundary.";

function reviewState() {
  return useRennetStore.getState().review;
}

/** Select the contents of `el`, then fire the document mouseup the layer listens for. */
function selectAndRelease(el: Element) {
  const range = document.createRange();
  range.selectNodeContents(el);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  act(() => {
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  });
}

function proseLayer() {
  return mount(
    <ProseSelectionLayer>
      <p>{PROSE}</p>
    </ProseSelectionLayer>,
  );
}

beforeEach(() => useRennetStore.getState().reviewActions.resetReview());
afterEach(() => vi.restoreAllMocks());

describe("ProseSelectionLayer — board-prose selection controls", () => {
  it("selecting text shows the toolbar verbs", () => {
    const { getByText } = proseLayer();
    selectAndRelease(getByText(PROSE));
    expect(getByText("Comment")).toBeTruthy();
    expect(getByText("Request Changes")).toBeTruthy();
    expect(getByText("Explain")).toBeTruthy();
  });

  it("Comment mints a quote thread on the selected span and focuses it", async () => {
    const { getByText, getByPlaceholderText, user } = proseLayer();
    selectAndRelease(getByText(PROSE));
    await user.click(getByText("Comment"));
    await user.type(getByPlaceholderText("Ask a question or leave a comment…"), "cite the hunk");
    await user.click(getByText("Save"));
    const threads = Object.values(reviewState().quoteThreads);
    expect(threads).toHaveLength(1);
    expect(threads[0]).toEqual({
      anchor: PROSE,
      kind: "comment",
      messages: [{ author: "user", text: "cite the hunk" }],
    });
    const [id] = Object.keys(reviewState().quoteThreads);
    expect(reviewState().focusedThreadId).toBe(id);
  });

  it("Explain mints an explain-kind thread (which never raises the exit count)", async () => {
    const { getByText, user } = proseLayer();
    selectAndRelease(getByText(PROSE));
    await user.click(getByText("Explain"));
    const threads = Object.values(reviewState().quoteThreads);
    expect(threads).toHaveLength(1);
    expect(threads[0]?.kind).toBe("explain");
    // Explain stages no ask.
    expect(Object.keys(reviewState().stagedAsks)).toHaveLength(0);
  });

  it("Request Changes mints a thread AND stages an ask that claims that thread", async () => {
    const { getByText, getByPlaceholderText, user } = proseLayer();
    selectAndRelease(getByText(PROSE));
    await user.click(getByText("Request Changes"));
    await user.type(getByPlaceholderText("What change are you requesting?"), "guard the boundary");
    await user.click(getByText("Stage"));
    const [id] = Object.keys(reviewState().quoteThreads);
    expect(id).toBeDefined();
    // The ask's anchor IS the thread id — one exit, not two.
    expect(reviewState().stagedAsks[id as string]).toEqual({
      anchor: id,
      type: "request-change",
      body: "guard the boundary",
    });
  });

  it("Escape and an outside click both dismiss the toolbar", () => {
    const { getByText, queryByText } = proseLayer();
    selectAndRelease(getByText(PROSE));
    expect(getByText("Comment")).toBeTruthy();
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(queryByText("Comment")).toBeNull();

    // Reopen, then dismiss by a collapsed (outside) selection.
    selectAndRelease(getByText(PROSE));
    expect(getByText("Comment")).toBeTruthy();
    act(() => {
      window.getSelection()?.removeAllRanges();
      document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    });
    expect(queryByText("Comment")).toBeNull();
  });

  it("flips the panel below the selection near the viewport top, above it otherwise", () => {
    const rect = vi.spyOn(Range.prototype, "getBoundingClientRect");

    // Near the top (top < 240) → placement below → no upward translate.
    rect.mockReturnValue({
      top: 12,
      bottom: 30,
      left: 0,
      right: 0,
      width: 100,
      height: 18,
    } as DOMRect);
    const near = proseLayer();
    selectAndRelease(near.getByText(PROSE));
    expect(
      near.container.querySelector(".absolute.z-50")?.classList.contains("-translate-y-full"),
    ).toBe(false);
    near.unmount();

    // Lower down (top >= 240) → placement above → upward translate.
    rect.mockReturnValue({
      top: 600,
      bottom: 618,
      left: 0,
      right: 0,
      width: 100,
      height: 18,
    } as DOMRect);
    const far = proseLayer();
    selectAndRelease(far.getByText(PROSE));
    expect(
      far.container.querySelector(".absolute.z-50")?.classList.contains("-translate-y-full"),
    ).toBe(true);
  });
});
