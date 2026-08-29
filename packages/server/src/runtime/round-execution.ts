import {
  RoundOperationConflictError,
  type RoundOperationExpectation,
  type RoundOperationStore,
} from "@rennet/adapters";
import {
  isRoundOperationTerminal,
  type RoundCommitAttempt,
  type RoundCommitReceipt,
  type RoundGateAttempt,
  type RoundGateReceipt,
  type RoundOperation,
  RoundOperationSchema,
  type RoundOperationState,
  type RoundRecordingAttempt,
  type RoundRecordingReceipt,
  type RoundReportDraftAttempt,
  type RoundReportDraftReceipt,
  type RoundReportReceipt,
  type RoundReportVerificationAttempt,
  type RoundSourceLandingAttempt,
  type RoundSourceLandingReceipt,
  type RoundWorkerAttempt,
  type RoundWorkerReceipt,
  type RoundWorkspaceAttempt,
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

export type RoundTerminalDrainDecision =
  | { readonly kind: "retain" }
  | { readonly kind: "clear" }
  | { readonly kind: "clear-queued" }
  | { readonly kind: "replace"; readonly operation: RoundOperation };

/** Effect ports are deliberately receipt-shaped. The coordinator persists each attempt before
 * invoking its effect; implementations make the effect idempotent by the persisted execution id. */
export interface RoundExecutionPorts {
  readonly planWorkspace: (operation: RoundOperation) => RoundWorkspaceAttempt;
  readonly prepareWorkspace: (
    input: RoundExecutionEffectInput<RoundWorkspaceAttempt>,
  ) => Promise<RoundWorkspaceReceipt>;
  readonly planWorker: (operation: RoundOperation) => RoundWorkerAttempt;
  readonly runWorker: (
    input: RoundExecutionEffectInput<RoundWorkerAttempt>,
  ) => Promise<RoundWorkerReceipt>;
  readonly observeWorker?: (
    input: RoundExecutionEffectInput<RoundWorkerAttempt>,
  ) => Promise<RoundWorkerReceipt>;
  readonly planGate: (operation: RoundOperation) => RoundGateAttempt;
  readonly runGate: (
    input: RoundExecutionEffectInput<RoundGateAttempt>,
  ) => Promise<RoundGateReceipt>;
  readonly observeGate?: (
    input: RoundExecutionEffectInput<RoundGateAttempt>,
  ) => Promise<RoundGateReceipt>;
  readonly planCommit: (operation: RoundOperation) => RoundCommitAttempt;
  readonly settleCommits: (
    input: RoundExecutionEffectInput<RoundCommitAttempt>,
  ) => Promise<RoundCommitReceipt>;
  readonly planSourceLanding: (operation: RoundOperation) => RoundSourceLandingAttempt;
  readonly landSourceChanges: (
    input: RoundExecutionEffectInput<RoundSourceLandingAttempt>,
  ) => Promise<RoundSourceLandingReceipt>;
  readonly planRoundRecording: (operation: RoundOperation) => RoundRecordingAttempt;
  readonly recordRound: (
    input: RoundExecutionEffectInput<RoundRecordingAttempt>,
  ) => Promise<RoundRecordingReceipt>;
  readonly prepareReport: (operation: RoundOperation) => RoundReportDraftAttempt;
  readonly draftReport: (
    input: RoundExecutionEffectInput<RoundReportDraftAttempt>,
  ) => Promise<RoundReportDraftReceipt>;
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

function gateFailureReason(receipt: Extract<RoundGateReceipt, { outcome: "failed" }>): string {
  const termination = receipt.termination;
  switch (termination.kind) {
    case "exit":
      return `gate exited with code ${termination.exitCode}`;
    case "signal":
      return `gate stopped by signal ${termination.signal}`;
    case "error":
      return termination.reason;
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

class DurableRoundExecutionCoordinator implements RoundExecutionCoordinator {
  private readonly inFlight = new Map<string, Promise<RoundOperation>>();
  private readonly now: () => number;

  constructor(private readonly options: RoundExecutionCoordinatorOptions) {
    this.now = options.now ?? Date.now;
  }

  submit(initial: RoundOperation): Promise<RoundOperation> {
    const validated = RoundOperationSchema.parse(initial);
    let active = this.options.store.claimIfIdle(validated);
    const running = this.inFlight.get(active.sessionId);

    if (isRoundOperationTerminal(active)) {
      if (running !== undefined) {
        this.requestRerun(active);
        return running;
      }
      if (!active.rerunRequested) {
        this.options.store.clear(expectation(active));
        active = this.options.store.claimIfIdle(validated);
        if (
          active.operationId === validated.operationId &&
          active.revision === 0 &&
          active.state.phase === "claimed"
        ) {
          this.options.ports.publish(active);
        }
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

  async recover(): Promise<readonly RoundOperation[]> {
    const { operations, errors } = this.options.store.listActive();
    if (errors.length > 0) {
      throw new AggregateError(
        errors.map(({ error }) => error),
        "one or more durable round operations are corrupt",
      );
    }
    return Promise.all(operations.map((operation) => this.start(operation)));
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
        reason: workerFailureReason(receipt),
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

  private async runGate(
    operation: RoundOperation,
    attempt: RoundGateAttempt,
    effect: RoundExecutionPorts["runGate"] | NonNullable<RoundExecutionPorts["observeGate"]>,
  ): Promise<RoundOperation> {
    if (operation.state.phase !== "gate-running") return operation;
    let receipt: RoundGateReceipt;
    try {
      receipt = await effect({ operation, attempt });
    } catch (error) {
      return this.fail(operation, {
        at: "gate",
        reason: errorReason(error),
        failedAt: Math.max(this.now(), operation.updatedAt),
        workspace: operation.state.workspace,
        worker: operation.state.worker,
        gate: attempt,
      });
    }
    if (receipt.outcome === "failed") {
      return this.fail(operation, {
        at: "gate",
        reason: gateFailureReason(receipt),
        failedAt: Math.max(this.now(), receipt.completedAt),
        workspace: operation.state.workspace,
        worker: operation.state.worker,
        gate: receipt,
      });
    }
    if (receipt.outcome === "skipped") {
      throw new Error("a configured gate returned a not-configured receipt");
    }
    return this.persist(
      operation,
      {
        phase: "gate-settled",
        workspace: operation.state.workspace,
        worker: operation.state.worker,
        gate: receipt,
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
          const attempt = this.options.ports.planWorkspace(operation);
          operation = this.persist(
            operation,
            { phase: "workspace-preparing", workspace: attempt },
            attempt.startedAt,
          ).operation;
          break;
        }
        case "workspace-preparing": {
          try {
            const receipt = await this.options.ports.prepareWorkspace({
              operation,
              attempt: state.workspace,
            });
            operation = this.persist(
              operation,
              { phase: "prepared", workspace: receipt },
              receipt.preparedAt,
            ).operation;
          } catch (error) {
            operation = this.fail(operation, {
              at: "preparing",
              reason: errorReason(error),
              failedAt: Math.max(this.now(), operation.updatedAt),
              workspace: state.workspace,
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
          if (operation.gatePlan.kind === "absent") {
            const settledAt = Math.max(this.now(), operation.updatedAt);
            operation = this.persist(
              operation,
              {
                phase: "gate-settled",
                workspace: state.workspace,
                worker: state.worker,
                gate: { outcome: "skipped", reason: "not-configured", settledAt },
              },
              settledAt,
            ).operation;
            break;
          }
          const attempt = this.options.ports.planGate(operation);
          const running = this.persist(
            operation,
            {
              phase: "gate-running",
              workspace: state.workspace,
              worker: state.worker,
              gate: attempt,
            },
            attempt.startedAt,
          );
          operation = running.operation;
          if (running.wrote) {
            operation = await this.runGate(operation, attempt, this.options.ports.runGate);
          }
          break;
        }
        case "gate-running": {
          const observe = this.options.ports.observeGate;
          if (observe === undefined) {
            operation = this.fail(operation, {
              at: "gate",
              reason: `gate execution ${state.gate.executionId} was interrupted and cannot be observed`,
              failedAt: Math.max(this.now(), operation.updatedAt),
              workspace: state.workspace,
              worker: state.worker,
              gate: state.gate,
            });
          } else {
            operation = await this.runGate(operation, state.gate, observe);
          }
          break;
        }
        case "gate-settled": {
          const attempt = this.options.ports.planCommit(operation);
          operation = this.persist(
            operation,
            {
              phase: "committing",
              workspace: state.workspace,
              worker: state.worker,
              gate: state.gate,
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
              gate: state.gate,
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
              reason: "worker diff and observed commit range disagree",
              failedAt: Math.max(this.now(), receipt.committedAt),
              workspace: state.workspace,
              worker: state.worker,
              gate: state.gate,
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
              gate: state.gate,
              commits: receipt,
            },
            receipt.committedAt,
          ).operation;
          break;
        }
        case "commits-settled": {
          const attempt = this.options.ports.planSourceLanding(operation);
          operation = this.persist(
            operation,
            {
              phase: "source-landing",
              workspace: state.workspace,
              worker: state.worker,
              gate: state.gate,
              commits: state.commits,
              landing: attempt,
            },
            attempt.startedAt,
          ).operation;
          break;
        }
        case "source-landing": {
          let receipt: RoundSourceLandingReceipt;
          try {
            receipt =
              hasWorkerChanges(state.worker) && hasCommitChanges(state.commits)
                ? await this.options.ports.landSourceChanges({
                    operation,
                    attempt: state.landing,
                  })
                : {
                    ...state.landing,
                    outcome: "unchanged",
                    landedAt: Math.max(this.now(), operation.updatedAt),
                  };
          } catch (error) {
            operation = this.fail(operation, {
              at: "source-landing",
              reason: errorReason(error),
              failedAt: Math.max(this.now(), operation.updatedAt),
              workspace: state.workspace,
              worker: state.worker,
              gate: state.gate,
              commits: state.commits,
              landing: state.landing,
            });
            break;
          }
          operation = this.persist(
            operation,
            {
              phase: "source-landed",
              workspace: state.workspace,
              worker: state.worker,
              gate: state.gate,
              commits: state.commits,
              landing: receipt,
            },
            receipt.landedAt,
          ).operation;
          break;
        }
        case "source-landed": {
          const attempt = this.options.ports.planRoundRecording(operation);
          operation = this.persist(
            operation,
            {
              phase: "round-recording",
              workspace: state.workspace,
              worker: state.worker,
              gate: state.gate,
              commits: state.commits,
              landing: state.landing,
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
                gate: state.gate,
                commits: state.commits,
                landing: state.landing,
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
              gate: state.gate,
              commits: state.commits,
              landing: state.landing,
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
                gate: state.gate,
                commits: state.commits,
                landing: state.landing,
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
              gate: state.gate,
              commits: state.commits,
              landing: state.landing,
              recording: state.recording,
              report: attempt,
            },
            attempt.startedAt,
          ).operation;
          break;
        }
        case "report-drafting": {
          try {
            const report = await this.options.ports.draftReport({
              operation,
              attempt: state.report,
            });
            const verification = this.options.ports.planReportVerification(operation);
            operation = this.persist(
              operation,
              {
                phase: "report-verifying",
                workspace: state.workspace,
                worker: state.worker,
                gate: state.gate,
                commits: state.commits,
                landing: state.landing,
                recording: state.recording,
                report,
                verification,
              },
              Math.max(report.draftedAt, verification.startedAt),
            ).operation;
          } catch (error) {
            operation = this.fail(operation, {
              at: "report-drafting",
              reason: errorReason(error),
              failedAt: Math.max(this.now(), operation.updatedAt),
              workspace: state.workspace,
              worker: state.worker,
              gate: state.gate,
              commits: state.commits,
              landing: state.landing,
              recording: state.recording,
              report: state.report,
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
                gate: state.gate,
                commits: state.commits,
                landing: state.landing,
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
              gate: state.gate,
              commits: state.commits,
              landing: state.landing,
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
