import { cn, ResizeHandle } from "@rennet/ui";
import { type ReactNode, useEffect, useState } from "react";
import { useRoute } from "wouter";
import { AppDialogs } from "../shell/app-dialogs";
import { CommandMenu } from "../shell/command-menu";
import {
  DEFAULT_CHAT_WIDTH,
  MIN_CHAT_WIDTH,
  MIN_SURFACE_WIDTH,
  SIDEBAR_PANEL_WIDTH,
  SIDEBAR_RAIL_WIDTH,
} from "../shell/constants";
import { KeyOwner } from "../shell/key-owner";
import { Sidebar } from "../shell/sidebar/sidebar";
import { TopBar } from "../shell/top-bar";
import { useRennetStore } from "../store";
import { ROUTES } from "./url";

// ─────────────────────────────────────────────────────────────────────────────
// The layout route (C01 §4.3, C03 §1). The persistent three-region frame:
// SIDEBAR · CHAT DOCK · MAIN SURFACE, in that order (INVENTORY §1). It is a fixed
// full-viewport split with no page scroll on the frame itself. The sidebar and the
// chat-dock slot live OUTSIDE the outlet, so navigation (which swaps only the
// outlet's content) never unmounts them — the risk-4 fence.
//
// The chat-dock slot is the SAME always-mounted element (`data-testid="chat-dock-
// slot"`); it is hidden by animating its wrapper width to 0 AND marking it `inert`
// whenever the chat is closed or the route is a takeover — mounted, out of the tab
// order, its transcript identity preserved for C7 (R47 amendment). The divider
// between dock and surface is C2's `ResizeHandle` with the consumer-owned constants;
// dragging suppresses the width transition for the LIFETIME of the drag, re-armed the
// instant the pointer lifts.
// ─────────────────────────────────────────────────────────────────────────────

export function AppLayout({ children }: { readonly children: ReactNode }) {
  const sidebarOpen = useRennetStore((s) => s.ui.sidebarOpen);
  const chatOpen = useRennetStore((s) => s.ui.chatOpen);
  const chatWidth = useRennetStore((s) => s.ui.chatWidth);
  const setChatWidth = useRennetStore((s) => s.uiActions.setChatWidth);

  // The dock and the session top-bar show only on a review-session route; every
  // other route is a takeover (settings, new chat, archived, map, indexing).
  const [onSession] = useRoute(ROUTES.session);
  const [onRun] = useRoute(ROUTES.sessionRun);
  const isSessionRoute = onSession || onRun;
  const dockOpen = chatOpen && isSessionRoute;

  // Suppress the width transition for the LIFETIME of a drag (it would lag the pointer),
  // keyed on the pointer being DOWN — set on pointer-down, cleared on up/cancel/lost-
  // capture — not on a trailing timer that mis-reads a mid-drag pause as "settled".
  const [resizing, setResizing] = useState(false);

  // The chat's maximum is whatever the container leaves once the sidebar keeps its
  // width and the surface keeps its minimum — measured off the viewport (the frame
  // is `fixed inset-0`), no arbitrary cap.
  const [viewportWidth, setViewportWidth] = useState(() =>
    typeof window === "undefined" ? 1280 : window.innerWidth,
  );
  useEffect(() => {
    const onResize = () => setViewportWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const sidebarWidth = sidebarOpen ? SIDEBAR_PANEL_WIDTH : SIDEBAR_RAIL_WIDTH;
  const maxChatWidth = Math.max(MIN_CHAT_WIDTH, viewportWidth - sidebarWidth - MIN_SURFACE_WIDTH);
  // The STORED width can outlive the room for it: a narrower viewport or an expanding
  // sidebar shrinks the maximum below what was saved, which would render the dock over
  // the surface's 400px floor AND report aria-valuenow > aria-valuemax. Clamp the width
  // we actually render + hand the splitter to the live bounds, so the surface keeps its
  // minimum and the ARIA range stays valid until the next drag rewrites the stored value.
  const effectiveChatWidth = Math.min(maxChatWidth, Math.max(MIN_CHAT_WIDTH, chatWidth));

  return (
    // The ONE global key owner wraps the frame + outlet, so every overlay (the command
    // menu here, C5/C12's later ones) shares one keydown authority + Escape priority stack.
    <KeyOwner>
      <div className="rennet-layout fixed inset-0 flex overflow-hidden bg-canvas text-ink">
        {/* The ⌘P/⌘K command menu — mounted once, outside the outlet, so the sidebar
            Search row + rail button (C3) drive this single controlled instance. */}
        <CommandMenu />

        {/* Sidebar region — the host/project/session tree is a projection (C3). */}
        <Sidebar />

        {/* The chat-dock SLOT — the SAME always-mounted element OUTSIDE the outlet, so
          navigating never unmounts it (risk 4). Hidden by width-0 + `inert` off a
          session route or with the chat closed; C7 fills the dock's internals. */}
        <div
          data-slot="chat-dock"
          data-testid="chat-dock-slot"
          data-open={dockOpen}
          inert={!dockOpen}
          style={{ width: dockOpen ? effectiveChatWidth : 0 }}
          className={cn(
            "rennet-chat-dock flex-none overflow-hidden border-r border-line bg-surface",
            !resizing && "transition-[width] duration-200 ease-out motion-reduce:transition-none",
          )}
        />

        {/* The divider — only on a session route with the chat open. */}
        {dockOpen ? (
          <ResizeHandle
            aria-label="Resize chat column"
            value={effectiveChatWidth}
            min={MIN_CHAT_WIDTH}
            max={maxChatWidth}
            defaultValue={DEFAULT_CHAT_WIDTH}
            onPointerDown={() => setResizing(true)}
            onPointerUp={() => setResizing(false)}
            onPointerCancel={() => setResizing(false)}
            onLostPointerCapture={() => setResizing(false)}
            onChange={setChatWidth}
          />
        ) : null}

        {/* The outlet — the ONLY part navigation swaps — under the session top-bar. */}
        <main data-region="outlet" className="rennet-outlet flex min-w-0 flex-1 flex-col">
          {isSessionRoute ? <TopBar /> : null}
          <div className="min-h-0 flex-1">{children}</div>
        </main>

        {/* App-wide dialogs (add-project, add-environment) — mounted once, each binds
            its own visibility to `ui.openDialogs` and portals over the frame. Inside the
            KeyOwner so their open/Escape participates in the one priority stack. */}
        <AppDialogs />
      </div>
    </KeyOwner>
  );
}
