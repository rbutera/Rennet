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
    <nav className="l3-index" aria-label="Orchestrator marks index">
      {placed.length > 0 ? (
        <ul className="l3-index-list">
          {placed.map((entry) => (
            <li className="l3-index-item" data-mark-kind={entry.markKind} key={entry.markId}>
              <button
                type="button"
                className="l3-index-jump"
                data-jump={entry.markId}
                onClick={() => onNavigate(entry)}
              >
                <span className="l3-hand" aria-hidden="true">
                  ◇
                </span>
                <span className="l3-index-label">{entry.label}</span>
                <span className="l3-index-anchor">{entry.anchor}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {orphans.length > 0 ? (
        <section className="l3-orphan-tray" aria-label="Orphaned marks">
          <header className="l3-orphan-header">
            {orphans.length} mark{orphans.length === 1 ? "" : "s"} could not be placed
          </header>
          <ul className="l3-orphan-list">
            {orphans.map((entry) => (
              <li className="l3-orphan-item" data-orphan-mark={entry.markId} key={entry.markId}>
                <span className="l3-hand" aria-hidden="true">
                  ◇
                </span>
                <span className="l3-index-label">{entry.label}</span>
                <span className="l3-orphan-reason">anchor did not resolve to a place</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </nav>
  );
}
