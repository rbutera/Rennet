import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AskLogStore, RoundRecordStore } from "@rennet/adapters";
import type { HarnessPort, LintTarget } from "@rennet/core";
import type {
  AskOccurrence,
  ComposedHandoffBundle,
  DraftBoard,
  Review,
  RoundEvent,
  RoundRecord,
  SessionModel,
} from "@rennet/protocol";
import { ROUND_NO_REGEN, sha256Hex } from "@rennet/protocol";
import { describe, expect, it, vi } from "vitest";
import { createDispatchRuntime, type DispatchDeps } from "./dispatch";
import { roundHandlers } from "./dispatch/round";
import {
  createRoundsRuntime,
  type DispatchRoundResult,
  type RoundsRuntimeDeps,
} from "./runtime/rounds";

// B11 cluster 4 — the round exit's dispatch. Two surfaces: the `round.dispatch` HANDLER
// (asks → ONE work-order, coalesced so the runtime is kicked once per distinct work-order) and
// the rounds runtime's `dispatchRound` SERIALIZER (one round in flight per session). The durable
// cross-restart boundaries are the completed dispatch record for the worker and the
// Generation-owned BoardMeta attempt for regeneration.

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
function harness(
  dispatchRound?: DispatchDeps["dispatchRound"],
  options: {
    readonly store?: AskLogStore;
    readonly roundRecordsForReview?: DispatchDeps["roundRecordsForReview"];
    readonly broadcastAskProjection?: DispatchDeps["broadcastAskProjection"];
    readonly queueRoundIfActive?: DispatchDeps["queueRoundIfActive"];
    readonly composeBundle?: DispatchDeps["composeBundle"];
  } = {},
) {
  const store =
    options.store ?? new AskLogStore(mkdtempSync(join(tmpdir(), "rennet-round-dispatch-")));
  const rt = createDispatchRuntime({
    askLog: store,
    service: { reviewById: (id: string) => (id === REVIEW_ID ? REVIEW : undefined) },
    ...(dispatchRound ? { dispatchRound } : {}),
    ...(options.roundRecordsForReview === undefined
      ? {}
      : { roundRecordsForReview: options.roundRecordsForReview }),
    ...(options.broadcastAskProjection === undefined
      ? {}
      : { broadcastAskProjection: options.broadcastAskProjection }),
    ...(options.queueRoundIfActive === undefined
      ? {}
      : { queueRoundIfActive: options.queueRoundIfActive }),
    ...(options.composeBundle === undefined ? {} : { composeBundle: options.composeBundle }),
  } as unknown as DispatchDeps);
  return { store, dispatch: roundHandlers(rt)["round.dispatch"] };
}

type DispatchKickInput = Parameters<NonNullable<DispatchDeps["dispatchRound"]>>[0];

function idFor(askOccurrences: readonly AskOccurrence[], sourcePatchsetId = "ps-1"): string {
  return sha256Hex(JSON.stringify({ reviewId: REVIEW_ID, sourcePatchsetId, askOccurrences }));
}

function completedRecord(
  askOccurrences: readonly AskOccurrence[],
  over: Partial<RoundRecord> = {},
): RoundRecord {
  return {
    asksDispatched: askOccurrences.map((occurrence) => occurrence.id),
    dispatchId: idFor(askOccurrences),
    sourcePatchsetId: "ps-1",
    askOccurrences: [...askOccurrences],
    workerCommitRange: { from: "c0", to: "c0" },
    boardGeneration: ROUND_NO_REGEN,
    reportBoard: ROUND_NO_REGEN,
    outcome: "completed",
    regeneration: "pending",
    diff: "+worker change",
    changedPaths: ["src/x.ts"],
    ...over,
  };
}

type DispatchResult = { workOrder: ComposedHandoffBundle; dispatched: boolean };

describe("round.dispatch (B11 4.2) — asks → one work-order, coalesced", () => {
  it("queues behind a durable active round before invoking the model composer", async () => {
    const composeBundle = vi.fn<NonNullable<DispatchDeps["composeBundle"]>>();
    const dispatchRound = vi.fn<NonNullable<DispatchDeps["dispatchRound"]>>();
    const queueRoundIfActive = vi.fn(async () => true);
    const { store, dispatch } = harness(dispatchRound, {
      composeBundle,
      queueRoundIfActive,
    });
    store.append(REVIEW_ID, {
      kind: "stage",
      ask: { id: "a1", anchor: "src/x.ts:1", type: "request-change", body: "queue me" },
    });

    const result = (await dispatch({ reviewId: REVIEW_ID })) as DispatchResult;

    expect(result.dispatched).toBe(true);
    expect(result.workOrder.composed).toBe(false);
    expect(queueRoundIfActive).toHaveBeenCalledTimes(1);
    expect(composeBundle).not.toHaveBeenCalled();
    expect(dispatchRound).not.toHaveBeenCalled();
  });

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

  it("a same-process redispatch of the same asks kicks the runtime exactly once", async () => {
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

  it("fresh handler reconstructs a pending placeholder and cleans after simulated regeneration", async () => {
    const askDir = mkdtempSync(join(tmpdir(), "rennet-round-crash-asks-"));
    const roundDir = mkdtempSync(join(tmpdir(), "rennet-round-crash-records-"));
    const rounds = new RoundRecordStore(roundDir);
    const firstStore = new AskLogStore(askDir);
    const staged = firstStore.append(REVIEW_ID, {
      kind: "stage",
      ask: { id: "a1", anchor: "src/x.ts:1", type: "request-change", body: "fix once" },
    });
    const first = harness(
      async (input) => {
        rounds.record("s1", completedRecord(input.askOccurrences));
        throw new Error("crash after the completed placeholder");
      },
      { store: firstStore, roundRecordsForReview: () => rounds.read("s1") },
    );
    await first.dispatch({ reviewId: REVIEW_ID });
    await vi.waitFor(() => expect(rounds.read("s1")[0]?.regeneration).toBe("pending"));
    expect(firstStore.readProjection(REVIEW_ID).stagedAsks.a1).toBeDefined();

    const restartedStore = new AskLogStore(askDir);
    const regeneration = vi.fn(async (input: DispatchKickInput) => {
      const completed = rounds
        .read("s1")
        .find((record) => record.outcome === "completed" && record.dispatchId === input.dispatchId);
      expect(completed?.regeneration).toBe("pending");
      rounds.record("s1", {
        ...completedRecord(input.askOccurrences),
        boardGeneration: "gen:ps-2",
        reportBoard: "board:report",
      });
    });
    const restarted = harness(regeneration, {
      store: restartedStore,
      roundRecordsForReview: () => rounds.read("s1"),
    });
    await restarted.dispatch({ reviewId: REVIEW_ID });
    await vi.waitFor(() =>
      expect(restartedStore.readProjection(REVIEW_ID).stagedAsks.a1).toBeUndefined(),
    );
    expect(staged.seq).toBe(0);
    expect(regeneration).toHaveBeenCalledTimes(1);
    expect(rounds.read("s1")).toHaveLength(1);
    expect(rounds.read("s1")[0]?.boardGeneration).toBe("gen:ps-2");
  });

  it("repairs stranded asks from a completed real record without invoking dispatch", async () => {
    const store = new AskLogStore(mkdtempSync(join(tmpdir(), "rennet-round-real-crash-")));
    const staged = store.append(REVIEW_ID, {
      kind: "stage",
      ask: { id: "a1", anchor: "src/x.ts:1", type: "request-change", body: "fix" },
    });
    const record = completedRecord([{ id: "a1", revision: staged.seq }], {
      boardGeneration: "gen:ps-2",
      reportBoard: "board:report",
    });
    const dispatchRound = vi.fn<NonNullable<DispatchDeps["dispatchRound"]>>();
    const broadcast = vi.fn<NonNullable<DispatchDeps["broadcastAskProjection"]>>();
    const { dispatch } = harness(dispatchRound, {
      store,
      roundRecordsForReview: () => [record],
      broadcastAskProjection: broadcast,
    });

    const result = (await dispatch({ reviewId: REVIEW_ID })) as DispatchResult;
    expect(result.dispatched).toBe(false);
    expect(dispatchRound).not.toHaveBeenCalled();
    expect(store.readProjection(REVIEW_ID).stagedAsks.a1).toBeUndefined();
    expect(broadcast).toHaveBeenCalledTimes(1);
  });

  it("a failed durable record retries and consumes nothing", async () => {
    const store = new AskLogStore(mkdtempSync(join(tmpdir(), "rennet-round-failed-retry-")));
    const staged = store.append(REVIEW_ID, {
      kind: "stage",
      ask: { id: "a1", anchor: "src/x.ts:1", type: "request-change", body: "retry me" },
    });
    const failed = completedRecord([{ id: "a1", revision: staged.seq }], { outcome: "failed" });
    const dispatchRound = vi.fn(async () => {
      throw new Error("still failed");
    });
    const { dispatch } = harness(dispatchRound, {
      store,
      roundRecordsForReview: () => [failed],
    });

    await dispatch({ reviewId: REVIEW_ID });
    await vi.waitFor(() => expect(dispatchRound).toHaveBeenCalledTimes(1));
    expect(store.readProjection(REVIEW_ID).stagedAsks.a1?.body).toBe("retry me");
  });

  it("a restored same-id ask has a new occurrence and runs again", async () => {
    const store = new AskLogStore(mkdtempSync(join(tmpdir(), "rennet-round-restored-")));
    const first = store.append(REVIEW_ID, {
      kind: "stage",
      ask: { id: "a1", anchor: "src/x.ts:1", type: "request-change", body: "fix" },
    });
    const real = completedRecord([{ id: "a1", revision: first.seq }], {
      boardGeneration: "gen:ps-2",
      reportBoard: "board:report",
    });
    store.append(REVIEW_ID, { kind: "retire", id: "a1", reason: "later" });
    const restored = store.append(REVIEW_ID, { kind: "restore", id: "a1" });
    let dispatchedInput: DispatchKickInput | undefined;
    const dispatchRound = vi.fn(async (input: DispatchKickInput) => {
      dispatchedInput = input;
      throw new Error("stop after proving the new occurrence ran");
    });
    const { dispatch } = harness(dispatchRound, {
      store,
      roundRecordsForReview: () => [real],
    });

    await dispatch({ reviewId: REVIEW_ID });
    await vi.waitFor(() => expect(dispatchRound).toHaveBeenCalledTimes(1));
    expect(dispatchedInput?.askOccurrences).toEqual([{ id: "a1", revision: restored.seq }]);
    expect(dispatchedInput?.dispatchId).not.toBe(real.dispatchId);
    expect(store.readProjection(REVIEW_ID).stagedAsks.a1).toBeDefined();
  });

  it("an edit and a new ask staged mid-run both survive successful cleanup", async () => {
    const store = new AskLogStore(mkdtempSync(join(tmpdir(), "rennet-round-mid-run-")));
    store.append(REVIEW_ID, {
      kind: "stage",
      ask: { id: "a1", anchor: "src/x.ts:1", type: "request-change", body: "original" },
    });
    let finish!: () => void;
    const running = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let finished = false;
    const dispatchRound = vi.fn(async () => {
      await running;
      finished = true;
    });
    const { dispatch } = harness(dispatchRound, { store });

    await dispatch({ reviewId: REVIEW_ID });
    await vi.waitFor(() => expect(dispatchRound).toHaveBeenCalledTimes(1));
    store.append(REVIEW_ID, { kind: "edit", id: "a1", body: "edited during the run" });
    store.append(REVIEW_ID, {
      kind: "stage",
      ask: { id: "a2", anchor: "src/y.ts:1", type: "comment", body: "new during the run" },
    });
    finish();
    await vi.waitFor(() => expect(finished).toBe(true));
    expect(Object.keys(store.readProjection(REVIEW_ID).stagedAsks)).toEqual(["a1", "a2"]);
    expect(store.readProjection(REVIEW_ID).stagedAsks.a1?.body).toBe("edited during the run");
  });

  it("resumes a completed placeholder from recorded bytes while edited asks stay queued", async () => {
    const store = new AskLogStore(mkdtempSync(join(tmpdir(), "rennet-round-partial-edit-")));
    const a = store.append(REVIEW_ID, {
      kind: "stage",
      ask: { id: "a1", anchor: "src/a.ts:1", type: "request-change", body: "original a" },
    });
    const b = store.append(REVIEW_ID, {
      kind: "stage",
      ask: { id: "a2", anchor: "src/b.ts:1", type: "comment", body: "original b" },
    });
    const occurrences = [
      { id: "a1", revision: a.seq },
      { id: "a2", revision: b.seq },
    ];
    const rounds = new RoundRecordStore(
      mkdtempSync(join(tmpdir(), "rennet-round-partial-record-")),
    );
    rounds.record("s1", completedRecord(occurrences));
    store.append(REVIEW_ID, { kind: "edit", id: "a1", body: "edited after the crash" });
    let resumed: DispatchKickInput | undefined;
    const { dispatch } = harness(
      async (input) => {
        resumed = input;
        rounds.record("s1", {
          ...completedRecord(input.askOccurrences),
          boardGeneration: "gen:ps-2",
          reportBoard: "board:report",
        });
      },
      { store, roundRecordsForReview: () => rounds.read("s1") },
    );

    await dispatch({ reviewId: REVIEW_ID });
    await vi.waitFor(() => expect(store.readProjection(REVIEW_ID).stagedAsks.a2).toBeUndefined());
    expect(
      resumed?.workOrder.tasks.flatMap((task) => task.asks).find((ask) => ask.id === "a1")
        ?.instruction,
    ).toBe("original a");
    expect(store.readProjection(REVIEW_ID).stagedAsks.a1?.body).toBe("edited after the crash");
  });

  it("resumes pending regeneration even when every recorded occurrence was edited", async () => {
    const store = new AskLogStore(mkdtempSync(join(tmpdir(), "rennet-round-all-edited-")));
    const staged = store.append(REVIEW_ID, {
      kind: "stage",
      ask: { id: "a1", anchor: "src/a.ts:1", type: "request-change", body: "old bytes" },
    });
    const pending = completedRecord([{ id: "a1", revision: staged.seq }]);
    store.append(REVIEW_ID, { kind: "edit", id: "a1", body: "new occurrence" });
    let dispatchedInput: DispatchKickInput | undefined;
    const dispatchRound = vi.fn(async (input: DispatchKickInput) => {
      dispatchedInput = input;
    });
    const { dispatch } = harness(dispatchRound, {
      store,
      roundRecordsForReview: () => [pending],
    });

    await dispatch({ reviewId: REVIEW_ID });
    await vi.waitFor(() => expect(dispatchRound).toHaveBeenCalledTimes(1));
    expect(dispatchedInput?.workOrder.tasks.flatMap((task) => task.asks)[0]?.instruction).toBe(
      "old bytes",
    );
    expect(store.readProjection(REVIEW_ID).stagedAsks.a1?.body).toBe("new occurrence");
  });

  it("keeps asks staged when a report succeeds but every lens regeneration fails", async () => {
    const store = new AskLogStore(mkdtempSync(join(tmpdir(), "rennet-round-zero-lens-asks-")));
    const roundRecords = new RoundRecordStore(
      mkdtempSync(join(tmpdir(), "rennet-round-zero-lens-records-")),
    );
    let boardSequence = 0;
    const reportOnlyPort = {
      createSession: async () => {
        let prompt = "";
        return {
          send: async (input: { prompt: string }) => {
            prompt = input.prompt;
          },
          close: async () => undefined,
          events: (async function* () {
            const isReport =
              prompt.includes("prompts/report.md") || prompt.includes("prompts/post-process.md");
            yield {
              kind: "session.ended",
              native: {},
              outcome: {
                status: "completed",
                structuredOutput: isReport
                  ? ({
                      elements: [
                        {
                          id: "report-prose",
                          kind: "prose",
                          data: {
                            author: { kind: "lens-agent", id: "report-seat" },
                            markdown: "The coding turn completed.",
                          },
                        },
                      ],
                    } as unknown as DraftBoard)
                  : ({ invalid: true } as unknown as DraftBoard),
              },
            };
          })(),
        };
      },
    } as unknown as HarnessPort;
    const progress: RoundEvent[] = [];
    const rounds = createRoundsRuntime({
      ...runtimeDeps(),
      resolveClaudePort: async () => reportOnlyPort,
      boardsRuntimeFor: () =>
        ({
          service: { apply: async () => ({ ok: true }) },
          createRennetBoard: async () => `board:${boardSequence++}`,
        }) as unknown as ReturnType<RoundsRuntimeDeps["boardsRuntimeFor"]>,
      readPrompt: (file) => `PROMPT_FILE:${file}`,
      recordRound: (sessionId, record) => roundRecords.record(sessionId, record),
      readRounds: (sessionId) => roundRecords.read(sessionId),
    });
    const dispatchRound = async (input: DispatchKickInput): Promise<void> => {
      const runtimeSession = session("s1");
      await rounds.dispatchRound({
        session: runtimeSession,
        workOrder: input.workOrder,
        dispatchId: input.dispatchId,
        sourcePatchsetId: input.sourcePatchsetId,
        askOccurrences: input.askOccurrences,
        runWorkers: async () => ({
          outcome: "completed",
          diff: "+changed",
          changedPaths: ["a.ts"],
          workerCommitRange: { from: "c0", to: "c0" },
        }),
      });
      await rounds.runRound({
        session: runtimeSession,
        repoRoot: "/repo",
        asksDispatched: input.askOccurrences.map((occurrence) => occurrence.id),
        dispatchId: input.dispatchId,
        sourcePatchsetId: input.sourcePatchsetId,
        askOccurrences: input.askOccurrences,
        runWorkers: async () => ({
          commitRange: { from: "c0", to: "c0" },
          patchsetId: "ps-2",
        }),
        deltaPacket: {
          patchset: { id: "ps-2", createdAt: "", truncated: false, files: [] },
          successorAccount: { asks: [] },
        } as never,
        hunks: [],
        lintContextFor: (lens: LintTarget) => ({ lens, hunks: [], files: new Map() }),
        reviewDraftLintCtx: { files: new Map() },
        onProgress: (event) => progress.push(event),
      });
    };
    const { dispatch } = harness(dispatchRound, {
      store,
      roundRecordsForReview: () => roundRecords.read("s1"),
    });
    store.append(REVIEW_ID, {
      kind: "stage",
      ask: {
        id: "report-only-ask",
        anchor: "a.ts:1",
        type: "request-change",
        body: "change it",
      },
    });

    await dispatch({ reviewId: REVIEW_ID });
    await vi.waitFor(() =>
      expect(progress.filter((event) => event.type === "failed")).toHaveLength(1),
    );

    expect(progress.some((event) => event.type === "report")).toBe(true);
    expect(progress.some((event) => event.type === "composed")).toBe(false);
    expect(store.readProjection(REVIEW_ID).stagedAsks["report-only-ask"]).toBeDefined();
    expect(roundRecords.read("s1")).toHaveLength(1);
    expect(roundRecords.read("s1")[0]?.regeneration).toBe("pending");
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
const SERIAL_DISPATCH = {
  dispatchId: "dispatch:serializer",
  sourcePatchsetId: "ps-1",
  askOccurrences: [],
} as const;

describe("createRoundsRuntime.dispatchRound (B11 4.2) — one round in flight per session", () => {
  it("serializes concurrent dispatches on one session (the second waits for the first)", async () => {
    const runtime = createRoundsRuntime(runtimeDeps());
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const first = runtime.dispatchRound({
      ...SERIAL_DISPATCH,
      session: session("s1"),
      workOrder: WORK_ORDER,
      runWorkers: async () => {
        order.push("1-start");
        await gate;
        order.push("1-end");
      },
    });
    const second = runtime.dispatchRound({
      ...SERIAL_DISPATCH,
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
        ...SERIAL_DISPATCH,
        session: session("s1"),
        workOrder: WORK_ORDER,
        runWorkers: async () => {
          throw new Error("round worker turn failed: no harness");
        },
      }),
    ).rejects.toThrow(/round worker turn failed/);

    // The session tail is not wedged by the failure: a subsequent (successful) round still runs.
    const ran = vi.fn(() => Promise.resolve());
    await runtime.dispatchRound({
      ...SERIAL_DISPATCH,
      session: session("s1"),
      workOrder: WORK_ORDER,
      runWorkers: ran,
    });
    expect(ran).toHaveBeenCalledTimes(1);
  });

  it("fsyncs the completed placeholder before post-dispatch ripening can start", async () => {
    const order: string[] = [];
    const runtime = createRoundsRuntime({
      ...runtimeDeps(),
      recordRound: () => order.push("placeholder-fsynced"),
    });
    await runtime.dispatchRound({
      ...SERIAL_DISPATCH,
      session: session("s1"),
      workOrder: WORK_ORDER,
      runWorkers: async () => {
        order.push("worker-completed");
        return COMPLETED_RESULT;
      },
    });
    order.push("ripening-started");
    expect(order).toEqual(["worker-completed", "placeholder-fsynced", "ripening-started"]);
  });

  it("runs dispatches on different sessions concurrently (the lock is per session)", async () => {
    const runtime = createRoundsRuntime(runtimeDeps());
    const started: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const a = runtime.dispatchRound({
      ...SERIAL_DISPATCH,
      session: session("sA"),
      workOrder: WORK_ORDER,
      runWorkers: async () => {
        started.push("A");
        await gate;
      },
    });
    const b = runtime.dispatchRound({
      ...SERIAL_DISPATCH,
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

// ── The rounds runtime RECORDS a RoundRecord per completed dispatch (record-only, no regen) ──

/** A work-order carrying two staged asks across one composed task — the ask ids are what a
 *  recorded round pins as `asksDispatched`. */
const ORDER_WITH_ASKS = {
  reviewId: "review-1",
  patchsetId: "ps-1",
  tasks: [
    {
      title: "Address the review",
      sourceDispositions: ["t1", "t2"],
      asks: [
        { path: "a.ts", type: "request-change", instruction: "fix", context: "", id: "t1" },
        { path: "b.ts", type: "comment", instruction: "note", context: "", id: "t2" },
      ],
    },
  ],
  prompt: "do the work",
  digest: "d1",
  composed: false,
  traceMap: {},
} as unknown as ComposedHandoffBundle;

const COMPLETED_RESULT: DispatchRoundResult = {
  outcome: "completed",
  diff: "diff --git a/a.ts b/a.ts\n+seeded",
  changedPaths: ["a.ts"],
  workerCommitRange: { from: "c0", to: "c1" },
};
const ORDER_DISPATCH = {
  dispatchId: "dispatch:asks",
  sourcePatchsetId: "ps-1",
  askOccurrences: [
    { id: "t1", revision: 0 },
    { id: "t2", revision: 1 },
  ],
} as const;

describe("createRoundsRuntime.dispatchRound — records a RoundRecord (part a: record only)", () => {
  it("un-dispatched session ⇒ empty ledger (no fabricated round)", () => {
    const runtime = createRoundsRuntime(runtimeDeps());
    expect(runtime.ledger("s1")).toEqual([]);
  });

  it("a completed dispatch records a real RoundRecord: asks, diff, paths, commits, honest no-regen generation", async () => {
    const runtime = createRoundsRuntime(runtimeDeps());
    await runtime.dispatchRound({
      ...ORDER_DISPATCH,
      session: session("s1"),
      workOrder: ORDER_WITH_ASKS,
      runWorkers: async () => COMPLETED_RESULT,
    });

    const ledger = runtime.ledger("s1");
    expect(ledger).toHaveLength(1);
    const record = ledger[0] as RoundRecord;
    expect(record.asksDispatched).toEqual(["t1", "t2"]);
    expect(record.dispatchId).toBe(ORDER_DISPATCH.dispatchId);
    expect(record.sourcePatchsetId).toBe("ps-1");
    expect(record.askOccurrences).toEqual(ORDER_DISPATCH.askOccurrences);
    expect(record.regeneration).toBe("pending");
    expect(record.diff).toBe(COMPLETED_RESULT.diff);
    expect(record.changedPaths).toEqual(["a.ts"]);
    expect(record.workerCommitRange).toEqual({ from: "c0", to: "c1" });
    expect(record.outcome).toBe("completed");
    // HONEST no-mint: no generation minted, no report board drafted — the marker, never a
    // fabricated id — and `mintedPatchsetGeneration` stays absent.
    expect(record.boardGeneration).toBe(ROUND_NO_REGEN);
    expect(record.reportBoard).toBe(ROUND_NO_REGEN);
    expect(record.mintedPatchsetGeneration).toBeUndefined();
  });

  it("a FAILED round STILL records its diff, then rejects so the dispatch retries", async () => {
    const runtime = createRoundsRuntime(runtimeDeps());
    const failed: DispatchRoundResult = {
      outcome: "failed",
      diff: "diff --git a/a.ts b/a.ts\n+partial-before-crash",
      changedPaths: ["a.ts"],
      workerCommitRange: { from: "c0", to: "c0" },
    };
    await expect(
      runtime.dispatchRound({
        ...ORDER_DISPATCH,
        session: session("s1"),
        workOrder: ORDER_WITH_ASKS,
        runWorkers: async () => failed,
      }),
    ).rejects.toThrow("The round's work order failed.");

    // The failed round is not lost — its partial diff is on the ledger (a crashed worker is
    // not an empty round).
    const ledger = runtime.ledger("s1");
    expect(ledger).toHaveLength(1);
    expect(ledger[0]?.outcome).toBe("failed");
    expect(ledger[0]?.diff).toContain("partial-before-crash");
  });
});
