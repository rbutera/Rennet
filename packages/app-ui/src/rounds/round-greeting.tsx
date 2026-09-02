import type {
  GenerationUsage,
  RoundLedgerRecord,
  RoundReportBoard as RoundReportBoardModel,
  RoundRunReceipt,
} from "@rennet/protocol";
import { Button } from "@rennet/ui";
import { ArrowRight } from "lucide-react";
import { Icon } from "../components/icon";
import {
  canRevealNewBoards,
  coverageNote,
  coverageStatus,
  type GenerationCoverage,
  type LaneRow,
  type LensLane,
  type RoundState,
  type RowStatus,
  roundTargetLabel,
} from "./round-machine";
import { RoundReportBoard } from "./round-report";
import { StatusIcon } from "./run-route";

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
const NO_LANES: readonly LensLane[] = Object.freeze([]);

/** …and the same for the synthetic tail STEPS, which are step rows, not lens lanes. */
const NO_STEPS: readonly LaneRow[] = Object.freeze([]);

function durationLabel(durationMs: number): string {
  if (durationMs < 1_000) return `${durationMs} ms`;
  const seconds = durationMs / 1_000;
  return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)} s`;
}

function gateSummary(gate: RoundRunReceipt["gate"]) {
  switch (gate.outcome) {
    case "passed":
      return (
        <>
          Passed <code>{gate.command}</code> in {durationLabel(gate.durationMs)}
          {gate.projectCount === undefined
            ? "."
            : ` across ${gate.projectCount} ${gate.projectCount === 1 ? "project" : "projects"}.`}
        </>
      );
    case "skipped":
      return <>No project gate was configured.</>;
  }
}

function harnessSummary(harness: RoundRunReceipt["harness"]): string {
  if (harness === undefined) return "";
  const name = harness.id === "claude-code" ? "Claude Code" : "Codex";
  return ` using ${name} ${harness.version}`;
}

function RunReceiptSummary({
  record,
  roundNumber,
}: {
  readonly record: RoundLedgerRecord;
  readonly roundNumber: number;
}) {
  if (record.run === undefined) return null;
  const askCount = record.asksDispatched.length;
  return (
    <div
      data-testid="round-run-receipt"
      className="flex flex-col gap-1 text-muted-foreground text-sm"
    >
      <p>
        Round {roundNumber} ran {askCount} {askCount === 1 ? "ask" : "asks"} on{" "}
        {roundTargetLabel(record.run.sourceTarget)}
        {harnessSummary(record.run.harness)}.
      </p>
      <p>{gateSummary(record.run.gate)}</p>
    </div>
  );
}

/** The greeting's per-lane status label — EXHAUSTIVE over `RowStatus` (finding 5). A
 *  regenerating lane reads "re-drafting"; a queued one "queued"; a drafted-but-unannounced
 *  one "drafted"; a successful no-material lane "not present"; a FAILED one "failed" —
 *  never the old "done" that made a queued or failed drafter lie as a settled success. */
function laneStatusLabel(status: RowStatus): string {
  switch (status) {
    case "queued":
      return "queued";
    case "running":
      return "re-drafting";
    case "drafted":
      return "drafted";
    case "absent":
      return "not present";
    case "failed":
      return "failed";
    case "done":
      return "done";
  }
}

/**
 * What a lens lane says about itself, read off the arm that HAS an account (review
 * finding 8): a settled lane its VERDICT, a failed lane its reason, and the in-flight arms
 * their status — because those genuinely have nothing else to say yet. The verdict comes
 * from the daemon's `stampDeltas` read, so "carrying forward" here can never disagree with
 * the section markers on the board itself.
 */
function laneNote(lane: LensLane): string {
  if (lane.status === "done")
    return lane.verdict === "carrying-forward" ? "carrying forward" : "reworked";
  if (lane.status === "failed") return lane.reason;
  if (lane.status === "absent") return lane.reason;
  return laneStatusLabel(lane.status);
}

/**
 * The synthetic tail steps (C15 4.2) — the two lines the regeneration shows after the
 * drafters settle, DERIVED from the real phase, never pre-rendered:
 *
 *   • "Finalizing generation" is the window between the last lens arrival and the
 *     `composed` event. Cross-lens coverage runs AFTER those arrivals (#725 D4) and is
 *     reported on its own row, so this step covers the rest: any configured review
 *     composition, validating the required boards, persisting the generation and the
 *     ledger record, then emitting `composed`. While any lane is still queued or running
 *     this step is absent.
 *   • "Composed generation <id>" — the `composed` event itself, naming the generation the
 *     reveal opens. The spike numbered it ("Composed generation 2") off a fixture round
 *     counter; the live machine knows the minted generation's IDENTITY and no ordinal, so
 *     the line carries the real id rather than a fabricated number.
 */
function finishSteps(state: RoundState, lanes: readonly LensLane[]): readonly LaneRow[] {
  const settled =
    lanes.length > 0 &&
    lanes.every((l) => l.status === "done" || l.status === "absent" || l.status === "failed");
  if (state.phase === "composed") {
    return [
      { id: "finalizing", label: "Generation finalized", status: "done" },
      { id: "composed", label: `Composed generation ${state.newGeneration}`, status: "done" },
    ];
  }
  if (settled) return [{ id: "finalizing", label: "Finalizing generation", status: "running" }];
  return NO_STEPS;
}

/**
 * The one line that says what the generation cost (#737). Tokens always; a dollar figure
 * only when every seat turn was metered and priced — a subscription session shows tokens
 * and no invented price. Compact notation: "12.3K tokens", never a wall of digits.
 */
export function usageNote(usage: GenerationUsage): string {
  const tokens = new Intl.NumberFormat("en", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(usage.totalTokens);
  const price =
    usage.reportedUsd === null
      ? ""
      : ` \u00b7 $${usage.reportedUsd.toFixed(usage.reportedUsd < 1 ? 3 : 2)}`;
  return `Spent ${tokens} tokens across ${usage.turns} seat turn${usage.turns === 1 ? "" : "s"}${price}`;
}

/** The lens drafters reworking beneath the report — rows from the machine's `composing`
 *  state (folded `onProgress`, never a wall clock). Every `RowStatus` renders through the SAME
 *  `StatusIcon` the run route uses (finding 5), so a queued or failed drafter reads honestly
 *  instead of a false green check. The report stays readable above while these still run.
 *
 *  The kicker is Rai's ruled verbatim pair (C15 4.1): "Regenerating the Boards" while the
 *  regeneration runs, "Regenerated the Boards" once it composed — a label swap on phase,
 *  not two components. */
function RegenerationProgress({
  state,
  lanes,
  coverage,
  usage,
}: {
  readonly state: RoundState;
  readonly lanes: readonly LensLane[];
  readonly coverage?: GenerationCoverage;
  readonly usage?: GenerationUsage;
}) {
  const steps = finishSteps(state, lanes);
  return (
    <div data-testid="regeneration-progress" className="flex flex-col gap-1">
      <span className="text-2xs font-medium uppercase tracking-wide text-muted-foreground/70">
        {state.phase === "composed" ? "Regenerated the Boards" : "Regenerating the Boards"}
      </span>
      {lanes.length > 0 && (
        <div className="flex flex-col divide-y divide-border/60 rounded-lg border border-border">
          {lanes.map((lane) => (
            <div
              key={lane.id}
              className="flex items-center gap-2.5 px-3.5 py-2 text-sm"
              data-row={lane.id}
              data-status={lane.status}
            >
              <StatusIcon status={lane.status} />
              <span className="text-foreground">{lane.label}</span>
              <span
                className={
                  lane.status === "failed"
                    ? "ml-auto text-2xs text-destructive"
                    : "ml-auto text-2xs text-muted-foreground"
                }
              >
                {/* The lane's own verdict (C15 3.3). A settled lens carries "carrying
                    forward" or "reworked" — derived server-side from the SAME `stampDeltas`
                    signal the board's section markers render, so a lane can never claim a
                    lens carried while its sections changed or went away. */}
                {laneNote(lane)}
              </span>
            </div>
          ))}
        </div>
      )}
      {coverage !== undefined && (
        <span
          data-testid="cross-lens-coverage"
          data-coverage={coverage.state}
          // The RENDERED register, exposed so a test can see the glyph choice: a coverage
          // run that completed with uncovered hunks is `warn`, never the green `done` check
          // that would read as a clean result over text saying the opposite.
          data-status={coverageStatus(coverage)}
          className="flex items-center gap-1.5 pt-1 text-12-5 text-muted-foreground"
        >
          <StatusIcon status={coverageStatus(coverage)} compact />
          {coverageNote(coverage)}
        </span>
      )}
      {usage !== undefined && (
        <span
          data-testid="generation-usage"
          data-turns={usage.turns}
          className="flex items-center gap-1.5 pt-1 text-12-5 text-muted-foreground"
        >
          {usageNote(usage)}
        </span>
      )}
      {steps.map((step) => (
        <span
          key={step.id}
          data-step={step.id}
          data-status={step.status}
          className="flex items-center gap-1.5 pt-1 text-12-5 text-muted-foreground"
        >
          <StatusIcon status={step.status} compact />
          {step.label}
        </span>
      ))}
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
  receipt,
}: {
  readonly board: RoundReportBoardModel;
  readonly state: RoundState;
  readonly onReveal: () => void;
  readonly receipt?: { readonly record: RoundLedgerRecord; readonly roundNumber: number };
}) {
  // The regeneration block lives on both regeneration phases: `composing` carries the
  // live lanes, and `composed` carries the ones it composed from (the machine forwards
  // them), so the kicker flips "Regenerating"→"Regenerated" over the same rows instead of
  // the block vanishing at the finish line.
  const lanes =
    state.phase === "composing"
      ? state.lanes
      : state.phase === "composed"
        ? (state.lanes ?? NO_LANES)
        : NO_LANES;
  const coverage = "coverage" in state ? state.coverage : undefined;
  const usage = "usage" in state ? state.usage : undefined;
  const regenerating = state.phase === "composing" || state.phase === "composed";
  return (
    <section
      data-screen="round-greeting"
      className="mx-auto flex w-full max-w-[820px] flex-col gap-6 p-6"
    >
      {receipt !== undefined && <RunReceiptSummary {...receipt} />}
      <RoundReportBoard board={board} />
      {regenerating && (
        <RegenerationProgress
          state={state}
          lanes={lanes}
          {...(coverage === undefined ? {} : { coverage })}
          {...(usage === undefined ? {} : { usage })}
        />
      )}
      {canRevealNewBoards(state) && (
        <Button
          data-testid="reveal-new-boards"
          variant="accent"
          onClick={onReveal}
          className="self-start"
        >
          View the New Boards
          <Icon icon={ArrowRight} className="size-3.5" />
        </Button>
      )}
    </section>
  );
}
