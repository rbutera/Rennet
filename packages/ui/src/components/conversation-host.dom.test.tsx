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

  it("opts THIS turn into 'both' from the caret, sends mode='both', and appends both cards", async () => {
    const both: AskReviewResult = {
      mode: "both",
      primary: { model: "Orchestrator · Claude", answer: "Milliseconds." },
      secondOpinion: { model: "codex", answer: "Milliseconds — the wrapper divides by 1000." },
    };
    const { bridge, calls } = fakeBridge([both]);
    const { container } = mount(
      <ConversationHost bridge={bridge} reviewId="review-1" anchors={[RANGE_ANCHOR]} />,
    );

    // Open a thread, then OPT INTO "both" via the composer caret before sending — this
    // is the production path that makes the Claude+Codex route reachable at all.
    const discuss = container.querySelector<HTMLButtonElement>(".discuss-control");
    if (!discuss) throw new Error("no discuss control");
    fireEvent.click(discuss);
    const caret = container.querySelector<HTMLButtonElement>(".conversation-composer-caret");
    if (!caret) throw new Error("no routing caret");
    fireEvent.click(caret);
    const bothOption = container.querySelector<HTMLButtonElement>(
      '.conversation-route-item[data-mode="both"]',
    );
    if (!bothOption) throw new Error("no 'both' menu item");
    fireEvent.click(bothOption);
    const input = container.querySelector<HTMLTextAreaElement>(".conversation-composer-input");
    const send = container.querySelector<HTMLButtonElement>(".conversation-composer-send");
    if (!input || !send) throw new Error("no composer");
    fireEvent.change(input, { target: { value: "seconds or ms?" } });
    fireEvent.click(send);

    await waitFor(() =>
      expect(container.querySelectorAll('.thread-message[data-author="harness"]').length).toBe(2),
    );
    // The REAL request carried mode "both" — the vacuous version asserted only the
    // fake's response and would pass even if the UI could never send "both".
    const ask = calls.find((c) => c.name === "review.ask");
    expect(ask).toBeDefined();
    const askInput = ask?.input as CommandInput<"review.ask">;
    expect(askInput.mode).toBe("both");
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

const LINE_ANCHOR: ConversationAnchor = {
  kind: "line",
  label: "src/rate/bucket.ts:L44",
  key: "src/rate/bucket.ts#L44",
};

/** A discuss request wrapping an anchor with a fresh occurrence id (issue #36). */
function req(anchor: ConversationAnchor, id: string = crypto.randomUUID()) {
  return { id, anchor };
}

describe("ConversationHost — the anchoring facet (issue #36)", () => {
  it("auto-opens a thread for a diff-originated request, with no discuss-control click", () => {
    const { bridge } = fakeBridge([orchestratorAnswer("…")]);
    const { container } = mount(
      <ConversationHost
        bridge={bridge}
        reviewId="review-1"
        anchors={[]}
        autoOpenRequests={[req(LINE_ANCHOR)]}
      />,
    );
    // The thread exists immediately — the diff is where the reviewer clicked, so the
    // margin already holds the conversation. No `.discuss-control` press was needed.
    const cluster = container.querySelector(".conversation-cluster");
    expect(cluster).not.toBeNull();
    expect(cluster?.getAttribute("data-anchor-key")).toBe("src/rate/bucket.ts#L44");
    expect(container.querySelector(".conversation-composer-input")).not.toBeNull();
  });

  it("a SECOND request on the same anchor key opens its OWN thread (#36 MED — not collapsed)", () => {
    // ⚠️ Exercise the ACCUMULATING path — `[r1]` then `[r1, r2]` — not one batched array
    // (#36 F5). A single batch never collapses same-key duplicates regardless of the
    // dedup key (the `seen` set is not updated mid-filter), so it could not fail under a
    // `request.id`→`anchor.key` regression. Rendering the growing list the live host
    // actually passes makes the guard bite: pre-fix (key dedup) the second stays absent.
    const { bridge } = fakeBridge([orchestratorAnswer("…")]);
    const first = req(LINE_ANCHOR, "req-1");
    const second = req(LINE_ANCHOR, "req-2"); // SAME anchor key, different occurrence id
    const { container, rerender } = mount(
      <ConversationHost
        bridge={bridge}
        reviewId="review-1"
        anchors={[]}
        autoOpenRequests={[first]}
      />,
    );
    expect(container.querySelectorAll(".conversation-cluster")).toHaveLength(1);
    rerender(
      <ConversationHost
        bridge={bridge}
        reviewId="review-1"
        anchors={[]}
        autoOpenRequests={[first, second]}
      />,
    );
    expect(container.querySelectorAll(".conversation-cluster")).toHaveLength(2);
    // Both align to the SAME margin key — anchor.key is grouping/alignment only.
    for (const cluster of container.querySelectorAll(".conversation-cluster")) {
      expect(cluster.getAttribute("data-anchor-key")).toBe("src/rate/bucket.ts#L44");
    }
  });

  it("is idempotent across re-renders: re-passing the SAME request id never reopens a thread", () => {
    const { bridge } = fakeBridge([orchestratorAnswer("…")]);
    const stable = req(LINE_ANCHOR, "req-stable");
    const { container, rerender } = mount(
      <ConversationHost
        bridge={bridge}
        reviewId="review-1"
        anchors={[]}
        autoOpenRequests={[stable]}
      />,
    );
    expect(container.querySelectorAll(".conversation-cluster")).toHaveLength(1);
    // A fresh array carrying the SAME request id (what an accumulating host re-passes
    // each render): the seen-ids ref makes this a no-op, never a duplicate thread.
    rerender(
      <ConversationHost
        bridge={bridge}
        reviewId="review-1"
        anchors={[]}
        autoOpenRequests={[{ ...stable }]}
      />,
    );
    expect(container.querySelectorAll(".conversation-cluster")).toHaveLength(1);
  });

  it("a FRAGMENT sub-thread carries the referenced message TEXT into its question (#36 F2)", async () => {
    // A distinctive parent answer so we can prove it TRAVELS into the sub-thread's turn.
    const PARENT = "FRAGMENT_PARENT_TEXT a limiter outage must never spread";
    const { bridge, calls } = fakeBridge([orchestratorAnswer(PARENT), orchestratorAnswer("Sure.")]);
    const { container } = mount(
      <ConversationHost
        bridge={bridge}
        reviewId="review-1"
        anchors={[]}
        autoOpenRequests={[req(LINE_ANCHOR)]}
      />,
    );
    // Ask so the thread grows the harness message the sub-thread will anchor to.
    const input = container.querySelector<HTMLTextAreaElement>(".conversation-composer-input");
    const send = container.querySelector<HTMLButtonElement>(".conversation-composer-send");
    if (!input || !send) throw new Error("no composer");
    fireEvent.change(input, { target: { value: "why fail open?" } });
    fireEvent.click(send);
    await waitFor(() =>
      expect(
        container.querySelector('.thread-message[data-author="harness"]')?.textContent,
      ).toContain(PARENT),
    );
    // Open the sub-thread on that harness answer → a SECOND thread.
    const subThread = container.querySelector<HTMLButtonElement>(
      ".thread-promote-btn.is-subthread",
    );
    if (!subThread) throw new Error("no sub-thread control on the harness message");
    fireEvent.click(subThread);
    await waitFor(() =>
      expect(container.querySelectorAll(".conversation-cluster")).toHaveLength(2),
    );
    // The fragment key is kind-prefixed by parent thread + message (never a bare id).
    const fragment = Array.from(container.querySelectorAll(".conversation-cluster")).find(
      (node) => node.getAttribute("data-anchor-key") !== "src/rate/bucket.ts#L44",
    );
    expect(fragment).toBeDefined();
    expect(fragment?.getAttribute("data-anchor-key")?.startsWith("fragment|")).toBe(true);

    // ⭐ F2: ask a question IN the sub-thread and prove the referenced fragment text
    // reaches `review.ask`. Without carrying the parent message into the anchor context,
    // the orchestrator receives only "… · reply" and cannot know which sentence.
    const subInput = fragment?.querySelector<HTMLTextAreaElement>(".conversation-composer-input");
    const subSend = fragment?.querySelector<HTMLButtonElement>(".conversation-composer-send");
    if (!subInput || !subSend) throw new Error("no sub-thread composer");
    fireEvent.change(subInput, { target: { value: "what do you mean?" } });
    fireEvent.click(subSend);
    await waitFor(() => expect(calls.filter((c) => c.name === "review.ask")).toHaveLength(2));
    const subAsk = calls.filter((c) => c.name === "review.ask").at(-1)?.input as
      | CommandInput<"review.ask">
      | undefined;
    expect(subAsk?.question).toContain(PARENT);
    expect(subAsk?.question).toContain("what do you mean?");
  });
});
