import type { LensKind } from "@rennet/protocol";
import { cn, Popover, PopoverContent, PopoverTrigger } from "@rennet/ui";
import { CircleCheck, CircleX, GitMerge, type LucideIcon, X } from "lucide-react";
import {
  type Dispatch,
  type ReactElement,
  type SetStateAction,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { Icon } from "../components/icon";
import { ReviewActivity } from "../components/review-activity";
import { AgentMark, type AgentToolId } from "../settings/assets/agent-marks";
import { useRennetStore } from "../store";
import type { LensBoardEntry } from "./board-data";
import { lensActivityKey, useLensActivityHistory } from "./lens-activity-state";
import { lensTint } from "./lens-colour";
import type { SeatVoice } from "./lens-seats";

/** A review leg's provider maps to its owner's mark (`agent-marks.tsx`). The Flagged legs are
 *  a Claude seat and a Codex seat; the mark carries the identity so the link reads "◆ transcript". */
const PROVIDER_MARK = { claudeAgent: "claude", codex: "codex" } as const satisfies Record<
  NonNullable<SeatVoice["provider"]>,
  AgentToolId
>;

/** The merge seat that collates the two Flagged review legs into one board. Its transcript is
 *  set apart from the legs (it is not a third reviewer), and labelled "Merged", never "collator". */
function isMergeVoice(voice: SeatVoice): boolean {
  return voice.seat.endsWith("-compile");
}

export function LensActivity({
  reviewId,
  generation = "",
  entry,
  active,
  inspected,
  setInspected,
  tab,
  onSelect,
}: {
  /** Select this lens's board. Opening a seat's transcript calls it first: the drawer
   *  lives inside the board region and the board follows the transcript's lens, so a
   *  transcript opened from another lens's tab lands beside its own board, not over the
   *  one the reviewer happened to be reading. */
  readonly onSelect?: (lens: LensKind) => void;
  readonly active: boolean;
  readonly inspected: LensKind | null;
  readonly setInspected: Dispatch<SetStateAction<LensKind | null>>;
  readonly tab: ReactElement;
  readonly reviewId: string;
  readonly generation?: string;
  readonly entry: Pick<LensBoardEntry, "lens" | "seat">;
}) {
  const triggerId = useId();
  const restoringFocus = useRef(false);
  const [dismissed, setDismissed] = useState(false);
  const [completing, setCompleting] = useState(false);

  const [now, setNow] = useState(Date.now);
  const openTranscript = useRennetStore((s) => s.uiActions.openSeatTranscript);
  const { seat, lens } = entry;
  const running = seat.register === "working";
  const wasRunning = useRef(running);
  useEffect(() => {
    const finished = wasRunning.current && !running;
    wasRunning.current = running;
    if (running) {
      setDismissed(false);
      setCompleting(false);
    }
    if (!finished) return;
    setCompleting(true);
    const timer = setTimeout(() => {
      setCompleting(false);
    }, 900);
    return () => clearTimeout(timer);
  }, [running]);
  useEffect(() => {
    if (active) setDismissed(false);
  }, [active]);
  const open =
    inspected !== null ? inspected === lens : active && !dismissed && (running || completing);
  const close = (restoreFocus = false) => {
    setDismissed(true);
    setInspected((current) => (current === lens ? null : current));
    if (restoreFocus) {
      restoringFocus.current = true;
      document.getElementById(triggerId)?.focus();
      restoringFocus.current = false;
    }
  };
  const key = lensActivityKey(reviewId, generation, seat);
  const record = useLensActivityHistory((state) => state.byRun[key]);
  const observe = useLensActivityHistory((state) => state.observe);
  useEffect(() => observe(reviewId, generation, [entry]), [observe, reviewId, generation, entry]);
  const history = record?.history ?? [];
  const observedAt = record?.observedAt ?? now;
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  const seconds = Math.max(0, Math.floor((now - observedAt) / 1000));

  // The two parallel review legs, and the merge that folds them into one board — set apart
  // below, because it is not a third reviewer. Non-Flagged lenses have neither: one plain voice.
  const mergeVoice = seat.voices.find(isMergeVoice);
  const legVoices = seat.voices.filter((voice) => !isMergeVoice(voice));

  const renderTranscript = (voice: SeatVoice, label: string, mark?: LucideIcon) => (
    <button
      key={voice.seat}
      data-seat-transcript={voice.seat}
      disabled={voice.thread === undefined}
      title={
        voice.thread === undefined ? "Transcript available when the agent thread starts" : undefined
      }
      type="button"
      className="flex items-center gap-1.5 self-start rounded px-2 py-1 text-sm text-primary hover:bg-secondary disabled:cursor-default disabled:opacity-50"
      onClick={() => {
        close();
        if (!voice.thread) return;
        onSelect?.(lens);
        openTranscript({ reviewId, lens, seat: voice.seat, thread: voice.thread });
      }}
    >
      {mark ? (
        <Icon icon={mark} className="size-3.5" />
      ) : voice.provider ? (
        <AgentMark id={PROVIDER_MARK[voice.provider]} className="size-3.5" />
      ) : null}
      <span>{label}</span>
    </button>
  );

  return (
    <Popover
      open={open}
      triggerId={triggerId}
      onOpenChange={(next, event) => {
        if (event.reason === "trigger-hover" || event.reason === "trigger-focus") {
          setInspected((current) => (next ? lens : current === lens ? null : current));
        } else if (event.reason === "trigger-press") {
          setInspected(lens);
        } else if (!next) {
          if (event.reason === "escape-key" || event.reason === "close-press") close(true);
          else setInspected((current) => (current === lens ? null : current));
        }
      }}
    >
      <PopoverTrigger
        id={triggerId}
        render={tab}
        openOnHover
        delay={0}
        closeDelay={120}
        onMouseEnter={() => setInspected(lens)}
        onFocus={() => {
          if (!restoringFocus.current) setInspected(lens);
        }}
      />
      <PopoverContent
        aria-label={`${seat.label} activity details`}
        initialFocus={false}
        finalFocus={false}
        data-completing={completing || undefined}
        side="bottom"
        align="start"
        sideOffset={8}
        className={cn(
          "max-h-[var(--available-height)] w-80 max-w-[calc(100vw-2rem)] overflow-y-auto p-4 motion-reduce:animate-none",
          lensTint(lens),
        )}
      >
        <div className="flex items-center gap-2">
          {completing ? (
            <Icon
              icon={
                seat.register === "settled" || seat.register === "absent" ? CircleCheck : CircleX
              }
              className="size-5 text-lens motion-safe:animate-in motion-safe:zoom-in-50"
            />
          ) : running ? (
            <ReviewActivity className="text-lens" />
          ) : null}
          <strong>{seat.label}</strong>
          {running ? (
            // Bare elapsed, next to the title. "Following for M:SS" read as a claim about the
            // reviewer ("you have been following"); this is just how long the seat has run.
            <span className="text-xs text-muted-foreground tabular-nums">
              {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}
            </span>
          ) : null}
          <span className="flex-1" />
          <button type="button" aria-label="Close activity" onClick={() => close(true)}>
            <Icon icon={X} className="size-4" />
          </button>
        </div>
        {completing ? (
          <p role="status" className="text-sm text-lens">
            {seat.register === "settled" || seat.register === "absent"
              ? "Review complete"
              : "Review stopped"}
          </p>
        ) : null}
        {seat.waitingOn.length > 0 ? (
          <p role="tooltip" className="text-sm">
            Noise reviews what remains once the other lenses have finished.
          </p>
        ) : null}
        {mergeVoice !== undefined ? (
          // The Flagged shape in one plain line — no "collator", no "compile". The reviewer
          // sees two reviews happen at once, then one merged list; this says exactly that.
          <p className="text-xs text-muted-foreground">
            Two reviewers, in parallel, then merged into one list.
          </p>
        ) : null}
        {history.length > 0 ? (
          <ol className="flex flex-col gap-3 border-l border-lens-line pl-3">
            {history.map((text, index) => (
              <li
                key={text}
                className={cn(
                  "motion-safe:animate-in motion-safe:slide-in-from-top-2 motion-safe:fade-in duration-300 text-sm [overflow-wrap:anywhere]",
                  index > 0 && "text-muted-foreground text-xs",
                )}
              >
                {text}
              </li>
            ))}
          </ol>
        ) : null}
        <div className="flex flex-col items-start gap-0.5">
          {legVoices.map((voice) =>
            renderTranscript(
              voice,
              voice.provider !== undefined ? "transcript" : "Open transcript",
            ),
          )}
        </div>
        {mergeVoice !== undefined ? (
          // Set apart from the two legs: the merged result is a different kind of thing to read,
          // so it sits under its own rule with its own glyph and the plain word "Merged".
          <div className="mt-1 flex flex-col items-start gap-0.5 border-t border-lens-line pt-2">
            {renderTranscript(mergeVoice, "Merged", GitMerge)}
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
