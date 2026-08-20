import type { CanvasAngle } from "@rennet/types";
import { Badge, Button } from "@rennet/ui";
import { type KeyboardEvent, useRef } from "react";
import { CANVAS_LENSES } from "../canvas/logic";

/** The five angles' display labels — shared with the Files view's Angles rail. */
export const ANGLE_LABELS: Record<CanvasAngle, string> = {
  spec: "Spec",
  sequence: "Sequence",
  decisions: "Decisions",
  noise: "Noise",
  flagged: "Flagged",
};

/**
 * The lens switcher: the five selectable canvas angles as tabs. Blast-radius
 * and scheme controls removed — not in wireframe #06/#08; blast radius lives
 * in the command palette, scheme toggle lives in the title bar (wireframe #15).
 */
export function LensSwitcher({
  angle,
  onSelectAngle,
}: {
  angle: CanvasAngle;
  onSelectAngle(angle: CanvasAngle): void;
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
    <nav
      className="lens-switcher flex items-center justify-between gap-4 border-b border-line bg-canvas px-5 py-3 font-sans"
      aria-label="Review lenses"
    >
      <div className="lens-tabs flex gap-1" role="tablist" aria-label="Canvases">
        {CANVAS_LENSES.map((candidate, index) => (
          <Button
            variant="ghost"
            role="tab"
            key={candidate}
            id={`lens-tab-${candidate}`}
            aria-controls="canvas-surface-panel"
            ref={(node) => {
              tabRefs.current[index] = node;
            }}
            tabIndex={candidate === angle ? 0 : -1}
            aria-selected={candidate === angle}
            className={`lens-tab h-8 rounded-control border px-3 text-sm font-semibold ${
              candidate === angle
                ? "is-active border-accent-line bg-accent-soft text-accent"
                : "border-transparent text-ink-soft hover:bg-raised hover:text-ink"
            }`}
            onKeyDown={onTabKeyDown}
            onClick={() => onSelectAngle(candidate)}
          >
            {ANGLE_LABELS[candidate]}
          </Button>
        ))}
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
    <div
      className="blast-not-assessed flex flex-wrap items-center gap-2 px-3 py-1.5 font-sans"
      role="note"
      aria-label="Blast radius: signals not assessed"
    >
      <span className="blast-not-assessed-label text-2xs font-semibold uppercase tracking-wide text-ink">
        Not assessed
      </span>
      {signals.map((entry) => (
        <Badge
          key={entry.signal}
          variant="outline"
          className="blast-chip border-accent-line bg-accent-soft px-2.5 py-0.5 text-2xs text-accent"
          title={entry.reason}
        >
          {SIGNAL_LABELS[entry.signal] ?? entry.signal}
        </Badge>
      ))}
    </div>
  );
}
