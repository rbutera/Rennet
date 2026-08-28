import type { ProcessedRepoSummary, Project, ProjectProcessEvent } from "@rennet/protocol";
import { PROACTIVE_REHYDRATION_COMMAND_ID } from "@rennet/protocol";
import { Toggle, ToggleGroup } from "@rennet/ui";
import { Check, Loader2, MapIcon, MessageSquarePlus } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";
import { useCoachAnchor, useMergedRefs } from "../../coach/registry";
import { Icon } from "../../components/icon";
import { useBridge, useCommand, useMutation } from "../../data";
import { newChatPath, projectMapPath } from "../../routes/url";
import { useRennetStore } from "../../store";

// ─────────────────────────────────────────────────────────────────────────────
// Project indexing view (C12 §10.4/§10.5). The single surface where everything after
// Add happens: the context map generates while a prefilled questionnaire offers the
// project's setup for confirmation (never a gate — the map completes and the exits
// appear whether or not the questionnaire is answered).
//
// Narration is driven by the REAL `project.process` `onProgress` channel (keyed by a
// per-project commandId), NOT the spike's 10.5s `setTimeout` — the view holds no timer.
// The one honest event ORDER (verified against `server/process-project.ts`): per repo,
// `repo-start` → `stage`* → `repo-done`/`repo-error`, then the command resolves with the
// per-repo summaries. This IS the map build; there is no scout narration on this channel
// (the deterministic scout runs at ADD time via `project.discover`, and the model-backed
// scout — B7 — fires server-side after processing with no client-reachable progress key).
// So the view does NOT fabricate a scout-vs-map split from these events: it renders one
// build timeline and prefills the questionnaire from the real project. The completion
// block distinguishes ready / partial / failed / map-unavailable — it never calls a
// transport error or an all-failed run "Context Map Ready".
// ─────────────────────────────────────────────────────────────────────────────

/** One stable protocol-valid commandId per project, so a remount re-attaches to the
 *  main-owned live run (leaving early never cancels it) instead of minting a fresh one. */
const processCommandIds = new Map<string, string>();
function processCommandId(projectId: string): string {
  const existing = processCommandIds.get(projectId);
  if (existing) return existing;
  const created = crypto.randomUUID();
  processCommandIds.set(projectId, created);
  return created;
}

type Provenance = "detected" | "guessed";

/** The build's terminal state once `project.process` resolves (or errors). */
type Outcome = "running" | "ready" | "partial" | "failed";

interface ScoutAnswer {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly provenance: Provenance;
  readonly hint: string;
  /** Present ⇒ the value renders as a segmented pick instead of a monospace input. */
  readonly options?: readonly string[];
}

/** The prefilled setup answers. Only the default branch has a real signal in this view
 *  (the project's confirmed primary branch, from `project.discover` at add time) and
 *  reads "detected"; the rest are honest "guessed" editable defaults — the model-backed
 *  scout that would detect them is B7, server-side, with no client-reachable signal here,
 *  so this view never CLAIMS a detection it cannot see. */
function baseAnswers(project: Project | undefined): ScoutAnswer[] {
  return [
    {
      id: "tracker",
      label: "Issue tracker",
      value: "github",
      provenance: "guessed",
      hint: "referenced tickets feed the review — set the tracker in Settings",
      options: ["github", "gitlab", "linear", "jira", "none"],
    },
    {
      id: "branch",
      label: "Default branch",
      value: project?.primaryBranch ?? "main",
      provenance: project ? "detected" : "guessed",
      hint: "the project's confirmed primary branch",
    },
    {
      id: "worktrees",
      label: "Worktree location",
      value: "~/.rennet/worktrees",
      provenance: "guessed",
      hint: "no in-repo convention found — rounds check out here",
    },
    {
      id: "gate",
      label: "Gate command",
      value: "pnpm check",
      provenance: "guessed",
      hint: "rounds run this before handing work back",
    },
    {
      id: "logo",
      label: "Logo / mark",
      value: "",
      provenance: "guessed",
      hint: "cosmetic — shown in the sidebar, never enters agent context",
    },
  ];
}

/** The friendly narration line an event carries, or null for events with no step. */
function narrationLabel(event: ProjectProcessEvent): { label: string; detail?: string } | null {
  switch (event.kind) {
    case "stage":
      return { label: event.note, detail: event.detail };
    case "repo-start":
      return { label: `Building ${event.repo}`, detail: `${event.index}/${event.total}` };
    case "repo-done": {
      // Real counts from the built snapshot summary — never scripted (the spike's
      // "456 files · 12 scopes" was fixture text; these come off the wire).
      const parts = [
        event.summary.files != null ? `${event.summary.files} files` : null,
        event.summary.symbols != null ? `${event.summary.symbols} symbols` : null,
      ].filter(Boolean);
      return { label: `Built ${event.repo}`, detail: parts.length ? parts.join(" · ") : undefined };
    }
    case "repo-error":
      return { label: `${event.repo} failed`, detail: event.message };
    default:
      return null;
  }
}

function StepLine({
  label,
  detail,
  running,
}: {
  label: string;
  detail?: string;
  running: boolean;
}) {
  return (
    <div className="flex items-center gap-2 text-sm">
      {running ? (
        <Icon icon={Loader2} className="size-3.5 shrink-0 animate-spin text-model" />
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
  // Each event carries a stable append-only id (its insertion length) so the timeline
  // keys are stable without an array index.
  const [events, setEvents] = useState<{ id: number; event: ProjectProcessEvent }[]>([]);
  // The build's outcome. `running` until the command resolves, then classified from the
  // per-repo summaries: every repo ok ⇒ ready; some failed ⇒ partial; all failed (or a
  // transport error) ⇒ failed. A transport error and an all-failed run are NEVER "ready".
  const [outcome, setOutcome] = useState<Outcome>("running");
  // The per-repo summaries the run resolves with — real file/symbol counts for the ready card.
  const [summaries, setSummaries] = useState<readonly ProcessedRepoSummary[]>([]);
  const startedFor = useRef<string | undefined>(undefined);

  // Drive the real context-map build once per project and accumulate its live narration
  // off the `project.process` `onProgress` channel. The commandId is stable per project,
  // so leaving and returning re-attaches to the same run (main replays its backlog) rather
  // than restarting it — the trigger is guarded to fire once, and a direct hop to a
  // different project resets the timeline before re-attaching.
  useEffect(() => {
    const commandId = processCommandId(projectId);
    const append = (event: ProjectProcessEvent) =>
      setEvents((prior) => [...prior, { id: prior.length, event }]);
    const unsubscribe = bridge.onProgress?.(commandId, append);
    // The background rehydration channel carries the knowledge swarm's lines,
    // which run AFTER `project.process` resolves and under a different, stable
    // command id. Nothing subscribed to it, so the whole knowledge pass — its
    // per-partition progress and its failure reason alike — was invisible.
    const unsubscribeBackground = bridge.onProgress?.(PROACTIVE_REHYDRATION_COMMAND_ID, append);
    if (startedFor.current !== projectId) {
      startedFor.current = projectId;
      setEvents([]);
      setOutcome("running");
      // The sidebar's indexing spinner tracks THIS run, not this mounted screen:
      // set on start, cleared only when the run resolves — leaving never cancels it.
      const setProcessing = useRennetStore.getState().uiActions.setProjectProcessing;
      setProcessing(projectId, true);
      // Bind the resolution to THIS run's project so a late resolution can't paint a
      // DIFFERENT project's view (run-identity guard): the spinner clears for this run
      // regardless, but the outcome/summaries land only while the view still shows it.
      const runProjectId = projectId;
      const finishRun = (result?: { repos: readonly ProcessedRepoSummary[] }) => {
        setProcessing(runProjectId, false);
        if (startedFor.current !== runProjectId) return; // navigated away — do not paint
        if (!result) {
          setOutcome("failed"); // a transport error is a failure, never "ready"
          return;
        }
        setSummaries(result.repos);
        const failed = result.repos.filter((repo) => !repo.ok).length;
        setOutcome(failed === 0 ? "ready" : failed === result.repos.length ? "failed" : "partial");
      };
      void process({ commandId, projectId }).then(finishRun, () => finishRun());
    }
    return () => {
      unsubscribe?.();
      unsubscribeBackground?.();
    };
  }, [bridge, projectId, process]);

  // Escape leaves the view (a field's own Escape blurs it and stops here — see the
  // input handler below). Leaving does not cancel: the run keeps its commandId.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") navigate(newChatPath());
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [navigate]);

  const done = outcome !== "running";
  const status = !done ? "indexing" : outcome === "ready" ? "indexed" : outcome;

  const answers = useMemo(() => baseAnswers(project), [project]);
  const detected = answers.filter((answer) => answer.provenance === "detected").length;
  const guessed = answers.length - detected;

  // The Start-a-Review CTA sits at the bottom of a scrolled timeline — bring it on
  // screen the moment the map completes.
  const ctaRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (done) ctaRef.current?.scrollIntoView?.({ behavior: "smooth", block: "center" });
  }, [done]);

  const isLast = (index: number) => index === events.length - 1 && !done;

  return (
    <section
      data-screen="project-indexing"
      data-status={status}
      className="flex h-full min-h-0 flex-1 flex-col overflow-hidden"
    >
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-line px-4">
        <button
          type="button"
          onClick={() => navigate(newChatPath())}
          aria-label="Back"
          className="flex size-7 items-center justify-center rounded-control text-ink-faint hover:bg-raised hover:text-ink"
        >
          <Icon icon={MapIcon} className="size-4" />
        </button>
        <span className="flex min-w-0 items-center gap-1.5 text-sm">
          <span className="shrink-0 font-medium text-ink">{project?.name ?? projectId}</span>
          <span className="text-ink-faint">›</span>
          <span className="text-ink-soft">{status}</span>
        </span>
        <kbd className="ml-auto rounded-chip border border-line px-1.5 py-0.5 text-2xs text-ink-faint">
          esc
        </kbd>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-[560px] flex-col gap-6 px-8 pt-[10vh] pb-16">
          {/* The prefilled setup, offered the moment the view opens (the deterministic scout
              already ran at add time) while the map builds beneath. Never a gate. */}
          <ScoutQuestionnaire answers={answers} detected={detected} guessed={guessed} />

          {/* The map build timeline — the one honest `project.process` event stream. */}
          <div className="flex flex-col gap-2">
            {events.map((item, index) => {
              const line = narrationLabel(item.event);
              if (!line) return null;
              return (
                <StepLine
                  key={item.id}
                  label={line.label}
                  detail={line.detail}
                  running={isLast(index)}
                />
              );
            })}
            {!done && events.length === 0 ? (
              <StepLine label="Indexing the project" running={true} />
            ) : null}
          </div>

          {done ? (
            <CompletionBlock
              projectId={projectId}
              outcome={outcome}
              summaries={summaries}
              ctaRef={ctaRef}
            />
          ) : null}
        </div>
      </div>
    </section>
  );
}

/**
 * The completion block (§10.7) — mounted only once the run resolves, so its
 * `project.contextMap` read hits the freshly-built snapshot. It states the HONEST outcome
 * rather than always claiming readiness: a run whose every repo failed (or that errored in
 * transport) reads "Indexing failed"; a run with some repos failed reads "partial"; a run
 * that finished but produced no queryable map reads "map isn't ready yet" — only an all-ok
 * run with a real map reads "Context Map Ready". View Context Map shows only when a map
 * actually exists; the full-width Start a Review CTA is always offered (Rule Zero — a
 * failed index never blocks the reviewer), scrolled into view by the parent.
 */
function CompletionBlock({
  projectId,
  outcome,
  summaries,
  ctaRef,
}: {
  readonly projectId: string;
  readonly outcome: Outcome;
  readonly summaries: readonly ProcessedRepoSummary[];
  readonly ctaRef: React.RefObject<HTMLButtonElement | null>;
}) {
  const [, navigate] = useLocation();
  // The `start-review` coach mark anchors this CTA (system-order first, so it wins on the
  // indexing-ready surface). Merge with `ctaRef` — that ref already scrolls it into view.
  const startReviewRef = useMergedRefs<HTMLButtonElement>(ctaRef, useCoachAnchor("start-review"));
  const { data: contextMap } = useCommand("project.contextMap", { projectId });
  const map = contextMap?.status === "ok" ? contextMap : undefined;
  // Loaded but not "ok" (absent / error) — a real signal the map didn't materialise, as
  // distinct from "not loaded yet" (undefined). A finished build with no map is not "ready".
  const mapUnavailable = contextMap != null && contextMap.status !== "ok";

  const files = summaries.reduce((total, repo) => total + (repo.files ?? 0), 0);
  const scopes = map?.map.scopes.length;
  const confirmed = map?.knowledge?.statements.filter((s) => s.status === "confirmed").length;
  const rejected = map?.knowledge?.statements.filter((s) => s.status === "rejected").length;
  const counts = [
    scopes != null ? `${scopes} scopes` : null,
    `${files} files`,
    confirmed != null && rejected != null ? `${confirmed} confirmed · ${rejected} rejected` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const failedRepos = summaries.filter((repo) => !repo.ok);

  // The honest state: a failed/partial run, or an ok run whose map didn't materialise.
  const state =
    outcome === "failed"
      ? "failed"
      : outcome === "partial"
        ? "partial"
        : mapUnavailable
          ? "unavailable"
          : "ready";
  const heading =
    state === "ready"
      ? "Context Map Ready"
      : state === "partial"
        ? "Context map built — some repositories didn't index"
        : state === "unavailable"
          ? "Indexing finished — the context map isn't ready yet"
          : "Indexing failed";
  const tone = state === "ready" ? "text-green" : "text-danger";
  const hasMap = state === "ready" || state === "partial";

  return (
    <>
      <div className="flex flex-col gap-1.5 rounded-surface border border-line px-4 py-3.5">
        <div className="flex items-center gap-2">
          <Icon icon={Check} className={`size-4 shrink-0 ${tone}`} />
          <span className="text-sm font-medium text-ink">{heading}</span>
          {counts ? <span className="truncate text-xs text-ink-soft">{counts}</span> : null}
          {hasMap ? (
            <button
              type="button"
              onClick={() => navigate(projectMapPath(projectId))}
              className="ml-auto flex shrink-0 items-center gap-1.5 rounded-control border border-line px-3 py-1.5 text-sm text-ink hover:bg-raised"
            >
              <Icon icon={MapIcon} className="size-3.5" />
              View Context Map
            </button>
          ) : null}
        </div>
        {failedRepos.length > 0 ? (
          <span className="text-xs text-ink-soft">
            Didn't index: {failedRepos.map((repo) => repo.repo).join(", ")}
          </span>
        ) : null}
      </div>

      <button
        ref={startReviewRef}
        type="button"
        onClick={() => navigate(newChatPath(projectId))}
        className="flex w-full items-center justify-center gap-2 rounded-surface bg-accent-fill px-6 py-4 text-base font-medium text-accent-ink hover:opacity-90"
      >
        <Icon icon={MessageSquarePlus} className="size-5" />
        Start a Review
      </button>
    </>
  );
}

function ProvenanceChip({ provenance }: { provenance: Provenance }) {
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

/**
 * The prefilled setup, offered for confirmation while the map generates. Confirming is
 * optional and never a gate — answers apply as shown unless edited, and stay editable in
 * Settings → Projects. Escape inside a field blurs it (and stops the view's Escape), never
 * leaving the view. The logo/mark is cosmetic and never enters agent context.
 *
 * ponytail: edits live in component state only. There is no project-config WRITE command in
 * the protocol yet (Settings → Projects is C10), so "Looks right" does NOT claim it saved —
 * it dismisses the card and points the reviewer at Settings, where the real edit will land.
 */
function ScoutQuestionnaire({
  answers,
  detected,
  guessed,
}: {
  readonly answers: readonly ScoutAnswer[];
  readonly detected: number;
  readonly guessed: number;
}) {
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [dismissed, setDismissed] = useState(false);
  const currentValue = (answer: ScoutAnswer) => edits[answer.id] ?? answer.value;
  const patch = (id: string, value: string) => setEdits((prior) => ({ ...prior, [id]: value }));

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
          While the map generates — does this look right?
          <span className="text-xs font-normal text-ink-soft">
            {detected} detected · {guessed} guessed
          </span>
        </span>
        <span className="text-sm text-ink-soft">
          Prefilled from the project. Skipping is fine; everything stays editable in Settings.
        </span>
      </div>

      <div className="flex flex-col divide-y divide-line">
        {answers.map((answer) => (
          <div key={answer.id} className="flex items-center gap-3 py-2">
            <div className="flex min-w-0 flex-col">
              <span className="flex items-center gap-1.5 text-sm font-medium text-ink">
                {answer.label}
                <ProvenanceChip provenance={answer.provenance} />
              </span>
              <span className="truncate text-xs text-ink-soft">{answer.hint}</span>
            </div>
            <div className="ml-auto shrink-0">
              {answer.options ? (
                <ToggleGroup
                  value={[currentValue(answer)]}
                  onValueChange={(next: string[]) => {
                    if (next[0]) patch(answer.id, next[0]);
                  }}
                  aria-label={answer.label}
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
                  onChange={(event) => patch(answer.id, event.target.value)}
                  onKeyDown={onFieldKeyDown}
                  aria-label={answer.label}
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
