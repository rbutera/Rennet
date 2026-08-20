import type { ProgressArtifactRef } from "@rennet/protocol";
import { CheckIcon, GitBranchIcon, TriangleIcon } from "./icons";
import type { RepoBlockView } from "./progress-feed-fold";
import { summaryLine } from "./progress-feed-fold";

/**
 * The ONE shared narration-feed organ (issue #71): a spinner-over-feed rendering of
 * the per-repo blocks a run produces. Extracted verbatim from `ProjectProcessing`'s
 * inline `.processing-repos` + `RepoBlock`. The processing screen is wired now;
 * context refresh and capture/review are tracked as later consumers by issue #71.
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
    <div className="processing-repos flex flex-col gap-2.5">
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
      className="processing-repo-name is-anchor cursor-pointer border-0 bg-transparent p-0 text-left font-semibold text-inherit hover:underline"
      onClick={() => onAnchor?.(anchor)}
    >
      {block.repo}
    </button>
  ) : (
    <span className="processing-repo-name font-semibold">{block.repo}</span>
  );
  return (
    <div
      className="processing-repo group rounded-surface border border-line px-3.5 py-3 data-[state=error]:border-danger data-[state=processing]:border-accent-line data-[state=error]:bg-danger-soft"
      data-state={block.state}
    >
      <p className="processing-repo-head m-0 flex items-center gap-2 text-base text-ink">
        <span
          className="processing-repo-icon inline-flex text-ink-soft group-data-[state=error]:text-danger"
          aria-hidden="true"
        >
          {block.state === "error" ? <TriangleIcon size={13} /> : <GitBranchIcon size={13} />}
        </span>
        {name}
        {block.state === "done" && block.summary ? (
          <span className="processing-repo-counts ml-auto text-sm text-ink-faint">
            {summaryLine(block.summary)}
          </span>
        ) : null}
        {block.state === "error" ? (
          <span className="processing-repo-counts is-error ml-auto text-sm text-ink">
            {block.error}
          </span>
        ) : null}
      </p>
      {block.trail.length > 0 ? (
        <ol className="processing-trail m-0 mt-2.5 flex list-none flex-col gap-1.5 p-0">
          {block.trail.map((entry, index) => {
            const last = index === block.trail.length - 1;
            const active = block.state === "processing" && last;
            return (
              <li
                key={entry.stage}
                className={`processing-step flex items-center gap-2 text-base ${active ? "is-active text-ink" : "text-ink-faint"}`}
              >
                <span
                  className="processing-step-mark inline-flex w-3.5 items-center justify-center text-accent"
                  aria-hidden="true"
                >
                  {active ? (
                    <span className="processing-dot h-[7px] w-[7px] animate-pulse rounded-full bg-accent" />
                  ) : (
                    <CheckIcon size={12} />
                  )}
                </span>
                <span className="processing-step-note flex-initial">{entry.note}</span>
                {entry.detail ? (
                  <span className="processing-step-detail ml-auto font-mono text-sm font-medium text-ink-faint">
                    {entry.detail}
                  </span>
                ) : null}
              </li>
            );
          })}
        </ol>
      ) : null}
    </div>
  );
}
