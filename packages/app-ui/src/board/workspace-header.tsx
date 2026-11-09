import { newCommandId, type SessionPreparation, type SidebarSession } from "@rennet/protocol";
import { Button } from "@rennet/ui";
import { useCallback, useEffect, useRef } from "react";
import { useCommand, useMutation, useRefreshCommand } from "../data";
import { useScopedHandle, useScopedState } from "../data/scoped-state";
import { useForgetSettledInstalls } from "../data/tool-install";
import { ActionFailureLine, useActionFailure } from "../preparation/action-failure";
import { LargeFileChoice, largeFileFailureKey } from "../preparation/large-file-choice";
import {
  failureInstallOwner,
  PreparationFailure,
  retryFailureKey,
} from "../preparation/preparation-failure";
import { preparationPhase, preparationStopped } from "../preparation/preparation-phase";
import { usePresenceShown } from "../preparation/preparation-presence";
import { useProjectLocus } from "../preparation/session-locus";

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
// can say (its reason) and actions only it can offer: since review-preparation-reliability
// that is one PreparationFailure block, with the recovery its kind calls for and Retry.
// And it carries the large-file question while preparation waits on it.
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
  const cancelFailure = useActionFailure();
  const phase = preparationPhase(preparation);
  const presenceShown = usePresenceShown();
  // The large-file dialog's remembered state belongs to ONE question. When the session is
  // no longer choosing, the next question (after a Retry, say) starts on a fresh dialog.
  const resetLargeFileQuestion = useResetLargeFileQuestion(slug);
  useEffect(() => {
    if (phase !== "choosing") resetLargeFileQuestion();
  }, [phase, resetLargeFileQuestion]);
  // A Retry's failure, and what the block's Install for me came to, belong to the stop they
  // were for: once the review is going again, the next stop starts without them. A kept
  // "Git LFS is installed" over a new stop asking for Git LFS offered no install at all.
  const retryFailure = useScopedHandle<string | undefined>(retryFailureKey(slug), undefined);
  const forgetFailureInstall = useForgetSettledInstalls(failureInstallOwner(slug));
  useEffect(() => {
    if (preparationStopped(phase)) return;
    retryFailure.set(undefined);
    forgetFailureInstall();
  }, [phase, retryFailure, forgetFailureInstall]);
  // Still going: the poll is what moves the rail, the presence and the seats. `choosing` is
  // polled too, so an answer given from another window resumes this one.
  const active = phase === "waiting" || phase === "choosing" || phase === "drafting";

  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(refreshSessions, PREPARATION_POLL_MS);
    return () => window.clearInterval(timer);
  }, [active, refreshSessions]);

  // Nothing to say: the boards are the workspace, and this header is only ever about
  // what is happening TO them.
  if (preparation === undefined || session === undefined) return null;

  // The floating chip, for a run that is still going (see DRAFTING below for its corner).
  const floatingCancel = (
    <>
      <button
        type="button"
        data-testid="preparation-cancel"
        aria-label="Cancel board generation"
        disabled={cancel.pending}
        onClick={() => {
          cancelFailure.run(
            () => cancel.mutate({ sessionId: session.id }),
            "Rennet couldn't cancel this review. Try again.",
          );
        }}
        className="app-region-no-drag absolute right-6 bottom-6 z-40 flex h-8 items-center rounded-full border border-line/60 bg-surface/70 px-3 font-medium text-ink-soft text-sm backdrop-blur-md transition-colors hover:text-ink disabled:opacity-60"
      >
        Cancel
      </button>
      {cancelFailure.message === undefined ? null : (
        // Just above the chip it is about, in the same corner.
        <div className="absolute right-6 bottom-16 z-40 max-w-xs rounded-lg bg-surface/90 px-3 py-2 backdrop-blur-md">
          <ActionFailureLine message={cancelFailure.message} />
        </div>
      )}
    </>
  );

  // WAITING: the board area is the preparation presence, and its Cancel sits inline under
  // the skeleton (review-preparation-reliability D6) — a second, floating Cancel over a board
  // that is itself a waiting presence would be two ways to say one thing. Where the presence
  // is NOT on screen (the diff view, or boards an earlier attempt drafted) the chip floats.
  if (phase === "waiting") return presenceShown ? null : floatingCancel;

  // CHOOSING: the large-file question, over the presence that keeps animating behind it.
  if (preparation.status === "awaiting") {
    return (
      <>
        <AwaitingChoice session={session} lfsAvailable={preparation.lfsAvailable} />
        {presenceShown ? null : floatingCancel}
      </>
    );
  }

  // STOPPED: one block that says what happened and what to do (task 3.3), in place of the
  // strip that used to sit over an empty board.
  if (preparation.status === "failed" || preparation.status === "cancelled") {
    return <PreparationFailure session={session} preparation={preparation} />;
  }

  // DRAFTING: one control, floating, and nothing else. It sits in the EXIT's corner —
  // `right-6 bottom-6`, the slot `handoff/fab.tsx` uses for Continue — because the two
  // never coexist: Continue is absent while the boards are being written, and this chip
  // is absent once they are. One corner, one thing the reviewer can do to the review at
  // a time. It used to float at `top-16 right-6`, which is exactly where the seat
  // transcript drawer's header puts its Close (the drawer is right-aligned inside the
  // board region), so opening a transcript mid-draft put Cancel over Close (Rai,
  // 2026-09-12). `absolute`, not `fixed`: both workspaces are `relative` columns filling
  // the outlet, and the outlet — not the window — is what the dock sits beside.
  // `app-region-no-drag` is explicit: a control that does not opt out of a drag region
  // never receives its own clicks.
  return floatingCancel;
}

/**
 * The large-file question while preparation waits on it. The modal opens on its own; Escape
 * (or its close button) does not strand the reviewer — it leaves this calm line with a way
 * back, while the presence keeps animating below.
 */
function AwaitingChoice({
  session,
  lfsAvailable,
}: {
  readonly session: SidebarSession;
  readonly lfsAvailable: boolean;
}) {
  // Per session, not per mount: the route swaps the workspace under this when the review
  // attaches mid-question, and a dismissed dialog must not spring back open.
  const [open, setOpen] = useScopedState(largeFileOpenKey(session.id), true);
  const { locus } = useProjectLocus(session.projectId);
  // Escape lands on the way back, not on <body>: with the dialog gone, that button is the
  // only control that reopens it, and focus should be where the next step is.
  const chooseAgain = useRef<HTMLButtonElement | null>(null);
  const wasOpen = useRef(open);
  useEffect(() => {
    if (wasOpen.current && !open) chooseAgain.current?.focus();
    wasOpen.current = open;
  }, [open]);
  return (
    <>
      <LargeFileChoice
        sessionId={session.id}
        open={open}
        onOpenChange={setOpen}
        lfsAvailable={lfsAvailable}
        locus={locus}
        finalFocus={chooseAgain}
      />
      {open ? null : (
        <div
          data-testid="large-file-waiting"
          role="status"
          className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-line border-b bg-surface/60 px-6 py-2.5"
        >
          <span className="text-ink-soft text-sm">
            This review is waiting for your choice about large files.
          </span>
          <Button ref={chooseAgain} variant="accent" size="sm" onClick={() => setOpen(true)}>
            Choose large-file mode
          </Button>
        </div>
      )}
    </>
  );
}

function largeFileOpenKey(sessionId: string): string {
  return `large-file-open:${sessionId}`;
}

/** Forget one session's large-file dialog state: open again, on its first screen. */
function useResetLargeFileQuestion(sessionId: string): () => void {
  const open = useScopedHandle(largeFileOpenKey(sessionId), true);
  const screen = useScopedHandle(`large-file-choice:${sessionId}`, {
    needsLfs: false,
    answered: false,
  });
  const failure = useScopedHandle<string | undefined>(largeFileFailureKey(sessionId), undefined);
  return useCallback(() => {
    open.set(true);
    screen.set({ needsLfs: false, answered: false });
    failure.set(undefined);
  }, [open, screen, failure]);
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
            // The failed seat's widget shows its own state; a retry that did not go through
            // leaves the lane failed and the block's own Retry in reach, so nothing escapes.
            mutate({ sessionId: session.id, commandId: newCommandId() }).catch(() => undefined);
          },
        }
      : {}),
    pending,
  };
}
