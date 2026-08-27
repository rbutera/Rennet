import type { ReactNode } from "react";
import { useRennetStore } from "../store";

// ─────────────────────────────────────────────────────────────────────────────
// The layout route (C01 §4.3). It owns the persistent chrome — the SIDEBAR region and
// the CHAT-DOCK SLOT — OUTSIDE the outlet, so navigation (which swaps only the outlet's
// content) never unmounts them. This is the risk-4 fence: the chat-dock DOM node
// survives a route round-trip because it is the layout's child, never a route's.
//
// The slot is a stable, always-mounted element; the dock's INTERNALS are C7's business.
// The sidebar's TREE is a server projection read through the data seam (C3); here the
// region is just an open/closed shell whose fold state lives in the `ui` store slice.
// ─────────────────────────────────────────────────────────────────────────────

export function AppLayout({ children }: { readonly children: ReactNode }) {
  const sidebarOpen = useRennetStore((s) => s.ui.sidebarOpen);
  const chatOpen = useRennetStore((s) => s.ui.chatOpen);
  const chatWidth = useRennetStore((s) => s.ui.chatWidth);

  return (
    <div className="rennet-layout flex min-h-screen bg-canvas text-ink">
      {/* Sidebar region — the host/project/session tree is a projection (C3 fills it). */}
      <aside
        data-region="sidebar"
        data-open={sidebarOpen}
        hidden={!sidebarOpen}
        className="rennet-sidebar w-64 flex-none border-r border-line bg-surface"
      />

      {/* The outlet — the ONLY part navigation swaps. */}
      <main data-region="outlet" className="rennet-outlet min-w-0 flex-1">
        {children}
      </main>

      {/* The chat-dock SLOT — a stable, always-mounted element OUTSIDE the outlet, so
          navigating never unmounts it (risk 4). C7 fills the dock's internals. */}
      <aside
        data-slot="chat-dock"
        data-testid="chat-dock-slot"
        data-open={chatOpen}
        style={{ width: chatOpen ? chatWidth : 0 }}
        className="rennet-chat-dock flex-none overflow-hidden border-l border-line bg-surface"
      />
    </div>
  );
}
