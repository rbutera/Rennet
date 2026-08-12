// @vitest-environment happy-dom
//
// Issue #251, criterion 3 — mounted-DOM proof that an INTERRUPTED turn reaches a human.
// The whole point of the interrupted state is that it must be distinguishable from the
// silent completion it exists to prevent, and the only place that matters is the surface
// a person looks at. So this mounts ConversationHost over a bridge whose `review.reattach`
// returns a persisted thread whose turn was streaming when a previous process died — and
// asserts it renders as interrupted, with an honest note and NO fabricated answer body.

import type { CommandInput, RennetBridge } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import type { ConversationAnchor } from "../canvas/conversation";
import { mount, waitFor } from "../test/dom";
import { ConversationHost } from "./conversation-host";

const ANCHOR: ConversationAnchor = {
  kind: "range",
  label: "src/rate/bucket.ts:44-47",
  key: "range|src/rate/bucket.ts|additions|44|47",
  side: "additions",
};

/** A bridge that answers `review.reattach` with a fixed persisted set and records the
 *  reattach call. Any other command throws (this test only exercises reattach). */
function reattachBridge(
  threads: { threadId: string; anchor: ConversationAnchor; messages: unknown[] }[],
): { bridge: RennetBridge; reattachedWith: () => CommandInput<"review.reattach"> | undefined } {
  let seen: CommandInput<"review.reattach"> | undefined;
  const invoke = (async (name: string, input: unknown) => {
    if (name !== "review.reattach") throw new Error(`unexpected ${name}`);
    seen = input as CommandInput<"review.reattach">;
    return { threads, inFlight: [] };
  }) as RennetBridge["invoke"];
  return { bridge: { invoke }, reattachedWith: () => seen };
}

describe("ConversationHost — re-attach surfaces an interrupted turn (criterion 3, #251)", () => {
  it("renders a persisted interrupted turn honestly: a note, no answer body, not promotable", async () => {
    const h = reattachBridge([
      {
        threadId: "th",
        anchor: ANCHOR,
        messages: [
          { id: "m0", author: "you", body: "why fail open?" },
          // The killed-mid-stream turn as the store recovers it: interrupted, empty body.
          { id: "m1", author: "harness", body: "", status: "interrupted" },
        ],
      },
    ]);
    const { container } = mount(
      <ConversationHost bridge={h.bridge} reviewId="review-42" anchors={[ANCHOR]} />,
    );

    // The thread comes back on mount and the interrupted turn is surfaced as such.
    await waitFor(() => {
      const interrupted = container.querySelectorAll('.thread-message[data-status="interrupted"]');
      expect(interrupted).toHaveLength(1);
    });
    expect(h.reattachedWith()?.reviewId).toBe("review-42");

    // The "you" message restored too, so the conversation is legible, not a bare card.
    const youBody = [
      ...container.querySelectorAll('.thread-message[data-author="you"] .thread-message-body'),
    ].map((node) => node.textContent);
    expect(youBody).toContain("why fail open?");

    // An honest note, NOT a fabricated answer — and no promote affordance on an
    // interrupted turn (there is no durable answer to promote).
    const interrupted = container.querySelector('.thread-message[data-status="interrupted"]');
    expect(interrupted?.querySelector(".thread-message-interrupted")?.textContent).toMatch(
      /interrupted before it finished/i,
    );
    expect(interrupted?.querySelector(".thread-message-body")).toBeNull();
    expect(interrupted?.querySelector(".thread-promote-btn")).toBeNull();
  });

  it("a reattach that returns no threads leaves the surface empty (best-effort, no crash)", async () => {
    const h = reattachBridge([]);
    const { container } = mount(
      <ConversationHost bridge={h.bridge} reviewId="r" anchors={[ANCHOR]} />,
    );
    await waitFor(() => expect(h.reattachedWith()?.reviewId).toBe("r"));
    expect(container.querySelectorAll(".thread-message")).toHaveLength(0);
  });

  it("surfaces a thread whose file left the diff as ORPHANED — visible, kept, never re-anchored (slice 3)", async () => {
    // The persisted thread hangs on src/gone.ts; the CURRENT diff (the anchors prop) only
    // has src/present.ts. So the thread's file is gone → orphaned, surfaced honestly.
    const goneAnchor: ConversationAnchor = {
      kind: "chunk",
      label: "src/gone.ts",
      key: "chunk|src/gone.ts",
      path: "src/gone.ts",
    };
    const presentAnchor: ConversationAnchor = {
      kind: "chunk",
      label: "src/present.ts",
      key: "chunk|src/present.ts",
      path: "src/present.ts",
    };
    const h = reattachBridge([
      {
        threadId: "th",
        anchor: goneAnchor,
        messages: [
          { id: "m0", author: "you", body: "is this rate limiter correct?" },
          { id: "m1", author: "harness", model: "Claude", body: "yes, it fails open by design" },
        ],
      },
    ]);
    const { container } = mount(
      <ConversationHost bridge={h.bridge} reviewId="r" anchors={[presentAnchor]} />,
    );

    await waitFor(() => {
      expect(container.querySelector('.conversation-cluster[data-orphaned="true"]')).not.toBeNull();
    });
    const cluster = container.querySelector('.conversation-cluster[data-orphaned="true"]');
    // An honest banner, and the conversation is KEPT (its messages still render).
    expect(cluster?.querySelector(".conversation-orphaned")?.textContent).toMatch(
      /no longer in the diff/i,
    );
    expect(cluster?.textContent).toContain("yes, it fails open by design");
    // NEVER re-anchored: the panel still carries its ORIGINAL anchor key, not the present file's.
    expect(cluster?.getAttribute("data-anchor-key")).toBe("chunk|src/gone.ts");
  });
});
