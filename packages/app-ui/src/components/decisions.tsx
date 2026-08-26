import type {
  AnalysisCohort,
  AnalysisElement,
  Canvas,
  DecisionEvidence,
  DecisionsRunStatus,
  DispositionType,
} from "@rennet/protocol";
import { ChevronDown } from "lucide-react";
import {
  type ApprovalScope,
  blastReasonsByChunk,
  canvasCoverage,
  paintedChunkIds,
} from "../canvas/logic";
import { DispositionBar } from "./disposition";
import { Icon } from "./icon";

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
    <div className="decision-detail flex flex-col gap-2">
      {hasEvidence ? (
        <ul
          className="decision-evidence flex list-none flex-col gap-1.5"
          aria-label="Evidence this decision was drawn from"
        >
          {detail.evidence.map((chip) => (
            <li
              className={`evidence-chip evidence-${chip.kind} flex items-baseline gap-2 rounded-control border border-green-line bg-green-soft px-2.5 py-1.5`}
              key={`${chip.kind}:${chip.label}:${chip.detail}`}
            >
              <span className="evidence-kind flex-none rounded-full border border-green-line px-2 py-0.5 text-2xs font-semibold uppercase tracking-wide text-green">
                {EVIDENCE_KIND_LABEL[chip.kind]}
              </span>
              <span className="evidence-label flex-none font-mono text-xs text-ink-faint">
                {chip.label}
              </span>
              <span className="evidence-detail text-sm text-ink-soft">{chip.detail}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {detail.why ? (
        <p className="decision-why flex flex-col gap-1">
          {/* The marker is load-bearing: an inferred rationale is never presented
              as a stated fact. */}
          <span className="decision-why-tag text-2xs font-semibold uppercase tracking-wide text-ink-faint">
            why · reconstructed
          </span>
          <span className="decision-why-text font-serif text-base italic text-ink-soft">
            {detail.why.text}
          </span>
        </p>
      ) : (
        <p className="decision-why decision-why-none flex flex-col gap-1 opacity-70">
          <span className="decision-why-tag text-2xs font-semibold uppercase tracking-wide text-ink-faint">
            why · none discerned
          </span>
        </p>
      )}
      {hasAlternatives ? (
        <div className="decision-alternatives flex flex-col gap-1">
          <span className="decision-alternatives-tag text-2xs font-semibold uppercase tracking-wide text-ink-faint">
            alternatives not taken
          </span>
          <ul className="decision-alternatives-list list-disc pl-4 text-sm text-ink-soft">
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
    <section
      className={`cohort mb-2.5 overflow-hidden rounded-surface border ${painted ? "is-blast border-accent-line bg-accent-surface" : "border-line bg-surface"}`}
    >
      <header className="cohort-head flex items-center justify-between gap-3 px-4 py-3">
        <button
          type="button"
          className="cohort-toggle group flex cursor-pointer items-center gap-2.5 border-0 bg-transparent p-0 text-left font-semibold text-ink"
          aria-expanded={expanded}
          onClick={() => onToggle(cohort.cohortKey)}
        >
          <span
            className={`cohort-chevron inline-flex text-ink-faint transition-transform ${expanded ? "is-open rotate-0" : "-rotate-90"}`}
            aria-hidden="true"
          >
            <Icon icon={ChevronDown} className="size-3.5" />
          </span>
          <span className="cohort-title text-base">{cohort.title}</span>
          {/* Honest count: the true number of decisions, collapsed or not. */}
          <span className="cohort-count text-sm font-normal text-ink-faint">
            {cohort.elementKeys.length} decisions
          </span>
          {painted ? (
            <span
              className="cohort-blast text-2xs font-semibold uppercase tracking-wide text-ink"
              title={blastReason ?? "In the blast radius"}
            >
              blast
            </span>
          ) : null}
        </button>
        {painted && blastReason ? (
          <p className="cohort-blast-reason text-sm text-ink">{blastReason}</p>
        ) : null}
        <DispositionBar
          scopeLabel={`cohort ${cohort.title}`}
          compact
          onDisposition={(type) =>
            onApproveScope({ kind: "cohort", cohortKey: cohort.cohortKey }, type)
          }
        />
      </header>
      {expanded ? (
        <ol className="cohort-elements list-none border-t border-line pb-1.5">
          {elements.map((element) => (
            <li
              className="decision flex flex-col gap-2 border-b border-line py-2.5 pl-8 pr-4 last:border-b-0"
              key={element.elementKey}
            >
              <div className="decision-head flex items-center justify-between gap-3">
                <button
                  type="button"
                  className="decision-select cursor-pointer border-0 bg-transparent p-0 text-left text-base font-semibold text-ink-soft hover:text-ink"
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
      <div className="decisions-canvas flex flex-col">
        <div
          className="decisions-failed rounded-surface border border-accent-line bg-accent-surface p-4"
          role="status"
        >
          <p className="decisions-failed-head text-base font-semibold text-ink">
            Couldn't reconstruct decisions
          </p>
          <p className="decisions-failed-body mt-1.5 text-ink-soft">
            The decision-extraction runner did not complete, so this is not "no decisions were
            made".
          </p>
          <p className="decisions-failed-reason mt-1.5 font-mono text-xs text-ink-faint">
            {runStatus.reason}
          </p>
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
      <div className="decisions-canvas flex flex-col">
        <p className="decisions-empty px-1 py-6 text-base italic text-ink-faint">
          Reviewed. No decisions were discerned from this diff — this angle ran, it was not skipped.
        </p>
      </div>
    );
  }
  return (
    <div className="decisions-canvas flex flex-col">
      <div className="canvas-toolbar mb-4 flex items-center justify-between gap-4 border-b border-line pb-3">
        <span className="canvas-coverage text-sm font-semibold text-ink">
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
