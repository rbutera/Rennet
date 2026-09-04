import {
  generationIdForPatchset,
  type LaneLatest,
  type LaneSeat,
  type LaneThreadRef,
  type LensKind,
  type LensLane,
  newCommandId,
  type Review,
  type SessionPreparation,
  type SidebarSession,
} from "@rennet/protocol";
import { Button, cn } from "@rennet/ui";
import { useEffect } from "react";
import { BoardAccount, LensBoardDocument } from "../board";
import { useLensBoardResolutions } from "../board/board-data";
import { lensSlot, lensTint } from "../board/lens-colour";
import { useMutation, useRefreshCommand } from "../data";
import { useRennetStore } from "../store";

// ─────────────────────────────────────────────────────────────────────────────
// The bench (t3-lens-threads 3.1) — the FIRST FRAME of a review's workspace, not a
// screen in front of it. It mounts in the session outlet, inside `AppLayout`, so the
// sidebar, the session top bar and the chat slot stay around it the whole time: the
// reviewer can open a lens transcript in the slot while the lenses are still running.
//
// The scene, and why it is a scene rather than the lane table it replaces:
//
//   • THE SLAB is the change itself — the branch or pull request the reviewer started
//     from, and once capture settles, how much of it was captured. Capture is the first
//     BEAT of this same scene (two named steps on the slab's rail), never a separate
//     page. The workspace is already open while it runs.
//   • FIVE READERS stand under the slab, each holding the CORE SAMPLE it drew out of
//     the change: a plug on a shaft rising into a socket in the slab's underside, in
//     that lens's own colour, with a live line of speech under it — what the seat is
//     doing right now.
//   • EVERY READER IS A CONTROL. Activating one points the chat slot at that seat's T3
//     thread (`uiActions.openLensThread`) and opens the dock. A lane with no thread yet
//     is disabled rather than pretending it has a transcript.
//
// COLOUR IS IDENTITY HERE, NOT STATE. Each lane binds its lens's hue from the theme's
// portable register (board/lens-colour.ts) — Flagged red, Decisions yellow, Design
// blue, Sequence green, Noise neutral — so the colour answers "which reader is this",
// the same question the lens rail's stops answer above. Which means state cannot ALSO
// be colour: the registers a reviewer must tell apart are carried by the way the
// sample is CUT and by the words under it, and a failed lane is a snapped plug in its
// own lens colour, never a red one. Waiting and absent are quiet, and they are quiet
// in different words: "queued" is a promise, an absent lens's `reason` is a result.
//
// It never invents state. A running lane with no `latest` yet says so ("under way"); an
// `idle` projection is rendered in the quiet voice with the daemon's own words ("quiet
// for 40s"), not frozen on a stale line.
// ─────────────────────────────────────────────────────────────────────────────

/** The visual register a lane reads in — five lane states, five things a reader can be. */
type Register = "waiting" | "working" | "settled" | "absent" | "failed";

function registerOf(lane: LensLane): Register {
  if (lane.status === "queued") return "waiting";
  if (lane.status === "running") return "working";
  if (lane.status === "failed") return "failed";
  if (lane.status === "absent") return "absent";
  return "settled";
}

/** One voice at the reader: a seat with its thread and its own live line. A lane that
 *  predates `seats` (or has none yet) speaks with one voice, the lane's own. */
interface Voice {
  readonly seat: string;
  /** Named only when the lane has more than one voice — a single seat is just the lens. */
  readonly name?: string;
  readonly thread?: LaneThreadRef;
  readonly latest?: LaneLatest;
}

const PROVIDER_NAME: Readonly<Record<LaneSeat["provider"], string>> = {
  claudeAgent: "Claude",
  codex: "Codex",
};

function voicesOf(lane: LensLane): readonly Voice[] {
  const seats = lane.seats ?? [];
  if (seats.length === 0) {
    return [
      {
        seat: lane.id,
        ...(lane.thread === undefined ? {} : { thread: lane.thread }),
        ...(lane.status === "running" && lane.latest !== undefined ? { latest: lane.latest } : {}),
      },
    ];
  }
  return seats.map((seat) => ({
    seat: seat.seat,
    ...(seats.length > 1 ? { name: PROVIDER_NAME[seat.provider] } : {}),
    ...(seat.thread === undefined ? {} : { thread: seat.thread }),
    ...(lane.status === "running" && seat.latest !== undefined ? { latest: seat.latest } : {}),
  }));
}

/** What a voice is saying, and whether it is said quietly (a promise or a lull, not work
 *  in progress). Read off the arm that HAS the words — never guessed. */
function speechOf(
  lane: LensLane,
  latest: LaneLatest | undefined,
): { readonly text: string; readonly quiet: boolean } {
  switch (lane.status) {
    case "queued":
      return { text: "queued", quiet: true };
    case "running":
      // No projection yet is its own honest state: the thread exists, nothing has come
      // off it. Saying "reading the change" here would be an invention.
      if (latest === undefined) return { text: "under way", quiet: true };
      return { text: latest.text, quiet: latest.kind === "idle" };
    case "drafted":
      return { text: "drafted", quiet: false };
    case "done":
      return {
        text: lane.verdict === "carrying-forward" ? "carrying forward" : "reworked",
        quiet: false,
      };
    default:
      // `absent` and `failed` both carry the drafter's own reason.
      return { text: lane.reason, quiet: lane.status === "absent" };
  }
}

// ── The core sample ──────────────────────────────────────────────────────────
// Each reader draws ONE core out of the change and lays it on the bench: a 12×44
// plug, cut from the slab it hangs under, in that lens's own colour. It replaces the
// gold circle-with-icon, and the swap is the point — five gold discs said "five
// things are happening"; five cores in five colours say WHICH five, and each one
// says what state it is in through its own structure.
//
// THE STATE IS THE CUT, NOT THE AMOUNT. `LensLane` carries no progress — status,
// verdict, and a latest line, nothing that could honestly fill a bar — so nothing
// here grows, fills, or completes. Each register is a different way the sample is
// cut, which is why a reader can tell them apart with the colour turned off:
//
//   queued     an empty tube: wall only, no strata. Nothing has been drawn yet.
//   under way  dashed strata — the cut is still open — and a lamp travelling down
//              the sample. The one moving thing on the bench, and it means reading.
//   settled    solid strata: the sample is cut clean, and it stops moving.
//   reworked   the same, plus a SEAM across the middle where the core was re-cut.
//              A lane that carried forward has no seam; the speech says which.
//   failed     the sample SNAPPED: two pieces, offset, with the lower one blank.
//   absent     a dashed outline — the socket was never filled.
//
// Failure is a break, never a colour: Flagged owns red now, so a red plug means
// "this is the Flagged lane", and a red Design lane would be a lie. The reason text
// under it says what went wrong; the snap says that something did.
//
// The plug is lens-AGNOSTIC on purpose — it paints in `lens`/`lens-soft`/`lens-line`,
// which resolve against whatever `--rn-lens` the lane bound above it (see
// board/lens-colour.ts). Adding a lens does not touch this component.

const CORE_W = 12;
const CORE_H = 44;
/** Where the three strata sit. The stadium wall is straight between y=6 and y=38, so
 *  every stratum runs the full inner width and none clips into a rounded cap. */
const STRATA_Y = [14, 22, 30] as const;
/** A snapped sample, as two pieces with jagged facing edges and nothing between them.
 *  The break is a SHAPE: it has to survive the colour being ignored, because the
 *  colour now says which lens this is, not whether it went wrong. */
const SNAP_TOP = "M1 6 A5 5 0 0 1 11 6 L11 19 L7.5 21 L4 18 L1 20 Z";
const SNAP_BOTTOM = "M1 25 L4.5 27 L8 24 L11 26 L11 38 A5 5 0 0 1 1 38 Z";

function CoreSample({
  register,
  reworked,
}: {
  readonly register: Register;
  readonly reworked: boolean;
}) {
  const cut = register === "settled";
  const open = register === "working";
  const quiet = register === "absent" || register === "waiting";
  return (
    <svg
      viewBox={`0 0 ${CORE_W} ${CORE_H}`}
      width={CORE_W}
      height={CORE_H}
      fill="none"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="text-lens"
    >
      {register === "failed" ? (
        <>
          <path d={SNAP_TOP} stroke="currentColor" strokeWidth={1.5} />
          <line x1={2.5} y1={12} x2={9.5} y2={12} stroke="currentColor" strokeWidth={1} />
          {/* The lower piece is blank and dimmed: whatever this seat was cutting, it
              never got that far. */}
          <path
            d={SNAP_BOTTOM}
            stroke="currentColor"
            strokeWidth={1.5}
            className="text-lens-line"
          />
        </>
      ) : (
        <>
          {/* The wall. Dashed when the socket was never filled — an absent lens is a
              result, so its sample is drawn empty rather than left out. */}
          <rect
            x={1}
            y={1}
            width={CORE_W - 2}
            height={CORE_H - 2}
            rx={(CORE_W - 2) / 2}
            stroke="currentColor"
            strokeWidth={register === "absent" ? 1 : 1.5}
            {...(register === "absent" ? { strokeDasharray: "2 3" } : {})}
            {...(quiet ? { className: "text-lens-line" } : {})}
          />
          {(cut || open) &&
            STRATA_Y.map((y) => (
              <line
                key={y}
                x1={2}
                y1={y}
                x2={CORE_W - 2}
                y2={y}
                stroke="currentColor"
                strokeWidth={1}
                // An open cut versus a clean one — a difference of PATTERN, so neither
                // can be read as "further along" than the other.
                {...(open ? { strokeDasharray: "1.5 2" } : {})}
              />
            ))}
          {cut && reworked && (
            // The seam: a doubled rule where the core was taken a second time.
            <>
              <line
                x1={1.5}
                y1={21}
                x2={CORE_W - 1.5}
                y2={21}
                stroke="currentColor"
                strokeWidth={1.5}
              />
              <line
                x1={1.5}
                y1={23.5}
                x2={CORE_W - 1.5}
                y2={23.5}
                stroke="currentColor"
                strokeWidth={1.5}
              />
            </>
          )}
        </>
      )}
    </svg>
  );
}

// ── The reader ───────────────────────────────────────────────────────────────

/**
 * One reader: the lane's socket, shaft and core sample once, then one line of speech
 * PER SEAT, each its own control. A lane with one seat (every lens but Flagged) reads
 * exactly as before; Flagged shows two lines, each naming its speaker, because a
 * Claude seat and a Codex seat are two voices with two transcripts, not one voice
 * that keeps changing its mind.
 */
function Reader({ lane, reviewId }: { readonly lane: LensLane; readonly reviewId?: string }) {
  const register = registerOf(lane);
  const voices = voicesOf(lane);
  const reading = lane.status === "running" && voices.some((v) => v.latest?.kind === "tool");
  const reworked = lane.status === "done" && lane.verdict !== "carrying-forward";

  return (
    <div
      data-row={lane.id}
      data-status={lane.status}
      data-register={register}
      data-lens-slot={lensSlot(lane.id)}
      // The lane BINDS its hue here; everything below paints in `lens`. Bound on the
      // column rather than on the mark so a future lane-level accent inherits it too.
      className={cn(
        "flex min-w-0 flex-col items-center gap-2 px-1 pb-3 pt-0 text-center",
        lensTint(lane.id),
      )}
    >
      {/* The socket in the slab's underside, and the shaft this core came out on. The
          shaft carries a travelling glance ONLY while a tool call is actually in
          flight — motion that means "this seat is reading the change right now". */}
      <span className="relative flex h-8 w-2 flex-col items-center" aria-hidden="true">
        <span className="h-0.5 w-2 rounded-full bg-lens-line" />
        <span className="w-px flex-1 bg-lens-line" />
        {reading && (
          <span className="absolute bottom-0 size-1 rounded-full bg-lens animate-bench-glance motion-reduce:animate-none" />
        )}
      </span>

      <span
        data-mark="core"
        data-cut={
          register === "failed"
            ? "snapped"
            : register === "absent"
              ? "empty"
              : register === "waiting"
                ? "unstarted"
                : register === "working"
                  ? "open"
                  : reworked
                    ? "seamed"
                    : "clean"
        }
        className="relative flex h-11 w-3 items-start justify-center overflow-hidden rounded-full transition-colors"
      >
        <CoreSample register={register} reworked={reworked} />
        {register === "working" && (
          // The affineur's lamp passing down the sample. `motion-reduce:hidden`, not
          // `animate-none`: parked at the top it would be a static band that reads as
          // a mark of its own, and the dashed strata already say "under way" without
          // it — the state survives the motion being switched off.
          <span className="pointer-events-none absolute inset-x-0 top-0 h-2 rounded-full bg-lens-soft animate-bench-core-scan motion-reduce:hidden" />
        )}
      </span>

      <span className="text-sm font-medium text-ink">{lane.label}</span>
      {voices.map((voice) => (
        <Speech
          key={voice.seat}
          lane={lane}
          voice={voice}
          {...(reviewId === undefined ? {} : { reviewId })}
        />
      ))}
    </div>
  );
}

/** One voice's line, and the control that opens that voice's transcript. */
function Speech({
  lane,
  voice,
  reviewId,
}: {
  readonly lane: LensLane;
  readonly voice: Voice;
  readonly reviewId?: string;
}) {
  const openLensThread = useRennetStore((s) => s.uiActions.openLensThread);
  const setChatOpen = useRennetStore((s) => s.uiActions.setChatOpen);
  const openRef = useRennetStore((s) => s.ui.lensThread);
  const register = registerOf(lane);
  const speech = speechOf(lane, voice.latest);
  // A transcript belongs to a review, and the store slice is global (review finding 4).
  // No review id ⇒ this bench cannot say which review its lanes are for, so its voices
  // open nothing rather than pointing the dock at an unlabelled thread.
  const thread = reviewId === undefined ? undefined : voice.thread;
  const open =
    thread !== undefined &&
    openRef !== null &&
    openRef.reviewId === reviewId &&
    openRef.thread.threadId === thread.threadId;
  return (
    <button
      type="button"
      data-seat={voice.seat}
      disabled={thread === undefined}
      aria-pressed={open}
      onClick={() => {
        if (thread === undefined || reviewId === undefined) return;
        // The dock is opened HERE, not in `openLensThread`: the store action only says
        // WHICH transcript the slot shows, and the slot is hidden at zero width while
        // the chat is closed. A reader that pointed the slot at a thread nobody could
        // see would report "opened" for nothing on screen.
        openLensThread({ reviewId, thread });
        setChatOpen(true);
      }}
      className={cn(
        "flex w-full cursor-pointer flex-col items-center gap-0.5 rounded-control px-1 py-1 transition-colors",
        "hover:bg-raised focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-accent-line",
        open && "bg-raised",
        thread === undefined && "cursor-default hover:bg-transparent",
      )}
    >
      {voice.name !== undefined && (
        <span className="text-2xs font-medium uppercase tracking-wide text-ink-faint">
          {voice.name}
        </span>
      )}
      <span
        data-speech={speech.quiet ? "quiet" : "live"}
        className={cn(
          // Wrap ANYWHERE: a live line is often a git command carrying a full sha or a
          // path with no break opportunity, and a token that will not wrap runs across the
          // neighbouring reader (drive 1.6, second run).
          "line-clamp-3 font-serif text-13 leading-snug [overflow-wrap:anywhere]",
          register === "failed"
            ? "text-danger"
            : speech.quiet
              ? "text-ink-faint italic"
              : "text-ink-soft",
        )}
      >
        {speech.text}
      </span>
    </button>
  );
}

// ── The slab ─────────────────────────────────────────────────────────────────

const CAPTURE_BEATS = [
  { id: "resolving-repository", label: "Resolving the repository" },
  { id: "capturing-change", label: "Capturing the change" },
] as const;

/** Capture as the first beat of the same scene: two named steps on the slab's own rail.
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

/** How much of the change is on the bench, in words that are true at every stage. */
function slabLine(
  preparation: SessionPreparation,
  branch: string | undefined,
  files: number | undefined,
): string {
  const from = branch === undefined ? "" : ` from ${branch}`;
  if (preparation.status === "capturing") {
    return `Rennet is pinning the exact change${from}.`;
  }
  if (files !== undefined) {
    return `${files} ${files === 1 ? "file" : "files"} captured${from}.`;
  }
  return branch === undefined ? "The captured change." : `The captured change on ${branch}.`;
}

// ── The bench ────────────────────────────────────────────────────────────────

export interface PreparationBenchProps {
  readonly session: SidebarSession;
  readonly preparation: SessionPreparation;
  /** The captured review, once `review.load` has answered — the SAME read the workspace
   *  route already runs for this slug (one cache key, one fetch), so the file count on the
   *  slab costs nothing extra. Absent until capture settles. */
  readonly review?: Review;
}

export function PreparationBench({ session, preparation, review }: PreparationBenchProps) {
  const refreshSessions = useRefreshCommand("session.list");
  const refreshBoards = useRefreshCommand("board.read");
  const cancel = useMutation("session.cancelPreparation", { invalidates: ["session.list"] });
  const retry = useMutation("session.retryPreparation", { invalidates: ["session.list"] });
  const active = preparation.status === "capturing" || preparation.status === "drafting";
  const lanes = "lanes" in preparation ? preparation.lanes : undefined;

  // THE BOARDS, as they land. A lane that has settled with a board reveals that board on
  // the bench at once, beneath the readers, without waiting for its siblings (the spec's
  // "boards replace their presence as they settle"). Read through the SAME per-lens
  // `board.read` seam the workspace's `LensBoardView` uses — one cache key per (review,
  // generation, lens), so the workspace that replaces the bench pays nothing again. The
  // generation is the initial one: the bench is the FIRST frame, before any round.
  const reviewId = review?.id ?? "";
  const generation = review === undefined ? "" : generationIdForPatchset(review.activePatchsetId);
  const boards = useLensBoardResolutions(reviewId, generation);
  const settled = (lanes ?? []).filter(
    (lane) => lane.status === "drafted" || lane.status === "done",
  );
  // A settled lane whose board has not answered yet: the draft is on disk a beat before
  // `board.read` has been asked again, so the poll below re-asks until it lands.
  const awaitingBoard = settled.some((lane) => {
    const read = boards[lane.id as LensKind];
    return read !== undefined && (read.status === "missing" || read.status === "pending");
  });
  // The lanes with something to SHOW — a board, or the account of a read that went wrong.
  // Resolved once, up here, because the line above the stack has to know whether the stack
  // exists before either is rendered.
  const landed = settled.flatMap((lane) => {
    const read = boards[lane.id as LensKind];
    return read === undefined || read.status === "missing" || read.status === "pending"
      ? []
      : [{ lane, read }];
  });

  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => {
      refreshSessions();
      if (awaitingBoard) refreshBoards();
    }, 400);
    return () => window.clearInterval(timer);
  }, [active, awaitingBoard, refreshBoards, refreshSessions]);

  const failed = preparation.status === "failed";
  const cancelled = preparation.status === "cancelled";
  // WHICH review these lanes belong to — off the preparation record, which is where the
  // daemon stamped it, not off a second route lookup. A lens transcript is opened against
  // it so the dock can tell this review's thread from the last one's (review finding 4).
  //
  // The SESSION's own `reviewId` is the fallback, and it is not decoration (#819): only the
  // `drafting` arm REQUIRES `reviewId`, while `failed` and `cancelled` make it optional and
  // both of them keep their lanes — threads and all. A preparation that failed after its
  // seats bound their threads therefore drew five readers holding real transcripts that no
  // click could open. `SidebarSession.reviewId` is the durable attach for the same review,
  // written by `attachReview` before drafting starts, so it answers the same question
  // rather than guessing at one.
  const preparationReviewId =
    ("reviewId" in preparation ? preparation.reviewId : undefined) ?? session.reviewId;
  const branch = session.claim?.branch;
  const files = review?.patchsets.find((set) => set.id === review.activePatchsetId)?.files.length;
  const stage =
    preparation.status === "capturing"
      ? preparation.step === "resolving-repository"
        ? "Resolving the repository"
        : "Capturing the change"
      : preparation.status === "drafting"
        ? "Generating the Boards"
        : preparation.stage === "capture"
          ? "Capture"
          : "Board generation";
  const prNumber = session.claim?.prNumber;

  return (
    <section
      data-screen="session-preparation"
      data-status={preparation.status}
      role={failed ? "alert" : "status"}
      // THE BENCH IS ITS OWN PRIMARY SCROLLER (#819). The outlet is a flex column and the
      // shell root is `fixed inset-0 overflow-hidden`, so a surface that does not declare
      // `min-h-0 flex-1 overflow-y-auto` is simply CLIPPED at the fold — which is what put
      // every landed board out of reach on the 0.7.0 drive. Same three classes the review
      // workspace's scroller carries; `chrome-scroll-clearance` is how a session surface
      // passes under the floating chip layer instead of starting beneath it.
      className="chrome-scroll-clearance min-h-0 flex-1 overflow-y-auto"
    >
      {/* `min-h-full` with SAFE centring, not `h-full` + `justify-center`: once the revealed
          boards make the bench taller than its pane, plain centring pushes the overflow out
          of BOTH ends and the top half (the slab and the first readers) is clipped where no
          scroll can reach it (drive 1.6, third run: four of five readers off-screen). It is
          INSIDE the scroller, so the short bench still centres and the tall one scrolls. */}
      <div className="mx-auto flex min-h-full w-full max-w-4xl flex-col justify-center-safe gap-8 p-8">
        {/* THE SLAB — the change under review, the centrepiece the readers look at. */}
        <div className="flex flex-col gap-3 rounded-window border border-line bg-surface p-6">
          <span className="flex flex-wrap items-center gap-2 text-2xs font-medium uppercase tracking-wide text-ink-faint">
            <span>{prNumber === undefined ? "Your branch" : `Pull request #${prNumber}`}</span>
            <span aria-hidden="true">·</span>
            {/* The stage keeps its OWN element so it is one findable string. Folded into the
              eyebrow's prose it became a fragment of a longer node, which is exactly the
              shape a text query cannot see. */}
            <span data-testid="preparation-stage" className={failed ? "text-danger" : undefined}>
              {failed ? `${stage} failed` : cancelled ? `${stage} cancelled` : stage}
            </span>
          </span>
          <h1 className="font-display text-2xl font-medium leading-tight text-ink">
            {session.title}
          </h1>
          <p className={cn("font-serif text-15", failed ? "text-danger" : "text-ink-soft")}>
            {failed
              ? preparation.reason
              : cancelled
                ? "The review is still here. Retry when you’re ready."
                : slabLine(preparation, branch, files)}
          </p>
          {preparation.status === "capturing" && <CaptureRail step={preparation.step} />}
        </div>

        {/* THE READERS — five presences at work on the slab above. While capture runs the
          daemon has not opened a lane yet, so they are not drawn: an empty bench is
          honest, five invented "queued" readers would not be. */}
        {lanes !== undefined && lanes.length > 0 && (
          // ONE ROW, always. The old `flex-wrap basis-36` orphaned the fifth reader onto
          // a line of its own below ~750px — visible in the app, and it broke the scene:
          // five readers under one slab became four under the slab and one adrift. An
          // explicit template of exactly as many equal columns as the daemon opened
          // lanes cannot wrap, and it stays honest when there are fewer than five.
          <div
            data-testid="bench-readers"
            className="grid items-start gap-x-2 gap-y-6"
            style={{ gridTemplateColumns: `repeat(${lanes.length}, minmax(0, 1fr))` }}
          >
            {lanes.map((lane) => (
              <Reader
                key={lane.id}
                lane={lane}
                {...(preparationReviewId === undefined ? {} : { reviewId: preparationReviewId })}
              />
            ))}
          </div>
        )}

        {/* THE BOARDS THAT HAVE LANDED — each settled lens's board, readable now, in lane
          order. The reader above stays as the way back to that lens's transcript.
          A read that answered with something OTHER than a board — malformed, wrong
          generation, unreadable, failed — shows its account in the board's place, in the
          workspace's own words (`BoardAccount`). Rendering null there left the reader
          saying "drafted" over an empty bench with no reason (Codex review, 2026-09-03).
          `missing` and `pending` are the only silent ones: the draft is on disk a beat
          before `board.read` is re-asked, and the poll above is already chasing them.

          The line above the stack says the stack is still being built — once, and only while
          lenses are still working, because after they stop it would be a promise nothing is
          keeping. A board here is a board that landed early, not the finished review, and a
          reviewer who is not told that reads a half-built stack as the whole of it (#819). */}
        {landed.length > 0 && active && (
          <p
            data-testid="bench-boards-landing"
            className="text-center font-serif text-13 text-ink-faint"
          >
            Boards land here as each lens finishes. The review opens in full once every lens has
            settled.
          </p>
        )}
        {landed.map(({ lane, read }) => (
          <section
            key={lane.id}
            data-bench-board={lane.id}
            className="rounded-window border border-line bg-surface px-8 py-6"
          >
            {read.status === "valid" ? (
              <LensBoardDocument
                reviewId={reviewId}
                board={read.board}
                forceOpen={lane.id === "flagged" ? true : undefined}
              />
            ) : (
              <BoardAccount resolution={read} />
            )}
          </section>
        ))}

        <div className="flex justify-center gap-2">
          {active ? (
            <Button
              variant="outline"
              disabled={cancel.pending}
              onClick={() => void cancel.mutate({ sessionId: session.id })}
            >
              Cancel
            </Button>
          ) : (
            <Button
              variant="accent"
              disabled={retry.pending}
              onClick={() =>
                void retry.mutate({ sessionId: session.id, commandId: newCommandId() })
              }
            >
              Retry
            </Button>
          )}
        </div>
      </div>
    </section>
  );
}
