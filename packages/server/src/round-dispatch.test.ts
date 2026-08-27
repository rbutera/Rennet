import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AskLogStore } from "@rennet/adapters";
import type { ComposedHandoffBundle, Review, SessionModel } from "@rennet/protocol";
import { describe, expect, it, vi } from "vitest";
import { createDispatchRuntime, type DispatchDeps } from "./dispatch";
import { roundHandlers } from "./dispatch/round";
import { createRoundsRuntime, type RoundsRuntimeDeps } from "./runtime/rounds";

// B11 cluster 4 — the round exit's dispatch. Two surfaces: the `round.dispatch` HANDLER
// (asks → ONE work-order, coalesced so the runtime is kicked once per distinct work-order) and
// the rounds runtime's `dispatchRound` SERIALIZER (one round in flight per session). The durable
// cross-restart idempotency is `runRound`/`runOnce`'s (loadDraftedBoards), proven in B09's
// `packet-e2e.test.ts` and wired live by cluster 4 — not re-proven here.

const REVIEW_ID = "review-1";

/** A minimal review whose active patchset carries no files (the work-order needs the asks, not
 *  the diff context, to be exactly one order carrying the staged asks). */
const REVIEW = {
  id: REVIEW_ID,
  repositoryRoot: "/repo",
  activePatchsetId: "ps-1",
  patchsets: [{ id: "ps-1", createdAt: "", truncated: false, files: [] }],
  dispositions: [],
  status: "current",
} as unknown as Review;

/** Build the round handler over a real ask-log store (keyed by review id — the session contract)
 *  plus an injected `dispatchRound` seam spy. `composeBundle` is omitted, so the handler composes
 *  the mechanical floor: one work-order carrying every addressed ask. */
function harness(dispatchRound?: DispatchDeps["dispatchRound"]) {
  const store = new AskLogStore(mkdtempSync(join(tmpdir(), "rennet-round-dispatch-")));
  const rt = createDispatchRuntime({
    askLog: store,
    service: { reviewById: (id: string) => (id === REVIEW_ID ? REVIEW : undefined) },
    ...(dispatchRound ? { dispatchRound } : {}),
  } as unknown as DispatchDeps);
  return { store, dispatch: roundHandlers(rt)["round.dispatch"] };
}

type DispatchResult = { workOrder: ComposedHandoffBundle; dispatched: boolean };

describe("round.dispatch (B11 4.2) — asks → one work-order, coalesced", () => {
  it("folds the durable asks into exactly one work-order carrying the staged asks", async () => {
    const { store, dispatch } = harness();
    // Two addressed asks (one code-anchored, one prose) + a question (excluded from the handoff).
    store.append(REVIEW_ID, {
      kind: "stage",
      ask: { id: "a1", anchor: "src/x.ts:10", type: "request-change", body: "rename the export" },
    });
    store.append(REVIEW_ID, {
      kind: "stage",
      ask: { id: "a2", anchor: "This section reads well.", type: "comment", body: "tighten it" },
    });
    store.append(REVIEW_ID, {
      kind: "stage",
      ask: { id: "a3", anchor: "src/x.ts:20", type: "question", body: "why here?" },
    });

    const { workOrder, dispatched } = (await dispatch({ reviewId: REVIEW_ID })) as DispatchResult;

    expect(dispatched).toBe(true);
    // ONE work-order, over this review's active patchset, carrying the two ADDRESSED asks — the
    // question is filtered (`isAddressedByHandoff`), so it is neither a task nor in the prompt.
    expect(workOrder.reviewId).toBe(REVIEW_ID);
    expect(workOrder.patchsetId).toBe("ps-1");
    expect(workOrder.tasks).toHaveLength(2);
    expect(workOrder.prompt).toContain("rename the export");
    expect(workOrder.prompt).toContain("tighten it");
    expect(workOrder.prompt).not.toContain("why here?");
  });

  it("a second dispatch of the same asks kicks the runtime exactly once (idempotent)", async () => {
    const dispatchRound = vi.fn(() => Promise.resolve());
    const { store, dispatch } = harness(dispatchRound);
    store.append(REVIEW_ID, {
      kind: "stage",
      ask: { id: "a1", anchor: "src/x.ts:1", type: "request-change", body: "fix" },
    });

    await dispatch({ reviewId: REVIEW_ID });
    await dispatch({ reviewId: REVIEW_ID });

    // The positive control: the injected runtime saw ONE call for the identical work-order.
    expect(dispatchRound).toHaveBeenCalledTimes(1);
  });

  it("a dispatch of the same asks while one is in flight is coalesced, not raced", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const dispatchRound = vi.fn(async () => {
      await gate;
    });
    const { store, dispatch } = harness(dispatchRound);
    store.append(REVIEW_ID, {
      kind: "stage",
      ask: { id: "a1", anchor: "src/x.ts:1", type: "request-change", body: "fix" },
    });

    // Both dispatch while the first kick is still pending — the second must coalesce onto it.
    const [r1, r2] = await Promise.all([
      dispatch({ reviewId: REVIEW_ID }),
      dispatch({ reviewId: REVIEW_ID }),
    ]);
    release();

    expect(dispatchRound).toHaveBeenCalledTimes(1);
    expect((r1 as DispatchResult).dispatched).toBe(true);
    expect((r2 as DispatchResult).dispatched).toBe(true);
  });

  it("finding 8: refuses the round exit on a TEAMMATE PR (the lane is own-branch only)", async () => {
    // A review with a post target the viewer did NOT author is a teammate PR: its exit is
    // *Post review*, never a coding round (handoff-and-exits.md "Work orders are own-branch
    // only"). The lane is ABSENT — dispatch honestly returns an empty order, no kick.
    const teamReview = {
      ...(REVIEW as object),
      postTarget: { number: 7, viewerDidAuthor: false },
    } as unknown as Review;
    const dispatchRound = vi.fn(() => Promise.resolve());
    const store = new AskLogStore(mkdtempSync(join(tmpdir(), "rennet-round-team-")));
    const rt = createDispatchRuntime({
      askLog: store,
      service: { reviewById: (id: string) => (id === REVIEW_ID ? teamReview : undefined) },
      dispatchRound,
    } as unknown as DispatchDeps);
    const dispatch = roundHandlers(rt)["round.dispatch"];
    store.append(REVIEW_ID, {
      kind: "stage",
      ask: { id: "a1", anchor: "src/x.ts:1", type: "request-change", body: "fix" },
    });

    const { dispatched } = (await dispatch({ reviewId: REVIEW_ID })) as DispatchResult;
    expect(dispatched).toBe(false);
    expect(dispatchRound).not.toHaveBeenCalled();
  });

  it("finding 8: DISPATCHES on the viewer's OWN pull request (viewerDidAuthor true)", async () => {
    const ownPr = {
      ...(REVIEW as object),
      postTarget: { number: 7, viewerDidAuthor: true },
    } as unknown as Review;
    const dispatchRound = vi.fn(() => Promise.resolve());
    const store = new AskLogStore(mkdtempSync(join(tmpdir(), "rennet-round-ownpr-")));
    const rt = createDispatchRuntime({
      askLog: store,
      service: { reviewById: (id: string) => (id === REVIEW_ID ? ownPr : undefined) },
      dispatchRound,
    } as unknown as DispatchDeps);
    const dispatch = roundHandlers(rt)["round.dispatch"];
    store.append(REVIEW_ID, {
      kind: "stage",
      ask: { id: "a1", anchor: "src/x.ts:1", type: "request-change", body: "fix" },
    });

    const { dispatched } = (await dispatch({ reviewId: REVIEW_ID })) as DispatchResult;
    expect(dispatched).toBe(true);
    expect(dispatchRound).toHaveBeenCalledTimes(1);
  });

  it("an empty ask set composes nothing to dispatch — no kick, no round", async () => {
    const dispatchRound = vi.fn(() => Promise.resolve());
    const { dispatch } = harness(dispatchRound);

    const { workOrder, dispatched } = (await dispatch({ reviewId: REVIEW_ID })) as DispatchResult;

    expect(dispatched).toBe(false);
    expect(workOrder.tasks).toHaveLength(0);
    expect(dispatchRound).not.toHaveBeenCalled();
  });

  it("a FAILED kick is evicted so an identical re-dispatch runs again (retryable)", async () => {
    const dispatchRound = vi.fn(async () => {
      throw new Error("no harness");
    });
    const { store, dispatch } = harness(dispatchRound);
    store.append(REVIEW_ID, {
      kind: "stage",
      ask: { id: "a1", anchor: "src/x.ts:1", type: "request-change", body: "fix" },
    });

    await dispatch({ reviewId: REVIEW_ID });
    // Let the rejected kick settle so its key is evicted before the retry.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await dispatch({ reviewId: REVIEW_ID });

    expect(dispatchRound).toHaveBeenCalledTimes(2);
  });
});

// ── The rounds runtime's per-session serializer (reused by `dispatchRound`, no second lock) ──

function runtimeDeps(): RoundsRuntimeDeps {
  return {
    resolveClaudePort: async () => null,
    resolveCodexExecutor: async () => null,
    boardsRuntimeFor: () =>
      ({ service: {}, createRennetBoard: async () => "board-1" }) as unknown as ReturnType<
        RoundsRuntimeDeps["boardsRuntimeFor"]
      >,
    readPrompt: () => "",
  };
}

const session = (id: string): SessionModel =>
  ({ id, projectId: "/repo", threads: [], createdAt: 0 }) as SessionModel;
const WORK_ORDER = {} as ComposedHandoffBundle;

describe("createRoundsRuntime.dispatchRound (B11 4.2) — one round in flight per session", () => {
  it("serializes concurrent dispatches on one session (the second waits for the first)", async () => {
    const runtime = createRoundsRuntime(runtimeDeps());
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const first = runtime.dispatchRound({
      session: session("s1"),
      workOrder: WORK_ORDER,
      runWorkers: async () => {
        order.push("1-start");
        await gate;
        order.push("1-end");
      },
    });
    const second = runtime.dispatchRound({
      session: session("s1"),
      workOrder: WORK_ORDER,
      runWorkers: async () => {
        order.push("2-start");
      },
    });

    // The second worker has NOT started while the first is still in flight (serialized, not raced).
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(order).toEqual(["1-start"]);

    release();
    await Promise.all([first, second]);
    expect(order).toEqual(["1-start", "1-end", "2-start"]);
  });

  it("finding 4: a FAILED worker turn rejects the round (memo evicts → retryable) without wedging the session", async () => {
    const runtime = createRoundsRuntime(runtimeDeps());
    // The create-server wiring throws when `runHandoffTurn` returns `{status:"failed"}`; model
    // that here — a failed turn must REJECT the round so `round.dispatch`'s per-key memo drops
    // the key and an identical re-dispatch retries, rather than memoizing a failure forever.
    await expect(
      runtime.dispatchRound({
        session: session("s1"),
        workOrder: WORK_ORDER,
        runWorkers: async () => {
          throw new Error("round worker turn failed: no harness");
        },
      }),
    ).rejects.toThrow(/round worker turn failed/);

    // The session tail is not wedged by the failure: a subsequent (successful) round still runs.
    const ran = vi.fn(() => Promise.resolve());
    await runtime.dispatchRound({ session: session("s1"), workOrder: WORK_ORDER, runWorkers: ran });
    expect(ran).toHaveBeenCalledTimes(1);
  });

  it("finding 4: a SUCCESSFUL round runs its ripening after the worker turn lands", async () => {
    const runtime = createRoundsRuntime(runtimeDeps());
    // Model the create-server runWorkers: after a completed turn it re-composes (ripens).
    const ripen = vi.fn(() => Promise.resolve());
    await runtime.dispatchRound({
      session: session("s1"),
      workOrder: WORK_ORDER,
      runWorkers: async () => {
        // (a completed turn does not throw) …
        await ripen();
      },
    });
    expect(ripen).toHaveBeenCalledTimes(1);
  });

  it("runs dispatches on different sessions concurrently (the lock is per session)", async () => {
    const runtime = createRoundsRuntime(runtimeDeps());
    const started: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const a = runtime.dispatchRound({
      session: session("sA"),
      workOrder: WORK_ORDER,
      runWorkers: async () => {
        started.push("A");
        await gate;
      },
    });
    const b = runtime.dispatchRound({
      session: session("sB"),
      workOrder: WORK_ORDER,
      runWorkers: async () => {
        started.push("B");
      },
    });

    // sB does not queue behind sA — both start before sA releases.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(started.sort()).toEqual(["A", "B"]);

    release();
    await Promise.all([a, b]);
  });
});
