import type { NoiseCategory } from "@rennet/types";
import { useState } from "react";
import type { NoiseGroupRow, NoiseIndex, NoiseJudgedBy } from "../canvas/noise";

// The Noise lens (issue #34): the low-signal churn a changeset touches, GROUPED
// away from the code that needs eyes. Each group is COLLAPSED under a plain-speech
// one-line summary and tagged with HOW it was judged — a deterministic mechanical
// RULE chip, or an LLM NOISE-JOB chip, so a reviewer can tell mechanical certainty
// from a model's call. Nothing is silently hidden: the totality floor is a surface
// here. Every group is INSPECTABLE (expand to see the churn it collects) and
// PULL-BACK-ABLE ("not noise?" reopens it into the main review, reversibly). A line
// that broke its group's pattern EJECTS into normal review, shown loudly above.
//
// Two "nothing here" states are kept DISTINCT: a review that ran and grouped
// nothing is honestly empty; a runner that failed is a different message. Telling
// the user "all clear" when the truth is "we could not check" is the exact
// conflation this lens refuses.

const CATEGORY_LABEL: Record<NoiseCategory, string> = {
  formatting: "Formatting",
  lockfile: "Lockfile",
  "import-order": "Import order",
  generated: "Generated",
  "fixture-rename": "Fixture rename",
  "comment-typo": "Comment typo",
  other: "Other",
};

/** The judged-by chip: a mechanical RULE (certainty) vs the LLM NOISE JOB (a call). */
function JudgeChip({ judgedBy }: { judgedBy: NoiseJudgedBy }) {
  if (judgedBy.kind === "rule") {
    return (
      <span
        className="noise-judge noise-judge-rule"
        data-judge="rule"
        title="settled by a deterministic mechanical rule"
      >
        <span className="noise-judge-kind">rule</span>
        <span className="noise-judge-detail">{judgedBy.rule}</span>
      </span>
    );
  }
  return (
    <span
      className="noise-judge noise-judge-job"
      data-judge="noise-job"
      title="judged by the LLM noise job"
    >
      <span className="noise-judge-kind">noise job</span>
      <span className="noise-judge-detail">{judgedBy.model}</span>
    </span>
  );
}

function NoiseGroupCard({
  group,
  expanded,
  onToggleExpand,
  onPullBack,
  onJumpToAnchor,
}: {
  group: NoiseGroupRow;
  expanded: boolean;
  onToggleExpand(): void;
  onPullBack(): void;
  onJumpToAnchor(anchor: string): void;
}) {
  return (
    <li className="noise-group" data-category={group.category} data-pulled="false">
      <div className="noise-group-head">
        <button
          type="button"
          className="noise-group-toggle"
          aria-expanded={expanded}
          onClick={onToggleExpand}
        >
          <span className="noise-group-category">{CATEGORY_LABEL[group.category]}</span>
          <span className="noise-group-summary">{group.summary}</span>
          <span className="noise-group-count">
            {group.suppressedCount} {group.suppressedCount === 1 ? "change" : "changes"}
          </span>
        </button>
        <JudgeChip judgedBy={group.judgedBy} />
        {/* Pull-back: reject the grouping, move this group into the main review. */}
        <button
          type="button"
          className="noise-pullback"
          data-pullback={group.groupId}
          onClick={onPullBack}
          title="Reject the grouping and pull this back into the review"
        >
          not noise?
        </button>
      </div>
      {/* Inspectable: the churn is collapsed, never hidden — expand to see every line. */}
      {expanded ? (
        <ul className="noise-items">
          {group.items.map((item) => (
            <li className="noise-item" key={item.anchor}>
              <button
                type="button"
                className="noise-item-jump"
                data-jump-anchor={item.anchor}
                onClick={() => onJumpToAnchor(item.anchor)}
              >
                <span className="noise-item-detail">{item.detail}</span>
                <span className="noise-item-anchor">{item.anchor}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export function NoiseLens({
  index,
  onJumpToAnchor,
}: {
  index: NoiseIndex;
  onJumpToAnchor(anchor: string): void;
}) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  // Pull-back is reversible: a pulled-back group leaves the noise fold and moves to
  // the "pulled into review" section, from which it can be re-grouped as noise.
  const [pulledBack, setPulledBack] = useState<ReadonlySet<string>>(new Set());

  // A runner that did not complete — kept LOUDLY distinct from "nothing grouped".
  if (index.state === "failed") {
    return (
      <div className="noise-canvas">
        <div className="noise-failed" role="status">
          <p className="noise-failed-head">Couldn't check</p>
          <p className="noise-failed-body">
            The noise-classification runner did not complete, so this is not an all-clear — nothing
            was grouped away because nothing ran, not because there was no noise.
          </p>
          <p className="noise-failed-reason">{index.reason}</p>
        </div>
      </div>
    );
  }

  const toggleExpand = (groupId: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  const pullBack = (groupId: string) => setPulledBack((current) => new Set(current).add(groupId));
  const regroup = (groupId: string) =>
    setPulledBack((current) => {
      const next = new Set(current);
      next.delete(groupId);
      return next;
    });

  const activeGroups = index.groups.filter((group) => !pulledBack.has(group.groupId));
  const pulledGroups = index.groups.filter((group) => pulledBack.has(group.groupId));

  return (
    <div className="noise-canvas">
      <div className="canvas-toolbar">
        <span className="canvas-coverage">
          {index.suppressedTotal} low-signal {index.suppressedTotal === 1 ? "change" : "changes"}{" "}
          grouped away
        </span>
        {index.groupCount > 0 ? (
          <span className="noise-counts">
            <span className="noise-count noise-count-rule">{index.counts.rule} by rule</span>
            <span className="noise-count noise-count-job">
              {index.counts.noiseJob} by noise job
            </span>
          </span>
        ) : null}
      </div>

      {/* The totality floor made loud: a line that broke its group's pattern is never
          suppressed — it ejects into normal review, surfaced here above the fold. */}
      {index.ejected.length > 0 ? (
        <div className="noise-ejected" role="status">
          <p className="noise-ejected-head">
            {index.ejected.length} {index.ejected.length === 1 ? "line" : "lines"} broke a group's
            pattern — pulled into the review, not grouped away
          </p>
          <ul className="noise-ejections">
            {index.ejected.map((ejection) => (
              <li className="noise-ejection" key={ejection.anchor}>
                <button
                  type="button"
                  className="noise-ejection-jump"
                  data-jump-anchor={ejection.anchor}
                  onClick={() => onJumpToAnchor(ejection.anchor)}
                >
                  <span className="noise-ejection-detail">{ejection.detail}</span>
                  <span className="noise-ejection-anchor">{ejection.anchor}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {index.groupCount === 0 ? (
        <p className="noise-empty">
          Reviewed. Nothing was grouped as noise — this angle ran clean, it was not skipped.
        </p>
      ) : (
        <ol className="noise-groups">
          {activeGroups.map((group) => (
            <NoiseGroupCard
              key={group.groupId}
              group={group}
              expanded={expanded.has(group.groupId)}
              onToggleExpand={() => toggleExpand(group.groupId)}
              onPullBack={() => pullBack(group.groupId)}
              onJumpToAnchor={onJumpToAnchor}
            />
          ))}
        </ol>
      )}

      {/* Pulled back into the review — reversible: re-group any of these as noise. */}
      {pulledGroups.length > 0 ? (
        <div className="noise-pulled" role="status">
          <p className="noise-pulled-head">
            {pulledGroups.length} {pulledGroups.length === 1 ? "group" : "groups"} pulled into the
            review
          </p>
          <ul className="noise-pulled-list">
            {pulledGroups.map((group) => (
              <li className="noise-pulled-group" data-pulled="true" key={group.groupId}>
                <span className="noise-pulled-category">{CATEGORY_LABEL[group.category]}</span>
                <span className="noise-pulled-summary">{group.summary}</span>
                <button
                  type="button"
                  className="noise-regroup"
                  data-regroup={group.groupId}
                  onClick={() => regroup(group.groupId)}
                  title="Re-group this as noise"
                >
                  re-group as noise
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
