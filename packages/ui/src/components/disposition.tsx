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
      className={`disposition-bar ${compact ? "is-compact" : ""}`}
      role="toolbar"
      aria-label={`Dispose ${scopeLabel}`}
    >
      {DISPOSITIONS.map(({ type, label, className, Icon }) => (
        <button
          type="button"
          key={type}
          className={`disposition-btn ${className}`}
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
