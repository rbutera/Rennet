"use client"

import * as React from "react"
import { createPortal } from "react-dom"
import { X } from "lucide-react"
import { Popover, PopoverContent } from "@/components/ui/popover"
import { MARK_BY_ID, type MarkId, useCoachmark, useTourStore } from "@/lib/tour"

/**
 * One coach mark: a spotlight cutout over the anchor plus an anchored card.
 * The cutout is a single `box-shadow` spread — purely visual, pointer-events
 * none — so the anchored control stays clickable underneath it. Touching the
 * anchor retires the mark: you learned it by doing it.
 *
 * Anchors resolve through a `data-tour="<id>"` attribute rather than a ref, so
 * wiring a surface is one attribute and one element, and marks can point at
 * controls that live inside a Base UI `render` prop.
 */

const resolvers = new Map<string, () => Element | null>()

/** Stable resolver for `[data-tour="<id>"]` — stable identity per id. */
export function byTour(id: string): () => Element | null {
  const existing = resolvers.get(id)
  if (existing) return existing
  const fn = () => document.querySelector(`[data-tour="${id}"]`)
  resolvers.set(id, fn)
  return fn
}

/** Breathing room between the anchor and the cutout edge. */
const PAD = 6

interface AnchorState {
  el: Element | null
  rect: DOMRect | null
  radius: string
}

/**
 * Track the anchor's live box. A rAF poll beats wiring scroll listeners onto
 * every ancestor scroll container: the mark is on screen for seconds at a
 * time, and it stays glued through sidebar width transitions and board scroll
 * without knowing anything about the surfaces it decorates.
 */
function useAnchorBox(resolve: () => Element | null): AnchorState {
  const [state, setState] = React.useState<AnchorState>({ el: null, rect: null, radius: "0px" })
  const resolveRef = React.useRef(resolve)
  resolveRef.current = resolve
  const key = React.useRef("")
  const elRef = React.useRef<Element | null>(null)

  React.useEffect(() => {
    let raf = 0
    const tick = () => {
      raf = requestAnimationFrame(tick)
      const el = resolveRef.current()
      const rect = el?.getBoundingClientRect() ?? null
      const radius = el ? window.getComputedStyle(el).borderRadius : "0px"
      const next = rect ? `${rect.x},${rect.y},${rect.width},${rect.height},${radius}` : "none"
      if (next === key.current && el === elRef.current) return
      key.current = next
      elRef.current = el
      setState({ el: el ?? null, rect, radius })
    }
    tick()
    return () => cancelAnimationFrame(raf)
  }, [])

  return state
}

export function Coachmark({
  id,
  anchor,
  enabled = true,
}: {
  id: MarkId
  /** Defaults to `[data-tour="<id>"]`. */
  anchor?: () => Element | null
  /** False keeps the mark out of the running entirely (its surface isn't ready). */
  enabled?: boolean
}) {
  const active = useCoachmark(id, enabled)
  if (!active) return null
  return <ActiveCoachmark id={id} anchor={anchor ?? byTour(id)} />
}

function ActiveCoachmark({ id, anchor }: { id: MarkId; anchor: () => Element | null }) {
  const mark = MARK_BY_ID[id]
  const { el, rect, radius } = useAnchorBox(anchor)
  const dismiss = useTourStore((s) => s.dismiss)
  const skipEverything = useTourStore((s) => s.skipEverything)

  // Learned on interaction — using the thing is better than reading about it.
  React.useEffect(() => {
    if (!el) return
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && el.contains(event.target)) dismiss(id)
    }
    document.addEventListener("pointerdown", onPointerDown, true)
    return () => document.removeEventListener("pointerdown", onPointerDown, true)
  }, [el, id, dismiss])

  if (!el || !rect) return null

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
  )

  return (
    <>
      {spotlight}
      <Popover
        open
        modal={false}
        onOpenChange={(open) => {
          if (!open) dismiss(id)
        }}
      >
        <PopoverContent
          anchor={el}
          side={mark.side ?? "bottom"}
          align={mark.align ?? "center"}
          // A full-region anchor has no usable outside edge — park the card in
          // the middle of it instead of off the viewport.
          sideOffset={
            mark.centered ? ({ anchor: a, positioner: p }) => -(a.height + p.height) / 2 : 14
          }
          initialFocus={false}
          finalFocus={false}
          aria-label={mark.title}
          className="w-[19.5rem] gap-2 p-3.5 shadow-overlay ring-1 ring-primary/30 motion-reduce:animate-none"
        >
          <div className="flex items-start gap-2">
            <span className="flex-1 text-[12.5px] font-semibold tracking-tight text-foreground">
              {mark.title}
            </span>
            <button
              type="button"
              onClick={() => dismiss(id)}
              aria-label="Dismiss tip"
              className="-mr-1 -mt-0.5 flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
            >
              <X className="size-3.5" aria-hidden="true" />
            </button>
          </div>
          <p className="text-[13px] leading-[1.55] text-muted-foreground">{mark.body}</p>
          <button
            type="button"
            onClick={skipEverything}
            className="w-fit text-[11.5px] text-muted-foreground/70 underline decoration-dotted underline-offset-2 transition-colors hover:text-foreground"
          >
            Skip all tips
          </button>
        </PopoverContent>
      </Popover>
    </>
  )
}
