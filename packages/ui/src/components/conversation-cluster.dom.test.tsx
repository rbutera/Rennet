// @vitest-environment happy-dom
//
// The INLINE CONVERSATION CLUSTER (issue #36). Mounted-DOM proof that:
//   • a thread can be OPENED on an anchor (the discuss verb fires with the anchor),
//   • the panel renders PRIVATE (blue backlight, a lock, data-lane="blue"),
//   • promote affordances appear on harness answers ONLY and fire the deliberate
//     promotion act with the right (messageId, kind),
//   • the composer asks about these lines and clears itself,
//   • and — the load-bearing law — opening/growing a thread does NOT reflow the diff
//     column (the margin is a sibling; the diff DOM is unchanged).

import { describe, expect, it } from "vitest";
import type { ConversationAnchor } from "../canvas/conversation";
import {
  answerInThread,
  askInThread,
  demoConversationThread,
  openThread,
} from "../canvas/conversation";
import { cleanup, fireEvent, mount } from "../test/dom";
import { ConversationCluster, ConversationMargin, DiscussControl } from "./conversation-cluster";

const RANGE_ANCHOR: ConversationAnchor = {
  kind: "range",
  label: "src/rate/bucket.ts",
  key: "src/rate/bucket.ts#L44-47",
};

describe("DiscussControl — opening a thread on an anchor", () => {
  it("fires onDiscuss with the anchor when pressed (a thread can be opened)", () => {
    const opened: ConversationAnchor[] = [];
    const { container } = mount(
      <DiscussControl anchor={RANGE_ANCHOR} onDiscuss={(anchor) => opened.push(anchor)} />,
    );
    const button = container.querySelector<HTMLButtonElement>(".discuss-control");
    expect(button?.getAttribute("data-anchor-kind")).toBe("range");
    expect(button?.getAttribute("data-lane")).toBe("blue");
    if (!button) throw new Error("no discuss control");
    fireEvent.click(button);
    expect(opened).toEqual([RANGE_ANCHOR]);
  });
});

describe("ConversationCluster — the private thread panel", () => {
  it("renders in the private (blue/backlight) lane with a locked header", () => {
    const { container } = mount(<ConversationCluster thread={demoConversationThread()} />);
    const panel = container.querySelector(".conversation-cluster");
    expect(panel?.classList.contains("is-private")).toBe(true);
    expect(panel?.getAttribute("data-lane")).toBe("blue");
    expect(panel?.getAttribute("data-route")).toBe("orchestrator");
    expect(container.querySelector(".conversation-head-lock")).not.toBeNull();
    // The anchor range pill (defaults to the anchor label) is shown.
    expect(container.querySelector(".conversation-head-anchor")?.textContent).toBe(
      "src/rate/bucket.ts:44-47",
    );
  });

  it("renders the you/harness messages, labelling the harness card", () => {
    const { container } = mount(<ConversationCluster thread={demoConversationThread()} />);
    const messages = container.querySelectorAll(".thread-message");
    expect(messages).toHaveLength(2);
    expect(messages[0]?.getAttribute("data-author")).toBe("you");
    expect(messages[1]?.getAttribute("data-author")).toBe("harness");
    expect(container.querySelector(".thread-message-model")?.textContent).toContain("Claude Code");
  });

  it("shows promote affordances on harness answers ONLY, and fires the deliberate act", () => {
    const promotions: Array<[string, string]> = [];
    const { container } = mount(
      <ConversationCluster
        thread={demoConversationThread()}
        onPromote={(messageId, kind) => promotions.push([messageId, kind])}
      />,
    );
    // The "you" message carries no promote footer; the harness message does.
    const youCard = container.querySelector('.thread-message[data-author="you"]');
    expect(youCard?.querySelector(".thread-message-promote")).toBeNull();

    const finding = container.querySelector<HTMLButtonElement>(
      '.thread-promote-btn[data-kind="finding"]',
    );
    const draft = container.querySelector<HTMLButtonElement>(
      '.thread-promote-btn[data-kind="draft-comment"]',
    );
    if (!finding || !draft) throw new Error("missing promote controls");
    fireEvent.click(finding);
    fireEvent.click(draft);
    expect(promotions).toEqual([
      ["m2", "finding"],
      ["m2", "draft-comment"],
    ]);
  });

  it("asks about these lines through the composer, then clears the draft", () => {
    const asked: Array<[string, string]> = [];
    const { container } = mount(
      <ConversationCluster
        thread={demoConversationThread()}
        onAsk={(body, mode) => asked.push([body, mode])}
      />,
    );
    const input = container.querySelector<HTMLTextAreaElement>(".conversation-composer-input");
    const send = container.querySelector<HTMLButtonElement>(".conversation-composer-send");
    if (!input || !send) throw new Error("no composer");
    // Empty → send disabled.
    expect(send.disabled).toBe(true);
    fireEvent.change(input, { target: { value: "  does this cap the outage?  " } });
    expect(send.disabled).toBe(false);
    fireEvent.click(send);
    // The default routing is the orchestrator — the caret was never touched.
    expect(asked).toEqual([["does this cap the outage?", "orchestrator"]]);
    // The composer clears after asking.
    expect(input.value).toBe("");
  });

  it("opts a turn into 'both' via the caret and emits that mode on send", () => {
    const asked: Array<[string, string]> = [];
    const { container } = mount(
      <ConversationCluster
        thread={demoConversationThread()}
        onAsk={(body, mode) => asked.push([body, mode])}
      />,
    );
    const caret = container.querySelector<HTMLButtonElement>(".conversation-composer-caret");
    if (!caret) throw new Error("no routing caret");
    // No menu until the caret opens it.
    expect(container.querySelector(".conversation-route-menu")).toBeNull();
    fireEvent.click(caret);
    const bothOption = container.querySelector<HTMLButtonElement>(
      '.conversation-route-item[data-mode="both"]',
    );
    if (!bothOption) throw new Error("no 'both' menu item");
    fireEvent.click(bothOption);
    // Picking an option closes the menu.
    expect(container.querySelector(".conversation-route-menu")).toBeNull();

    const input = container.querySelector<HTMLTextAreaElement>(".conversation-composer-input");
    const send = container.querySelector<HTMLButtonElement>(".conversation-composer-send");
    if (!input || !send) throw new Error("no composer");
    fireEvent.change(input, { target: { value: "seconds or ms?" } });
    fireEvent.click(send);
    expect(asked).toEqual([["seconds or ms?", "both"]]);
  });

  it("omits the composer entirely when no onAsk is given", () => {
    const { container } = mount(<ConversationCluster thread={demoConversationThread()} />);
    expect(container.querySelector(".conversation-composer")).toBeNull();
  });
});

describe("the CSS split contract in isolation (the SHIPPED app is proven separately)", () => {
  // ⚠️ This host is HAND-BUILT — it constructs the `.review-heart-split` / `.diff-column`
  // structure itself, so it proves only the NARROW CSS contract: GIVEN the split, a
  // sibling margin does not change the diff column's node count. It CANNOT prove the
  // shipped app renders that structure — a test that builds its own wrapper can't fail
  // on the wrapper being absent. That end-to-end proof lives in
  // `app.conversation-cluster.dom.test.tsx` (whole-`RennetApp` mount), which is where a
  // regression that unnests the host from the split actually reddens.
  function Host({ threads }: { threads: Parameters<typeof ConversationMargin>[0]["threads"] }) {
    return (
      <div className="review-heart-split">
        <div className="diff-column" data-testid="diff">
          <div className="code-view-row">line 44</div>
          <div className="code-view-row">line 45</div>
          <div className="code-view-row">line 46</div>
          <div className="code-view-row">line 47</div>
        </div>
        <ConversationMargin threads={threads} />
      </div>
    );
  }

  function diffNodeCount(container: HTMLElement): number {
    const diff = container.querySelector('[data-testid="diff"]');
    return diff ? diff.querySelectorAll("*").length : -1;
  }

  it("the diff column node count is unchanged as the margin goes empty → 1 → grown", () => {
    const empty = mount(<Host threads={[]} />);
    const baseline = diffNodeCount(empty.container);
    expect(baseline).toBe(4);
    cleanup();

    const oneThread = openThread("t1", RANGE_ANCHOR);
    const one = mount(<Host threads={[oneThread]} />);
    expect(one.container.querySelectorAll(".conversation-cluster")).toHaveLength(1);
    expect(diffNodeCount(one.container)).toBe(baseline);
    cleanup();

    // Grow the thread (ask + answer) — the margin gains message DOM, the diff must not.
    let grown = askInThread(oneThread, "m1", "why fail open?");
    grown = answerInThread(grown, "m2", "Claude Code", "outage must not spread");
    const growth = mount(<Host threads={[grown]} />);
    expect(growth.container.querySelectorAll(".thread-message")).toHaveLength(2);
    expect(diffNodeCount(growth.container)).toBe(baseline);
    cleanup();

    // A second thread on a different anchor — still no reflow of the diff column.
    const second = openThread("t2", {
      kind: "chunk",
      label: "src/rate/keys.ts",
      key: "keys#chunk",
    });
    const many = mount(<Host threads={[grown, second]} />);
    expect(many.container.querySelectorAll(".conversation-cluster")).toHaveLength(2);
    expect(diffNodeCount(many.container)).toBe(baseline);
  });
});

describe("ConversationMargin — the right-margin column", () => {
  it("renders one panel per thread, each carrying its anchor key for alignment", () => {
    const a = openThread("a", RANGE_ANCHOR);
    const b = openThread("b", { kind: "line", label: "src/rate/keys.ts:18", key: "keys#L18" });
    const asks: Array<[string, string]> = [];
    const { container } = mount(
      <ConversationMargin
        threads={[a, b]}
        onAsk={(threadId, body) => asks.push([threadId, body])}
      />,
    );
    const panels = container.querySelectorAll(".conversation-cluster");
    expect(panels).toHaveLength(2);
    expect(panels[0]?.getAttribute("data-anchor-key")).toBe("src/rate/bucket.ts#L44-47");
    expect(panels[1]?.getAttribute("data-anchor-key")).toBe("keys#L18");

    // The margin threads the threadId through onAsk.
    const secondInput = panels[1]?.querySelector<HTMLTextAreaElement>(
      ".conversation-composer-input",
    );
    const secondSend = panels[1]?.querySelector<HTMLButtonElement>(".conversation-composer-send");
    if (!secondInput || !secondSend) throw new Error("no composer on second panel");
    fireEvent.change(secondInput, { target: { value: "org key change?" } });
    fireEvent.click(secondSend);
    expect(asks).toEqual([["b", "org key change?"]]);
  });
});
