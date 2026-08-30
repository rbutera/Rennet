import {
  commandIdFor,
  type ProcessedRepoSummary,
  type ProjectProcessEvent,
  type ProjectProcessPhase,
  type ProjectProcessRun,
  type ProjectProcessStepStatus,
  type ProjectScoutAnswer,
  type ProjectScoutQuestionnaire,
} from "@rennet/protocol";
import { Spinner, Toggle, ToggleGroup } from "@rennet/ui";
import {
  ArrowLeft,
  Check,
  ChevronRight,
  MapIcon,
  MessageSquarePlus,
  TriangleAlert,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";
import { useCoachAnchor, useMergedRefs } from "../../coach/registry";
import { Icon } from "../../components/icon";
import { useBridge, useCommand, useMutation } from "../../data";
import { newChatPath, projectMapPath } from "../../routes/url";
import { selectBackgroundEvents, useRennetStore } from "../../store";

function processCommandId(projectId: string): string {
  return commandIdFor(`project.process:${projectId}`);
}

function eventKey(event: ProjectProcessEvent): string {
  switch (event.kind) {
    case "run-state":
      return `run:${event.runId}`;
    case "step":
      return `step:${event.runId}:${event.repo}:${event.phase}:${event.step}`;
    case "scout-ready":
      return `scout:${event.runId}:${event.repo}`;
    case "repo-start":
      return `repo-start:${event.repo}`;
    case "repo-done":
    case "repo-error":
      return `repo-terminal:${event.repo}`;
    case "done":
      return "done";
    case "stage":
      return `legacy-stage:${event.repo}:${event.stage}:${event.note}`;
  }
}

function upsertEvent(
  events: readonly ProjectProcessEvent[],
  event: ProjectProcessEvent,
): ProjectProcessEvent[] {
  const key = eventKey(event);
  const index = events.findIndex((candidate) => eventKey(candidate) === key);
  if (index < 0) return [...events, event];
  return events.map((candidate, candidateIndex) => (candidateIndex === index ? event : candidate));
}

interface TimelineLine {
  readonly label: string;
  readonly detail?: string;
  readonly status: ProjectProcessStepStatus;
}

function narrationLine(
  event: ProjectProcessEvent,
  legacyRunning: boolean,
  projectTerminal = false,
): TimelineLine | null {
  switch (event.kind) {
    case "step":
      return {
        label: event.note,
        status: event.status,
        ...(event.detail ? { detail: event.detail } : {}),
      };
    case "stage":
      return {
        label: event.note,
        status: /failed/i.test(event.note) ? "failed" : legacyRunning ? "running" : "done",
        ...(event.detail ? { detail: event.detail } : {}),
      };
    case "repo-start":
      return {
        label: `${projectTerminal ? "Building" : "Scouting"} ${event.repo}`,
        detail: `${event.index}/${event.total}`,
        status: "running",
      };
    case "repo-done": {
      const counts = [
        event.summary.files === undefined ? null : `${event.summary.files} files`,
        event.summary.symbols === undefined ? null : `${event.summary.symbols} symbols`,
      ].filter((part): part is string => part !== null);
      return {
        label: `Finished ${event.repo}`,
        status: "done",
        ...(counts.length > 0 ? { detail: counts.join(" · ") } : {}),
      };
    }
    case "repo-error":
      return { label: `${event.repo} failed`, detail: event.message, status: "failed" };
    case "run-state":
    case "scout-ready":
    case "done":
      return null;
  }
}

function currentPhase(events: readonly ProjectProcessEvent[]): ProjectProcessPhase {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.kind === "run-state") return event.phase;
  }
  return "scout";
}

function transportFailure(projectId: string, id: string): ProjectProcessRun {
  return {
    id,
    projectId,
    status: "failed",
    phase: "scout",
    repos: [],
    scout: null,
    reason: "The project-processing command disconnected",
  };
}

function legacyRun(
  projectId: string,
  id: string,
  repos: readonly ProcessedRepoSummary[],
): ProjectProcessRun {
  const failed = repos.filter((repo) => !repo.ok);
  if (failed.length > 0) {
    return {
      id,
      projectId,
      status: "failed",
      phase: "map",
      repos: [...repos],
      scout: null,
      reason: failed.map((repo) => `${repo.repo}: ${repo.error ?? "indexing failed"}`).join("; "),
    };
  }
  return {
    id,
    projectId,
    status: "done",
    phase: "complete",
    repos: [...repos],
    scout: null,
    totals: {
      repos: repos.length,
      files: repos.reduce((total, repo) => total + (repo.files ?? 0), 0),
      scopes: 0,
      confirmed: 0,
      rejected: 0,
    },
  };
}

function StepLine({ label, detail, status }: TimelineLine) {
  const running = status === "running" || status === "queued";
  return (
    <div className="flex items-center gap-2 text-sm" data-step-status={status}>
      {running ? (
        // Decorative: every running step would otherwise announce "Loading" as its own
        // live region, and the step's own label is what carries the state.
        <Spinner className="size-3.5 shrink-0 text-model" aria-hidden="true" />
      ) : status === "failed" ? (
        <Icon icon={TriangleAlert} className="size-3.5 shrink-0 text-danger" />
      ) : (
        <Icon icon={Check} className="size-3.5 shrink-0 text-ink-faint" />
      )}
      <span className={running ? "truncate text-ink" : "truncate text-ink-soft"}>
        {label}
        {detail ? ` · ${detail}` : ""}
      </span>
    </div>
  );
}

export function IndexingView({ projectId }: { readonly projectId: string }) {
  const bridge = useBridge();
  const [, navigate] = useLocation();
  const { data: projectsData } = useCommand("projects.list", {});
  const project = projectsData?.projects.find((candidate) => candidate.id === projectId);
  const { mutate: process } = useMutation("project.process");
  const [events, setEvents] = useState<ProjectProcessEvent[]>([]);
  const [run, setRun] = useState<ProjectProcessRun | null>(null);
  const [questionnaire, setQuestionnaire] = useState<ProjectScoutQuestionnaire | null>(null);
  const startedFor = useRef<string | undefined>(undefined);

  useEffect(() => {
    const commandId = processCommandId(projectId);
    const append = (event: ProjectProcessEvent) => {
      setEvents((prior) => upsertEvent(prior, event));
      if (event.kind === "scout-ready") setQuestionnaire(event.questionnaire);
    };
    const unsubscribe = bridge.onProgress?.(commandId, append);
    if (startedFor.current !== projectId) {
      startedFor.current = projectId;
      setEvents([]);
      setRun(null);
      setQuestionnaire(null);
      const setProcessing = useRennetStore.getState().uiActions.setProjectProcessing;
      setProcessing(projectId, true);
      const runProjectId = projectId;
      void process({ commandId, projectId }).then(
        (result) => {
          setProcessing(runProjectId, false);
          if (startedFor.current !== runProjectId) return;
          const terminal = result.run ?? legacyRun(runProjectId, commandId, result.repos);
          setRun(terminal);
          if (terminal.scout) setQuestionnaire(terminal.scout);
        },
        () => {
          setProcessing(runProjectId, false);
          if (startedFor.current === runProjectId)
            setRun(transportFailure(runProjectId, commandId));
        },
      );
    }
    return () => unsubscribe?.();
  }, [bridge, process, projectId]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") navigate(newChatPath());
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [navigate]);

  const phase = run?.phase ?? currentPhase(events);
  const terminal = run?.status === "done" || run?.status === "failed";
  const status =
    run?.status === "done"
      ? "indexed"
      : run?.status === "failed"
        ? "failed"
        : phase === "scout"
          ? "scouting"
          : "indexing";

  const ctaRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (terminal) ctaRef.current?.scrollIntoView?.({ behavior: "smooth", block: "center" });
  }, [terminal]);

  const background = useRennetStore(selectBackgroundEvents(projectId));
  const timeline = useMemo(
    () => [
      ...events.map((event) => ({ event, key: `foreground:${eventKey(event)}` })),
      ...background.map((event) => ({ event, key: `background:${eventKey(event)}` })),
    ],
    [events, background],
  );

  return (
    <section
      data-screen="project-indexing"
      data-status={status}
      className="flex h-full min-h-0 flex-1 flex-col overflow-hidden"
    >
      <header className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-3">
        <button
          type="button"
          onClick={() => navigate(newChatPath())}
          aria-label="Back"
          className="flex size-6 items-center justify-center rounded-control text-ink-faint hover:bg-raised hover:text-ink"
        >
          {/* Back is a back arrow. This control rendered a MAP glyph — a label that told
              the reviewer it opened the Context Map while it navigated to New Chat. */}
          <Icon icon={ArrowLeft} className="size-3.5" />
        </button>
        <span className="flex min-w-0 items-center gap-1.5 text-sm">
          <span className="shrink-0 font-medium text-ink">{project?.name ?? projectId}</span>
          <Icon icon={ChevronRight} className="size-2.5 shrink-0 text-muted-foreground/50" />
          <span className="text-ink-soft">{status}</span>
        </span>
        <kbd className="ml-auto rounded-chip border border-line px-1.5 py-0.5 text-2xs text-ink-faint">
          esc
        </kbd>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-[560px] flex-col gap-6 px-8 pt-[10vh] pb-16">
          {questionnaire ? <ScoutQuestionnaire questionnaire={questionnaire} /> : null}

          <div className="flex flex-col gap-2">
            {timeline.map(({ event, key }, index) => {
              const line = narrationLine(
                event,
                index === timeline.length - 1 && !terminal,
                terminal,
              );
              if (!line) return null;
              return <StepLine key={key} {...line} />;
            })}
            {!terminal &&
            timeline.every(({ event }) => narrationLine(event, false, false) === null) ? (
              <StepLine
                label={
                  phase === "scout"
                    ? "Reading the project"
                    : phase === "map"
                      ? "Building the structural map"
                      : "Building the knowledge map"
                }
                status="running"
              />
            ) : null}
          </div>

          {run && terminal ? <CompletionBlock run={run} ctaRef={ctaRef} /> : null}
        </div>
      </div>
    </section>
  );
}

function CompletionBlock({
  run,
  ctaRef,
}: {
  readonly run: ProjectProcessRun;
  readonly ctaRef: React.RefObject<HTMLButtonElement | null>;
}) {
  const [, navigate] = useLocation();
  const startReviewRef = useMergedRefs<HTMLButtonElement>(ctaRef, useCoachAnchor("start-review"));
  const ready = run.status === "done";
  const hasMap = ready || (run.status === "failed" && run.phase === "knowledge");
  const counts = ready
    ? `${run.totals.scopes} scopes · ${run.totals.files} files · ${run.totals.confirmed} confirmed · ${run.totals.rejected} rejected`
    : run.repos.length > 0
      ? `${run.repos.reduce((total, repo) => total + (repo.files ?? 0), 0)} files indexed`
      : "";

  return (
    <>
      <div className="flex flex-col gap-1.5 rounded-surface border border-line px-4 py-3.5">
        <div className="flex items-center gap-2">
          <Icon
            icon={ready ? Check : TriangleAlert}
            className={`size-4 shrink-0 ${ready ? "text-green" : "text-danger"}`}
          />
          <span className="text-sm font-medium text-ink">
            {ready ? "Context Map Ready" : `Project ${run.phase} failed`}
          </span>
          {counts ? <span className="truncate text-xs text-ink-soft">{counts}</span> : null}
          {hasMap ? (
            <button
              type="button"
              onClick={() => navigate(projectMapPath(run.projectId))}
              className="ml-auto flex shrink-0 items-center gap-1.5 rounded-control border border-line px-3 py-1.5 text-sm text-ink hover:bg-raised"
            >
              <Icon icon={MapIcon} className="size-3.5" />
              View Context Map
            </button>
          ) : null}
        </div>
        {run.status === "failed" ? (
          <span className="text-xs text-ink-soft">{run.reason}</span>
        ) : null}
      </div>

      <button
        ref={startReviewRef}
        type="button"
        onClick={() => navigate(newChatPath(run.projectId))}
        className="flex w-full items-center justify-center gap-2 rounded-surface bg-accent-fill px-6 py-4 text-base font-medium text-accent-ink hover:opacity-90"
      >
        <Icon icon={MessageSquarePlus} className="size-5" />
        Start a Review
      </button>
    </>
  );
}

const ANSWER_LABEL: Record<ProjectScoutAnswer["key"], string> = {
  trackerKind: "Issue tracker",
  defaultBranch: "Default branch",
  worktreeBaseDir: "Worktree location",
  gateCommand: "Gate command",
  logoPath: "Logo / mark",
};

function ProvenanceChip({ provenance }: { readonly provenance: ProjectScoutAnswer["provenance"] }) {
  return (
    <span
      className={
        provenance === "detected"
          ? "shrink-0 rounded-chip border border-line px-1.5 py-px text-2xs uppercase tracking-wide text-ink-faint"
          : "shrink-0 rounded-chip border border-model/40 px-1.5 py-px text-2xs uppercase tracking-wide text-model"
      }
    >
      {provenance}
    </span>
  );
}

function ScoutQuestionnaire({
  questionnaire,
}: {
  readonly questionnaire: ProjectScoutQuestionnaire;
}) {
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [dismissed, setDismissed] = useState(false);
  const currentValue = (answer: ProjectScoutAnswer) => edits[answer.key] ?? answer.value;
  const patch = (key: ProjectScoutAnswer["key"], value: string) =>
    setEdits((prior) => ({ ...prior, [key]: value }));

  function onFieldKeyDown(event: React.KeyboardEvent) {
    if (event.key === "Escape") {
      event.stopPropagation();
      (event.currentTarget as HTMLElement).blur();
    }
  }

  if (dismissed) {
    return (
      <div className="flex items-center gap-2 rounded-surface border border-line px-4 py-3">
        <Icon icon={Check} className="size-3.5 shrink-0 text-green" />
        <span className="text-sm text-ink-soft">Set these anytime in Settings → Projects</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 rounded-surface border border-line px-4 py-3.5">
      <div className="flex flex-col">
        <span className="flex items-center gap-2 text-sm font-medium text-ink">
          Scout finished — does this look right?
          <span className="text-xs font-normal text-ink-soft">
            {questionnaire.detected} detected · {questionnaire.guessed} guessed
          </span>
        </span>
        <span className="text-sm text-ink-soft">
          The map is already continuing. Skipping is fine; everything stays editable in Settings.
        </span>
      </div>

      <div className="flex flex-col divide-y divide-line">
        {questionnaire.answers.map((answer) => (
          <div key={answer.key} className="flex items-center gap-3 py-2">
            <div className="flex min-w-0 flex-col">
              <span className="flex items-center gap-1.5 text-sm font-medium text-ink">
                {ANSWER_LABEL[answer.key]}
                <ProvenanceChip provenance={answer.provenance} />
              </span>
              <span className="truncate text-xs text-ink-soft" title={answer.source}>
                {answer.hint} · {answer.source}
              </span>
            </div>
            <div className="ml-auto shrink-0">
              {answer.options ? (
                <ToggleGroup
                  value={[currentValue(answer)]}
                  onValueChange={(next: string[]) => {
                    if (next[0]) patch(answer.key, next[0]);
                  }}
                  aria-label={ANSWER_LABEL[answer.key]}
                >
                  {answer.options.map((option) => (
                    <Toggle key={option} value={option} size="sm">
                      {option}
                    </Toggle>
                  ))}
                </ToggleGroup>
              ) : (
                <input
                  value={currentValue(answer)}
                  onChange={(event) => patch(answer.key, event.target.value)}
                  onKeyDown={onFieldKeyDown}
                  aria-label={ANSWER_LABEL[answer.key]}
                  spellCheck={false}
                  className="w-48 rounded-control border border-line bg-surface px-2 py-1 font-mono text-xs text-ink focus-visible:border-accent-line focus-visible:outline-none"
                />
              )}
            </div>
          </div>
        ))}
      </div>

      <div>
        <button
          type="button"
          onClick={() => setDismissed(true)}
          className="rounded-control border border-line px-3 py-1.5 text-sm font-medium text-ink hover:bg-raised"
        >
          Looks right
        </button>
      </div>
    </div>
  );
}
