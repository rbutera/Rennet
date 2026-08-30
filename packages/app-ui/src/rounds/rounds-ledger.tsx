import { ROUND_NO_REGEN, type RoundLedgerRecord, type RoundRecord } from "@rennet/protocol";
import { cn } from "@rennet/ui";
import { Check, ChevronRight, GitCommitHorizontal, Minus } from "lucide-react";
import { useState } from "react";
import { useLocation, useSearch } from "wouter";
import { LensBoardView } from "../board";
import { Icon } from "../components/icon";
import { readSessionQuery, sessionPath } from "../routes/url";
import { roundTargetLabel } from "./round-machine";
import { RoundReportBoard, roundOutcomeTally } from "./round-report";
import { useReportBoard } from "./rounds-data";

// ─────────────────────────────────────────────────────────────────────────────
// The rounds ledger (C09 §6, Objective "rounds ledger beside Map·Diff") — the
// `?view=rounds` surface: the history of completed work-order rounds. One row per
// {@link RoundRecord} (newest first — the round number is the 1-based position in the
// oldest→newest ledger the seam hands back), and the selected round's three linked
// artefacts (INVENTORY §7.3):
//   - its REPORT — the `RoundRecord.reportBoard`, rendered through cluster 2's shared
//     `RoundReportBoard` (the same body the greeting mounts);
//   - its GENERATION — the round's own boards, on the one `LensBoardView` seam, opened with
//     the review's real generation LINE so the `GenerationSwitcher` can drill back (C15 4.4,
//     un-parking C09 finding F3). C15 2.2 stamps `frozenPredecessor` onto the durable record,
//     so the ledger no longer has to fake a single-generation session: the ids are walked out
//     of the records themselves, oldest→newest, and a round with no distinct predecessor
//     honestly offers no drill-down (the switcher hides itself under two ids);
//   - its DIFF — the diff surface, reachable by toggling `?view=diff` with the round's
//     LEDGER NUMBER (#571). The diff is the round's own checkpoint-measured change, carried
//     on the record since the dispatch wrote it; a round that captured none offers no
//     control at all rather than a live button that admits it does nothing.
//
// The ledger owns no round data of its own: records arrive from `useRoundRecords`
// (read by the workspace, handed in as `records` — the workspace already needs the
// count for its presence guard), and the report board is resolved + validated through
// the rounds seam's `useReportBoard`. Modern rows carry the immutable run receipt and exact
// report projection, so their summary states when and where the round ran and what it returned.
// Legacy rows omit facts they do not carry rather than guessing them.
// ─────────────────────────────────────────────────────────────────────────────

const ROUND_TIME_FORMATTER = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

/**
 * The review's generation line, oldest→newest, walked out of the durable records (C15 4.4).
 * Each record contributes its frozen predecessor (when the round moved code) and then its own
 * board generation, so the ids arrive in round order and a `Set` keeps the first sighting of
 * each. `ROUND_NO_REGEN` is a dispatch round's honest "regenerated nothing" marker, not a
 * generation, so it never enters the line.
 */
export function generationLine(records: readonly RoundRecord[]): readonly string[] {
  const ids = records.flatMap((r) => [r.frozenPredecessor, r.boardGeneration]);
  return [...new Set(ids.filter((id): id is string => id !== undefined && id !== ROUND_NO_REGEN))];
}

/**
 * Duration, in the shape the run receipt's millisecond count deserves at a glance.
 *
 * Rounds to whole seconds FIRST, then splits. Rounding after the split let the remainder
 * carry into a unit that cannot hold it: 59_999ms printed "60s" and 359_999ms printed
 * "5m 60s". A gate that finished inside a second reads "<1s" rather than the "0s" a round
 * gives it — the run happened, and "0s" says it took no time at all.
 */
export function gateDuration(ms: number): string {
  if (ms < 1000) return "<1s";
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/**
 * The retrospective panel a settled round wears (prototype `round-report.tsx:118-158`):
 * the one-line account is the DISCLOSURE, and opening it shows what the round was
 * dispatched to do and how its run went.
 *
 * Bound only to the durable record. **Trigger Queue** is `asksDispatched` — the exact
 * field the prototype's `round.triggers` stood in for — read back through the report's
 * `round_outcome` items so a dispatched ask shows its text rather than its thread id
 * (the report is the only place the ask's words survive on the record). **Run** is the
 * immutable run receipt: the gate the round ran and the commits it landed.
 *
 * What is NOT here, deliberately: the prototype's "Turn Anatomy" — three sentences
 * narrating what the orchestrator read, which lenses carried forward, and what the
 * re-draft marked. No producer writes that account. The per-lens carry/rework verdicts
 * exist only while a round is LIVE (`LensLane.verdict`, emitted as `RoundEvent`
 * `{type:"lens"}` from `server/src/runtime/rounds.ts:730`) and are never persisted onto
 * `RoundRecord`, so a settled round cannot recover them. Narrating them here would be
 * fiction, so the panel says less than the prototype and everything it says is checked.
 */
function ActivityFeed({
  record,
  generation,
  reworks,
  askText,
}: {
  readonly record: RoundLedgerRecord;
  readonly generation: string;
  readonly reworks: string;
  readonly askText: (ref: string) => string;
}) {
  const [open, setOpen] = useState(false);
  const gate = record.run?.gate;
  const commits = record.workerCommitRange;
  return (
    <div
      data-testid="round-retrospective"
      data-generation={generation}
      className="rounded-md border border-border bg-secondary/20"
    >
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-4 py-2 text-left text-muted-foreground text-xs transition-colors hover:text-foreground"
      >
        <Icon
          icon={ChevronRight}
          className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")}
        />
        <Icon icon={Check} className="size-3.5 shrink-0 text-muted-foreground/70" />
        Regenerated the boards{reworks} · generation {generation}
      </button>
      {open && (
        <div
          data-testid="round-retrospective-detail"
          className="flex flex-col gap-3 px-4 pt-1 pb-3 pl-10"
        >
          {record.asksDispatched.length > 0 && (
            <div className="flex flex-col gap-1">
              {/* 10px at full `text-muted-foreground`: the /70 knocked these group labels
                  under AA in both schemes, and they are the smallest type on the panel. */}
              <span className="font-medium text-10 text-muted-foreground uppercase tracking-wide">
                Trigger Queue
              </span>
              {record.asksDispatched.map((ref) => (
                <span
                  key={ref}
                  data-testid="round-trigger"
                  className="flex items-baseline gap-1.5 text-12-5 text-muted-foreground"
                >
                  <span aria-hidden="true" className="select-none text-muted-foreground/50">
                    ‣
                  </span>
                  {askText(ref)}
                </span>
              ))}
            </div>
          )}
          {/* The GATE is the optional half — it rides the run receipt, which legacy rows
              omit. The commit range is record-level and always present, so it renders
              either way: a legacy row that landed commits used to hide them purely
              because nobody had written down which gate command ran. */}
          <div className="flex flex-col gap-1">
            <span className="font-medium text-10 text-muted-foreground uppercase tracking-wide">
              Run
            </span>
            {gate !== undefined && (
              <span
                data-testid="round-gate"
                className="flex items-center gap-1.5 text-12-5 text-muted-foreground"
              >
                <Icon
                  icon={gate.outcome === "passed" ? Check : Minus}
                  className="size-3 shrink-0"
                />
                {gate.outcome === "passed"
                  ? `Gate passed · ${gate.command} · ${gateDuration(gate.durationMs)}`
                  : "No gate configured — the round ran without one"}
              </span>
            )}
            <span
              data-testid="round-commits"
              className="flex items-center gap-1.5 text-12-5 text-muted-foreground"
            >
              <Icon icon={GitCommitHorizontal} className="size-3 shrink-0" />
              {commits.from === commits.to
                ? "The worker landed no commits"
                : `Committed ${commits.from.slice(0, 7)}…${commits.to.slice(0, 7)}`}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

export function RoundsLedger({
  reviewId,
  slug,
  records,
}: {
  /** The review whose boards the ledger detail reads (the `board.read` identity). */
  readonly reviewId: string;
  readonly slug: string;
  readonly records: readonly RoundLedgerRecord[];
}) {
  const [, navigate] = useLocation();
  const query = readSessionQuery(new URLSearchParams(useSearch()));

  // Newest round first; the round number is the 1-based position in the oldest→newest
  // ledger, preserved as we reverse for display.
  const rows = records.map((record, index) => ({ record, round: index + 1 })).reverse();
  const [selectedRound, setSelectedRound] = useState(rows[0]?.round ?? 0);
  const selected = rows.find((r) => r.round === selectedRound) ?? rows[0];

  // The one report read (a single hook, stable across selection changes). The seam owns
  // validation: an unreadable report resolves `invalid`, never "no round".
  const report = useReportBoard(selected?.record.reportBoard ?? "");

  if (!selected) return null; // the workspace guards `records.length > 0`; honest no-op otherwise.

  const { record } = selected;
  // The generation the round reported against — the one the board surface opens on.
  const liveGeneration = record.boardGeneration;
  // …and everything before it in the review's generation line, so the switcher can drill
  // BACK to the frozen predecessor C15 2.2 persisted (C09 finding F3, un-parked). Slicing at
  // the selected round means a past round opens on ITS generation as the live one, with only
  // the generations that already existed then behind it — never a forward id it never saw.
  // The rework count is the ROUND REPORT's own verified tally, persisted onto the record
  // (C15 finding 10) — the `round_outcome` items the report did not classify `untouched`.
  // `asksDispatched.length` used to stand in for it, which counted how many asks went OUT
  // and read "5 reworks" over a round that changed nothing. A round whose report never
  // drafted has no verified count, so the line carries no number rather than inventing a
  // zero: honestly silent beats confidently wrong.
  const reworks =
    record.reworkCount === undefined
      ? ""
      : ` · ${record.reworkCount} ${record.reworkCount === 1 ? "rework" : "reworks"}`;
  // A dispatched ask is a thread id on the record; its WORDS survive only on the round
  // report's `round_outcome` items (`ask.ref` is the same id space `asksDispatched`
  // carries — `test/fixtures/rounds/report-board.ts:60-83` shows both halves). An ask
  // the report never accounted for keeps its id rather than borrowing another ask's text.
  const askText = (ref: string): string => {
    if (report.status !== "valid") return ref;
    for (const el of report.board.elements) {
      if (el.kind === "round_outcome" && el.data.ask.ref === ref) return el.data.ask.text;
    }
    return ref;
  };
  const line = generationLine(records);
  const position = line.indexOf(liveGeneration);
  const generations = position >= 0 ? line.slice(0, position + 1) : [liveGeneration];
  const selectedGeneration =
    query.generation !== null && generations.includes(query.generation)
      ? query.generation
      : liveGeneration;
  const regenerated = liveGeneration !== ROUND_NO_REGEN;

  return (
    <section
      data-screen="rounds-ledger"
      className="mx-auto flex w-full max-w-[720px] flex-col gap-6 px-8 py-10"
    >
      <header className="flex flex-col gap-1">
        <h1 className="font-display text-foreground text-xl">Rounds</h1>
        <p className="text-muted-foreground text-sm">
          Every completed work-order round — its report, its frozen generation, and its diff.
        </p>
      </header>

      <ul
        data-testid="rounds-ledger-rows"
        className="flex flex-col divide-y divide-border/60 overflow-hidden rounded-md border border-border"
      >
        {rows.map(({ record: r, round }) => {
          const active = round === selectedRound;
          const tally = r.report === undefined ? "" : roundOutcomeTally(r.report);
          return (
            <li key={round}>
              <button
                type="button"
                data-round={round}
                aria-current={active ? "true" : undefined}
                onClick={() => setSelectedRound(round)}
                className={cn(
                  "flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm transition-colors",
                  active ? "bg-secondary/40" : "hover:bg-secondary/20",
                )}
              >
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="font-medium text-foreground">Round {round}</span>
                  {r.run !== undefined && (
                    <span className="truncate text-muted-foreground text-2xs">
                      <time dateTime={new Date(r.run.startedAt).toISOString()}>
                        {ROUND_TIME_FORMATTER.format(new Date(r.run.startedAt))}
                      </time>
                      {" · on "}
                      {roundTargetLabel(r.run.sourceTarget)}
                    </span>
                  )}
                </span>
                {tally.length > 0 && (
                  <span className="ml-auto text-right text-muted-foreground text-2xs">{tally}</span>
                )}
              </button>
            </li>
          );
        })}
      </ul>

      <div data-testid="rounds-ledger-detail" className="flex flex-col gap-5">
        {report.status === "valid" ? (
          <RoundReportBoard board={report.board} />
        ) : report.status === "invalid" ? (
          <p className="text-danger text-sm">This round's report could not be read.</p>
        ) : (
          <p className="text-muted-foreground text-sm">This round has no report.</p>
        )}

        {/* The retrospective activity feed a SETTLED report wears (C15 4.3) — the round's
            own account of the regeneration, off the durable record. */}
        {report.status === "valid" && regenerated && (
          <ActivityFeed
            record={record}
            generation={liveGeneration}
            reworks={reworks}
            askText={askText}
          />
        )}

        {/* The round's DIFF — its own change, off the checkpoint the round captured
            (`RoundRecord.diffFiles`, split at the `session.rounds` read). Addressed by the
            round's LEDGER NUMBER, not its generation: a dispatch round that regenerated
            nothing carries `ROUND_NO_REGEN`, so a generation id cannot name a round back
            (#571). A round that captured no diff has NO control here — absent, never a
            greyed-out button or a link that lands on "isn't wired yet". */}
        {(record.diffFiles?.length ?? 0) > 0 && (
          <button
            type="button"
            data-testid="round-diff-link"
            data-round-number={selected.round}
            onClick={() =>
              navigate(
                sessionPath(slug, {
                  view: "diff",
                  lens: query.lens,
                  generation: query.generation ?? undefined,
                  file: query.file ?? undefined,
                  round: String(selected.round),
                  ask: query.ask ?? undefined,
                }),
              )
            }
            className="self-start text-model text-sm underline-offset-2 hover:underline"
          >
            Round diff
          </button>
        )}

        {/* The regenerated board's intro (C15 4.4): the generation this round composed and
            the round that composed it, in one quiet line rather than chrome prose. The
            number is the generation's real position in the review's line — the SAME ordinal
            the switcher beneath labels its tabs with, so the two can never disagree (and a
            drill-down is unambiguous: the switcher marks the frozen tab it moved to). */}
        {regenerated && (
          <p data-testid="board-intro" className="text-muted-foreground text-2xs">
            Generation {generations.length} · Round {selected.round}
          </p>
        )}

        <LensBoardView
          reviewId={reviewId}
          generation={liveGeneration}
          selectedGeneration={selectedGeneration}
          lens={query.lens}
          generations={generations}
          onGenerationSelect={(generation) =>
            navigate(
              sessionPath(slug, {
                view: "rounds",
                lens: query.lens,
                generation: generation === liveGeneration ? undefined : generation,
                file: query.file ?? undefined,
                round: query.round ?? undefined,
                ask: query.ask ?? undefined,
              }),
              { replace: true },
            )
          }
        />
      </div>
    </section>
  );
}
