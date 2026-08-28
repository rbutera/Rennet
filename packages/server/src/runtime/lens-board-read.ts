import { type LensBoard, LensBoardSchema, type LensKind } from "@rennet/protocol";

// ─────────────────────────────────────────────────────────────────────────────
// The lens-board READ projection (C05 cluster 8 / C18) — the inverse of
// `draftToOps`. The pipeline writes a drafted board's ELEMENTS to the whiteboard
// event log (`runLensBoard` → `whiteboard.apply`) and its board-level coverage to
// the `BoardMetaStore`; this rebuilds the `LensBoard` the client reads from those
// two durable halves, inventing nothing:
//
//   • `elements` — the board's projected state, in the order the ops created them.
//   • `sections` — the TOP-LEVEL `section` elements (a section another element
//     names as a child is nested, not a fold line), in that same order. `counts`
//     is TALLIED from each section's own resolved children, exactly as the fold
//     line is defined; `delta` is the R58 stamp the section element carries.
//   • `skippedHunks` — the board meta's, since the 13-kind element vocabulary has
//     no element that can carry board-level coverage.
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
export interface LensBoardIdentity {
  readonly lens: LensKind;
  readonly generation: string;
  readonly boardId: string;
  readonly skippedHunks: readonly { readonly hunk: string; readonly reason: string }[];
}

const asString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

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
 * state) and the identity/coverage half (the board-meta record). The result is
 * validated against `LensBoardSchema` HERE — a board whose persisted elements no
 * longer satisfy the host vocabulary THROWS rather than serving a half-board, so
 * the client reads an honest failure instead of a silently pruned document.
 */
export function projectLensBoard(
  elements: readonly StateElement[],
  identity: LensBoardIdentity,
): LensBoard {
  const byId = new Map(elements.map((el) => [el.id, el]));
  const nested = nestedIds(elements);
  const sections = elements
    .filter((el) => el.kind === "section" && !nested.has(el.id))
    .map((el) => {
      const children = Array.isArray(el.data.children) ? el.data.children : [];
      const counts: Record<string, number> = {};
      for (const child of children) {
        const kind = typeof child === "string" ? byId.get(child)?.kind : undefined;
        if (kind !== undefined) counts[kind] = (counts[kind] ?? 0) + 1;
      }
      const delta = el.data.delta;
      return {
        ref: el.id,
        gist: asString(el.data.gist) ?? asString(el.data.title) ?? "",
        counts,
        ...(delta === "new" || delta === "reworked" ? { delta } : {}),
      };
    });
  return LensBoardSchema.parse({
    lens: identity.lens,
    generation: identity.generation,
    boardId: identity.boardId,
    sections,
    elements,
    skippedHunks: identity.skippedHunks.map((s) => ({ hunk: s.hunk, reason: s.reason })),
  });
}
