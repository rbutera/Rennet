import type { LensBoard } from "@rennet/protocol";
import { cn } from "@rennet/ui";
import { useEffect, useRef, useState } from "react";
import { useRennetStore } from "../store";
import type { LensBoardEntry } from "./board-data";
import { lensTint } from "./lens-colour";
import { type SeatVoice, waitingOnLine } from "./lens-seats";

// ─────────────────────────────────────────────────────────────────────────────
// THE SEAT WIDGET (lens-board-tools 6.1, D12/D13/D14) — who is writing the board
// you are reading, directly above it.
//
// This is one of the three homes the bench's five readers were decomposed into: the
// rail took the per-lens indicator, this took the live line and the controls, and the
// boards became the workspace itself. It shows ONE lens — the selected one — because
// it sits above that lens's board and the rail already answers for the other four.
//
// A lane with two voices shows both side by side, each with its own state and its own
// way into its own transcript (`voice.seat` is the key: a Claude seat and a Codex seat
// are two transcripts, not one voice changing its mind).
//
// When the lane settles the widget COLLAPSES to a one-line receipt and stays — it is
// still the way back into the seat's thread, which is the whole reason a settled lane
// keeps its widget rather than dropping it.
//
// WHAT THE WIRE CANNOT ANSWER YET, said here rather than invented:
//
//   • THE MODEL. `LaneSeat` carries `provider` and no model, so the widget names the
//     provider ("Claude", "Codex") and stops. The per-lane `model` exists only on the
//     durable `GenerationPhaseTiming` record, which no command publishes.
//   • THE LANE'S DURATION. Nothing on the wire says when a seat started or how long it
//     took, so the receipt states what the board HOLDS and no duration, and the working
//     line says "watching 0:41" — which is a true statement about this window, not a
//     claim about the seat. When the seat's own span reaches the client, both become
//     the seat's numbers and this note goes.
// ─────────────────────────────────────────────────────────────────────────────

/** Elapsed since this window first saw this seat working, as `m:ss`. */
function useWatchedFor(key: string, running: boolean): string | undefined {
  const since = useRef<{ key: string; at: number } | undefined>(undefined);
  const [, tick] = useState(0);
  if (!running) {
    since.current = undefined;
  } else if (since.current?.key !== key) {
    since.current = { key, at: Date.now() };
  }
  const startedAt = since.current?.at;
  useEffect(() => {
    if (startedAt === undefined) return;
    const timer = setInterval(() => tick((n) => n + 1), 1_000);
    return () => clearInterval(timer);
  }, [startedAt]);
  if (startedAt === undefined) return undefined;
  const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1_000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** What the board holds so far, in the board's own units. Counted off the resolved
 *  board, so a partial board says how far it has got and a settled one says what it is. */
function writtenSoFar(board: LensBoard | undefined): string {
  if (board === undefined) return "nothing written yet";
  const elements = board.elements.length;
  const cited = board.elements.filter((element) => element.kind === "code_ref").length;
  const written = `${elements} ${elements === 1 ? "element" : "elements"} written`;
  return cited === 0 ? written : `${written} · ${cited} cited`;
}

function ProviderName({ voice }: { readonly voice: SeatVoice }) {
  if (voice.name === undefined) return null;
  return <span className="text-ink-faint text-xs">{voice.name}</span>;
}

/** One voice's live line and its transcript control. */
function Voice({
  voice,
  working,
  failed,
  open,
  openable: openableVoice,
  onOpen,
}: {
  readonly voice: SeatVoice;
  readonly working: boolean;
  readonly failed: boolean;
  readonly open: boolean;
  /** This voice's transcript can actually be opened — a thread, and a review to open it
   *  under. False renders no control at all rather than a dead one. */
  readonly openable: boolean;
  readonly onOpen: (voice: SeatVoice) => void;
}) {
  return (
    <div data-seat={voice.seat} className="flex min-w-0 flex-1 flex-col gap-1">
      <div className="flex min-w-0 items-baseline gap-2">
        <ProviderName voice={voice} />
        <span
          data-speech={voice.speech.quiet ? "quiet" : "live"}
          className={cn(
            // Wrap ANYWHERE: a live line is often a git command carrying a full sha or a
            // path with no break opportunity.
            "min-w-0 flex-1 font-serif text-13 leading-snug [overflow-wrap:anywhere]",
            failed ? "text-danger" : voice.speech.quiet ? "text-ink-faint italic" : "text-ink-soft",
          )}
        >
          {working && !voice.speech.quiet ? "now: " : ""}
          {voice.speech.text}
        </span>
      </div>
      {/* ABSENT, not disabled (the house convention). A seat whose thread does not exist
          yet — or a frame with no review to address it under — has no transcript to open,
          and a greyed control is a door onto an excuse. */}
      {!openableVoice ? null : (
        <button
          type="button"
          data-seat-transcript={voice.seat}
          aria-pressed={open}
          onClick={() => onOpen(voice)}
          className={cn(
            "self-start rounded-control px-2 py-0.5 text-ink-soft text-xs transition-colors",
            "hover:bg-raised hover:text-ink focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-accent-line",
            open && "bg-raised text-ink",
          )}
        >
          {open ? "Close transcript" : "Open transcript"}
        </button>
      )}
    </div>
  );
}

export interface SeatWidgetProps {
  readonly reviewId: string;
  readonly entry: LensBoardEntry;
  /** The board actually on screen. While the lane is open that is the LIVE one folded from
   *  the element stream, not the durable read on `entry` — "4 elements written" has to
   *  count what the reviewer can see, or the widget and the board disagree. */
  readonly board?: LensBoard;
  /** The generation-wide retry, offered against a failed lane. Absent ⇒ nothing to offer,
   *  and the widget says the failure without a dead button under it. */
  readonly onRetry?: () => void;
  readonly retrying?: boolean;
}

export function SeatWidget({
  reviewId,
  entry,
  board: shownBoard,
  onRetry,
  retrying = false,
}: SeatWidgetProps) {
  const { lens, seat } = entry;
  const board = shownBoard ?? entry.board;
  const openSeatTranscript = useRennetStore((s) => s.uiActions.openSeatTranscript);
  const openRef = useRennetStore((s) => s.ui.seatTranscript);
  const working = seat.register === "working";
  const failed = seat.register === "failed";
  const settled = !seat.drafting && !failed;
  const primary = seat.voices[0];
  const watched = useWatchedFor(`${lens}:${primary?.seat ?? ""}`, working);

  const onOpen = (voice: SeatVoice) => {
    // Unreachable: every control that calls this is gated on `openable` below. Kept as
    // the type narrowing for `voice.thread`, not as a runtime guard standing in for one.
    if (voice.thread === undefined || reviewId.length === 0) return;
    const already =
      openRef !== null && openRef.seat === voice.seat && openRef.reviewId === reviewId;
    openSeatTranscript(already ? null : { reviewId, lens, seat: voice.seat, thread: voice.thread });
  };
  const isOpen = (voice: SeatVoice) =>
    openRef !== null && openRef.reviewId === reviewId && openRef.seat === voice.seat;
  /** A transcript this widget can actually open: a thread to address, and a review to
   *  address it under. Absent, the control is not rendered — never rendered dead. */
  const openable = (voice: SeatVoice) => voice.thread !== undefined && reviewId.length > 0;

  // The settled receipt (D13): one line, and it still opens the transcript.
  if (settled) {
    return (
      <div
        data-kind="seat-widget"
        data-lens={lens}
        data-register={seat.register}
        data-shape="receipt"
        className={cn(
          "flex flex-wrap items-center gap-x-3 gap-y-1 rounded-window border border-line bg-raised px-3 py-2",
          lensTint(lens),
        )}
      >
        <span aria-hidden="true" className="size-1.5 rounded-full bg-lens" />
        <span className="font-medium text-ink text-sm">{seat.label}</span>
        <span className="text-ink-faint text-xs">
          {seat.voices
            .map((voice) => voice.name ?? "seat")
            .filter((name, index, all) => all.indexOf(name) === index)
            .join(" · ")}
          {seat.reworked ? " · reworked" : ""}
        </span>
        <span data-testid="seat-written" className="text-ink-soft text-xs">
          {board === undefined ? seat.voices[0]?.speech.text : writtenSoFar(board)}
        </span>
        <span className="flex-1" />
        {seat.voices.map((voice) =>
          !openable(voice) ? null : (
            <button
              key={voice.seat}
              type="button"
              data-seat-transcript={voice.seat}
              // NOT `aria-pressed`, and not a toggle group: these are per-voice controls
              // that open one surface, and the visible label already carries the state
              // ("Close transcript" when this voice's transcript is the one showing).
              // Marking them pressed would announce a settled receipt as a segmented
              // control the reviewer is choosing between (`rennet/no-handrolled-toggle`).
              data-open={isOpen(voice) ? "true" : undefined}
              onClick={() => onOpen(voice)}
              className={cn(
                "rounded-control px-2 py-0.5 text-ink-soft text-xs transition-colors",
                "hover:bg-surface hover:text-ink focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-accent-line",
                isOpen(voice) && "bg-surface text-ink",
              )}
            >
              {voice.name === undefined
                ? isOpen(voice)
                  ? "Close transcript"
                  : "Transcript"
                : isOpen(voice)
                  ? `Close ${voice.name} transcript`
                  : `${voice.name} transcript`}
            </button>
          ),
        )}
      </div>
    );
  }

  return (
    <div
      data-kind="seat-widget"
      data-lens={lens}
      data-register={seat.register}
      data-shape="working"
      className={cn(
        "flex flex-col gap-2 rounded-window border border-line bg-raised px-4 py-3",
        lensTint(lens),
      )}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span
          data-testid="seat-chip"
          className={cn(
            "rounded-chip border px-2 py-0.5 font-medium text-2xs uppercase tracking-wide",
            failed
              ? "border-danger/40 text-danger"
              : working
                ? "border-lens text-ink-soft"
                : "border-line text-ink-faint",
          )}
        >
          {failed ? "failed" : working ? "drafting" : "waiting"}
        </span>
        <span className="font-medium text-ink text-sm">{seat.label} seat</span>
        {watched === undefined ? null : (
          <span data-testid="seat-watched" className="text-ink-faint text-xs">
            watching {watched}
          </span>
        )}
        {seat.register === "waiting" && seat.waitingOn.length > 0 ? (
          <span data-testid="seat-waiting-on" className="text-ink-faint text-xs">
            {waitingOnLine(seat.waitingOn)}
          </span>
        ) : null}
        <span className="flex-1" />
        {failed && onRetry !== undefined ? (
          <button
            type="button"
            data-testid="seat-retry"
            disabled={retrying}
            onClick={onRetry}
            className="rounded-control border border-line px-2 py-0.5 text-ink-soft text-xs transition-colors hover:bg-surface hover:text-ink disabled:opacity-60"
          >
            {retrying ? "Retrying…" : "Draft the boards again"}
          </button>
        ) : null}
      </div>
      <div className={cn("flex gap-4", seat.voices.length > 1 && "flex-wrap")}>
        {seat.voices.map((voice) => (
          <Voice
            key={voice.seat}
            voice={voice}
            working={working}
            failed={failed}
            open={isOpen(voice)}
            openable={openable(voice)}
            onOpen={onOpen}
          />
        ))}
      </div>
      <p data-testid="seat-written" className="text-ink-faint text-xs">
        {writtenSoFar(board)}
      </p>
    </div>
  );
}
