import { type ReactNode, Suspense, useEffect, useRef } from "react";
import { useCommand } from "../data/query";
import { useRennetStore } from "../store";
import { useRouteReviewId } from "./chat-data";
import { useT3ChatSlot } from "./t3-chat-slot";

/**
 * Rung one: the sidecar's own UI in a <webview>. The daemon brokers a pairing URL (which
 * sets T3's session cookie inside the guest and lands on its home) and the bound thread's
 * route; once the guest reaches home, it is sent to the thread. Nothing here reads a
 * credential file; the bearer never enters the guest.
 */
export function T3ChatDock({ corner }: { readonly corner?: ReactNode }) {
  const reviewId = useRouteReviewId();
  const { data, error, pending } = useCommand(
    "chat.t3Session",
    reviewId === undefined ? {} : { reviewId },
    { enabled: reviewId !== undefined },
  );
  // Rung two when the host provides it (the desktop renderer); rung one otherwise.
  const slot = useT3ChatSlot();
  // Which thread the slot is showing: a lens seat's transcript when the reviewer opened
  // one from the bench (t3-lens-threads 3.4), the review's own thread otherwise.
  const lensThread = useRennetStore((s) => s.ui.lensThread);
  const openLensThread = useRennetStore((s) => s.uiActions.openLensThread);
  const host = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const element = host.current as (HTMLElement & { loadURL?: (url: string) => void }) | null;
    if (!element || !data?.threadUrl || !data.origin) return;
    const threadUrl = data.threadUrl;
    const home = `${data.origin}/`;
    const onNavigate = (event: Event) => {
      const url = (event as Event & { url?: string }).url;
      if (url === home) element.loadURL?.(threadUrl);
    };
    element.addEventListener("did-navigate", onNavigate);
    element.addEventListener("did-navigate-in-page", onNavigate);
    return () => {
      element.removeEventListener("did-navigate", onNavigate);
      element.removeEventListener("did-navigate-in-page", onNavigate);
    };
  }, [data?.origin, data?.threadUrl]);

  return (
    <div
      data-slot="t3-chat-dock"
      className="flex h-full min-h-0 flex-col overflow-hidden border-r border-line"
    >
      {corner ? <div className="flex-none">{corner}</div> : null}
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
        <webview
          ref={host as never}
          data-slot="t3-chat-view"
          data-thread-url={data.threadUrl}
          src={data.pairingUrl ?? data.threadUrl ?? data.origin}
          partition="persist:rennet-t3"
          className="min-h-0 flex-1"
        />
      )}
    </div>
  );
}
