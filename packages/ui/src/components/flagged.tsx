import type {
  CiFailure,
  CiSignal,
  DecompositionBlockingReason,
  DecompositionBlockingState,
  DualReviewNote,
  FindingAdjudication,
  UiScreenshot,
  UiVerification,
} from "@rennet/types";
import { type ReactNode, useEffect, useState } from "react";
import type { FlaggedIndex, FlaggedRow } from "../canvas/flagged";

/**
 * Load one verify-ui screenshot's data URL (issue #183). The Flagged lens strip calls
 * this per screenshot; the desktop host wires it to the `review.uiEvidence` command,
 * which reads the PNG from the review's evidence directory. `null` ⇒ the file no
 * longer resolves (moved store, escaping path) — the strip shows a plain
 * missing-evidence note, never a broken image or a crash.
 */
export type UiEvidenceLoader = (path: string) => Promise<string | null>;

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
      <Adjudication adjudication={row.agreement.adjudication} />
    </div>
  );
}

const ADJUDICATION_LABEL = {
  supported: "code supports the flag",
  contradicted: "code contradicts this flag",
  insufficient: "could not adjudicate",
} as const;

/**
 * The cross-harness adjudication chip (issue #41): the third opinion on a contested
 * row, rendered BESIDE both seats' verbatim answers — never replacing them, never
 * hiding the row. When the two seats disagreed, an adjudication turn asked the real
 * code who is right; `supported`/`contradicted` show which side the code backs, and
 * `insufficient` is the honest "could not adjudicate" caveat (a failed/capped/budget-
 * exhausted turn, or a genuine unknown). No verdict value drops the row (Rule Zero) —
 * absent adjudication renders nothing, exactly as before this change. The verdict LABEL
 * is Rennet chrome; the `evidence` is the adjudicator's own account and breathes, and
 * `adjudicatedBy` names the seat so the reader sees whose opinion this is.
 */
function Adjudication({ adjudication }: { adjudication?: FindingAdjudication }) {
  if (!adjudication) return null;
  return (
    <div
      className={`flag-adjudication flag-adjudication-${adjudication.verdict}`}
      data-adjudication={adjudication.verdict}
    >
      <span className="flag-adjudication-label">{ADJUDICATION_LABEL[adjudication.verdict]}</span>
      <span className="flag-adjudication-evidence">{adjudication.evidence}</span>
      <span className="flag-adjudication-seat">adjudicated by {adjudication.adjudicatedBy}</span>
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
      : failure.verdict === "change-caused"
        ? "change-caused CI failure (no offered hunk to place it on)"
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
    const placedChangeCaused = signal.failures.filter(
      (failure) => failure.verdict === "change-caused" && failure.findingId !== undefined,
    ).length;
    const panelFailures = signal.failures.filter(
      (failure) => failure.verdict !== "change-caused" || failure.findingId === undefined,
    );
    content = (
      <>
        {signal.incomplete ? (
          <p className="ci-signal-incomplete">
            CI results are incomplete — omitted checks may still be failing
          </p>
        ) : signal.overall === "passing" ? (
          <p>CI: all checks passing on the reviewed head</p>
        ) : signal.overall === "pending" ? (
          <p>CI checks are pending or have no passing/failing result on the reviewed head</p>
        ) : null}
        {placedChangeCaused > 0 ? (
          <p>
            {`${placedChangeCaused} change-caused CI ${
              placedChangeCaused === 1 ? "failure appears" : "failures appear"
            } in the flagged findings below`}
          </p>
        ) : null}
        {panelFailures.length > 0 ? (
          <ul className="ci-signal-failures">
            {panelFailures.map((failure) => (
              <CiFailureLine key={failure.checkId} failure={failure} />
            ))}
          </ul>
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

/**
 * One verify-ui screenshot thumbnail (issue #183). The bytes are read ON DEMAND via
 * the injected loader (the `review.uiEvidence` command), never inlined into the review
 * snapshot. While loading, the label stands in; a `null` load (a moved store, a file
 * that no longer resolves) degrades to a plain missing-evidence note — never a broken
 * image, never a crash (the spec's honest-degradation requirement).
 */
function UiEvidenceThumb({ screenshot, load }: { screenshot: UiScreenshot; load: UiEvidenceLoader }) {
  const [dataUrl, setDataUrl] = useState<string | null | "loading">("loading");
  useEffect(() => {
    let alive = true;
    load(screenshot.path).then(
      (url) => {
        if (alive) setDataUrl(url);
      },
      () => {
        if (alive) setDataUrl(null);
      },
    );
    return () => {
      alive = false;
    };
  }, [load, screenshot.path]);
  if (dataUrl === "loading") {
    return <span className="ui-evidence-loading">{screenshot.label}</span>;
  }
  if (dataUrl === null) {
    return (
      <span className="ui-evidence-missing" role="note">
        {screenshot.label}: screenshot unavailable
      </span>
    );
  }
  return (
    <figure className="ui-evidence-shot">
      <img src={dataUrl} alt={screenshot.label} />
      <figcaption>{screenshot.label}</figcaption>
    </figure>
  );
}

/**
 * The verify-ui strip (issue #183): the evidence the mount-and-screenshot pass
 * produced. When it `ran`, the strip shows how it mounted (mounted vs. a labelled
 * static review), the observation count (the observations themselves are ordinary
 * findings in the list above), and the captured screenshots inline. When it was
 * `unavailable`, the strip shows the ONE honest reason — could-not-check, NEVER an
 * all-clear. For `not-ui` (or an absent field) it renders nothing. It never gates any
 * action (Rule Zero); it is render-only honest copy.
 */
function UiVerificationStrip({
  status,
  loadUiEvidence,
}: {
  status: UiVerification | undefined;
  loadUiEvidence?: UiEvidenceLoader;
}) {
  if (!status || status.status === "not-ui") return null;
  if (status.status === "unavailable") {
    return (
      <div className="ui-verification ui-verification-unavailable" role="note" data-status="unavailable">
        <span className="ui-verification-label">verify-ui</span>
        <span className="ui-verification-reason">
          Couldn't check the rendered UI, so this is not an all-clear: {status.reason}
        </span>
      </div>
    );
  }
  return (
    <div className="ui-verification ui-verification-ran" data-status="ran" data-mounted={status.mounted}>
      <div className="ui-verification-head">
        <span className="ui-verification-label">
          {status.mounted ? "verify-ui · mounted" : "verify-ui · static review"}
        </span>
        <span className="ui-verification-count">
          {status.observationCount} {status.observationCount === 1 ? "observation" : "observations"}
        </span>
      </div>
      {status.screenshots.length > 0 && loadUiEvidence ? (
        <div className="ui-verification-shots">
          {status.screenshots.map((screenshot) => (
            <UiEvidenceThumb key={screenshot.path} screenshot={screenshot} load={loadUiEvidence} />
          ))}
        </div>
      ) : null}
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

const BLOCKING_REASON_LABEL: Record<DecompositionBlockingReason, string> = {
  truncated: "Truncated",
  binary: "Binary",
  submodule: "Submodule",
};

/**
 * The blocked-ingestion disclosure (R18, issue #309): render-only honest copy that
 * some captured content was NOT ingested, so an absence of findings over it is not
 * evidence it was reviewed. It NEVER adds a confirmation, acknowledgement, or gate
 * (Rule Zero) — it is a plain list the reader sees, shared verbatim with the
 * PublishSheet's disclosure. Rendered only when `states` is non-empty.
 */
export function BlockedIngestionDisclosure({
  states,
  heading = "Some content was not ingested",
}: {
  states: readonly DecompositionBlockingState[];
  /** The disclosure heading; the PublishSheet reuses this block with "Not fully ingested". */
  heading?: string;
}) {
  if (states.length === 0) return null;
  return (
    <div className="flagged-blocked-ingestion" role="note">
      <p className="flagged-blocked-head">{heading}</p>
      <ul className="flagged-blocked-list">
        {states.map((state) => (
          <li
            // Keyed on reason + path + detail: the detail line is unique per blocker
            // (each names its own file/reason), so no array index is needed and the
            // list is render-only regardless.
            key={`${state.reason}:${state.path ?? "*"}:${state.detail}`}
            className="flagged-blocked-item"
            data-reason={state.reason}
          >
            <span className="flagged-blocked-reason">{BLOCKING_REASON_LABEL[state.reason]}</span>
            <span className="flagged-blocked-detail">{state.detail}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function FlaggedLens({
  index,
  onJumpToAnchor,
  deepReview,
  loadUiEvidence,
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
  /**
   * The verify-ui screenshot loader (issue #183). Absent ⇒ the strip renders its
   * status and observation count but no thumbnails (a host with no bridge, or a
   * fixture). Present ⇒ each captured screenshot loads on demand via the
   * `review.uiEvidence` command the host wires here.
   */
  loadUiEvidence?: UiEvidenceLoader;
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
        <BlockedIngestionDisclosure states={index.blockingStates ?? []} />
        <CiSignalPanel signal={index.ciSignal} />
      </div>
    );
  }

  // The incomplete-ingestion blockers carried through the fold (#309). Empty ⇒ the
  // pre-#309 honest all-clear renders unchanged.
  const blockingStates = index.blockingStates ?? [];

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
      <UiVerificationStrip status={index.uiVerification} loadUiEvidence={loadUiEvidence} />
      {index.total === 0 ? (
        blockingStates.length > 0 ? (
          // Blocked ingestion makes the unconditional "ran clean" copy a lie: nothing
          // was flagged only IN WHAT COULD BE READ. Qualified copy + the disclosure
          // replace it (R18/#309). This is honest copy, not a gate.
          <p className="flagged-empty flagged-empty-qualified">
            Nothing was flagged in what could be read — but some content was not ingested, so this
            is not a full all-clear.
          </p>
        ) : (
          <p className="flagged-empty">
            Reviewed. Nothing was flagged — this angle ran clean, it was not skipped.
          </p>
        )
      ) : (
        <ol className="flags">
          {index.rows.map((row) => (
            <FlagRow key={row.findingId} row={row} onJumpToAnchor={onJumpToAnchor} />
          ))}
        </ol>
      )}
      {/* An absence of findings over un-ingested content is not evidence it was
          reviewed, so the disclosure renders beside findings too (#309). */}
      <BlockedIngestionDisclosure states={blockingStates} />
    </div>
  );
}
