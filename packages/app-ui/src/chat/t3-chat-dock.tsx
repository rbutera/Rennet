import { type ReactNode, Suspense } from "react";
import { useCommand } from "../data/query";
import { useOpenCapturedPath } from "../review/code-destination";
import { useChatTrail, useRouteReviewId } from "./chat-data";
import { ChatHeader } from "./chat-header";
import { useT3ChatSlot } from "./t3-chat-slot";

/**
 * The chat slot: T3's own thread view, mounted natively by the host through
 * `T3ChatSlotProvider`. Both of the desktop package's entries — the Electron renderer and
 * the served browser tab — provide it, so there is no second rung; a host that provides
 * nothing says so rather than showing an empty box.
 */
export function T3ChatDock({ corner }: { readonly corner?: ReactNode }) {
  const reviewId = useRouteReviewId();
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
      {error ? (
        <p data-slot="t3-chat-error" className="p-3 text-xs text-ink-soft">
          T3 Code sidecar unavailable: {error instanceof Error ? error.message : String(error)}
        </p>
      ) : pending || !data ? (
        <p data-slot="t3-chat-starting" className="p-3 text-xs text-ink-soft">
          Starting the T3 Code sidecar…
        </p>
      ) : slot ? (
        <Suspense
          fallback={
            <p data-slot="t3-chat-starting" className="p-3 text-xs text-ink-soft">
              Loading the thread view…
            </p>
          }
        >
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
