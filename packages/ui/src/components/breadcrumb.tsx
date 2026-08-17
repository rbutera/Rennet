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
    <nav className="nav-breadcrumb" aria-label="Breadcrumb">
      {crumb.map((segment, position) => {
        const current = position === crumb.length - 1;
        return (
          <span className="nav-breadcrumb-item" key={`${segment.kind}:${segment.index}`}>
            {position > 0 ? (
              <span className="nav-breadcrumb-separator" aria-hidden="true">
                ›
              </span>
            ) : null}
            <button
              type="button"
              className="nav-breadcrumb-segment"
              aria-current={current ? "page" : undefined}
              disabled={current}
              onClick={current ? undefined : () => onAscend(segment.index)}
            >
              {position === 0 ? (
                <span className="nav-breadcrumb-home">
                  <HomeIcon size={13} />
                </span>
              ) : null}
              <span>{segment.label}</span>
            </button>
          </span>
        );
      })}
    </nav>
  );
}
