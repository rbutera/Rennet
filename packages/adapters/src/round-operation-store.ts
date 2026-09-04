import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  isRoundOperationTerminal,
  type RoundCommitAttempt,
  type RoundOperation,
  type RoundOperationFailure,
  RoundOperationSchema,
  type RoundOperationState,
  type RoundRecordingAttempt,
  type RoundReportDraftAttempt,
  type RoundReportDraftReceipt,
  type RoundReportReceipt,
  type RoundReportVerificationAttempt,
  type RoundWorkerAttempt,
} from "@rennet/protocol";
import { z } from "zod";

/**
 * Bumped to 3 by round-worker-thread: the gate phases, the gate receipts and the gate plan
 * are gone, so a version-2 row describes a state machine this build cannot decode or
 * resume. (Version 2 was session-bound-workspace's own bump, for the same reason: the
 * workspace receipt became `bound-root` and the source-landing phases went.) Rows below the
 * current version are LEGACY, not corrupt — see {@link RoundOperationStoreLegacyError}.
 */
export const ROUND_OPERATION_STORE_VERSION = 3;
export const ROUND_OPERATION_STORE_FILE_NAME = "round-operations.sqlite";

const roundOperationFileSchema = z.object({
  version: z.number().int(),
  operation: RoundOperationSchema,
});

/** The version stamp alone, read before the operation it wraps. */
const roundOperationEnvelopeSchema = z.object({ version: z.number().int() });

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

/**
 * A row an OLDER Rennet wrote, told apart from a damaged one.
 *
 * These are different facts and they need different answers. A row that fails the current
 * schema at the current version is damage, and the daemon says so loudly — that is what
 * `RoundOperationStoreCorruptError` is for. A row stamped with a version this build has
 * moved past is just old: its phases and receipts describe a state machine that has been
 * deleted, nothing can resume it, and treating it as corruption wedges the session
 * permanently (`recover()` throws before it reaches any other session, and every later
 * `read` for that session throws forever). So the reader DROPS it, with a logged reason,
 * and the session dispatches fresh.
 */
export class RoundOperationStoreLegacyError extends Error {
  constructor(
    readonly sessionId: string,
    readonly version: number,
  ) {
    super(
      `round operation for session ${sessionId} was written by an older Rennet (store version ${version}, this build reads ${ROUND_OPERATION_STORE_VERSION}); dropping it`,
    );
    this.name = "RoundOperationStoreLegacyError";
  }
}

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

  // The VERSION is read before the operation, so an old row is recognised as old rather
  // than failing the current schema and reading as damage.
  const envelope = roundOperationEnvelopeSchema.safeParse(decoded);
  if (!envelope.success) {
    throw new RoundOperationStoreCorruptError(sessionId, "schema mismatch");
  }
  // STRICTLY older, not merely different: a row from a FUTURE version was written by a
  // newer daemon over the same data dir, and deleting a live round on downgrade is data
  // loss nobody asked for. That stays a refusal.
  if (envelope.data.version < ROUND_OPERATION_STORE_VERSION) {
    throw new RoundOperationStoreLegacyError(sessionId, envelope.data.version);
  }
  if (envelope.data.version !== ROUND_OPERATION_STORE_VERSION) {
    throw new RoundOperationStoreCorruptError(
      sessionId,
      `unknown store version ${envelope.data.version} (expected ${ROUND_OPERATION_STORE_VERSION})`,
    );
  }
  const parsed = roundOperationFileSchema.safeParse(decoded);
  if (!parsed.success) {
    throw new RoundOperationStoreCorruptError(sessionId, "schema mismatch");
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

function sameCommitAttempt(left: RoundCommitAttempt, right: RoundCommitAttempt): boolean {
  return (
    left.executionId === right.executionId &&
    left.baseHead === right.baseHead &&
    left.startedAt === right.startedAt
  );
}

function sameRoundRecordingAttempt(
  left: RoundRecordingAttempt,
  right: RoundRecordingAttempt,
): boolean {
  return (
    left.effect === right.effect &&
    left.executionId === right.executionId &&
    left.startedAt === right.startedAt
  );
}

function sameReportDraftReservation(
  left: RoundReportDraftAttempt,
  right: RoundReportDraftAttempt,
): boolean {
  return (
    left.executionId === right.executionId &&
    left.reportBoardId === right.reportBoardId &&
    left.generation === right.generation &&
    sameReceipt(left.boardIds, right.boardIds) &&
    left.startedAt === right.startedAt
  );
}

function sameReportHandoffContent(
  left: NonNullable<RoundReportDraftAttempt["handoff"]>,
  right: NonNullable<RoundReportDraftAttempt["handoff"]>,
): boolean {
  return (
    left.operationId === right.operationId &&
    left.reportBoardId === right.reportBoardId &&
    left.generation === right.generation &&
    sameReceipt(left.report, right.report)
  );
}

function sameReportDraftAttempt(
  left: RoundReportDraftAttempt,
  right: RoundReportDraftAttempt,
): boolean {
  return sameReportDraftReservation(left, right) && sameReceipt(left.handoff, right.handoff);
}

function extendsReportHandoffEpoch(
  operation: RoundOperation,
  next: RoundReportDraftAttempt,
): boolean {
  if (operation.state.phase !== "report-drafting") return false;
  const current = operation.state.report;
  const nextHandoff = next.handoff;
  if (
    !sameReportDraftReservation(current, next) ||
    nextHandoff === undefined ||
    nextHandoff.operationId !== operation.operationId ||
    nextHandoff.operationRevision !== operation.revision + 1
  ) {
    return false;
  }
  return current.handoff === undefined || sameReportHandoffContent(current.handoff, nextHandoff);
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

function isLegalFailedRetry(failure: RoundOperationFailure, next: RoundOperationState): boolean {
  switch (failure.at) {
    case "preparing":
      return next.phase === "claimed";
    case "worker":
      return next.phase === "prepared" && sameReceipt(failure.workspace, next.workspace);
    case "committing":
      return (
        next.phase === "committing" &&
        sameReceipt(failure.workspace, next.workspace) &&
        sameReceipt(failure.worker, next.worker) &&
        sameCommitAttempt(failure.commit, next.commit)
      );
    case "round-recording":
      return (
        next.phase === "round-recording" &&
        sameReceipt(failure.workspace, next.workspace) &&
        sameReceipt(failure.worker, next.worker) &&
        sameReceipt(failure.commits, next.commits) &&
        sameRoundRecordingAttempt(failure.recording, next.recording)
      );
    case "report-drafting":
      return (
        next.phase === "report-drafting" &&
        sameReceipt(failure.workspace, next.workspace) &&
        sameReceipt(failure.worker, next.worker) &&
        sameReceipt(failure.commits, next.commits) &&
        sameReceipt(failure.recording, next.recording) &&
        sameReportDraftAttempt(failure.report, next.report)
      );
    case "report-verifying":
      return (
        next.phase === "report-verifying" &&
        sameReceipt(failure.workspace, next.workspace) &&
        sameReceipt(failure.worker, next.worker) &&
        sameReceipt(failure.commits, next.commits) &&
        sameReceipt(failure.recording, next.recording) &&
        sameReceipt(failure.report, next.report) &&
        sameReceipt(failure.verification, next.verification)
      );
  }
}

function isLegalTransition(currentOperation: RoundOperation, next: RoundOperationState): boolean {
  const current = currentOperation.state;
  switch (current.phase) {
    case "claimed":
      return (
        next.phase === "prepared" || (next.phase === "failed" && next.failure.at === "preparing")
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
      return (
        next.phase === "committing" &&
        sameReceipt(current.workspace, next.workspace) &&
        sameReceipt(current.worker, next.worker)
      );
    case "committing":
      if (next.phase === "commits-settled") {
        return (
          sameReceipt(current.workspace, next.workspace) &&
          sameReceipt(current.worker, next.worker) &&
          sameCommitAttempt(current.commit, next.commits)
        );
      }
      return (
        next.phase === "failed" &&
        next.failure.at === "committing" &&
        sameReceipt(current.workspace, next.failure.workspace) &&
        sameReceipt(current.worker, next.failure.worker) &&
        sameCommitAttempt(current.commit, next.failure.commit)
      );
    case "commits-settled":
      return (
        next.phase === "round-recording" &&
        sameReceipt(current.workspace, next.workspace) &&
        sameReceipt(current.worker, next.worker) &&
        sameReceipt(current.commits, next.commits)
      );
    case "round-recording":
      if (next.phase === "round-recorded") {
        return (
          sameReceipt(current.workspace, next.workspace) &&
          sameReceipt(current.worker, next.worker) &&
          sameReceipt(current.commits, next.commits) &&
          sameRoundRecordingAttempt(current.recording, next.recording)
        );
      }
      return (
        next.phase === "failed" &&
        next.failure.at === "round-recording" &&
        sameReceipt(current.workspace, next.failure.workspace) &&
        sameReceipt(current.worker, next.failure.worker) &&
        sameReceipt(current.commits, next.failure.commits) &&
        sameRoundRecordingAttempt(current.recording, next.failure.recording)
      );
    case "round-recorded":
      if (next.phase === "report-drafting") {
        return (
          hasChangedEvidence(current.worker, current.commits) &&
          sameReceipt(current.workspace, next.workspace) &&
          sameReceipt(current.worker, next.worker) &&
          sameReceipt(current.commits, next.commits) &&
          sameReceipt(current.recording, next.recording)
        );
      }
      return (
        next.phase === "completed" &&
        next.result.kind === "unchanged" &&
        sameReceipt(current.workspace, next.workspace) &&
        sameReceipt(current.worker, next.worker) &&
        sameReceipt(current.commits, next.commits) &&
        sameReceipt(current.recording, next.recording)
      );
    case "report-drafting":
      if (next.phase === "report-drafting") {
        return (
          sameReceipt(current.workspace, next.workspace) &&
          sameReceipt(current.worker, next.worker) &&
          sameReceipt(current.commits, next.commits) &&
          sameReceipt(current.recording, next.recording) &&
          extendsReportHandoffEpoch(currentOperation, next.report)
        );
      }
      if (next.phase === "report-verifying") {
        return (
          sameReceipt(current.workspace, next.workspace) &&
          sameReceipt(current.worker, next.worker) &&
          sameReceipt(current.commits, next.commits) &&
          sameReceipt(current.recording, next.recording) &&
          sameReportDraftAttempt(current.report, next.report)
        );
      }
      return (
        next.phase === "failed" &&
        next.failure.at === "report-drafting" &&
        sameReceipt(current.workspace, next.failure.workspace) &&
        sameReceipt(current.worker, next.failure.worker) &&
        sameReceipt(current.commits, next.failure.commits) &&
        sameReceipt(current.recording, next.failure.recording) &&
        sameReceipt(current.report, next.failure.report)
      );
    case "report-verifying":
      if (next.phase === "completed" && next.result.kind === "changed") {
        return (
          sameReceipt(current.workspace, next.workspace) &&
          sameReceipt(current.worker, next.worker) &&
          sameReceipt(current.commits, next.commits) &&
          sameReceipt(current.recording, next.recording) &&
          sameReportDraft(current.report, next.result.report) &&
          sameVerificationAttempt(current.verification, next.result.report)
        );
      }
      return (
        next.phase === "failed" &&
        next.failure.at === "report-verifying" &&
        sameReceipt(current.workspace, next.failure.workspace) &&
        sameReceipt(current.worker, next.failure.worker) &&
        sameReceipt(current.commits, next.failure.commits) &&
        sameReceipt(current.recording, next.failure.recording) &&
        sameReceipt(current.report, next.failure.report) &&
        sameReceipt(current.verification, next.failure.verification)
      );
    case "completed":
      if (next.phase !== "completed") return false;
      if (current.returnedAt !== undefined || next.returnedAt === undefined) return false;
      return sameReceipt({ ...current, returnedAt: undefined }, { ...next, returnedAt: undefined });
    case "failed":
      return isLegalFailedRetry(current.failure, next);
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

  constructor(
    dir: string = defaultRoundOperationStoreDir(),
    private readonly warn: (message: string) => void = console.warn,
  ) {
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
    if (row === undefined) return undefined;
    try {
      return decodeOperationRow(row, sessionId);
    } catch (error) {
      if (!(error instanceof RoundOperationStoreLegacyError)) throw error;
      this.dropLegacyRow(error);
      return undefined;
    }
  }

  /** Remove a row an older Rennet wrote, once, saying so. Never touches a corrupt row. */
  private dropLegacyRow(error: RoundOperationStoreLegacyError): void {
    this.database.prepare(`DELETE FROM round_operations WHERE session_id = ?`).run(error.sessionId);
    this.warn(`rennet: ${error.message}`);
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
        // A row from an older build is dropped here rather than reported: `recover()`
        // turns this list's errors into an AggregateError and throws BEFORE driving any
        // operation, so one pre-upgrade row would stop every other session recovering.
        if (error instanceof RoundOperationStoreLegacyError) {
          this.dropLegacyRow(error);
          continue;
        }
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

  /** Atomically claim an idle session or replace a completed operation whose Return receipt
   * is durable. A draining completion and a queued rerun remain the active owner. */
  claimOrReplaceReturned(operation: RoundOperation): RoundOperation {
    const validated = RoundOperationSchema.parse(operation);
    assertInitialOperation(validated);
    return this.transaction(() => {
      const active = this.read(validated.sessionId);
      if (active === undefined) return this.write(validated);
      if (
        active.state.phase === "completed" &&
        active.state.returnedAt !== undefined &&
        !active.rerunRequested
      ) {
        if (validated.operationId === active.operationId) {
          throw new RoundOperationConflictError(
            {
              sessionId: active.sessionId,
              operationId: active.operationId,
              revision: active.revision,
            },
            "successor must have a distinct operation id",
          );
        }
        return this.write(validated);
      }
      return active;
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

  /** Clear a terminal row after the coordinator has re-folded the live ask log and found
   * no replacement work. Unlike {@link clear}, a queued rerun is allowed here because the
   * caller has just proven that the queue drained to empty. */
  clearAfterDrain(expectedTerminal: RoundOperationExpectation): void {
    this.transaction(() => {
      const current = this.requireExact(expectedTerminal);
      if (!isRoundOperationTerminal(current)) {
        throw new RoundOperationConflictError(expectedTerminal, "active operation is not terminal");
      }
      this.database
        .prepare(
          `DELETE FROM round_operations
           WHERE session_id = ? AND operation_id = ? AND revision = ?`,
        )
        .run(expectedTerminal.sessionId, expectedTerminal.operationId, expectedTerminal.revision);
    });
  }

  /** Release the SQLite handle during daemon shutdown. */
  close(): void {
    this.database.close();
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
