import type {
  ProcessedRepoSummary,
  Project,
  ProjectProcessEvent,
  RennetBridge,
} from "@rennet/protocol";
import { useEffect, useRef, useState } from "react";
import { ArrowRightIcon, CheckIcon, GitBranchIcon, SparkleIcon, TriangleIcon } from "./icons";

/**
 * The processing screen (issue #29, Rai's wireframe #2): after a project is added,
 * Rennet builds each included repo's ProjectSnapshot — the INITIAL CONTEXT DUMP.
 * A delightful spinner with LIVE narration that explains what it is doing in real
 * time. The narration is wired to the REAL generator stages streamed over the
 * bridge's `onProgress` channel (resolve → tree → workspace → conventions →
 * symbols → build → verify → store), never scripted text.
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

    const commandId = crypto.randomUUID();
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

  const view = deriveView(events, repos, project);

  if (phase === "failed") {
    return (
      <div className="processing">
        <p className="processing-failed" role="alert">
          <TriangleIcon size={15} />
          Could not start processing. {startError}
        </p>
        <div className="processing-actions">
          <button type="button" className="primary" onClick={onDone}>
            Back to projects
          </button>
        </div>
      </div>
    );
  }

  const done = phase === "done";
  return (
    <div className="processing" data-phase={phase}>
      <div className="processing-hero">
        <span className={`processing-orb${done ? " is-done" : ""}`} aria-hidden="true">
          {done ? <CheckIcon size={22} /> : <SparkleIcon size={20} />}
        </span>
        <p className="processing-headline" aria-live="polite">
          {done ? `${project.name} is ready` : view.headline}
        </p>
        <p className="processing-sub">
          {done ? view.doneSummary : view.sub}
        </p>
      </div>

      {view.repoBlocks.length > 0 ? (
        <div className="processing-repos">
          {view.repoBlocks.map((block) => (
            <RepoBlock key={block.repo} block={block} />
          ))}
        </div>
      ) : null}

      {done ? (
        <div className="processing-actions">
          <button type="button" className="ghost" onClick={onDone}>
            Back to projects
          </button>
          <button type="button" className="primary" onClick={onOpen}>
            Open {project.name}
            <ArrowRightIcon size={13} />
          </button>
        </div>
      ) : null}
    </div>
  );
}

/* ── one repo's live block ─────────────────────────────────────────────────── */

interface RepoBlockView {
  repo: string;
  state: "processing" | "done" | "error";
  /** The completed-stage trail (note + optional detail), oldest first. */
  trail: { stage: string; note: string; detail?: string }[];
  summary?: ProcessedRepoSummary;
  error?: string;
}

function RepoBlock({ block }: { block: RepoBlockView }) {
  return (
    <div className="processing-repo" data-state={block.state}>
      <p className="processing-repo-head">
        <span className="processing-repo-icon" aria-hidden="true">
          {block.state === "error" ? <TriangleIcon size={13} /> : <GitBranchIcon size={13} />}
        </span>
        <span className="processing-repo-name">{block.repo}</span>
        {block.state === "done" && block.summary ? (
          <span className="processing-repo-counts">{summaryLine(block.summary)}</span>
        ) : null}
        {block.state === "error" ? (
          <span className="processing-repo-counts is-error">{block.error}</span>
        ) : null}
      </p>
      {block.trail.length > 0 ? (
        <ol className="processing-trail">
          {block.trail.map((entry, index) => {
            const last = index === block.trail.length - 1;
            const active = block.state === "processing" && last;
            return (
              <li
                key={`${entry.stage}-${index}`}
                className={`processing-step${active ? " is-active" : ""}`}
              >
                <span className="processing-step-mark" aria-hidden="true">
                  {active ? <span className="processing-dot" /> : <CheckIcon size={12} />}
                </span>
                <span className="processing-step-note">{entry.note}</span>
                {entry.detail ? (
                  <span className="processing-step-detail">{entry.detail}</span>
                ) : null}
              </li>
            );
          })}
        </ol>
      ) : null}
    </div>
  );
}

/* ── deriving the view from the real event stream ──────────────────────────── */

interface ProcessingView {
  headline: string;
  sub: string;
  doneSummary: string;
  repoBlocks: RepoBlockView[];
}

/**
 * Fold the ordered event stream into a per-repo view. Every line comes from a
 * real event: the headline is the latest stage's note, the trail is the stages a
 * repo has actually completed, the counts are the built snapshot's real totals.
 */
function deriveView(
  events: readonly ProjectProcessEvent[],
  repos: readonly ProcessedRepoSummary[],
  project: Project,
): ProcessingView {
  const blocks = new Map<string, RepoBlockView>();
  function ensure(repo: string): RepoBlockView {
    const existing = blocks.get(repo);
    if (existing) return existing;
    const created: RepoBlockView = { repo, state: "processing", trail: [] };
    blocks.set(repo, created);
    return created;
  }

  let total = 0;
  let currentIndex = 0;
  let latestNote = "Getting ready";
  let latestDetail: string | undefined;
  let currentRepo: string | undefined;

  for (const event of events) {
    switch (event.kind) {
      case "repo-start": {
        total = event.total;
        currentIndex = event.index;
        currentRepo = event.repo;
        ensure(event.repo);
        latestNote = "Reading the repository";
        latestDetail = undefined;
        break;
      }
      case "stage": {
        const block = ensure(event.repo);
        // Collapse repeated emissions of the same stage (start then detail) into a
        // single trail row, upgrading it with the detail when it arrives.
        const tail = block.trail[block.trail.length - 1];
        if (tail && tail.stage === event.stage) {
          tail.note = event.note;
          if (event.detail) tail.detail = event.detail;
        } else {
          block.trail.push({ stage: event.stage, note: event.note, detail: event.detail });
        }
        currentRepo = event.repo;
        latestNote = event.note;
        latestDetail = event.detail;
        break;
      }
      case "repo-done": {
        const block = ensure(event.repo);
        block.state = "done";
        block.summary = event.summary;
        break;
      }
      case "repo-error": {
        const block = ensure(event.repo);
        block.state = "error";
        block.error = event.message;
        break;
      }
      case "done":
        break;
    }
  }

  // If the final summary arrived but per-repo events did not (degraded bridge),
  // synthesise blocks from the resolved summaries so the done state still reads.
  if (blocks.size === 0 && repos.length > 0) {
    for (const summary of repos)
      blocks.set(summary.repo, {
        repo: summary.repo,
        state: summary.ok ? "done" : "error",
        trail: [],
        summary: summary.ok ? summary : undefined,
        error: summary.ok ? undefined : summary.error,
      });
  }

  const headline = latestDetail ? `${latestNote} · ${latestDetail}` : latestNote;
  const sub =
    total > 1 && currentRepo
      ? `${currentRepo} — repo ${currentIndex} of ${total}`
      : currentRepo
        ? currentRepo
        : project.kind === "workspace"
          ? "Building the workspace map"
          : "Building the repo map";

  return {
    headline,
    sub,
    doneSummary: doneSummaryLine(repos, project),
    repoBlocks: [...blocks.values()],
  };
}

function doneSummaryLine(repos: readonly ProcessedRepoSummary[], project: Project): string {
  const ok = repos.filter((repo) => repo.ok);
  const failed = repos.length - ok.length;
  if (repos.length === 0) return "The context map is ready.";
  const files = ok.reduce((sum, repo) => sum + (repo.files ?? 0), 0);
  const symbols = ok.reduce((sum, repo) => sum + (repo.symbols ?? 0), 0);
  const repoWord = project.kind === "workspace" ? `${ok.length} repos · ` : "";
  const failedTail = failed > 0 ? ` · ${failed} could not be read` : "";
  return `${repoWord}${plural(files, "file")} mapped, ${plural(symbols, "symbol")} indexed${failedTail}`;
}

function summaryLine(summary: ProcessedRepoSummary): string {
  const parts = [plural(summary.files ?? 0, "file"), plural(summary.symbols ?? 0, "symbol")];
  if ((summary.references ?? 0) > 0) parts.push(plural(summary.references ?? 0, "reference"));
  return parts.join(" · ");
}

function plural(count: number, one: string): string {
  return `${count} ${count === 1 ? one : `${one}s`}`;
}
