import type { NarrationPlacement } from "@rennet/types";

// ─────────────────────────────────────────────────────────────────────────────
// NarrationPanel (issue #70) — the zoom ladder's own voice at one altitude.
//
// Renders the narrated account for the node the reader is looking at: the one-line
// account first (the collapsed sentence), the paragraph below it (progressive
// disclosure — narrative first, R2 of the Design Doctrine). It is CHROME, not code,
// so glass is correct; the account is opaque text on it.
//
// Never a spinner (Design Doctrine R3), never a silent blank (the #70 acceptance
// floor): a node whose account has not landed shows an HONEST "narration pending"
// line, and a terminally failed one shows an honest "narration unavailable" line.
// A reader always sees SOMETHING true about the altitude they are approving.
// ─────────────────────────────────────────────────────────────────────────────

export interface NarrationPanelProps {
  /** The altitude label shown as the panel's eyebrow, e.g. "Roll-up" / "Cohort". */
  altitude: string;
  placement: NarrationPlacement;
}

export function NarrationPanel({ altitude, placement }: NarrationPanelProps) {
  return (
    <section
      className="narration-panel"
      aria-label={`${altitude} narration`}
      data-status={placement.status}
    >
      <p className="narration-altitude">{altitude}</p>
      {placement.status === "narrated" ? (
        <>
          <p className="narration-one-line">{placement.oneLine}</p>
          <p className="narration-paragraph">{placement.paragraph}</p>
        </>
      ) : placement.status === "pending" ? (
        <p className="narration-state narration-pending">Narration pending…</p>
      ) : (
        <p className="narration-state narration-failed">Narration unavailable for this view.</p>
      )}
    </section>
  );
}
