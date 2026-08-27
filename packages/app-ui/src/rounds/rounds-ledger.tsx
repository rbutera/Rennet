import type { RoundRecord } from "@rennet/protocol";
import { cn } from "@rennet/ui";
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
//   - its FROZEN GENERATION — reachable through C5's `GenerationSwitcher` by handing
//     `LensBoardView` the record's `[boardGeneration, mintedPatchsetGeneration]` (the
//     #457 append-then-freeze pair: the generation it reported against, and the one its
//     worker minted), so drilling back is just a generation id on the one board seam;
//   - its DIFF — the diff surface, reachable by toggling `?view=diff`.
//
// The ledger owns no round data of its own: records arrive from `useRoundRecords`
// (read by the workspace, handed in as `records` — the workspace already needs the
// count for its presence guard), and the report board is resolved + validated through
// the rounds seam's `useReportBoard`. No timestamp lives on a `RoundRecord`, so a row
// summarises with the round number and its dispatched-ask count rather than a "when".
// ─────────────────────────────────────────────────────────────────────────────

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
  const frozen = record.boardGeneration;
  const minted = record.mintedPatchsetGeneration;
  // oldest→newest, deduped: the generation the round reported against, then the one its
  // worker minted (if anything landed). One id ⇒ nothing to drill into (switcher hides).
  const generations = minted && minted !== frozen ? [frozen, minted] : [frozen];
  const liveGeneration = minted ?? frozen;

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

        <button
          type="button"
          data-testid="round-diff-link"
          data-round-generation={liveGeneration}
          onClick={() => navigate(sessionPath(slug, { view: "diff", round: liveGeneration }))}
          className="self-start text-model text-sm underline-offset-2 hover:underline"
        >
          Round diff
        </button>

        <LensBoardView generation={liveGeneration} generations={generations} />
      </div>
    </section>
  );
}
