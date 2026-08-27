import type { Project, ProjectProcessEvent } from "@rennet/protocol";
import { Toggle, ToggleGroup } from "@rennet/ui";
import { Check, Loader2, MapIcon, MessageSquarePlus } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";
import { Icon } from "../../components/icon";
import { useBridge, useCommand, useMutation } from "../../data";
import { newChatPath, projectMapPath } from "../../routes/url";

// ─────────────────────────────────────────────────────────────────────────────
// Project indexing view (C12 §10.4/§10.5, cluster 3: scout phase + questionnaire).
// The single surface where everything after Add happens. The scout runs first as
// its own progression, then the prefilled questionnaire appears the instant the
// scout returns while the context map generates beneath it (never a gate — the map
// completes and the exits appear whether or not the questionnaire is answered).
//
// Narration is driven by the REAL `project.process` `onProgress` channel (keyed by a
// per-project commandId), NOT the spike's 10.5s `setTimeout` — the view holds no
// timer. `useCommandStream` folds only into a command's output cache ({repos}), which
// cannot carry per-stage narration, so the raw events are accumulated the way the
// incumbent `components/project-processing.tsx` proved (an `onProgress` subscription;
// only `.invoke` is seam-fenced). The map-generation timeline detail + the rich ready
// card are cluster 4 — this cluster lands the scout, the questionnaire, and a minimal
// ready block + exits so the never-a-gate positive control can run.
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

interface ScoutAnswer {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly provenance: Provenance;
  readonly hint: string;
  /** Present ⇒ the value renders as a segmented pick instead of a monospace input. */
  readonly options?: readonly string[];
}

/** The scout's prefilled answers, seeded from the real project + whatever the scout
 *  narration named. Only fields a real signal backs read "detected"; the rest are an
 *  honest "guessed" (the full scout engine that detects them is B7 — this is its
 *  surface, so those values are editable defaults, never a claimed detection). */
function baseAnswers(project: Project | undefined, forge: string | undefined): ScoutAnswer[] {
  return [
    {
      id: "tracker",
      label: "Issue tracker",
      value: forge ?? "github",
      provenance: forge ? "detected" : "guessed",
      hint: forge
        ? "from the git remote — referenced tickets feed the review"
        : "no remote read yet — referenced tickets feed the review",
      options: ["github", "gitlab", "linear", "jira", "none"],
    },
    {
      id: "branch",
      label: "Default branch",
      value: project?.primaryBranch ?? "main",
      provenance: project ? "detected" : "guessed",
      hint: "from the remote HEAD",
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

/** A forge named anywhere in the scout narration (`detail`), for the tracker prefill. */
function forgeFrom(events: readonly ProjectProcessEvent[]): string | undefined {
  for (const event of events) {
    const detail = event.kind === "stage" ? (event.detail ?? "") : "";
    if (/gitlab/i.test(detail)) return "gitlab";
    if (/github/i.test(detail)) return "github";
  }
  return undefined;
}

/** The friendly narration line an event carries, or null for events with no step. */
function narrationLabel(event: ProjectProcessEvent): { label: string; detail?: string } | null {
  switch (event.kind) {
    case "stage":
      return { label: event.note, detail: event.detail };
    case "repo-start":
      return { label: `Building ${event.repo}`, detail: `${event.index}/${event.total}` };
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
  const [phase, setPhase] = useState<"running" | "done">("running");
  const startedFor = useRef<string>();

  // Drive the real context-map build once per project and accumulate its live
  // narration off the `project.process` `onProgress` channel. The commandId is stable
  // per project, so leaving and returning re-attaches to the same run (main replays
  // its backlog) rather than restarting it — the trigger is guarded to fire once, and a
  // direct hop to a different project resets the timeline before re-attaching.
  useEffect(() => {
    const commandId = processCommandId(projectId);
    const unsubscribe = bridge.onProgress?.(commandId, (event) => {
      setEvents((prior) => [...prior, { id: prior.length, event }]);
    });
    if (startedFor.current !== projectId) {
      startedFor.current = projectId;
      setEvents([]);
      setPhase("running");
      void process({ commandId, projectId }).then(
        () => setPhase("done"),
        () => setPhase("done"),
      );
    }
    return () => unsubscribe?.();
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

  const done = phase === "done";
  const firstRepoStart = events.findIndex((item) => item.event.kind === "repo-start");
  const scoutReturned = firstRepoStart !== -1 || done;
  const scoutEvents = firstRepoStart === -1 ? events : events.slice(0, firstRepoStart);
  const mapEvents = firstRepoStart === -1 ? [] : events.slice(firstRepoStart);
  const status = done ? "indexed" : scoutReturned ? "indexing" : "scouting";

  const forge = forgeFrom(scoutEvents.map((item) => item.event));
  const answers = useMemo(() => baseAnswers(project, forge), [project, forge]);
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
          {/* Scout phase */}
          <div className="flex flex-col gap-2">
            {scoutEvents.map((item, index) => {
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
            {scoutReturned ? (
              <StepLine
                label="Scout returned"
                detail={`${detected} detected · ${guessed} guessed`}
                running={false}
              />
            ) : (
              scoutEvents.length === 0 && <StepLine label="Scouting the project" running={true} />
            )}
          </div>

          {/* Questionnaire — appears the instant the scout returns, while the map cooks beneath */}
          {scoutReturned ? <ScoutQuestionnaire answers={answers} /> : null}

          {/* Map generation (minimal here; cluster 4 enriches the timeline + ready card) */}
          {scoutReturned ? (
            <div className="flex flex-col gap-2">
              {mapEvents.map((item, index) => {
                const line = narrationLabel(item.event);
                if (!line) return null;
                return (
                  <StepLine
                    key={item.id}
                    label={line.label}
                    detail={line.detail}
                    running={isLast(firstRepoStart + index)}
                  />
                );
              })}
            </div>
          ) : null}

          {done ? (
            <>
              <div className="flex items-center gap-2 rounded-surface border border-line px-4 py-3.5">
                <Icon icon={Check} className="size-4 shrink-0 text-green" />
                <span className="text-sm font-medium text-ink">Context Map Ready</span>
                <button
                  type="button"
                  onClick={() => navigate(projectMapPath(projectId))}
                  className="ml-auto flex items-center gap-1.5 rounded-control border border-line px-3 py-1.5 text-sm text-ink hover:bg-raised"
                >
                  <Icon icon={MapIcon} className="size-3.5" />
                  View Context Map
                </button>
              </div>

              <button
                ref={ctaRef}
                type="button"
                onClick={() => navigate(newChatPath(projectId))}
                className="flex w-full items-center justify-center gap-2 rounded-surface bg-accent-fill px-6 py-4 text-base font-medium text-accent-ink hover:opacity-90"
              >
                <Icon icon={MessageSquarePlus} className="size-5" />
                Start a Review
              </button>
            </>
          ) : null}
        </div>
      </div>
    </section>
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
 * The scout's answers, offered for confirmation while the map generates. Confirming is
 * optional and never a gate — answers apply as shown unless edited, and stay editable
 * in Settings → Projects. Escape inside a field blurs it (and stops the view's Escape),
 * never leaving the view. The logo/mark is cosmetic and never enters agent context.
 */
function ScoutQuestionnaire({ answers }: { answers: readonly ScoutAnswer[] }) {
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState(false);
  const currentValue = (answer: ScoutAnswer) => edits[answer.id] ?? answer.value;
  const patch = (id: string, value: string) => setEdits((prior) => ({ ...prior, [id]: value }));

  function onFieldKeyDown(event: React.KeyboardEvent) {
    if (event.key === "Escape") {
      event.stopPropagation();
      (event.currentTarget as HTMLElement).blur();
    }
  }

  if (saved) {
    return (
      <div className="flex items-center gap-2 rounded-surface border border-line px-4 py-3">
        <Icon icon={Check} className="size-3.5 shrink-0 text-green" />
        <span className="text-sm text-ink-soft">
          Project setup saved — editable anytime in Settings → Projects
        </span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 rounded-surface border border-line px-4 py-3.5">
      <div className="flex flex-col">
        <span className="text-sm font-medium text-ink">
          While the map generates — does this look right?
        </span>
        <span className="text-sm text-ink-soft">
          The scout prefilled these. Skipping is fine; everything stays editable in Settings.
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
          onClick={() => setSaved(true)}
          className="rounded-control border border-line px-3 py-1.5 text-sm font-medium text-ink hover:bg-raised"
        >
          Looks right
        </button>
      </div>
    </div>
  );
}
