// @vitest-environment happy-dom
//
// Issue #251 — mounted-DOM proof that the orchestrator's answer STREAMS. The whole
// point of streaming is only observable at the surface a person looks at, so this
// drives the real component: open a thread, ask, watch a SINGLE preview message grow
// token by token (data-status="streaming"), then watch the durable answer REPLACE it
// on completion. Risk #1 (an interrupted/streaming state that never reaches a human is
// indistinguishable from silence) is answered here, at the rendered DOM, not the store.

import type { CommandInput, RennetBridge, ReviewAskStreamEvent } from "@rennet/protocol";
import type { AskReviewResult } from "@rennet/types";
import { describe, expect, it } from "vitest";
import type { ConversationAnchor } from "../canvas/conversation";
import { act, fireEvent, mount, waitFor } from "../test/dom";
import { ConversationHost } from "./conversation-host";

const RANGE_ANCHOR: ConversationAnchor = {
  kind: "range",
  label: "src/rate/bucket.ts",
  key: "range|src/rate/bucket.ts|additions|44|47",
  side: "additions",
};

/** A bridge whose `review.ask` invoke stays PENDING until the test resolves it, and
 *  whose `onAskStream` lets the test push token deltas in between — so the mid-stream
 *  DOM is observable before the final answer lands. */
function streamingBridge(): {
  bridge: RennetBridge;
  askInput: () => CommandInput<"review.ask">;
  emit: (event: ReviewAskStreamEvent) => void;
  resolveAsk: (result: AskReviewResult) => void;
  unsubscribed: () => boolean;
} {
  let listener: ((event: ReviewAskStreamEvent) => void) | undefined;
  let unsub = false;
  let resolveInvoke: ((result: AskReviewResult) => void) | undefined;
  let lastInput: CommandInput<"review.ask"> | undefined;
  const invoke = (async (name: string, input: unknown): Promise<unknown> => {
    if (name !== "review.ask") throw new Error(`unexpected ${name}`);
    lastInput = input as CommandInput<"review.ask">;
    return new Promise<AskReviewResult>((resolve) => {
      resolveInvoke = resolve;
    });
  }) as RennetBridge["invoke"];
  const onAskStream: NonNullable<RennetBridge["onAskStream"]> = (_reviewId, l) => {
    listener = l;
    return () => {
      unsub = true;
      listener = undefined;
    };
  };
  return {
    bridge: { invoke, onAskStream },
    askInput: () => {
      if (!lastInput) throw new Error("review.ask was not invoked");
      return lastInput;
    },
    emit: (event) => listener?.(event),
    resolveAsk: (result) => resolveInvoke?.(result),
    unsubscribed: () => unsub,
  };
}

function openAndAsk(container: HTMLElement, question: string): void {
  const discuss = container.querySelector<HTMLButtonElement>(".discuss-control");
  if (!discuss) throw new Error("no discuss control");
  fireEvent.click(discuss);
  const input = container.querySelector<HTMLTextAreaElement>(".conversation-composer-input");
  const send = container.querySelector<HTMLButtonElement>(".conversation-composer-send");
  if (!input || !send) throw new Error("no composer");
  fireEvent.change(input, { target: { value: question } });
  fireEvent.click(send);
}

function harnessBodies(container: HTMLElement): string[] {
  return [...container.querySelectorAll('.thread-message[data-author="harness"] .thread-message-body')].map(
    (node) => node.textContent ?? "",
  );
}

describe("ConversationHost — token streaming into a live message (#251)", () => {
  it("grows ONE preview message token by token, then the durable answer replaces it", async () => {
    const h = streamingBridge();
    const { container } = mount(
      <ConversationHost bridge={h.bridge} reviewId="review-42" anchors={[RANGE_ANCHOR]} />,
    );
    openAndAsk(container, "why fail open?");

    // The ask reached the boundary carrying a turn id + the anchor (streaming enabled).
    await waitFor(() => {
      expect(h.askInput().turnId).toBeTruthy();
    });
    const { threadId, turnId } = h.askInput();
    expect(threadId).toBeTruthy();
    expect(h.askInput().anchor?.key).toBe(RANGE_ANCHOR.key);

    // Tokens arrive → a SINGLE growing preview, marked streaming, not three messages.
    const delta = (text: string): ReviewAskStreamEvent => ({
      kind: "ask-delta",
      threadId: threadId as string,
      turnId: turnId as string,
      channel: "orchestrator",
      delta: text,
    });
    await act(async () => {
      h.emit(delta("Because "));
      h.emit(delta("a limiter outage "));
      h.emit(delta("must never become an API outage."));
    });

    await waitFor(() => {
      const streaming = container.querySelectorAll('.thread-message[data-status="streaming"]');
      expect(streaming).toHaveLength(1);
      expect(streaming[0]?.querySelector(".thread-message-body")?.textContent).toBe(
        "Because a limiter outage must never become an API outage.",
      );
    });
    // Exactly one harness message so far (the preview), never one-per-token.
    expect(harnessBodies(container)).toHaveLength(1);

    // Completion: the AUTHORITATIVE invoke result replaces the preview with a durable,
    // model-labelled answer — the streaming marker is gone, and there is no duplicate.
    await act(async () => {
      h.resolveAsk({
        mode: "orchestrator",
        primary: {
          model: "Orchestrator · Claude",
          answer: "Because a limiter outage must never become an API outage.",
        },
      });
    });

    await waitFor(() => {
      expect(container.querySelectorAll('.thread-message[data-status="streaming"]')).toHaveLength(0);
      const bodies = harnessBodies(container);
      expect(bodies).toEqual(["Because a limiter outage must never become an API outage."]);
    });
    // The durable answer carries its model label (the preview had none).
    expect(container.querySelector(".thread-message-model")?.textContent).toContain(
      "Orchestrator · Claude",
    );
    expect(h.unsubscribed()).toBe(true);
  });

  it("a bridge with NO push channel still lands the whole answer (streaming degrades cleanly)", async () => {
    // No onAskStream: the preview never appears, but the durable answer still arrives —
    // streaming is an echo, never a requirement for the answer.
    let resolveInvoke: ((result: AskReviewResult) => void) | undefined;
    const bridge: RennetBridge = {
      invoke: (async (name: string) => {
        if (name !== "review.ask") throw new Error(`unexpected ${name}`);
        return new Promise<AskReviewResult>((resolve) => {
          resolveInvoke = resolve;
        });
      }) as RennetBridge["invoke"],
    };
    const { container } = mount(
      <ConversationHost bridge={bridge} reviewId="r" anchors={[RANGE_ANCHOR]} />,
    );
    openAndAsk(container, "why?");
    await waitFor(() => expect(resolveInvoke).toBeTruthy());
    await act(async () => {
      resolveInvoke?.({ mode: "orchestrator", primary: { model: "Orchestrator · Claude", answer: "the answer" } });
    });
    await waitFor(() => expect(harnessBodies(container)).toEqual(["the answer"]));
    // Never a streaming preview when there is no stream.
    expect(container.querySelectorAll('.thread-message[data-status="streaming"]')).toHaveLength(0);
  });
});
