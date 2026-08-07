import type { DispositionBatch } from "../canvas/authoring";
import {
  type DestinationMode,
  type DestinationVariant,
  destinationVariant,
  stagedItems,
} from "../canvas/destination";

// ─────────────────────────────────────────────────────────────────────────────
// The DESTINATION FRAME (issue #64) — the persistent north the review stages
// toward. Always-present chrome, top-right, rendered from review-open even with
// nothing staged (an empty forming paper). It names WHAT the user is staging
// toward (the variant by mode) and fills visibly as dispositions are made
// (dispose == staged). Clicking through opens the publish sheet (#22).
//
// The staged DATA is identical across modes; only the framing changes. This
// component is presentational: the staged set and the mode are owned by the host.
// ─────────────────────────────────────────────────────────────────────────────

const MODES: DestinationMode[] = ["own-branch", "other-pr"];

export function DestinationFrame({
  batch,
  mode,
  onSelectMode,
  onOpenPublish,
}: {
  batch: DispositionBatch;
  mode: DestinationMode;
  /** Flip the framing (own-branch handoff bundle / other-PR review). Same staged data. */
  onSelectMode?: (mode: DestinationMode) => void;
  /** Open the publish sheet (#22) — review & sign the staged set. */
  onOpenPublish?: () => void;
}) {
  const variant: DestinationVariant = destinationVariant(mode);
  const items = stagedItems(batch);
  const empty = items.length === 0;

  return (
    <aside
      className="destination-frame"
      data-mode={mode}
      data-staged-count={items.length}
      aria-label={`Destination: ${variant.title}`}
    >
      <header className="destination-head">
        <p className="destination-eyebrow">STAGING TOWARD</p>
        <h2 className="destination-title">{variant.title}</h2>
        <p className="destination-summary">{variant.summary}</p>
      </header>

      {onSelectMode ? (
        <div className="destination-modes" role="tablist" aria-label="Destination variant">
          {MODES.map((candidate) => {
            const framing = destinationVariant(candidate);
            return (
              <button
                type="button"
                role="tab"
                aria-selected={candidate === mode}
                className={candidate === mode ? "is-active" : ""}
                key={candidate}
                onClick={() => onSelectMode(candidate)}
              >
                {framing.title}
              </button>
            );
          })}
        </div>
      ) : null}

      <div className="destination-body">
        <div className="destination-count">
          <strong>{items.length}</strong>
          <span>staged</span>
        </div>
        {empty ? (
          <p className="destination-empty">
            The paper is blank. Dispose something and it stages here toward{" "}
            {variant.signLabel.toLowerCase()}.
          </p>
        ) : (
          <ol className="destination-staged" aria-label="Staged dispositions">
            {items.map((entry) => (
              <li className="destination-staged-item" data-path={entry.path} key={entry.path}>
                <span className="destination-staged-type" data-type={entry.type}>
                  {entry.type[0]?.toUpperCase()}
                </span>
                <span className="destination-staged-path">{entry.path}</span>
              </li>
            ))}
          </ol>
        )}
      </div>

      <footer className="destination-foot">
        <button
          type="button"
          className="destination-open-publish"
          disabled={empty}
          onClick={() => onOpenPublish?.()}
        >
          Review &amp; {variant.signLabel.toLowerCase()}
        </button>
      </footer>
    </aside>
  );
}
