// @vitest-environment happy-dom
//
// The LIVE conversation host (issue #36): mounted-DOM proof that the inline
// conversation is REAL, not a fixture. It mounts `ConversationHost` over a recording
// fake `RennetBridge` and drives the whole interaction — open a thread on an anchor,
// ask, see the orchestrator's OWN answer land — asserting:
//   • a turn reaches the live `review.ask` boundary with the review id + the built
//     question (the anchor scope), and the REAL answer populates the thread;
//   • the answer is the bridge's, never the `demoConversationThread()` fixture string;
//   • a follow-up continues the SAME thread and carries the prior turn as context
//     (the second question folds in the first Q + A) — multi-turn is live + contextual;
//   • a "both" result appends BOTH labelled cards (primary + secondOpinion), no third;
//   • a failed turn surfaces honestly and never falls back to a fixture answer;
//   • a turn in flight shows an honest pending row and holds the composer.

import type { CommandInput, RennetBridge } from "@rennet/protocol";
import type { AskReviewResult } from "@rennet/types";
import { describe, expect, it } from "vitest";
import type { ConversationAnchor } from "../canvas/conversation";
import { fireEvent, mount, waitFor } from "../test/dom";
import { ConversationHost } from "./conversation-host";

const RANGE_ANCHOR: ConversationAnchor = {
  kind: "range",
  label: "src/rate/bucket.ts",
  key: "src/rate/bucket.ts#L44-47",
};

type Call = { name: string; input: unknown };

/** A recording bridge whose `review.ask` returns the next queued result in order. */
function fakeBridge(results: AskReviewResult[]): { bridge: RennetBridge; calls: Call[] } {
  const calls: Call[] = [];
  let i = 0;
  const invoke = async (name: string, input: unknown): Promise<unknown> => {
    calls.push({ name, input });
    if (name === "review.ask") {
      const result = results[Math.min(i, results.length - 1)];
      i += 1;
      return result;
    }
    throw new Error(`unexpected command ${name}`);
  };
  return { bridge: { invoke } as RennetBridge, calls };
}

function orchestratorAnswer(answer: string): AskReviewResult {
  return { mode: "orchestrator", primary: { model: "Orchestrator · Claude", answer } };
}

function openAndAsk(container: HTMLElement, question: string): void {
  const discuss = container.querySelector<HTMLButtonElement>(".discuss-control");
  if (!discuss) throw new Error("no discuss control");
  fireEvent.click(discuss);
  const input = container.querySelector<HTMLTextAreaElement>(".conversation-composer-input");
  const send = container.querySelector<HTMLButtonElement>(".conversation-composer-send");
  if (!input || !send) throw new Error("no composer after opening a thread");
  fireEvent.change(input, { target: { value: question } });
  fireEvent.click(send);
}

describe("ConversationHost — the live in-diff conversation", () => {
  it("opens a thread and populates it with the orchestrator's REAL answer (no fixture)", async () => {
    const { bridge, calls } = fakeBridge([
      orchestratorAnswer("Because a limiter outage must never become an API outage."),
    ]);
    const { container } = mount(
      <ConversationHost bridge={bridge} reviewId="review-42" anchors={[RANGE_ANCHOR]} />,
    );

    // No thread until the reviewer opens one on the anchor.
    expect(container.querySelector(".conversation-cluster")).toBeNull();
    openAndAsk(container, "why fail open?");

    // The reviewer's message lands immediately; the harness answer lands when the
    // live turn resolves — and it is the BRIDGE's answer, not the demo fixture.
    await waitFor(() =>
      expect(
        container.querySelector('.thread-message[data-author="harness"] .thread-message-body')
          ?.textContent,
      ).toBe("Because a limiter outage must never become an API outage."),
    );
    const harness = container.querySelector(
      '.thread-message[data-author="harness"] .thread-message-body',
    );
    expect(harness?.textContent).not.toContain("It follows the plan");

    // The turn reached the live boundary with the review id and the anchor-scoped
    // question the host built.
    const ask = calls.find((c) => c.name === "review.ask");
    expect(ask).toBeDefined();
    const input = ask?.input as CommandInput<"review.ask">;
    expect(input.reviewId).toBe("review-42");
    expect(input.mode).toBe("orchestrator");
    expect(typeof input.commandId).toBe("string");
    expect(input.question).toContain("src/rate/bucket.ts");
    expect(input.question).toContain("why fail open?");
  });

  it("a follow-up continues the SAME thread and carries the prior turn as context", async () => {
    const { bridge, calls } = fakeBridge([
      orchestratorAnswer("Outage must not spread across all orgs."),
      orchestratorAnswer("The store-error metric caps the blast radius."),
    ]);
    const { container } = mount(
      <ConversationHost bridge={bridge} reviewId="review-1" anchors={[RANGE_ANCHOR]} />,
    );

    openAndAsk(container, "why fail open?");
    await waitFor(() =>
      expect(container.querySelectorAll('.thread-message[data-author="harness"]').length).toBe(1),
    );

    // Ask again in the same (still the only) thread — no new discuss control needed.
    const input = container.querySelector<HTMLTextAreaElement>(".conversation-composer-input");
    const send = container.querySelector<HTMLButtonElement>(".conversation-composer-send");
    if (!input || !send) throw new Error("no composer for the follow-up");
    fireEvent.change(input, { target: { value: "but what caps the blast radius?" } });
    fireEvent.click(send);

    await waitFor(() =>
      expect(container.querySelectorAll('.thread-message[data-author="harness"]').length).toBe(2),
    );
    // Still ONE thread: the follow-up grew it, never forked a new one.
    expect(container.querySelectorAll(".conversation-cluster")).toHaveLength(1);

    // The SECOND live turn's question folded in the first turn's Q AND A — the
    // stateless orchestrator turn is handed the whole conversation so far.
    const asks = calls.filter((c) => c.name === "review.ask");
    expect(asks).toHaveLength(2);
    const second = asks[1]?.input as CommandInput<"review.ask">;
    expect(second.question).toContain("Conversation so far:");
    expect(second.question).toContain("why fail open?");
    expect(second.question).toContain("Outage must not spread across all orgs.");
    expect(second.question).toContain("but what caps the blast radius?");
  });

  it("appends BOTH cards for a 'both' result — primary + secondOpinion, no third", async () => {
    const both: AskReviewResult = {
      mode: "both",
      primary: { model: "Orchestrator · Claude", answer: "Milliseconds." },
      secondOpinion: { model: "codex", answer: "Milliseconds — the wrapper divides by 1000." },
    };
    const { bridge } = fakeBridge([both]);
    const { container } = mount(
      <ConversationHost bridge={bridge} reviewId="review-1" anchors={[RANGE_ANCHOR]} />,
    );
    openAndAsk(container, "seconds or ms?");
    await waitFor(() =>
      expect(container.querySelectorAll('.thread-message[data-author="harness"]').length).toBe(2),
    );
    const labels = [...container.querySelectorAll(".thread-message-model")].map(
      (n) => n.textContent,
    );
    expect(labels).toEqual(["Orchestrator · Claude", "codex"]);
  });

  it("surfaces a failed turn honestly — no fixture answer stands in", async () => {
    const failing: RennetBridge = {
      invoke: () => Promise.reject(new Error("the orchestrator is unavailable")),
    } as RennetBridge;
    const { container } = mount(
      <ConversationHost bridge={failing} reviewId="review-1" anchors={[RANGE_ANCHOR]} />,
    );
    openAndAsk(container, "why?");

    const alert = await waitFor(() => {
      const node = container.querySelector(".conversation-error");
      if (!node) throw new Error("no error surfaced yet");
      return node;
    });
    expect(alert.getAttribute("role")).toBe("alert");
    expect(alert.textContent).toMatch(/unavailable/i);
    // The reviewer's message is there; NO harness answer was fabricated.
    expect(container.querySelector('.thread-message[data-author="you"]')).not.toBeNull();
    expect(container.querySelector('.thread-message[data-author="harness"]')).toBeNull();
  });

  it("shows an honest pending row and holds the composer while a turn is in flight", async () => {
    // A bridge that never resolves — the thread must show pending and disable send.
    const hung: RennetBridge = {
      invoke: () => new Promise<never>(() => undefined),
    } as RennetBridge;
    const { container } = mount(
      <ConversationHost bridge={hung} reviewId="review-1" anchors={[RANGE_ANCHOR]} />,
    );
    openAndAsk(container, "why?");
    await waitFor(() => expect(container.querySelector(".conversation-pending")).not.toBeNull());
    const send = container.querySelector<HTMLButtonElement>(".conversation-composer-send");
    expect(send?.disabled).toBe(true);
  });
});
