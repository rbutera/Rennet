import {
  RoundOperationConflictError,
  type RoundOperationExpectation,
  type RoundOperationStore,
} from "@rennet/adapters";
import {
  isRoundOperationTerminal,
  type RoundCommitAttempt,
  type RoundCommitReceipt,
  type RoundOperation,
  type RoundOperationFailure,
  RoundOperationSchema,
  type RoundOperationState,
  type RoundRecordingAttempt,
  type RoundRecordingReceipt,
  type RoundReportBoard,
  type RoundReportDraftAttempt,
  type RoundReportDraftReceipt,
  type RoundReportHandoff,
  type RoundReportReceipt,
  type RoundReportVerificationAttempt,
  type RoundWorkerAttempt,
  type RoundWorkerReceipt,
  type RoundWorkspaceReceipt,
} from "@rennet/protocol";

export interface RoundExecutionEffectInput<TAttempt> {
  readonly operation: RoundOperation;
  readonly attempt: TAttempt;
}

export interface RoundReportVerificationInput
  extends RoundExecutionEffectInput<RoundReportVerificationAttempt> {
  readonly report: RoundReportDraftReceipt;
}

export interface RoundReportDraftInput extends RoundExecutionEffectInput<RoundReportDraftAttempt> {
  /** Persist the already-verified early report before any lens work can fail. */
  readonly recordReportHandoff: (input: {
    readonly reportBoardId: string;
    readonly generation: string;
    readonly report: RoundReportBoard;
  }) => RoundReportHandoff;
}

export type RoundTerminalDrainDecision =
  | { readonly kind: "retain" }
  | { readonly kind: "return"; readonly returnedAt: number }
  | { readonly kind: "clear" }
  | { readonly kind: "clear-queued" }
  | { readonly kind: "replace"; readonly operation: RoundOperation };

/** Effect ports are deliberately receipt-shaped. The coordinator persists each attempt before
 * invoking its effect; implementations make the effect idempotent by the persisted execution id. */
export interface RoundExecutionPorts {
  /**
   * Resolve the session's BOUND workspace and the head the round starts from. No worktree
   * is created — the root already exists and the session bound it — so this is one
   * side-effect-free read, and there is no attempt/receipt split to survive a crash in.
   */
  readonly planWorkspace: (operation: RoundOperation) => Promise<RoundWorkspaceReceipt>;
  readonly planWorker: (operation: RoundOperation) => RoundWorkerAttempt;
  readonly runWorker: (
    input: RoundExecutionEffectInput<RoundWorkerAttempt>,
  ) => Promise<RoundWorkerReceipt>;
  readonly observeWorker?: (
    input: RoundExecutionEffectInput<RoundWorkerAttempt>,
  ) => Promise<RoundWorkerReceipt>;
  /** The workspace's current head, for naming what a failed attempt already committed. */
  readonly observeCommits?: (workspace: RoundWorkspaceReceipt) => Promise<string>;
  readonly planCommit: (operation: RoundOperation) => RoundCommitAttempt;
  readonly settleCommits: (
    input: RoundExecutionEffectInput<RoundCommitAttempt>,
  ) => Promise<RoundCommitReceipt>;
  readonly planRoundRecording: (operation: RoundOperation) => RoundRecordingAttempt;
  readonly recordRound: (
    input: RoundExecutionEffectInput<RoundRecordingAttempt>,
  ) => Promise<RoundRecordingReceipt>;
  readonly prepareReport: (operation: RoundOperation) => RoundReportDraftAttempt;
  readonly draftReport: (input: RoundReportDraftInput) => Promise<RoundReportDraftReceipt>;
  readonly planReportVerification: (operation: RoundOperation) => RoundReportVerificationAttempt;
  readonly verifyReport: (input: RoundReportVerificationInput) => Promise<RoundReportReceipt>;
  /** Receives only values returned by a successful durable store mutation. */
  readonly publish: (operation: RoundOperation) => void;
  /** Runs cleanup while the terminal row is still readable, then chooses its durable drain. */
  readonly drainTerminal: (input: {
    readonly operation: RoundOperation;
  }) => Promise<RoundTerminalDrainDecision>;
}

export interface RoundExecutionCoordinator {
  /** Claim and drive an operation. Same-dispatch calls share the exact promise; a distinct
   * dispatch only sets the durable rerun bit until the current terminal operation drains. */
  submit(operation: RoundOperation): Promise<RoundOperation>;
  /** Resume one already-claimed durable operation, including a terminal waiting to drain. */
  resume(sessionId: string): Promise<RoundOperation | undefined>;
  /** Retry a failed operation from its last durable checkpoint. */
  retry(sessionId: string): Promise<RoundOperation | undefined>;
  /** Resume every durable operation from its first unsettled phase. */
  recover(): Promise<readonly RoundOperation[]>;
}

export interface RoundExecutionCoordinatorOptions {
  readonly store: RoundOperationStore;
  readonly ports: RoundExecutionPorts;
  readonly now?: () => number;
}

type PersistResult = {
  readonly operation: RoundOperation;
  readonly wrote: boolean;
};

function expectation(operation: RoundOperation): RoundOperationExpectation {
  return {
    sessionId: operation.sessionId,
    operationId: operation.operationId,
    revision: operation.revision,
  };
}

function sameState(left: RoundOperationState, right: RoundOperationState): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameReportHandoffContent(
  handoff: RoundReportHandoff,
  input: {
    readonly reportBoardId: string;
    readonly generation: string;
    readonly report: RoundReportBoard;
  },
): boolean {
  return (
    handoff.reportBoardId === input.reportBoardId &&
    handoff.generation === input.generation &&
    JSON.stringify(handoff.report) === JSON.stringify(input.report)
  );
}

function canColdRetryRepositoryAccessFailure(operation: RoundOperation): boolean {
  return (
    operation.state.phase === "failed" &&
    operation.state.failure.at === "report-drafting" &&
    operation.state.failure.reason === "Repository access was not granted" &&
    operation.state.failure.report.handoff !== undefined
  );
}

function errorReason(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) return error.message;
  return "round effect failed without an error message";
}

function workerFailureReason(receipt: Extract<RoundWorkerReceipt, { outcome: "failed" }>): string {
  const termination = receipt.termination;
  switch (termination.kind) {
    case "exit":
      return `worker exited with code ${termination.exitCode}`;
    case "signal":
      return `worker stopped by signal ${termination.signal}`;
    case "error":
      return termination.reason;
  }
}

export type RoundRetryMode = "round" | "regeneration";

export function roundRetryMode(failure: RoundOperationFailure): RoundRetryMode {
  switch (failure.at) {
    case "round-recording":
    case "report-drafting":
    case "report-verifying":
      return "regeneration";
    case "preparing":
    case "worker":
    case "committing":
      return "round";
  }
}

function retryState(failure: RoundOperationFailure): RoundOperationState {
  switch (failure.at) {
    case "preparing":
      return { phase: "claimed" };
    case "worker":
      return { phase: "prepared", workspace: failure.workspace };
    case "committing":
      return {
        phase: "committing",
        workspace: failure.workspace,
        worker: failure.worker,
        commit: failure.commit,
      };
    case "round-recording":
      return {
        phase: "round-recording",
        workspace: failure.workspace,
        worker: failure.worker,
        commits: failure.commits,
        recording: failure.recording,
      };
    case "report-drafting":
      return {
        phase: "report-drafting",
        workspace: failure.workspace,
        worker: failure.worker,
        commits: failure.commits,
        recording: failure.recording,
        report: failure.report,
      };
    case "report-verifying":
      return {
        phase: "report-verifying",
        workspace: failure.workspace,
        worker: failure.worker,
        commits: failure.commits,
        recording: failure.recording,
        report: failure.report,
        verification: failure.verification,
      };
  }
}

function hasWorkerChanges(worker: Extract<RoundWorkerReceipt, { outcome: "completed" }>): boolean {
  return worker.diff.trim().length > 0 && worker.changedPaths.length > 0;
}

function hasCommitChanges(commits: RoundCommitReceipt): boolean {
  return commits.count > 0 && commits.from !== commits.to;
}

function hasPartialWorkerEvidence(
  worker: Extract<RoundWorkerReceipt, { outcome: "completed" }>,
): boolean {
  return worker.diff.trim().length > 0 !== worker.changedPaths.length > 0;
}

function hasPartialCommitEvidence(commits: RoundCommitReceipt): boolean {
  return commits.count > 0 !== (commits.from !== commits.to);
}

/** Why the worker's diff and the observed commit range cannot both be true. */
function uncommittedWorkReason(
  worker: Extract<RoundWorkerReceipt, { outcome: "completed" }>,
  commits: RoundCommitReceipt,
): string {
  if (hasWorkerChanges(worker) && !hasCommitChanges(commits)) {
    const count = worker.changedPaths.length;
    return `the turn changed ${count} file${count === 1 ? "" : "s"} but left no commit on ${commits.from}; a round's commits are its result and nothing stages them for you`;
  }
  if (!hasWorkerChanges(worker) && hasCommitChanges(commits)) {
    return `the turn reported no changes but ${commits.from}..${commits.to} carries ${commits.count} commit${commits.count === 1 ? "" : "s"}`;
  }
  return "worker diff and observed commit range disagree";
}

class DurableRoundExecutionCoordinator implements RoundExecutionCoordinator {
  private readonly inFlight = new Map<string, Promise<RoundOperation>>();
  private readonly now: () => number;

  constructor(private readonly options: RoundExecutionCoordinatorOptions) {
    this.now = options.now ?? Date.now;
  }

  submit(initial: RoundOperation): Promise<RoundOperation> {
    const validated = RoundOperationSchema.parse(initial);
    let active = this.options.store.claimOrReplaceReturned(validated);
    const running = this.inFlight.get(active.sessionId);

    if (isRoundOperationTerminal(active)) {
      if (running !== undefined) {
        this.requestRerun(active);
        return running;
      }
      if (!active.rerunRequested) {
        return this.drainBeforeFreshSubmit(active, validated);
      }
    }

    if (active.dispatchId !== validated.dispatchId) {
      active = this.requestRerun(active);
      if (running !== undefined) return running;
      return this.start(active);
    }

    if (running !== undefined) return running;
    if (active.revision === 0 && active.state.phase === "claimed") {
      this.options.ports.publish(active);
    }
    return this.start(active);
  }

  resume(sessionId: string): Promise<RoundOperation | undefined> {
    const active = this.options.store.read(sessionId);
    if (active === undefined) return Promise.resolve(undefined);
    return this.start(active);
  }

  retry(sessionId: string): Promise<RoundOperation | undefined> {
    const active = this.options.store.read(sessionId);
    if (active === undefined) return Promise.resolve(undefined);
    if (active.state.phase !== "failed") return this.start(active);

    const retrying = this.retryFailed(active);
    const running = this.inFlight.get(sessionId);
    if (running === undefined) return this.start(retrying);

    const continueAfterRunning = (): Promise<RoundOperation | undefined> => {
      const latest = this.options.store.read(sessionId);
      if (
        latest === undefined ||
        latest.operationId !== retrying.operationId ||
        isRoundOperationTerminal(latest)
      ) {
        return Promise.resolve(latest);
      }
      return this.start(latest);
    };
    return running.then(continueAfterRunning, continueAfterRunning);
  }

  /** A retained terminal may be waiting only because its last drain failed. Re-run the
   * idempotent terminal effects before replacing it, so a fresh dispatch cannot erase an
   * unsettled transcript/cleanup receipt. */
  private async drainBeforeFreshSubmit(
    terminal: RoundOperation,
    validated: RoundOperation,
  ): Promise<RoundOperation> {
    await this.start(terminal);
    const latest = this.options.store.read(terminal.sessionId);
    if (
      latest !== undefined &&
      latest.operationId === terminal.operationId &&
      isRoundOperationTerminal(latest) &&
      !latest.rerunRequested
    ) {
      this.options.store.clear(expectation(latest));
    }
    return this.submit(validated);
  }

  async recover(): Promise<readonly RoundOperation[]> {
    const { operations, errors } = this.options.store.listActive();
    if (errors.length > 0) {
      throw new AggregateError(
        errors.map(({ error }) => error),
        "one or more durable round operations are corrupt",
      );
    }
    return Promise.all(
      operations.map((operation) => {
        if (canColdRetryRepositoryAccessFailure(operation)) {
          return this.start(this.retryFailed(operation));
        }
        if (operation.state.phase !== "report-drafting") return this.start(operation);
        const handoff = operation.state.report.handoff;
        if (handoff === undefined) return this.start(operation);
        const replay = this.persistReportHandoff(
          operation,
          {
            reportBoardId: handoff.reportBoardId,
            generation: handoff.generation,
            report: handoff.report,
          },
          true,
        );
        return this.start(replay.operation);
      }),
    );
  }

  private retryFailed(operation: RoundOperation): RoundOperation {
    if (operation.state.phase !== "failed") return operation;
    let retrying = this.persist(
      operation,
      retryState(operation.state.failure),
      Math.max(this.now(), operation.updatedAt),
    ).operation;
    if (retrying.state.phase !== "report-drafting" || retrying.state.report.handoff === undefined) {
      return retrying;
    }
    const handoff = retrying.state.report.handoff;
    retrying = this.persistReportHandoff(
      retrying,
      {
        reportBoardId: handoff.reportBoardId,
        generation: handoff.generation,
        report: handoff.report,
      },
      true,
    ).operation;
    return retrying;
  }

  private start(operation: RoundOperation): Promise<RoundOperation> {
    const running = this.inFlight.get(operation.sessionId);
    if (running !== undefined) return running;

    const promise = this.drive(operation).finally(() => {
      if (this.inFlight.get(operation.sessionId) === promise) {
        this.inFlight.delete(operation.sessionId);
      }
    });
    this.inFlight.set(operation.sessionId, promise);
    return promise;
  }

  private requestRerun(operation: RoundOperation): RoundOperation {
    let current = operation;
    for (;;) {
      if (current.rerunRequested) return current;
      try {
        const persisted = this.options.store.requestRerun(expectation(current));
        this.options.ports.publish(persisted);
        return persisted;
      } catch (error) {
        if (!(error instanceof RoundOperationConflictError)) throw error;
        const latest = this.options.store.read(current.sessionId);
        if (latest === undefined) throw error;
        if (latest.operationId !== operation.operationId) return latest;
        current = latest;
      }
    }
  }

  private persist(
    operation: RoundOperation,
    state: RoundOperationState,
    updatedAt: number,
  ): PersistResult {
    let current = operation;
    for (;;) {
      try {
        const persisted = this.options.store.compareAndSwap(expectation(current), {
          state,
          updatedAt: Math.max(current.updatedAt, updatedAt),
        });
        this.options.ports.publish(persisted);
        return { operation: persisted, wrote: true };
      } catch (error) {
        if (!(error instanceof RoundOperationConflictError)) throw error;
        const latest = this.options.store.read(current.sessionId);
        if (
          latest === undefined ||
          latest.operationId !== current.operationId ||
          latest.revision === current.revision
        ) {
          throw error;
        }
        if (sameState(latest.state, current.state)) {
          current = latest;
          continue;
        }
        return { operation: latest, wrote: false };
      }
    }
  }

  private fail(
    operation: RoundOperation,
    failure: Extract<RoundOperationState, { phase: "failed" }>["failure"],
  ): RoundOperation {
    return this.persist(operation, { phase: "failed", failure }, failure.failedAt).operation;
  }

  private persistReportHandoff(
    operation: RoundOperation,
    input: {
      readonly reportBoardId: string;
      readonly generation: string;
      readonly report: RoundReportBoard;
    },
    forceNewEpoch = false,
  ): { readonly operation: RoundOperation; readonly handoff: RoundReportHandoff } {
    let current = operation;
    for (;;) {
      if (current.state.phase !== "report-drafting") {
        throw new Error("round report handoff arrived outside its durable drafting phase");
      }
      const existing = current.state.report.handoff;
      if (
        !forceNewEpoch &&
        existing !== undefined &&
        existing.operationRevision === current.revision
      ) {
        if (!sameReportHandoffContent(existing, input)) {
          throw new Error("round report handoff changed within one durable drafting attempt");
        }
        return { operation: current, handoff: existing };
      }
      const handoff: RoundReportHandoff = {
        operationId: current.operationId,
        operationRevision: current.revision + 1,
        ...input,
      };
      try {
        const persisted = this.options.store.compareAndSwap(expectation(current), {
          state: {
            ...current.state,
            report: { ...current.state.report, handoff },
          },
          updatedAt: Math.max(current.updatedAt, this.now()),
        });
        if (persisted.revision !== handoff.operationRevision) {
          throw new Error("round report handoff lost its durable attempt revision");
        }
        this.options.ports.publish(persisted);
        return { operation: persisted, handoff };
      } catch (error) {
        if (!(error instanceof RoundOperationConflictError)) throw error;
        const latest = this.options.store.read(current.sessionId);
        if (
          latest === undefined ||
          latest.operationId !== current.operationId ||
          latest.revision === current.revision
        ) {
          throw error;
        }
        current = latest;
      }
    }
  }

  /**
   * A failed worker's retry re-runs from the SAME `sourceHead`, so anything the failed
   * attempt already committed is still in the range the retry observes and would be
   * counted as the retry's work. The reason names that range, because it is the reviewer's
   * to resolve — Rennet does not rewrite their branch.
   */
  private async priorCommitNote(
    operation: RoundOperation,
    receipt: Extract<RoundWorkerReceipt, { outcome: "failed" }>,
  ): Promise<string> {
    if (operation.state.phase !== "worker-running") return "";
    if (receipt.changedPaths.length === 0 && receipt.diff.trim().length === 0) return "";
    const head = await this.options.ports
      .observeCommits?.(operation.state.workspace)
      .catch(() => undefined);
    if (head === undefined || head === operation.state.workspace.sourceHead) return "";
    return `. This attempt already left commits on ${operation.state.workspace.sourceHead}..${head}; a retry runs from the same base and will count them as its own, so inspect or reset them first`;
  }

  private async runWorker(
    operation: RoundOperation,
    attempt: RoundWorkerAttempt,
    effect: RoundExecutionPorts["runWorker"] | NonNullable<RoundExecutionPorts["observeWorker"]>,
  ): Promise<RoundOperation> {
    if (operation.state.phase !== "worker-running") return operation;
    let receipt: RoundWorkerReceipt;
    try {
      receipt = await effect({ operation, attempt });
    } catch (error) {
      return this.fail(operation, {
        at: "worker",
        reason: errorReason(error),
        failedAt: Math.max(this.now(), operation.updatedAt),
        workspace: operation.state.workspace,
        worker: attempt,
      });
    }
    if (receipt.outcome === "failed") {
      return this.fail(operation, {
        at: "worker",
        reason: `${workerFailureReason(receipt)}${await this.priorCommitNote(operation, receipt)}`,
        failedAt: Math.max(this.now(), receipt.completedAt),
        workspace: operation.state.workspace,
        worker: receipt,
      });
    }
    return this.persist(
      operation,
      {
        phase: "worker-settled",
        workspace: operation.state.workspace,
        worker: receipt,
      },
      receipt.completedAt,
    ).operation;
  }

  private async drain(operation: RoundOperation): Promise<RoundOperation | undefined> {
    let terminal = operation;
    for (;;) {
      if (!isRoundOperationTerminal(terminal)) return terminal;
      const decision = await this.options.ports.drainTerminal({ operation: terminal });
      const latest = this.options.store.read(terminal.sessionId);
      if (latest === undefined) return undefined;
      if (latest.operationId !== terminal.operationId) return latest;
      if (!isRoundOperationTerminal(latest)) return latest;
      if (latest.revision !== terminal.revision) {
        terminal = latest;
        continue;
      }
      if (latest.rerunRequested) {
        if (decision.kind === "clear-queued") {
          this.options.store.clearAfterDrain(expectation(latest));
          return undefined;
        }
        if (decision.kind !== "replace") {
          throw new Error("terminal round has a queued rerun but its drain did not replace it");
        }
        const replacement = this.options.store.replaceAfterDrain(
          expectation(latest),
          decision.operation,
        );
        this.options.ports.publish(replacement);
        return replacement;
      }
      if (decision.kind === "return") {
        if (latest.state.phase !== "completed") {
          throw new Error("only a completed round can record its Return handback");
        }
        let returned: RoundOperation;
        try {
          returned = this.options.store.compareAndSwap(expectation(latest), {
            state: { ...latest.state, returnedAt: decision.returnedAt },
            updatedAt: Math.max(latest.updatedAt, decision.returnedAt),
          });
        } catch (error) {
          if (!(error instanceof RoundOperationConflictError)) throw error;
          const conflicted = this.options.store.read(latest.sessionId);
          if (conflicted === undefined) return undefined;
          if (conflicted.operationId !== latest.operationId) return conflicted;
          terminal = conflicted;
          continue;
        }
        this.options.ports.publish(returned);
        return undefined;
      }
      if (decision.kind === "retain") return undefined;
      if (decision.kind === "clear-queued") {
        throw new Error("terminal round without a queued rerun cannot use a queued drain");
      }
      if (decision.kind !== "clear") {
        throw new Error("terminal round without a queued rerun cannot be replaced");
      }
      this.options.store.clear(expectation(latest));
      return undefined;
    }
  }

  private async drive(start: RoundOperation): Promise<RoundOperation> {
    let operation = start;
    let lastTerminal: RoundOperation | undefined;

    for (;;) {
      const state = operation.state;
      switch (state.phase) {
        case "claimed": {
          try {
            const workspace = await this.options.ports.planWorkspace(operation);
            operation = this.persist(
              operation,
              { phase: "prepared", workspace },
              workspace.preparedAt,
            ).operation;
          } catch (error) {
            operation = this.fail(operation, {
              at: "preparing",
              reason: errorReason(error),
              failedAt: Math.max(this.now(), operation.updatedAt),
            });
          }
          break;
        }
        case "prepared": {
          const attempt = this.options.ports.planWorker(operation);
          const running = this.persist(
            operation,
            { phase: "worker-running", workspace: state.workspace, worker: attempt },
            attempt.startedAt,
          );
          operation = running.operation;
          if (running.wrote) {
            operation = await this.runWorker(operation, attempt, this.options.ports.runWorker);
          }
          break;
        }
        case "worker-running": {
          const observe = this.options.ports.observeWorker;
          if (observe === undefined) {
            operation = this.fail(operation, {
              at: "worker",
              reason: `worker execution ${state.worker.executionId} was interrupted and cannot be observed`,
              failedAt: Math.max(this.now(), operation.updatedAt),
              workspace: state.workspace,
              worker: state.worker,
            });
          } else {
            operation = await this.runWorker(operation, state.worker, observe);
          }
          break;
        }
        case "worker-settled": {
          const attempt = this.options.ports.planCommit(operation);
          operation = this.persist(
            operation,
            {
              phase: "committing",
              workspace: state.workspace,
              worker: state.worker,
              commit: attempt,
            },
            attempt.startedAt,
          ).operation;
          break;
        }
        case "committing": {
          let receipt: RoundCommitReceipt;
          try {
            receipt = await this.options.ports.settleCommits({
              operation,
              attempt: state.commit,
            });
          } catch (error) {
            operation = this.fail(operation, {
              at: "committing",
              reason: errorReason(error),
              failedAt: Math.max(this.now(), operation.updatedAt),
              workspace: state.workspace,
              worker: state.worker,
              commit: state.commit,
            });
            break;
          }
          const workerChanged = hasWorkerChanges(state.worker);
          const commitsChanged = hasCommitChanges(receipt);
          if (
            hasPartialWorkerEvidence(state.worker) ||
            hasPartialCommitEvidence(receipt) ||
            workerChanged !== commitsChanged
          ) {
            operation = this.fail(operation, {
              at: "committing",
              // The overwhelmingly common shape deserves its own sentence: the turn edited
              // and did not commit. Nothing stages on the reviewer's behalf, so there is
              // no round — and "disagree" told the reader nothing about which side was
              // empty or what to do about it.
              reason: uncommittedWorkReason(state.worker, receipt),
              failedAt: Math.max(this.now(), receipt.committedAt),
              workspace: state.workspace,
              worker: state.worker,
              commit: state.commit,
            });
            break;
          }
          operation = this.persist(
            operation,
            {
              phase: "commits-settled",
              workspace: state.workspace,
              worker: state.worker,
              commits: receipt,
            },
            receipt.committedAt,
          ).operation;
          break;
        }
        case "commits-settled": {
          const attempt = this.options.ports.planRoundRecording(operation);
          operation = this.persist(
            operation,
            {
              phase: "round-recording",
              workspace: state.workspace,
              worker: state.worker,
              commits: state.commits,
              recording: attempt,
            },
            attempt.startedAt,
          ).operation;
          break;
        }
        case "round-recording": {
          try {
            const receipt = await this.options.ports.recordRound({
              operation,
              attempt: state.recording,
            });
            operation = this.persist(
              operation,
              {
                phase: "round-recorded",
                workspace: state.workspace,
                worker: state.worker,
                commits: state.commits,
                recording: receipt,
              },
              receipt.recordedAt,
            ).operation;
          } catch (error) {
            operation = this.fail(operation, {
              at: "round-recording",
              reason: errorReason(error),
              failedAt: Math.max(this.now(), operation.updatedAt),
              workspace: state.workspace,
              worker: state.worker,
              commits: state.commits,
              recording: state.recording,
            });
          }
          break;
        }
        case "round-recorded": {
          if (!hasWorkerChanges(state.worker) && !hasCommitChanges(state.commits)) {
            const completedAt = Math.max(this.now(), operation.updatedAt);
            operation = this.persist(
              operation,
              {
                phase: "completed",
                workspace: state.workspace,
                worker: state.worker,
                commits: state.commits,
                recording: state.recording,
                result: { kind: "unchanged" },
                completedAt,
              },
              completedAt,
            ).operation;
            break;
          }
          const attempt = this.options.ports.prepareReport(operation);
          operation = this.persist(
            operation,
            {
              phase: "report-drafting",
              workspace: state.workspace,
              worker: state.worker,
              commits: state.commits,
              recording: state.recording,
              report: attempt,
            },
            attempt.startedAt,
          ).operation;
          break;
        }
        case "report-drafting": {
          let draftingOperation = operation;
          try {
            const drafted = await this.options.ports.draftReport({
              operation,
              attempt: state.report,
              recordReportHandoff: (input) => {
                const persisted = this.persistReportHandoff(draftingOperation, input);
                draftingOperation = persisted.operation;
                return persisted.handoff;
              },
            });
            if (draftingOperation.state.phase !== "report-drafting") {
              throw new Error("round report drafting changed phase before it settled");
            }
            const durableHandoff = draftingOperation.state.report.handoff;
            const report =
              durableHandoff === undefined ? drafted : { ...drafted, handoff: durableHandoff };
            const verification = this.options.ports.planReportVerification(draftingOperation);
            operation = this.persist(
              draftingOperation,
              {
                phase: "report-verifying",
                workspace: draftingOperation.state.workspace,
                worker: draftingOperation.state.worker,
                commits: draftingOperation.state.commits,
                recording: draftingOperation.state.recording,
                report,
                verification,
              },
              Math.max(report.draftedAt, verification.startedAt),
            ).operation;
          } catch (error) {
            if (draftingOperation.state.phase !== "report-drafting") throw error;
            operation = this.fail(draftingOperation, {
              at: "report-drafting",
              reason: errorReason(error),
              failedAt: Math.max(this.now(), draftingOperation.updatedAt),
              workspace: draftingOperation.state.workspace,
              worker: draftingOperation.state.worker,
              commits: draftingOperation.state.commits,
              recording: draftingOperation.state.recording,
              report: draftingOperation.state.report,
            });
          }
          break;
        }
        case "report-verifying": {
          try {
            const report = await this.options.ports.verifyReport({
              operation,
              report: state.report,
              attempt: state.verification,
            });
            const completedAt = Math.max(this.now(), report.verifiedAt);
            operation = this.persist(
              operation,
              {
                phase: "completed",
                workspace: state.workspace,
                worker: state.worker,
                commits: state.commits,
                recording: state.recording,
                result: { kind: "changed", report },
                completedAt,
              },
              completedAt,
            ).operation;
          } catch (error) {
            operation = this.fail(operation, {
              at: "report-verifying",
              reason: errorReason(error),
              failedAt: Math.max(this.now(), operation.updatedAt),
              workspace: state.workspace,
              worker: state.worker,
              commits: state.commits,
              recording: state.recording,
              report: state.report,
              verification: state.verification,
            });
          }
          break;
        }
        case "completed":
        case "failed": {
          lastTerminal = operation;
          const next = await this.drain(operation);
          if (next === undefined) return lastTerminal;
          operation = next;
          break;
        }
        default: {
          const exhaustive: never = state;
          throw new Error(`unhandled round operation state: ${JSON.stringify(exhaustive)}`);
        }
      }
    }
  }
}

export function createRoundExecutionCoordinator(
  options: RoundExecutionCoordinatorOptions,
): RoundExecutionCoordinator {
  return new DurableRoundExecutionCoordinator(options);
}
