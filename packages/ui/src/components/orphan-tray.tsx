import type { OrphanedDisposition } from "../canvas/authoring";

// The orphan tray: when a patchset advances and the engine's conservative
// byte-identical carry drops a disposition (a changed, renamed, or removed file
// fails closed), that disposition surfaces HERE — visibly, never vanishing. The
// reviewer decides what to do with it; the system never silently loses their work.

export function OrphanTray({
  orphans,
  onReauthor,
}: {
  orphans: OrphanedDisposition[];
  onReauthor?: (path: string) => void;
}) {
  // Empty is empty: no tray chrome when nothing was dropped.
  if (orphans.length === 0) return null;
  return (
    <section className="orphan-tray" aria-label="Orphaned dispositions">
      <header className="orphan-header">
        {orphans.length} disposition{orphans.length === 1 ? "" : "s"} did not carry to the new
        patchset
      </header>
      <ul className="orphan-entries">
        {orphans.map((orphan) => (
          <li
            className="orphan-entry"
            data-path={orphan.anchor.path}
            data-type={orphan.type}
            key={`${orphan.anchor.path} ${orphan.anchor.contentDigest}`}
          >
            <span className="orphan-entry-path">{orphan.anchor.path}</span>
            <span className="orphan-entry-type">{orphan.type}</span>
            {orphan.body ? <span className="orphan-entry-body">{orphan.body}</span> : null}
            <span className="orphan-entry-reason">did not carry — the file changed</span>
            <button
              type="button"
              className="orphan-entry-reauthor"
              onClick={() => onReauthor?.(orphan.anchor.path)}
            >
              Re-open
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
