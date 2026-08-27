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
import { useReportBoard, useRoundDispatch, useRoundState } from "../rounds/rounds-data";
import { ROUTES, readSessionQuery, sessionRunPath, viewToggle } from "../routes/url";
import { useRennetStore } from "../store";

// The review workspace route (B2 stub → Track C rebuild, #489). The canvas-era surface
// was deleted in the delete-first cutover; the Board rebuild restores it view-by-view
// over `?view`. C6 owns the `diff` branch; C8 owns the `handoff` branch (the exit view
// the FAB toggles to); C5 owns the default: the lens board document — sections in reading
// order, the lens switcher, and (once a review has frozen predecessors) the generation switcher.
//
// The board arrives through `board/board-data.ts`'s seam. No board-fetch command is
// registered yet (Reconciliation 1 — that is B4/B10's job), so with no `BoardSource`
// wired the surface renders its honest empty state until B8 emits real boards; the seam
// then binds `useCommand` in the single gated swap (cluster 8). Generation identity is
// likewise the session projection's to supply (B4/B9): until then the route opens on the
// one knowable, live generation.
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
        <DiffViewContainer review={review} />
      ) : greetingArmed && inReportPhase && report.status === "valid" ? (
        <RoundGreeting
          board={report.board}
          state={roundState}
          onReveal={() => armGreeting(false)}
        />
      ) : (
        <>
          <header className="border-border border-b px-6 py-3">
            <p className="eyebrow m-0 text-2xs font-semibold uppercase tracking-wide text-ink-faint">
              REVIEW · {review.repositoryRoot.split("/").at(-1)}
            </p>
          </header>
          <LensBoardView generation={boardGeneration} />
        </>
      )}
      <ExitFab mode={mode} open={view === "handoff"} onToggle={toHandoff} />
    </div>
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
      pr={exits.pr}
      onDispatch={onDispatch}
      onOpenPr={exits.onOpenPr}
    />
  );
}
