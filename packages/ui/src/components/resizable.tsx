import * as React from "react";
import { cn } from "../lib/utils";

/**
 * A draggable divider that resizes an adjacent pane. Pointer-capture drag maps
 * horizontal movement onto a numeric `value` clamped to `[min, max]`; the
 * consumer owns what that value means (a column width, a split ratio) and derives
 * its own bounds. Double-click resets to `defaultValue`. As a proper window
 * splitter it is keyboard-operable: focusable, arrow keys nudge by `step`, Home/
 * End jump to the bounds, with `aria-valuenow/min/max` reported. Vertical (column)
 * split only — an orientation axis is added when a consumer needs one, not before.
 */
export function ResizeHandle({
  value,
  onChange,
  min,
  max,
  defaultValue,
  step = 16,
  className,
  "aria-label": ariaLabel,
}: {
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
  defaultValue?: number;
  step?: number;
  className?: string;
  "aria-label"?: string;
}) {
  const dragging = React.useRef<{ startX: number; startWidth: number } | null>(null);
  const clamp = (n: number) => Math.min(max, Math.max(min, n));

  function onPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    dragging.current = { startX: event.clientX, startWidth: value };
    event.currentTarget.setPointerCapture(event.pointerId);
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
  }

  function onPointerMove(event: React.PointerEvent<HTMLDivElement>) {
    if (!dragging.current) return;
    const next = dragging.current.startWidth + (event.clientX - dragging.current.startX);
    onChange(clamp(next));
  }

  function onPointerUp(event: React.PointerEvent<HTMLDivElement>) {
    dragging.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const next =
      event.key === "ArrowLeft" || event.key === "ArrowDown"
        ? value - step
        : event.key === "ArrowRight" || event.key === "ArrowUp"
          ? value + step
          : event.key === "Home"
            ? min
            : event.key === "End"
              ? max
              : null;
    if (next === null) return;
    event.preventDefault();
    onChange(clamp(next));
  }

  return (
    // biome-ignore lint/a11y/useSemanticElements: a draggable/keyboard splitter cannot be an <hr>; role="separator" on a focusable div is the ARIA window-splitter pattern.
    <div
      data-slot="resize-handle"
      role="separator"
      aria-orientation="vertical"
      aria-label={ariaLabel}
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onKeyDown={onKeyDown}
      onDoubleClick={defaultValue === undefined ? undefined : () => onChange(defaultValue)}
      className={cn(
        "-mx-[3px] z-10 w-[6px] shrink-0 cursor-col-resize bg-transparent transition-colors hover:bg-foreground/20 focus-visible:bg-foreground/30 active:bg-foreground/30",
        className,
      )}
    />
  );
}
