import type { DispositionType, OpenSpecBlock, OpenSpecScenario } from "@rennet/types";
import type { AskMode, AskReviewResult } from "../canvas/ask";
import type {
  OpenSpecDeltaGroupView,
  OpenSpecDeltaView,
  OpenSpecRequirementView,
  OpenSpecReviewAnchor,
  OpenSpecViewModel,
} from "../canvas/openspec";
import { AskAnswers, AskControl } from "./ask";
import { DispositionCluster } from "./disposition-cluster";

// ─────────────────────────────────────────────────────────────────────────────
// The Spec angle: a STRUCTURED viewer for an OpenSpec change (Rai, wireframes #9).
//
// The change's artifacts have a KNOWN shape, so this renders them structured —
// never a raw-markdown dump. The proposal reads as why / what-changes /
// capabilities / impact; the design as a sectioned document with a table of
// contents; the tasks as a checklist with an honest progress roll-up; the spec
// deltas as the requirement → scenario tree with ADDED/MODIFIED/REMOVED badges and
// Gherkin WHEN/THEN steps.
//
// Every addressable element carries a review affordance, reusing the SAME seams as
// the diff lenses: the `DispositionCluster` (approve / request-change / comment /
// question) on each requirement, section, capability, task group, and the whole
// change; and the `AskControl` (ask the orchestrator by default, opt in to ask
// both models — no synthesis, ever) at the header. Review lives on the spec, not
// only on the diff.
// ─────────────────────────────────────────────────────────────────────────────

/** The controlled ask state the host threads in (mirrors the diff-lens ask seam). */
export interface OpenSpecAskState {
  readonly mode: AskMode;
  readonly question: string;
  readonly pending?: boolean;
  /** The routed result, once an ask resolves (orchestrator always; Codex only if both asked). */
  readonly result?: AskReviewResult;
  onQuestionChange(question: string): void;
  onModeChange(mode: AskMode): void;
  onAsk(): void;
}

const OPERATION_LABEL: Record<OpenSpecDeltaView["delta"]["groups"][number]["operation"], string> = {
  added: "Added",
  modified: "Modified",
  removed: "Removed",
  renamed: "Renamed",
};

/** Title-case a Gherkin keyword for display (avoids a record with a `then` key). */
function stepLabel(keyword: OpenSpecScenario["steps"][number]["keyword"]): string {
  return keyword.charAt(0).toUpperCase() + keyword.slice(1);
}

/** A compact review cluster on one Spec anchor — the shared disposition seam. */
function AnchorReview({
  anchor,
  onDispose,
}: {
  anchor: OpenSpecReviewAnchor;
  onDispose(anchor: OpenSpecReviewAnchor, type: DispositionType): void;
}) {
  return (
    <DispositionCluster
      anchor={{ kind: "element", label: anchor.label }}
      compact
      labelled={false}
      onDispose={(type) => onDispose(anchor, type)}
    />
  );
}

/** Render one block (paragraph / list / fenced code / table) structurally. */
function Block({ block }: { block: OpenSpecBlock }) {
  switch (block.kind) {
    case "paragraph":
      return <p className="ospec-paragraph">{block.text}</p>;
    case "code":
      return (
        <pre className="ospec-code" data-language={block.language}>
          <code>{block.code}</code>
        </pre>
      );
    case "table":
      return (
        <div className="ospec-table-wrap">
          <table className="ospec-table">
            <thead>
              <tr>
                {block.headers.map((header) => (
                  <th key={header}>{header}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                // Row order is the document's; a positional key is stable here.
                // biome-ignore lint/suspicious/noArrayIndexKey: table rows are positional and never reordered
                <tr key={rowIndex}>
                  {row.map((cell, cellIndex) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: table cells are positional and never reordered
                    <td key={cellIndex}>{cell}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "list":
      return block.ordered ? (
        <ol className="ospec-list ospec-list-ordered">
          {block.items.map((item, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: list items are positional prose with no stable id
            <li key={index}>
              {item.lead ? <span className="ospec-list-lead">{item.lead}</span> : null}
              <span className="ospec-list-text">{item.text}</span>
            </li>
          ))}
        </ol>
      ) : (
        <ul className="ospec-list ospec-list-unordered">
          {block.items.map((item, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: list items are positional prose with no stable id
            <li key={index}>
              {item.lead ? <span className="ospec-list-lead">{item.lead}</span> : null}
              <span className="ospec-list-text">{item.text}</span>
            </li>
          ))}
        </ul>
      );
  }
}

function Blocks({ blocks }: { blocks: readonly OpenSpecBlock[] }) {
  return (
    <>
      {blocks.map((block, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: blocks are a positional document stream
        <Block key={index} block={block} />
      ))}
    </>
  );
}

function Scenario({
  scenario,
  anchor,
  onDispose,
}: {
  scenario: OpenSpecScenario;
  anchor: OpenSpecReviewAnchor | undefined;
  onDispose(anchor: OpenSpecReviewAnchor, type: DispositionType): void;
}) {
  return (
    <div className="ospec-scenario">
      <div className="ospec-scenario-head">
        <p className="ospec-scenario-name">{scenario.name}</p>
        {anchor ? <AnchorReview anchor={anchor} onDispose={onDispose} /> : null}
      </div>
      <ol className="ospec-steps">
        {scenario.steps.map((step, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: steps are an ordered Gherkin sequence
          <li className="ospec-step" data-keyword={step.keyword} key={index}>
            <span className="ospec-step-keyword">{stepLabel(step.keyword)}</span>
            <span className="ospec-step-text">{step.text}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function Requirement({
  view,
  operation,
  onDispose,
}: {
  view: OpenSpecRequirementView;
  operation: OpenSpecDeltaGroupView["operation"];
  onDispose(anchor: OpenSpecReviewAnchor, type: DispositionType): void;
}) {
  const { requirement } = view;
  return (
    <li className="ospec-requirement" data-anchor={view.anchor.key} data-operation={operation}>
      <div className="ospec-requirement-head">
        {/* The requirement carries its OWN operation badge (issue #4): a delta mixing
            MODIFIED + ADDED requirements stays legible per-requirement, not just at
            the capability header. */}
        <span className={`ospec-op ospec-op-${operation}`} data-operation={operation}>
          {OPERATION_LABEL[operation]}
        </span>
        <h4 className="ospec-requirement-name">{requirement.name}</h4>
        <AnchorReview anchor={view.anchor} onDispose={onDispose} />
      </div>
      {requirement.statement ? (
        <p className="ospec-requirement-statement">{requirement.statement}</p>
      ) : null}
      {requirement.scenarios.length > 0 ? (
        <div className="ospec-scenarios">
          <span className="ospec-scenarios-count">
            {requirement.scenarios.length}{" "}
            {requirement.scenarios.length === 1 ? "scenario" : "scenarios"}
          </span>
          {requirement.scenarios.map((scenario, index) => (
            <Scenario
              key={view.scenarioAnchors[index]?.key ?? scenario.name}
              scenario={scenario}
              anchor={view.scenarioAnchors[index]}
              onDispose={onDispose}
            />
          ))}
        </div>
      ) : null}
    </li>
  );
}

function SpecDelta({
  view,
  onDispose,
}: {
  view: OpenSpecDeltaView;
  onDispose(anchor: OpenSpecReviewAnchor, type: DispositionType): void;
}) {
  return (
    <section className="ospec-delta" data-capability={view.delta.capability}>
      <header className="ospec-delta-head">
        <div className="ospec-delta-title">
          <span className="ospec-delta-cap">{view.delta.capability}</span>
          <span className="ospec-delta-ops">
            {view.groups.map((group, index) => (
              <span
                className={`ospec-op ospec-op-${group.operation}`}
                data-operation={group.operation}
                // biome-ignore lint/suspicious/noArrayIndexKey: groups are positional; operation+index disambiguates a rare repeat
                key={`${group.operation}-${index}`}
              >
                {OPERATION_LABEL[group.operation]} ({group.requirements.length})
              </span>
            ))}
          </span>
        </div>
        <AnchorReview anchor={view.anchor} onDispose={onDispose} />
      </header>
      {/* Operation groups are preserved (issue #4): each requirement renders under
          its operation, so attribution is never flattened away. */}
      {view.groups.map((group, index) => (
        <div
          className="ospec-op-group"
          data-operation={group.operation}
          // biome-ignore lint/suspicious/noArrayIndexKey: groups are positional; operation+index disambiguates a rare repeat
          key={`${group.operation}-${index}`}
        >
          <h5 className="ospec-op-group-head">{OPERATION_LABEL[group.operation]} requirements</h5>
          <ol className="ospec-requirements">
            {group.requirements.map((requirement) => (
              <Requirement
                key={requirement.anchor.key}
                view={requirement}
                operation={group.operation}
                onDispose={onDispose}
              />
            ))}
          </ol>
        </div>
      ))}
    </section>
  );
}

export function OpenSpecView({
  view,
  onDispose,
  ask,
}: {
  view: OpenSpecViewModel;
  /** Author a disposition against a Spec anchor (the shared DispositionWrite seam). */
  onDispose(anchor: OpenSpecReviewAnchor, type: DispositionType): void;
  /** The ask surface (orchestrator by default, opt-in both). Absent ⇒ no ask panel. */
  ask?: OpenSpecAskState;
}) {
  const { summary, proposal } = view;
  return (
    <div className="openspec-view" data-change={view.name}>
      <header className="ospec-header">
        <div className="ospec-header-title">
          <span className="ospec-kicker">OpenSpec change</span>
          <h2 className="ospec-name">{view.name}</h2>
        </div>
        <div className="ospec-summary">
          <span className="ospec-stat">
            <span className="ospec-stat-num">{summary.requirements}</span> requirements
          </span>
          <span className="ospec-stat">
            <span className="ospec-stat-num">{summary.scenarios}</span> scenarios
          </span>
          <span className="ospec-stat">
            <span className="ospec-stat-num">{summary.specCapabilities}</span> spec capabilities
          </span>
          <span className="ospec-stat">
            <span className="ospec-stat-num">
              {summary.tasksDone}/{summary.tasksTotal}
            </span>{" "}
            tasks
          </span>
        </div>
        <div className="ospec-header-review">
          <span className="ospec-review-label">Review the whole change</span>
          <DispositionCluster
            anchor={{ kind: "rollup", label: view.name }}
            onDispose={(type) => onDispose(view.changeAnchor, type)}
          />
        </div>
      </header>

      {ask ? (
        <section className="ospec-ask" aria-label="Ask about this change">
          <AskControl
            mode={ask.mode}
            question={ask.question}
            pending={ask.pending}
            onQuestionChange={ask.onQuestionChange}
            onModeChange={ask.onModeChange}
            onAsk={ask.onAsk}
          />
          {ask.result ? <AskAnswers question={ask.question} result={ask.result} /> : null}
        </section>
      ) : null}

      {proposal ? (
        <section className="ospec-proposal" aria-label="Proposal">
          <div className="ospec-section-head">
            <h3 className="ospec-section-title">Proposal</h3>
          </div>

          {proposal.proposal.why.length > 0 ? (
            <div className="ospec-why">
              <h4 className="ospec-subhead">Why</h4>
              {/* Each Why block carries its own review cluster (issue #3), anchored
                  to its source line in proposal.md. */}
              {proposal.proposal.why.map((block, index) => {
                const whyAnchor = proposal.whyAnchors[index];
                return (
                  <div
                    className="ospec-why-block"
                    // biome-ignore lint/suspicious/noArrayIndexKey: why blocks are positional prose
                    key={index}
                  >
                    <Block block={block} />
                    {whyAnchor ? <AnchorReview anchor={whyAnchor} onDispose={onDispose} /> : null}
                  </div>
                );
              })}
            </div>
          ) : null}

          {proposal.proposal.whatChanges.length > 0 ? (
            <div className="ospec-what-changes">
              <h4 className="ospec-subhead">What changes</h4>
              <ul className="ospec-list ospec-list-unordered">
                {proposal.proposal.whatChanges.map((item, index) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: change items are positional prose
                  <li key={index}>
                    {item.lead ? <span className="ospec-list-lead">{item.lead}</span> : null}
                    <span className="ospec-list-text">{item.text}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {proposal.capabilities.length > 0 ? (
            <div className="ospec-capabilities">
              <h4 className="ospec-subhead">Capabilities</h4>
              <ul className="ospec-capability-list">
                {proposal.capabilities.map((capability) => (
                  <li
                    className="ospec-capability"
                    data-nature={capability.nature}
                    key={capability.anchor.key}
                  >
                    <div className="ospec-capability-head">
                      <span className={`ospec-cap-nature ospec-cap-${capability.nature}`}>
                        {capability.nature === "new" ? "new" : "modified"}
                      </span>
                      <span className="ospec-cap-name">{capability.note.name}</span>
                      <AnchorReview anchor={capability.anchor} onDispose={onDispose} />
                    </div>
                    {capability.note.summary ? (
                      <p className="ospec-cap-summary">{capability.note.summary}</p>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {proposal.proposal.impact.length > 0 ? (
            <div className="ospec-impact">
              <h4 className="ospec-subhead">Impact</h4>
              <ul className="ospec-impact-list">
                {proposal.proposal.impact.map((entry, index) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: impact rows are positional
                  <li className="ospec-impact-row" key={index}>
                    {entry.area ? <span className="ospec-impact-area">{entry.area}</span> : null}
                    <span className="ospec-impact-detail">{entry.detail}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </section>
      ) : null}

      {view.specDeltas.length > 0 ? (
        <section className="ospec-deltas" aria-label="Spec deltas">
          <h3 className="ospec-section-title">Spec deltas</h3>
          {view.specDeltas.map((delta) => (
            <SpecDelta key={delta.anchor.key} view={delta} onDispose={onDispose} />
          ))}
        </section>
      ) : null}

      {view.taskGroups.length > 0 ? (
        <section className="ospec-tasks" aria-label="Tasks">
          <div className="ospec-section-head">
            <h3 className="ospec-section-title">Tasks</h3>
            <span className="ospec-task-progress">
              {summary.tasksDone} of {summary.tasksTotal} done
            </span>
          </div>
          <div
            className="ospec-progress"
            role="progressbar"
            aria-valuenow={summary.tasksDone}
            aria-valuemin={0}
            aria-valuemax={summary.tasksTotal}
          >
            <span
              className="ospec-progress-fill"
              style={{
                width:
                  summary.tasksTotal > 0
                    ? `${Math.round((summary.tasksDone / summary.tasksTotal) * 100)}%`
                    : "0%",
              }}
            />
          </div>
          {view.taskGroups.map((groupView) => (
            <section className="ospec-task-group" key={groupView.anchor.key}>
              <header className="ospec-task-group-head">
                <span className="ospec-task-group-title">{groupView.group.title}</span>
                <span className="ospec-task-group-count">
                  {groupView.group.done}/{groupView.group.total}
                </span>
                <AnchorReview anchor={groupView.anchor} onDispose={onDispose} />
              </header>
              <ul className="ospec-task-items">
                {groupView.group.items.map((item, index) => {
                  const itemAnchor = groupView.itemAnchors[index];
                  return (
                    <li
                      className="ospec-task-item"
                      data-status={item.status}
                      // biome-ignore lint/suspicious/noArrayIndexKey: task items are positional
                      key={index}
                    >
                      <span className="ospec-task-check" aria-hidden="true">
                        {item.status === "done" ? "☑" : "☐"}
                      </span>
                      <span className="ospec-task-text">{item.text}</span>
                      {/* Per-item review cluster (issue #3), anchored to the item's line. */}
                      {itemAnchor ? (
                        <AnchorReview anchor={itemAnchor} onDispose={onDispose} />
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </section>
      ) : null}

      {view.designSections.length > 0 ? (
        <section className="ospec-design" aria-label="Design">
          <h3 className="ospec-section-title">Design</h3>
          <nav className="ospec-toc" aria-label="Design contents">
            {view.designSections.map((sectionView) => (
              <a
                className={`ospec-toc-link ospec-toc-l${sectionView.section.level}`}
                href={`#${sectionView.anchor.key}`}
                key={sectionView.anchor.key}
              >
                {sectionView.section.heading}
              </a>
            ))}
          </nav>
          {view.designSections.map((sectionView) => (
            <section
              className={`ospec-design-section ospec-design-l${sectionView.section.level}`}
              id={sectionView.anchor.key}
              key={sectionView.anchor.key}
            >
              <div className="ospec-design-head">
                {sectionView.section.level === 2 ? (
                  <h4 className="ospec-design-heading">{sectionView.section.heading}</h4>
                ) : (
                  <h5 className="ospec-design-heading">{sectionView.section.heading}</h5>
                )}
                <AnchorReview anchor={sectionView.anchor} onDispose={onDispose} />
              </div>
              <Blocks blocks={sectionView.section.blocks} />
            </section>
          ))}
        </section>
      ) : null}
    </div>
  );
}
