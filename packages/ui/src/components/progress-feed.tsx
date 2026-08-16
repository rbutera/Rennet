import type { ProgressArtifactRef } from "@rennet/protocol";
import { CheckIcon, GitBranchIcon, TriangleIcon } from "./icons";
import type { RepoBlockView } from "./progress-feed-fold";
import { summaryLine } from "./progress-feed-fold";

/**
 * The ONE shared narration-feed organ (issue #71): a spinner-over-feed rendering of
 * the per-repo blocks a run produces. Extracted verbatim from `ProjectProcessing`'s
 * inline `.processing-repos` + `RepoBlock` so the processing screen, the context-
 * refresh indicator, and the capture/review wait render the SAME component, never a
 * parallel copy of the fold or the trail rendering.
 *
 * Completed stages fold into a compact done-ledger (each trail row a checked line),
 * the in-progress row keeps its live dot, and a soft repo error renders honestly.
 * When a landed block carries an artifact anchor and the consumer supplies
 * `onAnchor`, the block head activates that navigation; with no anchor it is plain
 * text — honestly inert, never a dead link.
 */
export function ProgressFeed({
  blocks,
  onAnchor,
}: {
  blocks: readonly RepoBlockView[];
  /** Navigate to a landed block's artifact. Absent ⇒ blocks are inert text. */
  onAnchor?: (anchor: ProgressArtifactRef) => void;
}) {
  if (blocks.length === 0) return null;
  return (
    <div className="processing-repos">
      {blocks.map((block) => (
        <RepoBlock key={block.repo} block={block} onAnchor={onAnchor} />
      ))}
    </div>
  );
}

/* ── one repo's live block ─────────────────────────────────────────────────── */

function RepoBlock({
  block,
  onAnchor,
}: {
  block: RepoBlockView;
  onAnchor?: (anchor: ProgressArtifactRef) => void;
}) {
  // A landed block is an anchor only when it produced a navigable artifact AND the
  // consumer wired navigation; otherwise the name is plain text (honestly inert).
  const anchor = block.state === "done" && block.anchor && onAnchor ? block.anchor : undefined;
  const name = anchor ? (
    <button
      type="button"
      className="processing-repo-name is-anchor"
      onClick={() => onAnchor?.(anchor)}
    >
      {block.repo}
    </button>
  ) : (
    <span className="processing-repo-name">{block.repo}</span>
  );
  return (
    <div className="processing-repo" data-state={block.state}>
      <p className="processing-repo-head">
        <span className="processing-repo-icon" aria-hidden="true">
          {block.state === "error" ? <TriangleIcon size={13} /> : <GitBranchIcon size={13} />}
        </span>
        {name}
        {block.state === "done" && block.summary ? (
          <span className="processing-repo-counts">{summaryLine(block.summary)}</span>
        ) : null}
        {block.state === "error" ? (
          <span className="processing-repo-counts is-error">{block.error}</span>
        ) : null}
      </p>
      {block.trail.length > 0 ? (
        <ol className="processing-trail">
          {block.trail.map((entry, index) => {
            const last = index === block.trail.length - 1;
            const active = block.state === "processing" && last;
            return (
              <li key={entry.stage} className={`processing-step${active ? " is-active" : ""}`}>
                <span className="processing-step-mark" aria-hidden="true">
                  {active ? <span className="processing-dot" /> : <CheckIcon size={12} />}
                </span>
                <span className="processing-step-note">{entry.note}</span>
                {entry.detail ? (
                  <span className="processing-step-detail">{entry.detail}</span>
                ) : null}
              </li>
            );
          })}
        </ol>
      ) : null}
    </div>
  );
}
