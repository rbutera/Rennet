import { ROUND_NO_REGEN, type RoundRecord } from "@rennet/protocol";
import { cn } from "@rennet/ui";
import { Check } from "lucide-react";
import { useState } from "react";
import { useLocation } from "wouter";
import { LensBoardView } from "../board";
import { sessionPath } from "../routes/url";
import { RoundReportBoard } from "./round-report";
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
//     generation identity (finding 2).
//
// The ledger owns no round data of its own: records arrive from `useRoundRecords`
// (read by the workspace, handed in as `records` — the workspace already needs the
// count for its presence guard), and the report board is resolved + validated through
// the rounds seam's `useReportBoard`. No timestamp lives on a `RoundRecord`, so a row
// summarises with the round number and its dispatched-ask count rather than a "when".
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The review's generation line, oldest→newest, walked out of the durable records (C15 4.4).
 * Each record contributes its frozen predecessor (when the round moved code) and then its own
 * board generation, so the ids arrive in round order and a `Set` keeps the first sighting of
 * each. `ROUND_NO_REGEN` is a dispatch round's honest "regenerated nothing" marker, not a
 * generation, so it never enters the line.
 */
function generationLine(records: readonly RoundRecord[]): readonly string[] {
  const ids = records.flatMap((r) => [r.frozenPredecessor, r.boardGeneration]);
  return [...new Set(ids.filter((id): id is string => id !== undefined && id !== ROUND_NO_REGEN))];
}

export function RoundsLedger({
  slug,
  records,
}: {
  readonly slug: string;
  readonly records: readonly RoundRecord[];
}) {
  const [, navigate] = useLocation();

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
  const line = generationLine(records);
  const position = line.indexOf(liveGeneration);
  const generations = position >= 0 ? line.slice(0, position + 1) : [liveGeneration];
  const regenerated = liveGeneration !== ROUND_NO_REGEN;

  return (
    <section
      data-screen="rounds-ledger"
      className="mx-auto flex w-full max-w-[820px] flex-col gap-6 p-6"
    >
      <header className="flex flex-col gap-1">
        <h1 className="font-display text-foreground text-xl">Rounds</h1>
        <p className="text-muted-foreground text-sm">
          Every completed work-order round — its report, its frozen generation, and its diff.
        </p>
      </header>

      <ul
        data-testid="rounds-ledger-rows"
        className="flex flex-col divide-y divide-border/60 overflow-hidden rounded-lg border border-border"
      >
        {rows.map(({ record: r, round }) => {
          const active = round === selectedRound;
          return (
            <li key={round}>
              <button
                type="button"
                data-round={round}
                aria-current={active ? "true" : undefined}
                onClick={() => setSelectedRound(round)}
                className={cn(
                  "flex w-full items-center gap-3 px-3.5 py-2.5 text-left text-sm transition-colors",
                  active ? "bg-secondary" : "hover:bg-secondary/50",
                )}
              >
                <span className="font-medium text-foreground">Round {round}</span>
                <span className="text-muted-foreground text-2xs">
                  {r.asksDispatched.length} asks
                </span>
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

        {/* The retrospective activity line a SETTLED report wears (C15 4.3) — the round's
            own account of the regeneration, off the durable record: the reworks it was
            dispatched to make and the generation it composed. A round that regenerated
            nothing (`ROUND_NO_REGEN`) wears no line rather than claiming a regeneration. */}
        {report.status === "valid" && regenerated && (
          <p
            data-testid="round-retrospective"
            data-generation={liveGeneration}
            className="flex items-center gap-2 text-muted-foreground text-xs"
          >
            <Check className="size-3.5 shrink-0 text-muted-foreground/70" aria-hidden="true" />
            Regenerated the boards · {record.asksDispatched.length} reworks · generation{" "}
            {liveGeneration}
          </p>
        )}

        <button
          type="button"
          data-testid="round-diff-link"
          data-round-generation={liveGeneration}
          onClick={() => navigate(sessionPath(slug, { view: "diff", round: liveGeneration }))}
          className="self-start text-model text-sm underline-offset-2 hover:underline"
        >
          Round diff
        </button>

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

        <LensBoardView generation={liveGeneration} generations={generations} />
      </div>
    </section>
  );
}
