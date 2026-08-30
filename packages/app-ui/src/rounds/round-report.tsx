import type {
  HostElement,
  LensSection,
  RoundReportBoard as RoundReportBoardModel,
} from "@rennet/protocol";
import type { ReactNode } from "react";
import {
  BoardElementsProvider,
  useBoardPatchsetId,
  useElement,
  useElements,
} from "../board/kinds/element-context";
import { RichText } from "../review";
import { ReportElement } from "./report-registry";

// ─────────────────────────────────────────────────────────────────────────────
// The round report body (C09 2.3, Objective "round report as the greeting") — the
// shared body the greeting (cluster 5) and the ledger (cluster 6) both mount.
//
// A report is a `RoundReportBoard`: a prose greeting plus `round_outcome`
// items. It renders through the SAME element pool the lens board uses
// (`BoardElementsProvider` — the citation join), dispatching each element through the
// report registry (`ReportElement`), never a bespoke document. The status tally is
// DERIVED from the board's outcomes, never stored. Sections render readable (expanded):
// the report must be readable the moment the reviewer returns (cluster 5's objective),
// not folded behind a gist.
// ─────────────────────────────────────────────────────────────────────────────

/** Display order for the status tally — the four `round_outcome` statuses (#486). */
const STATUS_ORDER = ["addressed", "partial", "untouched", "beyond"] as const;

/** A stable empty child list — a non-section ref resolves to no children (never a fresh
 *  array per render, so the pool resolver's memo identity holds). */
const NO_CHILDREN: readonly string[] = Object.freeze([]);

/** Tally the round's outcomes by status, in display order — DERIVED, never stored. */
export function roundOutcomeTally(board: RoundReportBoardModel): string {
  const counts = new Map<string, number>();
  for (const el of board.elements) {
    if (el.kind === "round_outcome") {
      counts.set(el.data.status, (counts.get(el.data.status) ?? 0) + 1);
    }
  }
  return STATUS_ORDER.filter((s) => counts.has(s))
    .map((s) => `${counts.get(s)} ${s}`)
    .join(" · ");
}

function ReportDocument({ board }: { readonly board: RoundReportBoardModel }) {
  const patchsetId = useBoardPatchsetId();
  return (
    <header className="flex flex-col gap-3">
      <h1 className="font-display text-foreground text-xl leading-snug">{board.document.title}</h1>
      {board.document.introMarkdown.trim().length > 0 && (
        <RichText
          text={board.document.introMarkdown}
          patchsetId={patchsetId}
          className="max-w-[640px]"
          paragraphClassName="text-15 leading-relaxed text-foreground/85"
        />
      )}
    </header>
  );
}

/** One report section: its title over its NON-outcome children, each through the report
 *  registry, plus whatever the board hands it as `card`. Resolves the `section` element
 *  through the pool (the machinery), like the lens `Section` — but readable (no fold) and
 *  over the wider report dispatch.
 *
 *  The outcomes are NOT gathered here. "One card" is a claim about the ROUND, and a
 *  section-local card could not make it: two outcome-bearing sections produced TWO cards,
 *  and a section mixing prose with outcomes produced NONE (the `every` test failed), so its
 *  outcomes fell out as loose paragraphs. Both shapes are wire-valid. {@link RoundReportBoard}
 *  therefore collects them board-wide and passes the one card down to be placed. */
function ReportSection({
  entry,
  omit,
  card,
}: {
  readonly entry: LensSection;
  readonly omit: ReadonlySet<string>;
  readonly card?: ReactNode;
}) {
  const el = useElement(entry.ref);
  const childIds = el?.kind === "section" ? el.data.children : NO_CHILDREN;
  const children = useElements(childIds);
  if (el?.kind !== "section") return null;
  const rest = children.filter((child) => !omit.has(child.id));
  return (
    <section data-kind="report-section" data-section-id={entry.ref} className="flex flex-col gap-3">
      <h2 className="font-display text-foreground text-lg leading-snug">{el.data.title}</h2>
      {rest.length > 0 && (
        <div className="flex flex-col gap-3">
          {rest.map((child) => (
            <ReportElement key={child.id} element={child} />
          ))}
        </div>
      )}
      {card}
    </section>
  );
}

/** The round's outcomes, as ONE bordered `divide-y` card with `px-4 py-3` rows (prototype
 *  `round-report.tsx:30-46`): they are a per-ask ledger, and the shared frame is what makes
 *  them read as one account rather than loose paragraphs. */
function OutcomeCard({ outcomes }: { readonly outcomes: readonly HostElement[] }) {
  return (
    <div
      data-kind="report-outcome-card"
      className="flex flex-col divide-y divide-border/60 rounded-md border border-border"
    >
      {outcomes.map((outcome) => (
        <div key={outcome.id} className="px-4 py-3">
          <ReportElement element={outcome} />
        </div>
      ))}
    </div>
  );
}

/** Render a report board (greeting + `round_outcome` items) through the report
 *  registry, headed by the derived status tally. The shared report body. */
export function RoundReportBoard({ board }: { readonly board: RoundReportBoardModel }) {
  // Every outcome on the board, in board order — one ledger for the round, however the
  // producer distributed them across sections.
  const outcomes = board.elements.filter((el) => el.kind === "round_outcome");
  const outcomeIds = new Set<string>(outcomes.map((el) => el.id));
  // The card lands in the section where the outcomes first appear, so a mixed section keeps
  // its prose above and the ledger below, in reading order.
  const firstOutcomeSection = board.sections.find((entry) => {
    const section = board.elements.find((el) => el.id === entry.ref);
    return section?.kind === "section" && section.data.children.some((id) => outcomeIds.has(id));
  })?.ref;
  const card = outcomes.length > 0 ? <OutcomeCard outcomes={outcomes} /> : null;
  return (
    <BoardElementsProvider
      elements={board.elements}
      generation={board.generation}
      boardId={board.boardId}
    >
      <article
        data-kind="round-report"
        data-board-id={board.boardId}
        className="flex flex-col gap-5"
      >
        <ReportDocument board={board} />
        <p data-testid="report-tally" className="text-muted-foreground text-sm">
          {roundOutcomeTally(board)}
        </p>
        {board.sections.map((entry) => (
          <ReportSection
            key={entry.ref}
            entry={entry}
            omit={outcomeIds}
            card={entry.ref === firstOutcomeSection ? card : undefined}
          />
        ))}
        {/* Outcomes no section claims are still the round's — a producer can leave them
            loose, and dropping them would lose the whole ledger rather than a heading. */}
        {firstOutcomeSection === undefined && card}
      </article>
    </BoardElementsProvider>
  );
}
