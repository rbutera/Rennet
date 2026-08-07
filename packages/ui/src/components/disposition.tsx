import type { DispositionType } from "@rennet/types";

// The disposition affordance: approve / request-change / comment / question at
// whatever granularity the caller passes (roll-up, cohort, selection, anchor).
// Every one is a user act; a group act fans out to per-anchor L2 (see fanOutApproval).

const DISPOSITIONS: { type: DispositionType; label: string; className: string }[] = [
  { type: "approve", label: "Approve", className: "d-approve" },
  { type: "request-change", label: "Request change", className: "d-request" },
  { type: "comment", label: "Comment", className: "d-comment" },
  { type: "question", label: "Question", className: "d-question" },
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
      {DISPOSITIONS.map(({ type, label, className }) => (
        <button
          type="button"
          key={type}
          className={`disposition-btn ${className}`}
          title={`${label} — ${scopeLabel}`}
          onClick={() => onDisposition(type)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
