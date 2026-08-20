import type {
  DetectedHarness,
  DiscoveredRepo,
  DiscoveryResult,
  Project,
  ProjectKind,
  RennetBridge,
} from "@rennet/protocol";
import { type ReactNode, useEffect, useState } from "react";
import { messageFrom } from "../lib/message-from";
import { GitHubConnectCard } from "./github-connect";
import {
  ArrowRightIcon,
  ChevronIcon,
  FolderIcon,
  GitBranchIcon,
  MonitorIcon,
  PlusIcon,
  SlidersIcon,
  SparkleIcon,
} from "./icons";
import { ProjectProcessing } from "./project-processing";
import { ChromeMark } from "./update-ready";

/**
 * The front door (issue #29). The empty projects list IS first run; the
 * add-a-project flow that lives there forever is the whole onboarding — no wizard,
 * no ceremony. The only vocabulary the user meets is WORKSPACE and PROJECT REPO;
 * everything else is inference. Discovery shows what it found as EDITABLE DEFAULTS,
 * never questions.
 *
 * Chrome is terse (Design Doctrine §4: four-words-or-fewer, no editorial copy);
 * the harness-detection line is ambient backlight, felt not ceremonial. Opening a
 * project into its two-zone detail is a later slice; a row here opens the review
 * surface directly for now (the reviewable open target MAIN derived).
 */
export function FrontDoor({
  bridge,
  onOpenProject,
  onOpenSettings,
  scheme,
}: {
  bridge: RennetBridge;
  onOpenProject(project: Project): void;
  /** Open the settings screen (wireframe #15). Omitted ⇒ no settings affordance. */
  onOpenSettings?(): void;
  /** The resolved appearance scheme (system already folded to dark/light upstream). */
  scheme?: "dark" | "light";
}) {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [detected, setDetected] = useState<DetectedHarness[] | null>(null);
  const [flow, setFlow] = useState<AddFlow | null>(null);
  const [error, setError] = useState<string>();

  useEffect(() => {
    bridge
      .invoke("projects.list", {})
      .then(({ projects: loaded }) => setProjects(loaded))
      .catch((reason: unknown) => {
        setProjects([]);
        setError(messageFrom(reason));
      });
  }, [bridge]);

  // The ambient detection line loads independently and never blocks the list.
  useEffect(() => {
    bridge
      .invoke("harness.detect", {})
      .then(({ detected: found }) => setDetected(found))
      .catch(() => setDetected([]));
  }, [bridge]);

  function afterAdd(next: Project[]): void {
    setProjects(next);
    setFlow(null);
  }

  return (
    <div
      className="rennet-glass front-door min-h-screen flex flex-col items-center bg-canvas px-6 pb-24"
      data-scheme={scheme ?? "dark"}
    >
      <header className="front-door-bar w-full max-w-[760px] flex items-center gap-3 pt-8 pb-3">
        {flow ? (
          <span
            className="front-door-mark flex-none w-8 h-8 grid place-items-center rounded-control border border-accent-line bg-accent-soft text-accent"
            aria-hidden="true"
          >
            {flow.step === "processing" ? <SparkleIcon size={18} /> : <PlusIcon size={16} />}
          </span>
        ) : (
          <ChromeMark
            size={16}
            className="front-door-mark flex-none w-8 h-8 grid place-items-center rounded-control border border-accent-line bg-accent-soft text-accent"
          />
        )}
        <h1 className="font-display text-display leading-none text-ink">
          {flow?.step === "processing" ? flow.project.name : flow ? "Add a project" : "Rennet"}
        </h1>
        {flow && flow.step !== "processing" ? (
          <span className="front-door-step ml-auto text-sm text-ink-faint">
            step {flow.step === "type-path" ? 1 : 2} of 2
          </span>
        ) : null}
        {flow?.step === "processing" ? (
          <span className="front-door-step ml-auto text-sm text-ink-faint">processing</span>
        ) : null}
        {onOpenSettings && !flow ? (
          <button
            type="button"
            className="front-door-settings ml-auto flex-none w-8 h-8 grid place-items-center rounded-control border border-line text-ink-soft hover:bg-raised hover:text-ink"
            onClick={onOpenSettings}
            title="Settings"
            aria-label="Settings"
          >
            <SlidersIcon size={16} />
          </button>
        ) : null}
      </header>

      {error ? (
        <p className="front-door-error w-full max-w-[760px] mb-3 px-3.5 py-2.5 rounded-chip border border-danger bg-danger-soft text-ink text-base">
          {error}
        </p>
      ) : null}

      {flow ? (
        <AddProject
          bridge={bridge}
          flow={flow}
          projects={projects ?? []}
          onFlow={setFlow}
          onAdded={afterAdd}
          onOpenProject={onOpenProject}
          onError={setError}
        />
      ) : (
        <ProjectsList
          projects={projects}
          detected={detected}
          bridge={bridge}
          onAdd={() => setFlow({ step: "type-path", kind: "workspace", busy: false })}
          onOpen={onOpenProject}
        />
      )}
    </div>
  );
}

/* ── The projects list (empty + populated) ─────────────────────────────────── */

function ProjectsList({
  projects,
  detected,
  bridge,
  onAdd,
  onOpen,
}: {
  projects: Project[] | null;
  detected: DetectedHarness[] | null;
  bridge: RennetBridge;
  onAdd(): void;
  onOpen(project: Project): void;
}) {
  if (projects === null)
    return <p className="front-door-loading mt-20 text-base text-ink-faint">Loading projects…</p>;

  const empty = projects.length === 0;
  return (
    <div className="projects w-full max-w-[760px] flex flex-col">
      <p className="eyebrow projects-eyebrow mt-1.5 mb-5 text-2xs font-semibold uppercase tracking-wide text-ink-faint">
        {empty ? "PROJECTS · NONE YET" : `PROJECTS · ${projects.length}`}
      </p>

      {empty ? (
        <button
          type="button"
          className="add-card self-center w-[min(420px,100%)] flex flex-col items-center gap-2 mt-6 px-6 py-10 rounded-surface border border-dashed border-line-strong text-ink transition-colors hover:border-accent-line hover:bg-accent-soft"
          onClick={onAdd}
        >
          <span
            className="add-card-plus w-11 h-11 grid place-items-center mb-2 rounded-surface border border-line-strong text-ink-soft"
            aria-hidden="true"
          >
            <PlusIcon size={20} />
          </span>
          <span className="add-card-title font-display text-2xl text-ink">Add a project</span>
          <span className="add-card-sub font-serif text-base text-ink-soft">
            Point Rennet at a workspace or a repo.
          </span>
        </button>
      ) : (
        <div className="project-rows flex flex-col gap-2">
          {projects.map((project) => (
            <button
              type="button"
              key={project.id}
              className="project-row flex items-center gap-3.5 px-4 py-3 rounded-surface border border-line bg-surface text-ink text-left transition-colors hover:bg-raised"
              onClick={() => onOpen(project)}
            >
              <span
                className="project-row-icon flex-none w-8 h-8 grid place-items-center rounded-control border border-line text-accent"
                aria-hidden="true"
              >
                {project.kind === "workspace" ? (
                  <MonitorIcon size={16} />
                ) : (
                  <GitBranchIcon size={16} />
                )}
              </span>
              <span className="project-row-main flex flex-col gap-0.5 min-w-0">
                <span className="project-row-name text-lg font-semibold">{project.name}</span>
                <span className="project-row-path text-sm text-ink-faint truncate">
                  {project.path}
                </span>
              </span>
              <span className="project-row-meta ml-auto text-sm text-ink-soft whitespace-nowrap">
                {project.kind === "workspace"
                  ? `${project.repoCount} ${plural(project.repoCount, "repo")} · ${project.branchCount} ${plural(project.branchCount, "branch", "branches")}`
                  : `${project.branchCount} ${plural(project.branchCount, "branch", "branches")}`}
              </span>
              <span className="project-row-branch flex-none inline-flex items-center gap-1.5 px-2.5 py-1 rounded-chip border border-line text-ink-soft text-sm">
                <GitBranchIcon size={12} />
                {project.primaryBranch}
              </span>
            </button>
          ))}
          <button
            type="button"
            className="add-row inline-flex items-center gap-2 self-start mt-1 px-3.5 py-2.5 rounded-chip border border-dashed border-line-strong text-ink-soft text-base font-semibold hover:text-ink hover:border-accent-line"
            onClick={onAdd}
          >
            <PlusIcon size={14} />
            Add a project
          </button>
        </div>
      )}

      <HarnessLine detected={detected} />
      <GitHubConnectCard bridge={bridge} />
    </div>
  );
}

/** The ambient backlight line: which harnesses were found. Hidden when none/loading. */
function HarnessLine({ detected }: { detected: DetectedHarness[] | null }) {
  if (!detected || detected.length === 0) return null;
  return (
    <p className="harness-line inline-flex items-center gap-2 self-center mt-7 px-3.5 py-2.5 rounded-chip border border-accent-line bg-accent-soft text-ink text-base font-semibold shadow-[inset_0_0_18px_var(--rn-accent-soft)]">
      <SparkleIcon size={13} />
      <span>
        {detected.map((harness) => harnessLabel(harness.id)).join(" · ")}
        <span className="harness-line-tail text-ink-faint font-normal"> detected</span>
      </span>
    </p>
  );
}

/* ── The add-a-project flow (two terse steps) ──────────────────────────────── */

type AddFlow =
  | { step: "type-path"; kind: ProjectKind; path?: string; busy: boolean }
  | {
      step: "worktree";
      kind: ProjectKind;
      path: string;
      discovery: DiscoveryResult;
      included: string[];
      primaryBranch: string;
      editingBranch: boolean;
      busy: boolean;
    }
  // The initial context dump: the project is persisted; now its snapshot builds
  // with live narration. `projects` is the post-add list, applied on finish.
  | { step: "processing"; project: Project; projects: Project[] };

function AddProject({
  bridge,
  flow,
  projects,
  onFlow,
  onAdded,
  onOpenProject,
  onError,
}: {
  bridge: RennetBridge;
  flow: AddFlow;
  projects: Project[];
  onFlow(flow: AddFlow | null): void;
  onAdded(projects: Project[]): void;
  onOpenProject(project: Project): void;
  onError(message: string | undefined): void;
}) {
  if (flow.step === "type-path") {
    return (
      <TypeAndPath
        bridge={bridge}
        flow={flow}
        projects={projects}
        onFlow={onFlow}
        onError={onError}
      />
    );
  }
  if (flow.step === "processing") {
    return (
      <ProjectProcessing
        bridge={bridge}
        project={flow.project}
        onDone={() => onAdded(flow.projects)}
        onOpen={() => onOpenProject(flow.project)}
      />
    );
  }
  return <WorktreeConfig bridge={bridge} flow={flow} onFlow={onFlow} onError={onError} />;
}

function TypeAndPath({
  bridge,
  flow,
  projects,
  onFlow,
  onError,
}: {
  bridge: RennetBridge;
  flow: Extract<AddFlow, { step: "type-path" }>;
  projects: Project[];
  onFlow(flow: AddFlow | null): void;
  onError(message: string | undefined): void;
}) {
  async function browse(): Promise<void> {
    onError(undefined);
    try {
      const { path } = await bridge.invoke("repository.choose", {});
      if (path) onFlow({ ...flow, path });
    } catch (reason) {
      onError(messageFrom(reason));
    }
  }

  async function proceed(): Promise<void> {
    if (!flow.path) return;
    onError(undefined);
    onFlow({ ...flow, busy: true });
    try {
      const { discovery } = await bridge.invoke("project.discover", {
        commandId: crypto.randomUUID(),
        path: flow.path,
        kind: flow.kind,
      });
      onFlow({
        step: "worktree",
        kind: flow.kind,
        path: flow.path,
        discovery,
        included: discovery.repos.map((repo) => repo.name),
        primaryBranch: discovery.primaryBranch,
        editingBranch: false,
        busy: false,
      });
    } catch (reason) {
      onFlow({ ...flow, busy: false });
      onError(messageFrom(reason));
    }
  }

  return (
    <div className="add-flow w-full max-w-[760px] flex flex-col">
      <p className="eyebrow mt-2 mb-2.5 text-2xs font-semibold uppercase tracking-wide text-ink-faint">
        WHAT ARE YOU POINTING AT
      </p>
      <div className="type-choice grid grid-cols-2 gap-3">
        <TypeCard
          selected={flow.kind === "workspace"}
          icon={<MonitorIcon size={18} />}
          title="Workspace"
          sub="a folder holding several repos"
          onSelect={() => onFlow({ ...flow, kind: "workspace" })}
        />
        <TypeCard
          selected={flow.kind === "repo"}
          icon={<GitBranchIcon size={18} />}
          title="Project repo"
          sub="one repo"
          onSelect={() => onFlow({ ...flow, kind: "repo" })}
        />
      </div>

      <p className="eyebrow mt-4 mb-2.5 text-2xs font-semibold uppercase tracking-wide text-ink-faint">
        PATH
      </p>
      <div className="path-row flex gap-2">
        <span
          className={`path-field flex-1 min-w-0 inline-flex items-center gap-2 px-3.5 py-2.5 rounded-control border border-line-strong bg-surface text-base truncate [&>svg]:flex-none [&>svg]:text-ink-faint ${flow.path ? "text-ink" : "text-ink-faint"}`}
          data-empty={flow.path ? "false" : "true"}
        >
          <FolderIcon size={14} />
          {flow.path ?? "Choose a folder…"}
        </span>
        <button
          type="button"
          className="path-browse flex-none px-4 rounded-control border border-line-strong bg-raised text-ink font-semibold hover:border-accent-line"
          onClick={() => void browse()}
        >
          Browse
        </button>
      </div>

      {projects.length > 0 ? (
        <div className="recents mt-1 rounded-control border border-line overflow-hidden bg-surface">
          <p className="eyebrow recents-eyebrow m-0 px-3.5 py-2.5 border-b border-line bg-raised text-2xs font-semibold uppercase tracking-wide text-ink-faint">
            RECENT
          </p>
          {recentPaths(projects).map((recent) => (
            <button
              type="button"
              key={`${recent.kind}:${recent.path}`}
              className="recent-row w-full flex items-center gap-2.5 px-3.5 py-2.5 border-t border-line bg-transparent text-ink text-left text-base hover:bg-raised [&:first-of-type]:border-t-0"
              onClick={() => onFlow({ ...flow, kind: recent.kind, path: recent.path })}
            >
              <span className="recent-icon flex-none inline-flex text-ink-faint" aria-hidden="true">
                {recent.kind === "workspace" ? (
                  <MonitorIcon size={14} />
                ) : (
                  <GitBranchIcon size={14} />
                )}
              </span>
              <span className="recent-path min-w-0 truncate">{recent.path}</span>
              <span className="recent-count ml-auto flex-none px-2 py-0.5 rounded-chip border border-accent-line bg-accent-soft text-ink text-sm">
                {recent.repoCount} {plural(recent.repoCount, "repo")}
              </span>
            </button>
          ))}
        </div>
      ) : null}

      <div className="add-flow-actions flex items-center gap-3 mt-6">
        <button
          type="button"
          className="ghost px-4 py-2.5 rounded-control border border-line text-ink-soft font-semibold hover:bg-raised hover:text-ink"
          onClick={() => onFlow(null)}
          disabled={flow.busy}
        >
          Cancel
        </button>
        <button
          type="button"
          className="primary ml-auto inline-flex items-center gap-1.5 px-4 py-2.5 rounded-control bg-accent-fill text-accent-ink font-semibold hover:brightness-105 disabled:opacity-50 disabled:cursor-not-allowed"
          onClick={() => void proceed()}
          disabled={!flow.path || flow.busy}
        >
          {flow.busy ? "Reading…" : "Continue"}
          <ArrowRightIcon size={13} />
        </button>
      </div>
    </div>
  );
}

function TypeCard({
  selected,
  icon,
  title,
  sub,
  onSelect,
}: {
  selected: boolean;
  icon: ReactNode;
  title: string;
  sub: string;
  onSelect(): void;
}) {
  return (
    <button
      type="button"
      className={`type-card flex items-center gap-3 p-4 rounded-surface border bg-raised text-ink text-left transition ${selected ? "is-selected border-accent ring-2 ring-accent-soft" : "border-line"}`}
      aria-pressed={selected}
      onClick={onSelect}
    >
      <span
        className="type-card-icon flex-none w-8 h-8 grid place-items-center rounded-control border border-line text-accent"
        aria-hidden="true"
      >
        {icon}
      </span>
      <span className="type-card-body flex flex-col gap-0.5">
        <span className="type-card-title text-lg font-semibold">{title}</span>
        <span className="type-card-sub text-sm text-ink-soft">{sub}</span>
      </span>
    </button>
  );
}

function WorktreeConfig({
  bridge,
  flow,
  onFlow,
  onError,
}: {
  bridge: RennetBridge;
  flow: Extract<AddFlow, { step: "worktree" }>;
  onFlow(flow: AddFlow | null): void;
  onError(message: string | undefined): void;
}) {
  const { discovery } = flow;
  const includedSet = new Set(flow.included);

  function toggle(repo: DiscoveredRepo): void {
    const next = new Set(includedSet);
    if (next.has(repo.name)) next.delete(repo.name);
    else next.add(repo.name);
    onFlow({ ...flow, included: [...next] });
  }

  async function confirm(): Promise<void> {
    onError(undefined);
    onFlow({ ...flow, busy: true });
    try {
      const { project, projects } = await bridge.invoke("projects.add", {
        commandId: crypto.randomUUID(),
        discovery,
        includedRepos: flow.included,
        primaryBranch: flow.primaryBranch.trim() || discovery.primaryBranch,
      });
      // Persisted — now build its snapshot (the initial context dump) with live
      // narration. The post-add list rides through, applied when processing ends.
      onFlow({ step: "processing", project, projects });
    } catch (reason) {
      onFlow({ ...flow, busy: false });
      onError(messageFrom(reason));
    }
  }

  const nothingFound = discovery.repos.length === 0;

  return (
    <div className="add-flow w-full max-w-[760px] flex flex-col">
      <p className="found-in flex items-center gap-2 mt-2 mb-3.5 text-base font-semibold text-ink">
        <span className="found-in-icon inline-flex text-ink-soft" aria-hidden="true">
          {flow.kind === "workspace" ? <MonitorIcon size={15} /> : <GitBranchIcon size={15} />}
        </span>
        Found in <span className="found-in-path text-ink-soft font-normal">{flow.path}</span>
      </p>

      {nothingFound ? (
        <p className="worktree-empty my-2 p-5 rounded-surface border border-dashed border-line-strong text-ink-soft text-center">
          {flow.kind === "repo"
            ? "This folder is not a git repository."
            : "No git repositories under this folder."}
        </p>
      ) : (
        <div className="worktree-rows flex flex-col gap-2">
          {discovery.repos.map((repo) => (
            <div
              className="worktree-row flex items-center gap-3.5 px-4 py-3 rounded-surface border border-line bg-surface"
              key={repo.name}
            >
              <span
                className="worktree-icon flex-none w-8 h-8 grid place-items-center rounded-control border border-line text-ink-soft"
                aria-hidden="true"
              >
                <GitBranchIcon size={15} />
              </span>
              <span className="worktree-main flex flex-col gap-0.5 min-w-0">
                <span className="worktree-name text-base font-semibold text-ink">{repo.name}</span>
                <span className="worktree-sub text-sm text-ink-faint">
                  {repo.branches} {plural(repo.branches, "branch", "branches")}
                  {repo.remote ? ` · ${repo.remote}` : ""}
                  {repo.note ? ` · ${repo.note}` : ""}
                </span>
              </span>
              <Toggle
                on={includedSet.has(repo.name)}
                label={`Include ${repo.name}`}
                onToggle={() => toggle(repo)}
              />
            </div>
          ))}

          <div className="primary-branch flex items-center gap-2.5 px-4 py-3 rounded-surface border border-line bg-surface">
            <span className="primary-branch-label text-ink-soft text-base">Primary branch</span>
            {flow.editingBranch ? (
              <input
                type="text"
                className="primary-branch-input px-2.5 py-1.5 rounded-chip border border-accent bg-raised text-ink text-base"
                value={flow.primaryBranch}
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                // biome-ignore lint/a11y/noAutofocus: focus the field the user just revealed.
                autoFocus
                onChange={(event) => onFlow({ ...flow, primaryBranch: event.target.value })}
                onBlur={() => onFlow({ ...flow, editingBranch: false })}
              />
            ) : (
              <span className="primary-branch-value inline-flex items-center gap-1.5 text-ink font-semibold text-base">
                <GitBranchIcon size={12} />
                {flow.primaryBranch}
              </span>
            )}
            <button
              type="button"
              className="primary-branch-edit ml-auto text-accent text-base hover:underline"
              onClick={() => onFlow({ ...flow, editingBranch: !flow.editingBranch })}
            >
              {flow.editingBranch ? "done" : "edit"}
            </button>
          </div>
        </div>
      )}

      {discovery.reconciliation ? (
        <p
          className="reconciliation flex items-start gap-2 mt-3 px-3.5 py-2.5 rounded-chip border border-accent-line bg-accent-surface text-ink text-base"
          role="note"
        >
          <ChevronIcon size={12} className="reconciliation-mark flex-none mt-0.5" />
          {discovery.reconciliation}
        </p>
      ) : null}

      <div className="add-flow-actions flex items-center gap-3 mt-6">
        <button
          type="button"
          className="ghost px-4 py-2.5 rounded-control border border-line text-ink-soft font-semibold hover:bg-raised hover:text-ink"
          onClick={() =>
            onFlow({ step: "type-path", kind: flow.kind, path: flow.path, busy: false })
          }
          disabled={flow.busy}
        >
          Back
        </button>
        <span className="included-count ml-auto text-ink-faint text-base">
          {includedSet.size} of {discovery.repos.length} included
        </span>
        <button
          type="button"
          className="primary inline-flex items-center gap-1.5 px-4 py-2.5 rounded-control bg-accent-fill text-accent-ink font-semibold hover:brightness-105 disabled:opacity-50 disabled:cursor-not-allowed"
          onClick={() => void confirm()}
          disabled={flow.busy || includedSet.size === 0}
        >
          {flow.busy ? "Adding…" : "Confirm"}
        </button>
      </div>
    </div>
  );
}

/** A private-to-reviewer backlight toggle switch. */
function Toggle({ on, label, onToggle }: { on: boolean; label: string; onToggle(): void }) {
  return (
    <button
      type="button"
      className={`toggle flex-none ml-auto w-10 h-6 p-0.5 rounded-full border transition ${on ? "is-on border-accent-line bg-accent-soft shadow-[inset_0_0_10px_var(--rn-accent-soft)]" : "border-line-strong bg-raised"}`}
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={onToggle}
    >
      <span
        className={`toggle-knob block w-[17px] h-[17px] rounded-full transition-transform ${on ? "translate-x-[17px] bg-accent" : "bg-ink-faint"}`}
        aria-hidden="true"
      />
    </button>
  );
}

/* ── helpers ───────────────────────────────────────────────────────────────── */

function harnessLabel(id: string): string {
  return id === "claude" ? "Claude" : id;
}

function plural(count: number, one: string, many = `${one}s`): string {
  return count === 1 ? one : many;
}

interface RecentPath {
  path: string;
  kind: ProjectKind;
  repoCount: number;
}

/** The recent paths for step 1, deduped by (kind, path), newest first, capped. */
function recentPaths(projects: readonly Project[]): RecentPath[] {
  const seen = new Set<string>();
  const recents: RecentPath[] = [];
  for (const project of projects) {
    const key = `${project.kind}:${project.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    recents.push({ path: project.path, kind: project.kind, repoCount: project.repoCount });
    if (recents.length >= 4) break;
  }
  return recents;
}
