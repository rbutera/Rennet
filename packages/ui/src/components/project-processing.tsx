import type {
  ProcessedRepoSummary,
  Project,
  ProjectProcessEvent,
  RennetBridge,
} from "@rennet/protocol";
import { useEffect, useRef, useState } from "react";
import { ArrowRightIcon, CheckIcon, SparkleIcon, TriangleIcon } from "./icons";
import { ProgressFeed } from "./progress-feed";
import { deriveProgressView } from "./progress-feed-fold";

const processCommandIds = new Map<string, string>();

function processCommandId(projectId: string): string {
  const existing = processCommandIds.get(projectId);
  if (existing) return existing;
  const created = crypto.randomUUID();
  processCommandIds.set(projectId, created);
  return created;
}

/**
 * The processing screen (issue #29, Rai's wireframe #2): after a project is added,
 * Rennet builds each included repo's ProjectSnapshot — the INITIAL CONTEXT DUMP.
 * A delightful spinner with LIVE narration that explains what it is doing in real
 * time. The narration is wired to the REAL generator stages streamed over the
 * bridge's `onProgress` channel (resolve → tree → workspace → conventions →
 * symbols → build → verify → store), never scripted text.
 *
 * The event-fold and the per-repo trail rendering now live in the SHARED narration
 * organ (`ProgressFeed` + `deriveProgressView`, issue #71): this screen is its first
 * live consumer. Context refresh and capture/review remain intended consumers;
 * their production wiring is tracked by the unchecked issue #71 tasks.
 *
 * When the bridge has no push channel the screen degrades gracefully: a calm
 * spinner, then the completion summary from the command's resolved value. No gate,
 * no model spend — the snapshot build is pure over git.
 */
export function ProjectProcessing({
  bridge,
  project,
  onDone,
  onOpen,
}: {
  bridge: RennetBridge;
  project: Project;
  /** Finish: return to the projects list (the project is already persisted). */
  onDone(): void;
  /** Open the freshly-processed project straight into its detail. */
  onOpen(): void;
}) {
  const [events, setEvents] = useState<ProjectProcessEvent[]>([]);
  const [phase, setPhase] = useState<"running" | "done" | "failed">("running");
  const [repos, setRepos] = useState<ProcessedRepoSummary[]>([]);
  const [startError, setStartError] = useState<string>();
  const started = useRef(false);

  useEffect(() => {
    // Build once per mount — a second `project.process` would rebuild the same
    // snapshot and double the narration.
    if (started.current) return;
    started.current = true;

    // Keep one protocol-valid command UUID per project for this renderer session,
    // so a remount re-attaches to the main-owned live run instead of minting a
    // fresh identity. Main deduplicates concurrent invocations and replays the
    // bounded live backlog; `started` only guards this mount.
    const commandId = processCommandId(project.id);
    const unsubscribe = bridge.onProgress?.(commandId, (event) => {
      setEvents((prior) => [...prior, event]);
      if (event.kind === "done") setRepos(event.repos);
    });

    bridge
      .invoke("project.process", { commandId, projectId: project.id })
      .then(({ repos: built }) => {
        setRepos((prior) => (prior.length > 0 ? prior : built));
        setPhase("done");
      })
      .catch((reason: unknown) => {
        setStartError(reason instanceof Error ? reason.message : String(reason));
        setPhase("failed");
      });

    return () => unsubscribe?.();
  }, [bridge, project.id]);

  const view = deriveProgressView(events, repos, project);

  if (phase === "failed") {
    return (
      <div className="processing self-center w-[min(520px,100%)] mt-5 flex flex-col gap-5">
        <p
          className="processing-failed flex items-center gap-2 mt-5 px-3.5 py-3 rounded-chip border border-danger bg-danger-soft text-ink text-base"
          role="alert"
        >
          <TriangleIcon size={15} />
          Could not start processing. {startError}
        </p>
        <div className="processing-actions flex items-center gap-3 mt-1">
          <button
            type="button"
            className="primary ml-auto inline-flex items-center gap-1.5 px-4 py-2.5 rounded-control bg-accent-fill text-accent-ink font-semibold hover:brightness-105"
            onClick={onDone}
          >
            Back to projects
          </button>
        </div>
      </div>
    );
  }

  const done = phase === "done";
  // A context dump where EVERY repo failed is not a success: no "ready", no Open.
  // A workspace with at least one good repo is still a (partial) success.
  const allFailed = done && repos.length > 0 && repos.every((repo) => !repo.ok);
  const succeeded = done && !allFailed;
  const outcome = done ? (allFailed ? "failed" : "ok") : undefined;
  return (
    <div
      className="processing self-center w-[min(520px,100%)] mt-5 flex flex-col gap-5"
      data-phase={phase}
      data-outcome={outcome}
    >
      <div className="processing-hero flex flex-col items-center text-center gap-2 pt-5 pb-1.5">
        <span
          className={`processing-orb relative inline-flex items-center justify-center w-16 h-16 rounded-full ${allFailed ? "is-failed text-danger bg-danger-soft" : succeeded ? "is-done text-accent-ink bg-accent-fill" : "text-accent bg-accent-surface"}`}
          aria-hidden="true"
        >
          {allFailed ? (
            <TriangleIcon size={20} />
          ) : succeeded ? (
            <CheckIcon size={22} />
          ) : (
            <SparkleIcon size={20} />
          )}
        </span>
        <p className="processing-headline mt-1.5 font-display text-2xl text-ink" aria-live="polite">
          {allFailed
            ? `Couldn't process ${project.name}`
            : succeeded
              ? `${project.name} is ready`
              : view.headline}
        </p>
        <p className="processing-sub text-base text-ink-faint">
          {allFailed ? view.failedSummary : done ? view.doneSummary : view.sub}
        </p>
      </div>

      <ProgressFeed
        blocks={view.repoBlocks}
        onAnchor={(artifact) => {
          if (artifact.kind === "project" && artifact.projectId === project.id) onOpen();
        }}
      />

      {done ? (
        <div className="processing-actions flex items-center gap-3 mt-1">
          <button
            type="button"
            className="ghost px-4 py-2.5 rounded-control border border-line text-ink-soft font-semibold hover:bg-raised hover:text-ink"
            onClick={onDone}
          >
            Back to projects
          </button>
          {succeeded ? (
            <button
              type="button"
              className="primary ml-auto inline-flex items-center gap-1.5 px-4 py-2.5 rounded-control bg-accent-fill text-accent-ink font-semibold hover:brightness-105"
              onClick={onOpen}
            >
              Open {project.name}
              <ArrowRightIcon size={13} />
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
