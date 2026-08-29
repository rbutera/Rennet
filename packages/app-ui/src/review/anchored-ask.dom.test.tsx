// @vitest-environment happy-dom
import {
  type AskProjection,
  type CommandInput,
  type CommandOutput,
  findingRefKey,
  type ReattachResult,
} from "@rennet/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { reviewReattachKey, SessionTranscriptProvider } from "../chat/chat-data";
import { ChatDock } from "../chat/chat-dock";
import { BridgeProvider } from "../data";
import { useBridgeContext } from "../data/bridge";
import { useRennetStore } from "../store";
import { act, cleanup, mount, screen, waitFor } from "../test/dom";
import { MemoryBridge } from "../test/memory-bridge";
import { ReviewAnchoredAskProvider, useAnchoredAsk } from "./anchored-ask";
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

describe("ReviewAnchoredAskProvider", () => {
  it("dispatches once on the existing thread and persists the real reply", async () => {
    const threadId = useRennetStore
      .getState()
      .reviewActions.addQuoteComment("rawCall() source", "Explain this passage.", "explain", {
        target: "finding-1",
        generation: "gen-2",
      });
    const seen: CommandInput<"review.ask">[] = [];
    const replyWrites: CommandInput<"ask.quoteReply">[] = [];
    const bridge = new MemoryBridge({
      "review.reattach": () => ({ threads: [], inFlight: [] }),
      "review.ask": (input) => {
        seen.push(input);
        return {
          mode: "orchestrator",
          primary: { model: "Orchestrator · Claude", answer: "It preserves identity." },
        };
      },
      "ask.quoteReply": (input) => {
        replyWrites.push(input);
        return { receipt: { kind: "quote-reply", threadId, messages: [] } };
      },
    });
    const view = mount(
      <BridgeProvider bridge={bridge}>
        <CaptureCache />
        <ReviewAnchoredAskProvider reviewId="review-1">
          <Send threadId={threadId} />
        </ReviewAnchoredAskProvider>
      </BridgeProvider>,
    );

    capturedCache?.setData(reviewReattachKey("review-1"), () => ({ threads: [], inFlight: [] }));
    await act(async () => view.user.click(view.getByText("Anchored send")));

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      reviewId: "review-1",
      threadId,
      question: "Why this fix?",
      turnBody: "Why this fix?",
      anchor: {
        kind: "fragment",
        key: threadId,
        context: "`rawCall()` [source](packages/core/src/a.ts)",
      },
      selection: {
        anchor: "board:gen-2:finding-1",
        excerpt: "`rawCall()` [source](packages/core/src/a.ts)",
        target: "finding-1",
        generation: "gen-2",
      },
    });
    expect(seen[0]?.commandId).toMatch(/^[0-9a-f-]{36}$/);
    expect(seen[0]?.turnId).toMatch(/^[0-9a-f-]{36}$/);
    const cached = capturedCache?.getSnapshot(reviewReattachKey("review-1")).data as
      | ReattachResult
      | undefined;
    expect(cached?.threads[0]?.messages[0]).toMatchObject({
      id: `${seen[0]?.turnId}::you`,
      author: "you",
      body: "Why this fix?",
    });
    await waitFor(() => expect(replyWrites).toHaveLength(1));
    expect(replyWrites[0]).toEqual({
      sessionId: "review-1",
      threadId,
      author: "orchestrator",
      text: "It preserves identity.",
    });
  });

  it("replays its user echo after an older in-flight reattach snapshot lands", async () => {
    const threadId = useRennetStore
      .getState()
      .reviewActions.addQuoteComment("rawCall()", "Explain this passage.", "explain");
    let resolveReattach!: (value: ReattachResult) => void;
    let reattachCalled = false;
    const pendingReattach = new Promise<ReattachResult>((resolve) => {
      resolveReattach = resolve;
    });
    const bridge = new MemoryBridge({
      "review.reattach": () => {
        reattachCalled = true;
        return pendingReattach;
      },
      "session.transcript": () => ({ trail: { title: "Review" }, rows: [] }),
      "review.ask": () => ({
        mode: "orchestrator",
        primary: { model: "Orchestrator · Claude", answer: "A real reply." },
      }),
    });
    const view = mount(
      <BridgeProvider bridge={bridge}>
        <SessionTranscriptProvider value={{ reviewId: "review-1" }}>
          <ChatDock />
        </SessionTranscriptProvider>
        <ReviewAnchoredAskProvider reviewId="review-1">
          <Send threadId={threadId} />
        </ReviewAnchoredAskProvider>
      </BridgeProvider>,
    );

    await waitFor(() => expect(reattachCalled).toBe(true));
    await act(async () => view.user.click(view.getByText("Anchored send")));
    await act(async () => resolveReattach({ threads: [], inFlight: [] }));

    await waitFor(() => expect(screen.getByText("Why this fix?")).toBeTruthy());
  });

  it("persists a late answer against the originating review after the provider switches", async () => {
    const threadId = "qt-origin";
    const originThread = {
      anchor: "rawCall()",
      kind: "explain" as const,
      messages: [{ author: "user" as const, text: "Explain this passage." }],
    };
    let resolveAsk!: (value: {
      mode: "orchestrator";
      primary: { model: string; answer: string };
    }) => void;
    const pendingAsk = new Promise<{
      mode: "orchestrator";
      primary: { model: string; answer: string };
    }>((resolve) => {
      resolveAsk = resolve;
    });
    const replyWrites: CommandInput<"ask.quoteReply">[] = [];
    const bridge = new MemoryBridge({
      "ask.read": ({ sessionId }) => ({
        projection:
          sessionId === "review-a"
            ? emptyProjection({ [threadId]: originThread })
            : emptyProjection(),
      }),
      "review.reattach": () => ({ threads: [], inFlight: [] }),
      "review.ask": () => pendingAsk,
      "ask.quoteReply": (input) => {
        replyWrites.push(input);
        return { receipt: { kind: "quote-reply", threadId, messages: originThread.messages } };
      },
    });
    const render = (reviewId: string, showSend: boolean) => (
      <BridgeProvider bridge={bridge}>
        <AskLogBinding reviewId={reviewId} />
        <ReviewAnchoredAskProvider reviewId={reviewId}>
          {showSend ? <Send threadId={threadId} /> : null}
        </ReviewAnchoredAskProvider>
      </BridgeProvider>
    );
    const view = mount(render("review-a", true));
    await waitFor(() =>
      expect(useRennetStore.getState().review.quoteThreads[threadId]).toEqual(originThread),
    );

    await act(async () => view.user.click(view.getByText("Anchored send")));
    view.rerender(render("review-b", false));
    await waitFor(() =>
      expect(useRennetStore.getState().review.quoteThreads[threadId]).toBeUndefined(),
    );
    await act(async () =>
      resolveAsk({
        mode: "orchestrator",
        primary: { model: "Orchestrator · Claude", answer: "It survives the switch." },
      }),
    );

    await waitFor(() => expect(replyWrites).toHaveLength(1));
    expect(replyWrites[0]).toEqual({
      sessionId: "review-a",
      threadId,
      author: "orchestrator",
      text: "It survives the switch.",
    });
    expect(useRennetStore.getState().review.quoteThreads[threadId]).toBeUndefined();
  });

  it("repairs a quote reply from the durable reattach transcript after reload", async () => {
    const threadId = "qt-reloaded";
    let projection = emptyProjection({
      [threadId]: {
        anchor: "rawCall()",
        kind: "explain",
        messages: [{ author: "user", text: "Explain this passage." }],
      },
    });
    const replyWrites: CommandInput<"ask.quoteReply">[] = [];
    const bridge = new MemoryBridge({
      "ask.read": () => ({ projection }),
      "review.reattach": () => ({
        threads: [
          {
            threadId,
            anchor: { kind: "fragment", key: threadId, label: "rawCall()" },
            messages: [
              { id: "turn-1::you", author: "you", body: "Explain this passage." },
              {
                id: "turn-1::orchestrator",
                author: "harness",
                body: "Recovered after reload.",
                status: "complete",
              },
            ],
          },
        ],
        inFlight: [],
      }),
      "ask.quoteReply": (input) => {
        replyWrites.push(input);
        const thread = projection.quoteThreads[threadId];
        if (!thread) throw new Error("expected persisted quote thread");
        projection = emptyProjection({
          [threadId]: {
            ...thread,
            messages: [...thread.messages, { author: input.author, text: input.text }],
          },
        });
        return { receipt: { kind: "quote-reply", threadId, messages: thread.messages } };
      },
    });

    mount(
      <BridgeProvider bridge={bridge}>
        <AskLogBinding reviewId="review-a" />
        <ReviewAnchoredAskProvider reviewId="review-a">
          <span>Board</span>
        </ReviewAnchoredAskProvider>
      </BridgeProvider>,
    );

    await waitFor(() => expect(replyWrites).toHaveLength(1));
    expect(replyWrites[0]?.sessionId).toBe("review-a");
    await waitFor(() =>
      expect(useRennetStore.getState().review.quoteThreads[threadId]?.messages.at(-1)).toEqual({
        author: "orchestrator",
        text: "Recovered after reload.",
      }),
    );
  });

  it("repairs an earlier failed reply write without losing durable reply order", async () => {
    const threadId = "qt-gap";
    const initialThread = {
      anchor: "rawCall()",
      kind: "explain" as const,
      messages: [
        { author: "user" as const, text: "Explain this passage." },
        { author: "orchestrator" as const, text: "Reply B" },
      ],
    };
    const projection = emptyProjection({ [threadId]: initialThread });
    const replacements: CommandInput<"ask.quoteOpen">[] = [];
    const replyWrites: CommandInput<"ask.quoteReply">[] = [];
    const bridge = new MemoryBridge({
      "ask.read": () => ({ projection }),
      "review.reattach": () => ({
        threads: [
          {
            threadId,
            anchor: { kind: "fragment", key: threadId, label: "rawCall()" },
            messages: [
              { id: "turn-0::you", author: "you", body: "Explain this passage." },
              {
                id: "turn-a::orchestrator",
                author: "harness",
                body: "Reply A",
                status: "complete",
              },
              {
                id: "turn-b::orchestrator",
                author: "harness",
                body: "Reply B",
                status: "complete",
              },
            ],
          },
        ],
        inFlight: [],
      }),
      "ask.quoteOpen": (input) => {
        replacements.push(input);
        return { receipt: { kind: "quote-open", threadId, thread: initialThread } };
      },
      "ask.quoteReply": (input) => {
        replyWrites.push(input);
        return { receipt: { kind: "quote-reply", threadId, messages: initialThread.messages } };
      },
    });

    mount(
      <BridgeProvider bridge={bridge}>
        <AskLogBinding reviewId="review-a" />
        <ReviewAnchoredAskProvider reviewId="review-a">
          <span>Board</span>
        </ReviewAnchoredAskProvider>
      </BridgeProvider>,
    );

    await waitFor(() => expect(replacements).toHaveLength(1));
    expect(replyWrites).toEqual([]);
    expect(replacements[0]).toEqual({
      sessionId: "review-a",
      threadId,
      thread: {
        ...initialThread,
        messages: [
          { author: "user", text: "Explain this passage." },
          { author: "orchestrator", text: "Reply A" },
          { author: "orchestrator", text: "Reply B" },
        ],
      },
    });
  });
});
