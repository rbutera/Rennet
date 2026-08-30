import type { ProjectSource } from "@rennet/protocol";
import { cn, Spinner } from "@rennet/ui";
import { Monitor, Server } from "lucide-react";
import { Icon } from "./icon";

/**
 * One selectable source in the add-a-project flow (source-aware project selection, task 6):
 * the local host, a WSL distro (`wsl:<distro>`), or a paired remote (`remote:<deviceId>`).
 * The `id` is the persisted {@link ProjectSource}; `label` is the human row text.
 */
export interface SourceOption {
  id: ProjectSource;
  label: string;
}

/**
 * The source switcher above the directory browser. Selecting a non-local row attaches that
 * source's own daemon (a remount, owned by the shell) so the browser below lists ITS
 * filesystem — the spec's "browse a WSL/remote source by attaching that source's daemon".
 *
 * Rows are styled like the front door's `recent-row`. "Local" is always first (it is the
 * owned daemon, always present). While the shell is attaching, the selected row shows a
 * "connecting…" spinner in place of its normal affordance.
 */
export function SourceSwitcher({
  sources,
  selected,
  connecting,
  onSelect,
}: {
  sources: SourceOption[];
  selected: ProjectSource;
  connecting: boolean;
  onSelect(id: ProjectSource): void;
}) {
  // "Local" always leads; the rest keep the order the shell built them in (distros, then
  // remotes). A stable sort on a single boolean key keeps that relative order intact.
  const ordered = [...sources].sort((a, b) => Number(b.id === "local") - Number(a.id === "local"));

  return (
    <div className="source-switcher mt-1 rounded-control border border-line overflow-hidden bg-surface">
      <p className="eyebrow source-switcher-eyebrow m-0 px-3.5 py-2.5 border-b border-line bg-raised text-2xs font-semibold uppercase tracking-wide text-ink-faint">
        SOURCE
      </p>
      {ordered.map((source) => {
        const isSelected = source.id === selected;
        const isConnecting = connecting && isSelected;
        return (
          <button
            type="button"
            key={source.id}
            aria-pressed={isSelected}
            disabled={connecting}
            className={cn(
              "source-row w-full flex items-center gap-2.5 px-3.5 py-2.5 border-t border-line bg-transparent text-ink text-left text-base hover:bg-raised disabled:cursor-default [&:first-of-type]:border-t-0",
              isSelected && "is-selected bg-accent-soft",
            )}
            onClick={() => onSelect(source.id)}
          >
            <span className="source-icon flex-none inline-flex text-ink-faint" aria-hidden="true">
              <Icon icon={source.id === "local" ? Monitor : Server} className="size-3.5" />
            </span>
            <span className="source-label min-w-0 truncate">{source.label}</span>
            {isConnecting ? (
              <span className="source-connecting ml-auto flex-none inline-flex items-center gap-1.5 text-sm text-ink-soft">
                <Spinner className="size-3.5" />
                connecting…
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
