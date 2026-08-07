import type { CoverageMosaic } from "../canvas/read-state";

// The coverage mosaic: the totality/residue guarantee made visible. Every path in
// the changeset is a cell coloured by its read-state — read (actioned), skimmed
// (scrolled but never actioned), unread (collapsed or never seen). Collapse is
// never read (OQ4). "Next unread" jumps the cursor to the next residue cell.

const STATE_LABEL = { read: "Read", skimmed: "Skimmed", unread: "Unread" } as const;

export function CoverageMosaicView({
  mosaic,
  onGotoNextUnread,
}: {
  mosaic: CoverageMosaic;
  onGotoNextUnread?: (fromIndex: number) => void;
}) {
  return (
    <section className="coverage-mosaic" aria-label="Review coverage">
      <header className="coverage-figures">
        <span className="coverage-read">{mosaic.read} read</span>
        <span className="coverage-skimmed">{mosaic.skimmed} skimmed</span>
        <span className="coverage-unread">{mosaic.unread} unread</span>
        <span className="coverage-total">of {mosaic.total}</span>
        <button
          type="button"
          className="coverage-next-unread"
          disabled={mosaic.unread === 0}
          onClick={() => onGotoNextUnread?.(-1)}
        >
          Next unread
        </button>
      </header>
      <ol className="coverage-cells">
        {mosaic.cells.map((cell, index) => (
          <li
            className={`coverage-cell coverage-cell-${cell.state}`}
            data-state={cell.state}
            data-path={cell.path}
            title={`${cell.path} — ${STATE_LABEL[cell.state]}`}
            key={cell.path}
          >
            <button
              type="button"
              className="coverage-cell-goto"
              aria-label={`${cell.path} (${STATE_LABEL[cell.state]})`}
              onClick={() => onGotoNextUnread?.(index)}
            />
          </li>
        ))}
      </ol>
    </section>
  );
}
