import type { AnchorSpan, Canvas, Disposition, DispositionType } from "@rennet/types";
import { type ApprovalScope, type DispositionWrite, fanOutApproval } from "./logic";

// ─────────────────────────────────────────────────────────────────────────────
// Disposition authoring depth (issue #17) — pure functions, no React, no DOM.
//
// #11 shipped the canvas surface and the group-act fan-out (`fanOutApproval`).
// This module is the user-sovereign authoring DEPTH #11 left for #17: authoring at
// EVERY altitude of the zoom ladder with a traceable act→writes fan-out, the raw
// draft body (lazy/vague is the SUPPORTED path), the batch view that is exactly
// the publish/handoff payload (edit / withdraw-with-zero-residue), and the
// orphaned-disposition set on a patchset advance.
//
// The `layer:ui` boundary allows only `@rennet/types` + this package: nothing here
// imports `@rennet/core`. Every altitude resolves to file-path L2 writes (slice-1
// `Disposition` anchors on a path); the finer altitude lives in the trace.
// ─────────────────────────────────────────────────────────────────────────────

// ── Author at every granularity: one act, traced to its per-anchor L2 writes ──

/** The altitude a single authoring act is applied at (the #11 zoom ladder). */
export type Granularity = "line" | "hunk" | "symbol" | "element" | "cohort" | "rollup";

/**
 * An authoring act. Each altitude names what it targets; `type` is the
 * disposition (approve/request-change/comment/question) and `body` is the raw,
 * sovereign body (lazy/vague supported, carried verbatim, never validated here).
 */
export type AuthoringAct =
  | { granularity: "rollup"; type: DispositionType; body?: string }
  | { granularity: "cohort"; cohortKey: string; type: DispositionType; body?: string }
  | { granularity: "element"; elementKey: string; type: DispositionType; body?: string }
  | { granularity: "symbol"; elementKey: string; type: DispositionType; body?: string }
  | { granularity: "hunk"; hunkId: string; type: DispositionType; body?: string }
  | {
      granularity: "line";
      hunkId: string;
      span: AnchorSpan;
      type: DispositionType;
      body?: string;
    };

/**
 * The trace binding ONE user act to the several per-anchor L2 writes it produced.
 * `source` records WHAT was acted on (rollup, a cohortKey, an elementKey, a
 * hunkId, or a hunk:line-span), so a cohort/roll-up act is provably one act, not
 * N clicks. This is the assertable form of "approve at any granularity".
 */
export interface AuthoringTrace {
  granularity: Granularity;
  source: string;
  writes: DispositionWrite[];
}

export interface AuthoredResult {
  writes: DispositionWrite[];
  trace: AuthoringTrace;
}

/** hunkId → the file paths of its containing chunk (from the L0 substrate). */
function pathsForHunk(canvas: Canvas, hunkId: string): string[] {
  for (const chunk of canvas.layers.substrate.chunks) {
    if (chunk.hunkIds.includes(hunkId)) {
      return [...chunk.filePaths].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
    }
  }
  return [];
}

function spanSource(hunkId: string, span: AnchorSpan): string {
  return span.endLine !== undefined
    ? `${hunkId}:L${span.startLine}-${span.endLine}`
    : `${hunkId}:L${span.startLine}`;
}

/**
 * Resolve an authoring act to its per-anchor L2 writes plus a trace. Roll-up /
 * cohort / element / symbol reuse #11's `fanOutApproval` (the seam); hunk / line
 * resolve the hunk → its containing chunk → the chunk's file paths. A group act is
 * ONE user act; the writes are the several anchors it covers.
 */
export function authorDisposition(canvas: Canvas, act: AuthoringAct): AuthoredResult {
  const body = act.body ?? "";
  const fromScope = (scope: ApprovalScope, source: string): AuthoredResult => {
    const writes = fanOutApproval(canvas, scope, act.type, body);
    return { writes, trace: { granularity: act.granularity, source, writes } };
  };
  const fromPaths = (paths: string[], source: string): AuthoredResult => {
    const writes = paths.map((path) => ({ path, type: act.type, body }));
    return { writes, trace: { granularity: act.granularity, source, writes } };
  };

  switch (act.granularity) {
    case "rollup":
      return fromScope({ kind: "rollup" }, "rollup");
    case "cohort":
      return fromScope({ kind: "cohort", cohortKey: act.cohortKey }, act.cohortKey);
    case "element":
    case "symbol":
      // A symbol is an element altitude; both resolve through the element's chunk.
      // The distinction is the trace label, never a different set of L2 writes.
      return fromScope({ kind: "anchor", elementKey: act.elementKey }, act.elementKey);
    case "hunk":
      return fromPaths(pathsForHunk(canvas, act.hunkId), act.hunkId);
    case "line":
      return fromPaths(pathsForHunk(canvas, act.hunkId), spanSource(act.hunkId, act.span));
  }
}

// ── The raw-draft batch: exactly what will publish or hand off ────────────────

/**
 * A staged disposition. `raw` is the user's sovereign body — lazy/vague/half-
 * formed is supported and carried verbatim; nothing refines it here.
 *
 * #19 seam: the comment-refinement loop will add `refined` / `published` forms and
 * an inline clarification thread alongside `raw`; `raw` stays sovereign and the
 * effective body until a user adjudication makes a refined body effective. This
 * slice is raw-only by design.
 */
export interface DispositionDraft {
  path: string;
  type: DispositionType;
  raw: string;
}

export type DispositionBatch = DispositionDraft[];

/** Turn an authored act's per-anchor writes into staged drafts. */
export function draftsFromAuthored(authored: AuthoredResult): DispositionDraft[] {
  return authored.writes.map((write) => ({ path: write.path, type: write.type, raw: write.body }));
}

/**
 * Add drafts to the batch, UPSERTING by path — a later act on a path replaces the
 * earlier draft, exactly as the engine's `DispositionSet` replaces by path. So
 * staging a roll-up then a specific element behaves identically to the engine.
 */
export function addToBatch(batch: DispositionBatch, drafts: DispositionDraft[]): DispositionBatch {
  const byPath = new Map(batch.map((draft) => [draft.path, draft]));
  for (const draft of drafts) byPath.set(draft.path, draft);
  return [...byPath.values()];
}

/** Edit a staged draft's raw body (no-op if the path is not staged). */
export function editDraftBody(
  batch: DispositionBatch,
  path: string,
  raw: string,
): DispositionBatch {
  return batch.map((draft) => (draft.path === path ? { ...draft, raw } : draft));
}

/** Edit a staged draft's disposition type (no-op if the path is not staged). */
export function editDraftType(
  batch: DispositionBatch,
  path: string,
  type: DispositionType,
): DispositionBatch {
  return batch.map((draft) => (draft.path === path ? { ...draft, type } : draft));
}

/**
 * Withdraw a staged draft before publish. It is removed ENTIRELY, so its bytes
 * vanish from the payload — no residue, no tombstone, nothing to leak into the PR.
 */
export function withdrawDraft(batch: DispositionBatch, path: string): DispositionBatch {
  return batch.filter((draft) => draft.path !== path);
}

/**
 * The exact publish/handoff payload as a list, sorted by path for determinism.
 * This is the `DispositionWrite` shape (`raw` → `body`); the batch VIEW renders
 * this same derived list, so "view bytes == payload bytes" holds by construction.
 */
export function batchViewModel(batch: DispositionBatch): DispositionWrite[] {
  return batch
    .map((draft) => ({ path: draft.path, type: draft.type, body: draft.raw }))
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}

/** The canonical bytes that will publish (someone else's PR) or hand off (own branch). */
export function batchPayload(batch: DispositionBatch): string {
  return JSON.stringify(batchViewModel(batch));
}

/**
 * A pure, dependency-free digest of the batch payload (FNV-1a over the canonical
 * bytes). Order-independent because it hashes the SORTED payload, so a reordered
 * batch digests identically. No node:crypto — this is a browser package.
 */
export function batchPayloadDigest(batch: DispositionBatch): string {
  const bytes = batchPayload(batch);
  let hash = 0x811c9dc5;
  for (let index = 0; index < bytes.length; index += 1) {
    hash ^= bytes.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

// ── Orphaned dispositions: a failed carry surfaces, never vanishes ────────────

/** A disposition dropped by a patchset advance (surfaced in the orphan tray). */
export type OrphanedDisposition = Disposition;

function anchorKey(disposition: Disposition): string {
  return `${disposition.anchor.path} ${disposition.anchor.contentDigest}`;
}

/**
 * The dispositions present BEFORE a patchset activation and absent AFTER — exactly
 * the ones the engine's conservative byte-identical carry dropped (a changed,
 * renamed, or removed file fails closed). A pure set difference on the two review
 * disposition lists, keyed by anchor path + content digest: no core-private carry
 * logic and no patch text, so it stays inside the `layer:ui` boundary.
 */
export function orphanedDispositions(
  before: Disposition[],
  after: Disposition[],
): OrphanedDisposition[] {
  const carried = new Set(after.map(anchorKey));
  return before.filter((disposition) => !carried.has(anchorKey(disposition)));
}
