import { basename } from "node:path";
import {
  type ConventionCatalogueLoad,
  compareVersions,
  type RepoPrefField,
} from "@rennet/adapters";
import {
  detectLocus,
  escapePath,
  REVIEW_ROLE_JOB_IDS,
  type ResolvedTracker,
  type ReviewRoleOverrides,
  resolve,
  resolvePromoted,
  resolveScheme,
  resolveTracker,
  resolveVisibility,
  reviewRoleJobId,
  reviewRoleMappings,
  SETTINGS_REGISTRY,
  type TrackerKind,
} from "@rennet/core";
import type {
  ClientSettings,
  CoachMarks,
  CouncilPick,
  CouncilScenarioOverrides,
  DaemonHostSection,
  DaemonHostStatus,
  DaemonSettings,
  DetectedForge,
  DetectedHarness,
  ForgeHostDetection,
  HarnessHostDetection,
  PairedDevice,
  Project,
  ProjectSource,
  ProjectVisibility,
  ReviewRoleMapping,
  ReviewRoleScenario,
  SetRepoVisibilityOutcome,
  SettingsGuidance,
  SettingsLayer,
  SettingsProject,
  SettingsProjectPrefs,
  SettingsProjectValueKey,
  SettingsProjectWriteOutcome,
  SettingsRepoValueKey,
  SettingsRepoWriteOutcome,
  SettingsView,
  ThemePack,
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
  /** Clock for durable client timestamps. */
  now?: () => Date;
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
        // The pref fields are the REPO RUNG of the settings ladder (C18 group A):
        // absent on an untouched install, so every pref falls back down the ladder.
        config: {
          visibility?: ProjectVisibility;
          promoted?: boolean;
          glyph?: string;
          worktreeBaseDir?: string;
          worktreePattern?: string;
          tracker?: {
            kind?: string;
            projectKey?: string;
            baseUrl?: string;
            tokenEnv?: string;
          };
        };
      };
  /**
   * Write ONE per-project preference on the repo rung (C18 group A) — the project's
   * own `config.json`, the same rung `visibility` uses. `null` RESETS (drops the
   * entry so the value falls back down the ladder). MUST itself refuse a malformed
   * config (throw), exactly as `updateGlobal`/`updateDaemon` do for their files.
   */
  writeRepoValue(input: { repoKey: string; field: RepoPrefField; value: string | null }): void;
  /**
   * The scout's DETECTED-layer offers for one repo, if any were ever recorded. Read
   * here so a row's provenance chip states the same layer RETRIEVAL resolves through
   * (`resolveTrackerConfig` folds the same offers) — a surface that showed `global`
   * for a value retrieval took from `detected` would be a lie about its own ladder.
   * Absent dep ⇒ no detected offers, which is the honest answer for a composition
   * with no scout wired.
   */
  scoutOffers?(repoKey: string): Readonly<Record<string, string | undefined>>;
  /**
   * Write a repo's guidance catalogue to its `.rennet/conventions.json` (C18 group A)
   * — the WRITER beside `loadGuidance`. Returns the catalogue read BACK off the file,
   * so the surface renders what was stored. Throws when the file cannot be written.
   */
  saveGuidance(
    repoRoot: string,
    rules: readonly {
      id?: string;
      convention: string;
      severity: "high" | "medium" | "low";
    }[],
  ): ConventionCatalogueLoad;
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
  /**
   * Ask ONE host's daemon whether it is running, and on which version (C17, #485). Resolves
   * `null` when that host's daemon did NOT answer — the caller then reports the host
   * unreachable and INVENTS NO VERSION for it. A host that answered but cannot name its
   * version resolves `{ version: null }`: reachable, version honestly absent.
   *
   * Absent dep ⇒ no host is probed at all (every host reads unreachable), which is the
   * truthful answer for a composition with no way to ask.
   */
  probeDaemon?(source: ProjectSource): Promise<{ version: string | null } | null>;
  /**
   * RE-ATTEMPT the handshake to one host's daemon on demand (C17 cluster 5, #533) — the effect
   * behind the host card's Reconnect button. Same contract as `probeDaemon` (`null` ⇒ did not
   * answer), with one difference that matters: it may THROW, and the message is shown to the
   * viewer as the reason the reconnect failed. A host kind that cannot be dialled from here at
   * all throws saying so, rather than resolving `null` and reading as a silent timeout.
   *
   * Absent dep ⇒ falls back to `probeDaemon`, which is still a real handshake attempt.
   */
  reconnectDaemon?(source: ProjectSource): Promise<{ version: string | null } | null>;
  /**
   * Ask ONE host which coding harnesses are installed ON IT (C17 cluster 3, #485). Resolves
   * `null` when that host CANNOT BE ASKED from here — the caller then reports honest absence
   * (`asked: false`, no rows) rather than copying this machine's agents onto it. An empty
   * ARRAY is the different, real claim: that host was asked and has none.
   *
   * Absent dep ⇒ no host can be asked, which is the truthful answer for a composition with
   * no detection effect wired.
   */
  detectHarnessesOn?(source: ProjectSource): Promise<DetectedHarness[] | null>;
  /**
   * Ask ONE host which forge (source-control) CLIs are installed ON IT (C17 amendment B) —
   * the exact mirror of `detectHarnessesOn`, and the same honesty: `null` when that host
   * CANNOT BE ASKED from here, so its Source Control section reads honestly absent instead of
   * inheriting this machine's `gh`. An empty ARRAY is the different, real claim: asked, none.
   */
  detectForgesOn?(source: ProjectSource): Promise<DetectedForge[] | null>;
  /**
   * UPDATE one host's daemon (C17 cluster 6, #534) — the effect behind the Update Daemon
   * button. Same contract as `reconnectDaemon`: it resolves the host's post-update answer
   * (`null` ⇒ it did not come back), and it MAY THROW, with the message shown to the viewer
   * as the reason the update failed.
   *
   * Absent dep ⇒ this composition has NO update mechanism at all, and every update attempt
   * says so rather than falling back to a probe that would report a fake success. It never
   * falls back to `probeDaemon`: an update that quietly did nothing must not read green.
   */
  updateDaemonOn?(source: ProjectSource): Promise<{ version: string | null } | null>;
  /**
   * The version THIS host's daemon could be updated TO, or `undefined` when that host has no
   * update mechanism at all. Per host, not global (review finding 5): a host Rennet cannot
   * update must not be told an update is available, because the only thing the button could
   * do there is fail. Absent dep ⇒ no host has a mechanism ⇒ `updateAvailable` is never
   * served, which is the truthful answer for a composition that cannot update anything.
   */
  latestDaemonVersionFor?(source: ProjectSource): string | undefined;
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
  /**
   * Per-host daemon status (C17, #485) for exactly the hosts `get().daemonHosts` enumerates
   * — the SAME enumeration, so the surface can never show a card with no status or a status
   * with no card. Each host's daemon is asked over `probeDaemon`; a host that does not answer
   * reads `reachable: false` with NO version, carrying only a `lastSeenVersion` it really
   * answered with before. Answering versions are remembered in daemon-settings as a
   * side effect, so a host that later goes dark still reads "last seen running v…".
   *
   * A SIBLING read rather than a field on `settings.get`: probing every host costs a bounded
   * network/exec round-trip per host, and `settings.get` is re-read on every appearance edit
   * and settings render. Keeping it separate leaves those reads instant and lets the surface
   * refresh status on its own cadence.
   */
  daemonStatus(): Promise<DaemonHostStatus[]>;
  /**
   * Re-attempt the handshake to ONE host's daemon (C17 cluster 5, #533) — the operation the
   * host card's Reconnect button performs. Runs the same per-host handshake `daemonStatus`
   * polls, for one host, on demand, and reports the OUTCOME rather than a state change: a
   * successful reconnect returns that host reachable with its real version (and remembers it
   * as last-seen, exactly as the poll does); a failed one returns it still unreachable, with
   * the reason. It never reads green on a handshake that did not complete.
   */
  reconnect(source: ProjectSource): Promise<{ status: DaemonHostStatus; error?: string }>;
  /**
   * UPDATE one host's daemon (C17 cluster 6, #534) — the operation the host card's Update
   * Daemon button performs, offered only where `daemonStatus` reported a real `updateAvailable`.
   * Reports the same outcome shape as `reconnect`, for the same reason: the card must follow
   * the host's post-update STATUS, never the click. A host with no update mechanism returns its
   * unchanged status plus the reason — never a "success" for an update that did not happen.
   */
  update(source: ProjectSource): Promise<{ status: DaemonHostStatus; error?: string }>;
  /**
   * The coding agents detected ON EACH HOST (C17 cluster 3, #485), for exactly the hosts
   * `get().daemonHosts` enumerates — the same enumeration `daemonStatus` walks, so a card can
   * never show agents belonging to another machine. Detection happens HERE, server-side: the
   * client holds ONE daemon connection (the locus daemon), so it has nothing to fan out over.
   *
   * A host this daemon cannot interrogate reads `asked: false` with no rows. That is an
   * honest absence, not "no agents installed" — and never the local set copied across.
   */
  harnessHosts(): Promise<HarnessHostDetection[]>;
  /**
   * The forge (source-control) CLIs detected ON EACH HOST (C17 amendment B), over the SAME host
   * enumeration `harnessHosts` walks. `forge.detect` answers for one daemon, so keying its rows
   * to every card would put this machine's `gh` on a distro it was never observed on — and
   * keying it to the connected host alone left every other card structurally unfillable, saying
   * "Connect … to detect its tooling" about a host already connected with the tool installed.
   *
   * A host this daemon cannot interrogate reads `asked: false` with no rows: honest absence.
   */
  forgeHosts(): Promise<ForgeHostDetection[]>;
  /**
   * Rule one agent in or out of reviews ON ONE HOST (C17 cluster 3.2) — the served store the
   * per-host enable toggle writes through, so a ruled-out agent stays ruled out across reload
   * instead of resetting with the renderer. Persisted on the daemon-settings rung beside the
   * host's last-seen version, because it is a per-host fact like the rest of that entry.
   *
   * Scoped to the host: ruling Codex out on this machine leaves it running on a WSL distro.
   * It is a DECISION, never a detection — it installs nothing, hides nothing, and an id
   * disabled on a host with no such agent simply matches no row. Returns the host's ruled-out
   * ids after the write. A malformed daemon-settings refuses it (throws), as every write here does.
   */
  setHarnessEnabled(input: {
    source: ProjectSource;
    harnessId: string;
    enabled: boolean;
  }): string[];
  /**
   * Rule one forge CLI in or out ON ONE HOST (amendment A) — the same served store, the same
   * per-host daemon-settings entry, for the Source Control row's toggle. Before this the row
   * wrote nowhere: it flipped, persisted nothing, and a reload silently restored it, which is
   * a control lying about a decision the product does not keep.
   *
   * Read back through `harnessHosts()`'s `disabledForges`. Returns the host's ruled-out forge
   * ids after the write; a malformed daemon-settings refuses it (throws), as every write here does.
   */
  setForgeEnabled(input: { source: ProjectSource; forgeId: string; enabled: boolean }): string[];
  guidance(projectId: string, repoPath: string): Promise<SettingsGuidance>;
  setAppearance(scheme: SettingsView["scheme"] | null): SettingsView["scheme"];
  setThemePack(themePack: ThemePack): ThemePack;
  completeWelcome(): string;
  /**
   * Replay the first-run welcome — the counterpart `completeWelcome` never had, which
   * left the wizard permanently unreachable once setup finished. ONE atomic write
   * REPLACES the whole `welcome` slice with `{ replayRequestedAt }`: the completion
   * stamp is dropped, and the stamp left behind is what the startup gate honors
   * regardless of project count (eligibility alone only ever elects a zero-project
   * client, so clearing the stamp by itself would be a no-op on a real machine).
   * Returns the request stamp. A malformed client-settings file refuses it (throws),
   * as every write here does. No confirmation — a plain write (Rule Zero).
   */
  resetWelcome(): string;
  setLastProject(input: { source: ProjectSource; projectId: string }): {
    source: ProjectSource;
    projectId: string;
  };
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
   * PER-SCENARIO (Rai, 2026-08-28): the write touches exactly ONE `(job, scenario)`
   * cell of `routing.task`. `null` clears that cell only, so it falls back to that
   * scenario's council-table default while the sibling columns keep their own
   * overrides — one edit never moves three columns.
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
  /**
   * Write ONE per-project preference on the REPO rung (C18 group A) — glyph, the
   * worktree pair, or this project's issue-tracker override. `value: null` resets
   * (the entry is dropped and the value falls back down the ladder). Values validate
   * through the same `SETTINGS_REGISTRY` declarations the resolver reads, so a write
   * and a read cannot disagree on what a legal value is; a malformed repo config
   * REFUSES the write (`status: "malformed"`, nothing written) exactly as the other
   * repo-scoped writes do. `applied` carries the freshly re-resolved row.
   *
   * The tracker keys are the ones with teeth: the same repo rung is what
   * `resolveTrackerConfig` folds over the host's global answer, so this write reaches
   * retrieval instead of decorating a surface.
   */
  setProjectValue(input: {
    projectId: string;
    repoPath: string;
    key: SettingsProjectValueKey;
    value: string | null;
  }): Promise<SettingsProjectWriteOutcome>;
  /**
   * Write a repo's guidance rules to its `.rennet/conventions.json` — the WRITE beside
   * `guidance`'s read, and the same file the lens runners read before every review.
   * Returns the catalogue read BACK off the file, so the surface renders what was
   * stored rather than the request echoed. `unresolved` ⇒ nothing was written.
   */
  setGuidance(input: {
    projectId: string;
    repoPath: string;
    rules: readonly { id?: string; rule: string; severity: "high" | "medium" | "low" }[];
  }): Promise<{ status: "applied" | "unresolved"; guidance: SettingsGuidance }>;
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

type DaemonHostEntry = NonNullable<DaemonSettings["hosts"]>[string];

/**
 * Merge per-host edits into daemon-settings' `hosts` map, PRESERVING every other fact each
 * entry already carries. One entry holds two independent things — the version a host was last
 * seen running and the agents the viewer ruled out there — written by two different paths, so
 * replacing an entry wholesale would let a background status poll silently un-rule-out an agent.
 */
function withHostEntries(
  current: DaemonSettings,
  edits: Readonly<Record<string, Partial<DaemonHostEntry>>>,
): DaemonSettings {
  const hosts: Record<string, DaemonHostEntry> = { ...current.hosts };
  for (const [source, edit] of Object.entries(edits)) {
    hosts[source] = { ...hosts[source], ...edit };
  }
  return { ...current, hosts };
}

/**
 * A host's ruled-out id list after one toggle (C17 cluster 3.2 + amendment A) — the same
 * decision arithmetic for agents and forge CLIs, so the two toggles cannot drift apart.
 * Idempotent: ruling out something already ruled out changes nothing.
 */
function ruledOut(current: readonly string[] = [], id: string, enabled: boolean): string[] {
  if (enabled) return current.filter((entry) => entry !== id);
  return current.includes(id) ? [...current] : [...current, id];
}

/**
 * One host's status from ONE probe answer (C17) — the single place the honesty rules live, so
 * the polled read (`daemonStatus`) and the on-demand re-handshake (`reconnect`) can never
 * disagree about what a non-answer means. A `null` answer INVENTS NOTHING: no `version`, no
 * `updateAvailable` (an unknown running version compares to nothing), only a `lastSeenVersion`
 * the host really answered with before. `updateAvailable` needs BOTH sides real.
 */
function hostStatus(
  source: ProjectSource,
  answer: { version: string | null } | null,
  lastSeenVersion: string | undefined,
  latest: string | undefined,
): DaemonHostStatus {
  if (!answer) {
    return { source, reachable: false, ...(lastSeenVersion ? { lastSeenVersion } : {}) };
  }
  const version = answer.version ?? undefined;
  // BOTH sides must be real AND comparable, or there is no flag at all.
  const updateAvailable =
    version !== undefined &&
    latest !== undefined &&
    NUMERIC_VERSION.test(version) &&
    NUMERIC_VERSION.test(latest)
      ? compareVersions(version, latest) < 0
      : undefined;
  return {
    source,
    reachable: true,
    ...(version ? { version } : {}),
    ...(updateAvailable === undefined ? {} : { updateAvailable }),
  };
}

/**
 * The version grammar `compareVersions` can actually decide: dot-separated numbers, nothing
 * else. It parses every other segment as 0, so `1.2.0-rc.1` reads identical to `1.2.0` and a
 * `nightly` build compares as `0` — either hiding a real update or inventing one (review
 * finding 6). Anything outside the grammar therefore yields NO flag rather than a guess.
 */
const NUMERIC_VERSION = /^\d+(\.\d+)*$/;

/**
 * Each per-project preference key → the registry declaration that validates it and the
 * repo-config field it is stored in (C18 group A). ONE table, so the write's validator,
 * the read's resolver, and the stored shape can never drift apart.
 */
const PROJECT_PREF: Record<
  SettingsProjectValueKey,
  { readonly field: RepoPrefField; readonly validate: (value: string) => string }
> = {
  glyph: { field: "glyph", validate: SETTINGS_REGISTRY.projectGlyph.validate },
  worktreeRoot: { field: "worktreeBaseDir", validate: SETTINGS_REGISTRY.worktreeBaseDir.validate },
  worktreePattern: {
    field: "worktreePattern",
    validate: SETTINGS_REGISTRY.worktreePattern.validate,
  },
  // The tracker vocabulary is enforced by the SAME validator retrieval resolves through,
  // so `kind: "jra"` is refused at the write instead of resolving to nothing later.
  trackerKind: { field: "trackerKind", validate: SETTINGS_REGISTRY.trackerKind.validate },
  trackerProjectKey: {
    field: "trackerProjectKey",
    validate: SETTINGS_REGISTRY.trackerProjectKey.validate,
  },
  trackerBaseUrl: { field: "trackerBaseUrl", validate: SETTINGS_REGISTRY.trackerBaseUrl.validate },
  trackerTokenEnv: {
    field: "trackerTokenEnv",
    validate: SETTINGS_REGISTRY.trackerTokenEnv.validate,
  },
};

/** One catalogue load → the surface's guidance view. ONE mapping for the read and the
 *  write, so the panel after a save shows exactly what the next read would show. */
function guidanceView(load: ConventionCatalogueLoad): SettingsGuidance {
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
}

/** A resolved tracker section → the wire's `{ value, layer }` cells. */
function trackerView(resolved: ResolvedTracker): SettingsProjectPrefs["tracker"] {
  return {
    kind: { value: resolved.kind.value as string, layer: resolved.kind.layer },
    projectKey: { value: resolved.projectKey.value, layer: resolved.projectKey.layer },
    baseUrl: { value: resolved.baseUrl.value, layer: resolved.baseUrl.layer },
    tokenEnv: { value: resolved.tokenEnv.value, layer: resolved.tokenEnv.layer },
  };
}

/** A STORED tracker kind as a ladder offer: only the real vocabulary is offered, so a
 *  hand-edited `kind: "jra"` is ignored rather than thrown into resolution. */
function trackerKindOffer(value: string | undefined): TrackerKind | undefined {
  return value === "none" || value === "github" || value === "jira" || value === "linear"
    ? value
    : undefined;
}

/** The update attempt for a composition with NO update effect wired: it says so and changes
 *  nothing, so the card shows a failure line rather than a success it did not earn. */
function noUpdateMechanism(): Promise<{ version: string | null } | null> {
  return Promise.reject(new Error("Rennet has no way to update this host's daemon."));
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
  // A trimmed, non-empty offer, or `undefined` — an empty stored string is NOT an
  // offer (it is what "unset" looks like), so it must not out-rank a lower layer.
  const offer = (value: string | undefined): string | undefined =>
    value === undefined || value.trim() === "" ? undefined : value.trim();

  /**
   * One repo's per-project prefs, resolved off the ladder (C18 group A). The offers are
   * exactly the ones the ENGINE resolves through elsewhere: the scout's detected facts
   * (the same ones `resolveTrackerConfig` folds), the host's global rung in
   * daemon-settings, and the project's own repo rung — so the chip on the surface names
   * the layer retrieval really used. Guidance rides along from the repo's own catalogue.
   */
  const resolvePrefs = (
    target: RepoTarget,
    config: {
      glyph?: string;
      worktreeBaseDir?: string;
      worktreePattern?: string;
      tracker?: { kind?: string; projectKey?: string; baseUrl?: string; tokenEnv?: string };
    } | null,
  ): SettingsProjectPrefs => {
    const detected = deps.scoutOffers?.(target.repoKey) ?? {};
    const globalTracker = deps.readDaemonSettings().tracker ?? {};
    const repoTracker = config?.tracker ?? {};
    const layered = <T extends string>(resolved: { value: T; layer: SettingsLayer }) => ({
      value: resolved.value as string,
      layer: resolved.layer,
    });
    const guidance = deps.loadGuidance(target.repoRoot);
    return {
      glyph: layered(resolve(SETTINGS_REGISTRY.projectGlyph, { repo: offer(config?.glyph) })),
      worktreeRoot: layered(
        resolve(SETTINGS_REGISTRY.worktreeBaseDir, {
          detected: offer(detected.worktreeBaseDir),
          repo: offer(config?.worktreeBaseDir),
        }),
      ),
      worktreePattern: layered(
        resolve(SETTINGS_REGISTRY.worktreePattern, { repo: offer(config?.worktreePattern) }),
      ),
      // ONE law for the whole section, the SAME one retrieval resolves through
      // (`resolveTracker`): an endpoint field offered below the layer that set the
      // kind belongs to another provider and is masked out. Without that, this
      // surface would show a JIRA project the host's Linear token — and retrieval
      // would call it.
      tracker: trackerView(
        resolveTracker({
          kind: {
            detected: trackerKindOffer(detected.trackerKind),
            global: trackerKindOffer(globalTracker.kind),
            repo: trackerKindOffer(repoTracker.kind),
          },
          projectKey: {
            detected: offer(detected.trackerProjectKey),
            global: offer(globalTracker.projectKey),
            repo: offer(repoTracker.projectKey),
          },
          baseUrl: { global: offer(globalTracker.baseUrl), repo: offer(repoTracker.baseUrl) },
          tokenEnv: { global: offer(globalTracker.tokenEnv), repo: offer(repoTracker.tokenEnv) },
        }),
      ),
      // The rules as the surface edits them (statement + severity). The authored
      // rationale and anti-pattern stay in the file — read by the review runners,
      // never rewritten from here.
      guidance: (guidance.catalogue?.rules ?? []).map((rule) => ({
        // The stable id rides out so an edit comes back addressing the SAME rule.
        ...(rule.id ? { id: rule.id } : {}),
        rule: rule.convention,
        severity: rule.severity,
      })),
    };
  };

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
      // A malformed config contributes NO repo offers (`config` is null), so the row
      // shows the lower layers' answers and its edits are refused — the same rule the
      // rest of the row already follows.
      prefs: resolvePrefs(target, config),
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

  /**
   * Run ONE on-demand per-host operation (Reconnect, cluster 5; Update Daemon, cluster 6) and
   * report its OUTCOME rather than a state change. Both operations share this body because
   * both must obey the same rule: the card follows what the host answered AFTERWARDS, never
   * the click. A thrown reason is surfaced verbatim — a generic "failed" tells the viewer
   * nothing about which thing to go fix — and a host that answered is remembered as last-seen,
   * merged into its entry so the viewer's per-host decisions survive.
   */
  const attemptOn = async (
    source: ProjectSource,
    attempt: ((source: ProjectSource) => Promise<{ version: string | null } | null>) | undefined,
  ): Promise<{ status: DaemonHostStatus; error?: string }> => {
    const lastSeenVersion = deps.readDaemonSettings().hosts?.[source]?.lastSeenVersion;
    let answer: { version: string | null } | null = null;
    let error: string | undefined;
    try {
      answer = (await attempt?.(source)) ?? null;
    } catch (reason) {
      error = reason instanceof Error ? reason.message : String(reason);
    }
    const status = hostStatus(
      source,
      answer,
      lastSeenVersion,
      deps.latestDaemonVersionFor?.(source),
    );
    const sighted = status.reachable ? status.version : undefined;
    if (sighted && sighted !== lastSeenVersion) {
      try {
        deps.updateDaemon((current) =>
          withHostEntries(current, { [source]: { lastSeenVersion: sighted } }),
        );
      } catch {
        // A malformed daemon-settings refuses the write; the live outcome still returns.
      }
    }
    return { status, ...(error ? { error } : {}) };
  };

  // The persisted per-scenario `routing.task` slice (C16, #485). Only job ids the
  // review-role catalogue actually names are admitted: a stale or unknown key in
  // `client-settings.json` is IGNORED rather than fed to the resolver, so a
  // hand-edited config can never route a job the surface does not show.
  const storedOverrides = (client: ClientSettings): ReviewRoleOverrides | undefined => {
    const stored = client.routing?.task;
    if (!stored) return undefined;
    const task: Record<string, CouncilScenarioOverrides> = {};
    let any = false;
    for (const jobId of REVIEW_ROLE_JOB_IDS) {
      const entry = stored[jobId];
      if (entry === undefined) continue;
      task[jobId] = entry;
      any = true;
    }
    return any ? task : undefined;
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
        ...(schemeState.config.appearance?.themePack
          ? { themePack: schemeState.config.appearance.themePack }
          : {}),
        ...(schemeState.config.welcome ? { welcome: schemeState.config.welcome } : {}),
        ...(schemeState.config.navigation ? { navigation: schemeState.config.navigation } : {}),
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

    daemonStatus: async (): Promise<DaemonHostStatus[]> => {
      // What each host was LAST SEEN running (C17 reconciliation 4). Only versions a host
      // really answered with are in here — there is no entry to read for a host that has
      // never answered, so a never-seen host reads blank rather than fabricated.
      const remembered = deps.readDaemonSettings().hosts ?? {};

      const statuses: DaemonHostStatus[] = [];
      // Versions learned THIS pass that differ from what is stored — persisted once at the
      // end so a steady-state poll of unchanged hosts costs no disk write.
      const learned: Record<string, { lastSeenVersion: string }> = {};

      for (const host of daemonHostSections(deps.listProjects())) {
        // No probe dep wired ⇒ no answer, which `hostStatus` reads as unreachable. Absence is
        // never a reachable host: an unasked host must not inherit a version it never gave.
        const answer = (await deps.probeDaemon?.(host.source).catch(() => null)) ?? null;
        const lastSeenVersion = remembered[host.source]?.lastSeenVersion;
        const status = hostStatus(
          host.source,
          answer,
          lastSeenVersion,
          deps.latestDaemonVersionFor?.(host.source),
        );
        const sighted = status.reachable ? status.version : undefined;
        if (sighted && sighted !== lastSeenVersion) {
          learned[host.source] = { lastSeenVersion: sighted };
        }
        statuses.push(status);
      }

      if (Object.keys(learned).length > 0) {
        try {
          // MERGED into the host's entry, never replacing it: that entry also carries the
          // viewer's per-host agent decisions (3.2), and learning a version must not
          // silently un-rule-out an agent they ruled out.
          deps.updateDaemon((current) => withHostEntries(current, learned));
        } catch {
          // A malformed daemon-settings REFUSES the write (Rule 75) — remembering a version
          // is not worth failing the status read over, so the live answer still returns.
        }
      }
      return statuses;
    },

    reconnect: (source) => attemptOn(source, deps.reconnectDaemon ?? deps.probeDaemon),

    update: (source) =>
      // No fallback to a probe: an update with no mechanism must report that it did nothing,
      // and a probe would answer "reachable" for a host still running the OLD version.
      attemptOn(source, deps.updateDaemonOn ?? noUpdateMechanism),

    forgeHosts: async (): Promise<ForgeHostDetection[]> => {
      const hosts: ForgeHostDetection[] = [];
      for (const host of daemonHostSections(deps.listProjects())) {
        // A detection that REJECTS is a host that could not be asked, exactly like a dep that
        // resolves null — either way nothing was observed there, so nothing is claimed.
        const detected = await deps.detectForgesOn?.(host.source).catch(() => null);
        hosts.push(
          detected
            ? { source: host.source, asked: true, detected }
            : { source: host.source, asked: false, detected: [] },
        );
      }
      return hosts;
    },

    harnessHosts: async (): Promise<HarnessHostDetection[]> => {
      // The viewer's PERSISTED per-host decisions (3.2), read once per pass. A host with no
      // entry has ruled nothing out, so every agent it reports reads enabled.
      const remembered = deps.readDaemonSettings().hosts ?? {};
      const hosts: HarnessHostDetection[] = [];
      for (const host of daemonHostSections(deps.listProjects())) {
        // The forge ruling rides this per-host read (amendment A): it lives on the SAME
        // daemon-settings entry, and serving it here means the toggle reads back what is
        // stored without a second round trip. It is a decision list only — it says nothing
        // about which forge CLIs exist (that is `forge.detect`).
        const disabledForges = remembered[host.source]?.disabledForges ?? [];
        const forgeRuling = disabledForges.length > 0 ? { disabledForges } : {};
        // A detection that REJECTS is a host that could not be asked, exactly like a dep
        // that resolves null — either way nothing was observed there, so nothing is claimed.
        const detected = await deps.detectHarnessesOn?.(host.source).catch(() => null);
        if (!detected) {
          hosts.push({ source: host.source, asked: false, detected: [], ...forgeRuling });
          continue;
        }
        const disabled = new Set(remembered[host.source]?.disabledHarnesses ?? []);
        hosts.push({
          source: host.source,
          asked: true,
          ...forgeRuling,
          // A ruled-out agent is still DETECTED and still listed — the decision turns its
          // toggle off, it does not hide a binary that is really installed.
          detected: detected.map((harness) => ({ ...harness, enabled: !disabled.has(harness.id) })),
        });
      }
      return hosts;
    },

    setHarnessEnabled: (input): string[] => {
      const disabled = ruledOut(
        deps.readDaemonSettings().hosts?.[input.source]?.disabledHarnesses,
        input.harnessId,
        input.enabled,
      );
      // A malformed daemon-settings REFUSES the write (Rule 75) — `updateDaemon` throws and
      // the caller learns the decision did not persist, rather than being told it did.
      deps.updateDaemon((stored) =>
        withHostEntries(stored, { [input.source]: { disabledHarnesses: disabled } }),
      );
      return disabled;
    },

    setForgeEnabled: (input): string[] => {
      // The same write, on the same entry, for the Source Control row (amendment A). The
      // entry merge is what keeps the two rulings independent: ruling out `gh` must not
      // un-rule-out an agent, and learning a daemon version must not clear either.
      const disabled = ruledOut(
        deps.readDaemonSettings().hosts?.[input.source]?.disabledForges,
        input.forgeId,
        input.enabled,
      );
      deps.updateDaemon((stored) =>
        withHostEntries(stored, { [input.source]: { disabledForges: disabled } }),
      );
      return disabled;
    },

    guidance: async (projectId: string, repoPath: string): Promise<SettingsGuidance> => {
      const project = deps.listProjects().find((entry) => entry.id === projectId);
      // The renderer-supplied `repoPath` is validated against the resolved targets.
      const target = project
        ? (await targetsFor(project)).find((entry) => entry.repoPath === repoPath)
        : undefined;
      if (!target) return { rules: [], reason: "absent", dropped: 0 };
      return guidanceView(deps.loadGuidance(target.repoRoot));
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

    setThemePack: (themePack): ThemePack => {
      const written = deps.updateGlobal((current) => ({
        ...current,
        appearance: { ...current.appearance, themePack },
      }));
      return written.appearance?.themePack ?? "affineur";
    },

    completeWelcome: (): string => {
      const completedAt = (deps.now?.() ?? new Date()).toISOString();
      const written = deps.updateGlobal((current) => ({
        ...current,
        welcome: { completedAt },
      }));
      return written.welcome?.completedAt ?? completedAt;
    },

    resetWelcome: (): string => {
      const replayRequestedAt = (deps.now?.() ?? new Date()).toISOString();
      // ONE `updateGlobal` — the same atomic write + malformed refusal `completeWelcome`
      // rides. Replacing the slice (rather than merging) is the point: the completion
      // stamp goes AND the replay request lands together, so the two can never disagree.
      const written = deps.updateGlobal((current) => ({
        ...current,
        welcome: { replayRequestedAt },
      }));
      return written.welcome?.replayRequestedAt ?? replayRequestedAt;
    },

    setLastProject: (input) => {
      const written = deps.updateGlobal((current) => ({
        ...current,
        navigation: {
          ...current.navigation,
          lastProjectBySource: {
            ...current.navigation?.lastProjectBySource,
            [input.source]: input.projectId,
          },
        },
      }));
      return {
        source: input.source,
        projectId: written.navigation?.lastProjectBySource?.[input.source] ?? input.projectId,
      };
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
      // never overwrite unparseable bytes (Rule 75). A pick SETS this ONE (job,
      // scenario) cell; `null` RESETS by dropping that cell only, so it falls back to
      // that scenario's council table while the sibling columns keep their own
      // overrides. A plain write, first click, no confirmation (Rule Zero).
      const written = deps.updateGlobal((current) => {
        const task = { ...current.routing?.task };
        const cells: CouncilScenarioOverrides = { ...task[jobId] };
        if (input.assignment === null) delete cells[input.scenario];
        // Model + effort ONLY — harness always derives from the model's provider (#89).
        else
          cells[input.scenario] = {
            model: input.assignment.model,
            effort: input.assignment.effort,
          };
        // Clearing a job's last cell drops the job entry, and clearing the last job
        // drops the whole slice — an install that reset everything is byte-identical
        // to one that never overrode anything.
        if (Object.keys(cells).length === 0) delete task[jobId];
        else task[jobId] = cells;
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

    setProjectValue: async (input): Promise<SettingsProjectWriteOutcome> => {
      const live = await liveTarget(input.projectId, input.repoPath);
      if (!live) return { status: "unresolved", key: input.key, project: null };
      // Refuse BEFORE any write (Rule 75). The adapter guards this too; refusing here
      // keeps the surface honest without a thrown error the row cannot explain.
      if (deps.loadConfigState(live.target.repoKey).status === "malformed") {
        return { status: "malformed", key: input.key, project: null };
      }
      const pref = PROJECT_PREF[input.key];
      // Validate through the registry declaration the RESOLVER reads by, so the write
      // and the read cannot disagree about what a legal value is. A blank value is a
      // RESET — the entry is dropped so the value falls back down the ladder.
      const validated = input.value === null ? null : pref.validate(input.value);
      deps.writeRepoValue({
        repoKey: live.target.repoKey,
        field: pref.field,
        value: validated === "" ? null : validated,
      });
      // Re-resolve from the live store: the surface adopts the resolver's own answer.
      return {
        status: "applied",
        key: input.key,
        project: resolveRow(live.project, live.target, live.multiRepo),
      };
    },

    setGuidance: async (input) => {
      const live = await liveTarget(input.projectId, input.repoPath);
      if (!live) {
        return { status: "unresolved", guidance: { rules: [], reason: "absent", dropped: 0 } };
      }
      const written = deps.saveGuidance(
        live.target.repoRoot,
        input.rules.map((rule) => ({
          ...(rule.id ? { id: rule.id } : {}),
          convention: rule.rule,
          severity: rule.severity,
        })),
      );
      return { status: "applied", guidance: guidanceView(written) };
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
