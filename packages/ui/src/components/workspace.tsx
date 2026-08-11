import { parseAnchor, type RennetBridge } from "@rennet/protocol";
import type {
  Canvas,
  CanvasAngle,
  CanvasChangeNotification,
  DecisionsRunStatus,
  DispositionType,
  FlaggedReview,
  NoiseReview,
  OpenSpecChange,
  Proposal,
  ReviewNarration,
} from "@rennet/types";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import {
  type AuthoringAct,
  authorDisposition,
  type DispositionBatch,
  type OrphanedDisposition,
} from "../canvas/authoring";
import { resolveCounterpart } from "../canvas/counterpart";
import type { CanvasFeedSource } from "../canvas/feed";
import { useCanvasFeed } from "../canvas/feed";
import { buildFlaggedIndex } from "../canvas/flagged";
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
  type OpenSpecReviewAnchor,
} from "../canvas/openspec";
import type { CoverageMosaic } from "../canvas/read-state";
import type { Mark } from "../canvas/registrar";
import { createViewStore, useViewStore, type ViewStore } from "../canvas/store";
import type { SymbolInspection, SymbolLookupPort } from "../canvas/symbol";
import { BatchView } from "./batch-view";
import { CodeView } from "./code-view";
import { CoverageMosaicView } from "./coverage";
import { DecisionsCanvas } from "./decisions";
import { type DeepReviewControl, FlaggedLens } from "./flagged";
import { FlatCanvas } from "./flat";
import { GranularityAuthor, type GranularityContext } from "./granularity-author";
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
export type DiffResolver = (elementKey: string) => { path: string; diff: string } | undefined;

export interface CanvasWorkspaceProps {
  canvases: Record<CanvasAngle, Canvas>;
  store?: ViewStore;
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
   * The deep-review control (issue #191). When present, the Flagged lens offers a
   * one-tap "deep review" that re-runs the flagged runner with `deepReview: true`
   * (the two-model reconcile). Absent ⇒ no affordance (a host with no bridge, the
   * #11 demo, or a test). Additive — the lens is unchanged when it is omitted.
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

/** The inspector's live state: which name, still loading, errored, or resolved. */
interface SymbolInspectorState {
  readonly name: string;
  readonly pending: boolean;
  readonly error?: string;
  readonly inspection?: SymbolInspection;
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
  const store = useMemo(() => props.store ?? createViewStore(), [props.store]);
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
  // The open symbol inspector (Rai, wireframes #8): null when closed. A newer click
  // replaces it, so a late lookup for a name no longer showing is discarded.
  const [symbolState, setSymbolState] = useState<SymbolInspectorState | null>(null);

  // Click a code identifier → resolve it via the lookup port and open the inspector.
  // A guard on the name means a stale in-flight lookup (the reviewer clicked another
  // symbol meanwhile) cannot overwrite the newer one.
  function inspectSymbol(name: string): void {
    const lookup = props.symbolLookup;
    if (!lookup) return;
    setSymbolState({ name, pending: true });
    lookup(name)
      .then((inspection) => {
        setSymbolState((current) =>
          current && current.name === name ? { name, pending: false, inspection } : current,
        );
      })
      .catch((reason) => {
        setSymbolState((current) =>
          current && current.name === name
            ? {
                name,
                pending: false,
                error: reason instanceof Error ? reason.message : String(reason),
              }
            : current,
        );
      });
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

  // The hunk occurrence ids the given element's diff renders (positional, in hunk
  // order): a hunk-anchored element is its own single hunk; a chunk-anchored one
  // maps to the substrate chunk's ordered hunk ids.
  function occurrenceIdsForElement(elementAnchor: string): string[] {
    const parsed = parseAnchor(elementAnchor);
    if (!parsed.ok) return [];
    if (parsed.anchor.kind === "hunk") return [parsed.anchor.id];
    const chunk = canvas.layers.substrate.chunks.find(
      (candidate) => candidate.chunkId === parsed.anchor.id,
    );
    return chunk ? [...chunk.hunkIds] : [parsed.anchor.id];
  }

  // The index orphans a mark on a COARSE, global check: a malformed anchor, or an
  // occurrence that is not in the changeset at all (its code is gone / its lineage
  // dropped). The FINE cases — an occurrence that exists but whose span is out of
  // bounds or whose side is empty — need that element's rendered diff to decide,
  // and the CodeView already reports them via `onPlacement` (the registrar's
  // authoritative `placeMarks`). Lifting that per-element placement into this global
  // index/tray is the follow-up (issue: index built from onPlacement), tracked with
  // the render-interaction wiring this slice defers; until then a span-orphan on a
  // present occurrence shows here as placed and renders nothing at its anchor.
  const markEntries: MarkIndexEntry[] = marks.map((mark) => {
    const parsed = parseAnchor(mark.anchor);
    const orphan = !parsed.ok || !changesetHunkIds.has(parsed.anchor.id);
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
  // against this review's files. Null ⇒ no button (no counterpart in the review).
  const counterpart = diff ? resolveCounterpart(canvas, diff.path) : null;

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
        onToggleScheme={() => store.getState().setScheme(scheme === "dark" ? "light" : "dark")}
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
        {/* Narrative first (Design Doctrine R2): the zoom ladder's own voice for
            the altitude in view, above the grouped summary. Shown at the roll-up
            and cohort altitudes; never a spinner, never a silent blank. */}
        {narrationPlacement ? (
          <NarrationPanel altitude={ZOOM_LABELS[zoom.level]} placement={narrationPlacement} />
        ) : null}
        {angle === "spec" && props.openSpecChange ? (
          <OpenSpecView
            view={buildOpenSpecView(props.openSpecChange)}
            onDispose={disposeOpenSpec}
            ask={props.openSpecAsk}
          />
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

      {diff ? (
        <div className="diff-zoom">
          <CodeView
            path={diff.path}
            diff={diff.diff}
            occurrenceIds={shownOccurrenceIds}
            marks={shownMarks}
            renderMarkCard={renderMarkCard}
            focusAnchor={focusAnchor ?? undefined}
            counterpart={
              counterpart
                ? {
                    label: counterpart.label,
                    path: counterpart.path,
                    onView: () => selectElement(counterpart.elementKey),
                  }
                : undefined
            }
            onSymbolClick={props.symbolLookup ? inspectSymbol : undefined}
          />
          {symbolState ? (
            <SymbolInspector
              name={symbolState.name}
              pending={symbolState.pending}
              error={symbolState.error}
              inspection={symbolState.inspection}
              onOpenInEditor={props.onOpenInEditor}
              onClose={() => setSymbolState(null)}
            />
          ) : null}
        </div>
      ) : null}

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
