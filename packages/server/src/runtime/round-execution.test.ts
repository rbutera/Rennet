import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoundOperationStore } from "@rennet/adapters";
import {
  type RoundCommitReceipt,
  type RoundGateReceipt,
  type RoundOperation,
  type RoundOperationFailure,
  type RoundOperationState,
  type RoundReportReceipt,
  type RoundSourceLandingAttempt,
  type RoundSourceLandingReceipt,
  type RoundSourceLandingUnitReceipt,
  type RoundWorkerReceipt,
  type RoundWorkspaceAttempt,
  roundSourceLandingArtifactPaths,
  sha256Hex,
} from "@rennet/protocol";
import { describe, expect, it, vi } from "vitest";
import { createRoundExecutionCoordinator, type RoundExecutionPorts } from "./round-execution";

function transactionalLandingAttempt(): RoundSourceLandingAttempt {
  return {
    effect: "source-landing",
    strategy: "exclusive-move-v1",
    executionId: "landing-transaction-1",
    baselineCommit: "head-before",
    workerHead: "head-after-1",
    startedAt: 20,
    units: [
      {
        id: "unit-a",
        path: "a.txt",
        baseline: { kind: "git", mode: "100644", oid: "a".repeat(40) },
        target: { kind: "git", mode: "100644", oid: "b".repeat(40) },
        ...roundSourceLandingArtifactPaths("landing-transaction-1", "unit-a"),
      },
      {
        id: "unit-b",
        path: "b.txt",
        baseline: { kind: "absent" },
        target: { kind: "git", mode: "100644", oid: "c".repeat(40) },
        ...roundSourceLandingArtifactPaths("landing-transaction-1", "unit-b"),
      },
    ],
    unitReceipts: [],
  };
}

function operation(
  options: {
    dispatchId?: string;
    gatePlan?: RoundOperation["gatePlan"];
    operationId?: string;
    roundNumber?: number;
  } = {},
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
    gatePlan: options.gatePlan ?? { kind: "configured", command: "pnpm check" },
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

function seedWorkerRunning(store: RoundOperationStore, initial: RoundOperation): RoundOperation {
  const claimed = store.claimIfIdle(initial);
  const workspaceAttempt: RoundWorkspaceAttempt = {
    kind: "detached-worktree",
    worktreePath: "/rounds/operation-1",
    sourceTreeOid: "tree-before",
    sourceParentHead: "parent-before",
    startedAt: 2,
  };
  const preparing = advance(
    store,
    claimed,
    { phase: "workspace-preparing", workspace: workspaceAttempt },
    2,
  );
  const workspace = { ...workspaceAttempt, sourceHead: "head-before", preparedAt: 3 };
  const prepared = advance(store, preparing, { phase: "prepared", workspace }, 3);
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

function seedGateRunning(store: RoundOperationStore, initial: RoundOperation): RoundOperation {
  const running = seedWorkerRunning(store, initial);
  if (running.state.phase !== "worker-running") throw new Error("expected seeded worker attempt");
  const worker = {
    ...running.state.worker,
    completedAt: 5,
    outcome: "completed",
    diff: "",
    changedPaths: [],
  } satisfies RoundWorkerReceipt;
  const settled = advance(
    store,
    running,
    { phase: "worker-settled", workspace: running.state.workspace, worker },
    5,
  );
  return advance(
    store,
    settled,
    {
      phase: "gate-running",
      workspace: running.state.workspace,
      worker,
      gate: { executionId: "gate-recovery", startedAt: 6 },
    },
    6,
  );
}

function seedCommitting(store: RoundOperationStore, initial: RoundOperation): RoundOperation {
  const running = seedWorkerRunning(store, initial);
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
  const gateSettled = advance(
    store,
    workerSettled,
    {
      phase: "gate-settled",
      workspace: running.state.workspace,
      worker,
      gate: { outcome: "skipped", reason: "not-configured", settledAt: 6 },
    },
    6,
  );
  return advance(
    store,
    gateSettled,
    {
      phase: "committing",
      workspace: running.state.workspace,
      worker,
      gate: { outcome: "skipped", reason: "not-configured", settledAt: 6 },
      commit: { executionId: "commit-recovery", baseHead: "head-before", startedAt: 7 },
    },
    7,
  );
}

function seedSourceLanding(store: RoundOperationStore, initial: RoundOperation): RoundOperation {
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
      gate: committing.state.gate,
      commits,
    },
    8,
  );
  return advance(
    store,
    settled,
    {
      phase: "source-landing",
      workspace: committing.state.workspace,
      worker: committing.state.worker,
      gate: committing.state.gate,
      commits,
      landing: {
        effect: "source-landing",
        executionId: "landing-recovery",
        baselineCommit: commits.from,
        workerHead: commits.to,
        startedAt: 9,
      },
    },
    9,
  );
}

function seedRoundRecording(store: RoundOperationStore, initial: RoundOperation): RoundOperation {
  const landing = seedSourceLanding(store, initial);
  if (landing.state.phase !== "source-landing") throw new Error("expected seeded landing attempt");
  const landed = advance(
    store,
    landing,
    {
      phase: "source-landed",
      workspace: landing.state.workspace,
      worker: landing.state.worker,
      gate: landing.state.gate,
      commits: landing.state.commits,
      landing: { ...landing.state.landing, outcome: "already-applied", landedAt: 10 },
    },
    10,
  );
  if (landed.state.phase !== "source-landed") throw new Error("expected seeded landing receipt");
  return advance(
    store,
    landed,
    {
      phase: "round-recording",
      workspace: landed.state.workspace,
      worker: landed.state.worker,
      gate: landed.state.gate,
      commits: landed.state.commits,
      landing: landed.state.landing,
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

function scenario(
  options: { commitCount?: number; gate?: RoundGateReceipt; worker?: RoundWorkerReceipt } = {},
): Scenario {
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
    planWorkspace(current) {
      calls.push("plan-workspace");
      return {
        kind: "detached-worktree",
        worktreePath: `/rounds/${current.operationId}`,
        sourceTreeOid: "tree-before",
        sourceParentHead: "parent-before",
        startedAt: now(),
      };
    },
    async prepareWorkspace({ operation: current, attempt }) {
      calls.push("prepare-workspace");
      expect(store.read(current.sessionId)?.state.phase).toBe("workspace-preparing");
      return { ...attempt, sourceHead: "head-before", preparedAt: now() };
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
    planGate() {
      calls.push("plan-gate");
      return { executionId: "gate-1", startedAt: now() };
    },
    async runGate({ operation: current, attempt }) {
      calls.push("gate");
      expect(store.read(current.sessionId)?.state.phase).toBe("gate-running");
      return (
        options.gate ?? {
          ...attempt,
          completedAt: now(),
          outcome: "passed",
          exitCode: 0,
        }
      );
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
    planSourceLanding(current) {
      calls.push("plan-source-landing");
      if (current.state.phase !== "commits-settled") {
        throw new Error("source landing planned before commits settled");
      }
      return {
        effect: "source-landing",
        executionId: "landing-1",
        baselineCommit: current.state.commits.from,
        workerHead: current.state.commits.to,
        startedAt: now(),
      };
    },
    async landSourceChanges({ operation: current, attempt }) {
      calls.push("land-source");
      expect(store.read(current.sessionId)?.state.phase).toBe("source-landing");
      return {
        ...attempt,
        outcome: "applied",
        landedAt: now(),
      } satisfies RoundSourceLandingReceipt;
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
      "prepare-workspace",
      "plan-worker",
      "worker",
      "plan-gate",
      "gate",
      "plan-commit",
      "commits",
      "plan-source-landing",
      "land-source",
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
      "workspace-preparing",
      "prepared",
      "worker-running",
      "worker-settled",
      "gate-running",
      "gate-settled",
      "committing",
      "commits-settled",
      "source-landing",
      "source-landed",
      "round-recording",
      "round-recorded",
      "report-drafting",
      "report-verifying",
      "completed",
    ]);
    expect(test.store.read(completed.sessionId)).toBeUndefined();
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
      workspace: vi.fn(test.ports.prepareWorkspace),
      worker: vi.fn(test.ports.runWorker),
      gate: vi.fn(test.ports.runGate),
      commits: vi.fn(test.ports.settleCommits),
      landing: vi.fn(test.ports.landSourceChanges),
      recording: vi.fn(test.ports.recordRound),
    };
    const recovered = await createRoundExecutionCoordinator({
      store: test.store,
      ports: {
        ...test.ports,
        prepareWorkspace: replayed.workspace,
        runWorker: replayed.worker,
        runGate: replayed.gate,
        settleCommits: replayed.commits,
        landSourceChanges: replayed.landing,
        recordRound: replayed.recording,
      },
    }).recover();

    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.state.phase).toBe("completed");
    expect(replayed.workspace).not.toHaveBeenCalled();
    expect(replayed.worker).not.toHaveBeenCalled();
    expect(replayed.gate).not.toHaveBeenCalled();
    expect(replayed.commits).not.toHaveBeenCalled();
    expect(replayed.landing).not.toHaveBeenCalled();
    expect(replayed.recording).not.toHaveBeenCalled();
  });

  it("cold-recovers the exact source landing attempt without replaying earlier effects", async () => {
    const test = scenario();
    seedSourceLanding(test.store, operation({ gatePlan: { kind: "absent" } }));
    const prepareWorkspace = vi.fn(test.ports.prepareWorkspace);
    const runWorker = vi.fn(test.ports.runWorker);
    const runGate = vi.fn(test.ports.runGate);
    const settleCommits = vi.fn(test.ports.settleCommits);
    const landSourceChanges = vi.fn(test.ports.landSourceChanges);
    const recovered = await createRoundExecutionCoordinator({
      store: new RoundOperationStore(test.dir),
      ports: {
        ...test.ports,
        prepareWorkspace,
        runWorker,
        runGate,
        settleCommits,
        landSourceChanges,
      },
    }).recover();

    expect(recovered[0]?.state.phase).toBe("completed");
    expect(prepareWorkspace).not.toHaveBeenCalled();
    expect(runWorker).not.toHaveBeenCalled();
    expect(runGate).not.toHaveBeenCalled();
    expect(settleCommits).not.toHaveBeenCalled();
    expect(landSourceChanges).toHaveBeenCalledTimes(1);
    expect(landSourceChanges.mock.calls[0]?.[0].attempt.executionId).toBe("landing-recovery");
  });

  it("persists each transactional landing unit as an exact prefix and resumes after a crash", async () => {
    const test = scenario();
    const attempt = transactionalLandingAttempt();
    const firstRunUnits: string[] = [];
    let crashed = false;
    const firstPorts: RoundExecutionPorts = {
      ...test.ports,
      planSourceLanding: () => attempt,
      landSourceChanges: vi.fn(test.ports.landSourceChanges),
      async landSourceUnit({ unit }) {
        firstRunUnits.push(unit.id);
        return {
          unitId: unit.id,
          outcome: "applied",
          landedAt: 30,
        } satisfies RoundSourceLandingUnitReceipt;
      },
      async cleanupSourceLanding() {
        throw new Error("cleanup ran before the complete receipt was durable");
      },
      publish(current) {
        if (
          !crashed &&
          current.state.phase === "source-landing" &&
          current.state.landing.strategy === "exclusive-move-v1" &&
          current.state.landing.unitReceipts.length === 1
        ) {
          crashed = true;
          throw new Error("simulated process death after the first durable unit");
        }
      },
    };

    await expect(
      createRoundExecutionCoordinator({ store: test.store, ports: firstPorts }).submit(operation()),
    ).rejects.toThrow("simulated process death");
    const interrupted = test.store.read("session-1");
    expect(interrupted?.state.phase).toBe("source-landing");
    if (
      interrupted?.state.phase !== "source-landing" ||
      interrupted.state.landing.strategy !== "exclusive-move-v1"
    ) {
      throw new Error("transactional landing prefix was not retained");
    }
    expect(interrupted.state.landing.unitReceipts.map(({ unitId }) => unitId)).toEqual(["unit-a"]);
    expect(firstRunUnits).toEqual(["unit-a"]);

    const resumedUnits: string[] = [];
    const cleanup = vi.fn(
      async (input: Parameters<NonNullable<RoundExecutionPorts["cleanupSourceLanding"]>>[0]) => {
        expect(test.store.read(input.operation.sessionId)?.state.phase).toBe("source-landed");
      },
    );
    const recovered = await createRoundExecutionCoordinator({
      store: new RoundOperationStore(test.dir),
      ports: {
        ...test.ports,
        planSourceLanding: () => attempt,
        landSourceChanges: vi.fn(test.ports.landSourceChanges),
        async landSourceUnit({ unit }) {
          resumedUnits.push(unit.id);
          return {
            unitId: unit.id,
            outcome: "already-applied",
            landedAt: 31,
          } satisfies RoundSourceLandingUnitReceipt;
        },
        cleanupSourceLanding: cleanup,
      },
    }).recover();

    expect(recovered[0]?.state.phase).toBe("completed");
    expect(resumedUnits).toEqual(["unit-b"]);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("terminalizes transactional landing planning failures instead of replanning on recovery", async () => {
    const test = scenario();
    const planSourceLanding = vi.fn(async (): Promise<RoundSourceLandingAttempt> => {
      throw new Error("Git returned unsupported mode 160000");
    });
    const ports: RoundExecutionPorts = {
      ...test.ports,
      planSourceLanding,
      async drainTerminal() {
        return { kind: "retain" };
      },
    };

    const failed = await createRoundExecutionCoordinator({ store: test.store, ports }).submit(
      operation(),
    );
    expect(failed.state.phase).toBe("failed");
    if (failed.state.phase !== "failed") throw new Error("planning failure was not terminal");
    expect(failed.state.failure).toMatchObject({
      at: "source-landing-planning",
      reason: "Git returned unsupported mode 160000",
    });

    const recovered = await createRoundExecutionCoordinator({
      store: new RoundOperationStore(test.dir),
      ports,
    }).recover();
    expect(recovered[0]?.state.phase).toBe("failed");
    expect(planSourceLanding).toHaveBeenCalledTimes(1);
  });

  it("cold-recovers the exact round recording attempt without relanding", async () => {
    const test = scenario();
    seedRoundRecording(test.store, operation({ gatePlan: { kind: "absent" } }));
    const settleCommits = vi.fn(test.ports.settleCommits);
    const landSourceChanges = vi.fn(test.ports.landSourceChanges);
    const recordRound = vi.fn(async (input: Parameters<RoundExecutionPorts["recordRound"]>[0]) => {
      expect(input.operation.dispatchId).toBe("dispatch-operation-1");
      return test.ports.recordRound(input);
    });
    const recovered = await createRoundExecutionCoordinator({
      store: new RoundOperationStore(test.dir),
      ports: {
        ...test.ports,
        settleCommits,
        landSourceChanges,
        recordRound,
      },
    }).recover();

    expect(recovered[0]?.state.phase).toBe("completed");
    expect(settleCommits).not.toHaveBeenCalled();
    expect(landSourceChanges).not.toHaveBeenCalled();
    expect(recordRound).toHaveBeenCalledTimes(1);
    expect(recordRound.mock.calls[0]?.[0].attempt.executionId).toBe("recording-recovery");
  });

  it("resumes an idempotent commit settlement from its persisted attempt", async () => {
    const test = scenario();
    seedCommitting(test.store, operation({ gatePlan: { kind: "absent" } }));
    const prepareWorkspace = vi.fn(test.ports.prepareWorkspace);
    const runWorker = vi.fn(test.ports.runWorker);
    const runGate = vi.fn(test.ports.runGate);
    const settleCommits = vi.fn(test.ports.settleCommits);
    const recovered = await createRoundExecutionCoordinator({
      store: test.store,
      ports: {
        ...test.ports,
        prepareWorkspace,
        runWorker,
        runGate,
        settleCommits,
      },
    }).recover();

    expect(recovered[0]?.state.phase).toBe("completed");
    expect(prepareWorkspace).not.toHaveBeenCalled();
    expect(runWorker).not.toHaveBeenCalled();
    expect(runGate).not.toHaveBeenCalled();
    expect(settleCommits).toHaveBeenCalledTimes(1);
    expect(settleCommits.mock.calls[0]?.[0].attempt.executionId).toBe("commit-recovery");
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

  it("marks an unobservable recovered gate as interrupted without running it again", async () => {
    const test = scenario();
    seedGateRunning(test.store, operation());
    const runGate = vi.fn(test.ports.runGate);
    const coordinator = createRoundExecutionCoordinator({
      store: test.store,
      ports: {
        ...test.ports,
        runGate,
        async drainTerminal() {
          throw new Error("retain failed gate for inspection");
        },
      },
      now: () => 20,
    });

    await expect(coordinator.recover()).rejects.toThrow("retain failed gate for inspection");
    expect(runGate).not.toHaveBeenCalled();
    const failed = test.store.read("session-1");
    expect(failed?.state.phase).toBe("failed");
    if (failed?.state.phase !== "failed") throw new Error("expected gate recovery to fail");
    expect(failed.state.failure).toMatchObject({
      at: "gate",
      gate: { executionId: "gate-recovery" },
    });
    expect(failed.state.failure.reason).toContain("interrupted");
  });

  it.each([
    {
      name: "source landing",
      expectedAt: "source-landing" satisfies RoundOperationFailure["at"],
      ports: (test: Scenario): RoundExecutionPorts => ({
        ...test.ports,
        async landSourceChanges() {
          throw new Error("source landing failed");
        },
      }),
    },
    {
      name: "round recording",
      expectedAt: "round-recording" satisfies RoundOperationFailure["at"],
      ports: (test: Scenario): RoundExecutionPorts => ({
        ...test.ports,
        async recordRound() {
          throw new Error("round recording failed");
        },
      }),
    },
  ])("persists $name failures at their exact effect boundary", async ({ expectedAt, ports }) => {
    const test = scenario();
    const failed = await createRoundExecutionCoordinator({
      store: test.store,
      ports: ports(test),
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

  it.each([
    {
      name: "passes a configured gate from its real zero exit receipt",
      gatePlan: { kind: "configured", command: "pnpm check" } satisfies RoundOperation["gatePlan"],
      gate: {
        executionId: "gate-1",
        startedAt: 13,
        completedAt: 14,
        outcome: "passed",
        exitCode: 0,
      } satisfies RoundGateReceipt,
      expectedPhase: "completed",
      expectedGate: "passed",
    },
    {
      name: "fails a configured gate from its nonzero exit receipt",
      gatePlan: { kind: "configured", command: "pnpm check" } satisfies RoundOperation["gatePlan"],
      gate: {
        executionId: "gate-1",
        startedAt: 13,
        completedAt: 14,
        outcome: "failed",
        termination: { kind: "exit", exitCode: 2 },
      } satisfies RoundGateReceipt,
      expectedPhase: "failed",
      expectedGate: "failed",
    },
  ])("$name", async ({ gatePlan, gate, expectedPhase, expectedGate }) => {
    const test = scenario({ gate });
    const terminal = await createRoundExecutionCoordinator({
      store: test.store,
      ports: test.ports,
    }).submit(operation({ gatePlan }));

    expect(terminal.state.phase).toBe(expectedPhase);
    if (terminal.state.phase === "completed") {
      expect(terminal.state.gate.outcome).toBe(expectedGate);
    } else if (terminal.state.phase === "failed") {
      expect(terminal.state.failure.at).toBe("gate");
    }
  });

  it("settles an absent gate without planning or running a command", async () => {
    const worker = {
      executionId: "worker-1",
      startedAt: 13,
      completedAt: 14,
      outcome: "completed",
      diff: "",
      changedPaths: [],
    } satisfies RoundWorkerReceipt;
    const test = scenario({ commitCount: 0, worker });
    const planGate = vi.fn(test.ports.planGate);
    const runGate = vi.fn(test.ports.runGate);
    const landSourceChanges = vi.fn(test.ports.landSourceChanges);
    const recordRound = vi.fn(test.ports.recordRound);
    const completed = await createRoundExecutionCoordinator({
      store: test.store,
      ports: { ...test.ports, planGate, runGate, landSourceChanges, recordRound },
    }).submit(operation({ gatePlan: { kind: "absent" } }));

    expect(completed.state.phase).toBe("completed");
    if (completed.state.phase !== "completed") throw new Error("expected an unchanged round");
    expect(completed.state.gate.outcome).toBe("skipped");
    expect(planGate).not.toHaveBeenCalled();
    expect(runGate).not.toHaveBeenCalled();
    expect(landSourceChanges).not.toHaveBeenCalled();
    expect(recordRound).toHaveBeenCalledTimes(1);
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
    const prepareWorkspace: RoundExecutionPorts["prepareWorkspace"] = vi.fn(async (input) => {
      const receipt = { ...input.attempt, sourceHead: "head-before", preparedAt: 12 };
      const current = test.store.read(input.operation.sessionId);
      if (current === undefined) throw new Error("workspace attempt was not persisted");
      advance(test.store, current, { phase: "prepared", workspace: receipt }, 12);
      return receipt;
    });
    const completed = await createRoundExecutionCoordinator({
      store: test.store,
      ports: { ...test.ports, prepareWorkspace },
    }).submit(operation());

    expect(completed.state.phase).toBe("completed");
    expect(prepareWorkspace).toHaveBeenCalledTimes(1);
    const revisions = test.published.map(({ revision }) => revision);
    expect(new Set(revisions).size).toBe(revisions.length);
    expect(revisions).not.toContain(2);
    expect(revisions).toEqual([...revisions].sort((left, right) => left - right));
  });

  it("retains an ordinary terminal receipt and treats the same dispatch as a fresh retry", async () => {
    const test = scenario();
    let failGate = true;
    const runWorker = vi.fn(test.ports.runWorker);
    const ports: RoundExecutionPorts = {
      ...test.ports,
      runWorker,
      async runGate(input) {
        if (failGate) {
          return {
            ...input.attempt,
            completedAt: 30,
            outcome: "failed",
            termination: { kind: "exit", exitCode: 1 },
          };
        }
        return { ...input.attempt, completedAt: 31, outcome: "passed", exitCode: 0 };
      },
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

    failGate = false;
    const second = coordinator.submit(initial);
    expect(second).not.toBe(first);
    const completed = await second;
    expect(completed.state.phase).toBe("completed");
    expect(runWorker).toHaveBeenCalledTimes(2);
    expect(test.store.read(initial.sessionId)?.state.phase).toBe("completed");
  });
});
