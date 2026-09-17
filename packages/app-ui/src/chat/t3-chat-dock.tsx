import { Skeleton } from "@rennet/ui";
import { type ReactNode, Suspense } from "react";
import { useCommand } from "../data/query";
import { useOpenCapturedPath } from "../review/code-destination";
import { useChatTrail, useRouteChatTarget } from "./chat-data";
import { ChatHeader } from "./chat-header";
import { ChatUnavailable } from "./chat-unavailable";
import { useT3ChatSlot } from "./t3-chat-slot";

/**
 * The bring-up wait, shown while the sidecar session opens or the thread view loads. A
 * skeleton, not a sentence: a wait reads as a wait without a label the reviewer has to parse
 * (Rai, 2026-09-14). The sr-only line keeps the state honest for a screen reader.
 */
function ChatPaneSkeleton({ label }: { readonly label: string }) {
  return (
    <div
      data-slot="t3-chat-starting"
      role="status"
      aria-label={label}
      className="flex flex-col gap-2.5 p-3"
    >
      <Skeleton className="h-3 w-2/3" />
      <Skeleton className="h-3 w-1/2" />
      <Skeleton className="h-3 w-4/5" />
    </div>
  );
}

/**
 * The chat slot: T3's own thread view, mounted natively by the host through
 * `T3ChatSlotProvider`. Both of the desktop package's entries — the Electron renderer and
 * the served browser tab — provide it, so there is no second rung; a host that provides
 * nothing says so rather than showing an empty box.
 */
export function T3ChatDock({ corner }: { readonly corner?: ReactNode }) {
  // WHICH of the three the route names decides what this dock may claim (#872). The read
  // below only runs for a review, so only a review may be told the sidecar is starting.
  const target = useRouteChatTarget();
  const reviewId = target.kind === "review" ? target.reviewId : undefined;
  const { data, error, pending } = useCommand(
    "chat.t3Session",
    reviewId === undefined ? {} : { reviewId },
    { enabled: reviewId !== undefined },
  );
  const slot = useT3ChatSlot();
  // WHICH THREAD THE SLOT SHOWS: the session's own, in every state of every lane (#823).
  //
  // There is no second answer and no branch that could produce one. Until this change the
  // dock had a lens-thread arm: a bench reader wrote `ui.lensThread` and the dock replaced
  // the reviewer's conversation with that seat's transcript, behind a "← Back to the
  // session" button. Rai, 2026-09-04: "we take over the orchestrator's chat with the lens
  // agent's chat thread.. thats a big nono and should be removed or reworked." It is
  // removed. A seat's transcript opens in the board region's own drawer
  // (`board/seat-transcript-drawer.tsx`), which is a SECOND mount of `slot.thread` — this
  // dock is no longer the only one, and it no longer has to choose.
  //
  // The trail TRANSFERS here when the dock opens (C20 state 2): the top bar hands it off,
  // so the dock has to render it or the open dock names no session at all. It rides the
  // dock's own header, above whatever fills the slot, and the header owns the corner too.
  const trail = useChatTrail(reviewId);
  // A file reference clicked in the chat opens Rennet's OWN Diff view when the review
  // captured that path. Wired HERE rather than in the two desktop entries: the dock is
  // already inside `CodeDestinationProvider` and already knows which review the route
  // names, so both entries inherit the behaviour by mounting the dock, instead of each
  // rebuilding the same navigation against the same store.
  const openFileInDiff = useOpenCapturedPath();

  return (
    <div
      data-slot="t3-chat-dock"
      className="flex h-full min-h-0 flex-col overflow-hidden border-r border-line"
    >
      <ChatHeader trail={trail} {...(corner ? { corner } : {})} />
      {target.kind === "resolving" ? null : target.kind === "no-review" ? (
        <p data-slot="t3-chat-no-review" className="p-3 text-xs text-ink-soft">
          No review is attached to this session, so there is no thread to open.
        </p>
      ) : error ? (
        <ChatUnavailable slot="t3-chat-error" />
      ) : pending || !data ? (
        <ChatPaneSkeleton label="Starting chat" />
      ) : slot ? (
        <Suspense fallback={<ChatPaneSkeleton label="Loading the thread view" />}>
          <slot.session session={data} onOpenFile={openFileInDiff} />
        </Suspense>
      ) : (
        <p data-slot="t3-chat-unmounted" className="p-3 text-xs text-ink-soft">
          This host does not mount the chat view.
        </p>
      )}
    </div>
  );
}
