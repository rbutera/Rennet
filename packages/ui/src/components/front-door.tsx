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
import { RennetBrandMark } from "./brand-mark";
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
    <div className="rennet-glass front-door" data-scheme={scheme ?? "dark"}>
      <header className="front-door-bar">
        <span className="front-door-mark" aria-hidden="true">
          {flow?.step === "processing" ? (
            <SparkleIcon size={18} />
          ) : flow ? (
            <PlusIcon size={16} />
          ) : (
            <RennetBrandMark size={16} />
          )}
        </span>
        <h1>
          {flow?.step === "processing" ? flow.project.name : flow ? "Add a project" : "Rennet"}
        </h1>
        {flow && flow.step !== "processing" ? (
          <span className="front-door-step">step {flow.step === "type-path" ? 1 : 2} of 2</span>
        ) : null}
        {flow?.step === "processing" ? <span className="front-door-step">processing</span> : null}
        {onOpenSettings && !flow ? (
          <button
            type="button"
            className="front-door-settings"
            onClick={onOpenSettings}
            title="Settings"
            aria-label="Settings"
          >
            <SlidersIcon size={16} />
          </button>
        ) : null}
      </header>

      {error ? <p className="front-door-error">{error}</p> : null}

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
  if (projects === null) return <p className="front-door-loading">Loading projects…</p>;

  const empty = projects.length === 0;
  return (
    <div className="projects">
      <p className="eyebrow projects-eyebrow">
        {empty ? "PROJECTS · NONE YET" : `PROJECTS · ${projects.length}`}
      </p>

      {empty ? (
        <button type="button" className="add-card" onClick={onAdd}>
          <span className="add-card-plus" aria-hidden="true">
            <PlusIcon size={20} />
          </span>
          <span className="add-card-title">Add a project</span>
          <span className="add-card-sub">Point Rennet at a workspace or a repo.</span>
        </button>
      ) : (
        <div className="project-rows">
          {projects.map((project) => (
            <button
              type="button"
              key={project.id}
              className="project-row"
              onClick={() => onOpen(project)}
            >
              <span className="project-row-icon" aria-hidden="true">
                {project.kind === "workspace" ? (
                  <MonitorIcon size={16} />
                ) : (
                  <GitBranchIcon size={16} />
                )}
              </span>
              <span className="project-row-main">
                <span className="project-row-name">{project.name}</span>
                <span className="project-row-path">{project.path}</span>
              </span>
              <span className="project-row-meta">
                {project.kind === "workspace"
                  ? `${project.repoCount} ${plural(project.repoCount, "repo")} · ${project.branchCount} ${plural(project.branchCount, "branch", "branches")}`
                  : `${project.branchCount} ${plural(project.branchCount, "branch", "branches")}`}
              </span>
              <span className="project-row-branch">
                <GitBranchIcon size={12} />
                {project.primaryBranch}
              </span>
            </button>
          ))}
          <button type="button" className="add-row" onClick={onAdd}>
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
    <p className="harness-line">
      <SparkleIcon size={13} />
      <span>
        {detected.map((harness) => harnessLabel(harness.id)).join(" · ")}
        <span className="harness-line-tail"> detected</span>
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
    <div className="add-flow">
      <p className="eyebrow">WHAT ARE YOU POINTING AT</p>
      <div className="type-choice">
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

      <p className="eyebrow">PATH</p>
      <div className="path-row">
        <span className="path-field" data-empty={flow.path ? "false" : "true"}>
          <FolderIcon size={14} />
          {flow.path ?? "Choose a folder…"}
        </span>
        <button type="button" className="path-browse" onClick={() => void browse()}>
          Browse
        </button>
      </div>

      {projects.length > 0 ? (
        <div className="recents">
          <p className="eyebrow recents-eyebrow">RECENT</p>
          {recentPaths(projects).map((recent) => (
            <button
              type="button"
              key={`${recent.kind}:${recent.path}`}
              className="recent-row"
              onClick={() => onFlow({ ...flow, kind: recent.kind, path: recent.path })}
            >
              <span className="recent-icon" aria-hidden="true">
                {recent.kind === "workspace" ? (
                  <MonitorIcon size={14} />
                ) : (
                  <GitBranchIcon size={14} />
                )}
              </span>
              <span className="recent-path">{recent.path}</span>
              <span className="recent-count">
                {recent.repoCount} {plural(recent.repoCount, "repo")}
              </span>
            </button>
          ))}
        </div>
      ) : null}

      <div className="add-flow-actions">
        <button type="button" className="ghost" onClick={() => onFlow(null)} disabled={flow.busy}>
          Cancel
        </button>
        <button
          type="button"
          className="primary"
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
      className={`type-card${selected ? " is-selected" : ""}`}
      aria-pressed={selected}
      onClick={onSelect}
    >
      <span className="type-card-icon" aria-hidden="true">
        {icon}
      </span>
      <span className="type-card-body">
        <span className="type-card-title">{title}</span>
        <span className="type-card-sub">{sub}</span>
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
    <div className="add-flow">
      <p className="found-in">
        <span className="found-in-icon" aria-hidden="true">
          {flow.kind === "workspace" ? <MonitorIcon size={15} /> : <GitBranchIcon size={15} />}
        </span>
        Found in <span className="found-in-path">{flow.path}</span>
      </p>

      {nothingFound ? (
        <p className="worktree-empty">
          {flow.kind === "repo"
            ? "This folder is not a git repository."
            : "No git repositories under this folder."}
        </p>
      ) : (
        <div className="worktree-rows">
          {discovery.repos.map((repo) => (
            <div className="worktree-row" key={repo.name}>
              <span className="worktree-icon" aria-hidden="true">
                <GitBranchIcon size={15} />
              </span>
              <span className="worktree-main">
                <span className="worktree-name">{repo.name}</span>
                <span className="worktree-sub">
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

          <div className="primary-branch">
            <span className="primary-branch-label">Primary branch</span>
            {flow.editingBranch ? (
              <input
                type="text"
                className="primary-branch-input"
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
              <span className="primary-branch-value">
                <GitBranchIcon size={12} />
                {flow.primaryBranch}
              </span>
            )}
            <button
              type="button"
              className="primary-branch-edit"
              onClick={() => onFlow({ ...flow, editingBranch: !flow.editingBranch })}
            >
              {flow.editingBranch ? "done" : "edit"}
            </button>
          </div>
        </div>
      )}

      {discovery.reconciliation ? (
        <p className="reconciliation" role="note">
          <ChevronIcon size={12} className="reconciliation-mark" />
          {discovery.reconciliation}
        </p>
      ) : null}

      <div className="add-flow-actions">
        <button
          type="button"
          className="ghost"
          onClick={() =>
            onFlow({ step: "type-path", kind: flow.kind, path: flow.path, busy: false })
          }
          disabled={flow.busy}
        >
          Back
        </button>
        <span className="included-count">
          {includedSet.size} of {discovery.repos.length} included
        </span>
        <button
          type="button"
          className="primary"
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
      className={`toggle${on ? " is-on" : ""}`}
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={onToggle}
    >
      <span className="toggle-knob" aria-hidden="true" />
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
