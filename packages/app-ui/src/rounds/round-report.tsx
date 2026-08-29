import type { LensSection, RoundReportBoard as RoundReportBoardModel } from "@rennet/protocol";
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
          paragraphClassName="text-base leading-relaxed text-foreground/85"
        />
      )}
    </header>
  );
}

/** One report section: its title over its children, each child through the report
 *  registry. Resolves the `section` element through the pool (the machinery), like the
 *  lens `Section` — but readable (no fold) and over the wider report dispatch. */
function ReportSection({ entry }: { readonly entry: LensSection }) {
  const el = useElement(entry.ref);
  const childIds = el?.kind === "section" ? el.data.children : NO_CHILDREN;
  const children = useElements(childIds);
  if (el?.kind !== "section") return null;
  return (
    <section data-kind="report-section" data-section-id={entry.ref} className="flex flex-col gap-3">
      <h2 className="font-display text-foreground text-lg leading-snug">{el.data.title}</h2>
      <div className="flex flex-col gap-3">
        {children.map((child) => (
          <ReportElement key={child.id} element={child} />
        ))}
      </div>
    </section>
  );
}

/** Render a report board (greeting + `round_outcome` items) through the report
 *  registry, headed by the derived status tally. The shared report body. */
export function RoundReportBoard({ board }: { readonly board: RoundReportBoardModel }) {
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
          <ReportSection key={entry.ref} entry={entry} />
        ))}
      </article>
    </BoardElementsProvider>
  );
}
