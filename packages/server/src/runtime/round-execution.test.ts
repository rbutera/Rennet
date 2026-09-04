import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoundOperationStore } from "@rennet/adapters";
import {
  type RoundCommitReceipt,
  type RoundOperation,
  type RoundOperationFailure,
  type RoundOperationState,
  type RoundReportBoard,
  type RoundReportReceipt,
  type RoundWorkerReceipt,
  type RoundWorkspaceReceipt,
  sha256Hex,
} from "@rennet/protocol";
import { describe, expect, it, vi } from "vitest";
import { createRoundExecutionCoordinator, type RoundExecutionPorts } from "./round-execution";

const reportBoard = {
  lens: "report",
  generation: "generation-1",
  boardId: "report-board-1",
  document: {
    title: "Round report",
    introMarkdown: "The requested change landed.",
    measure: "reading",
  },
  sections: [],
  elements: [],
} satisfies RoundReportBoard;

function operation(
  options: { dispatchId?: string; operationId?: string; roundNumber?: number } = {},
): RoundOperation {
  const operationId = options.operationId ?? "operation-1";
  const prompt = `Work order for ${operationId}`;
  return {
    operationId,
    sessionId: "session-1",
    reviewId: "review-1",
    dispatchId: options.dispatchId ?? `dispatch-${operationId}`,
    sourcePatchsetId: "patchset-1",
    askOccurrences: [{ id: `ask-${operationId}`, revision: 1 }],
    roundNumber: options.roundNumber ?? 1,
    sourceTarget: { kind: "branch", branch: "feat/test" },
    repoRoot: "/repo",
    workOrderPrompt: prompt,
    workOrderDigest: sha256Hex(prompt),
    revision: 0,
    rerunRequested: false,
    createdAt: 1,
    updatedAt: 1,
    state: { phase: "claimed" },
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve(value): void {
      if (resolvePromise === undefined) throw new Error("deferred promise was not initialized");
      resolvePromise(value);
    },
  };
}

function storeExpectation(current: RoundOperation): {
  readonly sessionId: string;
  readonly operationId: string;
  readonly revision: number;
} {
  return {
    sessionId: current.sessionId,
    operationId: current.operationId,
    revision: current.revision,
  };
}

function advance(
  store: RoundOperationStore,
  current: RoundOperation,
  state: RoundOperationState,
  updatedAt: number,
): RoundOperation {
  return store.compareAndSwap(storeExpectation(current), { state, updatedAt });
}

function seedWorkerRunning(
  store: RoundOperationStore,
  initial: RoundOperation,
  options: { sourceHead?: string } = {},
): RoundOperation {
  const claimed = store.claimIfIdle(initial);
  const workspace: RoundWorkspaceReceipt = {
    kind: "bound-root",
    root: "/repo",
    sourceHead: options.sourceHead ?? "head-before",
    preparedAt: 3,
  };
  const prepared = advance(store, claimed, { phase: "prepared", workspace }, 3);
  return advance(
    store,
    prepared,
    {
      phase: "worker-running",
      workspace,
      worker: { executionId: "worker-recovery", startedAt: 4 },
    },
    4,
  );
}

function seedCommitting(
  store: RoundOperationStore,
  initial: RoundOperation,
  options: { sourceHead?: string } = {},
): RoundOperation {
  const running = seedWorkerRunning(store, initial, options);
  if (running.state.phase !== "worker-running") throw new Error("expected seeded worker attempt");
  const worker = {
    ...running.state.worker,
    completedAt: 5,
    outcome: "completed",
    diff: "diff --git a/file.ts b/file.ts\n",
    changedPaths: ["file.ts"],
  } satisfies RoundWorkerReceipt;
  const workerSettled = advance(
    store,
    running,
    { phase: "worker-settled", workspace: running.state.workspace, worker },
    5,
  );
  return advance(
    store,
    workerSettled,
    {
      phase: "committing",
      workspace: running.state.workspace,
      worker,
      commit: {
        executionId: "commit-recovery",
        baseHead: running.state.workspace.sourceHead,
        startedAt: 7,
      },
    },
    7,
  );
}

function seedRoundRecording(store: RoundOperationStore, initial: RoundOperation): RoundOperation {
  const committing = seedCommitting(store, initial);
  if (committing.state.phase !== "committing") throw new Error("expected seeded commit attempt");
  const commits = {
    ...committing.state.commit,
    from: "head-before",
    to: "head-after",
    count: 1,
    committedAt: 8,
  } satisfies RoundCommitReceipt;
  const settled = advance(
    store,
    committing,
    {
      phase: "commits-settled",
      workspace: committing.state.workspace,
      worker: committing.state.worker,
      commits,
    },
    8,
  );
  return advance(
    store,
    settled,
    {
      phase: "round-recording",
      workspace: committing.state.workspace,
      worker: committing.state.worker,
      commits,
      recording: {
        effect: "round-recording",
        executionId: "recording-recovery",
        startedAt: 11,
      },
    },
    11,
  );
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempts = 0; attempts < 100; attempts += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error("condition did not become true");
}

type Scenario = {
  readonly dir: string;
  readonly store: RoundOperationStore;
  readonly ports: RoundExecutionPorts;
  readonly calls: string[];
  readonly published: RoundOperation[];
};

function scenario(options: { commitCount?: number; worker?: RoundWorkerReceipt } = {}): Scenario {
  const dir = mkdtempSync(join(tmpdir(), "round-execution-"));
  const store = new RoundOperationStore(dir);
  const calls: string[] = [];
  const published: RoundOperation[] = [];
  let tick = 10;
  const now = (): number => {
    tick += 1;
    return tick;
  };
  const worker =
    options.worker ??
    ({
      executionId: "worker-1",
      startedAt: 13,
      completedAt: 14,
      outcome: "completed",
      diff: "diff --git a/file.ts b/file.ts\n",
      changedPaths: ["file.ts"],
    } satisfies RoundWorkerReceipt);
  const count = options.commitCount ?? 1;

  const ports: RoundExecutionPorts = {
    async planWorkspace(current) {
      calls.push("plan-workspace");
      // The bound root is READ, never reserved: nothing is persisted before this resolves.
      expect(store.read(current.sessionId)?.state.phase).toBe("claimed");
      return {
        kind: "bound-root",
        root: current.repoRoot,
        sourceHead: "head-before",
        preparedAt: now(),
      };
    },
    planWorker() {
      calls.push("plan-worker");
      return { executionId: worker.executionId, startedAt: worker.startedAt };
    },
    async runWorker({ operation: current }) {
      calls.push("worker");
      expect(store.read(current.sessionId)?.state.phase).toBe("worker-running");
      return worker;
    },
    planCommit() {
      calls.push("plan-commit");
      return { executionId: "commit-1", baseHead: "head-before", startedAt: now() };
    },
    async settleCommits({ operation: current, attempt }) {
      calls.push("commits");
      expect(store.read(current.sessionId)?.state.phase).toBe("committing");
      return {
        ...attempt,
        from: "head-before",
        to: count === 0 ? "head-before" : `head-after-${count}`,
        count,
        committedAt: now(),
      } satisfies RoundCommitReceipt;
    },
    planRoundRecording() {
      calls.push("plan-round-recording");
      return { effect: "round-recording", executionId: "recording-1", startedAt: now() };
    },
    async recordRound({ operation: current, attempt }) {
      calls.push("record-round");
      expect(store.read(current.sessionId)?.state.phase).toBe("round-recording");
      return { ...attempt, recordedAt: now() };
    },
    prepareReport() {
      calls.push("prepare-report");
      return {
        executionId: "report-1",
        reportBoardId: "report-board-1",
        generation: "generation-1",
        boardIds: {
          design: "design-board-1",
          sequence: "sequence-board-1",
          decisions: "decisions-board-1",
          flagged: "flagged-board-1",
          noise: "noise-board-1",
          report: "report-board-1",
        },
        startedAt: now(),
      };
    },
    async draftReport({ operation: current, attempt }) {
      calls.push("draft-report");
      const persisted = store.read(current.sessionId);
      expect(persisted?.state.phase).toBe("report-drafting");
      if (persisted?.state.phase !== "report-drafting") {
        throw new Error("report attempt was not persisted before drafting");
      }
      expect(persisted.state.report.boardIds).toEqual(attempt.boardIds);
      return { ...attempt, draftedAt: now() };
    },
    planReportVerification() {
      calls.push("plan-report-verification");
      return { executionId: "verification-1", startedAt: now() };
    },
    async verifyReport({ operation: current, report, attempt }) {
      calls.push("verify-report");
      expect(store.read(current.sessionId)?.state.phase).toBe("report-verifying");
      expect(store.read(current.sessionId)?.state.phase).not.toBe("completed");
      return {
        ...report,
        verificationExecutionId: attempt.executionId,
        verificationStartedAt: attempt.startedAt,
        verifiedAt: now(),
      } satisfies RoundReportReceipt;
    },
    publish(current) {
      published.push(current);
    },
    async drainTerminal({ operation: current }) {
      calls.push("drain");
      expect(store.read(current.sessionId)?.operationId).toBe(current.operationId);
      return { kind: "clear" };
    },
  };
  return { dir, store, ports, calls, published };
}

describe("createRoundExecutionCoordinator", () => {
  it("persists every attempt before its effect and verifies the report before completion", async () => {
    const test = scenario();
    const completed = await createRoundExecutionCoordinator({
      store: test.store,
      ports: test.ports,
    }).submit(operation());

    expect(completed.state.phase).toBe("completed");
    if (completed.state.phase !== "completed") throw new Error("expected a completed round");
    expect(completed.state.result.kind).toBe("changed");
    expect(test.calls).toEqual([
      "plan-workspace",
      "plan-worker",
      "worker",
      "plan-commit",
      "commits",
      "plan-round-recording",
      "record-round",
      "prepare-report",
      "draft-report",
      "plan-report-verification",
      "verify-report",
      "drain",
    ]);
    expect(test.published.map((entry) => entry.state.phase)).toEqual([
      "claimed",
      "prepared",
      "worker-running",
      "worker-settled",
      "committing",
      "commits-settled",
      "round-recording",
      "round-recorded",
      "report-drafting",
      "report-verifying",
      "completed",
    ]);
    expect(test.store.read(completed.sessionId)).toBeUndefined();
  });

  it("publishes completion as draining until the durable Return handback is recorded", async () => {
    const test = scenario();
    const completed = await createRoundExecutionCoordinator({
      store: test.store,
      ports: {
        ...test.ports,
        async drainTerminal() {
          return { kind: "return", returnedAt: 2_000_000_000_000 };
        },
      },
    }).submit(operation());

    expect(completed.state.phase).toBe("completed");
    const retained = test.store.read(completed.sessionId);
    expect(retained?.state.phase).toBe("completed");
    if (retained?.state.phase !== "completed") throw new Error("expected retained completion");
    expect(retained.state.returnedAt).toBe(2_000_000_000_000);
    const publishedCompletions = test.published.filter(
      (entry) => entry.state.phase === "completed",
    );
    expect(publishedCompletions).toHaveLength(2);
    expect(publishedCompletions[0]?.state).not.toHaveProperty("returnedAt");
    expect(publishedCompletions[1]?.state).toHaveProperty("returnedAt", 2_000_000_000_000);
  });

  it("replaces a queued rerun without publishing round one as handed back", async () => {
    const test = scenario();
    const releaseDrain = deferred<void>();
    const replacement = operation({ operationId: "operation-2", roundNumber: 2 });
    const ports: RoundExecutionPorts = {
      ...test.ports,
      async drainTerminal({ operation: current }) {
        if (current.operationId === replacement.operationId) {
          return { kind: "return", returnedAt: 2_000_000_000_001 };
        }
        if (current.rerunRequested) return { kind: "replace", operation: replacement };
        await releaseDrain.promise;
        return { kind: "return", returnedAt: 2_000_000_000_000 };
      },
    };
    const coordinator = createRoundExecutionCoordinator({ store: test.store, ports });
    const first = coordinator.submit(operation());
    await waitUntil(() => test.store.read("session-1")?.state.phase === "completed");

    const second = coordinator.submit(replacement);
    expect(second).toBe(first);
    expect(test.store.read("session-1")?.rerunRequested).toBe(true);
    releaseDrain.resolve(undefined);
    await first;

    const retained = test.store.read("session-1");
    expect(retained?.operationId).toBe(replacement.operationId);
    expect(retained?.state).toHaveProperty("returnedAt", 2_000_000_000_001);
    expect(
      test.published.some(
        (entry) =>
          entry.operationId === "operation-1" &&
          entry.state.phase === "completed" &&
          entry.state.returnedAt !== undefined,
      ),
    ).toBe(false);
  });

  it("retries the Return receipt when a rerun wins its compare-and-swap", async () => {
    const test = scenario();
    const replacement = operation({ operationId: "operation-2", roundNumber: 2 });
    let workerCalls = 0;
    let injectedRerun = false;
    const compareAndSwap = test.store.compareAndSwap.bind(test.store);
    vi.spyOn(test.store, "compareAndSwap").mockImplementation((expected, next) => {
      if (
        !injectedRerun &&
        next.state.phase === "completed" &&
        next.state.returnedAt !== undefined
      ) {
        injectedRerun = true;
        test.store.requestRerun(expected);
      }
      return compareAndSwap(expected, next);
    });
    const coordinator = createRoundExecutionCoordinator({
      store: test.store,
      ports: {
        ...test.ports,
        async runWorker(input) {
          workerCalls += 1;
          return test.ports.runWorker(input);
        },
        async drainTerminal({ operation: current }) {
          if (current.rerunRequested) return { kind: "replace", operation: replacement };
          return {
            kind: "return",
            returnedAt:
              current.operationId === replacement.operationId
                ? 2_000_000_000_001
                : 2_000_000_000_000,
          };
        },
      },
    });

    await expect(coordinator.submit(operation())).resolves.toMatchObject({
      operationId: replacement.operationId,
    });

    expect(injectedRerun).toBe(true);
    expect(workerCalls).toBe(2);
    const retained = test.store.read("session-1");
    expect(retained?.operationId).toBe(replacement.operationId);
    expect(retained?.state).toHaveProperty("returnedAt", 2_000_000_000_001);
  });

  it("coalesces a repeated dispatch and only marks a distinct dispatch for rerun", async () => {
    const test = scenario();
    const worker = deferred<RoundWorkerReceipt>();
    let workerCalls = 0;
    const replacement = operation({ operationId: "operation-2", roundNumber: 2 });
    const ports: RoundExecutionPorts = {
      ...test.ports,
      async runWorker() {
        workerCalls += 1;
        return worker.promise;
      },
      async drainTerminal({ operation: current }) {
        if (current.rerunRequested) return { kind: "replace", operation: replacement };
        return { kind: "clear" };
      },
    };
    const coordinator = createRoundExecutionCoordinator({ store: test.store, ports });
    const firstOperation = operation();
    const first = coordinator.submit(firstOperation);
    await waitUntil(
      () => test.store.read(firstOperation.sessionId)?.state.phase === "worker-running",
    );

    expect(coordinator.submit(firstOperation)).toBe(first);
    expect(coordinator.submit(replacement)).toBe(first);
    expect(workerCalls).toBe(1);
    expect(test.store.read(firstOperation.sessionId)?.rerunRequested).toBe(true);

    worker.resolve({
      executionId: "worker-1",
      startedAt: 13,
      completedAt: 14,
      outcome: "completed",
      diff: "diff --git a/file.ts b/file.ts\n",
      changedPaths: ["file.ts"],
    });
    await waitUntil(() => workerCalls === 2);
    await first;
  });

  it("clears a queued rerun when the terminal drain finds no replacement work", async () => {
    const test = scenario();
    const worker = deferred<RoundWorkerReceipt>();
    const runWorker = vi.fn(async () => worker.promise);
    const ports: RoundExecutionPorts = {
      ...test.ports,
      runWorker,
      async drainTerminal({ operation: current }) {
        expect(current.rerunRequested).toBe(true);
        return { kind: "clear-queued" };
      },
    };
    const coordinator = createRoundExecutionCoordinator({ store: test.store, ports });
    const first = coordinator.submit(operation());
    await waitUntil(() => test.store.read("session-1")?.state.phase === "worker-running");

    expect(coordinator.submit(operation({ operationId: "operation-empty-rerun" }))).toBe(first);
    expect(runWorker).toHaveBeenCalledTimes(1);
    worker.resolve({
      executionId: "worker-1",
      startedAt: 13,
      completedAt: 14,
      outcome: "completed",
      diff: "diff --git a/file.ts b/file.ts\n",
      changedPaths: ["file.ts"],
    });

    await first;
    expect(runWorker).toHaveBeenCalledTimes(1);
    expect(test.store.read("session-1")).toBeUndefined();
  });

  it("retries a rerun CAS that loses to a concurrent phase settlement", async () => {
    const test = scenario();
    const worker = deferred<RoundWorkerReceipt>();
    const originalRequestRerun = test.store.requestRerun.bind(test.store);
    const requestRerun = vi.spyOn(test.store, "requestRerun");
    requestRerun.mockImplementationOnce((expected) => {
      const current = test.store.read(expected.sessionId);
      if (current?.state.phase !== "worker-running") {
        throw new Error("expected the durable worker attempt");
      }
      advance(
        test.store,
        current,
        {
          phase: "worker-settled",
          workspace: current.state.workspace,
          worker: {
            ...current.state.worker,
            completedAt: 14,
            outcome: "completed",
            diff: "diff --git a/file.ts b/file.ts\n",
            changedPaths: ["file.ts"],
          },
        },
        14,
      );
      return originalRequestRerun(expected);
    });
    const coordinator = createRoundExecutionCoordinator({
      store: test.store,
      ports: {
        ...test.ports,
        async runWorker() {
          return worker.promise;
        },
        async drainTerminal() {
          return { kind: "clear-queued" };
        },
      },
    });
    const first = coordinator.submit(operation());
    await waitUntil(() => test.store.read("session-1")?.state.phase === "worker-running");

    expect(coordinator.submit(operation({ operationId: "operation-rerun" }))).toBe(first);
    expect(test.store.read("session-1")?.rerunRequested).toBe(true);
    expect(requestRerun).toHaveBeenCalledTimes(2);
    worker.resolve({
      executionId: "worker-1",
      startedAt: 13,
      completedAt: 14,
      outcome: "completed",
      diff: "diff --git a/file.ts b/file.ts\n",
      changedPaths: ["file.ts"],
    });
    await first;
  });

  it("recovers at the first unsettled phase without replaying settled effects", async () => {
    const test = scenario();
    const stopped: RoundExecutionPorts = {
      ...test.ports,
      prepareReport() {
        throw new Error("stop after round recording settles");
      },
    };
    await expect(
      createRoundExecutionCoordinator({ store: test.store, ports: stopped }).submit(operation()),
    ).rejects.toThrow("stop after round recording settles");
    expect(test.store.read("session-1")?.state.phase).toBe("round-recorded");

    const replayed = {
      workspace: vi.fn(test.ports.planWorkspace),
      worker: vi.fn(test.ports.runWorker),
      commits: vi.fn(test.ports.settleCommits),
      recording: vi.fn(test.ports.recordRound),
    };
    const recovered = await createRoundExecutionCoordinator({
      store: test.store,
      ports: {
        ...test.ports,
        planWorkspace: replayed.workspace,
        runWorker: replayed.worker,
        settleCommits: replayed.commits,
        recordRound: replayed.recording,
      },
    }).recover();

    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.state.phase).toBe("completed");
    expect(replayed.workspace).not.toHaveBeenCalled();
    expect(replayed.worker).not.toHaveBeenCalled();
    expect(replayed.commits).not.toHaveBeenCalled();
    expect(replayed.recording).not.toHaveBeenCalled();
  });

  it("cold-recovers the exact round recording attempt without re-settling commits", async () => {
    const test = scenario();
    seedRoundRecording(test.store, operation());
    const settleCommits = vi.fn(test.ports.settleCommits);
    const recordRound = vi.fn(async (input: Parameters<RoundExecutionPorts["recordRound"]>[0]) => {
      expect(input.operation.dispatchId).toBe("dispatch-operation-1");
      return test.ports.recordRound(input);
    });
    const recovered = await createRoundExecutionCoordinator({
      store: new RoundOperationStore(test.dir),
      ports: {
        ...test.ports,
        settleCommits,
        recordRound,
      },
    }).recover();

    expect(recovered[0]?.state.phase).toBe("completed");
    expect(settleCommits).not.toHaveBeenCalled();
    expect(recordRound).toHaveBeenCalledTimes(1);
    expect(recordRound.mock.calls[0]?.[0].attempt.executionId).toBe("recording-recovery");
  });

  it("resumes an idempotent commit settlement from its persisted attempt", async () => {
    const test = scenario();
    seedCommitting(test.store, operation());
    const planWorkspace = vi.fn(test.ports.planWorkspace);
    const runWorker = vi.fn(test.ports.runWorker);
    const settleCommits = vi.fn(test.ports.settleCommits);
    const recovered = await createRoundExecutionCoordinator({
      store: test.store,
      ports: {
        ...test.ports,
        planWorkspace,
        runWorker,
        settleCommits,
      },
    }).recover();

    expect(recovered[0]?.state.phase).toBe("completed");
    expect(planWorkspace).not.toHaveBeenCalled();
    expect(runWorker).not.toHaveBeenCalled();
    expect(settleCommits).toHaveBeenCalledTimes(1);
    expect(settleCommits.mock.calls[0]?.[0].attempt.executionId).toBe("commit-recovery");
  });

  it("uses the worker observer on recovery and never dispatches the worker twice", async () => {
    const test = scenario();
    seedWorkerRunning(test.store, operation());
    const runWorker = vi.fn(async () => {
      throw new Error("duplicate worker execution");
    });
    const observeWorker = vi.fn(async ({ attempt }) => ({
      ...attempt,
      completedAt: 20,
      outcome: "failed" as const,
      termination: { kind: "error" as const, reason: "worker interrupted by daemon restart" },
      diff: "diff --git a/a.ts b/a.ts\n+partial edit\n",
      changedPaths: ["a.ts"],
    }));
    const coordinator = createRoundExecutionCoordinator({
      store: test.store,
      ports: {
        ...test.ports,
        runWorker,
        observeWorker,
        async drainTerminal() {
          throw new Error("retain recovered worker evidence");
        },
      },
      now: () => 20,
    });

    await expect(coordinator.recover()).rejects.toThrow("retain recovered worker evidence");
    expect(runWorker).not.toHaveBeenCalled();
    expect(observeWorker).toHaveBeenCalledTimes(1);
    expect(observeWorker.mock.calls[0]?.[0].attempt.executionId).toBe("worker-recovery");
    const failed = test.store.read("session-1");
    expect(failed?.state.phase).toBe("failed");
    if (failed?.state.phase !== "failed" || failed.state.failure.at !== "worker") {
      throw new Error("expected recovered worker evidence");
    }
    expect(failed.state.failure.worker).toMatchObject({
      outcome: "failed",
      diff: "diff --git a/a.ts b/a.ts\n+partial edit\n",
      changedPaths: ["a.ts"],
    });
  });

  it("marks an unobservable recovered worker as interrupted without dispatching it again", async () => {
    const test = scenario();
    seedWorkerRunning(test.store, operation());
    const runWorker = vi.fn(test.ports.runWorker);
    const coordinator = createRoundExecutionCoordinator({
      store: test.store,
      ports: {
        ...test.ports,
        runWorker,
        async drainTerminal({ operation: current }) {
          expect(test.store.read(current.sessionId)?.state.phase).toBe("failed");
          throw new Error("retain failed operation for inspection");
        },
      },
      now: () => 20,
    });

    await expect(coordinator.recover()).rejects.toThrow("retain failed operation for inspection");
    expect(runWorker).not.toHaveBeenCalled();
    const failed = test.store.read("session-1");
    expect(failed?.state.phase).toBe("failed");
    if (failed?.state.phase !== "failed") throw new Error("expected worker recovery to fail");
    expect(failed.state.failure).toMatchObject({
      at: "worker",
      worker: { executionId: "worker-recovery" },
    });
    expect(failed.state.failure.reason).toContain("interrupted");
  });

  it("persists round recording failures at their exact effect boundary", async () => {
    const expectedAt = "round-recording" satisfies RoundOperationFailure["at"];
    const test = scenario();
    const ports: RoundExecutionPorts = {
      ...test.ports,
      async recordRound() {
        throw new Error("round recording failed");
      },
    };
    const failed = await createRoundExecutionCoordinator({
      store: test.store,
      ports,
    }).submit(operation());

    expect(failed.state.phase).toBe("failed");
    if (failed.state.phase !== "failed") throw new Error("expected a failed round");
    expect(failed.state.failure.at).toBe(expectedAt);
  });

  it("persists a failed worker receipt as the terminal worker failure", async () => {
    const worker = {
      executionId: "worker-1",
      startedAt: 13,
      completedAt: 14,
      outcome: "failed",
      termination: { kind: "signal", signal: "SIGTERM" },
      diff: "partial diff",
      changedPaths: ["partial.ts"],
    } satisfies RoundWorkerReceipt;
    const test = scenario({ worker });
    const failed = await createRoundExecutionCoordinator({
      store: test.store,
      ports: test.ports,
    }).submit(operation());

    expect(failed.state.phase).toBe("failed");
    if (failed.state.phase !== "failed") throw new Error("expected a failed worker round");
    expect(failed.state.failure).toMatchObject({
      at: "worker",
      reason: "worker stopped by signal SIGTERM",
      worker: { outcome: "failed", changedPaths: ["partial.ts"] },
    });
    expect(test.calls).not.toContain("plan-gate");
  });

  // The shape every real round took while the round carried the review handoff's "do NOT
  // commit" rule: the turn edits, commits nothing, and the round has no result. The reason
  // is the only thing the reviewer sees, and "worker diff and observed commit range
  // disagree" named neither which side was empty nor what to do about it.
  it("names an edited-but-uncommitted turn instead of reporting a disagreement", async () => {
    const test = scenario({ commitCount: 0 });
    const failed = await createRoundExecutionCoordinator({
      store: test.store,
      ports: test.ports,
    }).submit(operation());

    expect(failed.state.phase).toBe("failed");
    if (failed.state.phase !== "failed") throw new Error("expected a failed round");
    expect(failed.state.failure.at).toBe("committing");
    expect(failed.state.failure.reason).toBe(
      "the turn changed 1 file but left no commit on head-before; a round's commits are its result and nothing stages them for you",
    );
  });

  // The mirror image, and the reason it is a separate sentence: commits with no reported
  // edits is a different problem from edits with no commits.
  it("names the commits a turn that reported nothing nonetheless left", async () => {
    const worker = {
      executionId: "worker-1",
      startedAt: 13,
      completedAt: 14,
      outcome: "completed",
      diff: "",
      changedPaths: [],
    } satisfies RoundWorkerReceipt;
    const test = scenario({ commitCount: 2, worker });
    const failed = await createRoundExecutionCoordinator({
      store: test.store,
      ports: test.ports,
    }).submit(operation());

    if (failed.state.phase !== "failed") throw new Error("expected a failed round");
    expect(failed.state.failure.reason).toContain("reported no changes but head-before..");
    expect(failed.state.failure.reason).toContain("carries 2 commits");
  });

  // A retry re-runs from the SAME `sourceHead`, so a failed attempt's commits are still in
  // the range the retry observes and would be counted as its work. The reviewer is the one
  // who resolves that — Rennet does not rewrite their branch — so the reason has to say so.
  it("names the commits a failed worker already left, because a retry would adopt them", async () => {
    const worker = {
      executionId: "worker-1",
      startedAt: 13,
      completedAt: 14,
      outcome: "failed",
      termination: { kind: "signal", signal: "SIGTERM" },
      diff: "partial diff",
      changedPaths: ["partial.ts"],
    } satisfies RoundWorkerReceipt;
    const test = scenario({ worker });
    const failed = await createRoundExecutionCoordinator({
      store: test.store,
      ports: { ...test.ports, observeCommits: async () => "head-after-partial" },
    }).submit(operation());

    if (failed.state.phase !== "failed") throw new Error("expected a failed worker round");
    expect(failed.state.failure.reason).toContain("worker stopped by signal SIGTERM");
    expect(failed.state.failure.reason).toContain("head-before..head-after-partial");

    // Control: an attempt that left the head where it started gets no note, so the sentence
    // cannot be a constant that reads as evidence.
    const still = scenario({ worker });
    const clean = await createRoundExecutionCoordinator({
      store: still.store,
      ports: { ...still.ports, observeCommits: async () => "head-before" },
    }).submit(operation());
    if (clean.state.phase !== "failed") throw new Error("expected a failed worker round");
    expect(clean.state.failure.reason).toBe("worker stopped by signal SIGTERM");
  });

  // Rennet runs no check of its own any more (round-worker-thread; Rai, 2026-09-04): the
  // worker runs the repository's, and the round goes from the settled turn straight to
  // observing the commits. Nothing between them is Rennet's to run.
  it("goes from a settled worker to the commit observation with nothing in between", async () => {
    const test = scenario();
    const completed = await createRoundExecutionCoordinator({
      store: test.store,
      ports: test.ports,
    }).submit(operation());

    expect(completed.state.phase).toBe("completed");
    // Order, not membership: a set of `toContain` checks passes for a workflow that does
    // the right steps in the wrong order, and the claim here is about sequence.
    expect(test.calls.slice(0, 5)).toEqual([
      "plan-workspace",
      "plan-worker",
      "worker",
      "plan-commit",
      "commits",
    ]);
    expect(test.calls.some((call) => call.includes("gate"))).toBe(false);
  });

  it.each([
    { count: 0, changed: false },
    { count: 1, changed: true },
    { count: 3, changed: true },
  ])(
    "records a $count commit result without fabricating the outcome",
    async ({ count, changed }) => {
      const worker = {
        executionId: "worker-1",
        startedAt: 13,
        completedAt: 14,
        outcome: "completed",
        diff: changed ? "diff --git a/file.ts b/file.ts\n" : "",
        changedPaths: changed ? ["file.ts"] : [],
      } satisfies RoundWorkerReceipt;
      const test = scenario({ commitCount: count, worker });
      const completed = await createRoundExecutionCoordinator({
        store: test.store,
        ports: test.ports,
      }).submit(operation());

      expect(completed.state.phase).toBe("completed");
      if (completed.state.phase !== "completed") throw new Error("expected a completed round");
      expect(completed.state.commits.count).toBe(count);
      expect(completed.state.result.kind).toBe(changed ? "changed" : "unchanged");
      expect(test.calls.includes("draft-report")).toBe(changed);
    },
  );

  it("adopts a concurrently persisted receipt without replaying the effect or publishing stale state", async () => {
    const test = scenario();
    const planWorkspace: RoundExecutionPorts["planWorkspace"] = vi.fn(async (current) => {
      const receipt: RoundWorkspaceReceipt = {
        kind: "bound-root",
        root: current.repoRoot,
        sourceHead: "head-before",
        preparedAt: 12,
      };
      const claimed = test.store.read(current.sessionId);
      if (claimed === undefined) throw new Error("the claim was not persisted");
      advance(test.store, claimed, { phase: "prepared", workspace: receipt }, 12);
      return receipt;
    });
    const completed = await createRoundExecutionCoordinator({
      store: test.store,
      ports: { ...test.ports, planWorkspace },
    }).submit(operation());

    expect(completed.state.phase).toBe("completed");
    expect(planWorkspace).toHaveBeenCalledTimes(1);
    const revisions = test.published.map(({ revision }) => revision);
    expect(new Set(revisions).size).toBe(revisions.length);
    // Revision 1 is the racer's `prepared` write. The coordinator ADOPTS it — it neither
    // republishes it as its own nor overwrites it — so it never reaches the publish sink.
    expect(revisions).not.toContain(1);
    expect(revisions).toEqual([...revisions].sort((left, right) => left - right));
  });

  it("retains an ordinary terminal receipt and treats the same dispatch as a fresh retry", async () => {
    const test = scenario();
    let failWorker = true;
    const runWorker = vi.fn(async (input: Parameters<RoundExecutionPorts["runWorker"]>[0]) => {
      if (failWorker) {
        return {
          ...input.attempt,
          completedAt: 30,
          outcome: "failed" as const,
          termination: { kind: "exit" as const, exitCode: 1 },
          diff: "",
          changedPaths: [],
        };
      }
      return test.ports.runWorker(input);
    });
    const ports: RoundExecutionPorts = {
      ...test.ports,
      runWorker,
      async drainTerminal() {
        return { kind: "retain" };
      },
    };
    const coordinator = createRoundExecutionCoordinator({ store: test.store, ports });
    const initial = operation();

    const first = coordinator.submit(initial);
    const failed = await first;
    expect(failed.state.phase).toBe("failed");
    expect(test.store.read(initial.sessionId)?.state.phase).toBe("failed");

    failWorker = false;
    const second = coordinator.submit(initial);
    expect(second).not.toBe(first);
    const completed = await second;
    expect(completed.state.phase).toBe("completed");
    expect(runWorker).toHaveBeenCalledTimes(2);
    expect(test.store.read(initial.sessionId)?.state.phase).toBe("completed");
  });

  it("fails at preparing when the bound workspace cannot be resolved, and retry re-claims", async () => {
    const test = scenario();
    // What the DURABLE row said each time the coordinator asked for the bound root. The
    // second entry is the whole point of the retry half: it is `claimed`, not `failed`.
    const phaseAtPlan: (string | undefined)[] = [];
    let attempts = 0;
    const planWorkspace: RoundExecutionPorts["planWorkspace"] = vi.fn(async (current) => {
      attempts += 1;
      phaseAtPlan.push(test.store.read(current.sessionId)?.state.phase);
      if (attempts === 1) throw new Error("the session's bound workspace root is gone");
      return test.ports.planWorkspace(current);
    });
    const coordinator = createRoundExecutionCoordinator({
      store: test.store,
      ports: {
        ...test.ports,
        planWorkspace,
        async drainTerminal() {
          return { kind: "retain" };
        },
      },
    });

    const failed = await coordinator.submit(operation());

    expect(failed.state.phase).toBe("failed");
    if (failed.state.phase !== "failed") throw new Error("expected a failed round");
    // The exact arm, and NOTHING beside it: `preparing` carries no workspace receipt,
    // because nothing was reserved before the read that threw.
    expect(failed.state.failure).toEqual({
      at: "preparing",
      reason: "the session's bound workspace root is gone",
      failedAt: expect.any(Number),
    });
    // Nothing downstream of the workspace read ran. The throwing plan is this test's own
    // stub and records nothing, so an empty ledger is exactly "no effect was dispatched".
    expect(test.calls).toEqual([]);

    const completed = await coordinator.retry("session-1");

    expect(completed?.state.phase).toBe("completed");
    expect(completed?.operationId).toBe(failed.operationId);
    // The retry drives the WHOLE round from the top, in order, exactly once.
    expect(test.calls).toEqual([
      "plan-workspace",
      "plan-worker",
      "worker",
      "plan-commit",
      "commits",
      "plan-round-recording",
      "record-round",
      "prepare-report",
      "draft-report",
      "plan-report-verification",
      "verify-report",
    ]);
    expect(phaseAtPlan).toEqual(["claimed", "claimed"]);
    // …and the re-claim is DURABLE, not just the in-memory retry path: the first state
    // published after the failure revision is `claimed` again.
    expect(
      test.published
        .filter((entry) => entry.revision > failed.revision)
        .map((entry) => entry.state.phase)[0],
    ).toBe("claimed");
  });

  it("retries a failed worker in the same operation and bound workspace", async () => {
    const test = scenario();
    let workerAttempt = 0;
    const planWorker: RoundExecutionPorts["planWorker"] = () => {
      test.calls.push("plan-worker");
      workerAttempt += 1;
      return { executionId: `worker-${workerAttempt}`, startedAt: 20 + workerAttempt };
    };
    const runWorker: RoundExecutionPorts["runWorker"] = vi.fn(async ({ attempt }) => {
      test.calls.push("worker");
      return workerAttempt === 1
        ? {
            ...attempt,
            completedAt: 30,
            outcome: "failed",
            termination: { kind: "signal", signal: "SIGTERM" },
            diff: "partial diff",
            changedPaths: ["partial.ts"],
          }
        : {
            ...attempt,
            completedAt: 31,
            outcome: "completed",
            diff: "diff --git a/file.ts b/file.ts\n",
            changedPaths: ["file.ts"],
          };
    });
    const coordinator = createRoundExecutionCoordinator({
      store: test.store,
      ports: {
        ...test.ports,
        planWorker,
        runWorker,
        async drainTerminal() {
          return { kind: "retain" };
        },
      },
    });

    const failed = await coordinator.submit(operation());
    expect(failed.state.phase).toBe("failed");
    if (failed.state.phase !== "failed" || failed.state.failure.at !== "worker") {
      throw new Error("expected a worker failure carrying its bound workspace");
    }
    const boundWorkspace = failed.state.failure.workspace;
    const completed = await coordinator.retry("session-1");

    expect(completed?.state.phase).toBe("completed");
    expect(runWorker).toHaveBeenCalledTimes(2);
    expect(test.calls.filter((call) => call === "plan-workspace")).toHaveLength(1);
    expect(completed?.operationId).toBe(failed.operationId);
    expect(completed?.askOccurrences).toEqual(failed.askOccurrences);
    if (completed?.state.phase !== "completed") throw new Error("retry did not complete");
    expect(completed.state.workspace).toEqual(boundWorkspace);
    expect(completed.state.workspace.root).toBe("/repo");
  });

  // The committing arm is a "round" retry (`roundRetryMode`), and observing commits is
  // exactly the step that can fail transiently now that nothing stages on the reviewer's
  // behalf. A retry must re-drive the observation from its persisted attempt and must not
  // repeat the worker's turn.
  it("retries commit settlement from its persisted attempt without repeating the turn", async () => {
    const test = scenario();
    let commitAttempts = 0;
    const runWorker = vi.fn(test.ports.runWorker);
    const planCommit = vi.fn(test.ports.planCommit);
    const settleCommits: RoundExecutionPorts["settleCommits"] = vi.fn(async (input) => {
      commitAttempts += 1;
      if (commitAttempts === 1) throw new Error("git rev-list was interrupted");
      return test.ports.settleCommits(input);
    });
    const coordinator = createRoundExecutionCoordinator({
      store: test.store,
      ports: {
        ...test.ports,
        runWorker,
        planCommit,
        settleCommits,
        async drainTerminal() {
          return { kind: "retain" };
        },
      },
    });

    const failed = await coordinator.submit(operation());
    expect(failed.state.phase).toBe("failed");
    if (failed.state.phase !== "failed") throw new Error("expected a failed round");
    expect(failed.state.failure.at).toBe("committing");
    expect(failed.state.failure.reason).toBe("git rev-list was interrupted");

    expect((await coordinator.retry("session-1"))?.state.phase).toBe("completed");
    expect(settleCommits).toHaveBeenCalledTimes(2);
    // The SAME persisted attempt, not a freshly planned one: a second `planCommit` would
    // measure the range from whatever HEAD is now rather than the head the round started
    // from, which is the range the review's successor patchset is built on.
    expect(planCommit).toHaveBeenCalledTimes(1);
    expect(runWorker).toHaveBeenCalledTimes(1);
  });

  it("retries board regeneration with the original reserved board identities", async () => {
    const test = scenario();
    let draftAttempt = 0;
    const runWorker = vi.fn(test.ports.runWorker);
    const settleCommits = vi.fn(test.ports.settleCommits);
    const recordRound = vi.fn(test.ports.recordRound);
    const draftReport: RoundExecutionPorts["draftReport"] = vi.fn(async (input) => {
      test.calls.push("draft-report");
      draftAttempt += 1;
      if (draftAttempt === 1) throw new Error("board regeneration failed");
      return { ...input.attempt, draftedAt: 40 };
    });
    const coordinator = createRoundExecutionCoordinator({
      store: test.store,
      ports: {
        ...test.ports,
        runWorker,
        settleCommits,
        recordRound,
        draftReport,
        async drainTerminal() {
          return { kind: "retain" };
        },
      },
    });

    const failed = await coordinator.submit(operation());
    expect(failed.state.phase).toBe("failed");
    if (failed.state.phase !== "failed" || failed.state.failure.at !== "report-drafting") {
      throw new Error("expected a report-drafting failure");
    }
    const reserved = failed.state.failure.report;
    const completed = await coordinator.retry("session-1");

    expect(completed?.state.phase).toBe("completed");
    expect(runWorker).toHaveBeenCalledTimes(1);
    expect(settleCommits).toHaveBeenCalledTimes(1);
    expect(recordRound).toHaveBeenCalledTimes(1);
    expect(draftReport).toHaveBeenCalledTimes(2);
    expect(test.calls.filter((call) => call === "prepare-report")).toHaveLength(1);
    if (completed?.state.phase !== "completed" || completed.state.result.kind !== "changed") {
      throw new Error("retry did not complete regeneration");
    }
    expect(completed.state.result.report.reportBoardId).toBe(reserved.reportBoardId);
    expect(completed.state.result.report.generation).toBe(reserved.generation);
  });

  it("persists the verified report handoff when later lens regeneration fails", async () => {
    const test = scenario();
    const coordinator = createRoundExecutionCoordinator({
      store: test.store,
      ports: {
        ...test.ports,
        async draftReport({ attempt, recordReportHandoff }) {
          const handoff = recordReportHandoff({
            reportBoardId: attempt.reportBoardId,
            generation: attempt.generation,
            report: reportBoard,
          });
          const persisted = test.store.read("session-1");
          expect(persisted?.revision).toBe(handoff.operationRevision);
          expect(persisted?.state.phase).toBe("report-drafting");
          throw new Error("core lens regeneration failed");
        },
        async drainTerminal() {
          return { kind: "retain" };
        },
      },
    });

    const failed = await coordinator.submit(operation());

    expect(failed.state.phase).toBe("failed");
    if (failed.state.phase !== "failed" || failed.state.failure.at !== "report-drafting") {
      throw new Error("expected a report-drafting failure");
    }
    expect(failed.state.failure.reason).toBe("core lens regeneration failed");
    expect(failed.state.failure.report.handoff).toMatchObject({
      operationId: failed.operationId,
      operationRevision: failed.revision - 1,
      reportBoardId: "report-board-1",
      generation: "generation-1",
      report: reportBoard,
    });

    const restartedDraftReport = vi.fn<RoundExecutionPorts["draftReport"]>(async () => {
      throw new Error("unexpected cold retry");
    });
    const restarted = createRoundExecutionCoordinator({
      store: new RoundOperationStore(test.dir),
      ports: {
        ...test.ports,
        draftReport: restartedDraftReport,
        async drainTerminal() {
          return { kind: "retain" };
        },
      },
    });

    const [recovered] = await restarted.recover();

    expect(recovered?.state).toMatchObject({
      phase: "failed",
      failure: {
        at: "report-drafting",
        reason: "core lens regeneration failed",
      },
    });
    expect(restartedDraftReport).not.toHaveBeenCalled();
  });

  it("cold-retries a retained post-handoff drafting failure without replaying settled work", async () => {
    const test = scenario();
    const first = createRoundExecutionCoordinator({
      store: test.store,
      ports: {
        ...test.ports,
        async draftReport({ attempt, recordReportHandoff }) {
          recordReportHandoff({
            reportBoardId: attempt.reportBoardId,
            generation: attempt.generation,
            report: reportBoard,
          });
          throw new Error("Repository access was not granted");
        },
        async drainTerminal() {
          return { kind: "retain" };
        },
      },
    });
    const failed = await first.submit(operation());
    if (failed.state.phase !== "failed" || failed.state.failure.at !== "report-drafting") {
      throw new Error("expected the first post-handoff attempt to fail");
    }
    const priorHandoff = failed.state.failure.report.handoff;
    if (priorHandoff === undefined) throw new Error("expected a durable report handoff");

    const planWorkspace = vi.fn(test.ports.planWorkspace);
    const runWorker = vi.fn(test.ports.runWorker);
    const settleCommits = vi.fn(test.ports.settleCommits);
    const recordRound = vi.fn(test.ports.recordRound);
    const draftReport = vi.fn<RoundExecutionPorts["draftReport"]>(
      async ({ operation: recovered, attempt, recordReportHandoff }) => {
        const handoff = recordReportHandoff({
          reportBoardId: attempt.reportBoardId,
          generation: attempt.generation,
          report: reportBoard,
        });
        expect(handoff.operationRevision).toBe(recovered.revision);
        expect(handoff.operationRevision).toBeGreaterThan(priorHandoff.operationRevision);
        return { ...attempt, draftedAt: handoff.operationRevision + 100 };
      },
    );
    const restarted = createRoundExecutionCoordinator({
      store: new RoundOperationStore(test.dir),
      ports: {
        ...test.ports,
        planWorkspace,
        runWorker,
        settleCommits,
        recordRound,
        draftReport,
        async drainTerminal() {
          return { kind: "retain" };
        },
      },
    });

    const [recovered] = await restarted.recover();

    expect(recovered?.state.phase).toBe("completed");
    expect(draftReport).toHaveBeenCalledTimes(1);
    expect(planWorkspace).not.toHaveBeenCalled();
    expect(runWorker).not.toHaveBeenCalled();
    expect(settleCommits).not.toHaveBeenCalled();
    expect(recordRound).not.toHaveBeenCalled();
  });

  it("mints a fresh report epoch before retrying regeneration with a queued rerun", async () => {
    const test = scenario();
    const handoffRevisions: number[] = [];
    const coordinator = createRoundExecutionCoordinator({
      store: test.store,
      ports: {
        ...test.ports,
        async draftReport({ attempt, recordReportHandoff }) {
          const handoff = recordReportHandoff({
            reportBoardId: attempt.reportBoardId,
            generation: attempt.generation,
            report: reportBoard,
          });
          handoffRevisions.push(handoff.operationRevision);
          throw new Error("core lens regeneration failed");
        },
        async drainTerminal({ operation: current }) {
          return current.rerunRequested ? { kind: "clear-queued" } : { kind: "retain" };
        },
      },
    });

    const firstFailure = await coordinator.submit(operation());
    if (
      firstFailure.state.phase !== "failed" ||
      firstFailure.state.failure.at !== "report-drafting"
    ) {
      throw new Error("expected the first report attempt to fail");
    }
    const firstHandoff = firstFailure.state.failure.report.handoff;
    if (firstHandoff === undefined) throw new Error("expected the first verified handoff");
    const queued = test.store.requestRerun(storeExpectation(firstFailure));

    const secondFailure = await coordinator.retry("session-1");

    expect(secondFailure?.state.phase).toBe("failed");
    expect(handoffRevisions).toEqual([
      firstHandoff.operationRevision,
      firstHandoff.operationRevision + 4,
    ]);
    expect(
      test.published
        .filter((entry) => entry.revision > queued.revision)
        .map((entry) => [
          entry.revision,
          entry.state.phase,
          entry.state.phase === "report-drafting"
            ? entry.state.report.handoff?.operationRevision
            : entry.state.phase === "failed" && entry.state.failure.at === "report-drafting"
              ? entry.state.failure.report.handoff?.operationRevision
              : undefined,
        ]),
    ).toEqual([
      [firstHandoff.operationRevision + 3, "report-drafting", firstHandoff.operationRevision],
      [firstHandoff.operationRevision + 4, "report-drafting", firstHandoff.operationRevision + 4],
      [firstHandoff.operationRevision + 5, "failed", firstHandoff.operationRevision + 4],
    ]);
  });

  it("mints a higher durable report epoch before replaying after daemon recovery", async () => {
    const test = scenario();
    const handoffReady = deferred<number>();
    const first = createRoundExecutionCoordinator({
      store: test.store,
      ports: {
        ...test.ports,
        async draftReport({ attempt, recordReportHandoff }) {
          const handoff = recordReportHandoff({
            reportBoardId: attempt.reportBoardId,
            generation: attempt.generation,
            report: reportBoard,
          });
          handoffReady.resolve(handoff.operationRevision);
          return new Promise<never>(() => undefined);
        },
      },
    });
    void first.submit(operation());
    const priorRevision = await handoffReady.promise;
    const replayedRevisions: number[] = [];
    const recoveredCoordinator = createRoundExecutionCoordinator({
      store: test.store,
      ports: {
        ...test.ports,
        async draftReport({ operation: recovered, attempt, recordReportHandoff }) {
          const handoff = recordReportHandoff({
            reportBoardId: attempt.reportBoardId,
            generation: attempt.generation,
            report: reportBoard,
          });
          replayedRevisions.push(handoff.operationRevision);
          expect(handoff.operationRevision).toBe(recovered.revision);
          throw new Error("replayed lens regeneration failed");
        },
        async drainTerminal() {
          return { kind: "retain" };
        },
      },
    });

    const [failed] = await recoveredCoordinator.recover();

    expect(replayedRevisions).toEqual([priorRevision + 1]);
    expect(failed?.state.phase).toBe("failed");
    if (failed?.state.phase !== "failed" || failed.state.failure.at !== "report-drafting") {
      throw new Error("expected the recovered report attempt to fail");
    }
    expect(failed.state.failure.report.handoff?.operationRevision).toBe(priorRevision + 1);
  });

  it("retries a failed terminal drain before a fresh dispatch can replace its receipt", async () => {
    const test = scenario();
    let drainAttempts = 0;
    const runWorker = vi.fn(test.ports.runWorker);
    const coordinator = createRoundExecutionCoordinator({
      store: test.store,
      ports: {
        ...test.ports,
        runWorker,
        async drainTerminal() {
          drainAttempts += 1;
          if (drainAttempts === 1) throw new Error("transcript append failed");
          return { kind: "retain" };
        },
      },
    });
    const initial = operation();

    await expect(coordinator.submit(initial)).rejects.toThrow("transcript append failed");
    expect(test.store.read(initial.sessionId)?.state.phase).toBe("completed");

    const completed = await coordinator.submit(initial);
    expect(completed.state.phase).toBe("completed");
    expect(drainAttempts).toBe(3);
    expect(runWorker).toHaveBeenCalledTimes(2);
  });
});
