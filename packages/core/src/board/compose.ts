/**
 * Board composition mechanics — the pure cross-lens pass of the draft pipeline
 * (C1/C3, B08 cluster 4). Composition is MECHANICAL here; the authored
 * connective prose is the orchestrator's (cluster 5, write-through on the
 * versioned composition prompt). The lens boards ARE the reading surface — this
 * module produces NO sixth composed board (C3). It consumes the B03-frozen seam
 * (`DraftBoard`, `DraftElement`, `Violation`, `SectionDeltaSchema`) verbatim and
 * re-models nothing (reconciliation 2).
 *
 * Two mechanics:
 *
 * 1. **Verbatim carry on stable element ids** ({@link carriedElementIds}) — an
 *    element whose id is stable across generations and whose content is
 *    byte-identical is carried unchanged; composition never rewrites it.
 *
 * 2. **Delta stamps** ({@link stampDeltas}) — R58: a `section` element is stamped
 *    `new` (its id is new this generation) or `reworked` (its subtree changed);
 *    an unchanged section carries no stamp (absence = carried). The stamp lives
 *    on the section element's `data.delta` (`SectionDeltaSchema`); the
 *    `LensBoard` projection's `sections[].delta` is projected from it downstream
 *    (B04/B10), not here. A mark keys on what an element CITES — a `code_ref`'s
 *    identity for the stamp is `(path, side, start_line, end_line)`, never the
 *    patchset id it was minted under (session-bound-workspace D5), so a regenerated
 *    board whose element still cites the same lines carries the same mark.
 */

import type { DraftBoard, DraftElement } from "@rennet/protocol";

// ── Shared tiny board utils ──────────────────────────────────────────────────
// ponytail: `stableStringify` is ~10 trivial lines duplicated from `validate.ts`
// (whose copy is module-private). Keeping compose.ts self-contained beats coupling
// to validate's internals or minting a board/util.ts for one helper.

/** Stable JSON: object keys sorted, so an insertion-order shuffle is not a diff. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

// ── 1. Verbatim carry + 2. Delta stamps ──────────────────────────────────────

/**
 * An element's content identity for carry/delta comparison. Excludes the
 * composition-set `delta` stamp (metadata, not drafter content) so a section
 * stamped `reworked` last generation still reads as carried when its content is
 * unchanged this generation. A `code_ref` is identified by what it cites —
 * `(path, side, start_line, end_line)` — and NOT by `patchset_id`: every
 * regenerated board is minted under the successor patchset, so keying on the id
 * would stamp every cited section `reworked` on every round (D5).
 */
function contentSig(el: DraftElement): string {
  const data = el.data as Record<string, unknown>;
  if (el.kind === "section" && "delta" in data) {
    return `${el.kind}:${stableStringify(withoutDelta(data))}`;
  }
  if (el.kind === "code_ref") {
    const { path, side, start_line, end_line } = data;
    return `${el.kind}:${stableStringify({ path, side, start_line, end_line })}`;
  }
  return `${el.kind}:${stableStringify(data)}`;
}

/** A copy of a section's `data` without the composition-set `delta` stamp. */
function withoutDelta(data: Record<string, unknown>): Record<string, unknown> {
  const rest = { ...data };
  delete rest.delta;
  return rest;
}

/**
 * The element ids carried VERBATIM from `previous` into `current`: present in
 * both, byte-identical content. A carried element is never rewritten by
 * composition.
 */
export function carriedElementIds(previous: DraftBoard, current: DraftBoard): Set<string> {
  const prevSig = new Map(previous.elements.map((el) => [el.id, contentSig(el)]));
  const carried = new Set<string>();
  for (const el of current.elements) {
    if (prevSig.get(el.id) === contentSig(el)) carried.add(el.id);
  }
  return carried;
}

/** The element ids a value references (an `element`-typed attribute holds an id). */
function referencedIds(el: DraftElement, byId: ReadonlyMap<string, DraftElement>): string[] {
  const refs: string[] = [];
  for (const value of Object.values(el.data as Record<string, unknown>)) {
    if (typeof value === "string" && byId.has(value)) refs.push(value);
    else if (Array.isArray(value)) {
      for (const v of value) if (typeof v === "string" && byId.has(v)) refs.push(v);
    }
  }
  return refs;
}

/** A section's subtree signature: itself + every element reachable through its refs. */
function subtreeSignature(board: DraftBoard, rootId: string): string {
  const byId = new Map(board.elements.map((el) => [el.id, el]));
  const seen = new Set<string>();
  const queue = [rootId];
  while (queue.length > 0) {
    const id = queue.shift() as string;
    if (seen.has(id)) continue;
    seen.add(id);
    const el = byId.get(id);
    if (el === undefined) continue;
    for (const ref of referencedIds(el, byId)) queue.push(ref);
  }
  return [...seen]
    .filter((id) => byId.has(id))
    .sort()
    .map((id) => `${id}=${contentSig(byId.get(id) as DraftElement)}`)
    .join("|");
}

/** The R58 delta for one section id: `new`, `reworked`, or `undefined` (carried). */
function sectionDelta(
  previous: DraftBoard | undefined,
  current: DraftBoard,
  sectionId: string,
): "new" | "reworked" | undefined {
  if (previous === undefined || !previous.elements.some((el) => el.id === sectionId)) return "new";
  return subtreeSignature(previous, sectionId) === subtreeSignature(current, sectionId)
    ? undefined
    : "reworked";
}

/**
 * The sections `previous` had that `current` does NOT — the regeneration's REMOVALS.
 *
 * A delta stamp can only live on a section that still exists, so deletion is invisible to
 * {@link stampDeltas} by construction: this is the other half of the delta, and the two
 * together are the whole account of what the round did to a board. Without it a round that
 * only deleted sections stamps nothing and reads as "carrying forward" — a board claiming
 * to carry content that is no longer there, which is the honest-present ruling inverted.
 */
export function removedSectionIds(previous: DraftBoard, current: DraftBoard): string[] {
  const present = new Set(current.elements.map((el) => el.id));
  return previous.elements
    .filter((el) => el.kind === "section" && !present.has(el.id))
    .map((el) => el.id);
}

/**
 * Did this lens CARRY FORWARD — i.e. did the regeneration change none of its sections?
 * (C15 3.3, a hard constraint: the live progress channel's lens-level "carrying forward"
 * lane label must derive from the SAME signal as the section markers, never a cheaper
 * heuristic. A lane that read "carrying forward" over sections that actually changed
 * would be a lie in the UI.)
 *
 * It reads the stamps {@link stampDeltas} WROTE plus the removals they cannot express, so
 * it cannot diverge from either: carried iff a prior generation exists, no section on the
 * stamped board carries a `new` or `reworked` delta, AND no section the prior generation
 * had went away. A first generation (`previous === undefined`) is never "carried" — there
 * is nothing to carry from, and every section is stamped `new` anyway.
 */
export function isCarriedForward(previous: DraftBoard | undefined, stamped: DraftBoard): boolean {
  if (previous === undefined) return false;
  if (removedSectionIds(previous, stamped).length > 0) return false;
  return !stamped.elements.some(
    (el) => el.kind === "section" && (el.data as { delta?: unknown }).delta !== undefined,
  );
}

/**
 * Stamp `current`'s `section` elements with their R58 round-delta against
 * `previous` (undefined = the first generation, everything is `new`). A carried
 * section's stamp is REMOVED (absence = carried). Pure — returns a new board,
 * never mutates the input. Non-section elements pass through untouched, so
 * verbatim carry on every other kind is automatic.
 *
 * Deletion is the half this cannot express — a stamp needs a section to sit on — so
 * {@link removedSectionIds} carries it, and {@link isCarriedForward} reads both.
 */
export function stampDeltas(previous: DraftBoard | undefined, current: DraftBoard): DraftBoard {
  const elements: DraftElement[] = current.elements.map((el) => {
    if (el.kind !== "section") return el;
    const delta = sectionDelta(previous, current, el.id);
    const rest = withoutDelta(el.data as Record<string, unknown>);
    const data = delta === undefined ? rest : { ...rest, delta };
    return { ...el, data } as DraftElement;
  });
  return { ...(current as object), elements } as DraftBoard;
}
