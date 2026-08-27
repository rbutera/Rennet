import type { LensBoard } from "@rennet/protocol";
import { Button } from "@rennet/ui";
import { Check, Loader2 } from "lucide-react";
import { canRevealNewBoards, type LaneRow, type RoundState } from "./round-machine";
import { RoundReportBoard } from "./round-report";

// ─────────────────────────────────────────────────────────────────────────────
// The round report as the greeting (C09 §5, Objective "round report as the greeting" +
// "progressive reveal"). On return from a round the report board (cluster 2's
// `RoundReportBoard`) fills the surface, READABLE IMMEDIATELY; beneath it the five lens
// drafters rework — rows from the machine's `composing` state, folded `onProgress`, NO
// `setTimeout`. **View the New Boards** is rendered IFF `canRevealNewBoards(state)` (i.e.
// at `composed`): it APPEARS at composition and is NEVER a disabled button waiting to
// enable (packet + INVENTORY §7.2). Its click is the single consume — `onReveal` disarms
// the greeting so the board surface returns to the new generation (the workspace derives
// that generation off `composed` state; cluster 5.2 wires it).
//
// The greeting owns NO round data: the report board is resolved + validated by the
// workspace through `useReportBoard` and handed in already-valid, and the regeneration
// rows are read straight off the machine's `composing` state. There is no fresh-object
// selector here (the Zustand trap) — the workspace holds the store reads.
// ─────────────────────────────────────────────────────────────────────────────

/** A stable empty lane list — non-`composing` phases resolve to the same ref. */
const NO_LANES: readonly LaneRow[] = Object.freeze([]);

/** The lens drafters reworking beneath the report — rows from the machine's `composing`
 *  state (folded `onProgress`, never a wall clock). A running lane reads "re-drafting", a
 *  settled one "done". The report stays readable above while these still run. */
function RegenerationProgress({ lanes }: { readonly lanes: readonly LaneRow[] }) {
  return (
    <div data-testid="regeneration-progress" className="flex flex-col gap-1.5">
      <span className="text-2xs font-medium uppercase tracking-wide text-muted-foreground/70">
        Re-drafting the boards
      </span>
      <div className="flex flex-col divide-y divide-border/60 rounded-lg border border-border">
        {lanes.map((lane) => {
          const running = lane.status === "running";
          return (
            <div
              key={lane.id}
              className="flex items-center gap-2.5 px-3.5 py-2 text-sm"
              data-row={lane.id}
            >
              {running ? (
                <Loader2 className="size-3.5 shrink-0 animate-spin text-model" aria-hidden="true" />
              ) : (
                <Check className="size-3.5 shrink-0 text-green-500" aria-hidden="true" />
              )}
              <span className="text-foreground">{lane.label}</span>
              <span className="ml-auto text-2xs text-muted-foreground">
                {running ? "re-drafting" : "done"}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * `RoundGreeting` — the report-as-greeting surface. The report fills the top (readable at
 * once); the regeneration progress streams beneath while `composing`; **View the New
 * Boards** appears only at `composed` (`canRevealNewBoards`) and, when it exists, always
 * works — it is never rendered disabled. Clicking calls `onReveal` (the single consume:
 * the workspace disarms the greeting and lands on the new generation).
 */
export function RoundGreeting({
  board,
  state,
  onReveal,
}: {
  readonly board: LensBoard;
  readonly state: RoundState;
  readonly onReveal: () => void;
}) {
  const lanes = state.phase === "composing" ? state.lanes : NO_LANES;
  return (
    <section
      data-screen="round-greeting"
      className="mx-auto flex w-full max-w-[820px] flex-col gap-6 p-6"
    >
      <RoundReportBoard board={board} />
      {lanes.length > 0 && <RegenerationProgress lanes={lanes} />}
      {canRevealNewBoards(state) && (
        <Button
          data-testid="reveal-new-boards"
          variant="accent"
          onClick={onReveal}
          className="self-start"
        >
          View the New Boards
        </Button>
      )}
    </section>
  );
}
