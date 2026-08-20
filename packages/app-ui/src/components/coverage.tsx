import { Button } from "@rennet/ui";
import type { CoverageMosaic } from "../canvas/read-state";

// The coverage mosaic: the totality/residue guarantee made visible. Every path in
// the changeset is a cell coloured by its read-state — read (actioned), skimmed
// (scrolled but never actioned), unread (collapsed or never seen). Collapse is
// never read (OQ4). "Next unread" jumps the cursor to the next residue cell.

const STATE_LABEL = { read: "Read", skimmed: "Skimmed", unread: "Unread" } as const;

// Cell fill by read-state: read is evidence (green), skimmed a light gold, unread a
// neutral step. The title + aria-label carry the state — colour is never the only cue.
const CELL_BG = {
  read: "bg-green-soft",
  skimmed: "bg-accent-soft",
  unread: "bg-raised",
} as const;

export function CoverageMosaicView({
  mosaic,
  onGotoNextUnread,
}: {
  mosaic: CoverageMosaic;
  onGotoNextUnread?: (fromIndex: number) => void;
}) {
  return (
    <section className="coverage-mosaic flex flex-col gap-2" aria-label="Review coverage">
      <header className="coverage-figures flex flex-wrap items-center gap-3 text-sm text-ink-soft">
        <span className="coverage-read text-green">{mosaic.read} read</span>
        <span className="coverage-skimmed text-ink-soft">{mosaic.skimmed} skimmed</span>
        <span className="coverage-unread text-ink-faint">{mosaic.unread} unread</span>
        <span className="coverage-total text-ink-faint">of {mosaic.total}</span>
        <Button
          variant="outline"
          className="coverage-next-unread ml-auto"
          disabled={mosaic.unread === 0}
          onClick={() => onGotoNextUnread?.(-1)}
        >
          Next unread
        </Button>
      </header>
      <ol className="coverage-cells m-0 flex list-none flex-wrap gap-1 p-0">
        {mosaic.cells.map((cell, index) => (
          <li
            className={`coverage-cell coverage-cell-${cell.state} h-4 w-4 rounded-micro border border-line ${CELL_BG[cell.state]}`}
            data-state={cell.state}
            data-path={cell.path}
            title={`${cell.path} — ${STATE_LABEL[cell.state]}`}
            key={cell.path}
          >
            <button
              type="button"
              className="coverage-cell-goto h-full w-full cursor-pointer border-0 bg-transparent"
              aria-label={`${cell.path} (${STATE_LABEL[cell.state]})`}
              onClick={() => onGotoNextUnread?.(index)}
            />
          </li>
        ))}
      </ol>
    </section>
  );
}
