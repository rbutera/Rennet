import type { CommandInput, RennetBridge } from "@rennet/protocol";
import type { RefObject } from "react";
import type { ConversationAnchor, DiscussRequest, PromotionEvent } from "../canvas/conversation";
import { ConversationHost, DEFAULT_CONVERSATION_TIMEOUT_MS } from "./conversation-host";

// ─────────────────────────────────────────────────────────────────────────────
// ConversationPanel — the review heart's conversation column (issue #36 → #356).
//
// The panel is now the THIN wrapper around the live `ConversationHost` MARGIN path:
// one aligned `ConversationCluster` per open thread, each carrying its `data-anchor-
// key`, aligned to its diff row when that row is on-window and stacked honestly
// otherwise. The flat `PanelSurface` chat stream it used to render is retired — the
// aligned rail shipped in #85 is now the live architecture (#356). Every per-thread
// affordance (ask, promote, sub-thread, pending, per-thread error, the "both" route)
// lives on `ConversationCluster`; the host owns opening/re-attach/orphan resolution.
//
// The wrapper keeps the `.conversation-panel-shell` element so the review-heart split's
// sibling-column contract holds: the shell is the diff column's fixed flex sibling, and
// growing or aligning a thread only ever changes THIS column — the diff never reflows.
// ─────────────────────────────────────────────────────────────────────────────

export interface ConversationPanelProps {
  bridge: RennetBridge;
  reviewId: string;
  anchors: readonly ConversationAnchor[];
  autoOpenRequests?: readonly DiscussRequest[];
  selection?: NonNullable<CommandInput<"review.ask">["selection"]>;
  timeoutMs?: number;
  onPromote?(event: PromotionEvent): void;
  /**
   * The diff column this panel's rail aligns against (issue #356). Threaded straight to
   * `ConversationHost` → `ConversationMargin`: a thread whose anchor row is rendered in
   * the windowed diff is offset to meet it; an off-window or unmatched anchor stacks.
   * Absent ⇒ every panel stacks (the honest default).
   */
  diffRef?: RefObject<HTMLElement | null>;
}

export function ConversationPanel({
  bridge,
  reviewId,
  anchors,
  autoOpenRequests = [],
  selection,
  timeoutMs = DEFAULT_CONVERSATION_TIMEOUT_MS,
  onPromote,
  diffRef,
}: ConversationPanelProps) {
  return (
    <aside className="conversation-panel-shell" aria-label="Conversation">
      <ConversationHost
        bridge={bridge}
        reviewId={reviewId}
        anchors={anchors}
        autoOpenRequests={autoOpenRequests}
        selection={selection}
        timeoutMs={timeoutMs}
        onPromote={onPromote}
        diffRef={diffRef}
      />
    </aside>
  );
}
