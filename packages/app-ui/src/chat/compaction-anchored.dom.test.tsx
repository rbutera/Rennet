// @vitest-environment happy-dom
//
// C07 cluster 5 (task 5.3): anchored threads render transcript-side from `review.quoteThreads`
// and focus on `review.focusedThreadId` (reconciliation 6, #466); a `compact_boundary` row
// renders with the honest ask-don't-estimate meter (reconciliation 7); a projection reporting
// NO context figure renders "unknown", never a fabricated number.
import { afterEach, describe, expect, it } from "vitest";
import { useRennetStore } from "../store";
import { act, cleanup, mount, screen } from "../test/dom";
import type { TranscriptRow } from "./chat-data";
import { ConversationPane } from "./conversation-pane";

const EMPTY_LIVE: ReadonlySet<string> = new Set();

afterEach(() => {
  cleanup();
  act(() => useRennetStore.getState().reviewActions.resetReview());
});

describe("anchored thread transcript-side (task 5.3)", () => {
  it("renders a quote thread's messages, keyed by its board ref, and focuses on focusedThreadId", () => {
    let threadId = "";
    act(() => {
      threadId = useRennetStore
        .getState()
        .reviewActions.addQuoteComment("the scoping middleware", "why does this run before auth?");
      useRennetStore
        .getState()
        .reviewActions.addQuoteReply(threadId, "orchestrator", "it doesn't — auth is first.");
    });
    const row: TranscriptRow = { kind: "anchored-thread", threadId, boardRef: "board-ref-7" };
    const { rerender } = mount(<ConversationPane rows={[row]} liveIds={EMPTY_LIVE} />);

    const card = screen.getByTestId("anchored-thread");
    expect(card.getAttribute("data-board-ref")).toBe("board-ref-7");
    expect(screen.getByText(/why does this run before auth/)).toBeTruthy();
    expect(screen.getByText(/it doesn't — auth is first/)).toBeTruthy();
    expect(card.getAttribute("data-focused")).toBe("false");

    // Focus follows the store's focusedThreadId.
    act(() => useRennetStore.getState().reviewActions.setFocusedThread(threadId));
    rerender(<ConversationPane rows={[row]} liveIds={EMPTY_LIVE} />);
    expect(screen.getByTestId("anchored-thread").getAttribute("data-focused")).toBe("true");
  });

  it("renders nothing for a ref whose thread is gone (no orphan card)", () => {
    const row: TranscriptRow = { kind: "anchored-thread", threadId: "missing", boardRef: "r1" };
    mount(<ConversationPane rows={[row]} liveIds={EMPTY_LIVE} />);
    expect(screen.queryByTestId("anchored-thread")).toBeNull();
  });
});

describe("honest compaction (task 5.3, reconciliation 7)", () => {
  it("renders a compact_boundary row with the harness-reported figures", () => {
    const row: TranscriptRow = {
      kind: "compact-boundary",
      id: "cb1",
      tokensBefore: 128000,
      tokensAfter: 24000,
    };
    mount(<ConversationPane rows={[row]} liveIds={EMPTY_LIVE} />);
    expect(screen.getByTestId("compaction-row")).toBeTruthy();
    expect(screen.getByText(/128k → 24k tokens/)).toBeTruthy();
  });

  it("shows the current context window figure when the projection carries one", () => {
    const row: TranscriptRow = { kind: "compact-boundary", id: "cb2" };
    mount(
      <ConversationPane
        rows={[row]}
        liveIds={EMPTY_LIVE}
        contextWindow={{ used: 60000, limit: 200000 }}
      />,
    );
    expect(screen.getByText(/60k \/ 200k tokens \(30%\)/)).toBeTruthy();
  });

  it("renders 'unknown', not a number, when the harness reports no figure", () => {
    const row: TranscriptRow = { kind: "compact-boundary", id: "cb3" };
    const { container } = mount(<ConversationPane rows={[row]} liveIds={EMPTY_LIVE} />);
    expect(screen.getByText(/context unknown/)).toBeTruthy();
    // The honest meter carries no digits at all.
    const meter = container.querySelector('[data-context="unknown"]');
    expect(meter?.textContent).not.toMatch(/\d/);
    expect(container.querySelector('[data-context="reported"]')).toBeNull();
  });
});
