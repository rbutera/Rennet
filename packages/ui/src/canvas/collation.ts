import type { AnchorSide, AnchorSpan, DispositionType } from "@rennet/types";
import type { DispositionBatch } from "./authoring";
import { anchorPathKey, type DispositionWrite } from "./logic";

// ─────────────────────────────────────────────────────────────────────────────
// The COLLATION DRAFT model (issue #101; ruling R40) — pure functions, no React,
// no DOM.
//
// R40 (Rai, 2026-08-08): the forming destination is the editable collation draft
// canvas, NOT the paper. Three states — unstaged → staged-in-draft → signed-on-
// paper. Disposing stages a disposition into THIS draft (still yours, editable);
// signing freezes the draft into the paper. Editing (reword / retype / reorder /
// merge / split / withdraw) lives HERE, on the draft — never on the paper.
//
// Why a NEW model and not #17's `DispositionBatch`. The shipped batch is a
// path-KEYED map (one disposition per path, upsert-by-path, rendered path-sorted).
// That is exactly right for "dispose == staged" ingestion, and it is kept intact
// (this module lifts FROM it). But the collation canvas needs three things the
// path-keyed batch structurally cannot express:
//   • ORDER — reorder is "how they read in the output" (the review's comment
//     order, the handoff bundle's task order). A path-sorted map has no user order.
//   • MERGE — two dispositions collapse into one (two adjacent comments → one).
//   • SPLIT — one disposition becomes two, which then share a path.
// So the collation draft is a LIST, not a map: an ordered array of id-keyed items,
// where two items MAY share a path (a split, or an intentional pair). Array order
// IS the draft order, and it is the order the paper previews and signs.
//
// The `layer:ui` boundary allows only `@rennet/types` + this package: nothing here
// imports `@rennet/core`.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One item on the collation draft. `id` is stable across edits (reword/retype/
 * reorder never change it), so reorder/merge/split are well-defined operations on
 * a specific item rather than on a path that may now be shared.
 *
 * `raw` is the user's sovereign body — lazy/vague/half-formed is the supported
 * path, carried verbatim. `refined` is the §2.5 comment-refinement seam: the
 * agent's cleaned form arrives here in the background; until it does, `raw` is the
 * effective body (see `effectiveBody`). This slice never sets `refined` itself —
 * it is the seam #19 fills — but the model and canvas render it the moment it
 * lands, so wiring refinement changes no shape here.
 */
export interface CollationItem {
  readonly id: string;
  path: string;
  type: DispositionType;
  raw: string;
  /**
   * Span-grained anchor (all-or-none with `side`). Present ⇒ this item disposes on
   * `path` at a line span (a Spec-view per-node review); absent ⇒ path-grained, the
   * diff lenses' unchanged behaviour. The item's `id` already encodes it (see
   * `ingestWrites`), so span-carrying items never collapse a distinct sibling away.
   */
  span?: AnchorSpan;
  side?: AnchorSide;
  /** §2.5 seam: the refined form. `effectiveBody` prefers it once present. */
  refined?: string;
  /**
   * The staging override for a stageable disposition (issue #109 — the ink/blue
   * material law). Meaningful ONLY for `comment`/`question`, which default to the
   * orchestrator (blue) and travel to the PR (ink) only when explicitly staged.
   * Absent ⇒ the type's default lane (see `itemLane` in `./staging`), so every
   * existing draft is unchanged: this is additive, and the two fixed types
   * (`approve` never publishes, `request-change` always does) ignore it entirely.
   */
  staged?: boolean;
}

/** The collation draft: an ORDERED list. Array order is the draft/output order. */
export type CollationDraft = CollationItem[];

/**
 * The effective body of an item — the refined form once it has landed, else the
 * sovereign raw. §2.1: "raw stays the effective body until a user adjudication
 * makes a refined body effective." This slice is raw-only in practice (nothing
 * sets `refined`), but the outbound bytes read through here so the refinement loop
 * flows without a shape change.
 */
export function effectiveBody(item: CollationItem): string {
  return item.refined ?? item.raw;
}

// ── Building the draft from the staged batch (dispose == staged ingestion) ─────

/**
 * Lift the shipped #17 `DispositionBatch` into an ordered draft. Initial order is
 * path-sorted, matching what the frame/paper showed before the collation canvas,
 * so opening the draft is continuous with the staged view it promotes. Each item's
 * id is its path (the batch is one-per-path), which stays stable under reword/
 * retype/reorder; splits mint fresh ids (see `splitItem`).
 */
export function draftFromBatch(batch: DispositionBatch): CollationDraft {
  return [...batch]
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
    .map((entry) => ({ id: entry.path, path: entry.path, type: entry.type, raw: entry.raw }));
}

/**
 * Ingest per-anchor L2 writes into the draft in the same act they are made
 * (dispose == staged, R40). Upsert by path: a write on a path already in the draft
 * replaces the FIRST item on that path in place (a re-disposition of that anchor,
 * preserving its position and id); a write on a new path appends a fresh item. So
 * ingesting from the lenses behaves like #17's `addToBatch`, while tolerating the
 * post-split case (a path held by two items) by updating the first rather than
 * collapsing the split away.
 */
export function ingestWrites(draft: CollationDraft, writes: DispositionWrite[]): CollationDraft {
  let next = draft;
  for (const write of writes) {
    // Key by the FULL anchor identity (path, or path#L…@side), not the bare path,
    // so span-grained writes coexist: five requirements in one `spec.md` become five
    // draft items, not one that overwrites the rest. Path-grained writes reduce to
    // the path exactly as before (the diff lenses are untouched).
    const id = anchorPathKey(write);
    const index = next.findIndex((item) => item.id === id);
    const span = write.span && write.side ? { span: write.span, side: write.side } : {};
    if (index >= 0) {
      next = next.map((item, at) =>
        at === index ? { ...item, type: write.type, raw: write.body, ...span } : item,
      );
    } else {
      next = [...next, { id, path: write.path, type: write.type, raw: write.body, ...span }];
    }
  }
  return next;
}

// ── Editing on the draft: reword / retype / reorder / merge / split / withdraw ─

/** Reword an item's raw body (no-op if the id is not on the draft). */
export function rewordItem(draft: CollationDraft, id: string, raw: string): CollationDraft {
  return draft.map((item) => (item.id === id ? { ...item, raw } : item));
}

/** Retype an item's disposition (no-op if the id is not on the draft). */
export function retypeItem(
  draft: CollationDraft,
  id: string,
  type: DispositionType,
): CollationDraft {
  return draft.map((item) => (item.id === id ? { ...item, type } : item));
}

/**
 * Reorder: move the item one place toward the top (`up`) or bottom (`down`). A
 * move at the boundary is a no-op (the top item cannot move up), so the caller can
 * wire both buttons unconditionally. Order is the output order, so this is a
 * content-affecting edit, not cosmetic.
 */
export function moveItem(
  draft: CollationDraft,
  id: string,
  direction: "up" | "down",
): CollationDraft {
  const index = draft.findIndex((item) => item.id === id);
  if (index < 0) return draft;
  const target = direction === "up" ? index - 1 : index + 1;
  if (target < 0 || target >= draft.length) return draft;
  const next = [...draft];
  const moved = next[index];
  const displaced = next[target];
  if (!moved || !displaced) return draft;
  next[index] = displaced;
  next[target] = moved;
  return next;
}

/**
 * Merge item `sourceId` INTO `targetId`: the two become one item at the target's
 * position, carrying the target's id/path/type and both bodies joined (target
 * first, blank halves dropped). The source is removed — zero residue. A merge of
 * an item into itself, or with an unknown id, is a no-op. Two adjacent comments
 * become one; the paper then carries one line where there were two.
 */
export function mergeItems(
  draft: CollationDraft,
  targetId: string,
  sourceId: string,
): CollationDraft {
  if (targetId === sourceId) return draft;
  const target = draft.find((item) => item.id === targetId);
  const source = draft.find((item) => item.id === sourceId);
  if (!target || !source) return draft;
  const joined = [effectiveBody(target), effectiveBody(source)]
    .map((body) => body.trim())
    .filter((body) => body.length > 0)
    .join("\n");
  return draft
    .filter((item) => item.id !== sourceId)
    .map((item) => (item.id === targetId ? { ...item, raw: joined, refined: undefined } : item));
}

/**
 * Split item `id` into two: the original keeps its body, and a fresh EMPTY sibling
 * is inserted immediately after it, sharing the path and type so the second half
 * can be authored/re-anchored independently. No content is duplicated (the new
 * half is blank, ready to reword). The new item's id is derived deterministically
 * from the original so the operation is pure and test-stable. No-op on an unknown
 * id. One note covering two things becomes two notes.
 */
export function splitItem(draft: CollationDraft, id: string): CollationDraft {
  const index = draft.findIndex((item) => item.id === id);
  if (index < 0) return draft;
  const original = draft[index];
  if (!original) return draft;
  const sibling: CollationItem = {
    id: nextSplitId(draft, original.id),
    path: original.path,
    type: original.type,
    raw: "",
  };
  const next = [...draft];
  next.splice(index + 1, 0, sibling);
  return next;
}

/**
 * A deterministic, collision-free id for a split sibling: `${baseId}::split::N`
 * with the lowest N not already present on the draft. Pure (no randomness), so a
 * split is reproducible in tests, and stable across repeated splits.
 */
function nextSplitId(draft: CollationDraft, baseId: string): string {
  const existing = new Set(draft.map((item) => item.id));
  let counter = 2;
  let candidate = `${baseId}::split::${counter}`;
  while (existing.has(candidate)) {
    counter += 1;
    candidate = `${baseId}::split::${counter}`;
  }
  return candidate;
}

/**
 * Withdraw an item by id (unstage, R37). It is removed ENTIRELY — its bytes vanish
 * from the payload, no residue, no tombstone. This is the collation canvas's
 * unstage act.
 */
export function withdrawItem(draft: CollationDraft, id: string): CollationDraft {
  return draft.filter((item) => item.id !== id);
}

/**
 * Withdraw every item on a path (unstage by anchor). Used by the ingestion side
 * (mark-unread clears a path's disposition), where the caller knows the path, not
 * an item id.
 */
export function withdrawPath(draft: CollationDraft, path: string): CollationDraft {
  return draft.filter((item) => item.path !== path);
}

// ── The outbound artifact: exactly what the paper previews and signs ──────────

/**
 * The ordered outbound list — every item as a `DispositionWrite`, IN DRAFT ORDER
 * (not path-sorted: the order is the user's, and it is what leaves). The body is
 * the effective body (refined once present, else raw). The paper renders this list
 * and previews `collationPayload(draft)`, so "what you see is what leaves" holds by
 * construction.
 */
export function collationItems(draft: CollationDraft): DispositionWrite[] {
  return draft.map((item) => ({
    path: item.path,
    type: item.type,
    body: effectiveBody(item),
    ...(item.span && item.side ? { span: item.span, side: item.side } : {}),
  }));
}

/**
 * The canonical outbound bytes — `collationItems` serialised in draft order. This
 * is what the paper signs, byte-for-byte identical to what it previews. Unlike the
 * #17 `batchPayload`, this is ORDER-DEPENDENT: reordering the draft changes the
 * bytes, because the order is a real property of the outbound artifact.
 */
export function collationPayload(draft: CollationDraft): string {
  return JSON.stringify(collationItems(draft));
}
