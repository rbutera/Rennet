import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import {
  type RoundOperation,
  type RoundRecordingAttempt,
  type RoundReportBoard,
  type RoundReportDraftAttempt,
  type RoundReportHandoff,
  type RoundSourceLandingAttempt,
  type RoundWorkerCompletedReceipt,
  type RoundWorkspaceAttempt,
  type RoundWorkspaceReceipt,
  roundSourceLandingArtifactPaths,
  sha256Hex,
} from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import {
  ROUND_OPERATION_STORE_FILE_NAME,
  ROUND_OPERATION_STORE_VERSION,
  RoundOperationConflictError,
  type RoundOperationExpectation,
  RoundOperationStore,
  RoundOperationStoreCorruptError,
  type RoundOperationTransition,
} from "./round-operation-store";

const RACE_ROLE = process.env.RENNET_ROUND_STORE_RACE_ROLE;
const RACE_DIR = process.env.RENNET_ROUND_STORE_RACE_DIR;
const RACE_SESSION_ID = "session-race";
const WORKSPACE_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const RACE_WAIT_CELL = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
const workspaceAttempt: RoundWorkspaceAttempt = {
  kind: "detached-worktree",
  worktreePath: "/round-worktree",
  sourceTreeOid: "tree123",
  sourceParentHead: "abc123",
  startedAt: 2,
};
const workspace: RoundWorkspaceReceipt = {
  ...workspaceAttempt,
  sourceHead: "abc123",
  preparedAt: 3,
};
const changedWorker = {
  executionId: "worker-1",
  startedAt: 3,
  completedAt: 4,
  outcome: "completed",
  diff: "diff --git a/file.ts b/file.ts",
  changedPaths: ["file.ts"],
} satisfies RoundWorkerCompletedReceipt;
const changedGate = {
  executionId: "gate-1",
  startedAt: 5,
  completedAt: 6,
  outcome: "passed",
  exitCode: 0,
} as const;
const changedCommits = {
  executionId: "commit-1",
  baseHead: "abc123",
  startedAt: 7,
  from: "abc123",
  to: "def456",
  count: 1,
  committedAt: 8,
} as const;
const changedLanding = {
  effect: "source-landing",
  executionId: "landing-1",
  baselineCommit: "abc123",
  workerHead: "def456",
  startedAt: 9,
  outcome: "applied",
  landedAt: 10,
} as const;
const recordingReceipt = {
  effect: "round-recording",
  executionId: "recording-1",
  startedAt: 11,
  recordedAt: 12,
} as const;
const reportDraftAttempt = {
  executionId: "report-draft-1",
  reportBoardId: "report-1",
  generation: "generation-2",
  boardIds: {
    design: "design-1",
    sequence: "sequence-1",
    decisions: "decisions-1",
    flagged: "flagged-1",
    noise: "noise-1",
    report: "report-1",
  },
  startedAt: 13,
} as const;
const reportDraftReceipt = { ...reportDraftAttempt, draftedAt: 14 } as const;
const reportBoard = {
  lens: "report" as const,
  generation: reportDraftAttempt.generation,
  boardId: reportDraftAttempt.reportBoardId,
  document: {
    title: "Round report",
    introMarkdown: "The requested change landed.",
    measure: "reading" as const,
  },
  sections: [],
  elements: [],
} satisfies RoundReportBoard;
function reportHandoff(operationId: string, operationRevision: number): RoundReportHandoff {
  return {
    operationId,
    operationRevision,
    reportBoardId: reportDraftAttempt.reportBoardId,
    generation: reportDraftAttempt.generation,
    report: reportBoard,
  };
}
const verificationAttempt = { executionId: "report-verify-1", startedAt: 15 } as const;
const changedRoundEvidence = {
  workspace,
  worker: changedWorker,
  gate: changedGate,
  commits: changedCommits,
  landing: changedLanding,
  recording: recordingReceipt,
} as const;

type CompletedRoundOperation = Omit<RoundOperation, "state"> & {
  state: Extract<RoundOperation["state"], { phase: "completed" }>;
};

function completedOperation(
  options: {
    operationId?: string;
    sessionId?: string;
    revision?: number;
    rerunRequested?: boolean;
    returnedAt?: number;
  } = {},
): CompletedRoundOperation {
  const completed = operation({
    operationId: options.operationId,
    sessionId: options.sessionId,
    revision: options.revision ?? 10,
    rerunRequested: options.rerunRequested,
    state: {
      phase: "completed",
      ...changedRoundEvidence,
      result: {
        kind: "changed",
        report: {
          ...reportDraftReceipt,
          verificationExecutionId: verificationAttempt.executionId,
          verificationStartedAt: verificationAttempt.startedAt,
          verifiedAt: 16,
        },
      },
      completedAt: 16,
      ...(options.returnedAt === undefined ? {} : { returnedAt: options.returnedAt }),
    },
  });
  if (completed.state.phase !== "completed") throw new Error("completed fixture is invalid");
  return { ...completed, state: completed.state };
}

function tempStoreDir(): string {
  return mkdtempSync(join(tmpdir(), "round-operation-store-"));
}

function insertStoredEnvelope(
  dir: string,
  values: {
    sessionId: string;
    operationId: string;
    revision: number;
    envelopeJson: string;
  },
): void {
  const database = new DatabaseSync(join(dir, ROUND_OPERATION_STORE_FILE_NAME));
  try {
    database
      .prepare(
        `INSERT INTO round_operations (session_id, operation_id, revision, envelope_json)
         VALUES (?, ?, ?, ?)`,
      )
      .run(values.sessionId, values.operationId, values.revision, values.envelopeJson);
  } finally {
    database.close();
  }
}

function operation(
  options: {
    gatePlan?: RoundOperation["gatePlan"];
    operationId?: string;
    sessionId?: string;
    revision?: number;
    rerunRequested?: boolean;
    state?: RoundOperation["state"];
    workOrderPrompt?: string;
  } = {},
): RoundOperation {
  const operationId = options.operationId ?? "operation-1";
  const workOrderPrompt = options.workOrderPrompt ?? "Implement the requested change.";
  return {
    operationId,
    sessionId: options.sessionId ?? "session-1",
    reviewId: "review-1",
    dispatchId: `dispatch-${operationId}`,
    sourcePatchsetId: "patchset-1",
    askOccurrences: [{ id: `ask-${operationId}`, revision: 0 }],
    roundNumber: 1,
    sourceTarget: { kind: "branch", branch: "feat/test" },
    repoRoot: "/repo",
    workOrderPrompt,
    workOrderDigest: sha256Hex(workOrderPrompt),
    gatePlan: options.gatePlan ?? { kind: "configured", command: "pnpm check" },
    revision: options.revision ?? 0,
    rerunRequested: options.rerunRequested ?? false,
    createdAt: 1,
    updatedAt: 1,
    state: options.state ?? { phase: "claimed" },
  };
}

function expectation(value: RoundOperation): RoundOperationExpectation {
  return {
    sessionId: value.sessionId,
    operationId: value.operationId,
    revision: value.revision,
  };
}

function storeWithPersistedOperation(value: RoundOperation): RoundOperationStore {
  const dir = tempStoreDir();
  new RoundOperationStore(dir).close();
  insertStoredEnvelope(dir, {
    sessionId: value.sessionId,
    operationId: value.operationId,
    revision: value.revision,
    envelopeJson: JSON.stringify({
      version: ROUND_OPERATION_STORE_VERSION,
      operation: value,
    }),
  });
  return new RoundOperationStore(dir);
}

function failDuringPreparation(
  store: RoundOperationStore,
  options: {
    operationId: string;
    sessionId: string;
  },
): RoundOperation {
  const claimed = store.claimIfIdle(operation(options));
  const preparing = store.compareAndSwap(expectation(claimed), {
    state: { phase: "workspace-preparing", workspace: workspaceAttempt },
    updatedAt: 2,
  });
  return store.compareAndSwap(expectation(preparing), {
    state: {
      phase: "failed",
      failure: {
        at: "preparing",
        reason: "worktree preparation stopped",
        failedAt: 3,
        workspace: workspaceAttempt,
      },
    },
    updatedAt: 3,
  });
}

function advanceToPrepared(store: RoundOperationStore, claimed: RoundOperation): RoundOperation {
  const preparing = store.compareAndSwap(expectation(claimed), {
    state: { phase: "workspace-preparing", workspace: workspaceAttempt },
    updatedAt: 2,
  });
  return store.compareAndSwap(expectation(preparing), {
    state: { phase: "prepared", workspace },
    updatedAt: 3,
  });
}

function advanceToWorkerSettled(
  store: RoundOperationStore,
  claimed: RoundOperation,
): RoundOperation {
  const prepared = advanceToPrepared(store, claimed);
  const running = store.compareAndSwap(expectation(prepared), {
    state: {
      phase: "worker-running",
      workspace,
      worker: { executionId: "worker-1", startedAt: 3 },
    },
    updatedAt: 3,
  });
  return store.compareAndSwap(expectation(running), {
    state: {
      phase: "worker-settled",
      workspace,
      worker: {
        executionId: "worker-1",
        startedAt: 3,
        completedAt: 4,
        outcome: "completed",
        diff: "",
        changedPaths: [],
      },
    },
    updatedAt: 4,
  });
}

function waitForRacePeers(dir: string): void {
  const deadline = Date.now() + 20_000;
  while (!(existsSync(join(dir, "ready-a")) && existsSync(join(dir, "ready-b")))) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for the race peer");
    Atomics.wait(RACE_WAIT_CELL, 0, 0, 10);
  }
}

function runRaceChild(dir: string, role: "a" | "b"): Promise<void> {
  return new Promise((resolve, reject) => {
    const vitest = join(WORKSPACE_ROOT, "node_modules", "vitest", "vitest.mjs");
    const child = spawn(
      process.execPath,
      [vitest, "run", join(WORKSPACE_ROOT, "packages/adapters/src/round-operation-store.test.ts")],
      {
        cwd: WORKSPACE_ROOT,
        env: {
          ...process.env,
          RENNET_ROUND_STORE_RACE_DIR: dir,
          RENNET_ROUND_STORE_RACE_ROLE: role,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`race child ${role} timed out\n${output}`));
    }, 30_000);
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else reject(new Error(`race child ${role} exited ${String(code)}\n${output}`));
    });
  });
}

if (RACE_ROLE !== undefined) {
  describe("RoundOperationStore process-race child", () => {
    it("attempts the shared compare-and-swap", () => {
      if (RACE_DIR === undefined) throw new Error("race directory is required");
      const store = new RoundOperationStore(RACE_DIR);
      const current = store.read(RACE_SESSION_ID);
      if (current === undefined) throw new Error("race operation is missing");
      writeFileSync(join(RACE_DIR, `ready-${RACE_ROLE}`), "ready");
      waitForRacePeers(RACE_DIR);

      let result: "success" | "conflict";
      try {
        store.compareAndSwap(expectation(current), {
          state: {
            phase: "workspace-preparing",
            workspace: workspaceAttempt,
          },
          updatedAt: current.updatedAt + 1,
        });
        result = "success";
      } catch (error) {
        if (!(error instanceof RoundOperationConflictError)) throw error;
        result = "conflict";
      }
      writeFileSync(join(RACE_DIR, `result-${RACE_ROLE}`), result);
      expect(result === "success" || result === "conflict").toBe(true);
    });
  });
} else {
  describe("RoundOperationStore", () => {
    it("reads a claimed operation through the versioned envelope after restart", () => {
      const dir = tempStoreDir();
      const claimed = operation({ operationId: "restart" });
      new RoundOperationStore(dir).claimIfIdle(claimed);

      expect(new RoundOperationStore(dir).read(claimed.sessionId)).toEqual(claimed);
      const database = new DatabaseSync(join(dir, ROUND_OPERATION_STORE_FILE_NAME), {
        readOnly: true,
      });
      const row = database
        .prepare("SELECT envelope_json FROM round_operations WHERE session_id = ?")
        .get(claimed.sessionId);
      database.close();
      if (typeof row?.envelope_json !== "string") throw new Error("stored envelope is missing");
      const persisted: unknown = JSON.parse(row.envelope_json);
      expect(persisted).toMatchObject({
        version: ROUND_OPERATION_STORE_VERSION,
        operation: claimed,
      });
    });

    it("persists the intended worktree before preparation can have side effects", () => {
      const dir = tempStoreDir();
      const store = new RoundOperationStore(dir);
      const claimed = store.claimIfIdle(operation({ operationId: "workspace-intent" }));
      const preparing = store.compareAndSwap(expectation(claimed), {
        state: { phase: "workspace-preparing", workspace: workspaceAttempt },
        updatedAt: 2,
      });

      expect(new RoundOperationStore(dir).read(claimed.sessionId)).toEqual(preparing);
    });

    it("returns the existing operation when a session is already claimed", () => {
      const store = new RoundOperationStore(tempStoreDir());
      const first = operation({ operationId: "first" });
      const second = operation({ operationId: "second" });

      expect(store.claimIfIdle(first)).toEqual(first);
      expect(store.claimIfIdle(second)).toEqual(first);
      expect(store.read(first.sessionId)).toEqual(first);
    });

    it("atomically claims a successor only after the completed operation returned", () => {
      const sessionId = "session-returned";
      const draining = completedOperation({ operationId: "draining", sessionId });
      const drainingStore = storeWithPersistedOperation(draining);
      const successor = operation({ operationId: "successor", sessionId });

      expect(drainingStore.claimOrReplaceReturned(successor)).toEqual(draining);
      expect(drainingStore.read(sessionId)).toEqual(draining);

      const returned = drainingStore.compareAndSwap(expectation(draining), {
        state: { ...draining.state, returnedAt: 17 },
        updatedAt: 17,
      });
      expect(drainingStore.claimOrReplaceReturned(successor)).toEqual(successor);
      expect(drainingStore.read(sessionId)).toEqual(successor);

      const queuedReturned = completedOperation({
        operationId: "queued-returned",
        sessionId: "session-queued-returned",
        rerunRequested: true,
        returnedAt: 17,
      });
      const queuedStore = storeWithPersistedOperation(queuedReturned);
      expect(
        queuedStore.claimOrReplaceReturned(
          operation({ operationId: "must-wait", sessionId: queuedReturned.sessionId }),
        ),
      ).toEqual(queuedReturned);
      const sameIdentity = completedOperation({
        operationId: "same-identity",
        sessionId: "session-same-identity",
        returnedAt: 17,
      });
      const sameIdentityStore = storeWithPersistedOperation(sameIdentity);
      expect(() =>
        sameIdentityStore.claimOrReplaceReturned(
          operation({ operationId: sameIdentity.operationId, sessionId: sameIdentity.sessionId }),
        ),
      ).toThrow(RoundOperationConflictError);
      expect(returned.state).toMatchObject({ phase: "completed", returnedAt: 17 });
    });

    it("allows a completed operation to add only its immutable return receipt", () => {
      const completed = completedOperation({ operationId: "return-receipt" });
      const store = storeWithPersistedOperation(completed);
      const returned = store.compareAndSwap(expectation(completed), {
        state: { ...completed.state, returnedAt: 17 },
        updatedAt: 17,
      });
      if (returned.state.phase !== "completed") throw new Error("return receipt was not persisted");
      const returnedState = returned.state;

      expect(returnedState).toEqual({ ...completed.state, returnedAt: 17 });
      expect(returned.revision).toBe(completed.revision + 1);
      expect(() =>
        store.compareAndSwap(expectation(returned), {
          state: { ...returnedState, returnedAt: 18 },
          updatedAt: 18,
        }),
      ).toThrow(RoundOperationConflictError);

      const mutationStore = storeWithPersistedOperation(
        completedOperation({ operationId: "mutated-return", sessionId: "mutated-return" }),
      );
      const current = mutationStore.read("mutated-return");
      if (current?.state.phase !== "completed") throw new Error("completed fixture is missing");
      const currentState = current.state;
      expect(() =>
        mutationStore.compareAndSwap(expectation(current), {
          state: {
            ...currentState,
            worker: { ...currentState.worker, changedPaths: ["other.ts"] },
            returnedAt: 17,
          },
          updatedAt: 17,
        }),
      ).toThrow(RoundOperationConflictError);
    });

    it("rejects a stale CAS and advances the revision exactly once", () => {
      const store = new RoundOperationStore(tempStoreDir());
      const claimed = store.claimIfIdle(operation({ operationId: "cas" }));
      const attemptedMutation = {
        state: { phase: "workspace-preparing", workspace: workspaceAttempt },
        updatedAt: 2,
        workOrderPrompt: "replace the frozen work order",
        gatePlan: { kind: "absent" },
      } satisfies RoundOperationTransition & {
        workOrderPrompt: string;
        gatePlan: { kind: "absent" };
      };
      const advanced = store.compareAndSwap(expectation(claimed), attemptedMutation);

      expect(() =>
        store.compareAndSwap(expectation(claimed), {
          state: { phase: "workspace-preparing", workspace: workspaceAttempt },
          updatedAt: 2,
        }),
      ).toThrow(RoundOperationConflictError);
      expect(advanced.revision).toBe(1);
      expect(advanced.workOrderPrompt).toBe(claimed.workOrderPrompt);
      expect(advanced.gatePlan).toEqual(claimed.gatePlan);
      expect(store.read(claimed.sessionId)).toEqual(advanced);
    });

    it("rejects skipped phases and mutations to carried receipts", () => {
      const store = new RoundOperationStore(tempStoreDir());
      const claimed = store.claimIfIdle(operation({ operationId: "transitions" }));
      expect(() =>
        store.compareAndSwap(expectation(claimed), {
          state: {
            phase: "worker-running",
            workspace,
            worker: { executionId: "worker-1", startedAt: 3 },
          },
          updatedAt: 3,
        }),
      ).toThrow(RoundOperationConflictError);

      const prepared = advanceToPrepared(store, claimed);
      expect(() =>
        store.compareAndSwap(expectation(prepared), {
          state: {
            phase: "worker-running",
            workspace: { ...workspace, sourceHead: "rewritten" },
            worker: { executionId: "worker-1", startedAt: 3 },
          },
          updatedAt: 3,
        }),
      ).toThrow(RoundOperationConflictError);
    });

    it("allows only the exact durable checkpoint out of a failed operation", () => {
      const store = new RoundOperationStore(tempStoreDir());
      const failed = failDuringPreparation(store, {
        operationId: "failed-retry",
        sessionId: "failed-retry",
      });

      expect(() =>
        store.compareAndSwap(expectation(failed), {
          state: {
            phase: "workspace-preparing",
            workspace: { ...workspaceAttempt, worktreePath: "/different-worktree" },
          },
          updatedAt: 4,
        }),
      ).toThrow(RoundOperationConflictError);

      const retrying = store.compareAndSwap(expectation(failed), {
        state: { phase: "workspace-preparing", workspace: workspaceAttempt },
        updatedAt: 4,
      });

      expect(retrying.state).toEqual({
        phase: "workspace-preparing",
        workspace: workspaceAttempt,
      });
    });

    it("rejects a drafted report receipt that rewrites a lens board id", () => {
      const drafting = operation({
        operationId: "draft-board-identity",
        revision: 8,
        state: {
          phase: "report-drafting",
          ...changedRoundEvidence,
          report: reportDraftAttempt,
        },
      });
      if (drafting.state.phase !== "report-drafting") {
        throw new Error("expected report drafting fixture");
      }
      const store = storeWithPersistedOperation(drafting);

      expect(() =>
        store.compareAndSwap(expectation(drafting), {
          state: {
            phase: "report-verifying",
            ...changedRoundEvidence,
            report: {
              ...reportDraftReceipt,
              boardIds: { ...reportDraftReceipt.boardIds, design: "rewritten-design" },
            },
            verification: verificationAttempt,
          },
          updatedAt: 15,
        }),
      ).toThrow(RoundOperationConflictError);
    });

    it("allows only an append-only report handoff epoch within report drafting", () => {
      const drafting = operation({
        operationId: "durable-report-handoff",
        revision: 8,
        state: {
          phase: "report-drafting",
          ...changedRoundEvidence,
          report: reportDraftAttempt,
        },
      });
      if (drafting.state.phase !== "report-drafting") {
        throw new Error("expected report drafting fixture");
      }
      const draftingState = drafting.state;
      const store = storeWithPersistedOperation(drafting);
      const handedOff = store.compareAndSwap(expectation(drafting), {
        state: {
          ...draftingState,
          report: {
            ...reportDraftAttempt,
            handoff: reportHandoff(drafting.operationId, drafting.revision + 1),
          },
        },
        updatedAt: 14,
      });
      expect(handedOff.revision).toBe(9);
      if (handedOff.state.phase !== "report-drafting") {
        throw new Error("expected report drafting to remain active");
      }
      expect(handedOff.state.report.handoff?.operationRevision).toBe(handedOff.revision);

      const replayed = store.compareAndSwap(expectation(handedOff), {
        state: {
          ...handedOff.state,
          report: {
            ...handedOff.state.report,
            handoff: reportHandoff(handedOff.operationId, handedOff.revision + 1),
          },
        },
        updatedAt: 15,
      });
      expect(replayed.revision).toBe(10);
      if (replayed.state.phase !== "report-drafting") {
        throw new Error("expected replayed report drafting to remain active");
      }
      const replayedState = replayed.state;
      expect(replayedState.report.handoff?.operationRevision).toBe(replayed.revision);

      const invalidReports: RoundReportDraftAttempt[] = [
        { ...replayedState.report, handoff: undefined },
        {
          ...replayedState.report,
          handoff: {
            ...reportHandoff(replayed.operationId, replayed.revision + 1),
            report: {
              ...reportBoard,
              document: { ...reportBoard.document, title: "Changed after handoff" },
            },
          },
        },
        {
          ...replayedState.report,
          handoff: reportHandoff(replayed.operationId, replayed.revision),
        },
      ];
      for (const report of invalidReports) {
        expect(() =>
          store.compareAndSwap(expectation(replayed), {
            state: { ...replayedState, report },
            updatedAt: 16,
          }),
        ).toThrow(RoundOperationConflictError);
      }
    });

    it("queues a rerun without rewriting the persisted report handoff revision", () => {
      const handedOff = operation({
        operationId: "queued-after-report-handoff",
        revision: 8,
        state: {
          phase: "report-drafting",
          ...changedRoundEvidence,
          report: {
            ...reportDraftAttempt,
            handoff: reportHandoff("queued-after-report-handoff", 8),
          },
        },
      });
      if (handedOff.state.phase !== "report-drafting") {
        throw new Error("expected handed-off report drafting to remain active");
      }
      const handedOffReport = handedOff.state.report;
      const store = storeWithPersistedOperation(handedOff);

      const queued = store.requestRerun(expectation(handedOff));

      expect(queued.revision).toBe(9);
      expect(queued.rerunRequested).toBe(true);
      expect(queued.state.phase).toBe("report-drafting");
      if (queued.state.phase !== "report-drafting") {
        throw new Error("expected queued report drafting to remain active");
      }
      expect(queued.state.report.handoff).toEqual(handedOffReport.handoff);
      expect(queued.state.report.handoff?.operationRevision).toBe(8);
    });

    it("rejects a verified report receipt that rewrites a lens board id", () => {
      const verifying = operation({
        operationId: "verified-board-identity",
        revision: 9,
        state: {
          phase: "report-verifying",
          ...changedRoundEvidence,
          report: reportDraftReceipt,
          verification: verificationAttempt,
        },
      });
      const store = storeWithPersistedOperation(verifying);

      expect(() =>
        store.compareAndSwap(expectation(verifying), {
          state: {
            phase: "completed",
            ...changedRoundEvidence,
            result: {
              kind: "changed",
              report: {
                ...reportDraftReceipt,
                boardIds: { ...reportDraftReceipt.boardIds, design: "rewritten-design" },
                verificationExecutionId: verificationAttempt.executionId,
                verificationStartedAt: verificationAttempt.startedAt,
                verifiedAt: 16,
              },
            },
            completedAt: 16,
          },
          updatedAt: 16,
        }),
      ).toThrow(RoundOperationConflictError);
    });

    it("skips only an absent gate and requires a configured gate to run", () => {
      const absentStore = new RoundOperationStore(tempStoreDir());
      const absentWorker = advanceToWorkerSettled(
        absentStore,
        absentStore.claimIfIdle(
          operation({ operationId: "absent-gate", gatePlan: { kind: "absent" } }),
        ),
      );
      if (absentWorker.state.phase !== "worker-settled") {
        throw new Error("worker fixture did not settle");
      }
      const skipped = absentStore.compareAndSwap(expectation(absentWorker), {
        state: {
          phase: "gate-settled",
          workspace,
          worker: absentWorker.state.worker,
          gate: { outcome: "skipped", reason: "not-configured", settledAt: 5 },
        },
        updatedAt: 5,
      });
      expect(skipped.state.phase).toBe("gate-settled");

      const configuredStore = new RoundOperationStore(tempStoreDir());
      const configuredWorker = advanceToWorkerSettled(
        configuredStore,
        configuredStore.claimIfIdle(operation({ operationId: "configured-gate" })),
      );
      if (configuredWorker.state.phase !== "worker-settled") {
        throw new Error("worker fixture did not settle");
      }
      const configuredWorkerReceipt = configuredWorker.state.worker;
      expect(() =>
        configuredStore.compareAndSwap(expectation(configuredWorker), {
          state: {
            phase: "gate-settled",
            workspace,
            worker: configuredWorkerReceipt,
            gate: { outcome: "skipped", reason: "not-configured", settledAt: 5 },
          },
          updatedAt: 5,
        }),
      ).toThrow(RoundOperationConflictError);
    });

    it("carries unchanged evidence through landing and recording with exact attempt identity", () => {
      const store = new RoundOperationStore(tempStoreDir());
      const workerSettled = advanceToWorkerSettled(
        store,
        store.claimIfIdle(operation({ operationId: "unchanged" })),
      );
      if (workerSettled.state.phase !== "worker-settled") {
        throw new Error("worker fixture did not settle");
      }
      const gateRunning = store.compareAndSwap(expectation(workerSettled), {
        state: {
          phase: "gate-running",
          workspace,
          worker: workerSettled.state.worker,
          gate: { executionId: "gate-1", startedAt: 5 },
        },
        updatedAt: 5,
      });
      if (gateRunning.state.phase !== "gate-running") {
        throw new Error("gate fixture did not start");
      }
      const gateSettled = store.compareAndSwap(expectation(gateRunning), {
        state: {
          phase: "gate-settled",
          workspace,
          worker: gateRunning.state.worker,
          gate: {
            ...gateRunning.state.gate,
            completedAt: 6,
            outcome: "passed",
            exitCode: 0,
          },
        },
        updatedAt: 6,
      });
      if (gateSettled.state.phase !== "gate-settled") {
        throw new Error("gate fixture did not settle");
      }
      const committing = store.compareAndSwap(expectation(gateSettled), {
        state: {
          phase: "committing",
          workspace,
          worker: gateSettled.state.worker,
          gate: gateSettled.state.gate,
          commit: { executionId: "commit-1", baseHead: "abc123", startedAt: 7 },
        },
        updatedAt: 7,
      });
      if (committing.state.phase !== "committing") {
        throw new Error("commit fixture did not start");
      }
      const commitsSettled = store.compareAndSwap(expectation(committing), {
        state: {
          phase: "commits-settled",
          workspace,
          worker: committing.state.worker,
          gate: committing.state.gate,
          commits: {
            ...committing.state.commit,
            from: "abc123",
            to: "abc123",
            count: 0,
            committedAt: 8,
          },
        },
        updatedAt: 8,
      });
      if (commitsSettled.state.phase !== "commits-settled") {
        throw new Error("commit fixture did not settle");
      }
      const settledWorker = commitsSettled.state.worker;
      const settledGate = commitsSettled.state.gate;
      const settledCommits = commitsSettled.state.commits;
      const landingAttempt = {
        effect: "source-landing",
        executionId: "landing-1",
        baselineCommit: settledCommits.from,
        workerHead: settledCommits.to,
        startedAt: 9,
      } satisfies RoundSourceLandingAttempt;
      const landing = store.compareAndSwap(expectation(commitsSettled), {
        state: {
          phase: "source-landing",
          workspace,
          worker: settledWorker,
          gate: settledGate,
          commits: settledCommits,
          landing: landingAttempt,
        },
        updatedAt: 9,
      });
      if (landing.state.phase !== "source-landing") {
        throw new Error("landing fixture did not start");
      }
      expect(() =>
        store.compareAndSwap(expectation(landing), {
          state: {
            phase: "source-landed",
            workspace,
            worker: settledWorker,
            gate: settledGate,
            commits: settledCommits,
            landing: {
              ...landingAttempt,
              executionId: "other-landing",
              outcome: "unchanged",
              landedAt: 10,
            },
          },
          updatedAt: 10,
        }),
      ).toThrow(RoundOperationConflictError);
      const sourceLanded = store.compareAndSwap(expectation(landing), {
        state: {
          phase: "source-landed",
          workspace,
          worker: settledWorker,
          gate: settledGate,
          commits: settledCommits,
          landing: { ...landingAttempt, outcome: "unchanged", landedAt: 10 },
        },
        updatedAt: 10,
      });
      if (sourceLanded.state.phase !== "source-landed") {
        throw new Error("landing fixture did not settle");
      }
      const settledLanding = sourceLanded.state.landing;
      const recordingAttempt = {
        effect: "round-recording",
        executionId: "recording-1",
        startedAt: 11,
      } satisfies RoundRecordingAttempt;
      const recording = store.compareAndSwap(expectation(sourceLanded), {
        state: {
          phase: "round-recording",
          workspace,
          worker: settledWorker,
          gate: settledGate,
          commits: settledCommits,
          landing: settledLanding,
          recording: recordingAttempt,
        },
        updatedAt: 11,
      });
      if (recording.state.phase !== "round-recording") {
        throw new Error("recording fixture did not start");
      }
      expect(() =>
        store.compareAndSwap(expectation(recording), {
          state: {
            phase: "round-recorded",
            workspace,
            worker: settledWorker,
            gate: settledGate,
            commits: settledCommits,
            landing: settledLanding,
            recording: {
              ...recordingAttempt,
              executionId: "other-recording",
              recordedAt: 12,
            },
          },
          updatedAt: 12,
        }),
      ).toThrow(RoundOperationConflictError);
      const recorded = store.compareAndSwap(expectation(recording), {
        state: {
          phase: "round-recorded",
          workspace,
          worker: settledWorker,
          gate: settledGate,
          commits: settledCommits,
          landing: settledLanding,
          recording: { ...recordingAttempt, recordedAt: 12 },
        },
        updatedAt: 12,
      });
      if (recorded.state.phase !== "round-recorded") {
        throw new Error("recording fixture did not settle");
      }
      const settledRecording = recorded.state.recording;

      expect(() =>
        store.compareAndSwap(expectation(recorded), {
          state: {
            phase: "report-drafting",
            workspace,
            worker: settledWorker,
            gate: settledGate,
            commits: settledCommits,
            landing: settledLanding,
            recording: settledRecording,
            report: {
              executionId: "report-1",
              reportBoardId: "board-1",
              generation: "generation-1",
              boardIds: {
                design: "design-1",
                sequence: "sequence-1",
                decisions: "decisions-1",
                flagged: "flagged-1",
                noise: "noise-1",
                report: "board-1",
              },
              startedAt: 13,
            },
          },
          updatedAt: 13,
        }),
      ).toThrow(RoundOperationConflictError);
      expect(
        store.compareAndSwap(expectation(recorded), {
          state: {
            phase: "completed",
            workspace,
            worker: settledWorker,
            gate: settledGate,
            commits: settledCommits,
            landing: settledLanding,
            recording: settledRecording,
            result: { kind: "unchanged" },
            completedAt: 13,
          },
          updatedAt: 13,
        }).state.phase,
      ).toBe("completed");
    });

    it("allows only the next exact transactional landing receipt prefix", () => {
      const unitAId = "a".repeat(64);
      const unitBId = "b".repeat(64);
      const landingAttempt = {
        effect: "source-landing",
        strategy: "exclusive-move-v1",
        executionId: "landing-prefix",
        baselineCommit: changedCommits.from,
        workerHead: changedCommits.to,
        startedAt: 9,
        units: [
          {
            id: unitAId,
            path: "a.txt",
            baseline: {
              kind: "git",
              mode: "100644",
              oid: "a".repeat(40),
              rawSha256: "1".repeat(64),
            },
            target: {
              kind: "git",
              mode: "100644",
              oid: "b".repeat(40),
              rawSha256: "2".repeat(64),
            },
            ...roundSourceLandingArtifactPaths("landing-prefix", unitAId),
          },
          {
            id: unitBId,
            path: "b.txt",
            baseline: { kind: "absent" },
            target: {
              kind: "git",
              mode: "100644",
              oid: "c".repeat(40),
              rawSha256: "3".repeat(64),
            },
            ...roundSourceLandingArtifactPaths("landing-prefix", unitBId),
          },
        ],
        unitReceipts: [],
      } satisfies RoundSourceLandingAttempt;
      const landingState = {
        phase: "source-landing",
        workspace,
        worker: changedWorker,
        gate: changedGate,
        commits: changedCommits,
        landing: landingAttempt,
      } satisfies Extract<RoundOperation["state"], { phase: "source-landing" }>;
      const active = operation({ revision: 10, state: landingState });
      const store = storeWithPersistedOperation(active);
      const firstReceipt = { unitId: unitAId, outcome: "applied", landedAt: 11 } as const;

      expect(() =>
        store.compareAndSwap(expectation(active), {
          state: {
            ...landingState,
            landing: {
              ...landingAttempt,
              unitReceipts: [
                firstReceipt,
                { unitId: unitBId, outcome: "applied", landedAt: 12 } as const,
              ],
            },
          },
          updatedAt: 12,
        }),
      ).toThrow(RoundOperationConflictError);
      expect(() =>
        store.compareAndSwap(expectation(active), {
          state: {
            ...landingState,
            landing: {
              ...landingAttempt,
              units: landingAttempt.units.map((unit) =>
                unit.id === unitBId ? { ...unit, path: "rewritten.txt" } : unit,
              ),
              unitReceipts: [firstReceipt],
            },
          },
          updatedAt: 11,
        }),
      ).toThrow(RoundOperationConflictError);

      const first = store.compareAndSwap(expectation(active), {
        state: {
          ...landingState,
          landing: { ...landingAttempt, unitReceipts: [firstReceipt] },
        },
        updatedAt: 11,
      });
      if (first.state.phase !== "source-landing") throw new Error("prefix did not persist");
      if (first.state.landing.strategy !== "exclusive-move-v1") {
        throw new Error("transactional landing strategy changed");
      }
      expect(first.state.landing.unitReceipts.map(({ unitId }) => unitId)).toEqual([unitAId]);
    });

    it("reloads and settles the exact selected-branch landing after restart", () => {
      const selectedHead = "a".repeat(40);
      const workerHead = "b".repeat(40);
      const branchWorkspace = {
        ...workspace,
        sourceParentHead: selectedHead,
        sourceHead: selectedHead,
      };
      const branchCommits = {
        ...changedCommits,
        baseHead: selectedHead,
        from: selectedHead,
        to: workerHead,
      };
      const landingAttempt = {
        effect: "source-landing",
        strategy: "branch-ref-v1",
        executionId: "landing-selected-branch",
        branch: "feat/test",
        expectedHead: selectedHead,
        baselineCommit: selectedHead,
        workerHead,
        startedAt: 9,
      } satisfies RoundSourceLandingAttempt;
      const active = operation({
        revision: 10,
        state: {
          phase: "source-landing",
          workspace: branchWorkspace,
          worker: changedWorker,
          gate: changedGate,
          commits: branchCommits,
          landing: landingAttempt,
        },
      });
      const dir = tempStoreDir();
      const firstStore = new RoundOperationStore(dir);
      firstStore.close();
      insertStoredEnvelope(dir, {
        sessionId: active.sessionId,
        operationId: active.operationId,
        revision: active.revision,
        envelopeJson: JSON.stringify({
          version: ROUND_OPERATION_STORE_VERSION,
          operation: active,
        }),
      });
      const restarted = new RoundOperationStore(dir);
      const recovered = restarted.read(active.sessionId);
      if (recovered?.state.phase !== "source-landing") {
        throw new Error("selected-branch landing did not survive restart");
      }

      const settled = restarted.compareAndSwap(expectation(recovered), {
        state: {
          ...recovered.state,
          phase: "source-landed",
          landing: { ...landingAttempt, outcome: "applied", landedAt: 10 },
        },
        updatedAt: 10,
      });

      expect(settled.state).toMatchObject({
        phase: "source-landed",
        landing: {
          strategy: "branch-ref-v1",
          branch: "feat/test",
          expectedHead: selectedHead,
          outcome: "applied",
        },
      });
      restarted.close();
    });

    it("claims only an initial claimed operation", () => {
      const store = new RoundOperationStore(tempStoreDir());
      expect(() => store.claimIfIdle(operation({ operationId: "revision", revision: 1 }))).toThrow(
        RoundOperationConflictError,
      );
      expect(() =>
        store.claimIfIdle(operation({ operationId: "rerun", rerunRequested: true })),
      ).toThrow(RoundOperationConflictError);
      expect(() =>
        store.claimIfIdle({
          ...operation({ operationId: "prepared" }),
          state: { phase: "prepared", workspace },
        }),
      ).toThrow(RoundOperationConflictError);
    });

    it("increments rerun once and makes retries converge on the flagged operation", () => {
      const store = new RoundOperationStore(tempStoreDir());
      const claimed = store.claimIfIdle(operation({ operationId: "rerun" }));

      const requested = store.requestRerun(expectation(claimed));
      const retried = store.requestRerun(expectation(claimed));
      const retriedAtCurrentRevision = store.requestRerun(expectation(requested));

      expect(requested.revision).toBe(1);
      expect(requested.rerunRequested).toBe(true);
      expect(requested.updatedAt).toBe(claimed.updatedAt + 1);
      expect(retried).toEqual(requested);
      expect(retriedAtCurrentRevision).toEqual(requested);
    });

    it("does not let a drained operation clear or replace its successor", () => {
      const store = new RoundOperationStore(tempStoreDir());
      const terminal = failDuringPreparation(store, {
        operationId: "old",
        sessionId: "session-drain",
      });
      const successor = operation({ operationId: "new", sessionId: terminal.sessionId });
      expect(() => store.replaceAfterDrain(expectation(terminal), successor)).toThrow(
        RoundOperationConflictError,
      );
      const queued = store.requestRerun(expectation(terminal));
      expect(() =>
        store.replaceAfterDrain(
          expectation(queued),
          operation({ operationId: terminal.operationId, sessionId: terminal.sessionId }),
        ),
      ).toThrow(RoundOperationConflictError);
      expect(() =>
        store.replaceAfterDrain(
          expectation(queued),
          operation({ operationId: "bad-revision", sessionId: terminal.sessionId, revision: 1 }),
        ),
      ).toThrow(RoundOperationConflictError);
      store.replaceAfterDrain(expectation(queued), successor);

      expect(() => store.clear(expectation(queued))).toThrow(RoundOperationConflictError);
      expect(() =>
        store.replaceAfterDrain(
          expectation(queued),
          operation({ operationId: "newer", sessionId: terminal.sessionId }),
        ),
      ).toThrow(RoundOperationConflictError);
      expect(store.read(terminal.sessionId)).toEqual(successor);
    });

    it("clears only the exact terminal revision", () => {
      const store = new RoundOperationStore(tempStoreDir());
      const active = store.claimIfIdle(operation({ operationId: "active" }));
      expect(() => store.clear(expectation(active))).toThrow(RoundOperationConflictError);

      const terminal = failDuringPreparation(store, {
        operationId: "terminal",
        sessionId: "session-terminal",
      });
      expect(() => store.clear({ ...expectation(terminal), revision: 0 })).toThrow(
        RoundOperationConflictError,
      );
      store.clear(expectation(terminal));
      expect(store.read(terminal.sessionId)).toBeUndefined();

      const queued = failDuringPreparation(store, {
        operationId: "queued-terminal",
        sessionId: "session-queued-terminal",
      });
      const withRerun = store.requestRerun(expectation(queued));
      expect(() => store.clear(expectation(withRerun))).toThrow(RoundOperationConflictError);
    });

    it("lists every claimed operation, including a terminal operation awaiting drain", () => {
      const dir = tempStoreDir();
      const store = new RoundOperationStore(dir);
      const active = operation({ operationId: "active", sessionId: "session-b" });
      store.claimIfIdle(active);
      const terminal = failDuringPreparation(store, {
        operationId: "terminal",
        sessionId: "session-a",
      });

      expect(new RoundOperationStore(dir).listActive()).toEqual({
        operations: [terminal, active],
        errors: [],
      });
    });

    it("refuses corrupt data instead of clobbering it during a claim", () => {
      const dir = tempStoreDir();
      const sessionId = "session-corrupt";
      const store = new RoundOperationStore(dir);
      insertStoredEnvelope(dir, {
        sessionId,
        operationId: "broken",
        revision: 0,
        envelopeJson: "{ broken",
      });
      const healthy = store.claimIfIdle(
        operation({ operationId: "healthy", sessionId: "session-healthy" }),
      );

      expect(() => store.read(sessionId)).toThrow(RoundOperationStoreCorruptError);
      expect(() => store.claimIfIdle(operation({ operationId: "replacement", sessionId }))).toThrow(
        RoundOperationStoreCorruptError,
      );
      const listed = store.listActive();
      expect(listed.operations).toEqual([healthy]);
      expect(listed.errors).toHaveLength(1);
      expect(listed.errors[0]?.sessionId).toBe(sessionId);
      expect(listed.errors[0]?.error).toBeInstanceOf(RoundOperationStoreCorruptError);
      expect(() => store.read(sessionId)).toThrow(RoundOperationStoreCorruptError);
    });

    it("refuses an unknown envelope version", () => {
      const dir = tempStoreDir();
      const stored = operation({ operationId: "future", sessionId: "session-future" });
      new RoundOperationStore(dir);
      insertStoredEnvelope(dir, {
        sessionId: stored.sessionId,
        operationId: stored.operationId,
        revision: stored.revision,
        envelopeJson: JSON.stringify({
          version: ROUND_OPERATION_STORE_VERSION + 1,
          operation: stored,
        }),
      });

      expect(() => new RoundOperationStore(dir).read(stored.sessionId)).toThrow(
        RoundOperationStoreCorruptError,
      );
    });

    it("allows exactly one process to CAS the same revision", async () => {
      const dir = tempStoreDir();
      const store = new RoundOperationStore(dir);
      store.claimIfIdle(
        operation({
          operationId: "race",
          sessionId: RACE_SESSION_ID,
          workOrderPrompt: "x".repeat(2_000_000),
        }),
      );

      await Promise.all([runRaceChild(dir, "a"), runRaceChild(dir, "b")]);

      const results = [
        readFileSync(join(dir, "result-a"), "utf8"),
        readFileSync(join(dir, "result-b"), "utf8"),
      ].sort();
      expect(results).toEqual(["conflict", "success"]);
      expect(store.read(RACE_SESSION_ID)?.revision).toBe(1);
    }, 40_000);
  });
}
