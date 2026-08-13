// @vitest-environment happy-dom

import type { CommandInput, RennetBridge } from "@rennet/protocol";
import type { AskReviewResult } from "@rennet/types";
import { describe, expect, it } from "vitest";
import type { ConversationAnchor } from "../canvas/conversation";
import { fireEvent, mount, waitFor } from "../test/dom";
import { ConversationPanel } from "./conversation-panel";

const LINE_ANCHOR: ConversationAnchor = {
  kind: "range",
  label: "src/rate/keys.ts:44-47",
  key: "range|src/rate/keys.ts|additions|44|47",
  side: "additions",
  path: "src/rate/keys.ts",
  context: "if (err) return { allowed: true }",
};

const CHUNK_ANCHOR: ConversationAnchor = {
  kind: "chunk",
  label: "src/rate/keys.ts · retry handling",
  key: "chunk|src/rate/keys.ts",
  path: "src/rate/keys.ts",
  context: "@@ -40,8 +40,12 @@",
};

type Call = { name: string; input: unknown };

function answer(text: string): AskReviewResult {
  return {
    mode: "orchestrator",
    primary: { model: "Orchestrator · Claude", answer: text },
  };
}

function fakeBridge({
  ask = answer("The bridge answered."),
  threads = [],
}: {
  ask?: AskReviewResult;
  threads?: {
    threadId: string;
    anchor: ConversationAnchor;
    messages: {
      id: string;
      author: "you" | "harness";
      body: string;
      model?: string;
      status?: "interrupted";
    }[];
  }[];
} = {}): { bridge: RennetBridge; calls: Call[] } {
  const calls: Call[] = [];
  const invoke = (async (name: string, input: unknown) => {
    calls.push({ name, input });
    if (name === "review.reattach") return { threads, inFlight: [] };
    if (name === "review.ask") return ask;
    throw new Error(`unexpected command ${name}`);
  }) as RennetBridge["invoke"];
  return { bridge: { invoke }, calls };
}

function compose(container: HTMLElement, body: string): void {
  const input = container.querySelector<HTMLTextAreaElement>(".conversation-panel-input");
  const send = container.querySelector<HTMLButtonElement>(".conversation-panel-send");
  if (!input || !send) throw new Error("conversation composer is missing");
  fireEvent.change(input, { target: { value: body } });
  fireEvent.click(send);
}

describe("ConversationPanel", () => {
  it("renders one stream where a line message has a reply chip and icon but a general ask has no chip", async () => {
    const h = fakeBridge({
      threads: [
        {
          threadId: "anchored-thread",
          anchor: LINE_ANCHOR,
          messages: [{ id: "anchored-message", author: "you", body: "Why fail open?" }],
        },
      ],
    });
    const { container } = mount(
      <ConversationPanel bridge={h.bridge} reviewId="review-42" anchors={[LINE_ANCHOR]} />,
    );

    await waitFor(() => expect(container.querySelectorAll(".chat-row")).toHaveLength(1));
    expect(container.querySelectorAll(".conversation-panel-stream")).toHaveLength(1);
    const anchored = container.querySelector<HTMLElement>('.chat-row[data-ask-type="question"]');
    expect(anchored?.querySelector(".chat-type-icon")).not.toBeNull();
    expect(anchored?.getAttribute("data-lane")).toBe("blue");
    expect(anchored?.classList.contains("is-private")).toBe(true);
    expect(anchored?.querySelector(".replychip-reference")?.textContent).toBe(
      "src/rate/keys.ts · L44-L47",
    );
    expect(anchored?.querySelector(".replychip-context")?.textContent).toBe(
      "if (err) return { allowed: true }",
    );

    compose(container, "Does the fallback share state?");
    await waitFor(() =>
      expect(
        container.querySelector('.chat-row[data-ask-type="general-ask"][data-author="harness"]'),
      ).not.toBeNull(),
    );
    const generalRows = container.querySelectorAll('.chat-row[data-ask-type="general-ask"]');
    expect(generalRows).toHaveLength(2);
    for (const row of generalRows) expect(row.querySelector(".replychip")).toBeNull();
  });

  it("marks a re-attached gone-file thread orphaned and suppresses its stale live-anchor chip", async () => {
    const goneAnchor: ConversationAnchor = {
      kind: "line",
      label: "src/gone.ts:10",
      key: "line|src/gone.ts|additions|10",
      side: "additions",
      path: "src/gone.ts",
      context: "return staleResult;",
    };
    const presentAnchor: ConversationAnchor = {
      kind: "chunk",
      label: "src/present.ts",
      key: "chunk|src/present.ts",
      path: "src/present.ts",
    };
    const h = fakeBridge({
      threads: [
        {
          threadId: "gone-thread",
          anchor: goneAnchor,
          messages: [{ id: "gone-message", author: "you", body: "What happened here?" }],
        },
      ],
    });
    const { container, rerender } = mount(
      <ConversationPanel bridge={h.bridge} reviewId="review-orphan" anchors={[]} />,
    );
    await waitFor(() => expect(container.querySelector(".chat-row")).not.toBeNull());

    rerender(
      <ConversationPanel bridge={h.bridge} reviewId="review-orphan" anchors={[presentAnchor]} />,
    );

    const orphaned = await waitFor(() => {
      const row = container.querySelector<HTMLElement>('.chat-row[data-orphaned="true"]');
      if (!row) throw new Error("gone-file thread has not resolved as orphaned");
      return row;
    });
    expect(orphaned.querySelector(".conversation-orphaned")?.textContent).toMatch(
      /no longer in the diff/i,
    );
    expect(orphaned.querySelector(".replychip")).toBeNull();
    expect(orphaned.textContent).not.toContain("src/gone.ts · L10");
  });

  it("renders only the truthful line reference when persisted anchor context is missing or blank", async () => {
    const missing: ConversationAnchor = {
      kind: "line",
      label: "src/rate/keys.ts:12",
      key: "line|src/rate/keys.ts|additions|12",
      side: "additions",
      path: "src/rate/keys.ts",
    };
    const blank: ConversationAnchor = {
      kind: "line",
      label: "src/rate/keys.ts:13",
      key: "line|src/rate/keys.ts|additions|13",
      side: "additions",
      path: "src/rate/keys.ts",
      context: "   ",
    };
    const h = fakeBridge({
      threads: [
        {
          threadId: "missing-context",
          anchor: missing,
          messages: [{ id: "missing-message", author: "you", body: "Missing context" }],
        },
        {
          threadId: "blank-context",
          anchor: blank,
          messages: [{ id: "blank-message", author: "you", body: "Blank context" }],
        },
      ],
    });
    const { container } = mount(
      <ConversationPanel bridge={h.bridge} reviewId="review-context" anchors={[missing, blank]} />,
    );

    await waitFor(() => expect(container.querySelectorAll(".replychip")).toHaveLength(2));
    expect(
      [...container.querySelectorAll(".replychip-reference")].map((node) => node.textContent),
    ).toEqual(["src/rate/keys.ts · L12", "src/rate/keys.ts · L13"]);
    expect(container.querySelectorAll(".replychip-context")).toHaveLength(0);
    expect(container.textContent).not.toContain("Line text unavailable");
  });

  it("submits a general question directly to review.ask with no permission step and paints the answer", async () => {
    const h = fakeBridge({ ask: answer("No. Each worker holds its own bucket.") });
    const { container } = mount(
      <ConversationPanel bridge={h.bridge} reviewId="review-general" anchors={[]} />,
    );

    compose(container, "Does the fallback bucket share state across workers?");
    await waitFor(() =>
      expect(container.querySelector('.chat-row[data-author="harness"]')?.textContent).toContain(
        "Each worker holds its own bucket",
      ),
    );

    const askCalls = h.calls.filter((call) => call.name === "review.ask");
    expect(askCalls).toHaveLength(1);
    const input = askCalls[0]?.input as CommandInput<"review.ask">;
    expect(input).toMatchObject({
      reviewId: "review-general",
      mode: "orchestrator",
      question: "Does the fallback bucket share state across workers?",
    });
    expect(input.anchor).toBeUndefined();
    expect(input.threadId).toBeUndefined();
    expect(Object.keys(input)).not.toContain("permission");
    const generalAnswer = container.querySelector(
      '.chat-row[data-ask-type="general-ask"][data-author="harness"]',
    );
    expect(generalAnswer?.querySelector(".chat-message-actions")).toBeNull();
  });

  it("auto-opens a line reply with its chip and sends the anchored turn through review.ask", async () => {
    const h = fakeBridge({ ask: answer("It follows the review plan.") });
    const { container } = mount(
      <ConversationPanel
        bridge={h.bridge}
        reviewId="review-line"
        anchors={[LINE_ANCHOR]}
        autoOpenRequests={[{ id: "discuss-1", anchor: LINE_ANCHOR }]}
      />,
    );

    const opened = await waitFor(() => {
      const row = container.querySelector<HTMLElement>(
        '.chat-row--anchor-context[data-anchor-key="range|src/rate/keys.ts|additions|44|47"]',
      );
      if (!row) throw new Error("anchored row has not opened");
      return row;
    });
    expect(opened.querySelector(".chat-type-icon")).not.toBeNull();
    expect(opened.querySelector(".replychip-reference")?.textContent).toBe(
      "src/rate/keys.ts · L44-L47",
    );

    compose(container, "Why does this fail open?");
    await waitFor(() =>
      expect(h.calls.filter((call) => call.name === "review.ask")).toHaveLength(1),
    );
    const input = h.calls.find((call) => call.name === "review.ask")
      ?.input as CommandInput<"review.ask">;
    expect(input.anchor).toEqual(LINE_ANCHOR);
    expect(input.turnBody).toBe("Why does this fail open?");
    await waitFor(() =>
      expect(container.querySelector('.chat-row[data-author="harness"]')?.textContent).toContain(
        "It follows the review plan.",
      ),
    );
  });

  it("toggles the expanded class and back", () => {
    const h = fakeBridge();
    const { container } = mount(
      <ConversationPanel bridge={h.bridge} reviewId="review-expand" anchors={[]} />,
    );
    const panel = container.querySelector<HTMLElement>(".conversation-panel");
    const toggle = container.querySelector<HTMLButtonElement>(".conversation-panel-expand");
    if (!panel || !toggle) throw new Error("expand control is missing");

    expect(panel.classList.contains("conversation-panel--expanded")).toBe(false);
    fireEvent.click(toggle);
    expect(panel.classList.contains("conversation-panel--expanded")).toBe(true);
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(toggle);
    expect(panel.classList.contains("conversation-panel--expanded")).toBe(false);
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
  });

  it("shows a selectable active context for a chunk thread and lets the reviewer clear it", async () => {
    const h = fakeBridge();
    const { container } = mount(
      <ConversationPanel
        bridge={h.bridge}
        reviewId="review-chunk"
        anchors={[CHUNK_ANCHOR]}
        autoOpenRequests={[{ id: "discuss-chunk", anchor: CHUNK_ANCHOR }]}
      />,
    );

    const contextRow = await waitFor(() => {
      const row = container.querySelector<HTMLElement>(
        '.chat-row--anchor-context[data-anchor-kind="chunk"][data-active="true"]',
      );
      if (!row) throw new Error("active chunk context is not visible");
      return row;
    });
    expect(contextRow.querySelector(".conversation-anchor-context")?.textContent).toContain(
      CHUNK_ANCHOR.label,
    );
    expect(
      container.querySelector(".conversation-panel-composer")?.getAttribute("data-anchor-kind"),
    ).toBe("chunk");

    const clear = container.querySelector<HTMLButtonElement>('[aria-label="Clear thread reply"]');
    if (!clear) throw new Error("active chunk context has no clear control");
    fireEvent.click(clear);
    expect(container.querySelector(".conversation-composer-context")).toBeNull();
    expect(
      container.querySelector(".conversation-panel-composer")?.getAttribute("data-anchor-kind"),
    ).toBe("general");

    fireEvent.click(contextRow.querySelector(".conversation-anchor-context") as HTMLButtonElement);
    expect(
      container.querySelector(".conversation-panel-composer")?.getAttribute("data-anchor-kind"),
    ).toBe("chunk");
  });

  it("re-attaches an interrupted turn and renders it honestly in the unified stream", async () => {
    const h = fakeBridge({
      threads: [
        {
          threadId: "interrupted-thread",
          anchor: LINE_ANCHOR,
          messages: [
            { id: "question", author: "you", body: "Why?" },
            { id: "partial", author: "harness", body: "", status: "interrupted" },
          ],
        },
      ],
    });
    const { container } = mount(
      <ConversationPanel bridge={h.bridge} reviewId="review-reattach" anchors={[LINE_ANCHOR]} />,
    );

    const interrupted = await waitFor(() => {
      const row = container.querySelector<HTMLElement>('.chat-row[data-status="interrupted"]');
      if (!row) throw new Error("interrupted row has not re-attached");
      return row;
    });
    expect(interrupted.querySelector(".chat-message-interrupted")?.textContent).toMatch(
      /interrupted before it finished/i,
    );
    expect(interrupted.querySelector(".replychip")).not.toBeNull();
  });
});
