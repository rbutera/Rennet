export function NavRail({
  canBack,
  canForward,
  onBack,
  onForward,
  onHome,
  onProjects,
}: {
  canBack: boolean;
  canForward: boolean;
  onBack: () => void;
  onForward: () => void;
  onHome: () => void;
  onProjects: () => void;
}) {
  return (
    <nav className="nav-rail" aria-label="Navigation">
      {/* Back/forward read as one paired control, so they sit SIDE BY SIDE
          (icon-only, tooltip carries the word) rather than stacked like the
          destination buttons below. */}
      <div className="nav-rail-history">
        <button
          type="button"
          className="nav-rail-button nav-rail-button-paired"
          aria-label="Back"
          title="Back"
          disabled={!canBack}
          onClick={onBack}
        >
          <span className="nav-rail-glyph" aria-hidden="true">
            ←
          </span>
        </button>
        <button
          type="button"
          className="nav-rail-button nav-rail-button-paired"
          aria-label="Forward"
          title="Forward"
          disabled={!canForward}
          onClick={onForward}
        >
          <span className="nav-rail-glyph" aria-hidden="true">
            →
          </span>
        </button>
      </div>

      <div className="nav-rail-destinations">
        <button type="button" className="nav-rail-button" onClick={onHome}>
          <span className="nav-rail-glyph" aria-hidden="true">
            ⌂
          </span>
          <span>Home</span>
        </button>
        <button type="button" className="nav-rail-button" onClick={onProjects}>
          <span className="nav-rail-glyph" aria-hidden="true">
            ◫
          </span>
          <span>Projects</span>
        </button>
      </div>
    </nav>
  );
}
