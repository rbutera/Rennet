import type { DispositionType } from "@rennet/types";
import type { ComponentType } from "react";
import { defaultLane, type StagingLane } from "../canvas/staging";
import { CheckIcon, CommentIcon, QuestionIcon, TriangleIcon } from "./icons";

// ─────────────────────────────────────────────────────────────────────────────
// The DISPOSITION CLUSTER (issue #109 — the review heart). The four verbs as real
// iconographic controls, placeable on ANY anchor: a diff line, a chunk header, an
// element, the whole roll-up (a dragged range + a conversation fragment ride the
// same shape, deferred with #36/#139). "Verbs times anchors": one disposition
// vocabulary, wider reach.
//
// The icons ARE the vocabulary contract (frame `00-legend`): approve = a tick,
// request-change = a warning triangle, comment = a bubble, question = a help
// circle. Each glyph has an `ICON_LEGEND` entry (icons.legend.test enforces it),
// so the cluster reads instantly against the legend.
//
// The material law is visible on the control itself (issue #109, "ink vs blue"):
// each verb carries its DEFAULT lane as `data-lane` — request-change renders in ink
// (it travels to the PR), approve/comment/question render blue/backlight (personal
// or orchestrator-bound, they stay local unless staged). So a reviewer sees, before
// they click, whether a verb publishes or stays on this machine.
//
// It fits the #62 calm roll-up: `is-compact` clusters are progressively disclosed
// by their row's `:hover`/`:focus-within` (opacity, not display — they stay in the
// DOM and the tab order), so the surface reads calm, not a dense always-on grid.
// This component owns none of that reveal; it just renders a cluster the row's CSS
// quiets until engaged.
// ─────────────────────────────────────────────────────────────────────────────

/** What a disposition cluster is anchored to. Line + chunk are this slice's floor. */
export type DispositionAnchorKind =
  | "line"
  | "range"
  | "chunk"
  | "element"
  | "cohort"
  | "rollup"
  | "fragment";

/** The anchor a cluster disposes on: its kind (for the label) + a human label. */
export interface DispositionClusterAnchor {
  readonly kind: DispositionAnchorKind;
  readonly label: string;
}

interface VerbSpec {
  readonly type: DispositionType;
  /** The short label the cluster shows (verbs earn a word; frame 00-legend). */
  readonly label: string;
  /** The verb-specific className, so each keeps its hover tint. */
  readonly className: string;
  readonly Icon: ComponentType<{ size?: number }>;
}

// Ordered approve → request-change → comment → question, matching the legend's
// conversation-cluster order. Each verb's lane is DERIVED (`defaultLane`), never
// hard-coded, so the cluster and the staging law cannot drift.
const VERBS: readonly VerbSpec[] = [
  { type: "approve", label: "Approve", className: "d-approve", Icon: CheckIcon },
  { type: "request-change", label: "Request change", className: "d-request", Icon: TriangleIcon },
  { type: "comment", label: "Comment", className: "d-comment", Icon: CommentIcon },
  { type: "question", label: "Question", className: "d-question", Icon: QuestionIcon },
];

// approve reads as evidence (green); the other three resolve to gold — review-blue and
// decision-amber merged into the one accent (theme doctrine 2026-08-19).
const VERB_HOVER: Record<DispositionType, string> = {
  approve: "hover:border-green-line hover:bg-green-soft hover:text-ink",
  "request-change": "hover:border-accent-line hover:bg-accent-soft hover:text-ink",
  comment: "hover:border-accent-line hover:bg-accent-soft hover:text-ink",
  question: "hover:border-accent-line hover:bg-accent-soft hover:text-ink",
};

/** A terse human name for an anchor kind, for the control's accessible name. */
const ANCHOR_NOUN: Record<DispositionAnchorKind, string> = {
  line: "line",
  range: "range",
  chunk: "chunk",
  element: "element",
  cohort: "cohort",
  rollup: "roll-up",
  fragment: "fragment",
};

export function DispositionCluster({
  anchor,
  compact = false,
  labelled = true,
  onDispose,
}: {
  /** The anchor this cluster disposes on (a diff line, a chunk header, …). */
  anchor: DispositionClusterAnchor;
  /** Compact (icon-forward, tighter) — the per-row reveal form. */
  compact?: boolean;
  /** Whether each verb shows its word beside the icon (off ⇒ icon-only, line rows). */
  labelled?: boolean;
  /** Dispose `type` on this anchor. The host resolves the anchor to L2 writes. */
  onDispose(type: DispositionType): void;
}) {
  const noun = ANCHOR_NOUN[anchor.kind];
  return (
    <div
      className={`disposition-cluster flex gap-1.5 ${compact ? "is-compact" : ""}`}
      data-anchor-kind={anchor.kind}
      role="toolbar"
      aria-label={`Dispose on ${noun} ${anchor.label}`}
    >
      {VERBS.map(({ type, label, className, Icon }) => {
        const lane: StagingLane = defaultLane(type);
        return (
          <button
            type="button"
            key={type}
            className={`disposition-cluster-btn ${className} inline-flex cursor-pointer items-center rounded-chip border bg-raised font-sans text-ink-soft ${lane === "ink" ? "border-line-strong" : "border-accent-line"} ${compact ? "gap-1 px-1.5 py-0.5 text-2xs" : "gap-1.5 px-2.5 py-1 text-sm"} ${VERB_HOVER[type]}`}
            data-type={type}
            data-lane={lane}
            title={`${label} — ${noun} ${anchor.label}`}
            aria-label={`${label} on ${noun} ${anchor.label}`}
            onClick={() => onDispose(type)}
          >
            <Icon size={13} />
            {labelled ? <span className="disposition-cluster-label">{label}</span> : null}
          </button>
        );
      })}
    </div>
  );
}
