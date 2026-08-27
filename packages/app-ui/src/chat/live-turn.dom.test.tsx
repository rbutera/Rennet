// @vitest-environment happy-dom
//
// C07 packet verification (task 8.2): a LIVE turn streams into the transcript. Over a
// MemoryBridge we emit `ask-delta`…`ask-delta`…`ask-complete` on `onAskStream`; the folded
// turn's prose GROWS then SETTLES in the transcript, and the orchestrator-presence
// affordance follows the in-flight state (present while streaming, gone once settled).
//
// POSITIVE CONTROL (run by hand during verification, then reverted): delete the
// `ask-complete` settle branch in `foldAskStream` (chat-data.ts) and the "presence gone
// after settle" assertion below reddens — the turn never leaves `inFlight`. Evidence is
// captured in the completion report.
import type { AskReviewResult } from "@rennet/protocol";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { BridgeProvider } from "../data";
import { act, cleanup, mount, screen, waitFor } from "../test/dom";
import { frontDoorHandlers } from "../test/fixtures/front-door";
import { MemoryBridge } from "../test/memory-bridge";
import { SessionTranscriptProvider } from "./chat-data";
import { ChatDock } from "./chat-dock";

const REVIEW_ID = "review-1";

afterEach(cleanup);

function DockHarness({ bridge }: { readonly bridge: MemoryBridge }): ReactNode {
  return (
    <BridgeProvider bridge={bridge}>
      <SessionTranscriptProvider
        value={{ reviewId: REVIEW_ID, rows: [], trail: { title: "Alpha" } }}
      >
        <ChatDock />
      </SessionTranscriptProvider>
    </BridgeProvider>
  );
}

function mountLive() {
  const bridge = new MemoryBridge({
    ...frontDoorHandlers(),
    "review.reattach": () => ({ threads: [], inFlight: [] }),
    "review.ask": (): AskReviewResult => ({
      mode: "orchestrator",
      primary: { model: "opus", answer: "done" },
    }),
  });
  return { ...mount(<DockHarness bridge={bridge} />), bridge };
}

const THREAD = "t1";
const TURN = "u1";
const emit = (bridge: MemoryBridge, event: Parameters<MemoryBridge["emitAskStream"]>[1]) =>
  act(() => bridge.emitAskStream(REVIEW_ID, event));

describe("a live turn streams into the transcript (task 8.2)", () => {
  it("grows the prose across deltas, then settles and drops the presence affordance", async () => {
    const { bridge, getByTestId } = mountLive();
    // Settle the initial reattach load before the stream begins (production ordering).
    await act(async () => {
      await Promise.resolve();
    });
    const transcript = getByTestId("chat-dock-transcript");

    // First delta: partial prose arrives, the turn is streaming ⇒ presence is shown.
    emit(bridge, {
      kind: "ask-delta",
      threadId: THREAD,
      turnId: TURN,
      channel: "orchestrator",
      delta: "The matcher",
      seq: 0,
    });
    await waitFor(() => expect(transcript.textContent).toContain("The matcher"));
    expect(screen.getByText(/orchestrator is working/)).toBeTruthy();

    // Second delta: the SAME turn's prose grows.
    emit(bridge, {
      kind: "ask-delta",
      threadId: THREAD,
      turnId: TURN,
      channel: "orchestrator",
      delta: " still excludes those routes.",
      seq: 1,
    });
    await waitFor(() =>
      expect(transcript.textContent).toContain("The matcher still excludes those routes."),
    );

    // Complete: the turn settles — the final body stands and presence disappears.
    emit(bridge, {
      kind: "ask-complete",
      threadId: THREAD,
      turnId: TURN,
      channel: "orchestrator",
      model: "opus",
      finalBody: "The matcher still excludes those routes.",
      seq: 2,
    });
    await waitFor(() => expect(screen.queryByText(/orchestrator is working/)).toBeNull());
    expect(transcript.textContent).toContain("The matcher still excludes those routes.");
  });

  it("rejects a replayed delta by its seq — the prose does not double", async () => {
    const { bridge, getByTestId } = mountLive();
    await act(async () => {
      await Promise.resolve();
    });
    const transcript = getByTestId("chat-dock-transcript");
    emit(bridge, {
      kind: "ask-delta",
      threadId: THREAD,
      turnId: TURN,
      channel: "orchestrator",
      delta: "once",
      seq: 5,
    });
    await waitFor(() => expect(transcript.textContent).toContain("once"));
    // A replay at the SAME seq must not append again (wire contract: seq idempotence).
    emit(bridge, {
      kind: "ask-delta",
      threadId: THREAD,
      turnId: TURN,
      channel: "orchestrator",
      delta: "once",
      seq: 5,
    });
    expect(transcript.textContent?.match(/once/g)?.length).toBe(1);
  });
});
