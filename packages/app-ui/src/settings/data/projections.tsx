import type { T3SidecarStatus } from "@rennet/protocol";
import { createContext, useContext } from "react";
import type { HostOS } from "../assets/os-glyphs";
import type { ProjectIconName } from "../assets/project-icon";
import type { Layered } from "./provenance";

// ─────────────────────────────────────────────────────────────────────────────
// The settings PROJECTION seam (C10 §2.1, reconciliations 5 & 8) — the shapes every
// settings page reads environments, source-control / agent detection, model mappings,
// project glyphs, worktree patterns, guidance and issue trackers through, instead of a
// protocol command per page.
//
// The context was NOT deleted when the engine landed (the plan said it would be). The
// B10 / B7 / C16 / C17 / C18 folds bound the reads to real commands INSIDE this seam
// instead: `live-projection.tsx` builds a `SettingsProjection` off `settings.get`,
// `daemon.status`, `forge.hosts`, `harness.hosts` and `projects.list`, and wraps the
// live Settings takeover with it. So:
//
//   • the LIVE client supplies `LiveSettingsProjection` — real hosts, real detection
//     rows, real per-project prefs — and its setters are served writes;
//   • {@link EMPTY_SETTINGS_PROJECTION} is the CONTEXT DEFAULT, not the live client:
//     what a subtree mounted outside that provider gets, honest-empty by construction;
//   • TESTS (and per-test fixtures) supply a stateful projection, so every page is
//     provable in isolation — chips render, edits persist through the setters, a
//     re-read reflects them (task 2.2, "never a hollow pass").
//
// The fields with no served backend are named one by one in `live-projection.tsx`.
// Values carry the `{ value, layer }` keep contract ({@link Layered}); the live
// `settings.*` commands keep their own richer `ResolvedProvenance` and bind in
// `live.ts`, not here.
// ─────────────────────────────────────────────────────────────────────────────

// ── Environments (§3) ─────────────────────────────────────────────────────────

/** A host's Rennet daemon, as far as it can be asked. Every field beyond `reachable`
 *  is absent when nothing could be detected — an unreachable host invents no state. */
export interface DaemonInfo {
  readonly reachable: boolean;
  /** The running daemon version, when the host answered. */
  readonly version?: string;
  /** The version this host was LAST seen running, when it is unreachable now. */
  readonly lastSeenVersion?: string;
  /** This host has a daemon update available (drives the button-only Update Daemon). */
  readonly updateAvailable?: boolean;
  /** The owned T3 Code sidecar's state (t3code-sidecar-chat); local host only, and only
   *  when the daemon composed one. Disclosure, never a control. */
  readonly t3Sidecar?: T3SidecarStatus;
}

/** One environment card: the machine, its address, and its daemon. */
export interface SettingsHost {
  readonly id: string;
  readonly name: string;
  readonly kind: "local" | "remote";
  readonly os: HostOS;
  /** The dial address; absent for the local machine (there is nothing to dial). */
  readonly address?: string;
  readonly daemon: DaemonInfo;
  /** Projects Rennet holds on this host — the blast radius the Remove confirmation names. */
  readonly projectCount?: number;
  /** Sessions across those projects — named alongside the projects when nonzero. */
  readonly sessionCount?: number;
}

// ── Detection rows (§4 source control, §5 agents — one shape) ──────────────────

/** The honest state of a detected tool on a host. */
export type ToolStatus = "available" | "not-authenticated" | "not-installed" | "unreachable";

/** One detected tool (a forge CLI or a coding harness) on one host — the shared row
 *  shape source-control and agents both render (mark, label, version, status, helper,
 *  and, where an acting path consumes it, an enable toggle). A row with no detected
 *  `version` shows none (never a guess). */
export interface DetectedTool {
  readonly id: string;
  readonly label: string;
  readonly version?: string;
  readonly status: ToolStatus;
  /** One line of honest state and the exact fix; backticked spans render as code. */
  readonly detail: string;
  readonly enabled: boolean;
}

// ── Model mappings (§5) ────────────────────────────────────────────────────────

export type RoleEffort = "low" | "medium" | "high" | "xhigh";

/** Where a resolved cell came from: the council table stands, or a routing override won.
 *  The surface derives "is this a default?" from this, never from a copied table. */
export type RoleLayer = "default" | "override";

/** One role's model + effort in one availability scenario; `null` means the role does
 *  not run in that scenario (the surface renders an em dash, never a fake assignment).
 *  `layer` is the C16 provenance — omitted reads as the council default. */
export interface RoleAssignment {
  readonly model: string;
  readonly effort: RoleEffort;
  readonly layer?: RoleLayer;
}

/** A user-legible review role over the Model Council job catalogue (#460/#464). One
 *  assignment per availability scenario (Dual / Claude-only / Codex-only). */
export interface ReviewRole {
  readonly id: string;
  readonly label: string;
  readonly hint: string;
  readonly dual: RoleAssignment | null;
  readonly claudeOnly: RoleAssignment | null;
  readonly codexOnly: RoleAssignment | null;
}

// ── Projects (§8) ──────────────────────────────────────────────────────────────

/** The chat engine for one project's sessions (t3code-sidecar-chat). */
export type ChatEngine = "rennet" | "t3";

/** The worktree location + naming pattern for one project (each a layered value). */
export interface WorktreeSettings {
  readonly root: Layered<string>;
  readonly pattern: Layered<string>;
}

/** A repo rule the review agents read, with the severity chip it carries (claim 669). */
export type GuidanceSeverity = "high" | "medium" | "low";
export interface GuidanceRule {
  /** The catalogue's stable id, when the served rule carries one. Kept through an edit
   *  so a retyped statement still addresses the SAME rule on disk (its rationale and
   *  anti-pattern survive). Never rendered. */
  readonly id?: string;
  readonly rule: string;
  readonly severity: GuidanceSeverity;
}

/** The issue tracker whose referenced tickets are fetched for review agents (#461). */
export type TrackerKind = "none" | "github" | "jira" | "linear";

/** The tracker section's resolved config for one project. GitHub rides the host's `gh`
 *  and exposes no fields; JIRA/Linear carry a project key, a base URL, and the NAME of
 *  the env var holding the token — the token value itself never enters any store. */
export interface IssueTrackerSettings {
  readonly kind: Layered<TrackerKind>;
  readonly projectKey: Layered<string> | null;
  readonly baseUrl: Layered<string> | null;
  readonly tokenEnv: Layered<string> | null;
}

// ── The projection contract ────────────────────────────────────────────────────

/**
 * Every projected settings read and its edit, in one seam. Reads are maps keyed by
 * host or project id; a missing key is an honest absence (a disconnected host, an
 * untouched project), never a thrown render. Setters write through whatever the
 * supplied projection is: served commands under the live provider, projection state
 * under a test fixture, genuine no-ops under {@link EMPTY_SETTINGS_PROJECTION}.
 */
export interface SettingsProjection {
  /** The environment cards, in display order. Served in the live client from
   *  `settings.get.daemonHosts` joined with `daemon.status`. */
  readonly hosts: readonly SettingsHost[];
  /** Source-control tooling detected per host id (absent host ⇒ nothing detected). */
  readonly sourceControlByHost: Readonly<Record<string, readonly DetectedTool[]>>;
  /** Coding harnesses detected per host id. */
  readonly agentsByHost: Readonly<Record<string, readonly DetectedTool[]>>;
  /** The review-role → model mappings shown in the Review section (empty ⇒ no section). */
  readonly reviewRoles: readonly ReviewRole[];
  /** The chosen display name per project id (absent ⇒ the real `projects.list` name). */
  readonly nameByProject: Readonly<Record<string, string>>;
  /** The chosen glyph per project id (absent ⇒ the default `layers`). */
  readonly glyphByProject: Readonly<Record<string, ProjectIconName>>;
  /** The worktree settings per project id. */
  readonly worktreeByProject: Readonly<Record<string, WorktreeSettings>>;
  /** The resolved chat engine per project; absent when the daemon predates the setting. */
  readonly chatEngineByProject: Readonly<Record<string, Layered<ChatEngine>>>;
  /** The issue-tracker settings per project id. */
  readonly trackerByProject: Readonly<Record<string, IssueTrackerSettings>>;
  /** The guidance rules the review agents read, per project id. */
  readonly guidanceByProject: Readonly<Record<string, readonly GuidanceRule[]>>;
  /** Whether the per-project editors (name, glyph, worktree, tracker, guidance) have a
   *  served WRITE store, asked of the SURFACE as a whole. The live projection leaves this
   *  FALSE and answers per project through {@link prefsBackedByProject} instead — it can
   *  only address a project whose row it holds. With no store, a fully enabled control
   *  would silently eat every keystroke, so the pages disable their controls and disclose
   *  the gap (the same honesty as the Environments cards, no UI lie). A stateful test
   *  projection sets it TRUE, so those editors are live and provable.
   *  (`setRepoVisibility` is NOT in this set — Repository is live-backed.) */
  readonly projectEditsPersist: boolean;
  /**
   * The SAME question, answered per project id — the honest one, because the capability
   * is a property of the served row (this daemon, this repo), not of the surface. A
   * project with an entry uses it; one with NO entry (its row has not arrived, or this
   * projection has no rows at all) falls back to {@link SettingsProjection.projectEditsPersist}.
   *
   * The live projection fills this from the rows it can address and leaves the global
   * flag false, so a project whose row it does not hold renders DISABLED rather than
   * enabled over a write it has no repo path for.
   */
  readonly prefsBackedByProject: Readonly<Record<string, boolean>>;
  /**
   * Whether the project NAME field has a served write store. Separate from
   * {@link SettingsProjection.projectEditsPersist} because they are two different
   * stores: the name writes through `project.rename` (C18, the projects store) while
   * the glyph, worktree, tracker and guidance editors write the repo rung through
   * `settings.setProjectValue` / `settings.setGuidance` and are answered per project by
   * {@link prefsBackedByProject}. One flag for both would tell the wrong truth about
   * one of them whenever a daemon serves one store and not the other.
   */
  readonly nameEditsPersist: boolean;

  /** Rename a host — flows through to the sidebar host-group header (one hosts state). */
  renameHost(id: string, name: string): void;
  /** Forget a remote host (never the local machine). */
  removeHost(id: string): void;
  /**
   * Re-attempt the handshake to a host's daemon (C17 cluster 5, #533) — what Reconnect does.
   * Resolves the honest OUTCOME: `reachable` is what the attempt actually achieved, and
   * `error` carries the reason when it did not. A projection with no served backend resolves
   * `{ reachable: false }`, so the button reports a failure instead of pretending to connect.
   */
  reconnectHost(id: string): Promise<{ readonly reachable: boolean; readonly error?: string }>;
  /**
   * UPDATE a host's daemon (C17 cluster 6, #534) — what Update Daemon does, offered only where
   * the host reported a real `updateAvailable`. Resolves the honest OUTCOME: `reachable` is
   * whether the host's daemon answered after the attempt, and `error` carries the reason when
   * the update did not happen. A projection with no served backend resolves `{ reachable:
   * false }`, so the button reports a failure instead of claiming an update it never performed.
   */
  updateHost(id: string): Promise<{ readonly reachable: boolean; readonly error?: string }>;
  /** Enable/disable one detected tool (source-control OR agent) on a host. */
  setToolEnabled(hostId: string, toolId: string, enabled: boolean): void;
  /** Set a review role's assignment in ONE scenario (the mappings dialog cell edit), or
   *  RESET that one cell with `null` so it falls back to that scenario's council default.
   *  Per-scenario by construction (Rai, 2026-08-28): the sibling columns never move. */
  setRoleAssignment(
    roleId: string,
    scenario: "dual" | "claudeOnly" | "codexOnly",
    assignment: RoleAssignment | null,
  ): void;
  /** Set a project's display name (applies live to the sidebar row); the `org/repo`
   *  default is restored by writing it back (an emptied name never persists). */
  setProjectName(projectId: string, name: string): void;
  /** Set a project's glyph (applies live to the sidebar row). */
  setProjectGlyph(projectId: string, icon: ProjectIconName): void;
  /** Set a project's worktree location directory. */
  setWorktreeRoot(projectId: string, root: string): void;
  /** Set a project's worktree naming pattern. */
  setWorktreePattern(projectId: string, pattern: string): void;
  /** Set a project's chat engine (t3code-sidecar-chat); takes effect on the next session open. */
  setChatEngine(projectId: string, engine: ChatEngine): void;
  /** Set a project's issue-tracker config. */
  setTracker(projectId: string, tracker: IssueTrackerSettings): void;
  /** Set a project's guidance rules (the review agents read them). */
  setGuidance(projectId: string, rules: readonly GuidanceRule[]): void;
}

/** The CONTEXT DEFAULT: nothing detected, every edit a genuine no-op. This is what a
 *  subtree mounted outside `LiveSettingsProjection` gets — not the live client, which
 *  supplies served reads and writes. Pages render their honest empty state over it, and
 *  the live projection spreads it so an unserved field stays empty rather than absent. */
export const EMPTY_SETTINGS_PROJECTION: SettingsProjection = {
  hosts: [],
  sourceControlByHost: {},
  agentsByHost: {},
  reviewRoles: [],
  nameByProject: {},
  glyphByProject: {},
  worktreeByProject: {},
  chatEngineByProject: {},
  trackerByProject: {},
  guidanceByProject: {},
  projectEditsPersist: false,
  prefsBackedByProject: {},
  nameEditsPersist: false,
  renameHost: () => undefined,
  removeHost: () => undefined,
  // No backend to hand a handshake to, so the honest outcome is a failed reconnect.
  reconnectHost: async () => ({ reachable: false }),
  // No backend to hand an update to, so the honest outcome is an update that did not happen.
  updateHost: async () => ({ reachable: false }),
  setToolEnabled: () => undefined,
  setRoleAssignment: () => undefined,
  setProjectName: () => undefined,
  setProjectGlyph: () => undefined,
  setWorktreeRoot: () => undefined,
  setWorktreePattern: () => undefined,
  setChatEngine: () => undefined,
  setTracker: () => undefined,
  setGuidance: () => undefined,
};

const SettingsProjectionContext = createContext<SettingsProjection>(EMPTY_SETTINGS_PROJECTION);

/** Wraps a mount to supply projection reads + edits — `live-projection.tsx` in the app,
 *  a stateful fixture in tests. */
export const SettingsProjectionProvider = SettingsProjectionContext.Provider;

/** The one hook every settings page reads its projection through. */
export function useSettingsProjection(): SettingsProjection {
  return useContext(SettingsProjectionContext);
}
