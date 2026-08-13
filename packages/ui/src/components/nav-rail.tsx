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
      <div className="nav-rail-history">
        <button
          type="button"
          className="nav-rail-button"
          aria-label="Back"
          disabled={!canBack}
          onClick={onBack}
        >
          <span className="nav-rail-glyph" aria-hidden="true">
            ←
          </span>
          <span>Back</span>
        </button>
        <button
          type="button"
          className="nav-rail-button"
          aria-label="Forward"
          disabled={!canForward}
          onClick={onForward}
        >
          <span className="nav-rail-glyph" aria-hidden="true">
            →
          </span>
          <span>Forward</span>
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
