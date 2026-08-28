import type { Review } from "@rennet/protocol";
import { useEffect, useRef } from "react";
import { useLocation, useRoute, useSearch } from "wouter";
import { LensBoardView } from "../board";
import { useHandoffExits } from "../handoff/exits";
import { ExitFab } from "../handoff/fab";
import { resolveEntryMode } from "../handoff/handoff-data";
import { HandoffView } from "../handoff/handoff-view";
import { DiffViewContainer } from "../review";
import { RoundGreeting } from "../rounds/round-greeting";
import {
  useReportBoard,
  useRoundDispatch,
  useRoundRecords,
  useRoundState,
  useRoundsUnavailable,
} from "../rounds/rounds-data";
import { RoundsLedger } from "../rounds/rounds-ledger";
import { ROUTES, readSessionQuery, sessionRunPath, viewToggle } from "../routes/url";
import { useRennetStore } from "../store";

// The review workspace route (B2 stub → Track C rebuild, #489). The canvas-era surface
// was deleted in the delete-first cutover; the Board rebuild restores it view-by-view
// over `?view`. C6 owns the `diff` branch; C8 owns the `handoff` branch (the exit view
// the FAB toggles to); C5 owns the default: the lens board document — sections in reading
// order, the lens switcher, and (once a review has frozen predecessors) the generation switcher.
//
// The board arrives through `board/board-data.ts`'s seam, which reads the registered
// `board.read` command (bound in C18) for this review's `(generation, lens)` pairs — a
// lens the host drafted no board for is honestly absent. Generation identity is still the
// session projection's to supply (B4/B9): until then the route opens on the one knowable,
// live generation.
//
// The exit FAB is mounted across the reading views (board/diff) in a `relative` container so its
// `absolute inset-0` root observes the PANE's width (the 54rem label-drop, C08 cluster 2). It
// toggles to `?view=handoff` and YIELDS while the hand-off is open (R49); leaving the hand-off is
// the top-bar's back arrow, so the board/diff pill stays reachable. A retrospective review offers
// no exit, so `ExitFab` renders nothing for it (law 10).
const LIVE_GENERATION = "live";

export function ReviewWorkspace({ review }: { review: Review }) {
  const [, navigate] = useLocation();
  const [, sessionParams] = useRoute(ROUTES.session);
  const query = readSessionQuery(new URLSearchParams(useSearch()));
  const view = query.view;
  const slug = sessionParams?.slug ? decodeURIComponent(sessionParams.slug) : "";
  const mode = resolveEntryMode(review);

  // Review-identity isolation (C05's boardId lesson, applied to the singleton `review` slice): the
  // reviewer's ephemeral acts (staged asks, retired ledger, inline edits, the verdict override) are
  // this review's, and MUST NOT survive a switch to another review — A's override becoming B's
  // submitted verdict is the leak. So the slice resets when `review.id` changes. It resets ONLY on a
  // real change, never on first mount, so a seed-then-mount (fixtures/tests) is preserved intact.
  const resetReview = useRennetStore((s) => s.reviewActions.resetReview);
  const previousReviewId = useRef(review.id);
  useEffect(() => {
    if (previousReviewId.current === review.id) return;
    previousReviewId.current = review.id;
    resetReview();
  }, [review.id, resetReview]);

  // The round report as the greeting (C09 §5.2). On return from a round the run route
  // armed `greetingArmed` and redirected here; while a round is in a report phase and its
  // board resolves valid, the board surface LEADS with the greeting (the report readable
  // at once, regeneration streaming beneath) instead of the plain lens board. The reveal
  // is the single consume: `armGreeting(false)` disarms it, and the surface returns to
  // `LensBoardView` at the composed round's NEW generation (derived off the machine's
  // `composed` state, never a stored navigation target — the S9 fence). Stable store
  // reads only (a primitive + a stable action ref) — no fresh-object selector.
  const roundState = useRoundState(slug);
  // The rounds ledger (C09 §6.2). `?view=rounds` shows the ledger EXACTLY when a round
  // has completed — the derived-presence C5 uses for the lens switcher, and what the
  // top-bar's History pill is gated on. A `?view=rounds` deep-link with no completed
  // round falls through to the board (the "no rounds ⇒ fall back" guard — url.ts already
  // falls back on an unknown `?view`, this covers the known-but-empty case).
  const roundRecords = useRoundRecords(slug);
  // Why the rounds cannot be read, when they cannot (review finding 9). An empty ledger and
  // an UNANSWERED one are different facts, and a client can outrun the daemon it is talking
  // to: rendering "no rounds have completed" over a daemon that never answered would be a
  // claim nobody established. The reason is stated where the ledger would have been.
  const roundsUnavailable = useRoundsUnavailable(slug);
  const greetingArmed = useRennetStore((s) => s.run.greetingArmed);
  const armGreeting = useRennetStore((s) => s.runActions.armGreeting);
  const reportBoardId = "reportBoardId" in roundState ? roundState.reportBoardId : "";
  const report = useReportBoard(reportBoardId);
  const inReportPhase =
    roundState.phase === "reporting" ||
    roundState.phase === "composing" ||
    roundState.phase === "composed";
  const boardGeneration =
    roundState.phase === "composed" ? roundState.newGeneration : LIVE_GENERATION;

  function toHandoff() {
    const { path, replace } = viewToggle(slug, "handoff", {
      lens: query.lens,
      file: query.file ?? undefined,
    });
    navigate(path, { replace });
  }

  return (
    <div className="relative min-h-screen bg-canvas">
      {view === "handoff" ? (
        <HandoffMount review={review} slug={slug} navigate={navigate} />
      ) : view === "diff" ? (
        <DiffViewContainer review={review} roundGeneration={query.round ?? undefined} />
      ) : view === "rounds" && roundsUnavailable !== undefined ? (
        <RoundsUnavailable reason={roundsUnavailable} />
      ) : view === "rounds" && roundRecords.length > 0 ? (
        <RoundsLedger reviewId={review.id} slug={slug} records={roundRecords} />
      ) : greetingArmed && inReportPhase ? (
        // Report phase with the greeting armed: the report GATES the reveal. A valid report
        // leads the surface (regeneration streaming beneath); a missing or invalid report is
        // surfaced HONESTLY — never silently swallowed, and the new generation stays HIDDEN
        // behind the reveal (finding 1). Falling through to `LensBoardView` here would open
        // the composed generation with no "View the New Boards" act and hide the failure.
        report.status === "valid" ? (
          <RoundGreeting
            board={report.board}
            state={roundState}
            onReveal={() => armGreeting(false)}
          />
        ) : (
          <ReportUnavailable status={report.status} />
        )
      ) : (
        <>
          <header className="border-border border-b px-6 py-3">
            <p className="eyebrow m-0 text-2xs font-semibold uppercase tracking-wide text-ink-faint">
              REVIEW · {review.repositoryRoot.split("/").at(-1)}
            </p>
          </header>
          <LensBoardView reviewId={review.id} generation={boardGeneration} />
        </>
      )}
      <ExitFab mode={mode} open={view === "handoff"} onToggle={toHandoff} />
    </div>
  );
}

/**
 * The rounds-unavailable surface (review finding 9): this daemon does not answer the rounds
 * reads, so Rennet cannot say whether the session has any. It states the fact and the
 * daemon's own reason, and that is the whole of it — there is no capability handshake
 * behind it, nothing to acknowledge, and every other view stays reachable. An honest
 * absence with its cause is a statement, not a gate.
 */
function RoundsUnavailable({ reason }: { reason: string }) {
  return (
    <>
      <header className="border-border border-b px-6 py-3">
        <p className="eyebrow m-0 text-2xs font-semibold uppercase tracking-wide text-ink-faint">
          ROUNDS
        </p>
      </header>
      <section
        data-testid="rounds-unavailable"
        role="status"
        className="mx-auto flex w-full max-w-[820px] flex-col gap-2 p-6"
      >
        <h1 className="font-display text-foreground text-xl">
          Rennet cannot read this session&rsquo;s rounds.
        </h1>
        <p className="text-muted-foreground text-sm">
          The daemon this window is connected to did not answer the rounds read, so whether this
          session has completed rounds is unknown — not none. It is most likely older than this app;
          updating the daemon should restore the ledger.
        </p>
        <p data-testid="rounds-unavailable-reason" className="text-muted-foreground/80 text-xs">
          {reason}
        </p>
      </section>
    </>
  );
}

// The report-as-greeting failure surface (finding 1). When the greeting is armed and the
// round is in a report phase but the report board does not resolve `valid`, the reviewer
// sees an HONEST state instead of the new-generation board: `missing` (the source had no
// board for this round's report id) and `invalid` (the source answered with data the schema
// rejected) read distinctly. The reveal gate is preserved — the new boards stay hidden until
// a valid report renders and the reviewer clicks through. This is honest failure, not a gate:
// the ledger/diff views remain reachable through the top bar (they precede this branch).
function ReportUnavailable({ status }: { status: "missing" | "invalid" }) {
  return (
    <>
      <header className="border-border border-b px-6 py-3">
        <p className="eyebrow m-0 text-2xs font-semibold uppercase tracking-wide text-ink-faint">
          ROUND REPORT
        </p>
      </header>
      <section
        data-testid="report-unavailable"
        data-report-status={status}
        role="status"
        className="mx-auto flex w-full max-w-[820px] flex-col gap-2 p-6"
      >
        <h1 className="font-display text-foreground text-xl">
          {status === "invalid"
            ? "This round's report could not be read."
            : "No report for this round."}
        </h1>
        <p className="text-muted-foreground text-sm">
          {status === "invalid"
            ? "The round completed, but its report came back in a shape Rennet could not render. The new boards stay held back until a readable report arrives."
            : "The round completed, but no report board resolved for it yet. The new boards stay held back until its report arrives."}
        </p>
      </section>
    </>
  );
}

// The hand-off, wired to its LIVE exits (C08 cluster 6). `useHandoffExits` names the registered,
// bound `publish.*` commands over the bridge (compose → review / submitPr) — so this is the only
// review-workspace path that needs a bridge, kept off the board/diff reading views. The lanes are
// already fully live over the store; this threads the sign-click egress (and the composed own-branch
// PR draft) through the `<HandoffView>` mount cluster 5 left taking no props.
//
// Dispatch wiring (C09 cluster 4): `onDispatch` closes C8's seam — reset the run slice at the
// dispatch act (NOT on the run route's cold reattach), fire the rounds seam's `dispatch(slug)`,
// then take over the live run route. Over the honest-absent source `dispatch` is undefined ⇒
// `onDispatch` stays undefined ⇒ C8's Dispatch button stays disabled (the truth today, no fake
// enablement). No dead click that lies.
function HandoffMount({
  review,
  slug,
  navigate,
}: {
  review: Review;
  slug: string;
  navigate: (to: string) => void;
}) {
  const exits = useHandoffExits(review);
  const dispatch = useRoundDispatch();
  const resetRun = useRennetStore((s) => s.runActions.resetRun);
  const onDispatch = dispatch
    ? () => {
        resetRun();
        dispatch(slug);
        navigate(sessionRunPath(slug));
      }
    : undefined;
  return (
    <HandoffView
      review={review}
      onPost={exits.onPost}
      reviewDraft={exits.reviewDraft}
      onSetVerdict={exits.onSetVerdict}
      pr={exits.pr}
      onDispatch={onDispatch}
      onOpenPr={exits.onOpenPr}
      onRevise={exits.onRevise}
    />
  );
}
