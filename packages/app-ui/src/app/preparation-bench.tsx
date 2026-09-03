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
import { Check, Minus, X } from "lucide-react";
import type { SVGProps } from "react";
import { useEffect } from "react";
import { BoardAccount, LensBoardDocument } from "../board";
import { useLensBoardResolutions } from "../board/board-data";
import { Icon } from "../components/icon";
import { useMutation, useRefreshCommand } from "../data";
import { coverageNote, coverageStatus } from "../rounds/round-machine";
import { StatusIcon } from "../rounds/run-route";
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
//   • FIVE READERS stand under the slab, each with an illustrated mark, a lantern that
//     is lit only while that seat is actually working, a gaze line rising to the slab
//     that carries a travelling glance while a tool call is in flight, and a live line
//     of speech in the review serif: what the seat is doing right now.
//   • EVERY READER IS A CONTROL. Activating one points the chat slot at that seat's T3
//     thread (`uiActions.openLensThread`) and opens the dock. A lane with no thread yet
//     is disabled rather than pretending it has a transcript.
//
// The three registers a reviewer must tell apart at a glance — working, settled, failed
// — are carried by colour AND by mark AND by motion, never by colour alone (root
// DESIGN.md): gold + a moving glance for working, green + a check for settled, danger +
// a cross for failed. Waiting and absent are quiet, and they are quiet in different
// words: "queued" is a promise, an absent lens's `reason` is a result.
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

// ── The marks ────────────────────────────────────────────────────────────────
// Five hand-drawn marks at the product's 1.6px currentColor stroke, one per lens, so
// the readers are told apart by SHAPE before colour. They are not lucide glyphs on
// purpose: a lens is a character on this bench, not a toolbar action.

type MarkProps = SVGProps<SVGSVGElement>;

function mark(paths: React.ReactNode) {
  return function Mark(props: MarkProps) {
    return (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.6}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        {...props}
      >
        {paths}
      </svg>
    );
  };
}

/** Design — an arch on its footings with a plumb line down the middle: structure, held. */
const DesignMark = mark(
  <>
    <path d="M5 19V12a7 7 0 0 1 14 0v7" />
    <path d="M12 5v14" />
    <path d="M3 19h18" />
  </>,
);

/** Sequence — three beats stepping down a path, in order, connected. */
const SequenceMark = mark(
  <>
    <path d="M4 7h4l4 5 4 5h4" />
    <circle cx="4" cy="7" r="1.6" />
    <circle cx="12" cy="12" r="1.6" />
    <circle cx="20" cy="17" r="1.6" />
  </>,
);

/** Decisions — a balance beam with two pans: two ways it could have gone. */
const DecisionsMark = mark(
  <>
    <path d="M12 4v16" />
    <path d="M5 8h14" />
    <path d="M2.5 14a2.5 2.5 0 0 0 5 0L5 8Z" />
    <path d="M16.5 14a2.5 2.5 0 0 0 5 0L19 8Z" />
  </>,
);

/** Flagged — a pennant with a spark off its point: something to stop and look at. */
const FlaggedMark = mark(
  <>
    <path d="M6 21V4" />
    <path d="M6 5h9l-2.5 4L15 13H6" />
    <path d="M18.5 17.5v3M17 19h3" />
  </>,
);

/** Noise — three waves flattening away, with the strike that quiets them. */
const NoiseMark = mark(
  <>
    <path d="M3 12c2-5 4-5 6 0s4 5 6 0" />
    <path d="M18 12h3" />
    <path d="M17 7l4 10" />
  </>,
);

/** A lens the client has never heard of still gets a presence, not a blank. */
const UnknownMark = mark(<circle cx="12" cy="12" r="7" />);

const MARKS: Readonly<Record<string, (props: MarkProps) => React.ReactElement>> = {
  design: DesignMark,
  sequence: SequenceMark,
  decisions: DecisionsMark,
  flagged: FlaggedMark,
  noise: NoiseMark,
};

// ── The reader ───────────────────────────────────────────────────────────────

const LANTERN_BY_REGISTER: Readonly<Record<Register, string>> = {
  waiting: "border-line bg-canvas text-ink-faint",
  working: "border-accent-line bg-accent-soft text-accent",
  settled: "border-green-line bg-green-soft text-green",
  absent: "border-line bg-raised text-ink-faint",
  failed: "border-danger bg-danger-soft text-danger",
};

const GAZE_BY_REGISTER: Readonly<Record<Register, string>> = {
  waiting: "bg-line",
  working: "bg-accent-line",
  settled: "bg-green-line",
  absent: "bg-line",
  failed: "bg-danger",
};

/**
 * One reader: the lane's lantern and mark once, then one line of speech PER SEAT, each
 * its own control. A lane with one seat (every lens but Flagged) reads exactly as before;
 * Flagged shows two lines, each naming its speaker, because a Claude seat and a Codex
 * seat are two voices with two transcripts, not one voice that keeps changing its mind.
 */
function Reader({ lane, reviewId }: { readonly lane: LensLane; readonly reviewId?: string }) {
  const register = registerOf(lane);
  const Mark = MARKS[lane.id] ?? UnknownMark;
  const voices = voicesOf(lane);
  const reading = lane.status === "running" && voices.some((v) => v.latest?.kind === "tool");

  return (
    <div
      data-row={lane.id}
      data-status={lane.status}
      data-register={register}
      className="flex min-w-36 flex-1 basis-36 flex-col items-center gap-2 px-2 pb-3 pt-0 text-center"
    >
      {/* The gaze line: this reader's attention, rising to the slab above. It carries a
          travelling glance ONLY while a tool call is actually in flight — motion that
          means "this seat is reading the change right now" and nothing else. */}
      <span className="relative flex h-8 w-1 justify-center" aria-hidden="true">
        <span className={cn("h-full w-px", GAZE_BY_REGISTER[register])} />
        {reading && (
          <span className="absolute bottom-0 size-1 rounded-full bg-accent animate-bench-glance motion-reduce:animate-none" />
        )}
      </span>

      <span
        className={cn(
          "relative grid size-11 place-items-center rounded-full border transition-colors",
          LANTERN_BY_REGISTER[register],
        )}
      >
        <Mark
          className={cn(
            "size-6",
            register === "working" && "animate-processing-pulse motion-reduce:animate-none",
          )}
        />
        {register === "settled" && <ReaderBadge tone="settled" glyph={Check} />}
        {register === "failed" && <ReaderBadge tone="failed" glyph={X} />}
        {register === "absent" && <ReaderBadge tone="absent" glyph={Minus} />}
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

/** The settled/absent/failed badge on a lantern's rim — the second, non-colour statement
 *  of the register (root DESIGN.md: never colour alone). */
function ReaderBadge({
  tone,
  glyph,
}: {
  readonly tone: "settled" | "absent" | "failed";
  readonly glyph: typeof Check;
}) {
  return (
    <span
      className={cn(
        "absolute -bottom-0.5 -right-0.5 grid size-4 place-items-center rounded-full border border-canvas",
        tone === "settled" && "bg-green text-canvas",
        tone === "failed" && "bg-danger text-canvas",
        tone === "absent" && "bg-line text-ink-soft",
      )}
    >
      <Icon icon={glyph} className="size-2.5" />
    </span>
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
  const preparationReviewId = "reviewId" in preparation ? preparation.reviewId : undefined;
  const coverage = "coverage" in preparation ? preparation.coverage : undefined;
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
      className="mx-auto flex h-full w-full max-w-4xl flex-col justify-center gap-8 p-8"
    >
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
        <div className="flex flex-wrap items-start justify-center gap-x-2 gap-y-6">
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
          before `board.read` is re-asked, and the poll above is already chasing them. */}
      {settled.map((lane) => {
        const read = boards[lane.id as LensKind];
        if (read === undefined || read.status === "missing" || read.status === "pending")
          return null;
        return (
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
        );
      })}

      {coverage !== undefined && (
        <p
          data-row="coverage"
          data-testid="cross-lens-coverage"
          data-coverage={coverage.state}
          data-status={coverageStatus(coverage)}
          className="flex items-center justify-center gap-2 font-serif text-13 text-ink-soft"
        >
          <StatusIcon status={coverageStatus(coverage)} compact />
          {coverageNote(coverage)}
        </p>
      )}

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
            onClick={() => void retry.mutate({ sessionId: session.id, commandId: newCommandId() })}
          >
            Retry
          </Button>
        )}
      </div>
    </section>
  );
}
