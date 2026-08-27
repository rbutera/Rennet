import type { Review } from "@rennet/protocol";
import { useLocation, useRoute, useSearch } from "wouter";
import { LensBoardView } from "../board";
import { useHandoffExits } from "../handoff/exits";
import { ExitFab } from "../handoff/fab";
import { resolveEntryMode } from "../handoff/handoff-data";
import { HandoffView } from "../handoff/handoff-view";
import { DiffViewContainer } from "../review";
import { ROUTES, readSessionQuery, viewToggle } from "../routes/url";

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
        <HandoffMount review={review} />
      ) : view === "diff" ? (
        <DiffViewContainer review={review} />
      ) : (
        <>
          <header className="border-border border-b px-6 py-3">
            <p className="eyebrow m-0 text-2xs font-semibold uppercase tracking-wide text-ink-faint">
              REVIEW · {review.repositoryRoot.split("/").at(-1)}
            </p>
          </header>
          <LensBoardView generation={LIVE_GENERATION} />
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
function HandoffMount({ review }: { review: Review }) {
  const exits = useHandoffExits(review);
  return (
    <HandoffView
      review={review}
      onPost={exits.onPost}
      reviewDraft={exits.reviewDraft}
      pr={exits.pr}
      onOpenPr={exits.onOpenPr}
    />
  );
}
