import type { NarrativeArtifact, NarrativeProgressEvent } from "@rennet/types";

// ─────────────────────────────────────────────────────────────────────────────
// NarrativeFeed (issue #71) — stage three's visible machine.
//
// This is prose over deterministic pipeline projections. It deliberately has no
// utility/model dependency: optional colour can arrive as a separate narration
// placement, but every line below stands without it. The empty fallback is a
// truthful "starting" line, never a spinner and never an empty panel (Doctrine
// interaction law 3 / R26).
// ─────────────────────────────────────────────────────────────────────────────

export interface NarrativeFeedProps {
  events?: readonly NarrativeProgressEvent[];
  onNavigate?(artifact: NarrativeArtifact): void;
  /** Completed work is intentionally compact when it shares the review surface. */
  compact?: boolean;
}

function summary(events: readonly NarrativeProgressEvent[]): string {
  const landed = events.filter(
    (event) =>
      event.artifact !== undefined && (event.status === "landed" || event.status === "complete"),
  ).length;
  return landed
    ? `${landed} ${landed === 1 ? "artifact is" : "artifacts are"} ready. You can leave this stage and return to it.`
    : "The local reading is still in progress. You can leave this stage and return to it.";
}

export function NarrativeFeed({ events = [], onNavigate, compact = false }: NarrativeFeedProps) {
  const complete = events.some((event) => event.status === "complete");
  const visible =
    events.length > 0
      ? events
      : [
          {
            reviewId: "local",
            patchsetId: "pending",
            key: "starting",
            seq: 1,
            phase: "starting" as const,
            status: "working" as const,
            text: "Starting a local reading of this changeset…",
          },
        ];
  // A long run stays resumable without taking over the completed review: retain
  // the landed artifacts + final state as the progress summary. The parent still
  // owns every original event, so leaving and returning never loses the record.
  const displayed =
    compact && complete
      ? visible.filter(
          (event) =>
            event.phase === "floor" || event.phase === "angle" || event.phase === "complete",
        )
      : visible;

  return (
    <section
      className="narrative-feed"
      aria-label="Live review narrative"
      data-status={complete ? "complete" : "running"}
    >
      <div className="narrative-feed-heading">
        <p>LIVE READING</p>
        <span>{complete ? "Ready" : "Working locally"}</span>
      </div>
      <ol className="narrative-feed-lines">
        {displayed.map((event) => {
          const artifact = event.artifact;
          const landedArtifact =
            artifact !== undefined && (event.status === "landed" || event.status === "complete")
              ? artifact
              : undefined;
          return (
            <li key={event.key} data-phase={event.phase} data-status={event.status}>
              {landedArtifact ? (
                <button type="button" onClick={() => onNavigate?.(landedArtifact)}>
                  {event.text}
                  <span aria-hidden="true"> ↗</span>
                </button>
              ) : (
                <p>{event.text}</p>
              )}
            </li>
          );
        })}
      </ol>
      <p className="narrative-feed-summary">{summary(visible)}</p>
    </section>
  );
}
