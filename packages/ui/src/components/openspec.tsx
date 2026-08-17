import type {
  DispositionType,
  OpenSpecBlock,
  OpenSpecChangeRaw,
  OpenSpecScenario,
} from "@rennet/types";
import { useEffect, useState } from "react";
import type { AskMode, AskReviewResult } from "../canvas/ask";
import {
  classifyCoverage,
  type OpenSpecDeltaGroupView,
  type OpenSpecDeltaView,
  type OpenSpecRequirementView,
  type OpenSpecReviewAnchor,
  type OpenSpecViewModel,
} from "../canvas/openspec";
import { AskAnswers, AskControl } from "./ask";
import { DispositionCluster } from "./disposition-cluster";
import { CheckboxCheckedIcon, CheckboxIcon } from "./icons";

// ─────────────────────────────────────────────────────────────────────────────
// The Spec angle: a STRUCTURED viewer for an OpenSpec change (Rai, wireframes #9).
//
// The change's artifacts have a KNOWN shape, so this renders them structured by
// default. The raw markdown is one keystroke away, never the default (issue #239 /
// #33): press `r` to flip the visible artifacts to their verbatim on-disk text and
// back. The proposal reads as why / what-changes /
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

/** The link glyph the coverage chip wears (the requirement↔diff tie made visible). */
function CoverageIcon() {
  return (
    <svg
      className="ospec-covchip-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M9.5 14.5l5-5" />
      <path d="M11 7l1.2-1.2a3.4 3.4 0 0 1 4.9 4.9L16 12" />
      <path d="M13 17l-1.2 1.2a3.4 3.4 0 0 1-4.9-4.9L8 12" />
    </svg>
  );
}

/** `n hunks` / `n tests` with honest singular/plural. */
function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/**
 * The requirement's coverage chip (Rai, wireframes #9 / R53): the requirements-side
 * mouth of the hunk↔requirement mapping. A COVERED requirement reads "covered by N
 * hunks · M tests" and, when a jump is wired, is a button that jumps to the first
 * claiming hunk (reusing the diff-lens anchor navigation). A requirement the mapping
 * scored at ZERO hunks reads a quiet amber "unimplemented · 0 hunks" — an honest
 * computed zero, never a gate. A requirement with NO mapping (coverage absent) shows
 * no chip at all: the view never fabricates coverage it was not handed.
 */
function CoverageChip({
  view,
  onJumpToHunk,
}: {
  view: OpenSpecRequirementView;
  onJumpToHunk?(anchor: string): void;
}) {
  const chip = classifyCoverage(view.coverage);
  if (!chip) return null;
  if (chip.kind === "unimplemented") {
    return (
      <span className="ospec-covchip ospec-covchip-zero" data-coverage="unimplemented">
        <CoverageIcon />
        unimplemented · 0 hunks
      </span>
    );
  }
  const label = `covered by ${count(chip.hunks.length, "hunk")} · ${count(chip.tests, "test")}`;
  const jumpTarget = chip.hunks[0];
  // Jump to the FIRST claiming hunk when navigation is wired and there is a target;
  // otherwise the chip is a static, honest label (still says what it covers).
  if (onJumpToHunk && jumpTarget) {
    return (
      <button
        type="button"
        className="ospec-covchip"
        data-coverage="covered"
        onClick={() => onJumpToHunk(jumpTarget)}
        aria-label={`${label} — jump to the claiming hunk`}
      >
        <CoverageIcon />
        {label}
      </button>
    );
  }
  return (
    <span className="ospec-covchip" data-coverage="covered">
      <CoverageIcon />
      {label}
    </span>
  );
}

function Requirement({
  view,
  operation,
  onDispose,
  onJumpToHunk,
}: {
  view: OpenSpecRequirementView;
  operation: OpenSpecDeltaGroupView["operation"];
  onDispose(anchor: OpenSpecReviewAnchor, type: DispositionType): void;
  onJumpToHunk?(anchor: string): void;
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
      {/* Coverage foot (issue #9 / R53): the requirement's tie to the diff — covered
          by N hunks · M tests (click jumps to the claiming hunk), or an honest
          "unimplemented" when the mapping scored zero, or nothing when uncomputed. */}
      {view.coverage ? (
        <div className="ospec-requirement-foot">
          <CoverageChip view={view} onJumpToHunk={onJumpToHunk} />
        </div>
      ) : null}
    </li>
  );
}

function SpecDelta({
  view,
  onDispose,
  onJumpToHunk,
}: {
  view: OpenSpecDeltaView;
  onDispose(anchor: OpenSpecReviewAnchor, type: DispositionType): void;
  onJumpToHunk?(anchor: string): void;
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
                onJumpToHunk={onJumpToHunk}
              />
            ))}
          </ol>
        </div>
      ))}
    </section>
  );
}

/**
 * The raw escape hatch (#239): the change's artifacts as verbatim markdown read off
 * disk, each in its own `<pre>` — no re-serialization, no re-rendering. Structured is
 * the default; this shows only when the reviewer presses the raw-view key.
 */
function RawArtifacts({ raw }: { raw: OpenSpecChangeRaw }) {
  const files: { label: string; md: string }[] = [];
  if (raw.proposalMd !== undefined) files.push({ label: "proposal.md", md: raw.proposalMd });
  if (raw.designMd !== undefined) files.push({ label: "design.md", md: raw.designMd });
  if (raw.tasksMd !== undefined) files.push({ label: "tasks.md", md: raw.tasksMd });
  for (const delta of raw.specDeltas) {
    files.push({ label: `specs/${delta.capability}/spec.md`, md: delta.md });
  }
  return (
    <section className="ospec-raw" aria-label="Raw markdown">
      {files.map((file) => (
        <div className="ospec-raw-file" key={file.label}>
          <h3 className="ospec-raw-name">{file.label}</h3>
          <pre className="ospec-raw-text">{file.md}</pre>
        </div>
      ))}
    </section>
  );
}

export function OpenSpecView({
  view,
  onDispose,
  ask,
  onJumpToHunk,
}: {
  view: OpenSpecViewModel;
  /** Author a disposition against a Spec anchor (the shared DispositionWrite seam). */
  onDispose(anchor: OpenSpecReviewAnchor, type: DispositionType): void;
  /** The ask surface (orchestrator by default, opt-in both). Absent ⇒ no ask panel. */
  ask?: OpenSpecAskState;
  /**
   * Jump to a claiming hunk from a requirement's coverage chip, by its diff anchor
   * (the SAME anchor navigation the diff lenses use). Absent ⇒ covered chips render
   * as static labels rather than jump buttons (still honest about what they cover).
   */
  onJumpToHunk?(anchor: string): void;
}) {
  const { summary, proposal } = view;

  // Raw markdown one keystroke away (#239): structured is the default; `r` flips the
  // visible artifacts to their verbatim on-disk text and back. Only bound when the
  // change carried its raw source — no raw ⇒ nothing to flip to, honestly inert.
  const [rawView, setRawView] = useState(false);
  const hasRaw = view.raw !== undefined;
  useEffect(() => {
    if (!hasRaw) return;
    function onKey(event: KeyboardEvent): void {
      if (event.key !== "r" || event.metaKey || event.ctrlKey || event.altKey) return;
      // A keystroke inside a text field is the reviewer typing, not a view command.
      const target = event.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        (target instanceof HTMLElement && target.isContentEditable)
      )
        return;
      setRawView((raw) => !raw);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hasRaw]);
  const showRaw = rawView && view.raw !== undefined;

  return (
    <div
      className="openspec-view"
      data-change={view.name}
      data-view={showRaw ? "raw" : "structured"}
    >
      {showRaw && view.raw ? <RawArtifacts raw={view.raw} /> : null}
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

      {!showRaw && proposal ? (
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

      {!showRaw && view.specDeltas.length > 0 ? (
        <section className="ospec-deltas" aria-label="Spec deltas">
          <h3 className="ospec-section-title">Spec deltas</h3>
          {view.specDeltas.map((delta) => (
            <SpecDelta
              key={delta.anchor.key}
              view={delta}
              onDispose={onDispose}
              onJumpToHunk={onJumpToHunk}
            />
          ))}
        </section>
      ) : null}

      {!showRaw && view.taskGroups.length > 0 ? (
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
                      <span className="ospec-task-check">
                        {item.status === "done" ? (
                          <CheckboxCheckedIcon size={14} />
                        ) : (
                          <CheckboxIcon size={14} />
                        )}
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

      {!showRaw && view.designSections.length > 0 ? (
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
