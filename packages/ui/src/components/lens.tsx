import type { CanvasAngle } from "@rennet/types";
import { CANVAS_LENSES } from "../canvas/logic";
import type { Scheme } from "../canvas/store";

const ANGLE_LABELS: Record<CanvasAngle, string> = {
  spec: "Spec",
  sequence: "Sequence",
  decisions: "Decisions",
  claims: "Claims",
  noise: "Noise",
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
