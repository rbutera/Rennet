import {
  type BoardDocument,
  type DomainCountKind,
  type HostKind,
  type LensBoard,
  LensBoardSchema,
  type LensKind,
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

const asString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const DOMAIN_COUNT_ENTRIES = [
  ["finding", "findings"],
  ["decision", "decisions"],
  ["requirement", "requirements"],
  ["order_step", "steps"],
  ["round_outcome", "outcomes"],
  ["noise_verdict", "groups"],
  ["code_ref", "files"],
  ["review_comment", "comments"],
] as const satisfies readonly (readonly [HostKind, DomainCountKind])[];

const DOMAIN_COUNT_FOR_HOST_KIND = new Map<string, DomainCountKind>(DOMAIN_COUNT_ENTRIES);

/** The element ids some element names as a child — the nested set, excluded from the
 *  top-level fold lines. Only `children` is a containment relation; other element-typed
 *  attributes (a finding's `code`, a decision's `evidence`) are citations, not nesting. */
function nestedIds(elements: readonly StateElement[]): ReadonlySet<string> {
  const nested = new Set<string>();
  for (const el of elements) {
    const children = el.data.children;
    if (!Array.isArray(children)) continue;
    for (const child of children) if (typeof child === "string") nested.add(child);
  }
  return nested;
}

/**
 * Project a persisted board's element state into the {@link LensBoard} the client
 * reads. Pure: the caller supplies the elements (the board service's projected
 * state) and the identity half (the board-meta record). The result is
 * validated against `LensBoardSchema` HERE — a board whose persisted elements no
 * longer satisfy the host vocabulary THROWS rather than serving a half-board, so
 * the client reads an honest failure instead of a silently pruned document.
 */
function projectBoard(elements: readonly StateElement[], identity: BoardIdentity) {
  const byId = new Map(elements.map((el) => [el.id, el]));
  const nested = nestedIds(elements);
  const sections = elements
    .filter((el) => el.kind === "section" && !nested.has(el.id))
    .map((el) => {
      const children = Array.isArray(el.data.children) ? el.data.children : [];
      const counts: Record<string, number> = {};
      const countedFilePaths = new Set<string>();
      for (const child of children) {
        const childElement = typeof child === "string" ? byId.get(child) : undefined;
        const hostKind = childElement?.kind;
        const domainKind =
          hostKind === undefined ? undefined : DOMAIN_COUNT_FOR_HOST_KIND.get(hostKind);
        if (domainKind === undefined) continue;
        if (domainKind === "files") {
          const path = asString(childElement?.data.path);
          if (path === undefined || countedFilePaths.has(path)) continue;
          countedFilePaths.add(path);
        }
        counts[domainKind] = (counts[domainKind] ?? 0) + 1;
      }
      const delta = el.data.delta;
      return {
        ref: el.id,
        gist: asString(el.data.gist) ?? asString(el.data.title) ?? "",
        counts,
        ...(delta === "new" || delta === "reworked" ? { delta } : {}),
      };
    });
  return {
    lens: identity.lens,
    generation: identity.generation,
    boardId: identity.boardId,
    document: resolveBoardDocument(identity.lens, identity.document),
    sections,
    elements,
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
