// @vitest-environment happy-dom
//
// ConversationPanel is now the thin wrapper over the live ConversationHost MARGIN path
// (issue #356): one aligned `ConversationCluster` per thread, not the retired flat
// `PanelSurface` stream. These proofs drive the margin — opening a thread from a discuss
// control, asking in that thread's own composer, and the honest states (orphaned,
// interrupted, pending, per-thread error, the "both" two-card result) the cluster owns.

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

const bothAnswers: AskReviewResult = {
  mode: "both",
  primary: { model: "Orchestrator · Claude", answer: "The orchestrator answer." },
  secondOpinion: { model: "Codex", answer: "The Codex second opinion." },
};

function fakeBridge({
  ask = answer("The bridge answered."),
  askRejects,
  threads = [],
}: {
  ask?: AskReviewResult | Promise<AskReviewResult>;
  /** The turn REJECTS with this message — thrown lazily inside `invoke` so no rejected
   *  promise dangles unhandled between construction and the host's await. */
  askRejects?: string;
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
    if (name === "review.ask") {
      if (askRejects !== undefined) throw new Error(askRejects);
      return ask;
    }
    throw new Error(`unexpected command ${name}`);
  }) as RennetBridge["invoke"];
  return { bridge: { invoke }, calls };
}

/** Open a fresh thread on the panel's first discussable anchor, returning its cluster. */
async function openThread(container: HTMLElement): Promise<HTMLElement> {
  const discuss = container.querySelector<HTMLButtonElement>(".discuss-control");
  if (!discuss) throw new Error("no discuss control to open a thread");
  fireEvent.click(discuss);
  return waitFor(() => {
    const cluster = container.querySelector<HTMLElement>(".conversation-cluster");
    if (!cluster) throw new Error("thread cluster did not open");
    return cluster;
  });
}

/** Ask in a thread cluster's own composer and wait for the expected answer text. */
async function askInCluster(cluster: HTMLElement, body: string, expected: string): Promise<void> {
  const input = cluster.querySelector<HTMLTextAreaElement>(".conversation-composer-input");
  const send = cluster.querySelector<HTMLButtonElement>(".conversation-composer-send");
  if (!input || !send) throw new Error("thread composer is missing");
  fireEvent.change(input, { target: { value: body } });
  fireEvent.click(send);
  await waitFor(() => expect(cluster.textContent?.includes(expected)).toBe(true));
}

describe("ConversationPanel (margin path)", () => {
  it("keeps the diff column's fixed sibling shell so the conversation column never nests in the diff", () => {
    const h = fakeBridge();
    const { container } = mount(
      <ConversationPanel bridge={h.bridge} reviewId="review-shell" anchors={[LINE_ANCHOR]} />,
    );
    const shell = container.querySelector<HTMLElement>(".conversation-panel-shell");
    expect(shell).not.toBeNull();
    // The aligned rail lives inside the shell — one column, sibling to the diff.
    expect(shell?.querySelector(".conversation-margin")).not.toBeNull();
    // A discuss control is offered for the anchor with no open thread yet.
    expect(shell?.querySelector(".discuss-control")).not.toBeNull();
  });

  it("re-attaches a persisted thread as an aligned cluster carrying its anchor key and message", async () => {
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

    const cluster = await waitFor(() => {
      const found = container.querySelector<HTMLElement>(".conversation-cluster");
      if (!found) throw new Error("re-attached thread did not render");
      return found;
    });
    expect(cluster.getAttribute("data-anchor-key")).toBe(LINE_ANCHOR.key);
    expect(cluster.getAttribute("data-lane")).toBe("blue");
    expect(cluster.classList.contains("is-private")).toBe(true);
    expect(cluster.querySelector(".conversation-head-anchor")?.textContent).toBe(LINE_ANCHOR.label);
    expect(cluster.querySelector(".thread-message-body")?.textContent).toBe("Why fail open?");
  });

  it("marks a re-attached gone-file thread orphaned with an honest banner and no live anchor", async () => {
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
    await waitFor(() => expect(container.querySelector(".conversation-cluster")).not.toBeNull());

    rerender(
      <ConversationPanel bridge={h.bridge} reviewId="review-orphan" anchors={[presentAnchor]} />,
    );

    const orphaned = await waitFor(() => {
      const cluster = container.querySelector<HTMLElement>(
        '.conversation-cluster[data-orphaned="true"]',
      );
      if (!cluster) throw new Error("gone-file thread has not resolved as orphaned");
      return cluster;
    });
    expect(orphaned.querySelector(".conversation-orphaned")?.textContent).toMatch(
      /no longer in the diff/i,
    );
    expect(orphaned.classList.contains("is-orphaned")).toBe(true);
  });

  it("renders two re-attached line threads as two clusters, each labelled by its own anchor", async () => {
    const first: ConversationAnchor = {
      kind: "line",
      label: "src/rate/keys.ts:12",
      key: "line|src/rate/keys.ts|additions|12",
      side: "additions",
      path: "src/rate/keys.ts",
    };
    const second: ConversationAnchor = {
      kind: "line",
      label: "src/rate/keys.ts:13",
      key: "line|src/rate/keys.ts|additions|13",
      side: "additions",
      path: "src/rate/keys.ts",
    };
    const h = fakeBridge({
      threads: [
        {
          threadId: "first-context",
          anchor: first,
          messages: [{ id: "first-message", author: "you", body: "First" }],
        },
        {
          threadId: "second-context",
          anchor: second,
          messages: [{ id: "second-message", author: "you", body: "Second" }],
        },
      ],
    });
    const { container } = mount(
      <ConversationPanel bridge={h.bridge} reviewId="review-context" anchors={[first, second]} />,
    );

    await waitFor(() =>
      expect(container.querySelectorAll(".conversation-cluster")).toHaveLength(2),
    );
    expect(
      [...container.querySelectorAll(".conversation-head-anchor")].map((n) => n.textContent),
    ).toEqual([first.label, second.label]);
  });

  it("sends a thread turn to review.ask with no permission step and paints the answer", async () => {
    const h = fakeBridge({ ask: answer("Each worker holds its own bucket.") });
    const { container } = mount(
      <ConversationPanel bridge={h.bridge} reviewId="review-general" anchors={[LINE_ANCHOR]} />,
    );

    const cluster = await openThread(container);
    await askInCluster(
      cluster,
      "Does the fallback bucket share state?",
      "Each worker holds its own",
    );

    const askCalls = h.calls.filter((call) => call.name === "review.ask");
    expect(askCalls).toHaveLength(1);
    const input = askCalls[0]?.input as CommandInput<"review.ask">;
    expect(input).toMatchObject({ reviewId: "review-general", mode: "orchestrator" });
    expect(input.turnBody).toBe("Does the fallback bucket share state?");
    expect(input.anchor).toEqual(LINE_ANCHOR);
    expect(Object.keys(input)).not.toContain("permission");
    // The answer is a durable harness card, not an inline ask-answers comparison surface.
    expect(cluster.querySelector('.thread-message[data-author="harness"]')).not.toBeNull();
    expect(cluster.querySelector(".ask-answer-card")).toBeNull();
  });

  it("offers both routes from the thread composer and renders a both result as two unsynthesised cards", async () => {
    const h = fakeBridge({ ask: bothAnswers });
    const { container } = mount(
      <ConversationPanel bridge={h.bridge} reviewId="review-both" anchors={[LINE_ANCHOR]} />,
    );
    const cluster = await openThread(container);

    const options = cluster.querySelector<HTMLButtonElement>('[aria-label="ask options"]');
    if (!options) throw new Error("the thread composer's ask routing is missing");
    expect(cluster.querySelector(".conversation-composer")?.getAttribute("data-ask-mode")).toBe(
      "orchestrator",
    );
    fireEvent.click(options);
    const both = cluster.querySelector<HTMLButtonElement>(
      '.conversation-route-item[data-mode="both"]',
    );
    if (!both) throw new Error("both-model routing is missing from the composer");
    fireEvent.click(both);
    expect(cluster.querySelector(".conversation-composer")?.getAttribute("data-ask-mode")).toBe(
      "both",
    );

    await askInCluster(cluster, "Do the models agree?", "The Codex second opinion.");

    const askCalls = h.calls.filter((call) => call.name === "review.ask");
    expect(askCalls).toHaveLength(1);
    expect(askCalls[0]?.input).toMatchObject({ reviewId: "review-both", mode: "both" });

    // Two durable harness cards, one per model — no synthesis, no merged card.
    const harness = cluster.querySelectorAll('.thread-message[data-author="harness"]');
    expect(harness).toHaveLength(2);
    expect(
      [...harness].map((card) => card.querySelector(".thread-message-model span")?.textContent),
    ).toEqual(["Orchestrator · Claude", "Codex"]);
    expect(cluster.querySelector(".ask-synthesis")).toBeNull();
  });

  it("reports a thread-turn timeout honestly and re-enables the composer", async () => {
    const h = fakeBridge({ ask: new Promise<AskReviewResult>(() => undefined) });
    const { container } = mount(
      <ConversationPanel
        bridge={h.bridge}
        reviewId="review-timeout"
        anchors={[LINE_ANCHOR]}
        timeoutMs={20}
      />,
    );
    const cluster = await openThread(container);
    const input = cluster.querySelector<HTMLTextAreaElement>(".conversation-composer-input");
    const send = cluster.querySelector<HTMLButtonElement>(".conversation-composer-send");
    if (!input || !send) throw new Error("thread composer is missing");
    fireEvent.change(input, { target: { value: "Which model timed out?" } });
    fireEvent.click(send);

    const alert = await waitFor(() => {
      const current = cluster.querySelector<HTMLElement>(".conversation-error");
      if (!current) throw new Error("timeout error has not appeared");
      return current;
    });
    expect(alert.textContent).toMatch(/did not answer in time/i);
    expect(
      cluster.querySelector<HTMLTextAreaElement>(".conversation-composer-input")?.disabled,
    ).toBe(false);
  });

  it("surfaces a rejected thread ask honestly and keeps the composer usable", async () => {
    const h = fakeBridge({ askRejects: "the models are unavailable" });
    const { container } = mount(
      <ConversationPanel bridge={h.bridge} reviewId="review-error" anchors={[LINE_ANCHOR]} />,
    );
    const cluster = await openThread(container);
    const input = cluster.querySelector<HTMLTextAreaElement>(".conversation-composer-input");
    const send = cluster.querySelector<HTMLButtonElement>(".conversation-composer-send");
    if (!input || !send) throw new Error("thread composer is missing");
    fireEvent.change(input, { target: { value: "Can either model answer?" } });
    fireEvent.click(send);

    const alert = await waitFor(() => {
      const current = cluster.querySelector<HTMLElement>(".conversation-error");
      if (!current) throw new Error("bridge error has not appeared");
      return current;
    });
    expect(alert.textContent).toBe("the models are unavailable");
    expect(
      cluster.querySelector<HTMLTextAreaElement>(".conversation-composer-input")?.disabled,
    ).toBe(false);
  });

  it("auto-opens a line thread from a diff-originated request and sends the anchored turn", async () => {
    const h = fakeBridge({ ask: answer("It follows the review plan.") });
    const { container } = mount(
      <ConversationPanel
        bridge={h.bridge}
        reviewId="review-line"
        anchors={[LINE_ANCHOR]}
        autoOpenRequests={[{ id: "discuss-1", anchor: LINE_ANCHOR }]}
      />,
    );

    const cluster = await waitFor(() => {
      const found = container.querySelector<HTMLElement>(
        `.conversation-cluster[data-anchor-key="${LINE_ANCHOR.key}"]`,
      );
      if (!found) throw new Error("anchored thread has not auto-opened");
      return found;
    });
    expect(cluster.querySelector(".conversation-head-anchor")?.textContent).toBe(LINE_ANCHOR.label);

    await askInCluster(cluster, "Why does this fail open?", "It follows the review plan.");
    const input = h.calls.find((call) => call.name === "review.ask")
      ?.input as CommandInput<"review.ask">;
    expect(input.anchor).toEqual(LINE_ANCHOR);
    expect(input.turnBody).toBe("Why does this fail open?");
  });

  it("opens a fresh thread from a discuss control (one thread per anchor)", async () => {
    const h = fakeBridge();
    const { container } = mount(
      <ConversationPanel bridge={h.bridge} reviewId="review-open" anchors={[LINE_ANCHOR]} />,
    );
    expect(container.querySelectorAll(".conversation-cluster")).toHaveLength(0);
    await openThread(container);
    expect(container.querySelectorAll(".conversation-cluster")).toHaveLength(1);
    // Its anchor is no longer discussable — the control is spent, so no double-open.
    expect(container.querySelector(".discuss-control")).toBeNull();
  });

  it("opens a chunk thread carrying its chunk anchor key and its own composer", async () => {
    const h = fakeBridge();
    const { container } = mount(
      <ConversationPanel
        bridge={h.bridge}
        reviewId="review-chunk"
        anchors={[CHUNK_ANCHOR]}
        autoOpenRequests={[{ id: "discuss-chunk", anchor: CHUNK_ANCHOR }]}
      />,
    );

    const cluster = await waitFor(() => {
      const found = container.querySelector<HTMLElement>(
        '.conversation-cluster[data-anchor-kind="chunk"]',
      );
      if (!found) throw new Error("chunk thread did not open");
      return found;
    });
    expect(cluster.getAttribute("data-anchor-key")).toBe(CHUNK_ANCHOR.key);
    expect(cluster.querySelector(".conversation-composer-input")).not.toBeNull();
  });

  it("re-attaches an interrupted turn and renders it honestly in its cluster", async () => {
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
      const card = container.querySelector<HTMLElement>(
        '.thread-message[data-status="interrupted"]',
      );
      if (!card) throw new Error("interrupted turn has not re-attached");
      return card;
    });
    expect(interrupted.querySelector(".thread-message-interrupted")?.textContent).toMatch(
      /interrupted before it finished/i,
    );
  });
});
