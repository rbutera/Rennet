import { parseAnchor } from "@rennet/protocol";
import type {
  AnchorSide,
  AnchorSpan,
  Canvas,
  CanvasAngle,
  DispositionType,
  NarrationPlacement,
  Proposal,
  ReviewNarration,
} from "@rennet/types";
import { CANVAS_ANGLES } from "@rennet/types";

// ─────────────────────────────────────────────────────────────────────────────
// Canvas UI logic (issue #11) — pure functions, no React, no DOM.
//
// The rendering surface's behaviour lives here so every product principle is a
// testable function, independent of the components that call it: approve at any
// granularity (fan-out), collapse-is-not-read (coverage), free zoom (reducer),
// the fixed-point lens (rotate + refocus), proposal adjudication (only accept
// creates L2), the amber overlay (never a queue), and the windowed diff envelope.
//
// The UI consumes the #10 `Canvas` shape and never runs the engine projector
// (the `layer:ui` boundary allows only `@rennet/types` + `@rennet/protocol`).
// ─────────────────────────────────────────────────────────────────────────────

// ── Approve at any granularity: one user act fans out to per-anchor L2 ────────

/** The granularity a single approve act is applied at. */
export type ApprovalScope =
  | { kind: "rollup" }
  | { kind: "cohort"; cohortKey: string }
  | { kind: "selection"; elementKeys: string[] }
  | { kind: "anchor"; elementKey: string };

/**
 * One per-anchor L2 disposition write (the `canvas.disposition` command input).
 * `span`/`side` are optional and all-or-none: present ⇒ a span-grained disposition
 * (distinct dispositions coexist per file, keyed by `path#L…@side`); absent ⇒
 * path-grained (one per file), the diff lenses' unchanged behaviour.
 */
export interface DispositionWrite {
  path: string;
  type: DispositionType;
  body: string;
  span?: AnchorSpan;
  side?: AnchorSide;
}

/**
 * The stable identity of a disposition write — path-grained on `path`, span-grained
 * on `path#L<start>-L<end>@<side>`. Mirrors the engine's own `anchorKey` (core), so
 * the local draft keys a write exactly as the engine does: two spans on one file,
 * and a path-grained + a span disposition on the same file, coexist. Replicated
 * here because `@rennet/ui` cannot import `@rennet/core`.
 */
export function anchorPathKey(write: Pick<DispositionWrite, "path" | "span" | "side">): string {
  if (write.span && write.side) {
    const end = write.span.endLine ?? write.span.startLine;
    return `${write.path}#L${write.span.startLine}-L${end}@${write.side}`;
  }
  return write.path;
}

/** chunkId → the file paths that chunk touches (from L0 substrate). */
function chunkPathMap(canvas: Canvas): Map<string, string[]> {
  return new Map(canvas.layers.substrate.chunks.map((chunk) => [chunk.chunkId, chunk.filePaths]));
}

/** hunkId → its containing chunkId (from L0 substrate). */
function hunkChunkMap(canvas: Canvas): Map<string, string> {
  const map = new Map<string, string>();
  for (const chunk of canvas.layers.substrate.chunks) {
    for (const hunkId of chunk.hunkIds) map.set(hunkId, chunk.chunkId);
  }
  return map;
}

/** elementKey → the cohortKey it belongs to (decisions canvas grouping). */
function elementCohortMap(canvas: Canvas): Map<string, string> {
  const map = new Map<string, string>();
  for (const cohort of canvas.layers.analysis.cohorts) {
    for (const key of cohort.elementKeys) map.set(key, cohort.cohortKey);
  }
  return map;
}

/** The chunkId a cohort is about (`cohort:<chunkId>` → `<chunkId>`). */
function cohortChunk(cohortKey: string): string {
  return cohortKey.startsWith("cohort:") ? cohortKey.slice("cohort:".length) : cohortKey;
}

/** Resolve one element to the chunk it lives in (via its cohort, else its anchor). */
function elementChunk(canvas: Canvas, elementKey: string): string | undefined {
  const cohortKey = elementCohortMap(canvas).get(elementKey);
  if (cohortKey) {
    const chunkId = cohortChunk(cohortKey);
    return chunkId.length > 0 ? chunkId : undefined;
  }
  const element = canvas.layers.analysis.elements.find((el) => el.elementKey === elementKey);
  if (!element) return undefined;
  const parsed = parseAnchor(element.anchor);
  if (!parsed.ok) return undefined;
  if (parsed.anchor.kind === "chunk") {
    return chunkPathMap(canvas).has(parsed.anchor.id) ? parsed.anchor.id : undefined;
  }
  if (parsed.anchor.kind === "hunk") return hunkChunkMap(canvas).get(parsed.anchor.id);
  return undefined;
}

/** The distinct target paths a scope resolves to (deterministic, sorted). */
function targetsForScope(canvas: Canvas, scope: ApprovalScope): string[] {
  const chunkPaths = chunkPathMap(canvas);
  const paths = new Set<string>();
  const addChunk = (chunkId: string): void => {
    for (const path of chunkPaths.get(chunkId) ?? []) paths.add(path);
  };
  if (scope.kind === "rollup") {
    for (const chunkId of chunkPaths.keys()) addChunk(chunkId);
  } else if (scope.kind === "cohort") {
    addChunk(cohortChunk(scope.cohortKey));
  } else {
    const keys = scope.kind === "anchor" ? [scope.elementKey] : scope.elementKeys;
    for (const key of keys) {
      const chunkId = elementChunk(canvas, key);
      if (chunkId) {
        addChunk(chunkId);
      } else {
        // A flat doc-angle element (spec/claims/noise) has no code chunk; the
        // element's own anchor is its disposition key.
        const element = canvas.layers.analysis.elements.find((el) => el.elementKey === key);
        if (element) paths.add(element.anchor);
      }
    }
  }
  return [...paths].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

/**
 * Fan a single approve act out to the per-anchor L2 disposition writes it covers.
 * A cohort/roll-up/selection is ONE user act; the writes are the several anchors
 * it touches — proving "approve the whole group at a time, or partials of it" is
 * one act, not N clicks.
 */
export function fanOutApproval(
  canvas: Canvas,
  scope: ApprovalScope,
  type: DispositionType,
  body = "",
): DispositionWrite[] {
  return targetsForScope(canvas, scope).map((path) => ({ path, type, body }));
}

// ── Collapse is not read: coverage is an action count, not a view-state count ──

export interface Coverage {
  total: number;
  read: number;
  unread: number;
}

/**
 * Coverage over a canvas: `total` distinct substrate paths, `read` the ones a
 * disposition covers, `unread` the rest. It is a pure function of substrate +
 * dispositions and does NOT take cohort-expansion state, so collapsing a cohort
 * can never mark its content read — the totality/residue guarantee (OQ4).
 */
export function canvasCoverage(canvas: Canvas): Coverage {
  const paths = new Set(canvas.layers.substrate.chunks.flatMap((chunk) => chunk.filePaths));
  const disposed = new Set(canvas.layers.disposition.dispositions.map((d) => d.anchor.path));
  let read = 0;
  for (const path of paths) if (disposed.has(path)) read += 1;
  return { total: paths.size, read, unread: paths.size - read };
}

// ── Free zoom: roll-up → cohort → element → diff, both directions ─────────────

export type ZoomLevel = "rollup" | "cohort" | "element" | "diff";

export interface ZoomState {
  level: ZoomLevel;
  cohortKey?: string;
  elementKey?: string;
}

export type ZoomAction =
  | { type: "enterCohort"; cohortKey: string }
  | { type: "enterElement"; elementKey: string }
  | { type: "openDiff" }
  | { type: "zoomIn" }
  | { type: "zoomOut" };

const ZOOM_ORDER: ZoomLevel[] = ["rollup", "cohort", "element", "diff"];

/** Deterministic zoom transitions. Keyboard handlers dispatch these actions. */
export function zoomReducer(state: ZoomState, action: ZoomAction): ZoomState {
  switch (action.type) {
    case "enterCohort":
      return { level: "cohort", cohortKey: action.cohortKey };
    case "enterElement":
      return { ...state, level: "element", elementKey: action.elementKey };
    case "openDiff":
      return { ...state, level: "diff" };
    case "zoomIn": {
      const next = ZOOM_ORDER[Math.min(ZOOM_ORDER.indexOf(state.level) + 1, ZOOM_ORDER.length - 1)];
      return { ...state, level: next ?? state.level };
    }
    case "zoomOut": {
      const previous = ZOOM_ORDER[Math.max(ZOOM_ORDER.indexOf(state.level) - 1, 0)];
      return { ...state, level: previous ?? state.level };
    }
  }
}

// ── Roll-up narration: the zoom ladder's own voice at the matching altitude ───

/**
 * Resolve the narration placement for the CURRENT zoom level (issue #70). The
 * narrated account is shown at the altitude it accounts for: the whole-changeset
 * roll-up at `rollup` zoom, the cohort's account at `cohort` zoom. Below a cohort
 * (`element`/`diff`) narration is not the surface's concern (the CodeView and its
 * inhabited marks are), so this returns `undefined` there.
 *
 * A cohort with no placement resolves to `pending` rather than `undefined`, so a
 * visible cohort node is NEVER silently blank — the acceptance floor holds even if
 * the delivered map is missing a key.
 */
export function narrationForZoom(
  narration: ReviewNarration | undefined,
  zoom: ZoomState,
): NarrationPlacement | undefined {
  if (!narration) return undefined;
  if (zoom.level === "rollup") return narration.rollup;
  if (zoom.level === "cohort" && zoom.cohortKey) {
    return narration.cohorts[zoom.cohortKey] ?? { status: "pending" };
  }
  return undefined;
}

// ── The fixed-point lens: five angles, cursor hunk survives rotation ──────────

/** The five selectable canvas lenses. Blast-radius is an overlay, never here. */
export const CANVAS_LENSES: readonly CanvasAngle[] = CANVAS_ANGLES;

/** Rotate the active lens across the five angles (wrapping), either direction. */
export function rotateLens(current: CanvasAngle, dir: 1 | -1): CanvasAngle {
  const index = CANVAS_LENSES.indexOf(current);
  const base = index === -1 ? 0 : index;
  const next = (base + dir + CANVAS_LENSES.length) % CANVAS_LENSES.length;
  return CANVAS_LENSES[next] ?? current;
}

/**
 * The fixed-point rule: after a lens rotation, re-center on the hunk that was
 * under the cursor. Given the cursor's anchor, return the element on the new
 * canvas carrying that anchor (or undefined if the new canvas does not cover it).
 * The cursor anchor itself is preserved by the caller; this only resolves where
 * to land.
 */
export function refocusCursor(
  canvas: Canvas,
  cursorAnchor: string | undefined,
): string | undefined {
  if (!cursorAnchor) return undefined;
  return canvas.layers.analysis.elements.find((el) => el.anchor === cursorAnchor)?.elementKey;
}

/**
 * The view state to land on after a lens rotation. The fixed-point rule: if the
 * hunk under the cursor exists on the new canvas, re-center on that element (zoom
 * to element); otherwise fall back to the roll-up. Preserving the cursor anchor
 * itself is the store's job (rotation never clears it) — this resolves WHERE the
 * rotated view lands so the hunk under the cursor does not move off screen.
 */
export function viewAfterRotate(
  canvas: Canvas,
  cursorAnchor: string | undefined,
): { selection?: string; zoom: ZoomState } {
  const elementKey = refocusCursor(canvas, cursorAnchor);
  if (elementKey) return { selection: elementKey, zoom: { level: "element", elementKey } };
  return { zoom: { level: "rollup" } };
}

// ── Keyboard region: canvas shortcuts must yield to text editing ──────────────

/**
 * Whether an event target is a text-editing surface (a form field or a
 * contenteditable node). The canvas keyboard region ([ ] rotate, l/h zoom) must
 * yield to editing: a keydown that originates in the proposal-edit textarea is
 * the user typing, not a canvas command, and must pass through untouched.
 */
export function isEditableTarget(
  target: { tagName?: string; isContentEditable?: boolean } | null | undefined,
): boolean {
  if (!target) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

// ── Proposal adjudication: only acceptance creates L2 ─────────────────────────

/** The outcome of adjudicating an orchestrator proposal. */
export type Adjudication =
  | { kind: "dismiss"; proposalId: string }
  | {
      kind: "accept-disposition";
      proposalId: string;
      path: string;
      type: DispositionType;
      body: string;
    }
  | { kind: "accept-structural"; proposalId: string };

/**
 * Adjudicate an orchestrator proposal. Dismiss is L3-only. Accepting a
 * `disposition` proposal is the ONLY path that creates L2 — and edit-then-accept
 * is first-class: an edited body replaces the proposed one. Accepting a
 * `regroup`/`split` proposal is structural (never an L2 disposition).
 */
export function adjudicateProposal(
  proposal: Proposal,
  outcome: "accepted" | "dismissed",
  editedBody?: string,
  type: DispositionType = "approve",
): Adjudication {
  if (outcome === "dismissed") return { kind: "dismiss", proposalId: proposal.proposalId };
  if (proposal.kind === "disposition") {
    return {
      kind: "accept-disposition",
      proposalId: proposal.proposalId,
      path: proposal.target,
      type,
      body: editedBody ?? proposal.payload,
    };
  }
  return { kind: "accept-structural", proposalId: proposal.proposalId };
}

/**
 * Resolve an adjudicated proposal off the canvas. Once accepted or dismissed, an
 * orchestrator proposal leaves L3 (accept has already produced its L2 write via
 * the disposition fan-out, if any). A no-op for an unknown id — never a wipe.
 */
export function withoutProposal(canvas: Canvas, proposalId: string): Canvas {
  return {
    ...canvas,
    layers: {
      ...canvas.layers,
      annotation: {
        ...canvas.layers.annotation,
        proposals: canvas.layers.annotation.proposals.filter(
          (proposal) => proposal.proposalId !== proposalId,
        ),
      },
    },
  };
}

// ── The amber blast-radius overlay: paint, never a queue ──────────────────────
//
// Blast radius is PAINT (Rule Zero / Canvas Paradigm §1): it marks risk on the
// surface the reviewer is already reading. It never gates, never reorders the
// canvas, never becomes a queue. The deterministic signals (issue #35) each carry
// a one-line `reason` rendered next to the mark, and the DEFERRED signals
// (`assessed: false`) are surfaced as visible chips — because a reviewer who
// cannot see that a signal was NOT run would assume it was.

/** The set of targets the blast-radius overlay paints amber onto this canvas. */
export function blastPaint(canvas: Canvas): Set<string> {
  return new Set(canvas.overlay.filter((paint) => paint.assessed !== false).map((p) => p.target));
}

/** Whether a given element/anchor target carries blast-radius amber paint. */
export function isPainted(canvas: Canvas, target: string): boolean {
  return canvas.overlay.some((paint) => paint.target === target && paint.assessed !== false);
}

/**
 * The chunk ids the overlay paints, resolving BOTH `rennet:chunk/<id>` targets
 * (direct) AND `rennet:file/<path>` targets (issue #35's file-level signals) via
 * the substrate: a chunk is painted when any file it covers is targeted. Deferred
 * (not-assessed) markers and the review-scoped target paint no chunk.
 */
export function paintedChunkIds(canvas: Canvas): Set<string> {
  const chunkTargets = new Set<string>();
  const fileTargets = new Set<string>();
  for (const paint of canvas.overlay) {
    if (paint.assessed === false) continue;
    if (paint.target.startsWith("rennet:chunk/")) {
      chunkTargets.add(paint.target.slice("rennet:chunk/".length));
    } else if (paint.target.startsWith("rennet:file/")) {
      fileTargets.add(paint.target.slice("rennet:file/".length));
    }
  }
  const painted = new Set(chunkTargets);
  for (const chunk of canvas.layers.substrate.chunks) {
    if (chunk.filePaths.some((path) => fileTargets.has(path))) painted.add(chunk.chunkId);
  }
  return painted;
}

/** One reason line per painted chunk id, joined when several signals fired. */
export function blastReasonsByChunk(canvas: Canvas): Map<string, string> {
  const fileReasons = new Map<string, string[]>();
  const chunkReasons = new Map<string, string[]>();
  for (const paint of canvas.overlay) {
    if (paint.assessed === false || !paint.reason) continue;
    if (paint.target.startsWith("rennet:chunk/")) {
      const id = paint.target.slice("rennet:chunk/".length);
      chunkReasons.set(id, [...(chunkReasons.get(id) ?? []), paint.reason]);
    } else if (paint.target.startsWith("rennet:file/")) {
      const path = paint.target.slice("rennet:file/".length);
      fileReasons.set(path, [...(fileReasons.get(path) ?? []), paint.reason]);
    }
  }
  const byChunk = new Map<string, string>();
  for (const chunk of canvas.layers.substrate.chunks) {
    const reasons = [...(chunkReasons.get(chunk.chunkId) ?? [])];
    for (const path of chunk.filePaths) reasons.push(...(fileReasons.get(path) ?? []));
    if (reasons.length > 0) byChunk.set(chunk.chunkId, reasons.join(" "));
  }
  return byChunk;
}

/**
 * The substrate chunk id an element anchor lives in, for resolving blast-radius
 * paint on a FLAT canvas (sequence) the SAME way the decisions canvas does: a
 * `chunk/<id>` anchor names its chunk directly; a `hunk/<id>` anchor resolves
 * through its containing chunk. Anything else (a `doc/<id>` anchor on spec/claims/
 * noise, an unknown id) has no code chunk and returns undefined — so blast amber,
 * which is file/chunk-grained, never lands on a document element. A chunk id absent
 * from the substrate (a proposal chunk) is returned as-is and simply matches no
 * painted chunk, so it never false-paints.
 */
export function anchorChunkId(canvas: Canvas, anchor: string): string | undefined {
  const parsed = parseAnchor(anchor);
  if (!parsed.ok) return undefined;
  if (parsed.anchor.kind === "chunk") return parsed.anchor.id;
  if (parsed.anchor.kind === "hunk") return hunkChunkMap(canvas).get(parsed.anchor.id);
  return undefined;
}

/** The deferred (NOT ASSESSED) signals on this canvas, surfaced as visible chips. */
export function blastNotAssessed(canvas: Canvas): { signal: string; reason: string }[] {
  return canvas.overlay
    .filter((paint) => paint.assessed === false)
    .map((paint) => ({ signal: paint.signal ?? "unknown", reason: paint.reason ?? "" }))
    .sort((left, right) => (left.signal < right.signal ? -1 : left.signal > right.signal ? 1 : 0));
}

// ── The windowed diff (R16): a bounded node-count envelope ────────────────────

/**
 * The per-row node cost of the windowed CodeView (a row is a gutter cell + a
 * line-number cell + the code text). The envelope is the ceiling on rendered DOM
 * nodes at any scroll position — well under the naive per-line explosion the
 * Pierre spike measured for a full render (97,139 nodes / 493ms).
 */
export const NODES_PER_ROW = 4;
export const MAX_RENDERED_NODES = 4000;

export interface WindowInput {
  total: number;
  rowHeight: number;
  viewportHeight: number;
  scrollTop: number;
  overscan?: number;
}

export interface WindowRange {
  start: number;
  end: number;
}

/**
 * The visible row range for the current scroll position, clamped to the file
 * bounds and padded by `overscan`. The window is a slice around the viewport, so
 * the rendered node count stays inside `MAX_RENDERED_NODES` no matter how long
 * the diff is — the R16 discipline (CodeView never renders the naive full tree).
 */
export function windowRows(input: WindowInput): WindowRange {
  const overscan = input.overscan ?? 6;
  const visibleRows = Math.ceil(input.viewportHeight / input.rowHeight);
  // Clamp the first visible row so an over-scroll (scrollTop past the end) lands
  // on the last page rather than inflating the window past the file bounds.
  const maxFirst = Math.max(0, input.total - visibleRows);
  const first = Math.min(Math.max(0, Math.floor(input.scrollTop / input.rowHeight)), maxFirst);
  const start = Math.max(0, first - overscan);
  const end = Math.min(input.total, first + visibleRows + overscan);
  return { start, end };
}
