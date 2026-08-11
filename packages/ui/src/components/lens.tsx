import type { CanvasAngle } from "@rennet/types";
import { CANVAS_LENSES } from "../canvas/logic";
import type { Scheme } from "../canvas/store";

const ANGLE_LABELS: Record<CanvasAngle, string> = {
  spec: "Spec",
  sequence: "Sequence",
  decisions: "Decisions",
  claims: "Claims",
  noise: "Noise",
  flagged: "Flagged",
};

/**
 * The lens switcher: the five selectable canvas angles, plus blast-radius as an
 * amber overlay TOGGLE and a colour-scheme toggle. Blast-radius is deliberately
 * NOT a tab — promoting the overlay to a sixth canvas would silently turn it into
 * a writable queue (Canvas Paradigm §1).
 */
export function LensSwitcher({
  angle,
  overlayOn,
  scheme,
  onSelectAngle,
  onToggleOverlay,
  onToggleScheme,
}: {
  angle: CanvasAngle;
  overlayOn: boolean;
  scheme: Scheme;
  onSelectAngle(angle: CanvasAngle): void;
  onToggleOverlay(): void;
  onToggleScheme(): void;
}) {
  return (
    <nav className="lens-switcher" aria-label="Review lenses">
      <div className="lens-tabs" role="tablist" aria-label="Canvases">
        {CANVAS_LENSES.map((candidate) => (
          <button
            type="button"
            role="tab"
            key={candidate}
            aria-selected={candidate === angle}
            className={`lens-tab ${candidate === angle ? "is-active" : ""}`}
            onClick={() => onSelectAngle(candidate)}
          >
            {ANGLE_LABELS[candidate]}
          </button>
        ))}
      </div>
      <div className="lens-controls">
        <button
          type="button"
          className={`lens-overlay ${overlayOn ? "is-on" : ""}`}
          aria-pressed={overlayOn}
          title="Paint blast radius onto the active canvas"
          onClick={onToggleOverlay}
        >
          Blast radius
        </button>
        <button type="button" className="lens-scheme" onClick={onToggleScheme}>
          {scheme === "dark" ? "Bright room" : "Dark"}
        </button>
      </div>
    </nav>
  );
}

const SIGNAL_LABELS: Record<string, string> = {
  "fan-in": "Fan-in",
  "contract-surface": "Contract surface",
  deletions: "Deletions",
  irreversibility: "Irreversibility",
  codeowners: "Code owners",
  "safety-net": "Safety net",
};

/**
 * The NOT-ASSESSED chips (issue #35). A blast-radius signal that was not run is
 * surfaced here as prominently as the amber marks themselves — a reviewer who
 * cannot SEE that a signal wasn't run would read "no amber" as "checked and
 * clear". This is not a gate and not a queue: it is honest paint about what the
 * overlay did and did not measure. Rendered whenever the overlay is engaged.
 */
export function BlastNotAssessed({ signals }: { signals: { signal: string; reason: string }[] }) {
  if (signals.length === 0) return null;
  return (
    <div className="blast-not-assessed" role="note" aria-label="Blast radius: signals not assessed">
      <span className="blast-not-assessed-label">Not assessed</span>
      {signals.map((entry) => (
        <span key={entry.signal} className="blast-chip" title={entry.reason}>
          {SIGNAL_LABELS[entry.signal] ?? entry.signal}
        </span>
      ))}
    </div>
  );
}
