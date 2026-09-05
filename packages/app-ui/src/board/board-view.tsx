import type {
  BoardDocument,
  LensAbsenceReason,
  LensBoard,
  LensKind,
  LensSection,
  SourceRef,
} from "@rennet/protocol";
import { cn } from "@rennet/ui";
import { type RefCallback, useEffect, useMemo } from "react";
import { useCoachAnchor } from "../coach/registry";
import { useRefreshCommand } from "../data";
import { ProseSelectionLayer, ReviewAnchoredAskProvider, RichText } from "../review";
import { useRennetStore } from "../store";
import {
  type BoardResolution,
  lensBoardsFromResolutions,
  lensesWithResult,
  lensReadsSettled,
  useLensBoardResolutions,
  useLensSeats,
} from "./board-data";
import { SourceChips } from "./design-meta";
import { DesignCapabilityGrid } from "./design-structure";
import { GenerationSwitcher } from "./generation-switcher";
import { BoardElementsProvider, useBoardPatchsetId } from "./kinds/element-context";
import { liveBoards, useLensDrafts } from "./live-draft";
import { SeatWidget } from "./seat-widget";
import { Section } from "./section";
import { useGenerationRetry } from "./workspace-header";

// ─────────────────────────────────────────────────────────────────────────────
// The lens board document (C05 6.1, Objective clause 6) — the review's reading
// heart. It assembles one lens board's sections in reading order under the board
// title, wrapped in C4's `ProseSelectionLayer` so a selection anywhere raises the
// Comment/Explain/Request-Changes toolbar (no duplicate toolbar logic — 6.2/5.2),
// and mounts the element pool through `BoardElementsProvider` so every citation
// resolves against the resolved board (never a walked prop tree).
//
// The lens switcher lives in the session top bar. This document receives the URL-owned
// `(generation, lens)` selection and keeps only the generation drill-down beside the
// document it changes. There is no second local selection authority here.
//
// Fold-all: EVERY section on EVERY lens starts folded, delta sections included. The
// reader arrives at a page of summaries and opens the ones they want (Rai, 2026-09-04,
// retiring R44's Flagged-opens-expanded). What a section shows once opened is the other
// half of the same rule — see `useCitationsOpenByDefault`: outside Noise and Design the
// cited code is already revealed, so opening a stop costs one click, not two.
// ─────────────────────────────────────────────────────────────────────────────

/** How often an unsettled board re-reads its lenses, how many consecutive
 *  learned-nothing reads it takes before the poll SLOWS (10 minutes of silence), and the
 *  cadence it slows to. It never stops — see the effect below for why. */
const POLL_MS = 5_000;
/** The cadence while a seat is actually writing — fast enough that a board fills in front
 *  of the reviewer rather than in five-second steps (lens-board-tools 5.3). */
const DRAFTING_POLL_MS = 1_500;
const POLL_LIMIT = 120;
const SLOW_POLL_MS = 60_000;
const SLOW_POLL_EVERY = SLOW_POLL_MS / POLL_MS;

export interface LensBoardViewProps {
  /** The session route this workspace is on — how the lanes (and so the seat states)
   *  are read. Empty ⇒ no session, so no lanes and no widget. */
  readonly slug: string;
  /** The review whose boards are read — half of the `board.read` identity. */
  readonly reviewId: string;
  /** The live generation to open on. */
  readonly generation: string;
  /** The generation selected in the session URL. Absent means the live generation. */
  readonly selectedGeneration?: string;
  /** The lens selected in the session URL. */
  readonly lens: LensKind;
  /** All generation ids for this review, oldest → newest (for drill-down). Defaults
   *  to just the live one, so the generation switcher stays hidden until there is a
   *  frozen predecessor to drill into. */
  readonly generations?: readonly string[];
  /** Replace the session URL with a generation selection. */
  readonly onGenerationSelect?: (generation: string) => void;
}

export function LensBoardView({
  slug,
  reviewId,
  generation,
  selectedGeneration = generation,
  lens,
  generations = [generation],
  onGenerationSelect = () => undefined,
}: LensBoardViewProps) {
  // The `highlight` coach mark anchors the prose document (centered on the region) — it
  // only registers once a board actually renders, so an empty/error board never elects it.
  const highlightRef = useCoachAnchor("highlight");

  const resolutions = useLensBoardResolutions(reviewId, selectedGeneration);
  // The boards being WRITTEN, folded from the element stream (D11). A lens with an open
  // draft renders from this; a lens whose lane has closed renders from the durable read,
  // which is the copy that carries the patchset stamps and the delta marks.
  const drafts = useLensDrafts(reviewId, selectedGeneration);
  const liveByLens = liveBoards(drafts);
  const seats = useLensSeats(slug, resolutions);
  const lenses = lensBoardsFromResolutions(resolutions, seats);
  // The FALLBACK set is the lenses that have something to open, not the rail's list: the
  // rail now lists all five from the first frame, so `lenses[0]` is always Design and
  // falling back to it would open an empty board over a settled sibling.
  const available = lensesWithResult(lenses).map((l) => l.lens);

  // Drafting takes minutes and the daemon has no board-arrival push, so without this the
  // boards a capture just kicked would land on disk and the surface would keep saying "no
  // board for this generation yet" until the window happened to regain focus (the only other
  // thing that invalidates `board.read`). `useCommand` has no polling, so this is it.
  //
  // ponytail: a 5s poll while any lens is still missing, THROTTLED two ways because the
  // unthrottled version polled a never-settling board at 5s for as long as it was on screen
  // (perf audit 2026-08-31, §1 H1) — a review whose Noise lens legitimately drafted nothing
  // never settles, so "stop when it settles" is not a stop condition. (1) A hidden document
  // polls not at all, and a paused tick spends no budget, so a window left in the background
  // for an hour comes back with its full window intact. (2) After `POLL_LIMIT` consecutive
  // ticks that observed NO lens status change, the poll drops to `SLOW_POLL_MS` — at 5s that
  // is ten minutes of complete silence before slowing, far longer than the gap between two
  // lenses landing in a slow round (drafting is per-lens minutes, and any status change
  // restarts the fast window through `statusKey`).
  //
  // It slows rather than STOPS, because for most reviews this poll is the only way a board
  // ever arrives on screen: the focus-invalidate escape hatch is gated on `fromWorkingTree`
  // (app/review-workspace-route.tsx), so a PR-snapshot review whose board first lands after
  // the budget would sit on "no board yet" until the reviewer remounted it. One read a minute
  // is not the burn the audit measured; a silent surface is a bug. Upgrade path: a daemon-side
  // board-arrival channel (the `roundProgress` push already proves the transport), at which
  // point this whole effect goes and neither throttle is needed.
  //
  // DRAFTING IS THE FAST WINDOW, AND IT IS THE FALLBACK PATH (lens-board-tools 5.3). The
  // element stream above is how a board fills in front of the reviewer; `onLensDraft` is
  // OPTIONAL on the bridge, so a host that does not provide it has only this read, and a
  // five-second cadence would make "renders each element as it lands" land in five-second
  // batches. While any seat is working the poll runs at `DRAFTING_POLL_MS` and every tick
  // reads; it reverts to the throttled cadence the moment the last seat stops, which is
  // what keeps the never-settling case off the burn the audit measured — the budget
  // answered SILENCE, and a working seat is the opposite of silence.
  const refreshBoards = useRefreshCommand("board.read");
  const awaitingLenses = !lensReadsSettled(resolutions);
  const anyWorking = Object.values(seats).some((state) => state.register === "working");
  // The observable "something happened": a lens moving BETWEEN statuses — missing/pending to
  // valid/absent/failed/invalid, or back. This is a STATUS key, not a content key: a settled
  // lens that re-drafts different content stays `valid` and does NOT restart the budget. An
  // unchanged key means no lens changed status, which is exactly what the budget counts.
  const statusKey = Object.values(resolutions)
    .map((resolution) => resolution.status)
    .join(",");
  // biome-ignore lint/correctness/useExhaustiveDependencies: statusKey is an intentional re-run trigger, not a body reference — a lens changing status must restart the poll's fast window, and re-running the effect is what resets `spent`.
  useEffect(() => {
    if (!awaitingLenses && !anyWorking) return;
    let spent = 0;
    const tick = () => {
      if (document.hidden) return;
      spent += 1;
      // Past the budget the interval keeps waking but only reads once a minute. A working
      // seat is never throttled: something IS arriving.
      if (!anyWorking && spent > POLL_LIMIT && spent % SLOW_POLL_EVERY !== 0) return;
      refreshBoards();
    };
    const timer = setInterval(tick, anyWorking ? DRAFTING_POLL_MS : POLL_MS);
    // Electron throttles a hidden window's timers to about one wake a minute, so coming back
    // to the window reads immediately instead of waiting out a throttled tick. This read is
    // free of the budget: returning to the window is the user telling us to look again, and
    // charging it would let alt-tabbing burn the very window it is meant to refresh.
    const onVisibility = () => {
      if (!document.hidden) refreshBoards();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [anyWorking, awaitingLenses, refreshBoards, statusKey]);

  // A generation may not carry every lens. A genuinely missing selected lens falls back
  // to the first populated, empty, or failed lens in canonical order. Invalid and pending
  // selected boards stay selected so their honest state is surfaced rather than hidden.
  const selected = resolutions[lens];
  const fallbackLens = available[0] ?? lens;
  const fallback = resolutions[fallbackLens];
  // A lens whose durable board has not arrived but whose seat is WRITING one holds the
  // selection: the reviewer asked for that lens and there is a board of it on screen, so
  // falling back to a settled sibling would move them off the thing they are watching.
  const effectiveLens: LensKind =
    selected.status === "missing" && liveByLens[lens] === undefined ? fallbackLens : lens;

  // Every lens folds every section, Flagged included (Rai, 2026-09-04). R44's
  // findings-open-on-arrival is retired: the reader takes the summaries first and opens
  // what they want to read. `undefined` leaves each section its own (folded) default.
  const forceOpen = undefined;

  // Resolve the board to SHOW through the same seam, so an INVALID board renders as an
  // honest error rather than "no board yet" (finding 1). The display lens is the
  // effective (valid) lens; with none present, probe the reviewer's pick or the R44
  // default so a malformed board there still surfaces instead of vanishing.
  const shown = effectiveLens === lens ? selected : fallback;
  // THE LIVE BOARD WINS WHILE THE LANE IS OPEN (D11). `board.read` serves the copy the
  // pipeline persisted; the element stream serves the one the seat is writing. Comparing
  // them here is the only place the two sources meet: an open draft is the fresher of the
  // two and is what the reviewer is watching, and the moment the lane closes the durable
  // copy takes over — it is the one that carries the patchset stamps and the delta marks
  // a drafting element has never had.
  const drafted = liveByLens[effectiveLens];
  const board = drafted ?? (shown.status === "valid" ? shown.board : undefined);
  const entry = lenses.find((candidate) => candidate.lens === effectiveLens);
  const seat = seats[effectiveLens];
  // The drafting signals belong to the LIVE generation. Drilling into a frozen predecessor
  // shows a finished board, and painting this generation's running seat over it would say
  // a settled board is still being written.
  const live = selectedGeneration === generation;
  const drafting = live && seat.drafting;
  const { retry, pending: retrying } = useGenerationRetry(slug);

  // ONE CONTROL, THREE PANES (6.2/D14). Selecting a lens moves the board, the widget and
  // the transcript together, so the three cannot describe different lenses — a drawer left
  // on the Sequence seat above the Decisions board is exactly the kind of quiet mismatch a
  // reviewer reads straight past. The transcript follows to the new lens's own seat when it
  // has one, and closes when it does not, because there is nothing there to show.
  const openTranscript = useRennetStore((s) => s.ui.seatTranscript);
  const openSeatTranscript = useRennetStore((s) => s.uiActions.openSeatTranscript);
  const transcriptLens = openTranscript?.lens;
  const transcriptReview = openTranscript?.reviewId;
  const followed = seat.voices.find((voice) => voice.thread !== undefined);
  // Depended on by IDENTITY-FREE parts: `voices` is rebuilt on every render, so an effect
  // keyed on the object would re-run every render for nothing.
  const followedSeat = followed?.seat;
  const followedEnvironment = followed?.thread?.environmentId;
  const followedThread = followed?.thread?.threadId;
  useEffect(() => {
    if (transcriptReview === undefined || transcriptReview !== reviewId) return;
    if (transcriptLens === effectiveLens) return;
    openSeatTranscript(
      followedSeat === undefined ||
        followedEnvironment === undefined ||
        followedThread === undefined
        ? null
        : {
            reviewId,
            lens: effectiveLens,
            seat: followedSeat,
            thread: { environmentId: followedEnvironment, threadId: followedThread },
          },
    );
  }, [
    effectiveLens,
    followedEnvironment,
    followedSeat,
    followedThread,
    openSeatTranscript,
    reviewId,
    transcriptLens,
    transcriptReview,
  ]);

  return (
    <main
      data-kind="lens-board-view"
      className={cn(
        "mx-auto flex w-full flex-col gap-8 px-8 py-8",
        board?.document.measure === "structured" ? "max-w-[960px]" : "max-w-[760px]",
      )}
    >
      <div className="flex flex-col gap-2">
        <GenerationSwitcher
          generations={generations}
          selected={selectedGeneration}
          current={generation}
          onSelect={onGenerationSelect}
        />
      </div>

      {/* THE SEAT WIDGET, directly above the board it is writing (6.1). Live generation
          only: a frozen predecessor's seats are long gone, and naming one would be a claim
          about a run that is over. */}
      {entry !== undefined && live && slug.length > 0 ? (
        <SeatWidget
          reviewId={reviewId}
          entry={entry}
          retrying={retrying}
          {...(board === undefined ? {} : { board })}
          {...(retry === undefined ? {} : { onRetry: retry })}
        />
      ) : null}

      {board ? (
        <LensBoardDocument
          reviewId={reviewId}
          board={board}
          forceOpen={forceOpen}
          anchorRef={highlightRef}
          drafting={drafting}
        />
      ) : (
        <BoardAccount resolution={shown} drafting={drafting} />
      )}
    </main>
  );
}

/**
 * The account a NON-`valid` resolution gives of itself — the one vocabulary every board
 * surface uses for these states, so the workspace and the bench never explain the same
 * failure two ways. A `valid` resolution renders nothing here: its document is the
 * caller's to place (the workspace wraps it differently from the bench).
 *
 * The bench used to render `null` for every one of these while its reader still read
 * "drafted" or "reworked" — a settled lane with no board and no reason (Codex review,
 * 2026-09-03). Reusing this component is what keeps that from happening again in a
 * second set of words.
 */
export function BoardAccount({
  resolution,
  drafting = false,
}: {
  readonly resolution: BoardResolution;
  /** This lens's seat is still writing. A board that has not answered yet then reads as
   *  a board being written rather than as an absence — and it carries the same two
   *  in-board provisional signals a partial board does, so "an unsettled board says so
   *  three ways" is true at every moment of the lane, not only once elements exist. */
  readonly drafting?: boolean;
}) {
  switch (resolution.status) {
    case "valid":
      return null;
    case "invalid":
      return (
        <div
          data-kind="board-error"
          data-reason={resolution.reason}
          className="text-danger text-sm"
        >
          <p className="font-medium">This board could not be read.</p>
          <p className="text-muted-foreground">
            {resolution.reason === "identity"
              ? "The source returned a board for a different lens or generation."
              : resolution.reason === "excluded-kind"
                ? "The board carries an element kind that no lens board renders."
                : resolution.reason === "unreadable"
                  ? "The board read failed, so its contents are unknown."
                  : "The board data did not match the expected shape."}
          </p>
        </div>
      );
    case "pending":
      return drafting ? (
        <EmptyDraftingBoard />
      ) : (
        <p data-kind="board-pending" className="text-muted-foreground text-sm">
          Reading this board…
        </p>
      );
    case "absent":
      return (
        <div data-kind="board-absent" className="text-muted-foreground text-sm">
          <p className="font-medium text-foreground">{absenceCopy(resolution.reason).title}</p>
          <p>{absenceCopy(resolution.reason).detail}</p>
        </div>
      );
    case "failed":
      return (
        <div
          data-kind="board-failed"
          data-classification={resolution.account?.classification}
          role="alert"
          className="text-danger text-sm"
        >
          <p className="font-medium">This lens failed to generate.</p>
          <p className="text-muted-foreground">{resolution.reason}</p>
          {resolution.account?.classification === "retryable" ? (
            <p className="text-muted-foreground">
              Another drafting attempt can still produce this board.
            </p>
          ) : null}
        </div>
      );
    default:
      return drafting ? (
        <EmptyDraftingBoard />
      ) : (
        <p data-kind="board-empty" className="text-muted-foreground text-sm">
          No board for this generation yet.
        </p>
      );
  }
}

/** A board whose seat is writing and whose first element has not landed. It carries the
 *  same in-progress mark and placeholder row a partial board does — the rail's indicator
 *  is the third — so the three-ways rule (D13) holds from the lane's first second. */
function EmptyDraftingBoard() {
  return (
    <div data-kind="board-drafting" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <InProgressChip />
        <span className="text-muted-foreground text-sm">This board is still being written.</span>
      </div>
      <GhostRow />
    </div>
  );
}

/** The in-progress mark: one of the three independent ways an unsettled board says so. */
function InProgressChip() {
  return (
    <span
      data-kind="board-in-progress"
      className="rounded-chip border border-line px-2 py-0.5 font-medium text-2xs text-ink-soft uppercase tracking-wide"
    >
      in progress
    </span>
  );
}

/** The placeholder last row: the third of the three, and the one that says WHERE the
 *  next element lands rather than merely that one is coming. */
function GhostRow() {
  return (
    <p
      data-kind="board-ghost"
      className="rounded-window border border-line border-dashed px-4 py-3 text-center font-serif text-13 text-ink-faint"
    >
      The seat is still writing — the next element lands here.
    </p>
  );
}

/**
 * One resolved board as a document: the ask provider, the element pool and the selection
 * layer around the article. It is THE SAME VIEW settled or not (D13) — the drafting view
 * and the finished view are one route, one component, and nothing navigates when the lane
 * settles. `drafting` only adds the two in-board provisional signals and withholds the
 * delta marks; the elements themselves render identically either way.
 */
export function LensBoardDocument({
  reviewId,
  board,
  forceOpen,
  anchorRef,
  drafting = false,
}: {
  readonly reviewId: string;
  readonly board: LensBoard;
  /** Force every section open (the Flagged default, R44); undefined keeps each section's own. */
  readonly forceOpen?: boolean;
  /** The coach anchor for the document — the workspace's alone, since an anchor id
   *  registers once and the bench can show several documents at a time. */
  readonly anchorRef?: RefCallback<Element>;
  /** This board's seat is still writing it. */
  readonly drafting?: boolean;
}) {
  // WITHHELD WHILE UNSETTLED (5.4/D13). A partial board's sections would every one carry a
  // `new` delta the moment a regeneration started writing them, which reads as "all of this
  // changed this round" — a lie the reviewer would act on by re-reading a whole board. The
  // marks are the round's answer and they belong to a finished round, so they appear at
  // settle. The stripped list is stable across renders for the same board and flag, which
  // matters because `Section` is `memo`'d on its `entry`.
  const sections = useMemo(
    () =>
      drafting
        ? board.sections.map(({ delta, ...rest }): LensSection => {
            void delta;
            return rest;
          })
        : board.sections,
    [board.sections, drafting],
  );
  return (
    <ReviewAnchoredAskProvider reviewId={reviewId}>
      <BoardElementsProvider
        elements={board.elements}
        reviewId={reviewId}
        generation={board.generation}
        boardId={board.boardId}
        lens={board.lens}
      >
        <ProseSelectionLayer>
          {/* Key the document subtree by boardId (finding 5): gen0/gen1 reuse section
            refs (change/design/tasks), so without a board-identity key switching
            generation would keep the prior board's per-section fold `useState`.
            Remounting on boardId resets fold state to the new board's foldAll. */}
          <article
            key={board.boardId}
            ref={anchorRef}
            data-lens={board.lens}
            data-generation={board.generation}
            className="flex flex-col"
          >
            <BoardHeader board={board} drafting={drafting} />
            {board.lens === "design" ? <DesignCapabilityGrid board={board} /> : null}
            <div className="flex flex-col gap-8">
              {sections.map((entry) => (
                <Section key={entry.ref} entry={entry} lens={board.lens} defaultOpen={forceOpen} />
              ))}
              {drafting ? <GhostRow /> : null}
            </div>
          </article>
        </ProseSelectionLayer>
      </BoardElementsProvider>
    </ReviewAnchoredAskProvider>
  );
}

function absenceCopy(reason: LensAbsenceReason): {
  readonly title: string;
  readonly detail: string;
} {
  switch (reason) {
    case "no-material":
      return {
        title: "No Design specification applies to this change.",
        detail:
          "There is no applicable specification to project into a Design board for this generation.",
      };
    // Reachable only by opening a `no-spec` Design board directly: the lens list omits
    // the tab (`lensBoardsFromResolutions`), so the switcher never routes here.
    case "no-spec":
      return {
        title: "No spec found for this branch.",
        detail: "This branch has no specification document to read the change against.",
      };
    case "no-decisions":
      return {
        title: "No material engineering decisions were found.",
        detail: "The change did not contain a judgment call with a viable alternative.",
      };
    case "no-findings":
      return {
        title: "No review findings were found.",
        detail: "No concrete review findings remain for this generation.",
      };
    case "no-noise":
      // D16e — the Noise board is the complement of the other four, so an empty one means
      // they cited the whole change between them. It is settled by the host before any
      // seat runs, which is why the copy says what the other boards did rather than what
      // a Noise seat concluded.
      return {
        title: "Every changed region is on another board.",
        detail: "Design, Sequence, Decisions and Flagged cited the whole change between them.",
      };
  }
}

function sourceTarget(
  board: LensBoard,
  byId: ReadonlyMap<string, LensBoard["elements"][number]>,
  source: SourceRef,
): string | undefined {
  return board.sections.find(({ ref }) => {
    const section = byId.get(ref);
    if (section?.kind !== "section") return false;
    return (section.data.sources ?? []).some(
      (candidate) => candidate.path === source.path && candidate.candidate === source.candidate,
    );
  })?.ref;
}

function BoardHeader({
  board,
  drafting = false,
}: {
  readonly board: LensBoard;
  readonly drafting?: boolean;
}) {
  const document: BoardDocument = board.document;
  // One index for every source chip, instead of one rebuilt per chip per render.
  const byId = useMemo(
    () => new Map(board.elements.map((element) => [element.id, element])),
    [board.elements],
  );
  return (
    <header className="mb-8 flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-2">
        <h1 className="font-display font-semibold text-2xl text-foreground tracking-tight">
          {document.title}
        </h1>
        {drafting ? (
          <>
            <InProgressChip />
            <span className="text-muted-foreground text-sm">
              This board is still being written.
            </span>
          </>
        ) : null}
      </div>
      {document.stats && document.stats.length > 0 ? (
        <dl data-kind="board-stats" className="flex flex-wrap items-baseline gap-x-5 gap-y-2">
          {document.stats.map((stat) => (
            <div
              key={stat.label}
              data-kind={
                board.lens === "design" && stat.label.toLowerCase() === "format"
                  ? "design-format"
                  : "board-stat"
              }
              className={cn(
                "flex items-baseline gap-1.5",
                board.lens === "design" &&
                  stat.label.toLowerCase() === "format" &&
                  "rounded-chip border border-line bg-raised px-2 py-1",
              )}
            >
              <dt className="text-2xs text-muted-foreground">{stat.label}</dt>
              <dd
                className={cn(
                  "font-medium text-sm text-foreground",
                  board.lens === "design" && stat.label.toLowerCase() === "format" && "font-mono",
                )}
              >
                {stat.value}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
      {document.introMarkdown.length > 0 ? <BoardIntro markdown={document.introMarkdown} /> : null}
      <SourceChips
        sources={document.sources ?? []}
        kind="artifact"
        {...(board.lens === "design"
          ? { targetForSource: (source: SourceRef) => sourceTarget(board, byId, source) }
          : {})}
      />
    </header>
  );
}

function BoardIntro({ markdown }: { readonly markdown: string }) {
  const patchsetId = useBoardPatchsetId();
  return (
    <RichText
      text={markdown}
      patchsetId={patchsetId}
      className="-mt-3"
      paragraphClassName="text-sm leading-relaxed text-muted-foreground"
    />
  );
}
