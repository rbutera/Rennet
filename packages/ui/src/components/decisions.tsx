import type { AnalysisCohort, AnalysisElement, Canvas, DispositionType } from "@rennet/types";
import { type ApprovalScope, blastPaint, canvasCoverage } from "../canvas/logic";
import { DispositionBar } from "./disposition";

// The decisions canvas: cohorts collapsed by default with HONEST counts, uncapped
// and untruncated. Expand/collapse is navigation only. Approve works at any
// granularity — the whole roll-up, a cohort, or a single decision — and every one
// is a single act (the fan-out to per-anchor L2 happens in the handler).

function paintedChunkIds(canvas: Canvas): Set<string> {
  const prefix = "rennet:chunk/";
  return new Set(
    [...blastPaint(canvas)]
      .filter((target) => target.startsWith(prefix))
      .map((target) => target.slice(prefix.length)),
  );
}

function Cohort({
  cohort,
  elements,
  expanded,
  painted,
  selectedElementKey,
  onToggle,
  onApproveScope,
  onSelectElement,
}: {
  cohort: AnalysisCohort;
  elements: AnalysisElement[];
  expanded: boolean;
  painted: boolean;
  selectedElementKey?: string;
  onToggle(cohortKey: string): void;
  onApproveScope(scope: ApprovalScope, type: DispositionType): void;
  onSelectElement(elementKey: string): void;
}) {
  return (
    <section className={painted ? "cohort is-blast" : "cohort"}>
      <header className="cohort-head">
        <button
          type="button"
          className="cohort-toggle"
          aria-expanded={expanded}
          onClick={() => onToggle(cohort.cohortKey)}
        >
          <span className="cohort-chevron" aria-hidden="true">
            {expanded ? "▾" : "▸"}
          </span>
          <span className="cohort-title">{cohort.title}</span>
          {/* Honest count: the true number of decisions, collapsed or not. */}
          <span className="cohort-count">{cohort.elementKeys.length} decisions</span>
          {painted ? (
            <span className="cohort-blast" title="In the blast radius">
              blast
            </span>
          ) : null}
        </button>
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
            <li
              className={
                selectedElementKey === element.elementKey ? "decision is-selected" : "decision"
              }
              key={element.elementKey}
            >
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
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  );
}

export function DecisionsCanvas({
  canvas,
  expandedCohorts,
  selectedElementKey,
  onToggleCohort,
  onApproveScope,
  onSelectElement,
}: {
  canvas: Canvas;
  expandedCohorts: Record<string, boolean>;
  selectedElementKey?: string;
  onToggleCohort(cohortKey: string): void;
  onApproveScope(scope: ApprovalScope, type: DispositionType): void;
  onSelectElement(elementKey: string): void;
}) {
  const coverage = canvasCoverage(canvas);
  const painted = paintedChunkIds(canvas);
  const byKey = new Map(canvas.layers.analysis.elements.map((el) => [el.elementKey, el]));
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
            selectedElementKey={selectedElementKey}
            onToggle={onToggleCohort}
            onApproveScope={onApproveScope}
            onSelectElement={onSelectElement}
          />
        );
      })}
    </div>
  );
}
