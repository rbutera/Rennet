import { newCommandId, type SessionPreparation, type SidebarSession } from "@rennet/protocol";
import { Button, cn } from "@rennet/ui";
import { useEffect } from "react";
import { useCommand, useMutation, useRefreshCommand } from "../data";

// ─────────────────────────────────────────────────────────────────────────────
// THE WORKSPACE HEADER (lens-board-tools 5.2/5.4, D12) — capture reported IN the
// workspace, over the boards, instead of in front of them.
//
// The bench's slab and its two-beat capture rail live here now. What changed is not the
// content but the POSITION: the boards are already on screen behind this, so there is no
// waiting stage between the reviewer and their review. When capture settles this header
// has nothing to say and renders nothing at all — a header that stayed to announce a
// finished step would be chrome restating history.
//
// It also carries the GENERATION-WIDE retry (5.4). The per-lens retry belongs on the
// failed lane's own widget; the retry that re-runs the whole preparation belongs here,
// where its scope is obvious.
// ─────────────────────────────────────────────────────────────────────────────

const CAPTURE_BEATS = [
  { id: "resolving-repository", label: "Resolving the repository" },
  { id: "capturing-change", label: "Capturing the change" },
] as const;

/** How often the header re-asks `session.list` while preparation is live. The lane lines
 *  the rail and the widget read come off this one read, so this poll is what makes them
 *  move; it is the bench's own cadence, kept because it is what the live line needs. */
const PREPARATION_POLL_MS = 400;

/** Capture as the first beat of the workspace, not a screen of its own: two named steps.
 *  The step the daemon says it is on is lit; the one behind it is done; the one ahead is
 *  faint. Nothing here is a timer — every state comes off `preparation.step`. */
function CaptureRail({ step }: { readonly step: "resolving-repository" | "capturing-change" }) {
  const current = CAPTURE_BEATS.findIndex((beat) => beat.id === step);
  return (
    <ol className="flex flex-wrap items-center gap-x-5 gap-y-2" data-testid="capture-rail">
      {CAPTURE_BEATS.map((beat, index) => {
        const state = index < current ? "done" : index === current ? "active" : "waiting";
        return (
          <li
            key={beat.id}
            data-beat={beat.id}
            data-state={state}
            className="flex items-center gap-2 text-13"
          >
            <span
              className={cn(
                "size-1.5 rounded-full",
                state === "done" && "bg-accent",
                state === "active" &&
                  "bg-accent animate-processing-pulse motion-reduce:animate-none",
                state === "waiting" && "bg-line",
              )}
              aria-hidden="true"
            />
            <span className={state === "waiting" ? "text-ink-faint" : "text-ink-soft"}>
              {beat.label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

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
  const stage =
    preparation.status === "capturing"
      ? preparation.step === "resolving-repository"
        ? "Resolving the repository"
        : "Capturing the change"
      : preparation.status === "drafting"
        ? "Generating the boards"
        : preparation.stage === "capture"
          ? "Capture"
          : "Board generation";

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
      {preparation.status === "capturing" ? <CaptureRail step={preparation.step} /> : null}
      <span className={cn("font-serif text-13", failed ? "text-danger" : "text-ink-soft")}>
        {failed
          ? preparation.reason
          : cancelled
            ? "The review is still here. Retry when you’re ready."
            : preparation.status === "capturing"
              ? "The boards open as their seats write them."
              : ""}
      </span>
      <span className="flex-1" />
      {active ? (
        <Button
          variant="outline"
          size="sm"
          disabled={cancel.pending}
          onClick={() => void cancel.mutate({ sessionId: session.id })}
        >
          Cancel
        </Button>
      ) : (
        <Button
          variant="accent"
          size="sm"
          data-testid="workspace-retry"
          disabled={retry.pending}
          onClick={() => void retry.mutate({ sessionId: session.id, commandId: newCommandId() })}
        >
          {retry.pending ? "Retrying…" : "Retry"}
        </Button>
      )}
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
