import * as React from "react";
import { cn } from "../lib/utils";

interface ResizeHandleProps extends Omit<React.ComponentPropsWithoutRef<"div">, "onChange"> {
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
  defaultValue?: number;
  step?: number;
}

/**
 * A draggable divider that resizes an adjacent pane. Pointer-capture drag maps
 * horizontal movement onto a numeric `value` clamped to `[min, max]`; the consumer
 * owns what that value means (a column width, a split ratio). Double-click resets to
 * `defaultValue` (itself clamped). As a W3C window splitter it is keyboard-operable:
 * focusable, Left/Right nudge by `step` (never Up/Down — those also scroll the page),
 * Home/End jump to the bounds, with `aria-valuenow/min/max` reported. It forwards the
 * rest of its div props, so `aria-controls`/`aria-labelledby` reach the element.
 * Vertical (column) split only — an orientation axis is added when a consumer needs
 * one, not before.
 */
export function ResizeHandle({
  value,
  onChange,
  min,
  max,
  defaultValue,
  step = 16,
  className,
  style,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
  onLostPointerCapture,
  onKeyDown,
  onDoubleClick,
  ...rest
}: ResizeHandleProps) {
  const clamp = React.useCallback((n: number) => Math.min(max, Math.max(min, n)), [min, max]);

  const drag = React.useRef<{
    pointerId: number;
    startX: number;
    startValue: number;
    el: HTMLDivElement;
    prevUserSelect: string;
    prevCursor: string;
  } | null>(null);

  // ONE termination path for pointerup / pointercancel / lostpointercapture / unmount.
  // It RESTORES the inline body styles the drag saved (not blanks them to ""), and
  // guards releasePointerCapture — on pointercancel/unmount the capture is already
  // gone and releasing it throws.
  const end = React.useCallback((pointerId?: number) => {
    const active = drag.current;
    if (!active) return;
    if (pointerId !== undefined && pointerId !== active.pointerId) return;
    drag.current = null;
    try {
      active.el.releasePointerCapture(active.pointerId);
    } catch {
      // capture already released (pointercancel / unmount) — ignore.
    }
    document.body.style.userSelect = active.prevUserSelect;
    document.body.style.cursor = active.prevCursor;
  }, []);

  // Unmount mid-drag → still restore the body styles this handle clobbered.
  React.useEffect(() => () => end(), [end]);

  function handlePointerDown(event: React.PointerEvent<HTMLDivElement>) {
    onPointerDown?.(event);
    // Primary button only, and never start a second drag over an in-flight one.
    if (event.button !== 0 || drag.current) return;
    const el = event.currentTarget;
    drag.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startValue: value,
      el,
      prevUserSelect: document.body.style.userSelect,
      prevCursor: document.body.style.cursor,
    };
    try {
      el.setPointerCapture(event.pointerId);
    } catch {
      // pointer capture is best-effort; the drag still tracks via move events.
    }
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
  }

  function handlePointerMove(event: React.PointerEvent<HTMLDivElement>) {
    onPointerMove?.(event);
    const active = drag.current;
    // Ignore a second pointer's moves — only the captured pointer drives the drag.
    if (!active || event.pointerId !== active.pointerId) return;
    onChange(clamp(active.startValue + (event.clientX - active.startX)));
  }

  function handlePointerUp(event: React.PointerEvent<HTMLDivElement>) {
    onPointerUp?.(event);
    end(event.pointerId);
  }

  function handlePointerCancel(event: React.PointerEvent<HTMLDivElement>) {
    onPointerCancel?.(event);
    end(event.pointerId);
  }

  function handleLostPointerCapture(event: React.PointerEvent<HTMLDivElement>) {
    onLostPointerCapture?.(event);
    end(event.pointerId);
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    onKeyDown?.(event);
    const next =
      event.key === "ArrowLeft"
        ? value - step
        : event.key === "ArrowRight"
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

  const resetTo = defaultValue === undefined ? undefined : clamp(defaultValue);

  return (
    // biome-ignore lint/a11y/useSemanticElements: a draggable/keyboard splitter cannot be an <hr>; role="separator" on a focusable div is the ARIA window-splitter pattern.
    <div
      data-slot="resize-handle"
      role="separator"
      aria-orientation="vertical"
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      {...rest}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      onLostPointerCapture={handleLostPointerCapture}
      onKeyDown={handleKeyDown}
      onDoubleClick={
        resetTo === undefined
          ? onDoubleClick
          : (event) => {
              onDoubleClick?.(event);
              onChange(resetTo);
            }
      }
      style={{ touchAction: "none", ...style }}
      className={cn(
        "-mx-[3px] z-10 w-[6px] shrink-0 cursor-col-resize bg-transparent outline-none transition-colors hover:bg-foreground/20 focus-visible:bg-foreground/30 focus-visible:ring-3 focus-visible:ring-ring/50 active:bg-foreground/30",
        className,
      )}
    />
  );
}
