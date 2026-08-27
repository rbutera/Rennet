import { createContext, useContext } from "react";
import type { HostOS } from "../assets/os-glyphs";
import type { ProjectIconName } from "../assets/project-icon";
import type { Layered } from "./provenance";

// ─────────────────────────────────────────────────────────────────────────────
// The settings PROJECTION seam (C10 §2.1, reconciliations 5 & 8). B10 has not
// landed the settings engine that will serve environments, source-control /
// agent detection, model mappings, project glyphs, worktree patterns, and issue
// trackers. So — exactly as C03's `sidebar-data.ts` does for the B9 session
// projection — those reads resolve through THIS context, not a protocol command:
//
//   • the LIVE client supplies nothing, so the projection is honest-EMPTY (no fake
//     hosts, no invented detection rows) and every setter is a genuine no-op;
//   • TESTS (and per-test fixtures) supply a stateful projection, so every page is
//     provable now — chips render, edits persist through the setters, a re-read
//     reflects them (task 2.2, "never a hollow pass").
//
// When B10 lands (cluster 10.1), each read binds to its live projection and this
// context is deleted — the seam is the ONLY file that changes (reconciliation 5).
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
 *  enable toggle). A row with no detected `version` shows none (never a guess). */
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

/** One role's model + effort in one availability scenario; `null` means the role does
 *  not run in that scenario (the surface renders an em dash, never a fake assignment). */
export interface RoleAssignment {
  readonly model: string;
  readonly effort: RoleEffort;
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

/** The worktree location + naming pattern for one project (each a layered value). */
export interface WorktreeSettings {
  readonly root: Layered<string>;
  readonly pattern: Layered<string>;
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
 * Every B10-absent settings read and its edit, in one seam. Reads are maps keyed by
 * host or project id; a missing key is an honest absence (a disconnected host, an
 * untouched project), never a thrown render. Setters persist into the supplied
 * projection state (test fixtures); the live EMPTY no-ops until B10.
 */
export interface SettingsProjection {
  /** The environment cards, in display order. Empty in the live client until B10. */
  readonly hosts: readonly SettingsHost[];
  /** Source-control tooling detected per host id (absent host ⇒ nothing detected). */
  readonly sourceControlByHost: Readonly<Record<string, readonly DetectedTool[]>>;
  /** Coding harnesses detected per host id. */
  readonly agentsByHost: Readonly<Record<string, readonly DetectedTool[]>>;
  /** The review-role → model mappings shown in the Review section (empty ⇒ no section). */
  readonly reviewRoles: readonly ReviewRole[];
  /** The chosen glyph per project id (absent ⇒ the default `layers`). */
  readonly glyphByProject: Readonly<Record<string, ProjectIconName>>;
  /** The worktree settings per project id. */
  readonly worktreeByProject: Readonly<Record<string, WorktreeSettings>>;
  /** The issue-tracker settings per project id. */
  readonly trackerByProject: Readonly<Record<string, IssueTrackerSettings>>;

  /** Rename a host — flows through to the sidebar host-group header (one hosts state). */
  renameHost(id: string, name: string): void;
  /** Forget a remote host (never the local machine). */
  removeHost(id: string): void;
  /** Enable/disable one detected tool (source-control OR agent) on a host. */
  setToolEnabled(hostId: string, toolId: string, enabled: boolean): void;
  /** Set a review role's assignment in one scenario (the mappings dialog cell edit). */
  setRoleAssignment(
    roleId: string,
    scenario: "dual" | "claudeOnly" | "codexOnly",
    assignment: RoleAssignment | null,
  ): void;
  /** Set a project's glyph (applies live to the sidebar row). */
  setProjectGlyph(projectId: string, icon: ProjectIconName): void;
  /** Set a project's worktree naming pattern. */
  setWorktreePattern(projectId: string, pattern: string): void;
  /** Set a project's issue-tracker config. */
  setTracker(projectId: string, tracker: IssueTrackerSettings): void;
}

/** The live client's projection: nothing detected, every edit a genuine no-op (there
 *  is no B10 engine to persist to yet). Pages render their honest empty state over it. */
export const EMPTY_SETTINGS_PROJECTION: SettingsProjection = {
  hosts: [],
  sourceControlByHost: {},
  agentsByHost: {},
  reviewRoles: [],
  glyphByProject: {},
  worktreeByProject: {},
  trackerByProject: {},
  renameHost: () => undefined,
  removeHost: () => undefined,
  setToolEnabled: () => undefined,
  setRoleAssignment: () => undefined,
  setProjectGlyph: () => undefined,
  setWorktreePattern: () => undefined,
  setTracker: () => undefined,
};

const SettingsProjectionContext = createContext<SettingsProjection>(EMPTY_SETTINGS_PROJECTION);

/** Wraps a mount to supply projection reads + edits (tests until B10; deleted when B10 lands). */
export const SettingsProjectionProvider = SettingsProjectionContext.Provider;

/** The one hook every page reads the B10-absent projection through. */
export function useSettingsProjection(): SettingsProjection {
  return useContext(SettingsProjectionContext);
}
