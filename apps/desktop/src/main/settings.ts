import { basename } from "node:path";
import type { ConventionCatalogueLoad } from "@rennet/adapters";
import {
  detectLocus,
  escapePath,
  type Locus,
  resolvePromoted,
  resolveScheme,
  resolveVisibility,
} from "@rennet/core";
import type {
  GlobalConfig,
  Project,
  ProjectVisibility,
  SetRepoLocusOutcome,
  SetRepoVisibilityOutcome,
  SettingsGuidance,
  SettingsProject,
  SettingsView,
} from "@rennet/protocol";

/**
 * The settings surface's composition (wireframe #15), extracted from the Electron
 * main so the config-ladder logic — repo-identity resolution, workspace expansion,
 * provenance, and the Rule-75 malformed refusals — is unit-testable off-Electron.
 * `index.ts` injects the real effects (git, the stores, discovery, the visibility
 * switch); a test injects fakes. Nothing here touches Electron or the real disk
 * except through the injected effects.
 */

/** The minimal on-disk config states this composition reads, from the two stores. */
export interface SettingsCompositionDeps {
  /** The persisted projects (newest first). */
  listProjects(): Project[];
  /**
   * A project's snapshot-store config state, keyed by the escaped git-top-level
   * key. Distinguishes absent (safe) / ok / malformed (edits refused).
   */
  loadConfigState(
    repoKey: string,
  ):
    | { status: "absent" | "malformed"; config: null }
    | {
        status: "ok";
        config: { visibility?: ProjectVisibility; promoted?: boolean; locus?: Locus };
      };
  /** The global (app-side) config state. */
  readGlobalState(): { status: "absent" | "ok" | "malformed"; config: GlobalConfig };
  /** Persist a global-config edit. MUST itself refuse a malformed file (throw). */
  updateGlobal(update: (current: GlobalConfig) => GlobalConfig): GlobalConfig;
  /**
   * Resolve a working path to its realpath-canonical git TOP LEVEL — the same
   * identity the snapshot generator keys on — or `null` when it is not a git
   * working tree (a since-removed checkout).
   */
  gitTopLevel(workingPath: string): Promise<string | null>;
  /** Rediscover every repo working path under a legacy workspace (no persisted set). */
  discoverWorkspaceRepos(project: Project): Promise<string[]>;
  /** Read a repo's `.rennet/conventions.json` house rules (read-through, degrades). */
  loadGuidance(repoRoot: string): ConventionCatalogueLoad;
  /** Run the real visibility switch; returns whether the `.gitignore` changed. */
  applyVisibility(input: {
    repoKey: string;
    repoRoot: string;
    target: ProjectVisibility;
  }): Promise<{ changed: boolean; gitignorePath: string }>;
  /**
   * Persist a repo's execution-locus override, or clear it (`locus: null` ⇒ back to
   * auto-detection). A plain config write — never a gate (Rule Zero).
   */
  applyLocus(input: { repoKey: string; locus: Locus | null }): void;
}

interface RepoTarget {
  /** The canonical git top-level path — the row's stable address. */
  readonly repoPath: string;
  /** `escapePath(repoPath)` — the snapshot-store key. */
  readonly repoKey: string;
  /** The repo root (same as `repoPath`), passed to fs-facing effects. */
  readonly repoRoot: string;
}

export interface SettingsComposition {
  get(): Promise<SettingsView>;
  guidance(projectId: string, repoPath: string): Promise<SettingsGuidance>;
  setAppearance(scheme: SettingsView["scheme"]): SettingsView["scheme"];
  setRepoVisibility(input: {
    projectId: string;
    repoPath: string;
    visibility: ProjectVisibility;
  }): Promise<SetRepoVisibilityOutcome>;
  setRepoLocus(input: {
    projectId: string;
    repoPath: string;
    locus: Locus | null;
  }): Promise<SetRepoLocusOutcome>;
}

export function createSettingsComposition(deps: SettingsCompositionDeps): SettingsComposition {
  // Resolve a working path to the SAME repo identity the snapshot generator uses:
  // the realpath-canonical git top level, escaped into the store key. `null` when
  // the path is not a git working tree. Keying off a bare open path was wrong — a
  // nested subdir would read a different entry and write the wrong `.gitignore`.
  const resolveRepoTarget = async (workingPath: string): Promise<RepoTarget | null> => {
    const topLevel = await deps.gitTopLevel(workingPath);
    if (!topLevel) return null;
    return { repoPath: topLevel, repoKey: escapePath(topLevel), repoRoot: topLevel };
  };

  // A project's included repos, mirroring `resolveRepoRoots` (project-detail): a
  // repo project is its own open path; a workspace honours the persisted inclusion
  // set; a LEGACY workspace (saved before `includedRepoPaths`) rediscovers every
  // repo under its path rather than collapsing to the first.
  const includedWorkingPaths = async (project: Project): Promise<string[]> => {
    if (project.kind === "repo") return [project.openPath || project.path];
    if (project.includedRepoPaths && project.includedRepoPaths.length > 0) {
      return [...project.includedRepoPaths];
    }
    try {
      return await deps.discoverWorkspaceRepos(project);
    } catch {
      return [project.openPath];
    }
  };

  // Every resolvable repo target for a project, deduped by top level.
  const targetsFor = async (project: Project): Promise<RepoTarget[]> => {
    const seen = new Set<string>();
    const targets: RepoTarget[] = [];
    for (const workingPath of await includedWorkingPaths(project)) {
      const target = await resolveRepoTarget(workingPath);
      if (target && !seen.has(target.repoPath)) {
        seen.add(target.repoPath);
        targets.push(target);
      }
    }
    return targets;
  };

  return {
    get: async (): Promise<SettingsView> => {
      const schemeState = deps.readGlobalState();
      const scheme = resolveScheme(schemeState.config);
      const projects: SettingsProject[] = [];
      const emittedRepoPaths = new Set<string>();
      for (const project of deps.listProjects()) {
        const targets = await targetsFor(project);
        const multiRepo = targets.length > 1;
        for (const target of targets) {
          if (emittedRepoPaths.has(target.repoPath)) continue;
          emittedRepoPaths.add(target.repoPath);
          const configState = deps.loadConfigState(target.repoKey);
          const configMalformed = configState.status === "malformed";
          // A malformed config never leaks its (unparseable) values into the
          // resolver — the row shows builtin defaults and refuses edits.
          const config = configState.status === "ok" ? configState.config : null;
          const visibility = resolveVisibility(config?.visibility);
          const promoted = resolvePromoted(config?.promoted);
          // A malformed config never leaks a locus override; the row auto-detects.
          const locus = config?.locus ?? detectLocus(target.repoPath);
          projects.push({
            projectId: project.id,
            name: multiRepo ? `${project.name} · ${basename(target.repoPath)}` : project.name,
            repoPath: target.repoPath,
            visibility: visibility.value,
            visibilityProvenance: visibility.provenance,
            promoted: promoted.value,
            promotedProvenance: promoted.provenance,
            locus,
            locusOverridden: config?.locus !== undefined,
            configMalformed,
          });
        }
      }
      return {
        scheme: scheme.value,
        schemeProvenance: scheme.provenance,
        appearanceMalformed: schemeState.status === "malformed",
        projects,
      };
    },

    guidance: async (projectId: string, repoPath: string): Promise<SettingsGuidance> => {
      const project = deps.listProjects().find((entry) => entry.id === projectId);
      // The renderer-supplied `repoPath` is validated against the resolved targets.
      const target = project
        ? (await targetsFor(project)).find((entry) => entry.repoPath === repoPath)
        : undefined;
      if (!target) return { rules: [], reason: "absent", dropped: 0 };
      const load = deps.loadGuidance(target.repoRoot);
      if (!load.catalogue) {
        return { rules: [], reason: load.reason ?? "absent", dropped: load.dropped };
      }
      return {
        rules: load.catalogue.rules.map((rule) => ({
          convention: rule.convention,
          rationale: rule.rationale,
          severity: rule.severity,
          ...(rule.antiPattern ? { antiPattern: rule.antiPattern } : {}),
        })),
        reason: null,
        dropped: load.dropped,
      };
    },

    setAppearance: (scheme: SettingsView["scheme"]): SettingsView["scheme"] => {
      // `updateGlobal` REFUSES (throws) when the config is malformed, so an edit can
      // never overwrite unparseable bytes; the caller surfaces the error.
      deps.updateGlobal((current) => ({
        ...current,
        appearance: { ...current.appearance, scheme },
      }));
      return scheme;
    },

    setRepoVisibility: async (input: {
      projectId: string;
      repoPath: string;
      visibility: ProjectVisibility;
    }): Promise<SetRepoVisibilityOutcome> => {
      const project = deps.listProjects().find((entry) => entry.id === input.projectId);
      // Re-resolve the target from the LIVE project (a checkout may have gone), and
      // reject a `repoPath` not in the project.
      const target = project
        ? (await targetsFor(project)).find((entry) => entry.repoPath === input.repoPath)
        : undefined;
      if (!target) {
        return {
          status: "unresolved",
          visibility: input.visibility,
          changed: false,
          gitignorePath: "",
        };
      }
      // Refuse a malformed config BEFORE any write (Rule 75). The adapter guards
      // this too; refusing here keeps the surface honest without a thrown error.
      if (deps.loadConfigState(target.repoKey).status === "malformed") {
        return {
          status: "malformed",
          visibility: input.visibility,
          changed: false,
          gitignorePath: "",
        };
      }
      const applied = await deps.applyVisibility({
        repoKey: target.repoKey,
        repoRoot: target.repoRoot,
        target: input.visibility,
      });
      return {
        status: "applied",
        visibility: input.visibility,
        changed: applied.changed,
        gitignorePath: applied.gitignorePath,
      };
    },

    setRepoLocus: async (input: {
      projectId: string;
      repoPath: string;
      locus: Locus | null;
    }): Promise<SetRepoLocusOutcome> => {
      const project = deps.listProjects().find((entry) => entry.id === input.projectId);
      const target = project
        ? (await targetsFor(project)).find((entry) => entry.repoPath === input.repoPath)
        : undefined;
      if (!target) {
        return { status: "unresolved", locus: detectLocus(input.repoPath), locusOverridden: false };
      }
      // Refuse a malformed config before any write (Rule 75), mirroring visibility.
      if (deps.loadConfigState(target.repoKey).status === "malformed") {
        return {
          status: "malformed",
          locus: detectLocus(target.repoPath),
          locusOverridden: false,
        };
      }
      deps.applyLocus({ repoKey: target.repoKey, locus: input.locus });
      return {
        status: "applied",
        locus: input.locus ?? detectLocus(target.repoPath),
        locusOverridden: input.locus !== null,
      };
    },
  };
}
