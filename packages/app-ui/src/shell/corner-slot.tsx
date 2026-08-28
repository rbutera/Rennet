import { cn } from "@rennet/ui";
import { PanelLeft } from "lucide-react";
import type { ReactNode } from "react";
import { Icon } from "../components/icon";
import { useBridge } from "../data";
import { useRennetStore } from "../store";

// ─────────────────────────────────────────────────────────────────────────────
// The corner slot (C20, #558). ONE object = [macOS traffic-light inset] + [the
// sidebar toggle], and **the leftmost pane owns it**. It mounts in exactly one
// place at a time — the sidebar header while the sidebar is expanded, the chat
// header while the sidebar is collapsed and the dock is open, and a floating pill
// over the full-bleed main view when both are shut. `cornerSlotOwner` is the one
// authority for which; each of the three call sites renders only when it owns it.
//
// On darwin the window is `titleBarStyle: "hiddenInset"`, so the OS paints the
// real close/minimise/zoom buttons over the renderer's top-left. There is nothing
// to draw here — the slot RESERVES their zone (76px, #557's measure) and, being
// the titlebar in that state, carries the shared `navigation-titlebar` drag rule
// so the corner strip drags the window and its buttons opt back out. Every other
// host keeps its native frame and reserves nothing, while keeping the same single
// toggle in the same place: non-darwin loses the inset, not the affordance.
// ─────────────────────────────────────────────────────────────────────────────

/** Which pane owns the corner slot. `"floating"` is the no-pane case. */
export type CornerSlotOwner = "sidebar" | "chat" | "floating";

/**
 * The single-owner authority — pure, no React, no store read, so both the call
 * sites and the tests can ask it the same question. Leftmost-pane-wins: the
 * sidebar if it is expanded, else the chat dock if it is OPEN (never merely
 * mounted — the layout keeps a closed dock alive at width 0 + `inert`, and a slot
 * mounted inside that hidden subtree is an invisible second mount that steals the
 * drag region), else nothing is left of the frame and the slot floats.
 */
export function cornerSlotOwner({
  sidebarOpen,
  dockOpen,
}: {
  readonly sidebarOpen: boolean;
  readonly dockOpen: boolean;
}): CornerSlotOwner {
  if (sidebarOpen) return "sidebar";
  return dockOpen ? "chat" : "floating";
}

/**
 * Whether the shell is running on macOS, read from the host bridge's `platform`
 * (`process.platform` through the preload). Only the corner slot cares: it is the
 * one object that shares the top-left corner with the OS's traffic lights.
 */
export function useMacTrafficLights(): boolean {
  return useBridge().platform === "darwin";
}

export function CornerSlot({
  owner,
  wordmark,
}: {
  readonly owner: CornerSlotOwner;
  /** State 1 only: the Rennet lockup, rendered BETWEEN the lights and the toggle. */
  readonly wordmark?: ReactNode;
}) {
  const mac = useMacTrafficLights();
  const open = useRennetStore((s) => s.ui.sidebarOpen);
  const setSidebarOpen = useRennetStore((s) => s.uiActions.setSidebarOpen);
  const label = open ? "Collapse sidebar" : "Expand sidebar";
  return (
    <div
      data-slot="corner-slot"
      data-owner={owner}
      className={cn(
        "flex h-10 shrink-0 items-center gap-2",
        mac && "navigation-titlebar",
        // State 1: the sidebar's header row IS this strip.
        owner === "sidebar" && (mac ? "pl-[76px] pr-3" : "pl-3 pr-3"),
        // State 2: inline as the chat header's leading element. `self-start` keeps
        // the light inset at its true y inside a taller (56px) row instead of
        // centring it, and the row's own leading padding gives way to ours.
        owner === "chat" && cn("self-start pr-2", mac ? "pl-[76px]" : "pl-0"),
        // State 3: a translucent pill floating over the full-bleed main view — the
        // one sanctioned use of translucent chrome (DESIGN.md §Material, amended
        // 2026-08-28). That amendment covers translucency and blur ONLY; the separate
        // ban on decorative shadows stands, so this is a hairline, not a shadow.
        // Inset 4px from the corner, so the mac padding is 76 − 4.
        owner === "floating" &&
          cn(
            "fixed top-1 left-1 z-40 h-8 rounded-full border border-line/60 bg-surface/70 pr-1.5 backdrop-blur-md",
            mac ? "pl-[72px]" : "pl-1.5",
          ),
      )}
    >
      {wordmark ? <div className="min-w-0 flex-1">{wordmark}</div> : null}
      <button
        type="button"
        onClick={() => setSidebarOpen(!open)}
        aria-label={label}
        title={label}
        className="flex size-6 shrink-0 items-center justify-center rounded-chip text-ink-soft hover:bg-raised hover:text-ink"
      >
        <Icon icon={PanelLeft} className="size-3.5" />
      </button>
    </div>
  );
}
