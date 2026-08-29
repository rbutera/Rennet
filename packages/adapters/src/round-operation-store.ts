import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  isRoundOperationTerminal,
  type RoundCommitAttempt,
  type RoundGateAttempt,
  type RoundOperation,
  RoundOperationSchema,
  type RoundOperationState,
  type RoundReportDraftAttempt,
  type RoundReportDraftReceipt,
  type RoundReportReceipt,
  type RoundReportVerificationAttempt,
  type RoundWorkerAttempt,
  type RoundWorkspaceAttempt,
} from "@rennet/protocol";
import { z } from "zod";

export const ROUND_OPERATION_STORE_VERSION = 1;
export const ROUND_OPERATION_STORE_FILE_NAME = "round-operations.sqlite";

const roundOperationFileSchema = z.object({
  version: z.number().int(),
  operation: RoundOperationSchema,
});

const roundOperationRowSchema = z.object({
  session_id: z.string(),
  operation_id: z.string(),
  revision: z.number().int().nonnegative(),
  envelope_json: z.string(),
});

export type RoundOperationExpectation = Pick<
  RoundOperation,
  "sessionId" | "operationId" | "revision"
>;

export type RoundOperationTransition = Pick<RoundOperation, "state" | "updatedAt">;

export type RoundOperationListError = {
  sessionId: string;
  error: RoundOperationStoreCorruptError;
};

export type RoundOperationActiveList = {
  operations: RoundOperation[];
  errors: RoundOperationListError[];
};

export class RoundOperationStoreCorruptError extends Error {
  constructor(id: string, detail: string) {
    super(`round operation ${id} is unreadable/corrupt: ${detail}`);
    this.name = "RoundOperationStoreCorruptError";
  }
}

export class RoundOperationConflictError extends Error {
  constructor(expected: RoundOperationExpectation, detail: string) {
    super(
      `round operation ${expected.operationId} at revision ${expected.revision} conflicts: ${detail}`,
    );
    this.name = "RoundOperationConflictError";
  }
}

function decodeOperationRow(rawRow: unknown, sessionId: string): RoundOperation {
  const row = roundOperationRowSchema.safeParse(rawRow);
  if (!row.success) {
    throw new RoundOperationStoreCorruptError(sessionId, "database row schema mismatch");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(row.data.envelope_json);
  } catch {
    throw new RoundOperationStoreCorruptError(sessionId, "malformed JSON");
  }

  const parsed = roundOperationFileSchema.safeParse(decoded);
  if (!parsed.success) {
    throw new RoundOperationStoreCorruptError(sessionId, "schema mismatch");
  }
  if (parsed.data.version !== ROUND_OPERATION_STORE_VERSION) {
    throw new RoundOperationStoreCorruptError(
      sessionId,
      `unknown store version ${parsed.data.version} (expected ${ROUND_OPERATION_STORE_VERSION})`,
    );
  }
  const operation = parsed.data.operation;
  if (
    row.data.session_id !== sessionId ||
    operation.sessionId !== sessionId ||
    row.data.operation_id !== operation.operationId ||
    row.data.revision !== operation.revision
  ) {
    throw new RoundOperationStoreCorruptError(sessionId, "database keys do not match operation");
  }
  return operation;
}

function sameReceipt(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameAttempt(left: RoundWorkerAttempt, right: RoundWorkerAttempt): boolean {
  return left.executionId === right.executionId && left.startedAt === right.startedAt;
}

function sameGateAttempt(left: RoundGateAttempt, right: RoundGateAttempt): boolean {
  return left.executionId === right.executionId && left.startedAt === right.startedAt;
}

function sameCommitAttempt(left: RoundCommitAttempt, right: RoundCommitAttempt): boolean {
  return (
    left.executionId === right.executionId &&
    left.baseHead === right.baseHead &&
    left.startedAt === right.startedAt
  );
}

function sameReportDraftAttempt(
  left: RoundReportDraftAttempt,
  right: RoundReportDraftAttempt,
): boolean {
  return (
    left.executionId === right.executionId &&
    left.reportBoardId === right.reportBoardId &&
    left.generation === right.generation &&
    left.startedAt === right.startedAt
  );
}

function sameReportDraft(left: RoundReportDraftReceipt, right: RoundReportDraftReceipt): boolean {
  return sameReportDraftAttempt(left, right) && left.draftedAt === right.draftedAt;
}

function sameVerificationAttempt(
  left: RoundReportVerificationAttempt,
  right: RoundReportReceipt,
): boolean {
  return (
    left.executionId === right.verificationExecutionId &&
    left.startedAt === right.verificationStartedAt
  );
}

function sameWorkspaceAttempt(left: RoundWorkspaceAttempt, right: RoundWorkspaceAttempt): boolean {
  return (
    left.kind === right.kind &&
    left.worktreePath === right.worktreePath &&
    left.sourceHead === right.sourceHead &&
    left.startedAt === right.startedAt
  );
}

function hasChangedEvidence(
  worker: { diff: string; changedPaths: string[] },
  commits: { count: number; from: string; to: string },
): boolean {
  return (
    worker.diff.trim().length > 0 &&
    worker.changedPaths.length > 0 &&
    commits.count > 0 &&
    commits.from !== commits.to
  );
}

function isLegalTransition(currentOperation: RoundOperation, next: RoundOperationState): boolean {
  const current = currentOperation.state;
  switch (current.phase) {
    case "claimed":
      return next.phase === "workspace-preparing";
    case "workspace-preparing":
      if (next.phase === "prepared") {
        return sameWorkspaceAttempt(current.workspace, next.workspace);
      }
      return (
        next.phase === "failed" &&
        next.failure.at === "preparing" &&
        sameWorkspaceAttempt(current.workspace, next.failure.workspace)
      );
    case "prepared":
      return next.phase === "worker-running" && sameReceipt(current.workspace, next.workspace);
    case "worker-running":
      if (next.phase === "worker-settled") {
        return (
          sameReceipt(current.workspace, next.workspace) && sameAttempt(current.worker, next.worker)
        );
      }
      return (
        next.phase === "failed" &&
        next.failure.at === "worker" &&
        sameReceipt(current.workspace, next.failure.workspace) &&
        sameAttempt(current.worker, next.failure.worker)
      );
    case "worker-settled":
      if (currentOperation.gatePlan.kind === "absent") {
        return (
          next.phase === "gate-settled" &&
          next.gate.outcome === "skipped" &&
          sameReceipt(current.workspace, next.workspace) &&
          sameReceipt(current.worker, next.worker)
        );
      }
      return (
        next.phase === "gate-running" &&
        sameReceipt(current.workspace, next.workspace) &&
        sameReceipt(current.worker, next.worker)
      );
    case "gate-running":
      if (next.phase === "gate-settled" && next.gate.outcome === "passed") {
        return (
          sameReceipt(current.workspace, next.workspace) &&
          sameReceipt(current.worker, next.worker) &&
          sameGateAttempt(current.gate, next.gate)
        );
      }
      return (
        next.phase === "failed" &&
        next.failure.at === "gate" &&
        sameReceipt(current.workspace, next.failure.workspace) &&
        sameReceipt(current.worker, next.failure.worker) &&
        sameGateAttempt(current.gate, next.failure.gate)
      );
    case "gate-settled":
      return (
        next.phase === "committing" &&
        sameReceipt(current.workspace, next.workspace) &&
        sameReceipt(current.worker, next.worker) &&
        sameReceipt(current.gate, next.gate)
      );
    case "committing":
      if (next.phase === "commits-settled") {
        return (
          sameReceipt(current.workspace, next.workspace) &&
          sameReceipt(current.worker, next.worker) &&
          sameReceipt(current.gate, next.gate) &&
          sameCommitAttempt(current.commit, next.commits)
        );
      }
      return (
        next.phase === "failed" &&
        next.failure.at === "committing" &&
        sameReceipt(current.workspace, next.failure.workspace) &&
        sameReceipt(current.worker, next.failure.worker) &&
        sameReceipt(current.gate, next.failure.gate) &&
        sameCommitAttempt(current.commit, next.failure.commit)
      );
    case "commits-settled":
      if (next.phase === "report-drafting") {
        return (
          hasChangedEvidence(current.worker, current.commits) &&
          sameReceipt(current.workspace, next.workspace) &&
          sameReceipt(current.worker, next.worker) &&
          sameReceipt(current.gate, next.gate) &&
          sameReceipt(current.commits, next.commits)
        );
      }
      return (
        next.phase === "completed" &&
        next.result.kind === "unchanged" &&
        sameReceipt(current.workspace, next.workspace) &&
        sameReceipt(current.worker, next.worker) &&
        sameReceipt(current.gate, next.gate) &&
        sameReceipt(current.commits, next.commits)
      );
    case "report-drafting":
      if (next.phase === "report-verifying") {
        return (
          sameReceipt(current.workspace, next.workspace) &&
          sameReceipt(current.worker, next.worker) &&
          sameReceipt(current.gate, next.gate) &&
          sameReceipt(current.commits, next.commits) &&
          sameReportDraftAttempt(current.report, next.report)
        );
      }
      return (
        next.phase === "failed" &&
        next.failure.at === "report-drafting" &&
        sameReceipt(current.workspace, next.failure.workspace) &&
        sameReceipt(current.worker, next.failure.worker) &&
        sameReceipt(current.gate, next.failure.gate) &&
        sameReceipt(current.commits, next.failure.commits) &&
        sameReceipt(current.report, next.failure.report)
      );
    case "report-verifying":
      if (next.phase === "completed" && next.result.kind === "changed") {
        return (
          sameReceipt(current.workspace, next.workspace) &&
          sameReceipt(current.worker, next.worker) &&
          sameReceipt(current.gate, next.gate) &&
          sameReceipt(current.commits, next.commits) &&
          sameReportDraft(current.report, next.result.report) &&
          sameVerificationAttempt(current.verification, next.result.report)
        );
      }
      return (
        next.phase === "failed" &&
        next.failure.at === "report-verifying" &&
        sameReceipt(current.workspace, next.failure.workspace) &&
        sameReceipt(current.worker, next.failure.worker) &&
        sameReceipt(current.gate, next.failure.gate) &&
        sameReceipt(current.commits, next.failure.commits) &&
        sameReceipt(current.report, next.failure.report) &&
        sameReceipt(current.verification, next.failure.verification)
      );
    case "completed":
    case "failed":
      return false;
  }
}

function assertInitialOperation(operation: RoundOperation): void {
  if (operation.revision !== 0 || operation.rerunRequested || operation.state.phase !== "claimed") {
    throw new RoundOperationConflictError(
      {
        sessionId: operation.sessionId,
        operationId: operation.operationId,
        revision: operation.revision,
      },
      "new operation must be claimed at revision 0 without a rerun request",
    );
  }
}

export function defaultRoundOperationStoreDir(): string {
  return join(homedir(), ".rennet", "round-operations");
}

/**
 * One durable operation per session. A terminal operation remains active until its
 * drain is durably cleared or replaced, so restart recovery can finish that drain.
 */
export class RoundOperationStore {
  private readonly database: DatabaseSync;

  constructor(dir: string = defaultRoundOperationStoreDir()) {
    mkdirSync(dir, { recursive: true });
    this.database = new DatabaseSync(join(dir, ROUND_OPERATION_STORE_FILE_NAME));
    this.database.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS round_operations (
        session_id TEXT PRIMARY KEY,
        operation_id TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision >= 0),
        envelope_json TEXT NOT NULL
      ) STRICT;
    `);
  }

  read(sessionId: string): RoundOperation | undefined {
    const row = this.database
      .prepare(
        `SELECT session_id, operation_id, revision, envelope_json
         FROM round_operations
         WHERE session_id = ?`,
      )
      .get(sessionId);
    return row === undefined ? undefined : decodeOperationRow(row, sessionId);
  }

  listActive(): RoundOperationActiveList {
    const operations: RoundOperation[] = [];
    const errors: RoundOperationListError[] = [];
    const rows = this.database
      .prepare(
        `SELECT session_id, operation_id, revision, envelope_json
         FROM round_operations
         ORDER BY session_id`,
      )
      .all();

    for (const row of rows) {
      const sessionId = typeof row.session_id === "string" ? row.session_id : "unknown-session-row";
      try {
        operations.push(decodeOperationRow(row, sessionId));
      } catch (error) {
        if (!(error instanceof RoundOperationStoreCorruptError)) throw error;
        errors.push({ sessionId, error });
      }
    }
    return { operations, errors };
  }

  claimIfIdle(operation: RoundOperation): RoundOperation {
    const validated = RoundOperationSchema.parse(operation);
    assertInitialOperation(validated);
    return this.transaction(() => {
      const active = this.read(validated.sessionId);
      if (active !== undefined) return active;
      return this.write(validated);
    });
  }

  compareAndSwap(
    expected: RoundOperationExpectation,
    next: RoundOperationTransition,
  ): RoundOperation {
    return this.transaction(() => {
      const current = this.requireExact(expected);
      const parsedCandidate = RoundOperationSchema.safeParse({
        ...current,
        state: next.state,
        updatedAt: next.updatedAt,
        revision: current.revision + 1,
      });
      if (!parsedCandidate.success) {
        throw new RoundOperationConflictError(expected, "next state fails protocol validation");
      }
      const candidate = parsedCandidate.data;
      if (candidate.updatedAt < current.updatedAt) {
        throw new RoundOperationConflictError(expected, "updatedAt moved backwards");
      }
      if (!isLegalTransition(current, candidate.state)) {
        throw new RoundOperationConflictError(
          expected,
          `illegal ${current.state.phase} -> ${candidate.state.phase} transition`,
        );
      }
      return this.write(candidate);
    });
  }

  requestRerun(expected: RoundOperationExpectation): RoundOperation {
    return this.transaction(() => {
      const current = this.requireIdentity(expected);
      if (current.rerunRequested) return current;
      if (current.revision !== expected.revision) {
        throw new RoundOperationConflictError(expected, `active revision is ${current.revision}`);
      }
      return this.write({
        ...current,
        revision: current.revision + 1,
        rerunRequested: true,
        updatedAt: current.updatedAt + 1,
      });
    });
  }

  replaceAfterDrain(
    expectedTerminal: RoundOperationExpectation,
    nextOperation: RoundOperation,
  ): RoundOperation {
    const validated = RoundOperationSchema.parse(nextOperation);
    assertInitialOperation(validated);
    if (validated.sessionId !== expectedTerminal.sessionId) {
      throw new RoundOperationConflictError(
        expectedTerminal,
        "replacement belongs to a different session",
      );
    }
    return this.transaction(() => {
      const current = this.requireExact(expectedTerminal);
      if (!isRoundOperationTerminal(current)) {
        throw new RoundOperationConflictError(expectedTerminal, "active operation is not terminal");
      }
      if (!current.rerunRequested) {
        throw new RoundOperationConflictError(
          expectedTerminal,
          "terminal operation has no rerun request to replace",
        );
      }
      if (validated.operationId === current.operationId) {
        throw new RoundOperationConflictError(
          expectedTerminal,
          "replacement must have a distinct operation id",
        );
      }
      return this.write(validated);
    });
  }

  clear(expectedTerminal: RoundOperationExpectation): void {
    this.transaction(() => {
      const current = this.requireExact(expectedTerminal);
      if (!isRoundOperationTerminal(current)) {
        throw new RoundOperationConflictError(expectedTerminal, "active operation is not terminal");
      }
      if (current.rerunRequested) {
        throw new RoundOperationConflictError(
          expectedTerminal,
          "terminal operation has a queued rerun",
        );
      }
      this.database
        .prepare(
          `DELETE FROM round_operations
           WHERE session_id = ? AND operation_id = ? AND revision = ?`,
        )
        .run(expectedTerminal.sessionId, expectedTerminal.operationId, expectedTerminal.revision);
    });
  }

  private write(operation: RoundOperation): RoundOperation {
    const envelope = roundOperationFileSchema.parse({
      version: ROUND_OPERATION_STORE_VERSION,
      operation,
    });
    this.database
      .prepare(
        `INSERT INTO round_operations (session_id, operation_id, revision, envelope_json)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           operation_id = excluded.operation_id,
           revision = excluded.revision,
           envelope_json = excluded.envelope_json`,
      )
      .run(
        operation.sessionId,
        operation.operationId,
        operation.revision,
        JSON.stringify(envelope),
      );
    return envelope.operation;
  }

  private transaction<T>(action: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = action();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      if (this.database.isTransaction) this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private requireIdentity(expected: RoundOperationExpectation): RoundOperation {
    const current = this.read(expected.sessionId);
    if (current === undefined) {
      throw new RoundOperationConflictError(expected, "no active operation");
    }
    if (current.operationId !== expected.operationId) {
      throw new RoundOperationConflictError(expected, `active operation is ${current.operationId}`);
    }
    return current;
  }

  private requireExact(expected: RoundOperationExpectation): RoundOperation {
    const current = this.requireIdentity(expected);
    if (current.revision !== expected.revision) {
      throw new RoundOperationConflictError(expected, `active revision is ${current.revision}`);
    }
    return current;
  }
}
