import type {
  AnalysisCohort,
  AnalysisElement,
  Canvas,
  CanvasAngle,
  Decomposition,
  Disposition,
  Hunk,
  Review,
  RspProvenance,
} from "@rennet/types";
import type {
  CanvasOpsBackend,
  CanvasOpsEffect,
  DiffHit,
  ElementDetail,
  HunkDetail,
  OpsFreshness,
  ReviewIdentity,
  RunLedgerEntry,
  ThreadDetail,
  ViewState,
} from "./canvas-ops";
import type { ReviewPipelineResult } from "./pipeline";
import { buildRoutePlan, type RoutePlanOptions } from "./route-plan";

// ─────────────────────────────────────────────────────────────────────────────
// The production `CanvasOpsBackend` core (issue #13 — the live end-to-end review).
//
// `reviewBackendCore(state)` is the PURE half of the two-layer production backend:
// every `CanvasOpsBackend` accessor EXCEPT the store-backed Repo-Map reads
// (`projectMap` / `fileContext` / `novelty`, the symbolic surface
// `fileOverview` / `symbolDefinition`, and the model-backed `knowledge`). It is a
// pure function of the live `Review` + the `buildReviewCanvases` result + recorded
// run state — no store, no Node, no I/O — so `core` stays node-free and the
// dependency arrows hold (`core` must not import `adapters`). The desktop
// composition root spreads this with `projectContextBackend` / `noveltyBackend` /
// `knowledgeBackend` (the injected store-backed slices) into ONE `CanvasOpsBackend`.
//
// Honesty over completeness (Rule 75, the "never a fake" vital circuit):
//   - canvas / angles / decomposition / element / hunk / searchDiff come straight
//     from the built canvases + the captured decomposition — always real for a
//     real review.
//   - runLedger / provenance are DISTINGUISHED-EMPTY in v1 (`total: 0` /
//     `undefined`), never a fabricated ledger row. A follow-up lights up the full
//     per-run ledger; until then "nothing recorded yet" is the honest answer.
//   - thread is `undefined` when no clarification thread was recorded (the tool
//     surfaces it as a distinguished nothing-found, never an empty-looking fake).
//   - applyEffects forwards the (structurally L2-free) effect union to an injected
//     sink; the pure core never mutates a store.
// ─────────────────────────────────────────────────────────────────────────────

/** The accessors the pure core supplies — everything but the store-backed Repo-Map reads. */
export type ReviewBackendCore = Omit<
  CanvasOpsBackend,
  "projectMap" | "fileContext" | "novelty" | "fileOverview" | "symbolDefinition" | "knowledge"
>;

/**
 * The live review state the core reads through. `pipeline` is the
 * `buildReviewCanvases` result (canvases by angle, the captured decomposition,
 * admitted docs, the route plan). Everything else is optional with an honest
 * default so a minimal caller (the wave's fixture) needs only `review` +
 * `pipeline`.
 */
export interface ReviewBackendState {
  /** The live review (identity, dispositions, repo, active patchset id). */
  readonly review: Review;
  /** The `buildReviewCanvases` result — canvases, decomposition, route plan. */
  readonly pipeline: ReviewPipelineResult;
  /**
   * Which canvas angle is "open" (read-only deixis). Defaults to the first
   * present angle in a stable canonical order.
   */
  readonly activeAngle?: CanvasAngle;
  /**
   * The freshness verdict every reply carries (R30 at the reply). Defaults to
   * `current` — the canvases were built over the active patchset. A composition
   * root that knows a re-capture is in flight may pass `stale`.
   */
  readonly freshness?: OpsFreshness;
  /** The recorded run-ledger rows. v1 default: none recorded (distinguished-empty). */
  readonly runLedger?: readonly RunLedgerEntry[];
  /** Per-doc RSP provenance recorded for the run. v1 default: none recorded. */
  readonly provenanceByDoc?: ReadonlyMap<string, RspProvenance>;
  /** RoutePlan budget options for `planRecompute` (the #8 Brita gate). */
  readonly routePlanOptions?: RoutePlanOptions;
  /**
   * The sink the (L3/presentational/recompute) effects a write op emits are
   * routed to. Defaults to a no-op — the pure core never touches a store; a live
   * composition root wires a real sink (persist canvas events, focus the UI,
   * enqueue a recompute).
   */
  readonly applyEffects?: (effects: readonly CanvasOpsEffect[]) => void;
}

/** A stable canonical angle order for choosing a default active canvas. */
const ANGLE_ORDER: readonly CanvasAngle[] = [
  "flagged",
  "decisions",
  "spec",
  "sequence",
  "claims",
  "noise",
];

/** All built canvases as an array, in canonical angle order. */
function canvasList(pipeline: ReviewPipelineResult): Canvas[] {
  const out: Canvas[] = [];
  for (const angle of ANGLE_ORDER) {
    const canvas = pipeline.canvases[angle];
    if (canvas) out.push(canvas);
  }
  return out;
}

/** The angles actually present in the built canvases, in canonical order. */
function presentAngles(pipeline: ReviewPipelineResult): CanvasAngle[] {
  return ANGLE_ORDER.filter((angle) => pipeline.canvases[angle] !== undefined);
}

/** The default active angle: the caller's choice, else the first present angle. */
function resolveActiveAngle(state: ReviewBackendState): CanvasAngle | undefined {
  if (state.activeAngle && state.pipeline.canvases[state.activeAngle]) return state.activeAngle;
  return presentAngles(state.pipeline)[0];
}

/** Render a hunk's captured lines as a readable unified block (real bytes, not a fixture). */
function renderHunk(hunk: Hunk): string {
  const header = `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`;
  const body = [
    ...hunk.contextLines.map((line) => ` ${line}`),
    ...hunk.deletedLines.map((line) => `-${line}`),
    ...hunk.addedLines.map((line) => `+${line}`),
  ];
  return [header, ...body].join("\n");
}

/** Dispositions anchored to a file path (the disposition layer's own path grain). */
function dispositionsForPath(
  dispositions: readonly Disposition[],
  filePath: string,
): Disposition[] {
  return dispositions.filter((d) => d.anchor.path === filePath);
}

/**
 * Build the pure core of a production `CanvasOpsBackend`: every accessor over the
 * live review state EXCEPT the store-backed `projectMap` / `fileContext` /
 * `novelty` reads (which the composition root spreads in from the adapters).
 */
export function reviewBackendCore(state: ReviewBackendState): ReviewBackendCore {
  const { review, pipeline } = state;
  const canvases = canvasList(pipeline);
  const byCanvasId = new Map<string, Canvas>(canvases.map((c) => [c.canvasId, c]));
  const activeAngle = resolveActiveAngle(state);
  const activeCanvas = activeAngle ? pipeline.canvases[activeAngle] : undefined;
  const decomposition: Decomposition = pipeline.decomposition;
  const hunksById = new Map<string, Hunk>(decomposition.hunks.map((h) => [h.id, h]));
  const classificationBySymbol = new Map<string, string>(
    decomposition.classifications.map((c) => [c.hunkId, c.enclosingSymbol]),
  );

  const resolveCanvas = (canvasId?: string): Canvas | undefined =>
    canvasId === undefined ? activeCanvas : byCanvasId.get(canvasId);

  const findElement = (ref: string): { canvas: Canvas; element: AnalysisElement } | undefined => {
    for (const canvas of canvases) {
      const element = canvas.layers.analysis.elements.find((e) => e.elementKey === ref);
      if (element) return { canvas, element };
    }
    return undefined;
  };

  const findCohort = (ref: string): AnalysisCohort | undefined => {
    for (const canvas of canvases) {
      const cohort = canvas.layers.analysis.cohorts.find((c) => c.cohortKey === ref);
      if (cohort) return cohort;
    }
    return undefined;
  };

  const resolveHunk = (ref: string): Hunk | undefined => {
    // Accept a bare hunk id, a `rennet:hunk/<id>` anchor, or a file path (first hunk).
    const direct = hunksById.get(ref);
    if (direct) return direct;
    const anchorMatch = /(?:^|[/:])hunk\/(.+)$/.exec(ref);
    if (anchorMatch?.[1]) {
      const byAnchor = hunksById.get(anchorMatch[1]);
      if (byAnchor) return byAnchor;
    }
    return decomposition.hunks.find((h) => h.filePath === ref);
  };

  return {
    identity: (): ReviewIdentity => ({
      repo: review.repositoryRoot,
      reviewId: review.id,
      patchsetId: review.activePatchsetId,
    }),

    freshness: (): OpsFreshness => state.freshness ?? "current",

    angles: (): readonly CanvasAngle[] => presentAngles(pipeline),

    canvas: resolveCanvas,

    view: (): ViewState => ({
      openCanvasId: activeCanvas?.canvasId,
      angle: activeAngle,
      expandedCohorts: [],
      selection: undefined,
    }),

    element: (ref: string): ElementDetail | undefined => {
      const hit = findElement(ref);
      if (hit) {
        const { canvas, element } = hit;
        return {
          refKind: "element",
          ref,
          element,
          body: element.decision
            ? { title: element.title, decision: element.decision }
            : { title: element.title },
          provenancePointer: element.docId,
          blastRadius: canvas.overlay.some((paint) => paint.target === ref),
        };
      }
      const cohort = findCohort(ref);
      if (cohort) return { refKind: "cohort", ref, body: cohort };
      for (const canvas of canvases) {
        const annotation = canvas.layers.annotation.annotations.find((a) => a.annotationId === ref);
        if (annotation) return { refKind: "annotation", ref, annotation, body: annotation.body };
      }
      return undefined;
    },

    // No first-class clarification-thread store in v1: an honest nothing-found
    // (the tool surfaces `undefined` as a distinguished empty, never a fake).
    thread: (): ThreadDetail | undefined => undefined,

    hunk: (ref: string): HunkDetail | undefined => {
      const hunk = resolveHunk(ref);
      if (!hunk) return undefined;
      return {
        ref,
        hunkId: hunk.id,
        file: hunk.filePath,
        content: renderHunk(hunk),
        // A fresh review (no prior patchset) carries no carry lineage — every hunk
        // is new. Carry/lineage is a re-capture concept (issue #78), not v1.
        lineage: "new",
        dispositions: dispositionsForPath(review.dispositions, hunk.filePath),
      };
    },

    searchDiff: (query: string): readonly DiffHit[] => {
      const needle = query.toLowerCase();
      const hits: DiffHit[] = [];
      const seen = new Set<string>();
      for (const hunk of decomposition.hunks) {
        const symbol = classificationBySymbol.get(hunk.id) ?? "";
        const hay = `${hunk.filePath}\n${symbol}`.toLowerCase();
        if (!hay.includes(needle)) continue;
        const anchor = `rennet:hunk/${hunk.id}`;
        if (seen.has(anchor)) continue;
        seen.add(anchor);
        hits.push({ anchor, kind: "hunk", file: hunk.filePath });
      }
      return hits;
    },

    decomposition: (): Decomposition => decomposition,

    // Distinguished-empty in v1 (never a fabricated ledger row). A filter over an
    // empty ledger is still empty; the tool paginates to `total: 0`.
    runLedger: (filter?: string): readonly RunLedgerEntry[] => {
      const rows = state.runLedger ?? [];
      if (!filter) return rows;
      return rows.filter((row) => row.purpose === filter || row.runId === filter);
    },

    provenance: (docId: string): RspProvenance | undefined => state.provenanceByDoc?.get(docId),

    // The #8 Brita budget gate over the live decomposition. The `scope`/`angle`
    // args name the recompute target; the budget verdict is a pure function of the
    // decomposition, so a real refusal rides back before any model runs.
    planRecompute: () => buildRoutePlan(decomposition, state.routePlanOptions),

    applyEffects: (effects) => {
      state.applyEffects?.(effects);
    },
  };
}
