import {
  generationIdForPatchset,
  isReviewStale,
  isWorkingTreeReview,
  type Review,
} from "@rennet/protocol";
import { useEffect, useRef } from "react";
import { useLocation, useRoute, useSearch } from "wouter";
import { LensBoardView } from "../board";
import { useMutation } from "../data";
import { useHandoffExits } from "../handoff/exits";
import { ExitFab } from "../handoff/fab";
import { resolveEntryMode } from "../handoff/handoff-data";
import { HandoffView } from "../handoff/handoff-view";
import { ProjectContextMapView } from "../project/context-map-view";
import { DiffViewContainer } from "../review";
import { useAskLog } from "../review/ask-log";
import { RoundGreeting } from "../rounds/round-greeting";
import {
  useReportBoard,
  useRoundDispatch,
  useRoundRecords,
  useRoundRecordsPending,
  useRoundState,
  useRoundsUnavailable,
} from "../rounds/rounds-data";
import { generationLine, RoundsLedger } from "../rounds/rounds-ledger";
import { useSessionProjectId } from "../routes/slug";
import { ROUTES, readSessionQuery, sessionPath, sessionRunPath, viewToggle } from "../routes/url";
import { useRennetStore } from "../store";

// The review workspace route (B2 stub → Track C rebuild, #489). The canvas-era surface
// was deleted in the delete-first cutover; the Board rebuild restores it view-by-view
// over `?view`. C6 owns the `diff` branch; C8 owns the `handoff` branch (the exit view
// the FAB toggles to); C5 owns the default: the lens board document — sections in reading
// order, the lens switcher, and (once a review has frozen predecessors) the generation switcher.
//
// The board arrives through `board/board-data.ts`'s seam, which reads the registered
// `board.read` command (bound in C18) for this review's `(generation, lens)` pairs — a
// lens the host drafted no board for is honestly absent.
//
// GENERATION IDENTITY. This used to pass the literal `"live"`, on the reasoning that the
// session projection would supply the real id later. Nothing was ever stamped `"live"` —
// the daemon files every board under `generationIdForPatchset(patchset.id)` and
// `board.read` matches the string EXACTLY — so the default path read `null` for every
// review, board or no board, and the reviewer's board was unreachable even once drafted.
// The id is not the session projection's to invent: a generation IS one review of one
// patchset (`architecture-contracts.md`), so the live generation is the one keyed to the
// review's ACTIVE patchset, and the shared `generationIdForPatchset` is how both ends spell
// it. Resolving `"live"` server-side would not have worked either: `board-data.ts` re-checks
// the answer's `generation` against the one it asked for, so the resolved board would have
// come back as a cross-wire error.
//
// The exit FAB is mounted across the reading views (board/diff) in a `relative` container so its
// `absolute inset-0` root observes the PANE's width (the 54rem label-drop, C08 cluster 2). It
// toggles to `?view=handoff` and YIELDS while the hand-off is open (R49); leaving the hand-off is
// the top-bar's back arrow, so the board/diff pill stays reachable. A retrospective review offers
// no exit, so `ExitFab` renders nothing for it (law 10).
//
// Freshness is the route's too (#576, restoring #38's surface). `architecture-contracts.md`:
// "The product does not present a mutated old artifact as fresh." The engine already knew — the
// watcher marks the repository dirty and `review.checkFreshness` folds the review to
// `status: "invalid"` — but nothing was ASKING, so the client presented a stale review as
// current. The round path regenerates internally, so the uncovered case is the reviewer editing
// their own tree while reading; the harm is posting that stale review under their own name.
// This is INFORMATION, not a gate: nothing is blocked, nothing needs acknowledging, and
// Regenerate is a plain button running the same `review.regenerate` a round already runs.

/**
 * What a freshness answer stales: the review the route renders, and the boards read off it.
 *
 * ⚠️ COUPLED to `routes/slug.ts`, the single point that decides how a session resolves and
 * which command feeds this route's `review` prop (`review.load` today). This list must name
 * that read — the moment the two disagree, the notice below silently stops appearing, which
 * is this issue (#576) all over again. `freshness.dom.test.tsx` mounts through
 * `useSlugResolution` for exactly that reason: change the read, and it goes red.
 */
const STALED_BY_FRESHNESS = ["review.load", "board.read"] as const;

/** Fire-and-forget: `useMutation` already holds the fault; this only settles the rejection. */
const held = () => undefined;

export function ReviewWorkspace({ review }: { review: Review }) {
  const [, navigate] = useLocation();
  const [, sessionParams] = useRoute(ROUTES.session);
  const query = readSessionQuery(new URLSearchParams(useSearch()));
  const view = query.view;
  const slug = sessionParams?.slug ? decodeURIComponent(sessionParams.slug) : "";
  const mode = resolveEntryMode(review);
  // WHICH project this session belongs to — the session ROW's own `projectId`, which is what
  // `?view=map` needs and what `review.repositoryRoot` cannot supply.
  const projectId = useSessionProjectId(slug);

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

  // The durable ask log for THIS review (the ask-log session id is the review id). It
  // hydrates the slice from `ask.read` — so a reload keeps the reviewer's staged asks, line
  // comments, quote threads, retired ledger and verdict — and installs the write sink every
  // mutator fires, which is the only reason `publish.compose`, `round.dispatch` and
  // `review.reviseSpan` see any of it: all three read the projection and nothing else.
  useAskLog(review.id);

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
  // The LEDGER read's own flight (#571) — the round-diff deep-link waits on this, not on the
  // round-events read `useRoundPending` reports.
  const roundRecordsPending = useRoundRecordsPending(slug);
  const greetingArmed = useRennetStore((s) => s.run.greetingArmed);
  const armGreeting = useRennetStore((s) => s.runActions.armGreeting);
  const reportBoardId = ("reportBoardId" in roundState ? roundState.reportBoardId : "") ?? "";
  const report = useReportBoard(reportBoardId);
  // A report phase is one that HAS a report to greet with. A round with no successor
  // account never runs the report seat, so it composes with no report board id at all —
  // and holding its new boards behind a greeting that can never arrive would be a promise
  // ("until its report arrives") that nothing is going to keep. Such a round lands on the
  // boards it just regenerated, which is what it was dispatched for. A round that DOES
  // name a report which fails to resolve still routes to `ReportUnavailable` — that report
  // exists and the reveal is genuinely owed.
  const inReportPhase =
    reportBoardId !== "" &&
    (roundState.phase === "reporting" ||
      roundState.phase === "composing" ||
      roundState.phase === "composed");
  // A composed round names the generation its reveal lands on; otherwise the live boards are
  // the ones drafted over the review's active patchset. Both are real ids the daemon stamped.
  const boardGeneration =
    roundState.phase === "composed"
      ? roundState.newGeneration
      : generationIdForPatchset(review.activePatchsetId);
  const boardGenerations = [...new Set([...generationLine(roundRecords), boardGeneration])];

  // Freshness applies to a WORKING-TREE capture and to nothing else. `review.openPr` states the
  // contract — a PR review is a snapshot taken against the pull request's pinned OIDs, "NOT wired
  // into the working-tree freshness watcher (the renderer gates that off by patchset source)" —
  // and `isWorkingTreeReview` is how the renderer tells them apart
  // (`@rennet/protocol`, `src/delta/citations.ts`). Asking
  // anyway would capture THIS CLONE's tree, which can never match a `github-local`/`github-rest`
  // patchset id, so the daemon commits `ReviewInvalidated`, the notice claims a change that never
  // happened, and Regenerate replaces the reviewed PR diff with a local capture — a lie, a
  // persisted write, and the destruction of the artifact under review. It is reachable, not
  // theoretical: `repositoryDirty` is ONE global flag, so an edit in any watched repo arms it and
  // the next PR review to mount collects the answer.
  const fromWorkingTree = isWorkingTreeReview(review);
  // Ask whether this review went stale — on mount, and again on every window focus, which is
  // exactly when the reviewer comes back from editing their own tree. The daemon short-circuits
  // when its watcher saw nothing, so a focus is cheap. Both writes stale `review.load`, so the
  // notice below renders off the REFRESHED status rather than the one this window opened on.
  const reviewId = review.id;
  const repoPath = review.repositoryRoot;
  const { mutate: checkFreshness } = useMutation("review.checkFreshness", {
    invalidates: STALED_BY_FRESHNESS,
  });
  const { mutate: regenerate, pending: regenerating } = useMutation("review.regenerate", {
    invalidates: STALED_BY_FRESHNESS,
  });
  useEffect(() => {
    if (!fromWorkingTree) return;
    // A failed check leaves the last known status standing: the surface never CLAIMS fresh, it
    // only says stale when the daemon said so, so an unanswered check is silence, not a lie.
    const ask = () => {
      void checkFreshness({ commandId: crypto.randomUUID(), reviewId, repoPath }).catch(held);
    };
    ask();
    window.addEventListener("focus", ask);
    return () => window.removeEventListener("focus", ask);
  }, [checkFreshness, reviewId, repoPath, fromWorkingTree]);
  // The staleness rule, now a SHARED predicate (`@rennet/protocol`) rather than a copy with a
  // pointer home — the pointer did not hold: mobile's copy was missing the working-tree gate
  // entirely and narrated pinned PR snapshots as stale (#600). A PR snapshot that somehow carries
  // `invalid` must not be narrated as "the repository changed", on either client. Mobile ORs its
  // reachability half on top; a desktop window IS its daemon connection, so this is the whole rule.
  const stale = isReviewStale(review);

  function toBoard() {
    const { path, replace } = viewToggle(slug, "board", {
      lens: query.lens,
      generation: query.generation ?? undefined,
      file: query.file ?? undefined,
      round: query.round ?? undefined,
      ask: query.ask ?? undefined,
    });
    navigate(path, { replace });
  }

  function toHandoff() {
    const { path, replace } = viewToggle(slug, "handoff", {
      lens: query.lens,
      generation: query.generation ?? undefined,
      file: query.file ?? undefined,
      round: query.round ?? undefined,
      ask: query.ask ?? undefined,
    });
    navigate(path, { replace });
  }

  return (
    // A flex COLUMN that fills the outlet, not a `min-h-screen` block. The height chain
    // matters: `DiffViewContainer` and the hand-off lanes each declare `min-h-0 flex-1
    // overflow-y-auto` for their own scrolling, which does nothing unless this parent is a
    // height-constrained flex column. The document branches below (board, rounds ledger,
    // round greeting, report-unavailable) had no scroller at all and were simply clipped by
    // the frame's `overflow-hidden`; they share ONE primary scroller now. That scroller is
    // also what C20's floating-chip clearance hangs off, so the board reads correctly under
    // the state-3 chip layer instead of starting beneath them.
    <div className="relative flex h-full min-h-0 flex-col bg-canvas">
      {/* One line, above the branch so it is present on the hand-off too — the surface where a
          stale review would be posted under the reviewer's own name. It reads and it offers a
          button; it blocks nothing and every view stays exactly as reachable as before. */}
      {stale ? (
        <div
          data-testid="review-stale"
          role="status"
          className="flex shrink-0 items-baseline gap-3 border-border border-b bg-accent-surface px-6 py-2 text-sm text-ink-soft"
        >
          <span>
            The repository changed since this review was captured — you are reading the older tree.
          </span>
          <button
            type="button"
            disabled={regenerating}
            onClick={() => {
              void regenerate({ commandId: crypto.randomUUID(), reviewId, repoPath }).catch(held);
            }}
            className="text-accent underline underline-offset-2 disabled:no-underline disabled:opacity-60"
          >
            {regenerating ? "Regenerating…" : "Regenerate"}
          </button>
        </div>
      ) : null}
      {view === "handoff" ? (
        <HandoffMount review={review} slug={slug} navigate={navigate} />
      ) : view === "map" ? (
        // `?view=map` shows this session's PROJECT context map — the destination the top
        // bar's Map toggle has advertised since C03 §4.3 and the one the docs describe
        // ("Map opens the project's context map"). There was no `map` branch here AT ALL, so
        // the toggle lit up, the URL gained `?view=map`, and the board the reviewer was
        // already reading stayed on screen with nothing to say it had failed. Reuses the same
        // `ProjectContextMapView` that `/projects/:id/map` mounts, with Back routed to the
        // board so leaving the map does not leave the session. The wrapper supplies the
        // height and scroller the surrounding column expects.
        <div className="min-h-0 flex-1 overflow-auto">
          {projectId === undefined ? null : projectId === null ? (
            <MapUnavailable />
          ) : (
            <ProjectContextMapView projectId={projectId} onBack={toBoard} />
          )}
        </div>
      ) : view === "diff" ? (
        <DiffViewContainer
          review={review}
          records={roundRecords}
          recordsPending={roundRecordsPending}
          {...(roundsUnavailable === undefined ? {} : { recordsUnavailable: roundsUnavailable })}
          round={query.round ?? undefined}
        />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {view === "rounds" && roundsUnavailable !== undefined ? (
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
              <LensBoardView
                reviewId={review.id}
                generation={boardGeneration}
                selectedGeneration={query.generation ?? boardGeneration}
                lens={query.lens}
                generations={boardGenerations}
                onGenerationSelect={(generation) =>
                  navigate(
                    sessionPath(slug, {
                      view: "board",
                      lens: query.lens,
                      generation: generation === boardGeneration ? undefined : generation,
                      file: query.file ?? undefined,
                      round: query.round ?? undefined,
                      ask: query.ask ?? undefined,
                    }),
                    { replace: true },
                  )
                }
              />
            </>
          )}
        </div>
      )}
      <ExitFab mode={mode} open={view === "handoff"} onToggle={toHandoff} />
    </div>
  );
}

/**
 * `?view=map` with no project to map. The context map is a PROJECT's, and only the session row
 * can name which project — so this is what a legacy `/s/<reviewId>` link reaches (a link that
 * resolves a review no session row names), and equally what an unreadable `session.list`
 * reaches. The copy is deliberately true of both: it says the project is UNKNOWN, never that
 * the project is absent, because those are different facts and only one of them was proved.
 *
 * The Map toggle STAYS in the top bar — the rounds-unavailable precedent below: hiding a
 * control behind an absence puts the reason out of reach. Clicking it states the fact rather
 * than re-rendering the board and looking like nothing happened. Every other view remains
 * exactly as reachable.
 */
function MapUnavailable() {
  return (
    <>
      <header className="border-border border-b px-6 py-3">
        <p className="eyebrow m-0 text-2xs font-semibold uppercase tracking-wide text-ink-faint">
          CONTEXT MAP
        </p>
      </header>
      <section
        data-testid="map-unavailable"
        role="status"
        className="mx-auto flex w-full max-w-[820px] flex-col gap-2 p-6"
      >
        <h1 className="font-display text-foreground text-xl">
          Rennet cannot tell which project this review belongs to.
        </h1>
        <p className="text-muted-foreground text-sm">
          A context map is a project&rsquo;s, and the session that owns this review is what names
          its project. This address reached the review without one — opening it from its session in
          the sidebar reaches its map.
        </p>
      </section>
    </>
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
// then take over the live run route. The app tree supplies the LIVE source (`routes/app.tsx`'s
// `LiveRoundsScope`, C15 3.2), whose `dispatch` is unconditional — so on the shipping path
// `onDispatch` IS wired and the button goes live the moment an ask stages. `dispatch` is absent
// only under the honest-absent default (a tree with no rounds scope, i.e. unit mounts), and there
// the button stays disabled rather than offering a dead click that lies.
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
      unavailable={exits.unavailable}
    />
  );
}
