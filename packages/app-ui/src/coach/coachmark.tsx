import { Popover, PopoverContent } from "@rennet/ui";
import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "../components/icon";
import { useCoachOptional, useCoachStore } from "./context";
import { MARK_BY_ID, type MarkId } from "./marks";
import { useCoachElement } from "./registry";
import type { CoachStore } from "./store";

// ─────────────────────────────────────────────────────────────────────────────
// The coach mark surface (C13 Cluster 2). Ported from the reviewed spike
// (`spikes/board-prototype/components/coachmark.tsx`) with the two structural
// rewrites the autopsy demands: the anchor comes from the typed registry, never
// `document.querySelector('[data-tour=…]')`, and there is no module-level state.
//
// Mount ONE `<Coachmark />` at the shell (Cluster 4). It reads the elected mark
// from the store and renders that one — one card on screen at a time. Each mark
// gets a spotlight cutout over its anchor plus an anchored teaching card. The
// cutout is a single `box-shadow` spread — pointer-events none — so the control
// underneath stays clickable, and touching it retires the mark: you learned it
// by doing it.
// ─────────────────────────────────────────────────────────────────────────────

/** Breathing room between the anchor and the cutout edge. */
const PAD = 6;

interface AnchorBox {
  rect: DOMRect | null;
  radius: string;
}

/**
 * Track the anchor element's live box for the spotlight cutout. A rAF poll beats
 * wiring scroll listeners onto every ancestor: the mark is on screen for seconds,
 * and it stays glued through sidebar width transitions and board scroll without
 * knowing anything about the surfaces it decorates.
 */
function useAnchorBox(el: Element | null): AnchorBox {
  const [box, setBox] = useState<AnchorBox>({ rect: null, radius: "0px" });
  const key = useRef("");

  useEffect(() => {
    if (!el) {
      key.current = "none";
      setBox({ rect: null, radius: "0px" });
      return;
    }
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const rect = el.getBoundingClientRect();
      const radius = window.getComputedStyle(el).borderRadius;
      const next = `${rect.x},${rect.y},${rect.width},${rect.height},${radius}`;
      if (next === key.current) return;
      key.current = next;
      setBox({ rect, radius });
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [el]);

  return box;
}

/** The shell-mounted surface: renders whichever mark the store has elected. */
export function Coachmark() {
  // Optional context: before the provider mounts (the store awaits `settings.get`,
  // Cluster 3) there is no store to subscribe to. Read it non-throwingly and render
  // nothing until it appears — a conditional store subscription would break the rules
  // of hooks, so the subscription lives in the inner component behind this guard.
  const coach = useCoachOptional();
  if (!coach) return null;
  return <ElectedCoachmark store={coach.store} />;
}

function ElectedCoachmark({ store }: { store: CoachStore }) {
  const active = store((s) => s.active);
  if (!active) return null;
  return <ActiveCoachmark key={active} id={active} />;
}

function ActiveCoachmark({ id }: { id: MarkId }) {
  const mark = MARK_BY_ID[id];
  const store = useCoachStore();
  const dismiss = store((s) => s.dismiss);
  const skipEverything = store((s) => s.skipEverything);
  const el = useCoachElement(id);
  const { rect, radius } = useAnchorBox(el);

  // Learned on interaction — using the thing beats reading about it.
  useEffect(() => {
    if (!el) return;
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && el.contains(event.target)) dismiss(id);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [el, id, dismiss]);

  if (!el || !rect) return null;

  const spotlight = createPortal(
    <div
      aria-hidden="true"
      className="pointer-events-none fixed z-40 animate-in fade-in-0 duration-200 motion-reduce:animate-none"
      style={{
        top: rect.top - PAD,
        left: rect.left - PAD,
        width: rect.width + PAD * 2,
        height: rect.height + PAD * 2,
        borderRadius: `calc(${radius.split(" ")[0] || "0px"} + ${PAD}px)`,
        boxShadow: "0 0 0 9999px color-mix(in oklab, var(--color-scrim) 50%, transparent)",
      }}
    />,
    document.body,
  );

  return (
    <>
      {spotlight}
      <Popover
        open
        modal={false}
        onOpenChange={(open) => {
          if (!open) dismiss(id);
        }}
      >
        <PopoverContent
          anchor={el}
          side={mark.side ?? "bottom"}
          align={mark.align ?? "center"}
          // A full-region anchor has no usable outside edge — park the card in the
          // middle of it instead of off the viewport.
          sideOffset={
            mark.centered ? ({ anchor: a, positioner: p }) => -(a.height + p.height) / 2 : 14
          }
          initialFocus={false}
          finalFocus={false}
          aria-label={mark.title}
          className="w-78 gap-2 p-3.5 ring-1 ring-primary/30 motion-reduce:animate-none"
        >
          <div className="flex items-start gap-2">
            <span className="flex-1 text-12-5 font-semibold tracking-tight text-foreground">
              {mark.title}
            </span>
            <button
              type="button"
              onClick={() => dismiss(id)}
              aria-label="Dismiss tip"
              className="-mr-1 -mt-0.5 flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
            >
              <Icon icon={X} className="size-3.5" aria-hidden="true" />
            </button>
          </div>
          <p className="text-13 leading-[1.55] text-muted-foreground">{mark.body}</p>
          <button
            type="button"
            onClick={skipEverything}
            className="w-fit text-2xs text-muted-foreground/70 underline decoration-dotted underline-offset-2 transition-colors hover:text-foreground"
          >
            Skip all tips
          </button>
        </PopoverContent>
      </Popover>
    </>
  );
}
