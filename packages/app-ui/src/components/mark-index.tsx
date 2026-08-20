// ─────────────────────────────────────────────────────────────────────────────
// MarkIndex — the demoted l3-strip. Doctrine (issue #77): "marks live at their
// anchors, never in a list." The strip is no longer the marks' HOME — the marks
// render AT their anchors in the CodeView. This is only an INDEX: a jump-list
// that navigates to the in-code mark. A mark whose anchor does not resolve to a
// place surfaces in the orphan tray here, visibly, never silently in a list.
// ─────────────────────────────────────────────────────────────────────────────

export interface MarkIndexEntry {
  markId: string;
  markKind: "annotation" | "proposal";
  label: string;
  anchor: string;
  /** True when the anchor resolves to no place — routed to the orphan tray. */
  orphan: boolean;
}

export function MarkIndex({
  entries,
  onNavigate,
}: {
  entries: MarkIndexEntry[];
  onNavigate(entry: MarkIndexEntry): void;
}) {
  if (entries.length === 0) return null;
  const placed = entries.filter((entry) => !entry.orphan);
  const orphans = entries.filter((entry) => entry.orphan);
  return (
    <nav
      className="l3-index flex flex-col gap-2 border-b border-line px-5 py-2.5"
      aria-label="Orchestrator marks index"
    >
      {placed.length > 0 ? (
        <ul className="l3-index-list m-0 flex list-none flex-col gap-1 p-0">
          {placed.map((entry) => (
            <li className="l3-index-item" data-mark-kind={entry.markKind} key={entry.markId}>
              <button
                type="button"
                className="l3-index-jump flex w-full cursor-pointer items-baseline gap-2 rounded-surface border border-dashed border-accent-line bg-transparent px-2.5 py-1.5 text-left text-base text-ink-soft hover:bg-accent-soft"
                data-jump={entry.markId}
                onClick={() => onNavigate(entry)}
              >
                <span className="l3-hand text-base leading-relaxed text-accent" aria-hidden="true">
                  ◇
                </span>
                <span className="l3-index-label min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
                  {entry.label}
                </span>
                <span className="l3-index-anchor font-mono text-2xs text-ink-faint">
                  {entry.anchor}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {orphans.length > 0 ? (
        <section
          className="l3-orphan-tray rounded-surface border border-accent-line bg-accent-surface px-2.5 py-2"
          aria-label="Orphaned marks"
        >
          <header className="l3-orphan-header mb-1.5 text-sm text-accent">
            {orphans.length} mark{orphans.length === 1 ? "" : "s"} could not be placed
          </header>
          <ul className="l3-orphan-list m-0 flex list-none flex-col gap-1 p-0">
            {orphans.map((entry) => (
              <li
                className="l3-orphan-item flex items-baseline gap-2 text-base text-ink-soft"
                data-orphan-mark={entry.markId}
                key={entry.markId}
              >
                <span className="l3-hand text-base leading-relaxed text-accent" aria-hidden="true">
                  ◇
                </span>
                <span className="l3-index-label min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
                  {entry.label}
                </span>
                <span className="l3-orphan-reason text-2xs text-ink-faint">
                  anchor did not resolve to a place
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </nav>
  );
}
