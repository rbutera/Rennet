import { basename } from "node:path";
import type { ConventionCatalogueLoad } from "@rennet/adapters";
import {
  detectLocus,
  escapePath,
  REVIEW_ROLE_JOB_IDS,
  resolvePromoted,
  resolveScheme,
  resolveVisibility,
  reviewRoleJobId,
  reviewRoleMappings,
  SETTINGS_REGISTRY,
} from "@rennet/core";
import type {
  ClientSettings,
  CoachMarks,
  CouncilJobId,
  CouncilOverridePick,
  CouncilOverrides,
  CouncilPick,
  DaemonHostSection,
  DaemonSettings,
  PairedDevice,
  Project,
  ProjectSource,
  ProjectVisibility,
  ReviewRoleMapping,
  ReviewRoleScenario,
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
        // A stale `locus` may still sit in an old config; it is ignored — execution
        // locus is a detected fact now (#476), read straight off the repo path.
        config: { visibility?: ProjectVisibility; promoted?: boolean };
      };
  /** The viewer's client-settings state (appearance, keybindings). */
  readGlobalState(): { status: "absent" | "ok" | "malformed"; config: ClientSettings };
  /**
   * This host's daemon-settings (the global ladder rung as it exists on the host this
   * daemon runs on, #476). Its `daemon.listen` rung is the only host rung locally
   * readable; remote/WSL hosts keep theirs on that host.
   */
  readDaemonSettings(): DaemonSettings;
  /**
   * Every paired device (newest first), the source for project-less remote hosts on
   * the settings surface (#476, finding 9). A device paired but not yet routing a
   * project still gets a host section, so it is visible before its first project.
   */
  listPairedDevices(): PairedDevice[];
  /** Persist a client-settings edit. MUST itself refuse a malformed file (throw). */
  updateGlobal(update: (current: ClientSettings) => ClientSettings): ClientSettings;
  /**
   * Persist a daemon-settings edit — the host's global ladder rung (#476). The
   * issue-tracker section (#461, B7) is a global-rung host fact, so it is written
   * HERE, not in client settings. MUST itself refuse a malformed file (throw).
   */
  updateDaemon(update: (current: DaemonSettings) => DaemonSettings): DaemonSettings;
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
  /**
   * Set (`keybinding` string), unbind (`null`), or reset (omitted) a command's
   * keybinding override (#44). A plain global write — refused (throws) on a malformed
   * config, exactly as `setAppearance`. Returns the whole stored map after the write.
   */
  setKeybinding(input: { id: string; keybinding?: string | null }): Record<string, string | null>;
  /**
   * Persist the onboarding coach-mark slice (C13) — seen marks + skip-all — to client
   * settings. A plain global write, refused (throws) on a malformed config exactly as
   * `setKeybinding`. Returns the stored slice after the write, so a reload reads back
   * what skip/dismiss/replay persisted.
   */
  setCoachmarks(input: CoachMarks): CoachMarks;
  /**
   * The model-council review-role mappings (C16, #485): the eight roles resolved
   * across `dual`/`claudeOnly`/`codexOnly`, layering the viewer's persisted
   * `routing.task` overrides over the council tables. HONEST-PRESENT — the tables
   * are static, so this is never empty; a role that does not run in a scenario
   * carries a `null` cell (the Flagged Second Seat in the single-provider columns).
   */
  reviewRoles(): ReviewRoleMapping[];
  /**
   * Set (a `CouncilPick`) or RESET (`null`) one review role's model assignment,
   * then return the re-resolved mappings so the surface adopts the resolver's own
   * answer. Model + effort only — harness derives from the model's provider (#89).
   * A malformed config REFUSES the write (throws) exactly as `setKeybinding`.
   *
   * SCENARIO-INDEPENDENT BY CONSTRUCTION: the council's honoured override slot is
   * `routing.task[jobId]`, which is not keyed by scenario (there is exactly one
   * live scenario at run time — whichever the availability probe finds). `scenario`
   * names the cell the viewer edited; the write moves every column that resolves
   * through that job, and the returned re-resolution SHOWS all of them moving
   * rather than pretending the edit was column-local.
   */
  setRoleAssignment(input: {
    roleId: string;
    scenario: ReviewRoleScenario;
    assignment: CouncilPick | null;
  }): ReviewRoleMapping[];
  /**
   * Write one issue-tracker value on the GLOBAL rung (#461, B7) — the ordinary
   * settings write B8's in-chat ask persists through. `null` resets (drops the
   * entry so the ladder falls back to detected/builtin). Values validate through
   * the same `SETTINGS_REGISTRY` declarations the resolver reads; a malformed
   * config refuses the write (throws) exactly as `setAppearance`. Returns the
   * stored tracker section after the write.
   */
  setTrackerValue(input: {
    key: "kind" | "projectKey" | "baseUrl" | "tokenEnv";
    value: string | null;
  }): NonNullable<DaemonSettings["tracker"]>;
  setRepoVisibility(input: {
    projectId: string;
    repoPath: string;
    visibility: ProjectVisibility;
  }): Promise<SetRepoVisibilityOutcome>;
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
    // Execution locus is a DETECTED FACT now (#476) — where the harness runs, read
    // straight off the repo path, not a stored/overridable ladder value.
    const locus = detectLocus(target.repoPath);
    const locusValue = locus.kind === "host" ? "host" : `WSL · ${locus.distro}`;
    return {
      projectId: project.id,
      name: multiRepo ? `${project.name} · ${basename(target.repoPath)}` : project.name,
      repoPath: target.repoPath,
      visibility: visibility.value,
      visibilityProvenance: visibility.provenance,
      promoted: promoted.value,
      promotedProvenance: promoted.provenance,
      locus,
      locusProvenance: {
        layer: "detected",
        contributions: [{ layer: "detected", value: locusValue, effective: true }],
      },
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

  // Every daemon host the surface covers (#476): the LOCAL host first (its
  // `daemon-settings` listener rung is the only one locally readable), then the UNION
  // of every distinct non-local `source` the projects route to AND every paired
  // device (finding 9 — a device paired but with no project yet would otherwise be
  // invisible). A remote/WSL host is LISTED so it is visible, but its rung lives on
  // that host — not fabricated here (no `listen`), which IS the unreadable-remote state.
  const daemonHostSections = (projects: Project[]): DaemonHostSection[] => {
    const listen = deps.readDaemonSettings().daemon?.listen;
    // A paired device's friendly name, keyed by its `remote:<deviceId>` source, so a
    // remote host reads "Remote · <name>" whether or not a project routes to it.
    const deviceNames = new Map<ProjectSource, string>();
    for (const device of deps.listPairedDevices()) {
      deviceNames.set(`remote:${device.deviceId}`, device.name);
    }
    const label = (source: ProjectSource): string => {
      if (source === "local") return "This machine";
      if (source.startsWith("wsl:")) return `WSL · ${source.slice("wsl:".length)}`;
      return `Remote · ${deviceNames.get(source) ?? source.slice("remote:".length)}`;
    };
    const hosts: DaemonHostSection[] = [
      { source: "local", label: "This machine", isLocal: true, ...(listen ? { listen } : {}) },
    ];
    const seen = new Set<ProjectSource>(["local"]);
    const add = (source: ProjectSource): void => {
      if (seen.has(source)) return;
      seen.add(source);
      hosts.push({ source, label: label(source), isLocal: false });
    };
    for (const project of projects) add(project.source);
    for (const source of deviceNames.keys()) add(source);
    return hosts;
  };

  // The persisted `routing.task` slice as council overrides (C16, #485). Only job
  // ids the review-role catalogue actually names are admitted: a stale or unknown
  // key in `client-settings.json` is IGNORED rather than fed to the resolver, so a
  // hand-edited config can never route a job the surface does not show.
  const storedOverrides = (client: ClientSettings): CouncilOverrides | undefined => {
    const stored = client.routing?.task;
    if (!stored) return undefined;
    const task: Partial<Record<CouncilJobId, CouncilOverridePick>> = {};
    let any = false;
    for (const jobId of REVIEW_ROLE_JOB_IDS) {
      const entry = stored[jobId];
      if (entry === undefined) continue;
      task[jobId] = entry;
      any = true;
    }
    return any ? { task: task as Readonly<Record<CouncilJobId, CouncilOverridePick>> } : undefined;
  };

  const resolveReviewRoleView = (): ReviewRoleMapping[] =>
    reviewRoleMappings(storedOverrides(deps.readGlobalState().config));

  return {
    get: async (): Promise<SettingsView> => {
      const schemeState = deps.readGlobalState();
      const scheme = resolveScheme(schemeState.config);
      const projects: SettingsProject[] = [];
      const emittedRepoPaths = new Set<string>();
      const allProjects = deps.listProjects();
      for (const project of allProjects) {
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
        // The stored override map, verbatim (#44). Additive: absent field ⇒ omitted.
        ...(schemeState.config.keybindings ? { keybindings: schemeState.config.keybindings } : {}),
        // The persisted coach-mark slice, verbatim (C13). Additive: absent ⇒ omitted,
        // the client reads it as empty/false. One read seeds the coach store on load.
        ...(schemeState.config.coachmarks ? { coachmarks: schemeState.config.coachmarks } : {}),
        // Every daemon host the surface covers (#476), local first (§4.2).
        daemonHosts: daemonHostSections(allProjects),
        // The council review-role mappings (C16, #485). Honest-present: the
        // assignment tables are static, so the eight roles ride every read even
        // with no override stored — the Review section is never a blank.
        reviewRoles: resolveReviewRoleView(),
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

    setKeybinding: (input): Record<string, string | null> => {
      // `updateGlobal` REFUSES (throws) when the config is malformed, so an edit can
      // never overwrite unparseable bytes (Rule 75). A string SETS the override, an
      // explicit `null` UNBINDS, and an omitted keybinding RESETS (drops the entry so
      // the command falls back to its catalogue default). A plain write, first click,
      // no confirmation — a conflicting chord is accepted and disclosed, never refused
      // (Rule Zero).
      const written = deps.updateGlobal((current) => {
        const keybindings = { ...current.keybindings };
        if (input.keybinding === undefined) delete keybindings[input.id];
        else keybindings[input.id] = input.keybinding;
        return { ...current, keybindings };
      });
      return written.keybindings ?? {};
    },

    setCoachmarks: (input: CoachMarks): CoachMarks => {
      // `updateGlobal` REFUSES (throws) when the config is malformed (Rule 75). The
      // whole slice is written verbatim — the coach store owns the merge (which marks
      // are seen, whether skip-all is set); this is a plain mirror to client settings,
      // no ceremony (Rule Zero). Returns the stored slice so a reload reads it back.
      const written = deps.updateGlobal((current) => ({ ...current, coachmarks: input }));
      return written.coachmarks ?? { seen: [], skipAll: false };
    },

    reviewRoles: resolveReviewRoleView,

    setRoleAssignment: (input): ReviewRoleMapping[] => {
      // Map role → council job through the catalogue, so an override can only land
      // on a job the council already routes (no fabricated ids).
      const jobId = reviewRoleJobId(input.roleId);
      if (jobId === undefined) {
        throw new Error(`settings: unknown review role "${input.roleId}"`);
      }
      // `updateGlobal` REFUSES (throws) when the config is malformed, so an edit can
      // never overwrite unparseable bytes (Rule 75). A pick SETS the override; `null`
      // RESETS by dropping the entry, so the cell falls back to the council table.
      // A plain write, first click, no confirmation (Rule Zero).
      const written = deps.updateGlobal((current) => {
        const task = { ...current.routing?.task };
        if (input.assignment === null) delete task[jobId];
        // Model + effort ONLY — harness always derives from the model's provider (#89).
        else task[jobId] = { model: input.assignment.model, effort: input.assignment.effort };
        // Clearing the last override drops the whole slice, so an install that
        // reset everything is byte-identical to one that never overrode anything.
        const next = { ...current };
        delete next.routing;
        return Object.keys(task).length === 0 ? next : { ...next, routing: { task } };
      });
      // Re-resolve from what was actually written — the surface adopts the
      // resolver's own answer, never a hand-recomputed one that could disagree.
      return reviewRoleMappings(storedOverrides(written));
    },

    setTrackerValue: (input): NonNullable<DaemonSettings["tracker"]> => {
      // Validate through the registry declaration the resolver reads — the write
      // and the read cannot disagree on what a legal value is. `null` resets. The
      // tracker is a GLOBAL-rung host fact (#461, B7), so it writes to DAEMON
      // settings, the same store `resolveTrackerConfig` reads it back from.
      const declaration = {
        kind: SETTINGS_REGISTRY.trackerKind,
        projectKey: SETTINGS_REGISTRY.trackerProjectKey,
        baseUrl: SETTINGS_REGISTRY.trackerBaseUrl,
        tokenEnv: SETTINGS_REGISTRY.trackerTokenEnv,
      }[input.key];
      const value = input.value === null ? null : declaration.validate(input.value);
      const written = deps.updateDaemon((current) => {
        const tracker = { ...current.tracker };
        if (value === null) delete tracker[input.key];
        else tracker[input.key] = value as never;
        return { ...current, tracker };
      });
      return written.tracker ?? {};
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

    // Reset a repo-scoped value to inheritance: drop the repo-layer entry so the
    // value falls back down the ladder. For VISIBILITY (the only repo-layer key now —
    // execution locus is a detected fact, #476) this also re-applies the gitignore
    // switch toward the newly effective value FIRST, so `.rennet/.gitignore` matches
    // the value the row will now resolve to — a reset that changed the effective value
    // without applying it would be a lie in the UI (design Dec. 4). Mirrors
    // `setRepoVisibility`'s live re-resolution and Rule-75 refusal.
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
    // explicitly, so a change in a lower layer no longer moves it. Set-to-current-
    // effective, reusing the SAME setter the explicit control uses — no new write path.
    // `visibility` is the only pinnable key (locus is a detected fact now, #476).
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
      await deps.applyVisibility({
        repoKey: live.target.repoKey,
        repoRoot: live.target.repoRoot,
        target: current.visibility,
      });
      return {
        status: "applied",
        key: input.key,
        project: resolveRow(live.project, live.target, live.multiRepo),
      };
    },
  };
}
