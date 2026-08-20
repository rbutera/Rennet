// @vitest-environment happy-dom
//
// Issue #251 — regression guard for the RE-ATTACH RENDER RACE.
//
// The reattach effect fires an async `review.reattach` on mount and seeds the restored
// threads. The original effect keyed on `[bridge, reviewId, anchors]` with a one-shot
// `reattachedRef` and a `cancelled` cleanup flag. Because the app builds `anchors` as a
// FRESH array every render (`patchset.files.map(...)`), any App re-render landing during
// the async reattach window tore the effect down (cleanup set cancelled=true), the re-run
// hit the one-shot ref and did NOT re-invoke, and the original invocation then resolved
// into a discard — so the restored threads, the interrupted turn, and the orphaned banner
// NEVER PAINTED. The bare-mount tests could not see it (no re-render, no StrictMode).
//
// These tests perform the literal original bug — a re-render with a fresh `anchors` array
// while the reattach is still in flight — and assert the restored surface paints. Each
// FAILS against the pre-fix effect (cluster count 0) and passes once the effect reads
// anchors via a ref and applies its result unconditionally.

import type { RennetBridge } from "@rennet/protocol";
import { StrictMode } from "react";
import { describe, expect, it } from "vitest";
import type { ConversationAnchor } from "../canvas/conversation";
import { mount, waitFor } from "../test/dom";
import { ConversationHost } from "./conversation-host";

const ANCHOR: ConversationAnchor = {
  kind: "chunk",
  label: "src/present.ts",
  key: "chunk|src/present.ts",
  path: "src/present.ts",
};
// A fresh array of identical content each call — models `patchset.files.map(...)`, which
// yields a new array + new object literals on every App render.
const freshAnchors = (): ConversationAnchor[] => [{ ...ANCHOR }];

/** A bridge whose `review.reattach` blocks on `release()`, so a prop change can land while
 *  the reattach is in flight (the real race: reattach IPC + disk read outlasts a render). */
function deferredReattachBridge(
  messages: { id: string; author: string; body: string; model?: string; status?: string }[],
): { bridge: RennetBridge; release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const invoke = (async (name: string) => {
    if (name !== "review.reattach") throw new Error(`unexpected ${name}`);
    await gate;
    return { threads: [{ threadId: "th", anchor: ANCHOR, messages }], inFlight: [] };
  }) as RennetBridge["invoke"];
  return { bridge: { invoke }, release };
}

const GONE_ANCHOR: ConversationAnchor = {
  kind: "chunk",
  label: "src/gone.ts",
  key: "chunk|src/gone.ts",
  path: "src/gone.ts",
};

/** A bridge whose `review.reattach` resolves immediately with one thread on `anchor`. */
function immediateReattachBridge(anchor: ConversationAnchor): RennetBridge {
  const invoke = (async (name: string) => {
    if (name !== "review.reattach") throw new Error(`unexpected ${name}`);
    return {
      threads: [
        {
          threadId: "th",
          anchor,
          messages: [{ id: "m0", author: "you", body: "is this rate limiter correct?" }],
        },
      ],
      inFlight: [],
    };
  }) as RennetBridge["invoke"];
  return { invoke };
}

describe("ConversationHost — reattach render survives a mid-flight re-render (#251)", () => {
  it("restored thread PAINTS when anchors identity changes while reattach is in flight", async () => {
    const h = deferredReattachBridge([
      { id: "m0", author: "you", body: "is this correct?" },
      { id: "m1", author: "harness", model: "Claude", body: "yes, it fails open by design" },
    ]);
    const { container, rerender } = mount(
      <ConversationHost bridge={h.bridge} reviewId="r" anchors={freshAnchors()} />,
    );
    // The literal original bug: a plain App re-render hands a NEW anchors array (identical
    // content) mid-flight — exactly app.tsx's unmemoized `patchset.files.map(...)`.
    rerender(<ConversationHost bridge={h.bridge} reviewId="r" anchors={freshAnchors()} />);
    h.release();

    // The restored conversation must reach the surface. Pre-fix this stayed at 0 clusters.
    await waitFor(() => {
      expect(container.querySelectorAll(".conversation-cluster")).toHaveLength(1);
    });
    const cluster = container.querySelector(".conversation-cluster");
    expect(cluster?.textContent).toContain("yes, it fails open by design");
  });

  it("the INTERRUPTED surface survives the same mid-flight re-render", async () => {
    // #251 criterion 3: an interrupted turn must reach a person. If the reattach is
    // discarded by the race, the interrupted note never paints — the exact silent
    // completion the surface exists to prevent, one layer out.
    const h = deferredReattachBridge([
      { id: "m0", author: "you", body: "why fail open?" },
      { id: "m1", author: "harness", body: "", status: "interrupted" },
    ]);
    const { container, rerender } = mount(
      <ConversationHost bridge={h.bridge} reviewId="r" anchors={freshAnchors()} />,
    );
    rerender(<ConversationHost bridge={h.bridge} reviewId="r" anchors={freshAnchors()} />);
    h.release();

    await waitFor(() => {
      expect(container.querySelectorAll('.thread-message[data-status="interrupted"]')).toHaveLength(
        1,
      );
    });
    expect(container.querySelector(".thread-message-interrupted")?.textContent).toMatch(
      /interrupted before it finished/i,
    );
  });

  it("restored thread PAINTS under StrictMode (the real app's render tree)", async () => {
    // The renderer runs production React so StrictMode is inert at runtime, but a dev build
    // double-invokes effects; the same discard fault fires. This pins that it does not.
    const h = deferredReattachBridge([
      { id: "m0", author: "you", body: "is this correct?" },
      { id: "m1", author: "harness", model: "Claude", body: "yes, looks right" },
    ]);
    const { container } = mount(
      <StrictMode>
        <ConversationHost bridge={h.bridge} reviewId="r" anchors={freshAnchors()} />
      </StrictMode>,
    );
    h.release();
    await waitFor(() => {
      expect(container.querySelectorAll(".conversation-cluster")).toHaveLength(1);
    });
    expect(container.querySelector(".conversation-cluster")?.textContent).toContain(
      "yes, looks right",
    );
  });
});

describe("ConversationHost — placement RE-RESOLVES when the diff loads after reattach (#251)", () => {
  it("a thread restored before the diff loads resolves to ORPHANED once the file list arrives", async () => {
    // The race the one-shot fetch alone re-introduces: reattach lands BEFORE the diff loads
    // (anchors=[] ⇒ could-not-determine ⇒ PLACED), and if placement never re-runs, a gone
    // file's thread never paints its orphaned banner for the whole session. This is reachable:
    // a zero-file patchset renders "No changes", so the host mounts with anchors=[] and the
    // patchset later gains files. Here the thread is on src/gone.ts; the diff then loads with
    // only src/present.ts, so it must orphan.
    const bridge = immediateReattachBridge(GONE_ANCHOR);
    const { container, rerender } = mount(
      <ConversationHost bridge={bridge} reviewId="r" anchors={[]} />,
    );
    // The thread restores and is PLACED (could-not-determine) — visible, not falsely orphaned.
    await waitFor(() => {
      expect(container.querySelector(".conversation-cluster")).not.toBeNull();
    });
    expect(container.querySelector('.conversation-cluster[data-orphaned="true"]')).toBeNull();

    // The diff loads: src/present.ts only, src/gone.ts is gone. Placement must re-resolve.
    rerender(<ConversationHost bridge={bridge} reviewId="r" anchors={freshAnchors()} />);
    await waitFor(() => {
      expect(container.querySelector('.conversation-cluster[data-orphaned="true"]')).not.toBeNull();
    });
    const orphaned = container.querySelector('.conversation-cluster[data-orphaned="true"]');
    expect(orphaned?.querySelector(".conversation-orphaned")?.textContent).toMatch(
      /no longer in the diff/i,
    );
    // Never re-anchored: it keeps its ORIGINAL anchor key, not the present file's.
    expect(orphaned?.getAttribute("data-anchor-key")).toBe("chunk|src/gone.ts");
  });

  it("a thread restored before the diff loads STAYS PLACED when its file is present", async () => {
    // The complement: re-resolution must not orphan a thread whose file IS in the loaded diff.
    const bridge = immediateReattachBridge(ANCHOR); // src/present.ts
    const { container, rerender } = mount(
      <ConversationHost bridge={bridge} reviewId="r" anchors={[]} />,
    );
    await waitFor(() => {
      expect(container.querySelector(".conversation-cluster")).not.toBeNull();
    });
    rerender(<ConversationHost bridge={bridge} reviewId="r" anchors={freshAnchors()} />);
    // Give the placement effect a chance to run, then confirm it did NOT orphan.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(container.querySelector(".conversation-cluster")).not.toBeNull();
    expect(container.querySelector('.conversation-cluster[data-orphaned="true"]')).toBeNull();
  });
});
