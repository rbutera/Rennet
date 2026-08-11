import { parseAnchor, type RennetBridge } from "@rennet/protocol";
import type {
  Canvas,
  CanvasAngle,
  CanvasChangeNotification,
  DecisionsRunStatus,
  DispositionType,
  ElementDiff,
  FlaggedReview,
  NoiseReview,
  OpenSpecChange,
  Proposal,
  ReviewNarration,
} from "@rennet/types";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import {
  type AuthoringAct,
  authorDisposition,
  type DispositionBatch,
  type OrphanedDisposition,
} from "../canvas/authoring";
import { type CounterpartTarget, resolveCounterpart } from "../canvas/counterpart";
import type { CanvasFeedSource } from "../canvas/feed";
import { useCanvasFeed } from "../canvas/feed";
import { buildFlaggedIndex } from "../canvas/flagged";
import { buildHypothesisFrame } from "../canvas/hypothesis";
import {
  type Adjudication,
  type ApprovalScope,
  adjudicateProposal,
  type DispositionWrite,
  fanOutApproval,
  isEditableTarget,
  narrationForZoom,
  rotateLens,
  viewAfterRotate,
  zoomReducer,
} from "../canvas/logic";
import { buildNoiseIndex } from "../canvas/noise";
import {
  authorOpenSpecDisposition,
  buildOpenSpecView,
  type OpenSpecCoverageIndex,
  type OpenSpecReviewAnchor,
} from "../canvas/openspec";
import type { CoverageMosaic } from "../canvas/read-state";
import { buildRowRegistry, type Mark, placeMarks } from "../canvas/registrar";
import { createViewStore, useViewStore, type ViewStore } from "../canvas/store";
import type { SymbolInspection, SymbolLookupPort } from "../canvas/symbol";
import { BatchView } from "./batch-view";
import { CodeView } from "./code-view";
import { CoverageMosaicView } from "./coverage";
import { DecisionsCanvas } from "./decisions";
import { type DeepReviewControl, FlaggedLens } from "./flagged";
import { FlatCanvas } from "./flat";
import { GranularityAuthor, type GranularityContext } from "./granularity-author";
import { HypothesisReadingFrame } from "./hypothesis";
import { AnnotationMark, ProposalMark } from "./l3";
import { LensSwitcher } from "./lens";
import { MarkIndex, type MarkIndexEntry } from "./mark-index";
import { NarrationPanel } from "./narration";
import { NoiseLens } from "./noise";
import { type OpenSpecAskState, OpenSpecView } from "./openspec";
import { OrphanTray } from "./orphan-tray";
import { SymbolInspector } from "./symbol-inspector";

// ─────────────────────────────────────────────────────────────────────────────
// CanvasWorkspace — the container. It holds the ephemeral view store, binds the
// R35 change feed, and renders the active canvas plus its L3 marks. Everything
// under it is a pure presentational component: the container computes derived
// view state and hands children props + callbacks. Fan-out, adjudication, zoom,
// and lens rotation are the pure functions from `canvas/logic`.
// ─────────────────────────────────────────────────────────────────────────────

/** A per-element diff resolver (the real product wires the patchset; demo injects one). */
export type DiffResolver = (elementKey: string) => ElementDiff | undefined;

export interface CanvasWorkspaceProps {
  canvases: Record<CanvasAngle, Canvas>;
  store?: ViewStore;
  /**
   * The resolved app appearance scheme (wireframe #15). The canvas FOLLOWS it —
   * seeded at creation and kept in sync as the app scheme changes (a delayed
   * `settings.get`, a live OS `prefers-color-scheme` flip) — UNTIL the reviewer
   * uses the in-review scheme toggle, after which their explicit choice holds.
   */
  scheme?: "dark" | "light";
  feedSource?: CanvasFeedSource;
  bridge?: RennetBridge;
  /** Fan-out sink: the per-anchor L2 writes a single approve act produced. */
  onDispositions?: (writes: DispositionWrite[]) => void;
  /**
   * A disposition write the engine REJECTED (a real rejection now that
   * `canvas.disposition` is wired — e.g. a Spec anchor whose artifact file is not in
   * the reviewed patchset, or a wrong-`side` span). Surfaced so the host can tell the
   * reviewer their comment did not persist, never silently swallowed. Absent ⇒ the
   * rejection is still logged (never silent), just not host-surfaced.
   */
  onDispositionError?: (write: DispositionWrite, error: Error) => void;
  /** Proposal adjudication sink (accept/dismiss/structural). */
  onAdjudicate?: (adjudication: Adjudication) => void;
  /** Change-feed invalidation hint — where a re-query (TanStack invalidation) slots in. */
  onInvalidate?: (notification: CanvasChangeNotification) => void;
  diffFor?: DiffResolver;
  /**
   * The roll-up narration placed onto the canvases (issue #70), delivered
   * alongside the canvas set. Rendered at the matching zoom altitude (roll-up /
   * cohort). Absent means the pipeline produced no narration — every altitude then
   * shows an honest "narration pending" line, never a silent blank.
   */
  narration?: ReviewNarration;

  /**
   * The Flagged lens's input (issue #138), behind the typed boundary. When the
   * flagged angle is active the lens renders THIS (the automated review layer's
   * findings + dual-review agreement), not the canvas analysis layer. Absent means
   * the review produced no flagged input — the lens then shows the honest empty
   * state, never a silent blank.
   */
  flaggedReview?: FlaggedReview;

  /**
   * The dual-model control (issue #191). Dual is the DEFAULT; when present, the
   * Flagged lens offers a toggle that opts DOWN to the single-Claude quick review
   * (and back), re-running the flagged runner with the chosen mode. Absent ⇒ no
   * affordance (a host with no bridge, the #11 demo, or a test). Additive — the lens
   * is unchanged when it is omitted.
   */
  deepReview?: DeepReviewControl;

  /**
   * The Noise lens's input (issue #34), behind the typed boundary. When the noise
   * angle is active the lens renders THIS (the low-signal churn grouped away, each
   * group tagged rule vs noise job), not the canvas analysis layer. Absent means the
   * review produced no noise input — the lens then shows the honest empty state,
   * never a silent blank.
   */
  noiseReview?: NoiseReview;

  /**
   * The Decisions runner's status (issue #137). The grouped decisions themselves
   * come from the canvas (placed by `projectDecisions`); this thin status only
   * distinguishes a runner that FAILED from a review that ran and discerned
   * nothing. Absent ⇒ `ok` (the live failed signal lands with the live runner).
   */
  decisionsRunStatus?: DecisionsRunStatus;

  /**
   * The parsed OpenSpec change the Spec angle renders (Rai, wireframes #9). When the
   * `spec` angle is active and this is present, the workspace renders the structured
   * `OpenSpecView` (proposal / design / tasks / spec deltas) instead of the flat
   * canvas fallback. Its review affordances (comment / request-change / question)
   * flow through the SAME disposition seam as the diff lenses (`emit`). Absent ⇒ the
   * spec angle falls back to the flat canvas (no change loaded), never a blank.
   */
  openSpecChange?: OpenSpecChange;

  /**
   * The produced hunk↔requirement coverage (Rai, wireframes #9 / R53), keyed by
   * `openSpecRequirementCoverageKey(capability, name)`. When present, each requirement
   * in the Spec view renders its coverage chip (covered-by-N-hunks·M-tests → jumps to
   * the claiming hunk, or an honest amber "unimplemented" for a computed zero). The
   * live `runCoverageMapping` runner produces it over the `openspec.coverage` boundary;
   * the app passes it ONLY on a completed `ok` mapping, so absent ⇒ no chips (no
   * producer, or a failed/uncomputed run) and the view never fabricates coverage.
   */
  openSpecCoverage?: OpenSpecCoverageIndex;

  /**
   * The Spec view's ask surface (issue #139 seam): ask the orchestrator by default,
   * opt in to ask both models, no synthesis. Absent ⇒ the Spec view renders without
   * an ask panel (the disposition verbs still carry the question affordance).
   */
  openSpecAsk?: OpenSpecAskState;

  // ── Authoring depth (issue #17), additive and optional ──────────────────────
  // The dock renders only the sections whose props are supplied, so a host that
  // passes none (like the #11 demo and its tests) gets the surface unchanged.
  /** The current target at each altitude, for the granularity author. */
  granularityContext?: GranularityContext;
  /** An authoring act was raised at some altitude; the workspace fans it out to L2. */
  onAuthor?: (act: AuthoringAct, writes: DispositionWrite[]) => void;
  /** The staged batch — exactly what will publish or hand off. */
  batch?: DispositionBatch;
  onEditDraftBody?: (path: string, raw: string) => void;
  onEditDraftType?: (path: string, type: DispositionType) => void;
  onWithdrawDraft?: (path: string) => void;
  onPublishBatch?: () => void;
  /** Dispositions the last patchset advance dropped (surfaced, never lost). */
  orphans?: OrphanedDisposition[];
  onReauthorOrphan?: (path: string) => void;
  /** The read/skimmed/unread coverage mosaic over the whole changeset. */
  mosaic?: CoverageMosaic;
  onGotoNextUnread?: (fromIndex: number) => void;

  /**
   * The symbol lookup port (Rai, wireframes #8). When present, code identifiers in
   * the diff become clickable and open the in-app SymbolInspector (definitions +
   * references from the model-free symbolic surface). Absent ⇒ identifiers are inert
   * (additive: hosts/tests without a symbolic backend render unchanged).
   */
  symbolLookup?: SymbolLookupPort;
  /**
   * Open a file+line in the reviewer's editor (from the inspector, and the natural
   * home for #7's editor jump too). Absent ⇒ inspector sites are shown but not
   * openable.
   */
  onOpenInEditor?: (path: string, line: number) => void;
}

/** One inspected name in the navigation history: loading, errored, or resolved. */
interface InspectorEntry {
  /** Unique per lookup invocation — settles this entry and only this one, so two
   *  in-flight lookups of the SAME name land on their own entries (never each other's). */
  readonly requestId: number;
  readonly name: string;
  readonly pending: boolean;
  readonly error?: string;
  readonly inspection?: SymbolInspection;
}

/**
 * The inspector's live state (Rai, wireframes #8 + #11). A floating peek is a
 * single-entry history; PINNED, it becomes a mini-browser — `history` is the
 * breadcrumb chain and `cursor` the current crumb, so back / forward / crumb-jump
 * all move the cursor while the diff never moves.
 */
interface SymbolInspectorState {
  readonly pinned: boolean;
  readonly history: readonly InspectorEntry[];
  readonly cursor: number;
}

/**
 * Fill in the result of ONE lookup, matched by its `requestId` — never by name.
 * A response for an entry no longer in history (retargeted / truncated away) is a
 * harmless no-op, and two concurrent lookups of the same name settle their OWN
 * entries rather than the oldest response completing the newest entry.
 */
function applyLookupResult(
  state: SymbolInspectorState,
  requestId: number,
  patch: {
    readonly pending: false;
    readonly inspection?: SymbolInspection;
    readonly error?: string;
  },
): SymbolInspectorState {
  return {
    ...state,
    history: state.history.map((entry) =>
      entry.requestId === requestId ? { ...entry, ...patch } : entry,
    ),
  };
}

function FeedBinder({
  source,
  canvasId,
  onInvalidate,
}: {
  source: CanvasFeedSource;
  canvasId: string;
  onInvalidate?: (notification: CanvasChangeNotification) => void;
}) {
  const notification = useCanvasFeed(source, canvasId);
  useEffect(() => {
    if (notification) onInvalidate?.(notification);
  }, [notification, onInvalidate]);
  return null;
}

const ZOOM_LABELS = {
  rollup: "Roll-up",
  cohort: "Cohort",
  element: "Element",
  diff: "Diff",
} as const;

export function CanvasWorkspace(props: CanvasWorkspaceProps) {
  // Seed the view store's scheme from the app scheme at creation (via a ref, so
  // the store isn't recreated on later scheme changes — the sync effect below
  // handles those without discarding view state).
  const seedSchemeRef = useRef(props.scheme);
  const store = useMemo(
    () =>
      props.store ??
      createViewStore(seedSchemeRef.current ? { scheme: seedSchemeRef.current } : undefined),
    [props.store],
  );
  // The canvas FOLLOWS the app scheme (so the document-root theming reaches the
  // nested `.canvas-app`, incl. a restored review and a live OS change) UNTIL the
  // reviewer explicitly toggles the in-review override, after which it holds.
  const schemeOverriddenRef = useRef(false);
  useEffect(() => {
    if (!schemeOverriddenRef.current && props.scheme) {
      store.getState().setScheme(props.scheme);
    }
  }, [props.scheme, store]);
  const angle = useViewStore(store, (state) => state.angle);
  const overlayOn = useViewStore(store, (state) => state.overlayOn);
  const scheme = useViewStore(store, (state) => state.scheme);
  const expandedCohorts = useViewStore(store, (state) => state.expandedCohorts);
  const zoom = useViewStore(store, (state) => state.zoom);
  const selection = useViewStore(store, (state) => state.selection);

  const canvas = props.canvases[angle];
  const [editing, setEditing] = useState<{ id: string; draft: string } | null>(null);
  // Deixis: the anchor the agent (or the index) is pointing at — the CodeView
  // pulses its span. Cleared as the user moves on.
  const [focusAnchor, setFocusAnchor] = useState<string | null>(null);
  // The hypothesis reading frame (issue #178/#181), folded from the flagged review's
  // committed hypothesis + its predicted-risk cross-check. BOTH ride the SAME
  // FlaggedReview on purpose — the cross-check references the hypothesis's per-pass
  // minted riskIds, so a frame built from a different pass's hypothesis would fall
  // every risk back to `open`. Absent a hypothesis (no adapter, a failed pass, or
  // before the flagged review lands) the frame is simply not shown.
  const hypothesisFrame = useMemo(() => {
    const flagged = props.flaggedReview;
    if (flagged?.status !== "ok" || !flagged.hypothesis) return undefined;
    return buildHypothesisFrame(flagged.hypothesis, flagged.crossChecks ?? []);
  }, [props.flaggedReview]);
  // Narrative-first (Design Doctrine §3.2): the reading frame shows by default, but is
  // collapsible so it never traps the reviewer above the lens they want to read.
  const [hypothesisOpen, setHypothesisOpen] = useState(true);
  // The open symbol inspector (Rai, wireframes #8 + #11): null when closed. When
  // FLOATING a newer click retargets it (single-entry history); when PINNED a click
  // pushes onto the breadcrumb chain so the reviewer navigates deeper in the rail.
  const [symbolState, setSymbolState] = useState<SymbolInspectorState | null>(null);
  // Monotonic lookup id, so each invocation settles its OWN history entry.
  const requestSeq = useRef(0);

  // Click a code identifier (in the diff or a pinned neighbour) → resolve it via the
  // lookup port and show it. Floating: retarget. Pinned: truncate any forward history
  // and push the new name as the current crumb. The result settles by requestId, so
  // out-of-order responses (even for the same name) each land on their own entry.
  function inspectSymbol(name: string): void {
    const lookup = props.symbolLookup;
    if (!lookup) return;
    requestSeq.current += 1;
    const requestId = requestSeq.current;
    setSymbolState((current) => {
      const entry: InspectorEntry = { requestId, name, pending: true };
      if (!current?.pinned) return { pinned: false, history: [entry], cursor: 0 };
      const kept = current.history.slice(0, current.cursor + 1);
      const history = [...kept, entry];
      return { pinned: true, history, cursor: history.length - 1 };
    });
    lookup(name)
      .then((inspection) => {
        setSymbolState((current) =>
          current ? applyLookupResult(current, requestId, { pending: false, inspection }) : current,
        );
      })
      .catch((reason) => {
        const error = reason instanceof Error ? reason.message : String(reason);
        setSymbolState((current) =>
          current ? applyLookupResult(current, requestId, { pending: false, error }) : current,
        );
      });
  }

  // Pin toggles float ⇄ dock. Unpinning collapses the chain to just the current
  // crumb (a floating peek is single-target); pinning keeps the chain to grow.
  function togglePin(): void {
    setSymbolState((current) => {
      if (!current) return current;
      if (current.pinned) {
        const shown = current.history[current.cursor];
        return { pinned: false, history: shown ? [shown] : [], cursor: 0 };
      }
      return { ...current, pinned: true };
    });
  }

  function moveCursor(next: number): void {
    setSymbolState((current) =>
      current && next >= 0 && next < current.history.length
        ? { ...current, cursor: next }
        : current,
    );
  }

  // The canvas's L3 marks, as anchor-addressed marks the CodeView can land in the
  // code. An annotation's `target` and a proposal's `target` are already anchors.
  const marks: Mark[] = [
    ...canvas.layers.annotation.annotations.map((annotation) => ({
      markId: annotation.annotationId,
      markKind: "annotation" as const,
      anchor: annotation.target,
      body: annotation.body,
    })),
    ...canvas.layers.annotation.proposals.map((proposal) => ({
      markId: proposal.proposalId,
      markKind: "proposal" as const,
      anchor: proposal.target,
      body: proposal.payload,
    })),
  ];

  // The hunk occurrences that HAVE a place in this changeset (the substrate's
  // hunk ids). A mark whose occurrence is not among them cannot be placed — its
  // anchored code is gone / its lineage was dropped — and routes to the tray.
  const changesetHunkIds = new Set<string>();
  for (const chunk of canvas.layers.substrate.chunks) {
    for (const hunkId of chunk.hunkIds) changesetHunkIds.add(hunkId);
  }

  // The SET of hunk occurrence ids an element's diff renders on a GIVEN canvas: a
  // hunk-anchored element is its own single hunk; a chunk-anchored one is THAT canvas's
  // substrate chunk's hunk ids. Used ONLY as a membership set (which marks belong to
  // this element, cross-canvas jump resolution) — NOT for mark PLACEMENT. Placement
  // rides `ElementDiff.hunkOccurrences`, emitted with the diff text so it cannot drift
  // (issue #84); do not reroute placement through this order-of-decomposition list.
  function occurrenceIdsForElementOn(targetCanvas: Canvas, elementAnchor: string): string[] {
    const parsed = parseAnchor(elementAnchor);
    if (!parsed.ok) return [];
    if (parsed.anchor.kind === "hunk") return [parsed.anchor.id];
    const chunk = targetCanvas.layers.substrate.chunks.find(
      (candidate) => candidate.chunkId === parsed.anchor.id,
    );
    return chunk ? [...chunk.hunkIds] : [parsed.anchor.id];
  }

  // The active-canvas convenience the shown-marks filter uses.
  function occurrenceIdsForElement(elementAnchor: string): string[] {
    return occurrenceIdsForElementOn(canvas, elementAnchor);
  }

  // The index's orphan verdict is AUTHORITATIVE (issue #84 P0-2), not the old coarse
  // "is the occurrence in the changeset" test. The coarse test misses the fine cases —
  // a present occurrence whose span falls out of its slice, or an element whose mapping
  // is empty — where `placeMarks` correctly returns an orphan while the mark renders on
  // NO row. Surfacing those as "placed" was the exact silent-loss the registrar's loud
  // failure was meant to prevent, discarded one layer up. So we run the SAME
  // `placeMarks` the CodeView uses, over each element's REAL diff (`diffFor`), for
  // EVERY mark — not just the mounted element's — and let it decide.
  //
  // We only OVERRIDE the coarse verdict when placeMarks actually produced one (element
  // and its rendered diff both resolved). If `diffFor` is absent (the demo host) or an
  // element's diff cannot be found, we keep the coarse verdict rather than false-orphan
  // a valid mark we simply could not resolve here.
  const authoritativePlaced = new Set<string>();
  const authoritativeOrphan = new Set<string>();
  if (props.diffFor) {
    // Resolve which element OWNS each hunk in two passes. FIRST by element ANCHOR (a
    // hunk-anchored element owns its hunk; a floor-chunk element owns its substrate
    // chunk's hunks) — the original resolution, kept so the #84 empty-`hunkOccurrences`
    // element still owns its hunk via its anchor and therefore still reaches
    // `placeMarks` to orphan loudly. THEN, for any hunk no anchor claimed, by the
    // element's REAL diff (`ElementDiff.hunkOccurrences`). That second pass is the #250
    // fix: a proposal chunk (`projectSequence`) regroups floor hunks into an element
    // whose chunk anchor is NOT in the floor substrate, so its anchor occurrence set is
    // just its own chunk id — a mark on a regrouped hunk found no owner, never reached
    // `placeMarks`, and silently rode the coarse "in changeset" verdict as a false
    // "placed". `hunkOccurrences` is emitted with the diff text so it cannot drift from
    // it (#84), which is what makes it a trustworthy ownership source.
    const elementDiffByKey = new Map<string, ElementDiff>();
    const hunkOwnerKey = new Map<string, string>();
    for (const element of canvas.layers.analysis.elements) {
      const elementDiff = props.diffFor(element.elementKey);
      if (elementDiff) elementDiffByKey.set(element.elementKey, elementDiff);
      for (const hunkId of occurrenceIdsForElement(element.anchor)) {
        if (!hunkOwnerKey.has(hunkId)) hunkOwnerKey.set(hunkId, element.elementKey);
      }
    }
    for (const element of canvas.layers.analysis.elements) {
      const elementDiff = elementDiffByKey.get(element.elementKey);
      if (!elementDiff) continue;
      for (const hunk of elementDiff.hunkOccurrences) {
        for (const occurrence of hunk) {
          if (!hunkOwnerKey.has(occurrence.id)) hunkOwnerKey.set(occurrence.id, element.elementKey);
        }
      }
    }
    const marksByElementKey = new Map<string, Mark[]>();
    for (const mark of marks) {
      const parsed = parseAnchor(mark.anchor);
      if (!parsed.ok) continue;
      const ownerKey = hunkOwnerKey.get(parsed.anchor.id);
      if (ownerKey === undefined) continue;
      const list = marksByElementKey.get(ownerKey) ?? [];
      list.push(mark);
      marksByElementKey.set(ownerKey, list);
    }
    for (const [elementKey, elementMarks] of marksByElementKey) {
      // Only an element whose diff RESOLVED can be adjudicated by `placeMarks`. An
      // anchor-only owner (diffFor returned undefined) keeps the coarse verdict rather
      // than false-orphaning a mark we simply could not place here — the invariant the
      // #84 set relies on, which #250 must preserve (never trade a hidden orphan for a
      // false one).
      const elementDiff = elementDiffByKey.get(elementKey);
      if (!elementDiff) continue;
      const registry = buildRowRegistry({
        diff: elementDiff.diff,
        hunkOccurrences: elementDiff.hunkOccurrences,
      });
      const placement = placeMarks(registry, elementMarks);
      for (const placed of placement.placed) authoritativePlaced.add(placed.mark.markId);
      for (const orphaned of placement.orphans) authoritativeOrphan.add(orphaned.mark.markId);
    }
  }
  const markEntries: MarkIndexEntry[] = marks.map((mark) => {
    const parsed = parseAnchor(mark.anchor);
    const coarseOrphan = !parsed.ok || !changesetHunkIds.has(parsed.anchor.id);
    let orphan = coarseOrphan;
    if (authoritativeOrphan.has(mark.markId)) orphan = true;
    else if (authoritativePlaced.has(mark.markId)) orphan = false;
    return {
      markId: mark.markId,
      markKind: mark.markKind,
      label: mark.body,
      anchor: mark.anchor,
      orphan,
    };
  });

  // Navigate to a mark's in-code home: select its element, zoom to the diff, and
  // point at its anchor. The index navigates TO the mark; it never houses it.
  function navigateToMark(entry: MarkIndexEntry): void {
    const parsed = parseAnchor(entry.anchor);
    if (parsed.ok) {
      const element = canvas.layers.analysis.elements.find((candidate) => {
        const candidateAnchor = parseAnchor(candidate.anchor);
        return candidateAnchor.ok && candidateAnchor.anchor.id === parsed.anchor.id;
      });
      if (element) {
        store.getState().select(element.elementKey);
        store.getState().setCursor(entry.anchor);
        store.getState().setZoom({ level: "diff", elementKey: element.elementKey });
      }
    }
    setFocusAnchor(entry.anchor);
  }

  function emit(writes: DispositionWrite[]): void {
    props.onDispositions?.(writes);
    for (const write of writes) {
      props.bridge
        ?.invoke("canvas.disposition", {
          commandId: crypto.randomUUID(),
          reviewId: canvas.reviewId,
          patchsetId: canvas.patchsetId,
          path: write.path,
          disposition: write.type,
          body: write.body,
          // Span-grained when the write carries one (the Spec view's per-node
          // review). All-or-none; a diff-lens write has neither and stays path-grained.
          ...(write.span && write.side ? { span: write.span, side: write.side } : {}),
        })
        .catch((cause: unknown) => {
          // FAIL LOUD, never silent. `canvas.disposition` IS wired to the engine
          // (dispatch → setDisposition), so a rejection now means a REAL rejection —
          // a path/span the engine refuses (a Spec node whose artifact file is not in
          // the reviewed patchset, or a wrong-`side` span on a modified file). A
          // silently-dropped review comment is the exact stub this whole change
          // fights, so we surface it, never swallow it. Diff-lens writes hit valid
          // patchset paths and never reject, so this path is dead for them — their
          // behaviour is byte-for-byte unchanged.
          const error = cause instanceof Error ? cause : new Error(String(cause));
          props.onDispositionError?.(write, error);
          // The never-silent floor even when no host surface is wired (the demo):
          // a rejection is at least visible, never a no-op that looks like success.
          console.error("canvas.disposition rejected — the review comment did NOT persist", {
            path: write.path,
            span: write.span,
            side: write.side,
            error: error.message,
          });
        });
    }
  }

  function approveScope(scope: ApprovalScope, type: DispositionType): void {
    emit(fanOutApproval(canvas, scope, type));
  }

  // A Spec-view disposition resolves to exactly one write (its anchor key is the
  // path) and rides the SAME `emit` seam — sink + best-effort `canvas.disposition`
  // bridge command — as every diff-lens disposition. Review lives on the spec too.
  function disposeOpenSpec(anchor: OpenSpecReviewAnchor, type: DispositionType): void {
    emit(authorOpenSpecDisposition(anchor, type).writes);
  }

  // Resolve an authoring act at any altitude to its per-anchor L2 writes and fan
  // them out through the same sink as #11's approve affordance.
  function author(act: AuthoringAct): void {
    const { writes } = authorDisposition(canvas, act);
    emit(writes);
    props.onAuthor?.(act, writes);
  }

  const hasAuthoringDock =
    props.onAuthor !== undefined ||
    props.batch !== undefined ||
    (props.orphans !== undefined && props.orphans.length > 0) ||
    props.mosaic !== undefined;

  function selectElement(elementKey: string): void {
    const element = canvas.layers.analysis.elements.find((el) => el.elementKey === elementKey);
    store.getState().select(elementKey);
    if (element) store.getState().setCursor(element.anchor);
    store.getState().setZoom({ ...zoom, level: "element", elementKey });
  }

  // Jump to the impl↔test counterpart (Rai, wireframes #7). The target element may
  // live on ANOTHER lens (the current lens placed none for that file), so switch to
  // the target lens first, then select the element from THAT canvas — reading the
  // target canvas directly rather than the render-closure `canvas`, which would be
  // stale straight after the angle change.
  function navigateToCounterpart(target: CounterpartTarget): void {
    const targetCanvas = props.canvases[target.angle];
    if (target.angle !== angle) store.getState().setAngle(target.angle);
    const element = targetCanvas?.layers.analysis.elements.find(
      (el) => el.elementKey === target.elementKey,
    );
    store.getState().select(target.elementKey);
    if (element) store.getState().setCursor(element.anchor);
    store.getState().setZoom({ level: "element", elementKey: target.elementKey });
  }

  // The Flagged lens is an INDEX: a row jumps to the mark at its anchor. The mark
  // still renders at its anchor on the code surface — the lens points at it, it
  // does not own it. Set the cursor + deixis focus so the span at the anchor
  // pulses; if the anchor resolves to a placed element, zoom to its diff too.
  function jumpToAnchor(anchor: string): void {
    store.getState().setCursor(anchor);
    const parsed = parseAnchor(anchor);
    if (parsed.ok) {
      const element = canvas.layers.analysis.elements.find((candidate) => {
        const candidateAnchor = parseAnchor(candidate.anchor);
        return candidateAnchor.ok && candidateAnchor.anchor.id === parsed.anchor.id;
      });
      if (element) {
        store.getState().select(element.elementKey);
        store.getState().setZoom({ level: "diff", elementKey: element.elementKey });
      }
    }
    setFocusAnchor(anchor);
  }

  // Jump from a possibly-related risk in the reading frame to the finding the lexical
  // cross-check paired with it (issue #178): switch to the Flagged lens (where findings
  // live) and scroll the matching finding row into view, so the reviewer can judge the
  // relation themselves. The row carries `data-finding-id`; a no-match is a best-effort
  // no-op (never a throw), and the scroll waits a frame for the lens to mount after the
  // angle change.
  function jumpToFinding(findingId: string): void {
    goToAngle("flagged");
    if (typeof window === "undefined") return;
    const selector =
      typeof CSS !== "undefined" && typeof CSS.escape === "function"
        ? `[data-finding-id="${CSS.escape(findingId)}"]`
        : `[data-finding-id="${findingId}"]`;
    window.requestAnimationFrame(() => {
      document.querySelector(selector)?.scrollIntoView({ block: "center" });
    });
  }

  // Jump from a Spec-view coverage chip to its claiming hunk (Rai, wireframes #9 /
  // R53). The chip lives on the SPEC angle, whose analysis elements are DOCUMENT-
  // anchored — so the claiming hunk is never on the active canvas; it lives on a code
  // lens. `jumpToAnchor` only searches the active canvas by a DIRECT hunk-anchor
  // match, so it silently no-ops here. This resolves the owning element ACROSS the
  // canvas set (a hunk-anchored element directly, OR a chunk-anchored one whose
  // substrate chunk CONTAINS the hunk — the common case), switching to the current
  // angle first, then the rest; then selects it and zooms to its diff so the claiming
  // code actually shows. No canvas owns the hunk (its lineage dropped) ⇒ a best-effort
  // cursor+focus point, never a throw.
  function jumpToHunkAnchor(anchor: string): void {
    store.getState().setCursor(anchor);
    setFocusAnchor(anchor);
    const parsed = parseAnchor(anchor);
    if (!parsed.ok) return;
    const targetId = parsed.anchor.id;
    const orderedAngles: CanvasAngle[] = [
      angle,
      ...(Object.keys(props.canvases) as CanvasAngle[]).filter((candidate) => candidate !== angle),
    ];
    for (const candidateAngle of orderedAngles) {
      const candidateCanvas = props.canvases[candidateAngle];
      const element = candidateCanvas.layers.analysis.elements.find((el) =>
        occurrenceIdsForElementOn(candidateCanvas, el.anchor).includes(targetId),
      );
      if (!element) continue;
      // Read the TARGET canvas directly (not the render-closure `canvas`, stale right
      // after an angle change), mirroring navigateToCounterpart.
      if (candidateAngle !== angle) store.getState().setAngle(candidateAngle);
      store.getState().select(element.elementKey);
      store.getState().setCursor(element.anchor);
      store.getState().setZoom({ level: "diff", elementKey: element.elementKey });
      return;
    }
  }

  function acceptProposal(proposal: Proposal): void {
    const draft = editing?.id === proposal.proposalId ? editing.draft : undefined;
    const adjudication = adjudicateProposal(proposal, "accepted", draft);
    if (adjudication.kind === "accept-disposition") {
      emit([
        {
          path: adjudication.path,
          type: adjudication.type,
          body: adjudication.body,
        },
      ]);
    }
    props.onAdjudicate?.(adjudication);
    setEditing(null);
  }

  function dismissProposal(proposal: Proposal): void {
    props.onAdjudicate?.(adjudicateProposal(proposal, "dismissed"));
  }

  function pinAnnotation(annotationId: string): void {
    props.bridge
      ?.invoke("canvas.pinAnnotation", {
        commandId: crypto.randomUUID(),
        canvasId: canvas.canvasId,
        annotationId,
      })
      .catch(() => undefined);
  }

  function clearAnnotation(annotationId: string): void {
    props.bridge
      ?.invoke("canvas.clearAnnotation", {
        commandId: crypto.randomUUID(),
        canvasId: canvas.canvasId,
        annotationId,
      })
      .catch(() => undefined);
  }

  // Land on a lens, honouring the fixed-point rule: if the hunk under the cursor
  // exists on the new canvas, re-center on it (zoom to element); otherwise fall
  // back to the roll-up. The cursor anchor itself is preserved across the change.
  function goToAngle(nextAngle: CanvasAngle): void {
    const view = viewAfterRotate(props.canvases[nextAngle], store.getState().cursorAnchor);
    store.getState().setAngle(nextAngle);
    store.getState().select(view.selection);
    store.getState().setZoom(view.zoom);
  }

  function rotateAndRefocus(dir: 1 | -1): void {
    goToAngle(rotateLens(store.getState().angle, dir));
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
    // Canvas shortcuts must never hijack text editing: a keydown from the
    // proposal-edit textarea (or any field) is the user typing, not a command.
    if (isEditableTarget(event.target as HTMLElement)) return;
    if (event.key === "]") rotateAndRefocus(1);
    else if (event.key === "[") rotateAndRefocus(-1);
    else if (event.key === "l" || event.key === "ArrowRight")
      store.getState().setZoom(zoomReducer(zoom, { type: "zoomIn" }));
    else if (event.key === "h" || event.key === "ArrowLeft" || event.key === "Escape")
      store.getState().setZoom(zoomReducer(zoom, { type: "zoomOut" }));
    else return;
    event.preventDefault();
  }

  // The code IS the reading surface (issue #63): a reviewer must be able to read the
  // actual hunk, not just metadata cards about it. So the diff shows as soon as an
  // element is SELECTED (element zoom), not only at the deepest diff zoom — selecting
  // an element in Decisions/Flat is the natural "let me read this" gesture, and the
  // real hunk (with its dispositions anchored) appears inline right there. The
  // deepest diff zoom stays the code-only focus; element zoom shows code beneath the
  // decision context. A doc-anchored element with no diff still renders nothing
  // (honest empty), never a fixture.
  const codeAltitude = zoom.level === "diff" || zoom.level === "element";
  const diff = codeAltitude && selection ? props.diffFor?.(selection) : undefined;

  // The impl↔test counterpart jump (Rai, wireframes #7): resolved for the shown file
  // against this review's changed-file inventory, ACROSS lenses and by the SET of
  // paths each element's diff renders (not analysis IDs, not a single path — so it is
  // immune to both the floor-vs-proposal chunk-ID regrouping AND a proposal chunk that
  // merges an impl and its test into one element). Null ⇒ no button.
  const counterpart = diff
    ? resolveCounterpart(
        props.canvases,
        angle,
        diff.path,
        (elementKey) => props.diffFor?.(elementKey)?.paths,
      )
    : null;

  // The narrated account for the altitude in view (#70): the whole-changeset
  // roll-up at roll-up zoom, the cohort's account at cohort zoom, nothing below.
  const narrationPlacement = narrationForZoom(props.narration, zoom);

  // The occurrence the shown diff renders, and the marks that belong to it. Marks
  // for other elements are not this view's concern (they are not orphans — they
  // live on their own element's diff); the CodeView only receives its occurrence's.
  const selectedElement = selection
    ? canvas.layers.analysis.elements.find((element) => element.elementKey === selection)
    : undefined;
  const shownOccurrenceIds = selectedElement ? occurrenceIdsForElement(selectedElement.anchor) : [];
  const shownMarks = marks.filter((mark) => {
    const parsed = parseAnchor(mark.anchor);
    return parsed.ok && shownOccurrenceIds.includes(parsed.anchor.id);
  });

  // The card the CodeView renders inline at a mark's span — the SAME glass cards
  // (◇ hand, accept/edit/dismiss, pin/clear), now at the anchor instead of a strip.
  function renderMarkCard(mark: Mark): ReactNode {
    if (mark.markKind === "proposal") {
      const proposal = canvas.layers.annotation.proposals.find(
        (candidate) => candidate.proposalId === mark.markId,
      );
      if (!proposal) return null;
      return (
        <ProposalMark
          proposal={proposal}
          editing={editing?.id === proposal.proposalId}
          draft={editing?.id === proposal.proposalId ? editing.draft : ""}
          onAccept={() => acceptProposal(proposal)}
          onEdit={() => setEditing({ id: proposal.proposalId, draft: proposal.payload })}
          onChangeDraft={(value) => setEditing({ id: proposal.proposalId, draft: value })}
          onDismiss={() => dismissProposal(proposal)}
        />
      );
    }
    const annotation = canvas.layers.annotation.annotations.find(
      (candidate) => candidate.annotationId === mark.markId,
    );
    if (!annotation) return null;
    return (
      <AnnotationMark annotation={annotation} onPin={pinAnnotation} onClear={clearAnnotation} />
    );
  }

  return (
    <div
      className="canvas-app"
      data-scheme={scheme === "light" ? "light" : "dark"}
      role="application"
      aria-label="Rennet canvases"
      onKeyDown={onKeyDown}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: the application-role canvas surface is an intentional keyboard region (lens rotation with [ ], zoom with l/h) and must be focusable
      tabIndex={0}
    >
      {props.feedSource ? (
        <FeedBinder
          source={props.feedSource}
          canvasId={canvas.canvasId}
          onInvalidate={props.onInvalidate}
        />
      ) : null}

      <LensSwitcher
        angle={angle}
        overlayOn={overlayOn}
        scheme={scheme}
        onSelectAngle={(next) => goToAngle(next)}
        onToggleOverlay={() => store.getState().toggleOverlay()}
        onToggleScheme={() => {
          // The reviewer took explicit control — stop following the app scheme.
          schemeOverriddenRef.current = true;
          store.getState().setScheme(scheme === "dark" ? "light" : "dark");
        }}
      />

      <div className="zoom-bar" role="toolbar" aria-label="Zoom">
        <button
          type="button"
          onClick={() => store.getState().setZoom(zoomReducer(zoom, { type: "zoomOut" }))}
        >
          Zoom out
        </button>
        <span className="zoom-level">{ZOOM_LABELS[zoom.level]}</span>
        <button
          type="button"
          onClick={() => store.getState().setZoom(zoomReducer(zoom, { type: "zoomIn" }))}
        >
          Zoom in
        </button>
        {overlayOn ? <span className="overlay-legend">Blast radius painted amber</span> : null}
      </div>

      {/* The demoted l3-strip: a navigating INDEX, not the marks' home. The marks
          themselves render AT their anchors in the CodeView below; here they are
          only a jump-list, and any unplaceable mark surfaces in the orphan tray. */}
      {marks.length > 0 ? <MarkIndex entries={markEntries} onNavigate={navigateToMark} /> : null}

      <main className="canvas-surface">
        {/* The hypothesis reading frame (issue #178/#181): the reviewer's prior —
            domain, scope, the design we'd have chosen, and the predicted risks with
            their cross-check status — shown BEFORE the lenses so the review is read
            with expectations rather than rubber-stamped. An OPEN risk (predicted, no
            finding cleared it) is the #181 payoff: it surfaces here for the human to
            check themselves. Collapsible (narrative-first, never a trap). Placement is
            not in the wireframes (invented per Design Doctrine §3.2). */}
        {hypothesisFrame ? (
          <section className="hypothesis-panel" aria-label="Review hypothesis">
            <button
              type="button"
              className="hypothesis-panel-toggle"
              aria-expanded={hypothesisOpen}
              onClick={() => setHypothesisOpen((open) => !open)}
            >
              <span className="hypothesis-panel-title">Reading frame</span>
              <span className="hypothesis-panel-counts">
                <span className="hypothesis-panel-open">{hypothesisFrame.counts.open} open</span>
                <span className="hypothesis-panel-addressed">
                  {hypothesisFrame.counts.confirmed} related
                </span>
              </span>
            </button>
            {hypothesisOpen ? (
              <HypothesisReadingFrame frame={hypothesisFrame} onJumpToFinding={jumpToFinding} />
            ) : null}
          </section>
        ) : null}
        {/* Narrative first (Design Doctrine R2): the zoom ladder's own voice for
            the altitude in view, above the grouped summary. Shown at the roll-up
            and cohort altitudes; never a spinner, never a silent blank. */}
        {narrationPlacement ? (
          <NarrationPanel altitude={ZOOM_LABELS[zoom.level]} placement={narrationPlacement} />
        ) : null}
        {angle === "spec" ? (
          props.openSpecChange ? (
            <OpenSpecView
              view={buildOpenSpecView(props.openSpecChange, props.openSpecCoverage)}
              onDispose={disposeOpenSpec}
              ask={props.openSpecAsk}
              // A coverage chip jumps to its claiming hunk. The hunk lives on a CODE
              // lens, never the active Spec canvas, so this resolves the owning element
              // ACROSS the canvas set, switches angle, and zooms to its diff (issue #9
              // / R53) — jumpToAnchor alone would silently no-op on the Spec angle.
              onJumpToHunk={jumpToHunkAnchor}
            />
          ) : (
            // The Spec angle is EXHAUSTIVE (wireframes #9): a change renders the viewer,
            // no change renders this honest empty state — never a fixture, and never a
            // silent fall-through to the FlatCanvas diff.
            <div className="openspec-empty" role="status">
              <p className="canvas-empty">No OpenSpec change in this review.</p>
            </div>
          )
        ) : angle === "flagged" ? (
          <FlaggedLens
            index={buildFlaggedIndex(props.flaggedReview ?? { status: "ok", findings: [] })}
            onJumpToAnchor={jumpToAnchor}
            deepReview={props.deepReview}
          />
        ) : angle === "noise" ? (
          <NoiseLens
            index={buildNoiseIndex(props.noiseReview ?? { status: "ok", groups: [] })}
            onJumpToAnchor={jumpToAnchor}
          />
        ) : angle === "decisions" ? (
          <DecisionsCanvas
            canvas={canvas}
            expandedCohorts={expandedCohorts}
            onToggleCohort={(cohortKey) => store.getState().toggleCohort(cohortKey)}
            onApproveScope={approveScope}
            onSelectElement={selectElement}
            runStatus={props.decisionsRunStatus ?? { status: "ok" }}
          />
        ) : (
          <FlatCanvas
            canvas={canvas}
            onApproveScope={approveScope}
            onSelectElement={selectElement}
          />
        )}
      </main>

      {diff
        ? (() => {
            const shown = symbolState ? symbolState.history[symbolState.cursor] : undefined;
            const pinned = symbolState?.pinned === true;
            const inspector =
              symbolState && shown ? (
                <SymbolInspector
                  name={shown.name}
                  pending={shown.pending}
                  error={shown.error}
                  inspection={shown.inspection}
                  onOpenInEditor={props.onOpenInEditor}
                  onClose={() => setSymbolState(null)}
                  pinned={pinned}
                  onTogglePin={togglePin}
                  breadcrumb={symbolState.history.map((entry) => entry.name)}
                  cursor={symbolState.cursor}
                  onCrumb={moveCursor}
                  onBack={() => moveCursor(symbolState.cursor - 1)}
                  onForward={() => moveCursor(symbolState.cursor + 1)}
                  canBack={symbolState.cursor > 0}
                  canForward={symbolState.cursor < symbolState.history.length - 1}
                  onNavigate={inspectSymbol}
                />
              ) : null;
            return (
              <div className={`diff-zoom${pinned ? " diff-zoom--split" : ""}`}>
                <div className="diff-zoom-main">
                  <CodeView
                    path={diff.path}
                    diff={diff.diff}
                    hunkOccurrences={diff.hunkOccurrences}
                    marks={shownMarks}
                    renderMarkCard={renderMarkCard}
                    focusAnchor={focusAnchor ?? undefined}
                    counterpart={
                      counterpart
                        ? {
                            label: counterpart.label,
                            path: counterpart.path,
                            onView: () => navigateToCounterpart(counterpart),
                          }
                        : undefined
                    }
                    onSymbolClick={props.symbolLookup ? inspectSymbol : undefined}
                  />
                  {pinned ? null : inspector}
                </div>
                {pinned ? <div className="diff-zoom-rail">{inspector}</div> : null}
              </div>
            );
          })()
        : null}

      {hasAuthoringDock ? (
        <aside className="authoring-dock" aria-label="Disposition authoring">
          {props.mosaic ? (
            <CoverageMosaicView mosaic={props.mosaic} onGotoNextUnread={props.onGotoNextUnread} />
          ) : null}
          {props.orphans && props.orphans.length > 0 ? (
            <OrphanTray orphans={props.orphans} onReauthor={props.onReauthorOrphan} />
          ) : null}
          {props.onAuthor ? (
            <GranularityAuthor context={props.granularityContext} onAuthor={author} />
          ) : null}
          {props.batch ? (
            <BatchView
              batch={props.batch}
              onEditBody={props.onEditDraftBody}
              onEditType={props.onEditDraftType}
              onWithdraw={props.onWithdrawDraft}
              onPublish={props.onPublishBatch}
            />
          ) : null}
        </aside>
      ) : null}
    </div>
  );
}
