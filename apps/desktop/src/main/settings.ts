import { basename } from "node:path";
import type { ConventionCatalogueLoad } from "@rennet/adapters";
import {
  detectLocus,
  escapePath,
  type Locus,
  resolveLocus,
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
  SettingsRepoValueKey,
  SettingsRepoWriteOutcome,
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
  loadConfigState(repoKey: string):
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
  /**
   * Delete a repo-scoped config field, dropping the repo-layer entry so the value
   * falls back down the ladder (Reset). A plain config write — never a gate. The
   * adapter's Rule-75 guard refuses when the file is malformed.
   */
  clearRepoValue(input: { repoKey: string; field: SettingsRepoValueKey }): void;
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
  setAppearance(scheme: SettingsView["scheme"] | null): SettingsView["scheme"];
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
  resetRepoValue(input: {
    projectId: string;
    repoPath: string;
    key: SettingsRepoValueKey;
  }): Promise<SettingsRepoWriteOutcome>;
  pinRepoValue(input: {
    projectId: string;
    repoPath: string;
    key: SettingsRepoValueKey;
  }): Promise<SettingsRepoWriteOutcome>;
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

  // Resolve ONE repo's row from the LIVE store — the resolver's own answer for
  // every setting, provenance and all. Reused by `get()` and by reset/pin, so a
  // post-write re-resolution renders exactly what the engine now resolves (never a
  // hand-recomputed account that could disagree). A malformed config never leaks
  // its unparseable values: the row shows builtin/detected defaults and refuses edits.
  const resolveRow = (
    project: Project,
    target: RepoTarget,
    multiRepo: boolean,
  ): SettingsProject => {
    const configState = deps.loadConfigState(target.repoKey);
    const configMalformed = configState.status === "malformed";
    const config = configState.status === "ok" ? configState.config : null;
    const visibility = resolveVisibility(config?.visibility);
    const promoted = resolvePromoted(config?.promoted);
    // Locus resolves THROUGH the ladder (detected < repo), not around it —
    // `locusOverridden` is derived from the resolved layer, not a side-channel.
    const locus = resolveLocus(detectLocus(target.repoPath), config?.locus);
    return {
      projectId: project.id,
      name: multiRepo ? `${project.name} · ${basename(target.repoPath)}` : project.name,
      repoPath: target.repoPath,
      visibility: visibility.value,
      visibilityProvenance: visibility.provenance,
      promoted: promoted.value,
      promotedProvenance: promoted.provenance,
      locus: locus.value,
      locusOverridden: locus.layer === "repo",
      locusProvenance: locus.provenance,
      configMalformed,
    };
  };

  // Re-resolve the LIVE target for a repo-scoped write: the project must still exist
  // and own `repoPath` (a checkout may have gone). Returns the target + project +
  // multiRepo flag so a row can be re-resolved after the write.
  const liveTarget = async (
    projectId: string,
    repoPath: string,
  ): Promise<{ project: Project; target: RepoTarget; multiRepo: boolean } | null> => {
    const project = deps.listProjects().find((entry) => entry.id === projectId);
    if (!project) return null;
    const targets = await targetsFor(project);
    const target = targets.find((entry) => entry.repoPath === repoPath);
    if (!target) return null;
    return { project, target, multiRepo: targets.length > 1 };
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
          projects.push(resolveRow(project, target, multiRepo));
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

    setAppearance: (scheme: SettingsView["scheme"] | null): SettingsView["scheme"] => {
      // `updateGlobal` REFUSES (throws) when the config is malformed, so an edit can
      // never overwrite unparseable bytes; the caller surfaces the error. A `null`
      // scheme RESETS to the builtin — drop the stored entry so it falls back down
      // the ladder (a plain write, Rule Zero — the global-layer reset).
      deps.updateGlobal((current) => {
        if (scheme === null) {
          const appearance = { ...current.appearance };
          delete appearance.scheme;
          return { ...current, appearance };
        }
        return { ...current, appearance: { ...current.appearance, scheme } };
      });
      // A set returns the value just written; a reset re-resolves the effective
      // value the cleared ladder now yields (the builtin).
      return scheme ?? resolveScheme(deps.readGlobalState().config).value;
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
      const live = await liveTarget(input.projectId, input.repoPath);
      if (!live) {
        const locus = resolveLocus(detectLocus(input.repoPath), undefined);
        return {
          status: "unresolved",
          locus: locus.value,
          locusOverridden: false,
          project: null,
        };
      }
      // Refuse a malformed config before any write (Rule 75), mirroring visibility.
      if (deps.loadConfigState(live.target.repoKey).status === "malformed") {
        const locus = resolveLocus(detectLocus(live.target.repoPath), undefined);
        return {
          status: "malformed",
          locus: locus.value,
          locusOverridden: false,
          project: null,
        };
      }
      deps.applyLocus({ repoKey: live.target.repoKey, locus: input.locus });
      const project = resolveRow(live.project, live.target, live.multiRepo);
      return {
        status: "applied",
        locus: project.locus,
        locusOverridden: project.locusOverridden,
        project,
      };
    },

    // Reset a repo-scoped value to inheritance: drop the repo-layer entry so the
    // value falls back down the ladder. For VISIBILITY this also re-applies the
    // gitignore switch toward the newly effective value FIRST, so `.rennet/.gitignore`
    // matches the value the row will now resolve to — a reset that changed the
    // effective value without applying it would be a lie in the UI (design Dec. 4).
    // Both mirror `setRepoVisibility`'s live re-resolution and Rule-75 refusal.
    resetRepoValue: async (input: {
      projectId: string;
      repoPath: string;
      key: SettingsRepoValueKey;
    }): Promise<SettingsRepoWriteOutcome> => {
      const live = await liveTarget(input.projectId, input.repoPath);
      if (!live) return { status: "unresolved", key: input.key, project: null };
      if (deps.loadConfigState(live.target.repoKey).status === "malformed") {
        return { status: "malformed", key: input.key, project: null };
      }
      if (input.key === "visibility") {
        // The effective value once the repo entry is gone (builtin `local` today).
        const effective = resolveVisibility(undefined).value;
        await deps.applyVisibility({
          repoKey: live.target.repoKey,
          repoRoot: live.target.repoRoot,
          target: effective,
        });
      }
      deps.clearRepoValue({ repoKey: live.target.repoKey, field: input.key });
      return {
        status: "applied",
        key: input.key,
        project: resolveRow(live.project, live.target, live.multiRepo),
      };
    },

    // Pin a repo-scoped value at the repo layer: write the CURRENT effective value
    // explicitly, so a change in a lower layer or in detection no longer moves it
    // (chiefly: freeze an auto-detected locus). Set-to-current-effective, so it
    // reuses the SAME setters the explicit controls use — no new write path.
    pinRepoValue: async (input: {
      projectId: string;
      repoPath: string;
      key: SettingsRepoValueKey;
    }): Promise<SettingsRepoWriteOutcome> => {
      const live = await liveTarget(input.projectId, input.repoPath);
      if (!live) return { status: "unresolved", key: input.key, project: null };
      if (deps.loadConfigState(live.target.repoKey).status === "malformed") {
        return { status: "malformed", key: input.key, project: null };
      }
      // Resolve the value at command time (not the renderer's snapshot), then write
      // it at the repo layer through the setter that owns that key's side effects.
      const current = resolveRow(live.project, live.target, live.multiRepo);
      if (input.key === "visibility") {
        await deps.applyVisibility({
          repoKey: live.target.repoKey,
          repoRoot: live.target.repoRoot,
          target: current.visibility,
        });
      } else {
        deps.applyLocus({ repoKey: live.target.repoKey, locus: current.locus });
      }
      return {
        status: "applied",
        key: input.key,
        project: resolveRow(live.project, live.target, live.multiRepo),
      };
    },
  };
}
