import { type ReactNode, useEffect, useRef } from "react";
import { useRoute } from "wouter";
import { useCommand } from "../data/query";
import { useSessionProjectId } from "../routes/slug";
import { ROUTES } from "../routes/url";
import { useSettingsProjection } from "../settings/data/projections";
import { useRouteReviewId } from "./chat-data";
import { ChatDock } from "./chat-dock";

// ─────────────────────────────────────────────────────────────────────────────
// The chat slot's engine switch (t3code-sidecar-chat, group 6). The slot is the SAME
// always-mounted element in the layout; this decides what fills it for the session on
// the route: Rennet's own dock, or (engine `t3`, rung one) an Electron <webview> of the
// sidecar's served UI at the thread the daemon bound for this review. Rung one is proof,
// not the product: literally another app in a frame, with its own theme. Whether the
// thread view fits the slot and whether approvals and questions round-trip is what it
// exists to answer (6.2); the native ChatView mount is rung two.
// ─────────────────────────────────────────────────────────────────────────────

function useRouteSlug(): string {
  const [onSession, sessionParams] = useRoute(ROUTES.session);
  const [, runParams] = useRoute(ROUTES.sessionRun);
  const raw = (onSession ? sessionParams?.slug : runParams?.slug) ?? "";
  return raw === "" ? "" : decodeURIComponent(raw);
}

/** The engine for the session on the route: `t3` only when the project resolved it. */
export function useRouteChatEngine(): "rennet" | "t3" {
  const slug = useRouteSlug();
  const projectId = useSessionProjectId(slug);
  const projection = useSettingsProjection();
  if (!projectId) return "rennet";
  return projection.chatEngineByProject[projectId]?.value ?? "rennet";
}

export function EngineChatDock({ corner }: { readonly corner?: ReactNode }) {
  const engine = useRouteChatEngine();
  return engine === "t3" ? <T3ChatDock corner={corner} /> : <ChatDock corner={corner} />;
}

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
