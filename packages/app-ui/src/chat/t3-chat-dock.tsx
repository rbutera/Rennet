import { type ReactNode, Suspense } from "react";
import { useCommand } from "../data/query";
import { useRennetStore } from "../store";
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
  // Which thread the slot is showing: a lens seat's transcript when the reviewer opened
  // one from the bench (t3-lens-threads 3.4), the review's own thread otherwise.
  const lensThread = useRennetStore((s) => s.ui.lensThread);
  const openLensThread = useRennetStore((s) => s.uiActions.openLensThread);
  // The trail TRANSFERS here when the dock opens (C20 state 2): the top bar hands it off,
  // so the dock has to render it or the open dock names no session at all. It rides the
  // dock's own header, above whatever fills the slot, and the header owns the corner too.
  const trail = useChatTrail(reviewId);

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
          {lensThread ? (
            <>
              <button
                type="button"
                data-slot="t3-thread-back"
                onClick={() => openLensThread(null)}
                className="flex-none border-line border-b px-3 py-2 text-left text-ink-soft text-xs hover:text-ink"
              >
                ← Back to the session
              </button>
              <slot.thread session={data} thread={lensThread} readOnly />
            </>
          ) : (
            <slot.session session={data} />
          )}
        </Suspense>
      ) : (
        <p data-slot="t3-chat-unmounted" className="p-3 text-xs text-ink-soft">
          This host does not mount the chat view.
        </p>
      )}
    </div>
  );
}
