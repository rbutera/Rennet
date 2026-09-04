import { type ReactNode, Suspense, useEffect } from "react";
import { useCommand } from "../data/query";
import { useOpenCapturedPath } from "../review/code-destination";
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
  //
  // The store slice is global, this dock is mounted once, and the review under it changes
  // with the route — so a ref belonging to ANOTHER review is not this dock's transcript.
  // It is treated as none in the same render (an effect alone would paint one frame of the
  // previous session's thread under this session's header) and cleared right after.
  const openRef = useRennetStore((s) => s.ui.lensThread);
  const openLensThread = useRennetStore((s) => s.uiActions.openLensThread);
  //
  // A POSITIVE CONTRADICTION, never silence (AGENTS.md): the route not having resolved its
  // review yet is not evidence that this transcript belongs to another one, and treating it
  // as such would clear the lens a bench opened while its own review was still resolving.
  // Only a review id that is known AND different disowns the ref.
  const foreign = openRef !== null && reviewId !== undefined && openRef.reviewId !== reviewId;
  const lensThread = openRef !== null && !foreign ? openRef.thread : null;
  useEffect(() => {
    if (foreign) openLensThread(null);
  }, [foreign, openLensThread]);
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
              <slot.thread
                session={data}
                thread={lensThread}
                readOnly
                onOpenFile={openFileInDiff}
              />
            </>
          ) : (
            <slot.session session={data} onOpenFile={openFileInDiff} />
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
