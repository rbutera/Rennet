import type { CanvasAngle } from "@rennet/types";
import { type KeyboardEvent, useRef } from "react";
import { CANVAS_LENSES } from "../canvas/logic";
import type { Scheme } from "../canvas/store";

/** The five angles' display labels — shared with the Files view's Angles rail. */
export const ANGLE_LABELS: Record<CanvasAngle, string> = {
  spec: "Spec",
  sequence: "Sequence",
  decisions: "Decisions",
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
  // Roving tabindex + arrow-key movement (WAI-ARIA tabs pattern). The role=tablist /
  // role=tab markup announces a tab widget, so the keyboard must operate it as one:
  // exactly one tab is in the tab order (the active one), and Arrow/Home/End move
  // between tabs with focus following selection. Click and the app-level [ ] cycle
  // are unchanged — this only adds the movement the tab semantics already promise.
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const moveTo = (index: number) => {
    const count = CANVAS_LENSES.length;
    const wrapped = ((index % count) + count) % count;
    const lens = CANVAS_LENSES[wrapped];
    if (lens === undefined) return;
    onSelectAngle(lens);
    tabRefs.current[wrapped]?.focus();
  };
  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    // Arrows move relative to the ACTIVE angle, not the focused button: app-level
    // bracket rotation can change the selection while focus stays on the old tab
    // (now tabindex -1), and the next arrow must continue from the real selection,
    // not the stale button index (focus Decisions, ] selects Noise, ArrowLeft
    // must land Decisions, not Sequence).
    const activeIndex = Math.max(0, CANVAS_LENSES.indexOf(angle));
    // A handled arrow/Home/End must NOT bubble to the canvas application handler
    // (workspace onKeyDown maps ArrowRight/ArrowLeft to zoom): stopPropagation keeps
    // tab movement from also zooming the canvas. preventDefault marks it handled so
    // the app dispatcher's defaultPrevented guard is a second line of defence.
    switch (event.key) {
      case "ArrowRight":
        event.preventDefault();
        event.stopPropagation();
        moveTo(activeIndex + 1);
        break;
      case "ArrowLeft":
        event.preventDefault();
        event.stopPropagation();
        moveTo(activeIndex - 1);
        break;
      case "Home":
        event.preventDefault();
        event.stopPropagation();
        moveTo(0);
        break;
      case "End":
        event.preventDefault();
        event.stopPropagation();
        moveTo(CANVAS_LENSES.length - 1);
        break;
    }
  };
  return (
    <nav className="lens-switcher" aria-label="Review lenses">
      <div className="lens-tabs" role="tablist" aria-label="Canvases">
        {CANVAS_LENSES.map((candidate, index) => (
          <button
            type="button"
            role="tab"
            key={candidate}
            id={`lens-tab-${candidate}`}
            aria-controls="canvas-surface-panel"
            ref={(node) => {
              tabRefs.current[index] = node;
            }}
            tabIndex={candidate === angle ? 0 : -1}
            aria-selected={candidate === angle}
            className={`lens-tab ${candidate === angle ? "is-active" : ""}`}
            onKeyDown={onTabKeyDown}
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
