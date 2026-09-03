// @vitest-environment happy-dom
import {
  type AskProjection,
  type CommandInput,
  type CommandOutput,
  findingRefKey,
} from "@rennet/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BridgeProvider } from "../data";
import { useBridgeContext } from "../data/bridge";
import { useRennetStore } from "../store";
import { act, cleanup, mount, screen, waitFor } from "../test/dom";
import { MemoryBridge } from "../test/memory-bridge";
import { anchoredAskText, ReviewAnchoredAskProvider, useAnchoredAsk } from "./anchored-ask";
import { useAskLog } from "./ask-log";

function Send({ threadId }: { readonly threadId: string }) {
  const send = useAnchoredAsk();
  return (
    <button
      type="button"
      onClick={() =>
        void send?.({
          threadId,
          question: "Why this fix?",
          excerpt: "`rawCall()` [source](packages/core/src/a.ts)",
          target: "finding-1",
          generation: "gen-2",
        })
      }
    >
      Anchored send
    </button>
  );
}

let capturedCache: ReturnType<typeof useBridgeContext>["cache"] | undefined;

function CaptureCache() {
  capturedCache = useBridgeContext().cache;
  return null;
}

function AskLogBinding({ reviewId }: { readonly reviewId: string }) {
  useAskLog(reviewId);
  return null;
}

const RECONCILE_FINDING = {
  generation: "gen-2",
  boardId: "board:flagged:gen-2",
  findingId: "finding-1",
} as const;

function DismissFinding() {
  const dismissFinding = useRennetStore((state) => state.reviewActions.dismissFinding);
  return (
    <button type="button" onClick={() => dismissFinding(RECONCILE_FINDING)}>
      Dismiss finding
    </button>
  );
}

function UnstageAsk({ id }: { readonly id: string }) {
  const unstageAsk = useRennetStore((state) => state.reviewActions.unstageAsk);
  return (
    <button type="button" onClick={() => unstageAsk(id)}>
      Unstage ask
    </button>
  );
}

function emptyProjection(quoteThreads: AskProjection["quoteThreads"] = {}): AskProjection {
  return {
    stagedAsks: {},
    findingDispositions: {},
    lineComments: {},
    quoteThreads,
    retired: {},
    verdictOverride: null,
  };
}

beforeEach(() => {
  capturedCache = undefined;
  useRennetStore.getState().reviewActions.resetReview();
});
afterEach(cleanup);

describe("useAskLog write reconciliation", () => {
  it("applies a server-authored projection while the review remains open", async () => {
    const ask = {
      id: "round-ask",
      anchor: "src/a.ts:1",
      type: "request-change" as const,
      body: "Fix this in the next round.",
    };
    const bridge = new MemoryBridge({
      "ask.read": () => ({
        projection: { ...emptyProjection(), stagedAsks: { [ask.id]: ask } },
      }),
    });
    mount(
      <BridgeProvider bridge={bridge}>
        <AskLogBinding reviewId="review-1" />
      </BridgeProvider>,
    );
    await waitFor(() => expect(useRennetStore.getState().review.stagedAsks[ask.id]).toEqual(ask));

    act(() => bridge.emitAskProjection("another-review", emptyProjection()));
    expect(useRennetStore.getState().review.stagedAsks[ask.id]).toEqual(ask);

    act(() => bridge.emitAskProjection("review-1", emptyProjection()));
    await waitFor(() =>
      expect(useRennetStore.getState().review.stagedAsks[ask.id]).toBeUndefined(),
    );
  });

  it("applies a cleanup push held behind a local write even when the refresh fails", async () => {
    const ask = {
      id: "round-ask",
      anchor: "src/a.ts:1",
      type: "request-change" as const,
      body: "Fix this in the next round.",
    };
    let reads = 0;
    let resolveWrite!: (output: CommandOutput<"ask.dismissFinding">) => void;
    const pendingWrite = new Promise<CommandOutput<"ask.dismissFinding">>((resolve) => {
      resolveWrite = resolve;
    });
    const bridge = new MemoryBridge({
      "ask.read": () => {
        reads += 1;
        if (reads > 1) throw new Error("refresh unavailable");
        return { projection: { ...emptyProjection(), stagedAsks: { [ask.id]: ask } } };
      },
      "ask.dismissFinding": () => pendingWrite,
    });
    const view = mount(
      <BridgeProvider bridge={bridge}>
        <AskLogBinding reviewId="review-1" />
        <DismissFinding />
      </BridgeProvider>,
    );
    await waitFor(() => expect(useRennetStore.getState().review.stagedAsks[ask.id]).toEqual(ask));

    await act(async () => view.user.click(view.getByText("Dismiss finding")));
    act(() => bridge.emitAskProjection("review-1", emptyProjection()));
    expect(useRennetStore.getState().review.stagedAsks[ask.id]).toEqual(ask);

    await act(async () =>
      resolveWrite({ receipt: { kind: "finding-restore", finding: RECONCILE_FINDING } }),
    );
    await waitFor(() => expect(reads).toBeGreaterThan(1));
    expect(useRennetStore.getState().review.stagedAsks[ask.id]).toBeUndefined();
  });

  it("re-reads after a rejected write and removes the optimistic ghost", async () => {
    let reads = 0;
    let rejectWrite!: (error: Error) => void;
    const pendingWrite = new Promise<never>((_resolve, reject) => {
      rejectWrite = reject;
    });
    const bridge = new MemoryBridge({
      "ask.read": () => {
        reads += 1;
        return { projection: emptyProjection() };
      },
      "ask.dismissFinding": () => pendingWrite,
    });
    const view = mount(
      <BridgeProvider bridge={bridge}>
        <AskLogBinding reviewId="review-1" />
        <DismissFinding />
      </BridgeProvider>,
    );
    await waitFor(() => expect(reads).toBe(1));

    await act(async () => view.user.click(view.getByText("Dismiss finding")));
    const key = findingRefKey(RECONCILE_FINDING);
    expect(useRennetStore.getState().review.findingDispositions[key]).toBeDefined();

    await act(async () => rejectWrite(new Error("disk full")));
    await waitFor(() => expect(reads).toBeGreaterThan(1));
    await waitFor(() =>
      expect(useRennetStore.getState().review.findingDispositions[key]).toBeUndefined(),
    );
  });

  it("re-reads after a successful write settles and trusts the durable projection", async () => {
    const ask = {
      id: "durable-ask",
      anchor: "src/a.ts:1",
      type: "request-change" as const,
      body: "Keep the durable request.",
    };
    const projection: AskProjection = {
      ...emptyProjection(),
      stagedAsks: { [ask.id]: ask },
    };
    let reads = 0;
    let resolveWrite!: (output: CommandOutput<"ask.unstage">) => void;
    const pendingWrite = new Promise<CommandOutput<"ask.unstage">>((resolve) => {
      resolveWrite = resolve;
    });
    const bridge = new MemoryBridge({
      "ask.read": () => {
        reads += 1;
        return { projection: { ...projection } };
      },
      "ask.unstage": () => pendingWrite,
    });
    const view = mount(
      <BridgeProvider bridge={bridge}>
        <AskLogBinding reviewId="review-1" />
        <UnstageAsk id={ask.id} />
      </BridgeProvider>,
    );
    await waitFor(() => expect(useRennetStore.getState().review.stagedAsks[ask.id]).toEqual(ask));

    await act(async () => view.user.click(view.getByText("Unstage ask")));
    expect(useRennetStore.getState().review.stagedAsks[ask.id]).toBeUndefined();
    expect(reads).toBe(1);

    await act(async () => resolveWrite({ receipt: { kind: "stage", ask } }));
    await waitFor(() => expect(reads).toBeGreaterThan(1));
    await waitFor(() => expect(useRennetStore.getState().review.stagedAsks[ask.id]).toEqual(ask));
  });
});

describe("ReviewAnchoredAskProvider (t3-lens-threads 4.2)", () => {
  it("starts one turn on the review thread carrying the question and the cited span, and opens the chat", async () => {
    const threadId = useRennetStore
      .getState()
      .reviewActions.addQuoteComment("rawCall() source", "Explain this passage.", "explain", {
        target: "finding-1",
        generation: "gen-2",
      });
    const sends: CommandInput<"chat.t3Send">[] = [];
    const bridge = new MemoryBridge({
      "chat.t3Send": (input) => {
        sends.push(input);
        return { threadId: "t3-thread-1" };
      },
    });
    act(() => useRennetStore.getState().uiActions.setChatOpen(false));
    const view = mount(
      <BridgeProvider bridge={bridge}>
        <ReviewAnchoredAskProvider reviewId="review-1">
          <Send threadId={threadId} />
        </ReviewAnchoredAskProvider>
      </BridgeProvider>,
    );

    await act(async () => view.user.click(view.getByText("Anchored send")));

    // ONE turn, on the review the provider names, carrying both halves: the question and
    // the span it was asked about. The answer streams in T3 own view, so nothing here
    // reads a reply back. This asserts what was SENT, which is all this path now owns.
    expect(sends).toHaveLength(1);
    expect(sends[0]?.reviewId).toBe("review-1");
    expect(sends[0]?.text).toContain("Why this fix?");
    expect(sends[0]?.text).toContain("packages/core/src/a.ts");
    // The question comes FIRST: a position assertion, not two membership checks that a
    // reversed compose would satisfy just as well.
    expect(sends[0]?.text.indexOf("Why this fix?")).toBeLessThan(
      sends[0]?.text.indexOf("packages/core/src/a.ts") ?? -1,
    );
    // And the dock is open, because that is where the answer arrives. Asking with nothing
    // opening would read to the reviewer as a dropped ask.
    expect(useRennetStore.getState().ui.chatOpen).toBe(true);
  });

  it("caps a long cited span with an honest truncation marker", () => {
    const long = "x".repeat(2_000);
    const text = anchoredAskText({ question: "why?", excerpt: long });
    expect(text.length).toBeLessThan(long.length);
    expect(text).toContain("(truncated)");
    expect(text.startsWith("why?")).toBe(true);
  });
});
