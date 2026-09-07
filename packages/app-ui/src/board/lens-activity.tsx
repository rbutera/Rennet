import { cn, Popover, PopoverContent, PopoverTrigger } from "@rennet/ui";
import { Activity, Pin, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Icon } from "../components/icon";
import { ReviewActivity } from "../components/review-activity";
import { useRennetStore } from "../store";
import type { LensBoardEntry } from "./board-data";
import { lensTint } from "./lens-colour";

export function LensActivity({
  reviewId,
  entry,
}: {
  readonly reviewId: string;
  readonly entry: Pick<LensBoardEntry, "lens" | "seat">;
}) {
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [history, setHistory] = useState<readonly string[]>([]);
  const [observedAt] = useState(Date.now);
  const [now, setNow] = useState(Date.now);
  const openTranscript = useRennetStore((s) => s.uiActions.openSeatTranscript);
  const { seat, lens } = entry;
  const running = seat.register === "working";
  const action = seat.voices
    .map((voice) => (voice.latest?.kind === "tool" ? "Inspecting the change" : voice.speech.text))
    .join(" · ");
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  useEffect(() => {
    setHistory((previous) =>
      previous[0] === action
        ? previous
        : [action, ...previous.filter((text) => text !== action)].slice(0, 4),
    );
  }, [action]);
  const seconds = Math.floor((now - observedAt) / 1000);
  return (
    <Popover
      open={open}
      onOpenChange={(next, event) => {
        if (!next && pinned && event.reason !== "escape-key") return;
        setOpen(next);
        if (!next) setPinned(false);
      }}
    >
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label={`${seat.label} activity`}
            className={cn(
              "flex size-6 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-secondary",
              lensTint(lens),
            )}
          />
        }
      >
        {running ? (
          <ReviewActivity label={`${seat.label} is reviewing`} className="size-3.5 text-lens" />
        ) : (
          <Icon icon={Activity} className="size-3.5" />
        )}
      </PopoverTrigger>
      <PopoverContent
        aria-label={`${seat.label} activity details`}
        side="bottom"
        align="end"
        sideOffset={12}
        className={cn("w-80 max-w-[calc(100vw-2rem)] p-4", lensTint(lens))}
      >
        <div className="flex items-center gap-2">
          {running ? <ReviewActivity className="text-lens" /> : null}
          <strong className="flex-1">{seat.label}</strong>
          <button
            type="button"
            aria-label={pinned ? "Unpin activity" : "Pin activity"}
            onClick={() => setPinned(!pinned)}
            className={cn("rounded p-1", pinned && "bg-secondary text-lens")}
          >
            <Icon icon={Pin} className="size-4" />
          </button>
          <button
            type="button"
            aria-label="Close activity"
            onClick={() => {
              setPinned(false);
              setOpen(false);
            }}
          >
            <Icon icon={X} className="size-4" />
          </button>
        </div>
        {running ? (
          <p className="text-xs text-muted-foreground">
            Following for {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}
          </p>
        ) : null}
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
        {seat.voices.map((voice) =>
          voice.thread === undefined ? null : (
            <button
              key={voice.seat}
              data-seat-transcript={voice.seat}
              type="button"
              className="self-start rounded px-2 py-1 text-sm text-lens hover:bg-secondary"
              onClick={() => {
                if (!pinned) setOpen(false);
                if (voice.thread)
                  openTranscript({ reviewId, lens, seat: voice.seat, thread: voice.thread });
              }}
            >
              {voice.name ? `Open ${voice.name} transcript` : "Open transcript"}
            </button>
          ),
        )}
      </PopoverContent>
    </Popover>
  );
}
