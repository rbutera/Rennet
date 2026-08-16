import { type CollationDraft, collationItems } from "../canvas/collation";
import {
  type DestinationMode,
  type DestinationVariant,
  destinationVariant,
} from "../canvas/destination";
import { handoffDispositions } from "../canvas/publish";
import { laneCounts } from "../canvas/staging";
import { ArrowRightIcon, TargetIcon } from "./icons";

// ─────────────────────────────────────────────────────────────────────────────
// The DESTINATION FRAME (issue #64; re-pointed by R40, issue #101) — the
// persistent north the review stages toward. Always-present chrome, top-right,
// rendered from review-open even with nothing collated (an empty forming draft).
// It names WHAT the user is staging toward (the variant by mode) and fills visibly
// as dispositions are made (dispose == staged).
//
// R40 re-point: the frame stops BEING the paper. Clicking through now opens the
// COLLATION DRAFT CANVAS (issue #101) — the editable forming destination — NOT the
// publish sheet. The flow is frame → draft → paper (two surfaces), not frame →
// paper. The empty-state copy "The paper is blank" was wrong (the frame is not the
// paper) and is now "The draft is empty."
//
// The collated DATA is identical across modes; only the framing changes. This
// component is presentational: the draft and the mode are owned by the host.
// ─────────────────────────────────────────────────────────────────────────────

const MODES: DestinationMode[] = ["own-branch", "other-pr"];

export function DestinationFrame({
  draft,
  mode,
  onSelectMode,
  onOpenDraft,
  onHandoff,
}: {
  draft: CollationDraft;
  mode: DestinationMode;
  /** Flip the framing (own-branch handoff bundle / other-PR review). Same data. */
  onSelectMode?: (mode: DestinationMode) => void;
  /** Open the collation draft canvas (#101) — collate, edit, then sign. */
  onOpenDraft?: () => void;
  /**
   * Open the stage-6 handoff paper (#72) — compose the bundle, preview it, run it.
   * Only offered on own-branch with at least one actionable ask; absent ⇒ no button.
   */
  onHandoff?: () => void;
}) {
  const variant: DestinationVariant = destinationVariant(mode);
  const items = collationItems(draft);
  const empty = items.length === 0;
  // The handoff path is own-branch only, and only when there is something a coding
  // agent can act on (a request-change or comment). No actionable ask ⇒ no button.
  const handoffCount = handoffDispositions(draft).length;
  const canHandoff = onHandoff !== undefined && mode === "own-branch" && handoffCount > 0;
  // The ink/blue split (issue #109): how many dispositions travel to the PR vs stay
  // private on this machine (the wireframe's "N private" pill).
  const lanes = laneCounts(draft);

  return (
    <aside
      className="destination-frame"
      data-mode={mode}
      data-staged-count={items.length}
      data-publish-count={lanes.ink}
      data-private-count={lanes.blue}
      aria-label={`Destination: ${variant.title}`}
    >
      <header className="destination-head">
        <p className="destination-eyebrow">
          <TargetIcon size={11} />
          STAGING TOWARD
        </p>
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
          <span>collated</span>
          {lanes.blue > 0 ? (
            <span className="destination-private-pill" data-private-count={lanes.blue}>
              {lanes.blue} private
            </span>
          ) : null}
        </div>
        {empty ? (
          <p className="destination-empty">
            The draft is empty. Dispose something and it collates here toward{" "}
            {variant.signLabel.toLowerCase()}.
          </p>
        ) : (
          <ol className="destination-staged" aria-label="Collated dispositions">
            {draft.map((entry) => (
              <li className="destination-staged-item" data-path={entry.path} key={entry.id}>
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
          className="destination-open-draft"
          disabled={empty}
          onClick={() => onOpenDraft?.()}
        >
          Open the draft
          <ArrowRightIcon size={14} />
        </button>
        {canHandoff ? (
          <button type="button" className="destination-handoff" onClick={() => onHandoff?.()}>
            Hand off to agent
            <ArrowRightIcon size={14} />
          </button>
        ) : null}
      </footer>
    </aside>
  );
}
