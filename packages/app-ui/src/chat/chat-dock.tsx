import type { ReactNode } from "react";
import { useChatDock } from "./chat-data";
import { ChatHeader } from "./chat-header";
import { Composer } from "./composer";
import { ConversationPane } from "./conversation-pane";

// ─────────────────────────────────────────────────────────────────────────────
// ChatDock (C07, ported from the spike's `ChatColumn`). The dock's INTERNALS, mounted
// ONCE as the child of C3's always-mounted `data-slot="chat-dock"` (the layout owns the
// slot's width / `inert` / non-unmounting lifetime — that lifetime IS the transcript-
// identity guarantee across navigation, R47/R52). Three stacked regions: header ·
// transcript · composer. Every row, stream, and send resolves through `chat-data.ts`;
// this component imports NO fixture module and takes no transcript props.
//
// The ONE prop is C20's `corner`: the layout owns `dockOpen`, so the layout decides
// whether the chat pane owns the corner slot and hands the node down. Gating there
// (never here on "the dock exists") is what keeps the slot out of the closed dock's
// hidden, inert, zero-width subtree.
// ─────────────────────────────────────────────────────────────────────────────

export function ChatDock({ corner }: { readonly corner?: ReactNode }) {
  const { rows, liveIds, trail, contextWindow, inFlight, send } = useChatDock();
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <ChatHeader trail={trail} corner={corner} />
      <ConversationPane rows={rows} liveIds={liveIds} contextWindow={contextWindow} />
      <Composer onSend={send} inFlight={inFlight} />
    </div>
  );
}
