import type {
  ProcessedRepoSummary,
  ProgressArtifactRef,
  Project,
  ProjectProcessEvent,
} from "@rennet/protocol";

/**
 * The shared narration-feed fold (issue #71). This is the ONE pure fold every
 * narrated slot's feed derives from — extracted verbatim from the processing
 * screen's private `deriveView` so there is a single organ, not a copy per slot.
 *
 * It folds an ordered `ProjectProcessEvent[]` (plus the command's resolved
 * per-repo summary) into a per-repo view: a headline (the latest real stage note),
 * a per-repo trail of the stages a repo has actually completed, and the real
 * counts from the built snapshot. Every line comes from a real emitted event —
 * never scripted text.
 *
 * Unknown event kinds are skipped, never thrown on, so the progress-event union
 * can keep growing (the capture/review milestones, #71) without breaking older
 * consumers of this fold.
 */

/** One repo's live block: its completed-stage trail and outcome. */
export interface RepoBlockView {
  repo: string;
  state: "processing" | "done" | "error";
  /** The completed-stage trail (note + optional detail), oldest first. */
  trail: { stage: string; note: string; detail?: string }[];
  summary?: ProcessedRepoSummary;
  error?: string;
  /**
   * The artifact this landed block produced, when the terminal event carried one
   * (#71 anchoring). A block with no anchor is honestly inert — never a dead link.
   */
  anchor?: ProgressArtifactRef;
}

/** The whole feed view: the hero lines plus the per-repo blocks. */
export interface ProcessingView {
  headline: string;
  sub: string;
  doneSummary: string;
  /** The sub-line for the all-repos-failed completion state. */
  failedSummary: string;
  repoBlocks: RepoBlockView[];
}

/**
 * Fold the ordered event stream into a per-repo view. Every line comes from a
 * real event: the headline is the latest stage's note, the trail is the stages a
 * repo has actually completed, the counts are the built snapshot's real totals.
 */
export function deriveProgressView(
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
        if (event.artifact) block.anchor = event.artifact;
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
      // Unknown / not-repo-shaped kinds (the capture/review milestones, #71) are
      // tolerated: they never belong to a repo trail, so this fold skips them. A
      // capture/review slot renders through the same organ over its own fold.
      default:
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
    failedSummary: failedSummaryLine(repos, project),
    repoBlocks: [...blocks.values()],
  };
}

export function failedSummaryLine(
  repos: readonly ProcessedRepoSummary[],
  project: Project,
): string {
  const noun = project.kind === "workspace" ? "repositories" : "repository";
  if (repos.length > 1) return `None of the ${repos.length} ${noun} could be read.`;
  const only = repos[0];
  return only?.error
    ? `The ${noun} could not be read: ${only.error}`
    : `The ${noun} could not be read.`;
}

export function doneSummaryLine(repos: readonly ProcessedRepoSummary[], project: Project): string {
  const ok = repos.filter((repo) => repo.ok);
  const failed = repos.length - ok.length;
  if (repos.length === 0) return "The context map is ready.";
  const files = ok.reduce((sum, repo) => sum + (repo.files ?? 0), 0);
  const symbols = ok.reduce((sum, repo) => sum + (repo.symbols ?? 0), 0);
  const repoWord = project.kind === "workspace" ? `${ok.length} repos · ` : "";
  const failedTail = failed > 0 ? ` · ${failed} could not be read` : "";
  return `${repoWord}${plural(files, "file")} mapped, ${plural(symbols, "symbol")} indexed${failedTail}`;
}

export function summaryLine(summary: ProcessedRepoSummary): string {
  const parts = [plural(summary.files ?? 0, "file"), plural(summary.symbols ?? 0, "symbol")];
  if ((summary.references ?? 0) > 0) parts.push(plural(summary.references ?? 0, "reference"));
  return parts.join(" · ");
}

function plural(count: number, one: string): string {
  return `${count} ${count === 1 ? one : `${one}s`}`;
}
