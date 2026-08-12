import type {
  AnalysisCohort,
  AnalysisElement,
  Canvas,
  DecisionEvidence,
  DecisionsRunStatus,
  DispositionType,
} from "@rennet/types";
import {
  type ApprovalScope,
  blastReasonsByChunk,
  canvasCoverage,
  paintedChunkIds,
} from "../canvas/logic";
import { DispositionBar } from "./disposition";
import { ChevronIcon } from "./icons";

// The decisions canvas: cohorts collapsed by default with HONEST counts, uncapped
// and untruncated. Expand/collapse is navigation only. Approve works at any
// granularity — the whole roll-up, a cohort, or a single decision — and every one
// is a single act (the fan-out to per-anchor L2 happens in the handler).
//
// Each decision shows the calls the implementer made (issue #137): its evidence
// chips (the spec line, PR-body passage, or hunk it was drawn from), a
// reconstructed why (marked as reconstructed — a starting read, never a claim of
// fact), and the alternatives not taken where discernible. Grouping stays the
// projector's chunk grouping (the cohort title IS the theme, e.g. "Storage and
// state"). There is deliberately NO evidenced/mechanical/contestable triage
// bucket: judging a decision is the reviewer's job, not a pre-chewed verdict's.

const EVIDENCE_KIND_LABEL: Record<DecisionEvidence["kind"], string> = {
  spec: "spec",
  "pr-body": "PR body",
  hunk: "hunk",
};

/**
 * The rich detail under one decision (issue #137): evidence chips, a reconstructed
 * why, and the alternatives not taken. Pure — reads only the element's carried
 * `decision` payload. A decision with no `why` renders on its evidence alone
 * rather than inventing a rationale.
 */
function DecisionDetailView({ element }: { element: AnalysisElement }) {
  const detail = element.decision;
  if (!detail) return null;
  const hasEvidence = detail.evidence.length > 0;
  const hasAlternatives = detail.alternatives.length > 0;
  return (
    <div className="decision-detail">
      {hasEvidence ? (
        <ul className="decision-evidence" aria-label="Evidence this decision was drawn from">
          {detail.evidence.map((chip) => (
            <li
              className={`evidence-chip evidence-${chip.kind}`}
              key={`${chip.kind}:${chip.label}:${chip.detail}`}
            >
              <span className="evidence-kind">{EVIDENCE_KIND_LABEL[chip.kind]}</span>
              <span className="evidence-label">{chip.label}</span>
              <span className="evidence-detail">{chip.detail}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {detail.why ? (
        <p className="decision-why">
          {/* The marker is load-bearing: an inferred rationale is never presented
              as a stated fact. */}
          <span className="decision-why-tag">why · reconstructed</span>
          <span className="decision-why-text">{detail.why.text}</span>
        </p>
      ) : (
        <p className="decision-why decision-why-none">
          <span className="decision-why-tag">why · none discerned</span>
        </p>
      )}
      {hasAlternatives ? (
        <div className="decision-alternatives">
          <span className="decision-alternatives-tag">alternatives not taken</span>
          <ul className="decision-alternatives-list">
            {detail.alternatives.map((alt) => (
              <li key={alt}>{alt}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function Cohort({
  cohort,
  elements,
  expanded,
  painted,
  blastReason,
  onToggle,
  onApproveScope,
  onSelectElement,
}: {
  cohort: AnalysisCohort;
  elements: AnalysisElement[];
  expanded: boolean;
  painted: boolean;
  blastReason?: string;
  onToggle(cohortKey: string): void;
  onApproveScope(scope: ApprovalScope, type: DispositionType): void;
  onSelectElement(elementKey: string): void;
}) {
  return (
    <section className={`cohort ${painted ? "is-blast" : ""}`}>
      <header className="cohort-head">
        <button
          type="button"
          className="cohort-toggle"
          aria-expanded={expanded}
          onClick={() => onToggle(cohort.cohortKey)}
        >
          <span className={`cohort-chevron ${expanded ? "is-open" : ""}`} aria-hidden="true">
            <ChevronIcon size={13} />
          </span>
          <span className="cohort-title">{cohort.title}</span>
          {/* Honest count: the true number of decisions, collapsed or not. */}
          <span className="cohort-count">{cohort.elementKeys.length} decisions</span>
          {painted ? (
            <span className="cohort-blast" title={blastReason ?? "In the blast radius"}>
              blast
            </span>
          ) : null}
        </button>
        {painted && blastReason ? <p className="cohort-blast-reason">{blastReason}</p> : null}
        <DispositionBar
          scopeLabel={`cohort ${cohort.title}`}
          compact
          onDisposition={(type) =>
            onApproveScope({ kind: "cohort", cohortKey: cohort.cohortKey }, type)
          }
        />
      </header>
      {expanded ? (
        <ol className="cohort-elements">
          {elements.map((element) => (
            <li className="decision" key={element.elementKey}>
              <div className="decision-head">
                <button
                  type="button"
                  className="decision-select"
                  onClick={() => onSelectElement(element.elementKey)}
                >
                  {element.title}
                </button>
                <DispositionBar
                  scopeLabel={`decision ${element.title}`}
                  compact
                  onDisposition={(type) =>
                    onApproveScope({ kind: "anchor", elementKey: element.elementKey }, type)
                  }
                />
              </div>
              {/* The evidence chips + reconstructed why the decision was drawn from. */}
              <DecisionDetailView element={element} />
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  );
}

export function DecisionsCanvas({
  canvas,
  overlayOn,
  expandedCohorts,
  onToggleCohort,
  onApproveScope,
  onSelectElement,
  runStatus = { status: "ok" },
}: {
  canvas: Canvas;
  /**
   * The blast-radius overlay toggle (issue #35). Amber paint FOLLOWS the toggle,
   * exactly like the not-assessed chips: off ⇒ no amber, so the invariant "if you can
   * see amber, you can see what was not assessed" holds structurally (both are gated
   * on the same toggle). Absent ⇒ off (a host/test that never engages the overlay).
   */
  overlayOn?: boolean;
  expandedCohorts: Record<string, boolean>;
  onToggleCohort(cohortKey: string): void;
  onApproveScope(scope: ApprovalScope, type: DispositionType): void;
  onSelectElement(elementKey: string): void;
  /**
   * The decision-extraction runner's status (issue #137). A runner that FAILED is
   * kept LOUDLY distinct from a review that ran and discerned nothing — telling
   * the reviewer "no decisions" when the truth is "we could not check" is the
   * exact conflation this refuses. Defaults to `ok`; the live failed signal lands
   * with the live runner (a fixture stands behind it now).
   */
  runStatus?: DecisionsRunStatus;
}) {
  // A runner that did not complete — never conflated with "nothing discerned".
  if (runStatus.status === "failed") {
    return (
      <div className="decisions-canvas">
        <div className="decisions-failed" role="status">
          <p className="decisions-failed-head">Couldn't reconstruct decisions</p>
          <p className="decisions-failed-body">
            The decision-extraction runner did not complete, so this is not "no decisions were
            made".
          </p>
          <p className="decisions-failed-reason">{runStatus.reason}</p>
        </div>
      </div>
    );
  }
  const coverage = canvasCoverage(canvas);
  // Amber follows the overlay toggle (#35 / F1): off ⇒ no painted chunks, so the
  // cohort amber and the not-assessed chips appear and disappear together.
  const painted = overlayOn ? paintedChunkIds(canvas) : new Set<string>();
  const blastReasons = overlayOn ? blastReasonsByChunk(canvas) : new Map<string, string>();
  const byKey = new Map(canvas.layers.analysis.elements.map((el) => [el.elementKey, el]));
  // A review that RAN and discerned no decisions — honestly empty, distinct from
  // the failed-runner banner above.
  if (canvas.layers.analysis.cohorts.length === 0) {
    return (
      <div className="decisions-canvas">
        <p className="decisions-empty">
          Reviewed. No decisions were discerned from this diff — this angle ran, it was not skipped.
        </p>
      </div>
    );
  }
  return (
    <div className="decisions-canvas">
      <div className="canvas-toolbar">
        <span className="canvas-coverage">
          {coverage.unread} unread of {coverage.total}
        </span>
        <DispositionBar
          scopeLabel="whole roll-up"
          onDisposition={(type) => onApproveScope({ kind: "rollup" }, type)}
        />
      </div>
      {canvas.layers.analysis.readingOrder.map((cohortKey) => {
        const cohort = canvas.layers.analysis.cohorts.find((c) => c.cohortKey === cohortKey);
        if (!cohort) return null;
        const elements = cohort.elementKeys
          .map((key) => byKey.get(key))
          .filter((element): element is AnalysisElement => element !== undefined);
        const chunkId = cohortKey.startsWith("cohort:") ? cohortKey.slice("cohort:".length) : "";
        return (
          <Cohort
            key={cohortKey}
            cohort={cohort}
            elements={elements}
            expanded={Boolean(expandedCohorts[cohortKey])}
            painted={painted.has(chunkId)}
            blastReason={blastReasons.get(chunkId)}
            onToggle={onToggleCohort}
            onApproveScope={onApproveScope}
            onSelectElement={onSelectElement}
          />
        );
      })}
    </div>
  );
}
