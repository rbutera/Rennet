import type { DispositionType } from "@rennet/types";
import type { ComponentType } from "react";
import { CheckIcon, CommentIcon, QuestionIcon, TriangleIcon } from "./icons";

// The disposition affordance: approve / request-change / comment / question at
// whatever granularity the caller passes (roll-up, cohort, selection, anchor).
// Every one is a user act; a group act fans out to per-anchor L2 (see fanOutApproval).
// Each carries a mood-board stroke icon (aria-hidden, so the label stays the name).

const DISPOSITIONS: {
  type: DispositionType;
  label: string;
  className: string;
  Icon: ComponentType<{ size?: number }>;
}[] = [
  { type: "approve", label: "Approve", className: "d-approve", Icon: CheckIcon },
  { type: "request-change", label: "Request change", className: "d-request", Icon: TriangleIcon },
  { type: "comment", label: "Comment", className: "d-comment", Icon: CommentIcon },
  { type: "question", label: "Question", className: "d-question", Icon: QuestionIcon },
];

// The verb's hover register: approve reads as evidence (green); the other three all
// resolve to gold — review-blue and decision-amber merged into the one accent (theme
// doctrine 2026-08-19). The icon + word carry the verb; the tint carries the mood.
const VERB_HOVER: Record<DispositionType, string> = {
  approve: "hover:border-green-line hover:bg-green-soft hover:text-ink",
  "request-change": "hover:border-accent-line hover:bg-accent-soft hover:text-ink",
  comment: "hover:border-accent-line hover:bg-accent-soft hover:text-ink",
  question: "hover:border-accent-line hover:bg-accent-soft hover:text-ink",
};

export function DispositionBar({
  scopeLabel,
  compact = false,
  onDisposition,
}: {
  scopeLabel: string;
  compact?: boolean;
  onDisposition(type: DispositionType): void;
}) {
  return (
    <div
      className={`disposition-bar flex gap-1.5 ${compact ? "is-compact" : ""}`}
      role="toolbar"
      aria-label={`Dispose ${scopeLabel}`}
    >
      {DISPOSITIONS.map(({ type, label, className, Icon }) => (
        <button
          type="button"
          key={type}
          className={`disposition-btn ${className} inline-flex cursor-pointer items-center rounded-chip border border-line-strong bg-raised font-sans text-ink-soft ${compact ? "gap-1 px-2 py-0.5 text-2xs" : "gap-1.5 px-3 py-1.5 text-sm"} ${VERB_HOVER[type]}`}
          title={`${label} — ${scopeLabel}`}
          onClick={() => onDisposition(type)}
        >
          <Icon size={13} />
          <span className="disposition-label">{label}</span>
        </button>
      ))}
    </div>
  );
}
