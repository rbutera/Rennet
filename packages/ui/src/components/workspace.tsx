import type { RennetBridge } from "@rennet/protocol";
import type {
  Canvas,
  CanvasAngle,
  CanvasChangeNotification,
  DispositionType,
  Proposal,
} from "@rennet/types";
import { useEffect, useMemo, useState } from "react";
import type { CanvasFeedSource } from "../canvas/feed";
import { useCanvasFeed } from "../canvas/feed";
import {
  type Adjudication,
  type ApprovalScope,
  adjudicateProposal,
  type DispositionWrite,
  fanOutApproval,
  zoomReducer,
} from "../canvas/logic";
import { createViewStore, useViewStore, type ViewStore } from "../canvas/store";
import { CodeView } from "./code-view";
import { DecisionsCanvas } from "./decisions";
import { FlatCanvas } from "./flat";
import { AnnotationMark, ProposalMark } from "./l3";
import { LensSwitcher } from "./lens";

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
  /** Proposal adjudication sink (accept/dismiss/structural). */
  onAdjudicate?: (adjudication: Adjudication) => void;
  /** Change-feed invalidation hint — where a re-query (TanStack invalidation) slots in. */
  onInvalidate?: (notification: CanvasChangeNotification) => void;
  diffFor?: DiffResolver;
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

  function emit(writes: DispositionWrite[]): void {
    props.onDispositions?.(writes);
    // Best-effort bridge write. The engine may not yet handle canvas.* commands
    // (the snapshot/dispatch wiring is a follow-up), so a failure must not crash
    // the surface — the fan-out sink above is what the demo renders from.
    for (const write of writes) {
      props.bridge
        ?.invoke("canvas.disposition", {
          commandId: crypto.randomUUID(),
          reviewId: canvas.reviewId,
          patchsetId: canvas.patchsetId,
          path: write.path,
          disposition: write.type,
          body: write.body,
        })
        .catch(() => undefined);
    }
  }

  function approveScope(scope: ApprovalScope, type: DispositionType): void {
    emit(fanOutApproval(canvas, scope, type));
  }

  function selectElement(elementKey: string): void {
    const element = canvas.layers.analysis.elements.find((el) => el.elementKey === elementKey);
    store.getState().select(elementKey);
    if (element) store.getState().setCursor(element.anchor);
    store.getState().setZoom({ ...zoom, level: "element", elementKey });
  }

  function acceptProposal(proposal: Proposal): void {
    const draft = editing?.id === proposal.proposalId ? editing.draft : undefined;
    const adjudication = adjudicateProposal(proposal, "accepted", draft);
    if (adjudication.kind === "accept-disposition") {
      emit([{ path: adjudication.path, type: adjudication.type, body: adjudication.body }]);
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

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
    if (event.key === "]") store.getState().rotate(1);
    else if (event.key === "[") store.getState().rotate(-1);
    else if (event.key === "l" || event.key === "ArrowRight")
      store.getState().setZoom(zoomReducer(zoom, { type: "zoomIn" }));
    else if (event.key === "h" || event.key === "ArrowLeft" || event.key === "Escape")
      store.getState().setZoom(zoomReducer(zoom, { type: "zoomOut" }));
    else return;
    event.preventDefault();
  }

  const diff = zoom.level === "diff" && selection ? props.diffFor?.(selection) : undefined;

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
        onSelectAngle={(next) => store.getState().setAngle(next)}
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

      {canvas.layers.annotation.annotations.length > 0 ||
      canvas.layers.annotation.proposals.length > 0 ? (
        <section className="l3-strip" aria-label="Orchestrator marks">
          {canvas.layers.annotation.annotations.map((annotation) => (
            <AnnotationMark
              key={annotation.annotationId}
              annotation={annotation}
              onPin={pinAnnotation}
              onClear={clearAnnotation}
            />
          ))}
          {canvas.layers.annotation.proposals.map((proposal) => (
            <ProposalMark
              key={proposal.proposalId}
              proposal={proposal}
              editing={editing?.id === proposal.proposalId}
              draft={editing?.id === proposal.proposalId ? editing.draft : ""}
              onAccept={() => acceptProposal(proposal)}
              onEdit={() => setEditing({ id: proposal.proposalId, draft: proposal.payload })}
              onChangeDraft={(value) => setEditing({ id: proposal.proposalId, draft: value })}
              onDismiss={() => dismissProposal(proposal)}
            />
          ))}
        </section>
      ) : null}

      <main className="canvas-surface">
        {angle === "decisions" ? (
          <DecisionsCanvas
            canvas={canvas}
            expandedCohorts={expandedCohorts}
            onToggleCohort={(cohortKey) => store.getState().toggleCohort(cohortKey)}
            onApproveScope={approveScope}
            onSelectElement={selectElement}
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
          <CodeView path={diff.path} diff={diff.diff} />
        </div>
      ) : null}
    </div>
  );
}
