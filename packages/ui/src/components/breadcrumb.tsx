import type { CrumbSegment } from "../nav/history";
import { HomeIcon } from "./icons";

export function Breadcrumb({
  crumb,
  onAscend,
}: {
  crumb: CrumbSegment[];
  onAscend: (index: number) => void;
}) {
  return (
    <nav
      className="nav-breadcrumb flex min-w-0 items-center gap-1 text-sm text-ink-faint"
      aria-label="Breadcrumb"
    >
      {crumb.map((segment, position) => {
        const current = position === crumb.length - 1;
        return (
          <span
            className="nav-breadcrumb-item flex min-w-0 items-center gap-1"
            key={`${segment.kind}:${segment.index}`}
          >
            {position > 0 ? (
              <span className="nav-breadcrumb-separator text-ink-faint/70" aria-hidden="true">
                ›
              </span>
            ) : null}
            <button
              type="button"
              className="nav-breadcrumb-segment flex min-w-0 items-center gap-1.5 truncate rounded-chip px-1.5 py-1 font-sans text-sm text-ink-soft enabled:cursor-pointer enabled:hover:bg-raised enabled:hover:text-ink disabled:text-ink"
              aria-current={current ? "page" : undefined}
              disabled={current}
              onClick={current ? undefined : () => onAscend(segment.index)}
            >
              {position === 0 ? (
                <span className="nav-breadcrumb-home flex items-center text-accent">
                  <HomeIcon size={13} />
                </span>
              ) : null}
              <span className="truncate">{segment.label}</span>
            </button>
          </span>
        );
      })}
    </nav>
  );
}
