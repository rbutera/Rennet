// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRennetStore } from "../store";
import { act, mount } from "../test/dom";
import { type AnchoredAskInput, AnchoredAskProvider } from "./anchored-ask";
import { RichText } from "./rich-text";
import { ProseSelectionLayer } from "./selection-toolbar";

const PROSE = "The decomposition must preserve every hunk boundary.";

function reviewState() {
  return useRennetStore.getState().review;
}

/** Select the contents of `el`, then fire the mouseup ON `el` (a release inside the
 *  prose, the real anchoring gesture — target is the selected element, not `document`). */
function selectAndRelease(el: Element) {
  const range = document.createRange();
  range.selectNodeContents(el);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  act(() => {
    el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
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

  it("Explain maps display text to raw markdown and sends one anchored turn", async () => {
    const sent: AnchoredAskInput[] = [];
    const view = mount(
      <AnchoredAskProvider
        value={async (input) => {
          sent.push(input);
        }}
      >
        <ProseSelectionLayer>
          <article data-generation="gen-1" data-quote-target="finding-1">
            <RichText text="Call `decompose()` before dispatch." patchsetId="ps-1" />
          </article>
        </ProseSelectionLayer>
      </AnchoredAskProvider>,
    );
    selectAndRelease(view.getByText("decompose()"));
    await view.user.click(view.getByText("Explain"));

    const [threadId] = Object.keys(reviewState().quoteThreads);
    expect(reviewState().quoteThreads[threadId ?? ""]?.anchor).toBe("`decompose()`");
    expect(sent).toEqual([
      {
        threadId,
        question: "Explain this passage.",
        excerpt: "`decompose()`",
        target: "finding-1",
        generation: "gen-1",
      },
    ]);
  });

  it("scopes only text rendered by a durable quote target", async () => {
    const view = mount(
      <ProseSelectionLayer>
        <article data-generation="gen-1" data-element-id="requirement-1">
          <p data-quote-target="requirement-1">The host SHALL resume the round.</p>
          <span>Status in progress</span>
        </article>
      </ProseSelectionLayer>,
    );

    selectAndRelease(view.getByText("The host SHALL resume the round."));
    await view.user.click(view.getByText("Explain"));
    selectAndRelease(view.getByText("Status in progress"));
    await view.user.click(view.getByText("Explain"));

    const threads = Object.values(reviewState().quoteThreads);
    expect(threads).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          anchor: "The host SHALL resume the round.",
          target: "requirement-1",
          generation: "gen-1",
        }),
        expect.objectContaining({ anchor: "Status in progress" }),
      ]),
    );
    const metadataThread = threads.find((thread) => thread.anchor === "Status in progress");
    expect(metadataThread?.target).toBeUndefined();
    expect(metadataThread?.generation).toBeUndefined();
  });

  it("Request Changes mints a thread AND stages an ask that claims that thread", async () => {
    const { getByText, getByPlaceholderText, user } = proseLayer();
    selectAndRelease(getByText(PROSE));
    await user.click(getByText("Request Changes"));
    await user.type(getByPlaceholderText("What change are you requesting?"), "guard the boundary");
    await user.click(getByText("Stage"));
    const [id] = Object.keys(reviewState().quoteThreads);
    if (!id) throw new Error("expected a minted quote thread");
    // The ask is keyed by its IDENTITY (the minted thread id), keeps the quoted span as source
    // provenance, AND claims the thread by id — distinct fields, so two request-changes on identical
    // prose stay separate and an exit tally counts the thread once without conflation.
    expect(reviewState().stagedAsks[id]).toEqual({
      id,
      anchor: PROSE,
      type: "request-change",
      body: "guard the boundary",
      threadId: id,
    });
  });

  it("Escape and a collapsed selection both dismiss the toolbar", () => {
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

  it("a release targeting outside the container dismisses even with a live selection", () => {
    const { getByText, queryByText } = proseLayer();
    selectAndRelease(getByText(PROSE));
    expect(getByText("Comment")).toBeTruthy();
    // A real outside click: mouseup targeted on <body> (outside the prose container),
    // WITHOUT clearing the still-live internal selection.
    act(() => {
      document.body.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    });
    expect(queryByText("Comment")).toBeNull();
    // The selection was deliberately left intact — this proves the target check, not
    // the collapsed-selection path.
    expect(window.getSelection()?.isCollapsed).toBe(false);
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

describe("code selections retain immutable range identity", () => {
  const codeRef = {
    patchsetId: "ps-reviewed",
    path: "old-name.ts",
    side: "base",
    startLine: 9,
    endLine: 10,
  };
  /** `wrapper` mirrors what really renders the attribute: the board is an `<article
   *  data-lens>` (`board-view.tsx`), the seat transcript drawer an `<aside data-lens>`. */
  function codeLayer(
    sent: AnchoredAskInput[],
    lens?: string,
    wrapper: "article" | "aside" = "article",
  ) {
    const Wrapper = wrapper;
    return mount(
      <AnchoredAskProvider
        value={async (input) => {
          sent.push(input);
        }}
      >
        <ProseSelectionLayer>
          <Wrapper {...(lens === undefined ? {} : { "data-lens": lens })}>
            <span
              data-code-patchset="ps-reviewed"
              data-code-path="old-name.ts"
              data-code-side="base"
              data-code-line="9"
            >
              removed one
            </span>
            <span
              data-code-patchset="ps-reviewed"
              data-code-path="old-name.ts"
              data-code-side="base"
              data-code-line="10"
            >
              removed two
            </span>
          </Wrapper>
        </ProseSelectionLayer>
      </AnchoredAskProvider>,
    );
  }
  function selectCode(view: ReturnType<typeof codeLayer>) {
    const first = view.getByText("removed one");
    const last = view.getByText("removed two");
    const range = document.createRange();
    range.setStart(first.firstChild ?? first, 0);
    range.setEnd(last.firstChild ?? last, "removed two".length);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    act(() => last.dispatchEvent(new MouseEvent("mouseup", { bubbles: true })));
  }
  it("Comment saves patchset, old path, base side and the whole selected range", async () => {
    const view = codeLayer([]);
    selectCode(view);
    await view.user.click(view.getByText("Comment"));
    await view.user.type(
      view.getByPlaceholderText("Ask a question or leave a comment…"),
      "Keep this",
    );
    await view.user.click(view.getByText("Save"));
    expect(Object.values(reviewState().quoteThreads)[0]?.codeRef).toEqual(codeRef);
  });
  // session-thread-briefing 4.3: an Explain has to say WHICH board the span came from, and
  // the board article is the only thing that knows (`board-view.tsx` renders `data-lens`).
  // A `CodeRef` carries the patchset, path, side and lines and nothing about the board.
  it("carries the board's lens off the DOM when the selection was made on a board", async () => {
    const sent: AnchoredAskInput[] = [];
    const view = codeLayer(sent, "flagged");
    selectCode(view);
    await view.user.click(view.getByText("Explain"));
    expect(sent[0]?.lens).toBe("flagged");
  });

  it("carries no lens when the selection was made outside a board, rather than inventing one", async () => {
    const sent: AnchoredAskInput[] = [];
    const view = codeLayer(sent);
    selectCode(view);
    await view.user.click(view.getByText("Explain"));
    expect(sent[0]?.lens).toBeUndefined();
    // Not vacuous: the same click DID carry the range, so the ask itself went out.
    expect(sent[0]?.codeRef).toEqual(codeRef);
  });

  it("carries no lens for a span highlighted in a seat transcript, not the board's", async () => {
    // The seat-transcript drawer is an `<aside data-lens>`, so a bare `closest("[data-lens]")`
    // labelled a span from a seat's scrollback as having come from that lens's BOARD. It did
    // not, and the thread would go looking on the board for a line that is not there.
    const sent: AnchoredAskInput[] = [];
    const view = codeLayer(sent, "flagged", "aside");
    selectCode(view);
    await view.user.click(view.getByText("Explain"));
    expect(sent[0]?.lens).toBeUndefined();
    expect(sent[0]?.codeRef).toEqual(codeRef);
  });

  it("Explain sends the same immutable range and Request Changes stages it", async () => {
    const sent: AnchoredAskInput[] = [];
    const view = codeLayer(sent);
    selectCode(view);
    await view.user.click(view.getByText("Explain"));
    expect(sent[0]?.codeRef).toEqual(codeRef);
    selectCode(view);
    await view.user.click(view.getByText("Request Changes"));
    await view.user.type(
      view.getByPlaceholderText("What change are you requesting?"),
      "Restore these",
    );
    await view.user.click(view.getByText("Stage"));
    expect(Object.values(reviewState().stagedAsks)[0]?.codeRef).toEqual(codeRef);
  });
});

it("does not turn a cross-side code selection into a quote without provenance", () => {
  const view = mount(
    <ProseSelectionLayer>
      <div>
        <span
          data-code-patchset="ps"
          data-code-path="code.ts"
          data-code-side="base"
          data-code-line="1"
        >
          old
        </span>
        <span
          data-code-patchset="ps"
          data-code-path="code.ts"
          data-code-side="head"
          data-code-line="1"
        >
          new
        </span>
      </div>
    </ProseSelectionLayer>,
  );
  const first = view.getByText("old");
  const last = view.getByText("new");
  const range = document.createRange();
  range.setStart(first.firstChild ?? first, 0);
  range.setEnd(last.firstChild ?? last, 3);
  window.getSelection()?.removeAllRanges();
  window.getSelection()?.addRange(range);
  act(() => last.dispatchEvent(new MouseEvent("mouseup", { bubbles: true })));
  expect(view.getByText("Select lines within one file and one side of the diff.")).toBeTruthy();
  expect(view.queryByText("Comment")).toBeNull();
  expect(Object.values(reviewState().quoteThreads)).toHaveLength(0);
});
