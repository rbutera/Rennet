import type { BoardMetaRecord } from "@rennet/adapters";
import type { ComposableAsk, Generation, Review, RoundOperation } from "@rennet/protocol";
import { projectRoundReportBoard } from "./lens-board-read";
import { verifyRoundReportEvidence } from "./round-report-verification";

export type StoredRoundReportVerificationIdentity = {
  readonly reportBoardId: string;
  readonly generation: string;
  readonly expectedPatchsetId: string;
} & ({ readonly point: "precommit" } | { readonly point: "persisted" });

interface StoredBoardElement {
  readonly id: string;
  readonly kind: string;
  readonly data: Record<string, unknown>;
}

export interface StoredRoundReportVerificationDeps {
  readonly reviewById: (reviewId: string) => Review | null;
  readonly loadGeneration: (generation: string) => Generation | undefined;
  readonly loadBoardElements: (
    repoRoot: string,
    boardId: string,
  ) => Promise<readonly StoredBoardElement[]>;
  readonly loadBoardMeta: (boardId: string) => BoardMetaRecord | undefined;
  readonly loadDispatchedAsks: (operation: RoundOperation) => readonly ComposableAsk[];
}

/**
 * Verify one report against the immutable worker receipt and its exact board identity.
 *
 * The precommit pass additionally proves that the review still names the successor being
 * drafted. Recovery deliberately does not: the active review can advance after this report
 * and generation commit, while their immutable identities remain valid.
 */
export async function verifyStoredRoundReport(
  deps: StoredRoundReportVerificationDeps,
  operation: RoundOperation,
  identity: StoredRoundReportVerificationIdentity,
): Promise<void> {
  if (operation.state.phase !== "report-drafting" && operation.state.phase !== "report-verifying") {
    throw new Error("Round report verification started outside its durable report phases.");
  }
  if (
    identity.point === "precommit" &&
    deps.reviewById(operation.reviewId)?.activePatchsetId !== identity.expectedPatchsetId
  ) {
    throw new Error("Round report verification lost its exact successor patchset.");
  }
  if (identity.point === "persisted") {
    const persisted = deps.loadGeneration(identity.generation);
    if (persisted?.patchsetId !== identity.expectedPatchsetId) {
      throw new Error("Round report verification lost its persisted generation identity.");
    }
  }
  const elements = await deps.loadBoardElements(operation.repoRoot, identity.reportBoardId);
  const meta = deps.loadBoardMeta(identity.reportBoardId);
  if (
    meta === undefined ||
    meta.boardId !== identity.reportBoardId ||
    meta.lens !== "report" ||
    meta.session !== operation.sessionId ||
    meta.generation !== identity.generation
  ) {
    throw new Error("Round report verification could not resolve its durable board identity.");
  }
  const board = projectRoundReportBoard(elements, {
    lens: "report",
    generation: identity.generation,
    boardId: identity.reportBoardId,
    document: meta.document,
    skippedHunks: meta.skippedHunks,
  });
  verifyRoundReportEvidence({
    board,
    dispatchedAsks: deps.loadDispatchedAsks(operation),
    expectedPatchsetId: identity.expectedPatchsetId,
    diff: operation.state.worker.diff,
    changedPaths: operation.state.worker.changedPaths,
  });
}
