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
    <section
      className="orphan-tray rounded-surface border border-accent-line bg-accent-surface p-4"
      aria-label="Orphaned dispositions"
    >
      <header className="orphan-header mb-2 text-sm font-semibold text-accent">
        {orphans.length} disposition{orphans.length === 1 ? "" : "s"} did not carry to the new
        patchset
      </header>
      <ul className="orphan-entries flex list-none flex-col gap-2">
        {orphans.map((orphan) => (
          <li
            className="orphan-entry flex flex-wrap items-baseline gap-2 font-sans text-sm text-ink-soft"
            data-path={orphan.anchor.path}
            data-type={orphan.type}
            key={`${orphan.anchor.path} ${orphan.anchor.contentDigest}`}
          >
            <span className="orphan-entry-path font-mono text-ink">{orphan.anchor.path}</span>
            <span className="orphan-entry-type text-2xs uppercase tracking-wide text-accent">
              {orphan.type}
            </span>
            {orphan.body ? (
              <span className="orphan-entry-body text-ink-soft">{orphan.body}</span>
            ) : null}
            <span className="orphan-entry-reason text-2xs text-ink-faint">
              did not carry — the file changed
            </span>
            <button
              type="button"
              className="orphan-entry-reauthor ml-auto cursor-pointer rounded-chip border border-accent-line px-2 py-1 text-xs text-accent hover:bg-accent-soft"
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
