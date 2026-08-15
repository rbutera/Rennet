import type { CiFailure, CiSignal, DualReviewNote } from "@rennet/types";
import type { ReactNode } from "react";
import type { FlaggedIndex, FlaggedRow } from "../canvas/flagged";

/**
 * The dual-model affordance (issue #191). Dual-model review is the DEFAULT (Rai's
 * mandate, 2026-08-11 — the tool's whole job is to spend tokens and run models, so
 * a single-seat default was wrong): every review starts dual, running both provider
 * seats and reconciling them into per-finding agreement/disagreement. This control
 * is the explicit OPT-DOWN — a two-way toggle that lets a human drop to the
 * single-Claude "quick" review, never a one-way "opt into deep". `active` is true
 * while dual is on (the default); `onToggle` flips between dual and quick, re-running
 * the flagged review with the new mode.
 */
export interface DeepReviewControl {
  active: boolean;
  onToggle(): void;
}

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

/**
 * How the review was produced (issue #41/#191): who ran, and the HONEST single-seat
 * degradation marker. It NEVER shows a merged verdict — per-finding disagreement
 * lives in each row's `Agreement`. Absent `dual` ⇒ a single-seat quick review, and
 * nothing renders.
 */
function DualBadge({ dual }: { dual?: DualReviewNote }) {
  if (!dual) return null;
  if (dual.secondSeatUnavailable) {
    return (
      <span
        className="flag-dual flag-dual-degraded"
        data-dual="degraded"
        title={dual.secondSeatUnavailable}
      >
        single provider — no second opinion
      </span>
    );
  }
  return (
    <span className="flag-dual flag-dual-full" data-dual="full">
      reconciled by {dual.seats.join(" + ")}
    </span>
  );
}

function CiFailureLine({ failure }: { failure: CiFailure }) {
  const label =
    failure.verdict === "environmental"
      ? "environmental (infra)"
      : "Rennet could not attribute this — check it yourself";
  return (
    <li className={`ci-signal-failure ci-signal-${failure.verdict}`}>
      <span className="ci-signal-failure-label">{label}</span>
      <span className="ci-signal-check-name">{failure.checkName}</span>
      <span className="ci-signal-evidence">{failure.evidence}</span>
      {failure.detailsUrl ? (
        <a className="ci-signal-details" href={failure.detailsUrl}>
          check details
        </a>
      ) : null}
    </li>
  );
}

export function CiSignalPanel({ signal }: { signal?: CiSignal }) {
  if (!signal) return null;

  let content: ReactNode;
  if (signal.status === "unavailable") {
    content = <p>CI status unavailable — {signal.reason}</p>;
  } else if (signal.status === "no-checks") {
    content = <p>no CI checks reported for the reviewed head</p>;
  } else {
    const changeCaused = signal.failures.filter(
      (failure) => failure.verdict === "change-caused",
    ).length;
    const panelFailures = signal.failures.filter((failure) => failure.verdict !== "change-caused");
    content = (
      <>
        {signal.overall === "passing" ? (
          <p>CI: all checks passing on the reviewed head</p>
        ) : signal.overall === "pending" ? (
          <p>CI checks are still pending on the reviewed head</p>
        ) : null}
        {changeCaused > 0 ? (
          <p>
            {`${changeCaused} change-caused CI ${
              changeCaused === 1 ? "failure appears" : "failures appear"
            } in the flagged findings below`}
          </p>
        ) : null}
        {panelFailures.length > 0 ? (
          <ul className="ci-signal-failures">
            {panelFailures.map((failure) => (
              <CiFailureLine key={failure.checkName} failure={failure} />
            ))}
          </ul>
        ) : null}
        {signal.incomplete ? (
          <p className="ci-signal-incomplete">
            CI results may be incomplete because GitHub returned partial results
          </p>
        ) : null}
      </>
    );
  }

  return (
    <details className="ci-signal-panel" open>
      <summary>CI on reviewed head</summary>
      <div className="ci-signal-body">{content}</div>
    </details>
  );
}

/**
 * The reproduce-or-refute verification chip (issue #179): the evidence the
 * verification pass produced for a finding. A `reproduced` finding shows a confirmed
 * "we dug into it" chip; an `inconclusive` one shows an honest "couldn't verify"
 * caveat — never silently dropped, because a dead or uncertain verifier must never
 * read as an all-clear. A `refuted` finding never reaches a row (core dropped it),
 * so it renders nothing here. The verdict LABEL is Rennet chrome (terse, one word or
 * two, proportional type); the `evidence` is the model's own account and breathes
 * (Design Doctrine §4, the authorship seam).
 */
function Verification({ verification }: { verification: FlaggedRow["verification"] }) {
  if (!verification || verification.verdict === "refuted") return null;
  const reproduced = verification.verdict === "reproduced";
  return (
    <div
      className={`flag-verification flag-verification-${verification.verdict}`}
      data-verdict={verification.verdict}
    >
      <span className="flag-verification-label">
        {reproduced ? "reproduced" : "couldn't verify"}
      </span>
      <span className="flag-verification-evidence">{verification.evidence}</span>
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
    <li className="flag" data-severity={row.severity} data-finding-id={row.findingId}>
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
      <Verification verification={row.verification} />
    </li>
  );
}

export function FlaggedLens({
  index,
  onJumpToAnchor,
  deepReview,
}: {
  index: FlaggedIndex;
  onJumpToAnchor(anchor: string): void;
  /**
   * The dual-model control (issue #191). Absent ⇒ no affordance is shown (a host
   * with no bridge, or a fixture). Present ⇒ the toolbar offers a toggle that opts
   * DOWN from the default dual-model reconcile to a single-Claude quick review (and
   * back). Dual is the default; this is the opt-down, not an opt-in.
   */
  deepReview?: DeepReviewControl;
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
        <CiSignalPanel signal={index.ciSignal} />
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
        <DualBadge dual={index.dual} />
        {deepReview ? (
          <button
            type="button"
            className="flag-deep-review"
            data-active={deepReview.active}
            aria-pressed={deepReview.active}
            onClick={deepReview.onToggle}
          >
            {deepReview.active ? "Dual review · switch to quick" : "Quick review · switch to dual"}
          </button>
        ) : null}
      </div>
      <CiSignalPanel signal={index.ciSignal} />
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
