import type {
  DetectedHarness,
  DiscoveredRepo,
  DiscoveryResult,
  Project,
  ProjectKind,
  ProjectSource,
  RennetBridge,
} from "@rennet/protocol";
import { Button, Input, Switch } from "@rennet/ui";
import {
  ArrowRight,
  ChevronDown,
  GitBranch,
  Monitor,
  Plus,
  SlidersHorizontal,
  Sparkles,
} from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { messageFrom } from "../lib/message-from";
import type { ConnectSource, LogWslConnect, PendingSourceBrowse } from "./connection-host";
import { DirectoryBrowser } from "./directory-browser";
import { GitHubConnectCard } from "./github-connect";
import { Icon } from "./icon";
import { ProjectProcessing } from "./project-processing";
import { type SourceOption, SourceSwitcher } from "./source-switcher";
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
  sources,
  activeSource,
  connectSource,
  pendingSourceBrowse,
  onPendingSourceBrowseConsumed,
  pendingAddPath,
  onPendingAddConsumed,
  logWslConnect,
  onOpenProject,
  onOpenSettings,
  scheme,
}: {
  bridge: RennetBridge;
  /**
   * The selectable sources for the add flow (source-aware project selection, task 6): Local plus
   * each WSL distro and paired remote. Absent ⇒ Local only (the browser shell / tests). Built by
   * the shell, which owns distro enumeration and the paired-daemon list.
   */
  sources?: SourceOption[];
  /**
   * The `ProjectSource` of the daemon currently attached. A FRESH add flow defaults its `source`
   * to this — so when the app is already on a WSL/remote daemon, the flow (and the SourceSwitcher's
   * selection) agree with the daemon actually attached, rather than always claiming Local while the
   * browser lists a different daemon's filesystem. Absent ⇒ Local.
   */
  activeSource?: ProjectSource;
  /**
   * Attach the daemon a chosen source lives on (WSL/remote reuse the owned/attached-daemon
   * machinery from #437/#439). A non-local source `switched:true` remounts the app onto that
   * daemon — this instance then tears down, and the freshly mounted one restores the browse via
   * {@link pendingSourceBrowse}. Local (or already-attached) is `switched:false`. Absent ⇒ only
   * Local is reachable.
   */
  connectSource?: ConnectSource;
  /** A source (+kind) this freshly mounted front door should RESTORE the browse step on, once —
   *  set when a source switch remounted the app onto that source's daemon. */
  pendingSourceBrowse?: PendingSourceBrowse;
  /** Called after {@link pendingSourceBrowse} is consumed, so the host clears it. */
  onPendingSourceBrowseConsumed?(): void;
  /** A distro-native path (+kind) this freshly mounted front door should ADD on itself, once. */
  pendingAddPath?: { readonly path: string; readonly kind: ProjectKind };
  /** Called after {@link pendingAddPath} is consumed, so the host clears it. */
  onPendingAddConsumed?(): void;
  /** Append one line to the desktop's wsl-connect.log — traces the add's completion distro-side. */
  logWslConnect?: LogWslConnect;
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

  // WSL connect flow, receiving end: this front door was just remounted onto a distro daemon and
  // carries the distro-native path a WSL add queued. Complete the add THERE once — discover +
  // projects.add with the discovery defaults — then land in the same processing step a local add
  // does, and tell the host to clear the pending path. The `detect`/`switch` lines were already
  // written by the desktop resolver; this logs the completion (or fault) so the trace is whole.
  // ponytail: a plain ref guards the single run; StrictMode's dev-only double-mount could rerun it
  // (harmless in prod), same trade-off as the pending-capture guard in shell.tsx.
  const pendingAddConsumed = useRef(false);
  useEffect(() => {
    if (!pendingAddPath || pendingAddConsumed.current) return;
    pendingAddConsumed.current = true;
    const { path, kind } = pendingAddPath;
    void (async () => {
      try {
        // Grant the distro-native path on THIS (distro) daemon before discovering it —
        // the daemon only scans paths granted via repository.choose, and the pick
        // happened on the host daemon we just switched away from. The user chose this
        // path; forwarding the grant is not a new consent step.
        await bridge.invoke("repository.choose", { path });
        const { discovery } = await bridge.invoke("project.discover", {
          commandId: crypto.randomUUID(),
          path,
          kind,
        });
        const { project, projects: next } = await bridge.invoke("projects.add", {
          commandId: crypto.randomUUID(),
          discovery,
          includedRepos: discovery.repos.map((repo) => repo.name),
          primaryBranch: discovery.primaryBranch,
        });
        logWslConnect?.({
          event: "add",
          path,
          detail: { project: project.id, repos: discovery.repos.length },
        });
        setFlow({ step: "processing", project, projects: next });
      } catch (reason) {
        const message = messageFrom(reason);
        logWslConnect?.({ event: "error", path, detail: { error: message } });
        setError(message);
      } finally {
        onPendingAddConsumed?.();
      }
    })();
  }, [pendingAddPath, bridge, onPendingAddConsumed, logWslConnect]);

  // Source-switch, receiving end: a non-local source select remounted the app onto that source's
  // daemon (this front door is that fresh mount), carrying the source (+kind) the add flow was on.
  // Re-open the add flow at the browse step with that source selected — the DirectoryBrowser below
  // now lists the newly attached daemon — then tell the host to clear the pending browse. A plain
  // ref guards the single run (StrictMode's dev double-mount reruns harmlessly), mirroring the
  // pending-add guard above.
  const pendingBrowseConsumed = useRef(false);
  useEffect(() => {
    if (!pendingSourceBrowse || pendingBrowseConsumed.current) return;
    pendingBrowseConsumed.current = true;
    setFlow({
      step: "type-path",
      kind: pendingSourceBrowse.kind,
      source: pendingSourceBrowse.source,
      // A recent restore carries its path across the remount; a plain switcher browse has none
      // (the DirectoryBrowser then opens at the newly attached daemon's home dir).
      path: pendingSourceBrowse.path,
      busy: false,
    });
    onPendingSourceBrowseConsumed?.();
  }, [pendingSourceBrowse, onPendingSourceBrowseConsumed]);

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
            {flow.step === "processing" ? (
              <Icon icon={Sparkles} className="size-4.5" />
            ) : (
              <Icon icon={Plus} className="size-4" />
            )}
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
          <Button
            variant="outline"
            size="icon"
            className="front-door-settings ml-auto text-ink-soft"
            onClick={onOpenSettings}
            title="Settings"
            aria-label="Settings"
          >
            <Icon icon={SlidersHorizontal} className="size-4" />
          </Button>
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
          sources={sources}
          connectSource={connectSource}
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
          onAdd={() =>
            setFlow({
              step: "type-path",
              kind: "repo",
              // Default to the daemon actually attached, not always "local": if the app is on a
              // WSL/remote daemon, the browser lists THAT filesystem, so the flow must say so.
              source: activeSource ?? "local",
              busy: false,
            })
          }
          onOpen={onOpenProject}
          onRemove={(id) => {
            // Forget a project (the repo on disk is untouched); refresh from the
            // authoritative surviving list MAIN returns.
            bridge
              .invoke("projects.remove", { commandId: crypto.randomUUID(), projectId: id })
              .then(({ projects: next }) => setProjects(next))
              .catch((reason: unknown) => setError(messageFrom(reason)));
          }}
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
  onRemove,
}: {
  projects: Project[] | null;
  detected: DetectedHarness[] | null;
  bridge: RennetBridge;
  onAdd(): void;
  onOpen(project: Project): void;
  onRemove(projectId: string): void;
}) {
  // Right-click a project row to forget it. A small menu anchored at the cursor;
  // any click / key / scroll dismisses it. Removing does NOT touch the repo on disk.
  const [menu, setMenu] = useState<{ project: Project; x: number; y: number } | null>(null);
  useEffect(() => {
    if (!menu) return;
    const close = (): void => setMenu(null);
    window.addEventListener("click", close);
    window.addEventListener("keydown", close);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [menu]);

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
            <Icon icon={Plus} className="size-5" />
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
              onContextMenu={(event) => {
                event.preventDefault();
                setMenu({ project, x: event.clientX, y: event.clientY });
              }}
            >
              <span
                className="project-row-icon flex-none w-8 h-8 grid place-items-center rounded-control border border-line text-accent"
                aria-hidden="true"
              >
                {project.kind === "workspace" ? (
                  <Icon icon={Monitor} className="size-4" />
                ) : (
                  <Icon icon={GitBranch} className="size-4" />
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
                <Icon icon={GitBranch} className="size-3" />
                {project.primaryBranch}
              </span>
            </button>
          ))}
          <button
            type="button"
            className="add-row inline-flex items-center gap-2 self-start mt-1 px-3.5 py-2.5 rounded-chip border border-dashed border-line-strong text-ink-soft text-base font-semibold hover:text-ink hover:border-accent-line"
            onClick={onAdd}
          >
            <Icon icon={Plus} className="size-3.5" />
            Add a project
          </button>
          {menu ? (
            <div
              className="project-context-menu fixed z-50 min-w-[180px] rounded-control border border-line bg-surface shadow-lg py-1"
              style={{ top: menu.y, left: menu.x }}
              role="menu"
            >
              <button
                type="button"
                role="menuitem"
                className="w-full px-3.5 py-2 text-left text-base text-ink hover:bg-raised"
                onClick={() => {
                  onRemove(menu.project.id);
                  setMenu(null);
                }}
              >
                Remove from Rennet
              </button>
            </div>
          ) : null}
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
      <Icon icon={Sparkles} className="size-3.5" />
      <span>
        {detected.map((harness) => harnessLabel(harness.id)).join(" · ")}
        <span className="harness-line-tail text-ink-faint font-normal"> detected</span>
      </span>
    </p>
  );
}

/* ── The add-a-project flow (two terse steps) ──────────────────────────────── */

type AddFlow =
  | { step: "type-path"; kind: ProjectKind; source: ProjectSource; path?: string; busy: boolean }
  | {
      step: "worktree";
      kind: ProjectKind;
      source: ProjectSource;
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
  sources,
  connectSource,
  flow,
  projects,
  onFlow,
  onAdded,
  onOpenProject,
  onError,
}: {
  bridge: RennetBridge;
  sources?: SourceOption[];
  connectSource?: ConnectSource;
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
        sources={sources}
        connectSource={connectSource}
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
  sources,
  connectSource,
  flow,
  projects,
  onFlow,
  onError,
}: {
  bridge: RennetBridge;
  sources?: SourceOption[];
  connectSource?: ConnectSource;
  flow: Extract<AddFlow, { step: "type-path" }>;
  projects: Project[];
  onFlow(flow: AddFlow | null): void;
  onError(message: string | undefined): void;
}) {
  // A reload token the browser navigates on: a SAME-source recent updates `flow.path` but
  // doesn't change `flow.source`, so without this the browser would keep showing the old
  // directory while Continue submitted the recent's path. Bumping it on a recent jump forces
  // the browser to navigate there; a plain browse never bumps it, so there is no reload loop.
  const [browseNonce, setBrowseNonce] = useState(0);
  // Switch which source's daemon the browser lists. A non-local source `switched:true` remounts
  // the whole app onto that daemon (this instance tears down; the fresh mount restores the browse
  // via `pendingSourceBrowse`). Local, or already attached, stays put. `busy` doubles as the
  // switcher's "connecting…" state — the two never overlap (you either switch or continue).
  async function selectSource(
    id: ProjectSource,
    // A recent row passes its kind + path so re-selecting a recent RESTORES them (rather than
    // clearing the path like a plain switcher select); they ride through the attach/remount.
    browse?: { kind: ProjectKind; path: string },
  ): Promise<void> {
    if (flow.busy) return;
    const kind = browse?.kind ?? flow.kind;
    const path = browse?.path;
    if (id === flow.source) {
      // Same daemon already attached: no switch. A recent still jumps to its path + kind;
      // a plain re-select of the current source is a no-op.
      if (browse) {
        // Bump the reload token so the browser actually NAVIGATES to the recent's directory
        // (a `flow.path` change alone doesn't reload it) — keeping the shown dir === submitted.
        setBrowseNonce((nonce) => nonce + 1);
        onFlow({ ...flow, kind, path });
      }
      return;
    }
    onError(undefined);
    if (!connectSource) {
      onFlow({ ...flow, kind, source: id, path });
      return;
    }
    onFlow({ ...flow, kind, source: id, path: undefined, busy: true });
    try {
      const outcome = await connectSource(id, kind, path);
      if (outcome.error) {
        onFlow({ ...flow, busy: false }); // the prior source stays selected; surface the fault
        onError(outcome.error);
        return;
      }
      if (outcome.switched) return; // remounting onto that daemon; this instance tears down
      onFlow({ ...flow, kind, source: id, path, busy: false });
    } catch (reason) {
      onFlow({ ...flow, busy: false });
      onError(messageFrom(reason));
    }
  }

  async function proceed(): Promise<void> {
    if (!flow.path) return;
    onError(undefined);
    onFlow({ ...flow, busy: true });
    try {
      // Grant the browsed path on the ATTACHED daemon before discovering it — the daemon only
      // scans paths granted via repository.choose, which now always forwards {path} (the native
      // picker is retired). The user browsed to this path; forwarding the grant is not a gate.
      await bridge.invoke("repository.choose", { path: flow.path });
      const { discovery } = await bridge.invoke("project.discover", {
        commandId: crypto.randomUUID(),
        path: flow.path,
        kind: flow.kind,
        source: flow.source,
      });
      onFlow({
        step: "worktree",
        kind: flow.kind,
        source: flow.source,
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
          selected={flow.kind === "repo"}
          icon={<Icon icon={GitBranch} className="size-4.5" />}
          title="Project repo"
          sub="one repo"
          onSelect={() => onFlow({ ...flow, kind: "repo" })}
        />
        <TypeCard
          selected={flow.kind === "workspace"}
          icon={<Icon icon={Monitor} className="size-4.5" />}
          title="Workspace"
          sub="a folder holding several repos"
          onSelect={() => onFlow({ ...flow, kind: "workspace" })}
        />
      </div>

      {sources && sources.length > 0 ? (
        <SourceSwitcher
          sources={sources}
          selected={flow.source}
          connecting={flow.busy}
          onSelect={(id) => void selectSource(id)}
        />
      ) : null}

      <p className="eyebrow mt-4 mb-2.5 text-2xs font-semibold uppercase tracking-wide text-ink-faint">
        PATH
      </p>
      <DirectoryBrowser
        bridge={bridge}
        reloadKey={`${flow.source}#${browseNonce}`}
        initialPath={flow.path}
        onPathChange={(path) => onFlow({ ...flow, path })}
        // A failed load (bad typed path / unreachable target) invalidates the selection, so drop
        // the path — Continue then disables until a good directory loads (SPEC: invalid path).
        onPathInvalid={() => onFlow({ ...flow, path: undefined })}
      />

      {projects.length > 0 ? (
        <div className="recents mt-3 rounded-control border border-line overflow-hidden bg-surface">
          <p className="eyebrow recents-eyebrow m-0 px-3.5 py-2.5 border-b border-line bg-raised text-2xs font-semibold uppercase tracking-wide text-ink-faint">
            RECENT
          </p>
          {recentPaths(projects).map((recent) => (
            <button
              type="button"
              key={`${recent.kind}:${recent.path}`}
              className="recent-row w-full flex items-center gap-2.5 px-3.5 py-2.5 border-t border-line bg-transparent text-ink text-left text-base hover:bg-raised [&:first-of-type]:border-t-0"
              // Route a recent through the SAME source-selection path the switcher takes, so a
              // non-local recent attaches its daemon (not just relabels the source) before its
              // path is restored — carrying kind + path across the attach/remount.
              onClick={() =>
                void selectSource(recent.source, { kind: recent.kind, path: recent.path })
              }
            >
              <span className="recent-icon flex-none inline-flex text-ink-faint" aria-hidden="true">
                {recent.kind === "workspace" ? (
                  <Icon icon={Monitor} className="size-3.5" />
                ) : (
                  <Icon icon={GitBranch} className="size-3.5" />
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
        <Button
          variant="outline"
          size="lg"
          className="ghost text-ink-soft"
          onClick={() => onFlow(null)}
          disabled={flow.busy}
        >
          Cancel
        </Button>
        <Button
          size="lg"
          className="primary ml-auto"
          onClick={() => void proceed()}
          disabled={!flow.path || flow.busy}
        >
          {flow.busy ? "Reading…" : "Continue"}
          <Icon icon={ArrowRight} className="size-3.5" />
        </Button>
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
        // `source` rides in on `discovery.source` (stamped by `project.discover`) — the one
        // authoritative field; no redundant top-level `source` that could disagree with it.
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
          {flow.kind === "workspace" ? (
            <Icon icon={Monitor} className="size-4" />
          ) : (
            <Icon icon={GitBranch} className="size-4" />
          )}
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
                <Icon icon={GitBranch} className="size-4" />
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
              <Input
                type="text"
                className="primary-branch-input w-auto"
                value={flow.primaryBranch}
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                autoFocus
                onChange={(event) => onFlow({ ...flow, primaryBranch: event.target.value })}
                onBlur={() => onFlow({ ...flow, editingBranch: false })}
              />
            ) : (
              <span className="primary-branch-value inline-flex items-center gap-1.5 text-ink font-semibold text-base">
                <Icon icon={GitBranch} className="size-3" />
                {flow.primaryBranch}
              </span>
            )}
            <Button
              variant="link"
              size="sm"
              className="primary-branch-edit ml-auto"
              onClick={() => onFlow({ ...flow, editingBranch: !flow.editingBranch })}
            >
              {flow.editingBranch ? "done" : "edit"}
            </Button>
          </div>
        </div>
      )}

      {discovery.reconciliation ? (
        <p
          className="reconciliation flex items-start gap-2 mt-3 px-3.5 py-2.5 rounded-chip border border-accent-line bg-accent-surface text-ink text-base"
          role="note"
        >
          <Icon icon={ChevronDown} className="reconciliation-mark flex-none mt-0.5 size-3" />
          {discovery.reconciliation}
        </p>
      ) : null}

      <div className="add-flow-actions flex items-center gap-3 mt-6">
        <Button
          variant="outline"
          size="lg"
          className="ghost text-ink-soft"
          onClick={() =>
            onFlow({
              step: "type-path",
              kind: flow.kind,
              source: flow.source,
              path: flow.path,
              busy: false,
            })
          }
          disabled={flow.busy}
        >
          Back
        </Button>
        <span className="included-count ml-auto text-ink-faint text-base">
          {includedSet.size} of {discovery.repos.length} included
        </span>
        <Button
          size="lg"
          className="primary"
          onClick={() => void confirm()}
          disabled={flow.busy || includedSet.size === 0}
        >
          {flow.busy ? "Adding…" : "Confirm"}
        </Button>
      </div>
    </div>
  );
}

/** A private-to-reviewer backlight toggle switch. */
function Toggle({ on, label, onToggle }: { on: boolean; label: string; onToggle(): void }) {
  return (
    <Switch
      variant="backlight"
      className={`toggle flex-none ml-auto${on ? " is-on" : ""}`}
      checked={on}
      aria-label={label}
      onCheckedChange={onToggle}
    />
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
  source: ProjectSource;
  repoCount: number;
}

/** The recent paths for step 1, deduped by (kind, path), newest first, capped. Each carries the
 *  project's SOURCE so re-selecting a recent points the flow at the right daemon. */
function recentPaths(projects: readonly Project[]): RecentPath[] {
  const seen = new Set<string>();
  const recents: RecentPath[] = [];
  for (const project of projects) {
    const key = `${project.kind}:${project.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    recents.push({
      path: project.path,
      kind: project.kind,
      source: project.source,
      repoCount: project.repoCount,
    });
    if (recents.length >= 4) break;
  }
  return recents;
}
