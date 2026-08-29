import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import {
  type RoundOperation,
  type RoundWorkspaceAttempt,
  type RoundWorkspaceReceipt,
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

    it("cannot turn an unchanged worker and commit range into a changed report", () => {
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

      expect(() =>
        store.compareAndSwap(expectation(commitsSettled), {
          state: {
            phase: "report-drafting",
            workspace,
            worker: settledWorker,
            gate: settledGate,
            commits: settledCommits,
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
              startedAt: 9,
            },
          },
          updatedAt: 9,
        }),
      ).toThrow(RoundOperationConflictError);
      expect(
        store.compareAndSwap(expectation(commitsSettled), {
          state: {
            phase: "completed",
            workspace,
            worker: settledWorker,
            gate: settledGate,
            commits: settledCommits,
            result: { kind: "unchanged" },
            completedAt: 9,
          },
          updatedAt: 9,
        }).state.phase,
      ).toBe("completed");
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
