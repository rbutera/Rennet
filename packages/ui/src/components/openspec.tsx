import type {
  Disposition,
  DispositionType,
  OpenSpecCapabilityDelta,
  OpenSpecProseSection,
  OpenSpecReviewAnchor,
} from "@rennet/types";
import type { ReactNode } from "react";
import type { AskMode, AskReviewResult } from "../canvas/ask";
import type { DispositionWrite } from "../canvas/logic";
import {
  authorOpenSpecDisposition,
  dispositionsForAnchor,
  type OpenSpecViewModel,
} from "../canvas/openspec";
import { AskAnswers, AskControl } from "./ask";
import { DispositionCluster } from "./disposition-cluster";

// ─────────────────────────────────────────────────────────────────────────────
// The OpenSpec change view (#15). Renders a parsed `OpenSpecChange` as a reviewable
// document: the proposal (why / what-changes / capabilities / impact), the design
// sections, the task checklist with its progress, and the per-capability spec
// deltas down to their scenarios. Every reviewable node carries a `DispositionCluster`
// (the four review verbs, reused unchanged) whose disposition is authored against the
// node's STRUCTURAL anchor via `authorOpenSpecDisposition`, so an OpenSpec review
// rides the existing disposition machinery. An optional Ask thread (reusing
// `AskControl` / `AskAnswers`) lets the reviewer put a question about the change to
// the orchestrator (or both models). Host-free — the host owns disposition staging
// and ask routing; this component only renders and reports.
// ─────────────────────────────────────────────────────────────────────────────

/** The ask thread state + handlers the view threads into `AskControl` / `AskAnswers`. */
export interface OpenSpecAskProps {
  readonly mode: AskMode;
  readonly question: string;
  readonly pending?: boolean;
  readonly result?: AskReviewResult;
  onQuestionChange(question: string): void;
  onModeChange(mode: AskMode): void;
  onAsk(): void;
}

export interface OpenSpecViewProps {
  readonly view: OpenSpecViewModel;
  /** Author a disposition on a node; the host stages/refines the raw body (#19 seam). */
  onAuthorDisposition(write: DispositionWrite): void;
  /** Optional "ask about this change" thread. */
  readonly ask?: OpenSpecAskProps;
}

/** The review affordance placed on any node: the four verbs + the node's dispositions. */
function Reviewable({
  anchor,
  label,
  view,
  onAuthorDisposition,
  children,
}: {
  anchor: OpenSpecReviewAnchor;
  label: string;
  view: OpenSpecViewModel;
  onAuthorDisposition(write: DispositionWrite): void;
  children: ReactNode;
}) {
  const dispositions = dispositionsForAnchor(view, anchor);
  const dispose = (type: DispositionType): void =>
    onAuthorDisposition(authorOpenSpecDisposition(anchor, type));
  return (
    <div className="openspec-node" data-anchor={anchor.id}>
      <div className="openspec-node-body">{children}</div>
      <div className="openspec-node-review">
        <DispositionCluster anchor={{ kind: "element", label }} compact onDispose={dispose} />
        {dispositions.length > 0 ? <DispositionList dispositions={dispositions} /> : null}
      </div>
    </div>
  );
}

function DispositionList({ dispositions }: { dispositions: readonly Disposition[] }) {
  return (
    <ul className="openspec-dispositions">
      {dispositions.map((disposition) => (
        <li
          className="openspec-disposition"
          data-type={disposition.type}
          key={`${disposition.type}|${disposition.body}`}
        >
          <span className="openspec-disposition-type">{disposition.type}</span>
          {disposition.body ? (
            <span className="openspec-disposition-body">{disposition.body}</span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/** Raw markdown body, whitespace preserved (a full markdown render is out of scope). */
function Prose({ body }: { body: string }) {
  return body.trim().length > 0 ? <div className="openspec-prose">{body}</div> : null;
}

function ProseSectionView({
  section,
  view,
  onAuthorDisposition,
}: {
  section: OpenSpecProseSection;
  view: OpenSpecViewModel;
  onAuthorDisposition(write: DispositionWrite): void;
}) {
  return (
    <div className="openspec-section" data-level={section.level}>
      <Reviewable
        anchor={section.anchor}
        label={section.heading}
        view={view}
        onAuthorDisposition={onAuthorDisposition}
      >
        <h4 className="openspec-section-heading">{section.heading}</h4>
        <Prose body={section.body} />
      </Reviewable>
      {(section.subsections ?? []).map((child) => (
        <ProseSectionView
          key={child.anchor.id}
          section={child}
          view={view}
          onAuthorDisposition={onAuthorDisposition}
        />
      ))}
    </div>
  );
}

function CapabilityDeltaView({
  capability,
  view,
  onAuthorDisposition,
}: {
  capability: OpenSpecCapabilityDelta;
  view: OpenSpecViewModel;
  onAuthorDisposition(write: DispositionWrite): void;
}) {
  return (
    <Reviewable
      anchor={capability.anchor}
      label={`capability ${capability.name}`}
      view={view}
      onAuthorDisposition={onAuthorDisposition}
    >
      <div className="openspec-capability" data-kind={capability.kind}>
        <span className={`openspec-cap-kind openspec-cap-kind-${capability.kind}`}>
          {capability.kind}
        </span>
        <code className="openspec-cap-name">{capability.name}</code>
        <span className="openspec-cap-desc">{capability.description}</span>
      </div>
    </Reviewable>
  );
}

export function OpenSpecView({ view, onAuthorDisposition, ask }: OpenSpecViewProps) {
  const { change, taskProgress, dispositionCount } = view;
  const pct = Math.round(taskProgress.ratio * 100);
  return (
    <article className="openspec-view" aria-label={`OpenSpec change ${change.name}`}>
      <header className="openspec-head">
        <h2 className="openspec-name">{change.name}</h2>
        <div className="openspec-meta">
          {change.meta?.schema ? (
            <span className="openspec-meta-chip" data-key="schema">
              {change.meta.schema}
            </span>
          ) : null}
          {change.meta?.created ? (
            <span className="openspec-meta-chip" data-key="created">
              {change.meta.created}
            </span>
          ) : null}
          <span className="openspec-meta-chip" data-key="dispositions">
            {dispositionCount} {dispositionCount === 1 ? "disposition" : "dispositions"}
          </span>
        </div>
        <div
          className="openspec-progress"
          role="progressbar"
          aria-label="Task progress"
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div className="openspec-progress-track">
            <div className="openspec-progress-fill" style={{ width: `${pct}%` }} />
          </div>
          <span className="openspec-progress-label">
            {taskProgress.completed}/{taskProgress.total} tasks
          </span>
        </div>
      </header>

      {ask ? (
        <section className="openspec-ask" aria-label="Ask about this change">
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

      <section className="openspec-proposal" aria-label="Proposal">
        <h3 className="openspec-artifact-heading">Proposal</h3>
        <ProseSectionView
          section={change.proposal.why}
          view={view}
          onAuthorDisposition={onAuthorDisposition}
        />
        <ProseSectionView
          section={change.proposal.whatChanges}
          view={view}
          onAuthorDisposition={onAuthorDisposition}
        />
        <div className="openspec-capabilities">
          <h4 className="openspec-section-heading">Capabilities</h4>
          {change.proposal.capabilities.map((capability) => (
            <CapabilityDeltaView
              key={capability.anchor.id}
              capability={capability}
              view={view}
              onAuthorDisposition={onAuthorDisposition}
            />
          ))}
        </div>
        <ProseSectionView
          section={change.proposal.impact}
          view={view}
          onAuthorDisposition={onAuthorDisposition}
        />
      </section>

      {change.design ? (
        <section className="openspec-design" aria-label="Design">
          <h3 className="openspec-artifact-heading">Design</h3>
          {change.design.sections.map((section) => (
            <ProseSectionView
              key={section.anchor.id}
              section={section}
              view={view}
              onAuthorDisposition={onAuthorDisposition}
            />
          ))}
        </section>
      ) : null}

      <section className="openspec-tasks" aria-label="Tasks">
        <h3 className="openspec-artifact-heading">Tasks</h3>
        {change.tasks.groups.map((group) => (
          <div className="openspec-task-group" key={group.anchor.id}>
            <Reviewable
              anchor={group.anchor}
              label={`task group ${group.ordinal ?? group.title}`}
              view={view}
              onAuthorDisposition={onAuthorDisposition}
            >
              <h4 className="openspec-group-heading">
                {group.ordinal ? `${group.ordinal}. ` : ""}
                {group.title}
              </h4>
              <ul className="openspec-checklist">
                {group.items.map((item) => (
                  <li className="openspec-task" data-checked={item.checked} key={item.anchor.id}>
                    <span className="openspec-task-box" aria-hidden="true">
                      {item.checked ? "☑" : "☐"}
                    </span>
                    {item.ordinal ? (
                      <span className="openspec-task-ord">{item.ordinal}</span>
                    ) : null}
                    <span className="openspec-task-text">{item.text}</span>
                  </li>
                ))}
              </ul>
            </Reviewable>
          </div>
        ))}
      </section>

      {change.specDeltas.length > 0 ? (
        <section className="openspec-specs" aria-label="Spec deltas">
          <h3 className="openspec-artifact-heading">Spec deltas</h3>
          {change.specDeltas.map((delta) => (
            <div className="openspec-spec" key={delta.anchor.id}>
              <h4 className="openspec-spec-cap">{delta.capability}</h4>
              {delta.operations.map((operation) => (
                <div
                  className="openspec-op"
                  data-op={operation.operation}
                  key={operation.anchor.id}
                >
                  <span className="openspec-op-label">{operation.operation} requirements</span>
                  {operation.requirements.map((requirement) => (
                    <div className="openspec-req" key={requirement.anchor.id}>
                      <Reviewable
                        anchor={requirement.anchor}
                        label={`requirement ${requirement.name}`}
                        view={view}
                        onAuthorDisposition={onAuthorDisposition}
                      >
                        <h5 className="openspec-req-name">{requirement.name}</h5>
                        <Prose body={requirement.text} />
                      </Reviewable>
                      {requirement.scenarios.map((scenario) => (
                        <div className="openspec-scenario" key={scenario.anchor.id}>
                          <Reviewable
                            anchor={scenario.anchor}
                            label={`scenario ${scenario.name}`}
                            view={view}
                            onAuthorDisposition={onAuthorDisposition}
                          >
                            <h6 className="openspec-scenario-name">{scenario.name}</h6>
                            <ol className="openspec-steps">
                              {scenario.steps.map((step) => (
                                <li
                                  className="openspec-step"
                                  key={`${step.keyword ?? "-"}|${step.text}`}
                                >
                                  {step.keyword ? (
                                    <span className="openspec-step-kw">{step.keyword}</span>
                                  ) : null}
                                  <span className="openspec-step-text">{step.text}</span>
                                </li>
                              ))}
                            </ol>
                          </Reviewable>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          ))}
        </section>
      ) : null}
    </article>
  );
}
