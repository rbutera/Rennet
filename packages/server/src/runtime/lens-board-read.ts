import { DELTA_MARK_BASIS } from "@rennet/core";
import {
  type BoardDocument,
  type LensBoard,
  LensBoardSchema,
  type LensKind,
  projectBoardSections,
  ROUND_NO_REGEN,
  type RoundRecord,
  type RoundReportBoard,
  RoundReportBoardSchema,
  resolveBoardDocument,
} from "@rennet/protocol";

// ─────────────────────────────────────────────────────────────────────────────
// The lens-board READ projection (C05 cluster 8 / C18) — the inverse of
// `draftToOps`. The pipeline writes a drafted board's ELEMENTS to the whiteboard
// event log (`runLensBoard` → `whiteboard.apply`) and its board-level document to
// the `BoardMetaStore`; this rebuilds the `LensBoard` the client reads from those
// two durable halves, inventing nothing:
//
//   • `elements` — the board's projected state, in the order the ops created them.
//   • `document` — the authored title/intro/measure from board metadata, or the
//     deterministic lens fallback for a legacy record that predates it.
//   • `sections` — the TOP-LEVEL `section` elements (a section another element
//     names as a child is nested, not a fold line), in that same order. `counts`
//     is TALLIED from each section's own resolved children, exactly as the fold
//     line is defined; `delta` is the R58 stamp the section element carries.
//
// The one derivation with a choice in it is `gist`. The drafters are asked for a
// one-line folded gist (`prompts/*.md`) and the `section` kind is a loose object,
// so a board that carries one is served it; a board that does not falls back to
// the section's own TITLE — its own words, never a summary this projection wrote.
// ─────────────────────────────────────────────────────────────────────────────

/** The wire element shape the board service projects — `{ id, kind, data }`. */
interface StateElement {
  readonly id: string;
  readonly kind: string;
  readonly data: Record<string, unknown>;
}

/** The board-level facts the event log cannot carry, from the board-meta record. */
interface BoardIdentity {
  readonly lens: LensKind | "report";
  readonly generation: string;
  readonly boardId: string;
  readonly document?: BoardDocument;
}

export interface LensBoardIdentity extends BoardIdentity {
  readonly lens: LensKind;
}

export interface RoundReportBoardIdentity extends BoardIdentity {
  readonly lens: "report";
}

interface StoredRoundReportMeta {
  readonly lens: string;
  readonly boardId: string;
  readonly session?: string;
  readonly generation?: string;
  readonly document?: BoardDocument;
}

/**
 * Project a persisted board's element state into the {@link LensBoard} the client
 * reads. Pure: the caller supplies the elements (the board service's projected
 * state) and the identity half (the board-meta record). The result is
 * validated against `LensBoardSchema` HERE — a board whose persisted elements no
 * longer satisfy the host vocabulary THROWS rather than serving a half-board, so
 * the client reads an honest failure instead of a silently pruned document.
 */
function projectBoard(stored: readonly StateElement[], identity: BoardIdentity) {
  // A mark minted before marks keyed on citations keyed on element ids (D5) and would be
  // wrong under the current basis: it is stripped, and the board says so, rather than
  // served as a current mark.
  const legacyMark = (el: StateElement): boolean =>
    el.kind === "section" &&
    el.data.delta !== undefined &&
    el.data.delta_basis !== DELTA_MARK_BASIS;
  const marksStripped = stored.some(legacyMark);
  const elements = marksStripped
    ? stored.map((el) => {
        if (!legacyMark(el)) return el;
        const data = { ...el.data };
        delete data.delta;
        delete data.delta_basis;
        return { ...el, data };
      })
    : stored;
  // The fold lines come from `@rennet/protocol`'s own projection, which the CLIENT also
  // runs over the live element stream (`lens-board-tools` D11/D13). One derivation, two
  // readers: a board that folded one way while it was being written and another way once
  // it settled would reorganise itself under the reviewer at the moment the lane settled.
  const sections = projectBoardSections(elements);
  return {
    lens: identity.lens,
    generation: identity.generation,
    boardId: identity.boardId,
    document: resolveBoardDocument(identity.lens, identity.document),
    sections,
    elements,
    ...(marksStripped ? { marksStripped: "pre-citation-basis" as const } : {}),
  };
}

export function projectLensBoard(
  elements: readonly StateElement[],
  identity: LensBoardIdentity,
): LensBoard {
  return LensBoardSchema.parse(projectBoard(elements, identity));
}

/** Project the exact persisted report board named by a durable rounds-ledger row. */
export function projectRoundReportBoard(
  elements: readonly StateElement[],
  identity: RoundReportBoardIdentity,
): RoundReportBoard {
  return RoundReportBoardSchema.parse(projectBoard(elements, identity));
}

/**
 * Read the exact report projection named by one durable ledger row. Identity is checked
 * before board state is touched, so another session, generation, or board kind can never
 * be rendered under the row's receipt.
 */
export async function readRoundReportBoardForRecord(
  input: {
    readonly record: RoundRecord;
    readonly sessionId: string;
    readonly reportBoardId: string;
  },
  deps: {
    readonly loadMeta: (boardId: string) => StoredRoundReportMeta | undefined;
    readonly readElements: (boardId: string) => Promise<readonly StateElement[]>;
  },
): Promise<RoundReportBoard | undefined> {
  if (
    input.record.reportBoard !== input.reportBoardId ||
    input.record.boardGeneration === ROUND_NO_REGEN
  ) {
    return undefined;
  }
  const meta = deps.loadMeta(input.reportBoardId);
  if (
    meta === undefined ||
    meta.lens !== "report" ||
    meta.boardId !== input.reportBoardId ||
    meta.session !== input.sessionId ||
    meta.generation !== input.record.boardGeneration
  ) {
    return undefined;
  }
  return projectRoundReportBoard(await deps.readElements(input.reportBoardId), {
    lens: "report",
    generation: input.record.boardGeneration,
    boardId: input.reportBoardId,
    document: meta.document,
  });
}
