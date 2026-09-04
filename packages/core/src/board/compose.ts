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
 *    (B04/B10), not here. A mark keys on what a section SAYS and CITES, never on
 *    element ids: a `code_ref` CITES `(path, side, start_line, end_line)` — not the
 *    patchset id it was minted under, and not its optional `symbol` anchor — and a
 *    section is matched by its content, then by a shared citation, never by id first
 *    (session-bound-workspace D5). So a regenerated board whose elements cite the
 *    same lines carries the same marks, even when every id was reminted. Each mark
 *    is stamped with {@link DELTA_MARK_BASIS} so a reader can tell it from a mark
 *    minted under the older id keying.
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
 * The basis the delta marks this module writes are keyed on. Stamped beside every mark
 * (`data.delta_basis`) so a reader can tell a mark minted under the citation keying from
 * one minted before it, when marks keyed on element ids: the read projection shows no
 * marks for the latter rather than wrong ones (session-bound-workspace D5).
 */
export const DELTA_MARK_BASIS = "citation";

/**
 * The fields of a `code_ref` that its CONTENT identity compares — the citation plus the
 * optional seat-authored `symbol` anchor, and never `patchset_id`.
 */
const CODE_REF_CONTENT_FIELDS = ["path", "side", "start_line", "end_line", "symbol"] as const;

/**
 * The fields that identify WHAT a `code_ref` cites: the path, side and line range, and
 * nothing else (D5 — "delta marks key on path and range").
 *
 * `symbol` is deliberately absent. It is optional and seat-authored, so a regeneration that
 * renamed it, or simply omitted it, produced a different citation key over identical lines —
 * and the section then matched nothing, read as new, and took its predecessor with it into
 * the removals. The symbol still moves the CONTENT signature (a renamed anchor is a rework),
 * which is the mark it should leave.
 */
const CODE_REF_CITATION_FIELDS = ["path", "side", "start_line", "end_line"] as const;

/**
 * The data an element is compared by. Excludes the composition-set `delta` stamp and its
 * basis (metadata, not drafter content) so a section stamped `reworked` last generation
 * still reads as carried when its content is unchanged this generation. A `code_ref` is
 * identified by what it cites — `(path, side, start_line, end_line, symbol)` — and NOT by
 * `patchset_id`: every regenerated board is minted under the successor patchset, so keying
 * on the id would stamp every cited section `reworked` on every round (D5).
 */
function comparedData(el: DraftElement): Record<string, unknown> {
  const data = el.data as Record<string, unknown>;
  if (el.kind === "section") return withoutDelta(data);
  if (el.kind === "code_ref") {
    return Object.fromEntries(CODE_REF_CONTENT_FIELDS.map((field) => [field, data[field]]));
  }
  return data;
}

/** What a `code_ref` cites, as a stable string; `undefined` for every other kind. */
function citationKey(el: DraftElement): string | undefined {
  if (el.kind !== "code_ref") return undefined;
  const data = el.data as Record<string, unknown>;
  return stableStringify(
    Object.fromEntries(CODE_REF_CITATION_FIELDS.map((field) => [field, data[field]])),
  );
}

/** An element's content identity for the verbatim carry: its kind and compared data. */
function contentSig(el: DraftElement): string {
  return `${el.kind}:${stableStringify(comparedData(el))}`;
}

/** A copy of a section's `data` without the composition-set `delta` stamp and its basis. */
function withoutDelta(data: Record<string, unknown>): Record<string, unknown> {
  const rest = { ...data };
  delete rest.delta;
  delete rest.delta_basis;
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

/**
 * One board's sections, each with the two id-free identities a delta mark keys on:
 *
 *  - `signature` — the section's compared data with every element reference replaced by
 *    the referenced element's own signature, recursively (a cycle is cut at its second
 *    visit). No element id survives into it, so a regenerated board that mints new ids for
 *    the same content has the same signature: content, not ids, is what "the same section"
 *    means (D5).
 *  - `citations` — the `(path, side, start, end)` key of every `code_ref` in the subtree,
 *    which is how a section that CHANGED is still recognised as the same section, reworked.
 */
interface SectionIdentity {
  readonly element: DraftElement;
  readonly signature: string;
  readonly citations: ReadonlySet<string>;
}

function sectionIdentities(board: DraftBoard): SectionIdentity[] {
  const byId = new Map(board.elements.map((el) => [el.id, el]));
  const signatureOf = (el: DraftElement, stack: ReadonlySet<string>): string => {
    const inner = new Set(stack).add(el.id);
    const resolve = (value: unknown): unknown => {
      if (typeof value === "string") {
        const target = byId.get(value);
        if (target === undefined) return value;
        return inner.has(value) ? "<cycle>" : `<${signatureOf(target, inner)}>`;
      }
      return Array.isArray(value) ? value.map(resolve) : value;
    };
    const data = Object.fromEntries(
      Object.entries(comparedData(el)).map(([key, value]) => [key, resolve(value)]),
    );
    return `${el.kind}:${stableStringify(data)}`;
  };
  const citationsOf = (root: DraftElement): Set<string> => {
    const cited = new Set<string>();
    const seen = new Set<string>();
    const queue = [root.id];
    while (queue.length > 0) {
      const id = queue.shift() as string;
      if (seen.has(id)) continue;
      seen.add(id);
      const el = byId.get(id);
      if (el === undefined) continue;
      const citation = citationKey(el);
      if (citation !== undefined) cited.add(citation);
      for (const value of Object.values(el.data as Record<string, unknown>)) {
        for (const v of Array.isArray(value) ? value : [value]) {
          if (typeof v === "string" && byId.has(v)) queue.push(v);
        }
      }
    }
    return cited;
  };
  return board.elements
    .filter((el) => el.kind === "section")
    .map((el) => ({
      element: el,
      signature: signatureOf(el, new Set()),
      citations: citationsOf(el),
    }));
}

/**
 * Is `previous` the same section as `current`, possibly reworked? Same content is the
 * strongest answer; failing that, the two cite a common `(path, side, start, end)` range,
 * or — for a board that kept its ids — carry the same id.
 *
 * The title is the LAST resort and only when NEITHER section cites anything. A title is
 * what a seat writes freely, and the board vocabulary is small: two boards both carrying a
 * "Findings" section about different code are the ordinary case, not the exception. Matching
 * on it made a genuinely new section read as a rework of the old one, and hid the old one's
 * removal — the honest-present ruling inverted, in both directions at once. Where a section
 * cites code, the citations answer the question; where it cites nothing (a prose-only
 * section), the title is all there is.
 */
function sameSection(previous: SectionIdentity, current: SectionIdentity): boolean {
  if (previous.signature === current.signature) return true;
  for (const citation of current.citations) if (previous.citations.has(citation)) return true;
  if (previous.citations.size === 0 && current.citations.size === 0) {
    const title = (identity: SectionIdentity) =>
      (identity.element.data as { title?: unknown }).title;
    if (title(previous) !== undefined && title(previous) === title(current)) return true;
  }
  return previous.element.id === current.element.id;
}

/** The R58 delta for one section: `new`, `reworked`, or `undefined` (carried). */
function sectionDelta(
  previous: readonly SectionIdentity[] | undefined,
  current: SectionIdentity,
): "new" | "reworked" | undefined {
  if (previous === undefined) return "new";
  if (previous.some((p) => p.signature === current.signature)) return undefined;
  return previous.some((p) => sameSection(p, current)) ? "reworked" : "new";
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
  const kept = sectionIdentities(current);
  return sectionIdentities(previous)
    .filter((p) => !kept.some((c) => sameSection(p, c)))
    .map((p) => p.element.id);
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
  const prior = previous === undefined ? undefined : sectionIdentities(previous);
  const identities = new Map(sectionIdentities(current).map((s) => [s.element.id, s]));
  const elements: DraftElement[] = current.elements.map((el) => {
    const identity = identities.get(el.id);
    if (el.kind !== "section" || identity === undefined) return el;
    const delta = sectionDelta(prior, identity);
    const rest = withoutDelta(el.data as Record<string, unknown>);
    const data = delta === undefined ? rest : { ...rest, delta, delta_basis: DELTA_MARK_BASIS };
    return { ...el, data } as DraftElement;
  });
  return { ...(current as object), elements } as DraftBoard;
}
