import { basename, join } from "node:path";
import {
  assertWorktreePattern,
  branchWorktreePath,
  type ConventionCatalogueLoad,
  compareVersions,
  expandWorktreeRootForWrite,
  prWorktreePath,
  type RepoPrefField,
  repoKeyForRoot,
  resolveWorktreeRoot,
  type WorktreeRepoFacts,
  type WorktreeRepoIdentity,
} from "@rennet/adapters";
import {
  type CouncilOverrideReader,
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
  taskOverridesFor,
  type WorkspaceMode,
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
  ProjectMarkChoice,
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
import { benchmarkRecordingEnabled } from "@rennet/protocol";
import type { ResolvedWorktreePlacement } from "./bound-workspace";

/**
 * The settings surface's composition (wireframe #15), extracted from the Electron
 * main so the config-ladder logic — repo-identity resolution, workspace expansion,
 * provenance, and the Rule-75 malformed refusals — is unit-testable off-Electron.
 * `index.ts` injects the real effects (git, the stores, discovery, the visibility
 * switch); a test injects fakes. Nothing here touches Electron or the real disk
 * except through the injected effects.
 */

/**
 * The repository facts a placement preview substitutes (workspace-settings D3) — read
 * per REPOSITORY, by its own path, and DEFINED IN ADAPTERS beside the token builders that
 * consume them, because the binding reads the same shape from the same function. Every
 * field is honestly absent when git cannot answer, and the fallback then lives in one
 * place (`branchTokens` / `prTokens`): `local` for an owner no remote resolves, the
 * folder's own basename for a name, `main` for a branch nothing reports.
 */
export type { WorktreeRepoFacts };

/** The minimal on-disk config states this composition reads, from the two stores. */
export interface SettingsCompositionDeps {
  /** Clock for durable client timestamps. */
  now?: () => Date;
  /**
   * The daemon's data directory — the base of the worktree location's BUILTIN
   * (`<dataDir>/worktrees`), resolved at read time so the preview and the binding agree
   * with whatever `--data-dir` / `RENNET_USER_DATA` produced.
   */
  dataDir: string;
  /**
   * One repository's placement facts for the preview (D3). Absent dep ⇒ no facts, which
   * reads exactly as a repository whose remote and branch could not be resolved — never
   * another repository's values.
   */
  worktreeFacts?(repoRoot: string): Promise<WorktreeRepoFacts>;
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
          mark?: string;
          worktreeBaseDir?: string;
          worktreePattern?: string;
          prWorktreePattern?: string;
          workspace?: string;
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
   * Whether ONE repo's project dir holds a copied detected logo (#900, ADR 0004) — the
   * `detected` rung of the `mark` ladder. It asks about the FILE, not the scout's recorded
   * path: the mark is bytes Rennet owns, so a scout fact whose file was never copied (or
   * was removed) must not offer a mark the surface cannot render.
   *
   * Absent dep ⇒ no project offers `detected`, which is the honest answer for a composition
   * with no mark store wired.
   */
  detectedLogoExists?(repoKey: string): boolean;
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

/** The four resolved placement values, declared beside the binding that consumes them. */
export type { ResolvedWorktreePlacement };

export interface SettingsComposition {
  get(): Promise<SettingsView>;
  /**
   * The placement the BINDING resolves by, for one repository root (workspace-settings D1).
   *
   * The same ladder `get()` projects onto a row — builtin < detected < global < repo — read
   * without building the row: the binding needs four values and none of the preview, the
   * provenance chips or the guidance catalogue that a row carries.
   *
   * Asked by REPOSITORY ROOT, never by project id: a workspace project holds many
   * repositories under one identity and that mapping is not invertible, so two repos of one
   * workspace resolve their own rungs and place their own worktrees (CLAUDE.md, 2026-08-28).
   * A path that is not a git working tree still answers — with the ladder read against the
   * key that path escapes to — because refusing here would refuse the bind.
   */
  resolveWorktreePlacement(repoRoot: string): Promise<ResolvedWorktreePlacement>;
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
   * left the wizard permanently unreachable once setup finished. ONE atomic write ADDS
   * `replayRequestedAt` to the `welcome` slice, PRESERVING an existing `completedAt`
   * (an older v1 build requires that field; see the implementation). The request stamp
   * is what the startup gate honors regardless of project count — eligibility alone only
   * ever elects a zero-project client, so a reset that wrote nothing new would be a no-op
   * on a real machine. `completeWelcome` still REPLACES the slice, so finishing the
   * replayed welcome clears the request.
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
   * Turn benchmark recording on or off (#731). A plain client-settings write, refused
   * (throws) on a malformed file exactly as `setCoachmarks`. Returns the RESOLVED state
   * after the write, so the surface adopts the resolver's own answer.
   */
  setBenchmarkRecording(enabled: boolean): boolean;
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
   * Write one worktree value on the GLOBAL rung (workspace-settings D1) — this host's
   * answer for where Rennet places worktrees, how it names them, and whether it works
   * inside a checkout the reviewer already has out. It lives in `daemon-settings.json`
   * rather than client settings because a filesystem path is a fact about the machine
   * that binds, not about the viewer looking at it.
   *
   * `null` resets (the entry is dropped, so the value falls back to its builtin).
   * Values validate through the same `SETTINGS_REGISTRY` declarations the resolver
   * reads, and a malformed daemon-settings refuses the write (throws) exactly as
   * `setTrackerValue`. Returns the stored worktree section after the write.
   */
  setWorktreeValue(input: {
    key: "root" | "pattern" | "prPattern" | "workspace";
    value: string | null;
  }): NonNullable<DaemonSettings["worktrees"]>;
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
  {
    readonly field: RepoPrefField;
    readonly validate: (value: string) => string;
    /** A filesystem LOCATION: expanded and made absolute against the data dir before it
     *  is persisted, which the caller does because only it holds the data dir. */
    readonly expandsRoot?: boolean;
  }
> = {
  glyph: { field: "glyph", validate: SETTINGS_REGISTRY.projectGlyph.validate },
  // The mark vocabulary is enforced by the SAME validator the resolver reads by, so
  // `mark: "photo"` is refused at the write rather than resolving to nothing later.
  mark: { field: "mark", validate: SETTINGS_REGISTRY.projectMark.validate },
  // A written location is EXPANDED AND MADE ABSOLUTE here, at the write (D1 and the
  // spec delta). Storing `~/trees` verbatim makes the same bytes mean two directories on
  // two machines, and the row would then show a string the daemon re-interprets on every
  // read. `expandsRoot` is the flag that says "this key needs the data dir", which the
  // module-level table cannot reach — `setProjectValue` supplies it.
  worktreeRoot: {
    field: "worktreeBaseDir",
    validate: SETTINGS_REGISTRY.worktreeBaseDir.validate,
    expandsRoot: true,
  },
  // A pattern is RENDERED with placeholder tokens before it is persisted, so a pattern
  // that would place a worktree outside the root — or name a token its grammar does not
  // have — is refused with git-level honesty about which, and the file is never touched.
  worktreePattern: {
    field: "worktreePattern",
    validate: (value) =>
      checkedPattern("branch", SETTINGS_REGISTRY.worktreePattern.validate(value)),
  },
  prWorktreePattern: {
    field: "prWorktreePattern",
    validate: (value) =>
      checkedPattern("pull-request", SETTINGS_REGISTRY.prWorktreePattern.validate(value)),
  },
  // The workspace vocabulary is enforced by the SAME validator the binding resolves by,
  // so `workspace: "solo"` is refused at the write instead of silently reading `share`.
  workspace: { field: "workspace", validate: SETTINGS_REGISTRY.workspace.validate },
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

/**
 * How many settings rows resolve at once. Each row spawns git twice (the remote and the
 * branch its preview samples), so this is the burst a single `settings.get` may put on the
 * host — and on a WSL daemon, the number of simultaneous distro round trips.
 */
const ROW_CONCURRENCY = 4;

/**
 * Run `tasks` with at most `limit` in flight, results in the tasks' own order.
 *
 * A hand-rolled worker pool rather than a dependency: it is nine lines, and the
 * alternative (`Promise.all` over every task) is what made a thirty-repository workspace
 * spawn sixty gits at once. Rejections propagate exactly as `Promise.all`'s do — the first
 * one rejects the whole read, because a settings view missing a row it could not explain
 * is worse than one that failed out loud.
 */
async function mapWithConcurrency<T>(
  tasks: readonly (() => Promise<T>)[],
  limit: number,
): Promise<T[]> {
  const results = new Array<T>(tasks.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < tasks.length) {
      const index = next++;
      // biome-ignore lint/style/noNonNullAssertion: `index` is bounded by `tasks.length`.
      results[index] = await tasks[index]!();
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
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

/** A STORED mark choice as a ladder offer, on the same terms as the tracker kind: a
 *  hand-edited `mark: "photo"` is DROPPED rather than thrown into resolution. */
function markOffer(value: string | undefined): ProjectMarkChoice | undefined {
  return value === "glyph" || value === "detected" || value === "upload" ? value : undefined;
}

/** A STORED tracker kind as a ladder offer: only the real vocabulary is offered, so a
 *  hand-edited `kind: "jra"` is ignored rather than thrown into resolution. */
function trackerKindOffer(value: string | undefined): TrackerKind | undefined {
  return value === "none" || value === "github" || value === "jira" || value === "linear"
    ? value
    : undefined;
}

/** Validate a pattern the way the BINDING will render it, and return it unchanged — the
 *  one place the write path and the placement share a definition of "legal pattern". */
function checkedPattern(kind: "branch" | "pull-request", pattern: string): string {
  assertWorktreePattern(kind, pattern);
  return pattern;
}

/** A STORED workspace mode as a ladder offer, on the same terms as the two above: a
 *  hand-edited `workspace: "solo"` is DROPPED rather than thrown into resolution, so a
 *  garbage value falls back to `share` instead of failing the whole settings read. */
function workspaceOffer(value: string | undefined): WorkspaceMode | undefined {
  return value === "share" || value === "own" ? value : undefined;
}

/** The update attempt for a composition with NO update effect wired: it says so and changes
 *  nothing, so the card shows a failure line rather than a success it did not earn. */
function noUpdateMechanism(): Promise<{ version: string | null } | null> {
  return Promise.reject(new Error("Rennet has no way to update this host's daemon."));
}

/**
 * The persisted per-scenario `routing.task` slice (C16, #485). Only job ids the review-role
 * catalogue actually names are admitted: a stale or unknown key in `client-settings.json`
 * is IGNORED rather than fed to the resolver, so a hand-edited config can never route a job
 * the surface does not show.
 *
 * Module-level, and exported, because it now has TWO readers: the settings VIEW
 * (`reviewRoles`) and every live dispatch site through {@link createCouncilOverrideReader}.
 * Having only the first is what #876 was.
 */
export function storedRoleOverrides(client: ClientSettings): ReviewRoleOverrides | undefined {
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
}

/**
 * What every production dispatch site reads the reviewer's role overrides with (#876).
 *
 * Read on EVERY dispatch rather than captured once at boot: a reviewer who changes a seat's
 * model expects the next round to run on it, not the next daemon restart. The read is a
 * cached file read and a dispatch already costs a model turn, so freshness is free here.
 *
 * A malformed `client-settings.json` yields no override rather than a throw — the store
 * answers `{ status: "malformed", config }` and the council falls back to its own tables,
 * which is the same routing the host had before anyone opened the surface.
 */
export function createCouncilOverrideReader(
  readGlobalState: () => { config: ClientSettings },
): CouncilOverrideReader {
  return (availability) => {
    try {
      return taskOverridesFor(storedRoleOverrides(readGlobalState().config), availability);
    } catch {
      return undefined;
    }
  };
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
      mark?: string;
      worktreeBaseDir?: string;
      worktreePattern?: string;
      prWorktreePattern?: string;
      workspace?: string;
      tracker?: { kind?: string; projectKey?: string; baseUrl?: string; tokenEnv?: string };
    } | null,
    /**
     * Every repo key of the project this row belongs to. The mark's `detected` rung is
     * offered when ANY of them holds a copied logo, not only this row's: the scout runs per
     * repo, so in a workspace the logo may have been found in the second repo while the
     * client reads the FIRST row's prefs. Resolving per-target alone would hide it.
     */
    projectRepoKeys: readonly string[],
  ): SettingsProjectPrefs => {
    const detected = deps.scoutOffers?.(target.repoKey) ?? {};
    const daemonSettings = deps.readDaemonSettings();
    const globalTracker = daemonSettings.tracker ?? {};
    const globalWorktrees = daemonSettings.worktrees ?? {};
    const repoTracker = config?.tracker ?? {};
    const layered = <T extends string>(resolved: { value: T; layer: SettingsLayer }) => ({
      value: resolved.value as string,
      layer: resolved.layer,
    });
    const guidance = deps.loadGuidance(target.repoRoot);
    return {
      glyph: layered(resolve(SETTINGS_REGISTRY.projectGlyph, { repo: offer(config?.glyph) })),
      // The `detected` rung is the EXISTENCE of a copied logo file, not the scout's stored
      // path (ADR 0004): the mark is bytes in the project dir, so a path that no longer
      // resolves must not offer a mark the surface cannot show.
      mark: layered(
        resolve(SETTINGS_REGISTRY.projectMark, {
          ...(projectRepoKeys.some((repoKey) => deps.detectedLogoExists?.(repoKey))
            ? { detected: "detected" as const }
            : {}),
          repo: markOffer(config?.mark),
        }),
      ),
      // The worktree section (workspace-settings D1/D2/D4). Its GLOBAL rung is the
      // daemon's own `daemon-settings.json`, not client settings: where this host puts
      // checkouts, how it names them, and whether it works inside a tree the reviewer
      // has open are facts about the machine that binds — the same argument that put
      // `tracker` there. The repo rung is the project's own `config.json`.
      // The BUILTIN is the real directory, not "" (D1: `join(dataDir, "worktrees")`,
      // computed at resolution time). An untouched repository's row shows the path the
      // daemon would actually create, labelled `builtin` — an empty builtin left the row
      // saying nothing while placement used a path, which is the reader's problem to
      // translate and the surface's job to state.
      worktreeRoot: layered(
        resolve(
          { ...SETTINGS_REGISTRY.worktreeBaseDir, builtinDefault: join(deps.dataDir, "worktrees") },
          {
            detected: offer(detected.worktreeBaseDir),
            global: offer(globalWorktrees.root),
            repo: offer(config?.worktreeBaseDir),
          },
        ),
      ),
      worktreePattern: layered(
        resolve(SETTINGS_REGISTRY.worktreePattern, {
          global: offer(globalWorktrees.pattern),
          repo: offer(config?.worktreePattern),
        }),
      ),
      prWorktreePattern: layered(
        resolve(SETTINGS_REGISTRY.prWorktreePattern, {
          global: offer(globalWorktrees.prPattern),
          repo: offer(config?.prWorktreePattern),
        }),
      ),
      workspace: layered(
        resolve<WorkspaceMode>(SETTINGS_REGISTRY.workspace, {
          global: workspaceOffer(globalWorktrees.workspace),
          repo: workspaceOffer(config?.workspace),
        }),
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

  /**
   * The example paths this row's resolved placement produces FOR THIS REPOSITORY (D3),
   * through the SAME functions the binding places by — which is the whole answer to why
   * #812's client-side preview lied: app-ui has neither the data directory nor the
   * escaped repo key, and a preview computed without them is a promise nothing keeps.
   *
   * Per ROW, never per project: the repo key, the remote and the branch all come from
   * `target`/`facts` for this repository, so two repositories of one workspace preview
   * differently (CLAUDE.md — a workspace maps many repos to one identity).
   *
   * A pattern that cannot render for this repository yields NO preview rather than a
   * path the binding would not produce; the write path refuses such a pattern, so the
   * only way to reach it is a hand-edited file.
   */
  const worktreePreview = (
    target: RepoTarget,
    prefs: SettingsProjectPrefs,
    facts: WorktreeRepoFacts | undefined,
  ): SettingsProject["worktreePreview"] => {
    const root = resolveWorktreeRoot(deps.dataDir, prefs.worktreeRoot.value);
    // `{repo}` through the SAME route the binding spells it — `escapePath(realpath(root))`,
    // not `escapePath(gitTopLevel)`. `RepoTarget.repoKey` is the snapshot-store key and
    // skips the realpath, which is a different directory the moment a symlink is in the
    // path (`/var` → `/private/var`), and a preview that names a different directory from
    // the bind is #812 again.
    const identity: WorktreeRepoIdentity = {
      repoKey: repoKeyForRoot(target.repoPath),
      repoRoot: target.repoPath,
      ...facts,
    };
    try {
      return {
        // The repository's own current branch is the honest sample; `main` is what a
        // repository with no readable branch (a fresh clone, an unreachable locus) gets.
        branch: branchWorktreePath(
          root,
          prefs.worktreePattern.value,
          identity,
          facts?.branch ?? "main",
        ),
        pullRequest: prWorktreePath(root, prefs.prWorktreePattern.value, identity, 1),
      };
    } catch {
      return undefined;
    }
  };

  /**
   * A per-OPERATION reader of `worktreeFacts` (memoised, one `Map` per call of the
   * factory — never module-level, because a repository's remote can change while the
   * daemon runs and a long-lived cache would preview a stale one).
   *
   * `settings.get()` resolves every row through ONE of these, and so does each write
   * that re-resolves a row twice (`pinRepoValue`). The facts are a git subprocess per
   * repository: sequential, per-row spawns made every settings mutation — and every
   * mutation invalidates `settings.get` on the client — cost one round trip per repo.
   */
  const factsReader = (): ((repoPath: string) => Promise<WorktreeRepoFacts | undefined>) => {
    const inFlight = new Map<string, Promise<WorktreeRepoFacts | undefined>>();
    return (repoPath) => {
      const cached = inFlight.get(repoPath);
      if (cached !== undefined) return cached;
      const pending = Promise.resolve(deps.worktreeFacts?.(repoPath)).catch(() => undefined);
      inFlight.set(repoPath, pending);
      return pending;
    };
  };

  const resolveRow = async (
    project: Project,
    target: RepoTarget,
    multiRepo: boolean,
    /** Every repo key of this project, for the prefs a project resolves across its repos
     *  (the mark's `detected` rung). Defaults to this row's own, which is the whole set
     *  for a single-repo project. */
    projectRepoKeys: readonly string[] = [target.repoKey],
    /** The operation's facts reader. Defaults to a fresh one, which is exactly right for
     *  a single-row resolution and shares nothing across operations. */
    readFacts: (repoPath: string) => Promise<WorktreeRepoFacts | undefined> = factsReader(),
  ): Promise<SettingsProject> => {
    const configState = deps.loadConfigState(target.repoKey);
    const configMalformed = configState.status === "malformed";
    const config = configState.status === "ok" ? configState.config : null;
    const visibility = resolveVisibility(config?.visibility);
    const promoted = resolvePromoted(config?.promoted);
    // Execution locus is a DETECTED FACT now (#476) — where the harness runs, read
    // straight off the repo path, not a stored/overridable ladder value.
    const locus = detectLocus(target.repoPath);
    const locusValue = locus.kind === "host" ? "host" : `WSL · ${locus.distro}`;
    const prefs = resolvePrefs(target, config, projectRepoKeys);
    // THIS repository's facts, asked for by its own path — the row named the repo, so
    // the repo answers. A project id could not: it maps to many.
    const preview = worktreePreview(target, prefs, await readFacts(target.repoPath));
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
      prefs,
      ...(preview ? { worktreePreview: preview } : {}),
    };
  };

  // Re-resolve the LIVE target for a repo-scoped write: the project must still exist
  // and own `repoPath` (a checkout may have gone). Returns the target + project +
  // multiRepo flag so a row can be re-resolved after the write.
  const liveTarget = async (
    projectId: string,
    repoPath: string,
  ): Promise<{
    project: Project;
    target: RepoTarget;
    multiRepo: boolean;
    /** Every repo key of the project, so a post-write re-resolution sees the same
     *  cross-repo prefs `get()` does (the mark's `detected` rung). */
    repoKeys: string[];
  } | null> => {
    const project = deps.listProjects().find((entry) => entry.id === projectId);
    if (!project) return null;
    const targets = await targetsFor(project);
    const target = targets.find((entry) => entry.repoPath === repoPath);
    if (!target) return null;
    return {
      project,
      target,
      multiRepo: targets.length > 1,
      repoKeys: targets.map((entry) => entry.repoKey),
    };
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

  const resolveReviewRoleView = (): ReviewRoleMapping[] =>
    reviewRoleMappings(storedRoleOverrides(deps.readGlobalState().config));

  return {
    get: async (): Promise<SettingsView> => {
      const schemeState = deps.readGlobalState();
      const scheme = resolveScheme(schemeState.config);
      const emittedRepoPaths = new Set<string>();
      const allProjects = deps.listProjects();
      const rows: (() => Promise<SettingsProject>)[] = [];
      // ONE facts reader for the whole view, and the rows resolve CONCURRENTLY — but
      // BOUNDED. Each row costs two git subprocesses for its remote and branch; awaited in
      // the loop they serialised across every project × repo, and every settings mutation
      // invalidates `settings.get` on the client, so flipping appearance on an 8-repo
      // workspace paid 8 sequential spawns and a WSL locus makes each of those a distro
      // round trip. Firing them ALL at once is the other failure: a reviewer with thirty
      // repositories open spawned sixty gits in one breath, and on a WSL daemon sixty
      // distro round trips. Four in flight keeps the win and bounds the burst.
      const readFacts = factsReader();
      for (const project of allProjects) {
        const targets = await targetsFor(project);
        const multiRepo = targets.length > 1;
        const repoKeys = targets.map((entry) => entry.repoKey);
        for (const target of targets) {
          if (emittedRepoPaths.has(target.repoPath)) continue;
          emittedRepoPaths.add(target.repoPath);
          rows.push(() => resolveRow(project, target, multiRepo, repoKeys, readFacts));
        }
      }
      // Results land at their own index, so the view's row order is the push order still.
      const projects: SettingsProject[] = await mapWithConcurrency(rows, ROW_CONCURRENCY);
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
        // Benchmark recording (#731), RESOLVED — an absent slice is the default-on
        // install, and resolving here keeps that default in one place.
        benchmarkRecording: benchmarkRecordingEnabled(schemeState.config),
      };
    },

    resolveWorktreePlacement: async (repoRoot: string): Promise<ResolvedWorktreePlacement> => {
      // The row's own resolution, minus the row. `resolveRepoTarget` is what makes the repo
      // rung readable at all: `.rennet/config.json` is keyed by `escapePath(gitTopLevel)`,
      // and a session's `repositoryRoot` is that top level in every arrangement but a
      // hand-built one — so an unresolvable path falls back to escaping what it was given
      // rather than silently reading no repo rung and rather than throwing a bind away.
      const target = (await resolveRepoTarget(repoRoot)) ?? {
        repoPath: repoRoot,
        repoKey: escapePath(repoRoot),
        repoRoot,
      };
      const configState = deps.loadConfigState(target.repoKey);
      // A MALFORMED config resolves as an absent one, exactly as `resolveRow` does: its
      // unparseable values never reach the ladder, so a broken file places worktrees at the
      // builtin rather than wherever a half-read object happened to say.
      const config = configState.status === "ok" ? configState.config : null;
      const prefs = resolvePrefs(target, config, [target.repoKey]);
      return {
        root: resolveWorktreeRoot(deps.dataDir, prefs.worktreeRoot.value),
        pattern: prefs.worktreePattern.value,
        prPattern: prefs.prWorktreePattern.value,
        workspace: prefs.workspace.value as WorkspaceMode,
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
      // rides. The request is ADDED to the slice, and an existing `completedAt` is carried
      // through untouched: `CLIENT_SETTINGS_VERSION` is still 1, and an older build's v1
      // schema has `welcome.completedAt` REQUIRED. A replay-only slice would read as
      // malformed to that build, and a malformed file refuses every subsequent settings
      // write — so dropping the stamp would brick settings for anyone who downgrades.
      // Preserving it costs nothing here: the startup gate elects replay on the PRESENCE
      // of `replayRequestedAt`, before it ever looks at `completedAt`.
      //
      // Residual gap, stated rather than papered over: a client that has never completed
      // the welcome has no `completedAt` to preserve, so the slice this writes is
      // `{ replayRequestedAt }` alone, which an older build still reads as malformed. That
      // client is one whose welcome is already showing (no completion stamp ⇒ the
      // zero-project first-run path), so it has no reason to ask for a replay; closing it
      // properly needs `welcome.completedAt` to become optional in a version bump.
      const written = deps.updateGlobal((current) => ({
        ...current,
        welcome: current.welcome?.completedAt
          ? { completedAt: current.welcome.completedAt, replayRequestedAt }
          : { replayRequestedAt },
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

    setBenchmarkRecording: (enabled: boolean): boolean => {
      // A plain write, first click, no confirmation (Rule Zero) — this is observability
      // configuration and turning it off changes nothing about how a review runs.
      // `updateGlobal` REFUSES (throws) on a malformed file (Rule 75). The slice is
      // written EXPLICITLY in both directions rather than deleted when true, so a
      // reviewer who deliberately re-enabled it reads back their own decision instead of
      // an absence that merely happens to resolve the same way today.
      const written = deps.updateGlobal((current) => ({
        ...current,
        benchmarks: { record: enabled },
      }));
      return benchmarkRecordingEnabled(written);
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
      return reviewRoleMappings(storedRoleOverrides(written));
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

    setWorktreeValue: (input): NonNullable<DaemonSettings["worktrees"]> => {
      // The SAME declarations the resolver reads by, so the host rung cannot hold a
      // value the ladder would refuse — and the same `null`-resets law as the tracker.
      const declaration = {
        root: SETTINGS_REGISTRY.worktreeBaseDir,
        pattern: SETTINGS_REGISTRY.worktreePattern,
        prPattern: SETTINGS_REGISTRY.prWorktreePattern,
        workspace: SETTINGS_REGISTRY.workspace,
      }[input.key];
      const validated = input.value === null ? null : declaration.validate(input.value);
      // The host rung's patterns render, and its root expands, on exactly the terms the
      // repo rung's do — one law for both files (D1/D2).
      let value = validated;
      if (validated !== null && (input.key === "pattern" || input.key === "prPattern")) {
        value = checkedPattern(input.key === "pattern" ? "branch" : "pull-request", validated);
      } else if (validated !== null && input.key === "root") {
        value = expandWorktreeRootForWrite(deps.dataDir, validated);
      }
      const written = deps.updateDaemon((current) => {
        const worktrees = { ...current.worktrees };
        if (value === null) delete worktrees[input.key];
        else worktrees[input.key] = value as never;
        // A reset of the LAST key takes the section with it: an empty `worktrees: {}` in
        // `daemon-settings.json` is a shape the reader has to interpret as "unset", and
        // the file should just say nothing about worktrees.
        const next = { ...current };
        if (Object.keys(worktrees).length === 0) delete next.worktrees;
        else next.worktrees = worktrees;
        return next;
      });
      return written.worktrees ?? {};
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
      // A blank value is a RESET — the entry is dropped so the value falls back down the
      // ladder — and that is decided BEFORE validation: a key with a closed vocabulary
      // (`mark`) would otherwise throw on "", so "clear this" would mean two different
      // things depending on the key. Everything else validates through the registry
      // declaration the RESOLVER reads by, so the write and the read cannot disagree about
      // what a legal value is.
      const checked =
        input.value === null || input.value === "" ? null : pref.validate(input.value);
      // A location is stored EXPANDED AND ABSOLUTE (D1): `~/trees` becomes this user's
      // home, a relative value resolves against the data dir, and `~someone/…` is refused
      // with its reason rather than persisted as a literal `~someone` directory.
      const validated =
        checked !== null && pref.expandsRoot
          ? expandWorktreeRootForWrite(deps.dataDir, checked)
          : checked;
      deps.writeRepoValue({
        repoKey: live.target.repoKey,
        field: pref.field,
        value: validated === "" ? null : validated,
      });
      // Re-resolve from the live store: the surface adopts the resolver's own answer.
      return {
        status: "applied",
        key: input.key,
        project: await resolveRow(live.project, live.target, live.multiRepo, live.repoKeys),
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
        project: await resolveRow(live.project, live.target, live.multiRepo, live.repoKeys),
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
      // Both resolutions share ONE facts reader: this is the same repository twice in
      // one operation, and its remote is not going to change between the two reads.
      const readFacts = factsReader();
      const current = await resolveRow(
        live.project,
        live.target,
        live.multiRepo,
        live.repoKeys,
        readFacts,
      );
      await deps.applyVisibility({
        repoKey: live.target.repoKey,
        repoRoot: live.target.repoRoot,
        target: current.visibility,
      });
      return {
        status: "applied",
        key: input.key,
        project: await resolveRow(
          live.project,
          live.target,
          live.multiRepo,
          live.repoKeys,
          readFacts,
        ),
      };
    },
  };
}
