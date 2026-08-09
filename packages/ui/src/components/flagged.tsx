import type { FlaggedIndex, FlaggedRow } from "../canvas/flagged";

// The Flagged lens (issue #138): one INDEX over everything the automated review
// layer raised. Each row carries a severity chip, the models' agreement state
// (both concur with vote counts, OR they disagree with each model's answer shown
// side by side and labelled), and an anchor the row jumps to. The lens points at
// the mark at its anchor — it does not own the mark. The disagreement flare lives
// HERE, in the index, never as a chat interruption or a synthesis block.
//
// Two "nothing here" states are kept DISTINCT: a review that ran and flagged
// nothing is honestly empty; a runner that failed is a different message. Telling
// the user "all clear" when the truth is "we could not check" is the exact
// conflation this lens refuses.

const SEVERITY_LABEL = { high: "high", medium: "medium", low: "low" } as const;

function Agreement({ row }: { row: FlaggedRow }) {
  if (row.agreement.kind === "concur") {
    return (
      <span className="flag-agreement flag-concur" data-agreement="concur">
        both models concur {row.agreement.agree}/{row.agreement.total}
      </span>
    );
  }
  return (
    <div className="flag-agreement flag-disagree" data-agreement="disagree">
      <span className="flag-disagree-flare">models disagree</span>
      <div className="flag-answers">
        {row.agreement.answers.map((answer) => (
          <div className="flag-answer" key={answer.model}>
            <span className="flag-answer-model">{answer.model}</span>
            <span className="flag-answer-text">{answer.answer}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function FlagRow({
  row,
  onJumpToAnchor,
}: {
  row: FlaggedRow;
  onJumpToAnchor(anchor: string): void;
}) {
  return (
    <li className="flag" data-severity={row.severity}>
      <div className="flag-head">
        <span className={`flag-severity flag-severity-${row.severity}`}>
          {SEVERITY_LABEL[row.severity]}
        </span>
        {/* The lens is an index: the row jumps to the mark at its anchor. */}
        <button
          type="button"
          className="flag-jump"
          data-jump-anchor={row.anchor}
          onClick={() => onJumpToAnchor(row.anchor)}
        >
          <span className="flag-summary">{row.summary}</span>
          <span className="flag-anchor">{row.anchor}</span>
        </button>
      </div>
      <Agreement row={row} />
    </li>
  );
}

export function FlaggedLens({
  index,
  onJumpToAnchor,
}: {
  index: FlaggedIndex;
  onJumpToAnchor(anchor: string): void;
}) {
  // A runner that did not complete — kept LOUDLY distinct from "nothing flagged".
  if (index.state === "failed") {
    return (
      <div className="flagged-canvas">
        <div className="flagged-failed" role="status">
          <p className="flagged-failed-head">Couldn't check</p>
          <p className="flagged-failed-body">
            The automated review runner did not complete, so this is not an all-clear.
          </p>
          <p className="flagged-failed-reason">{index.reason}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flagged-canvas">
      <div className="canvas-toolbar">
        <span className="canvas-coverage">
          {index.total} {index.total === 1 ? "flag" : "flags"}
        </span>
        {index.total > 0 ? (
          <span className="flag-counts">
            <span className="flag-count flag-count-high">{index.counts.high} high</span>
            <span className="flag-count flag-count-medium">{index.counts.medium} medium</span>
            <span className="flag-count flag-count-low">{index.counts.low} low</span>
          </span>
        ) : null}
      </div>
      {index.total === 0 ? (
        <p className="flagged-empty">
          Reviewed. Nothing was flagged — this angle ran clean, it was not skipped.
        </p>
      ) : (
        <ol className="flags">
          {index.rows.map((row) => (
            <FlagRow key={row.findingId} row={row} onJumpToAnchor={onJumpToAnchor} />
          ))}
        </ol>
      )}
    </div>
  );
}
