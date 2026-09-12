import { newCommandId, type SessionPreparation, type SidebarSession } from "@rennet/protocol";
import { Button, cn } from "@rennet/ui";
import { useEffect } from "react";
import { useCommand, useMutation, useRefreshCommand } from "../data";

// ─────────────────────────────────────────────────────────────────────────────
// THE WORKSPACE HEADER (lens-board-tools 5.2/5.4, D12) — capture reported IN the
// workspace, over the boards, instead of in front of them.
//
// The bench's slab lives here now. What changed is not the content but the POSITION: the
// boards are already on screen behind this, so there is no waiting stage between the
// reviewer and their review. When capture settles this header has nothing to say and
// renders nothing at all — a header that stayed to announce a finished step would be
// chrome restating history.
//
// It also carries the GENERATION-WIDE retry (5.4). The per-lens retry belongs on the
// failed lane's own widget; the retry that re-runs the whole preparation belongs here,
// where its scope is obvious.
//
// WHAT IT NO LONGER DOES: while preparation is RUNNING there is no header at all. A
// full-width slab carrying a spinner and two named beats was Rennet describing its own
// machinery across the top of the boards the reviewer came to read — and the frame
// already animates that fact, once, in the corner slot's sphere. What running state
// still needs is the one thing the sphere cannot offer: a way to stop it. So the
// running case renders exactly that and nothing else — a floating Cancel chip under the
// titlebar, in the same skin as the rest of the floating chrome.
//
// The header comes back for a terminal state, because a failure has something only it
// can say (its reason) and an action only it can offer (Retry).
// ─────────────────────────────────────────────────────────────────────────────

/** How often this component re-asks `session.list` while preparation is live. The lane
 *  lines the rail and the seat widget read come off this one read, so this poll is what
 *  makes them move; it is the bench's own cadence, kept because it is what the live
 *  surfaces need — the header stopping at the door changes where the poll's answer is
 *  DRAWN, not whether it is asked. */
const PREPARATION_POLL_MS = 400;

/** Read the session row this workspace is on. Shares `session.list`'s one cache key with
 *  the rail's own lane read, so the poll below feeds both. */
export function useSessionRow(slug: string): SidebarSession | undefined {
  const { data } = useCommand("session.list", {}, { enabled: slug.length > 0 });
  return data?.sessions.find((candidate) => candidate.id === slug);
}

export function WorkspaceHeader({ slug }: { readonly slug: string }) {
  const session = useSessionRow(slug);
  const preparation: SessionPreparation | undefined = session?.preparation;
  const refreshSessions = useRefreshCommand("session.list");
  const cancel = useMutation("session.cancelPreparation", { invalidates: ["session.list"] });
  const retry = useMutation("session.retryPreparation", { invalidates: ["session.list"] });
  const active = preparation?.status === "capturing" || preparation?.status === "drafting";

  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(refreshSessions, PREPARATION_POLL_MS);
    return () => window.clearInterval(timer);
  }, [active, refreshSessions]);

  // Nothing to say: the boards are the workspace, and this header is only ever about
  // what is happening TO them.
  if (preparation === undefined || session === undefined) return null;

  const failed = preparation.status === "failed";
  const cancelled = preparation.status === "cancelled";

  // RUNNING: one control, floating, and nothing else. `top-16` clears the session top
  // bar (min-h-14, with its own pills on this edge) as well as the 40px corner-slot row,
  // so it never lands under the drag strip, the pill, or the History/Map/Diff rail, and
  // `right-6` puts it on the FAB's column — the two things the reviewer can do
  // to a running review share one edge. `app-region-no-drag` is explicit: on darwin this
  // chip sits just below a drag region, and a control that does not opt out of one never
  // receives its own clicks.
  if (active) {
    return (
      <button
        type="button"
        data-testid="preparation-cancel"
        aria-label="Cancel board generation"
        disabled={cancel.pending}
        onClick={() => void cancel.mutate({ sessionId: session.id })}
        className="app-region-no-drag fixed top-16 right-6 z-40 flex h-8 items-center rounded-full border border-line/60 bg-surface/70 px-3 font-medium text-ink-soft text-sm backdrop-blur-md transition-colors hover:text-ink disabled:opacity-60"
      >
        Cancel
      </button>
    );
  }

  const stage = (failed || cancelled) && preparation.stage === "capture" ? "Capture" : "Review";

  return (
    <header
      data-testid="workspace-header"
      data-status={preparation.status}
      role={failed ? "alert" : "status"}
      className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-line border-b bg-surface px-6 py-2.5"
    >
      <span
        data-testid="preparation-stage"
        className={cn("font-medium text-13", failed ? "text-danger" : "text-ink")}
      >
        {failed ? `${stage} failed` : cancelled ? `${stage} cancelled` : stage}
      </span>
      <span className={cn("font-serif text-13", failed ? "text-danger" : "text-ink-soft")}>
        {failed
          ? preparation.reason
          : cancelled
            ? "The review is still here. Retry when you’re ready."
            : ""}
      </span>
      <span className="flex-1" />
      <Button
        variant="accent"
        size="sm"
        data-testid="workspace-retry"
        disabled={retry.pending}
        onClick={() => void retry.mutate({ sessionId: session.id, commandId: newCommandId() })}
      >
        {retry.pending ? "Retrying…" : "Retry"}
      </Button>
    </header>
  );
}

/** The generation-wide retry as a bare action, for the seat widget's failure state to
 *  offer against a lane that failed. There is no per-lens retry command on the wire, so
 *  the widget offers this one and names its real scope rather than a lie about its own. */
export function useGenerationRetry(slug: string): {
  readonly retry?: () => void;
  readonly pending: boolean;
} {
  const session = useSessionRow(slug);
  const { mutate, pending } = useMutation("session.retryPreparation", {
    invalidates: ["session.list"],
  });
  const preparation = session?.preparation;
  const retriable =
    session !== undefined &&
    preparation !== undefined &&
    (preparation.status === "failed" || preparation.status === "cancelled");
  return {
    ...(retriable
      ? {
          retry: () => {
            void mutate({ sessionId: session.id, commandId: newCommandId() });
          },
        }
      : {}),
    pending,
  };
}
