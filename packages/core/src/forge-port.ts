/**
 * The forge-neutral seam (Contracts R24; GitHub Integration Plan §5).
 *
 * Every forge (GitHub today, GitLab/Gitea later) is reached through this port,
 * expressed entirely in Rennet nouns with capability flags and an opaque
 * `forgeRef` per entity. Degradation is written against the capability flags,
 * never against `if (forge === 'github')`, so a weaker forge simply produces a
 * different flattening rather than a code fork. No GitHub vocabulary (GraphQL
 * documents, `line`/`side` translation) leaks past this boundary.
 *
 * This module is node-free at module scope so a mobile or third-party client can
 * import it: no `node:*`, no filesystem, no process.
 */

import type { ForgeRepoIdentity } from "@rennet/protocol";

// Protocol owns the repository identity because it crosses every client boundary. Re-export it
// here so existing ForgePort consumers keep one import path without a second declaration.
export type { ForgeRepoIdentity } from "@rennet/protocol";

/** A reference to a pull/merge request on a forge. */
export interface ForgePullRequestRef {
  repo: ForgeRepoIdentity;
  number: number;
}

/**
 * SSO state parsed from a forge response (`X-GitHub-SSO` on GitHub).
 *
 * `partial-results` is the load-bearing case: a 200 with a valid-looking payload
 * can be INCOMPLETE when a token is unauthorized across some organizations. It
 * must surface as a first-class banner naming the orgs and offering the (time-
 * limited) authorization URL — a truncated surface must never render as complete.
 */
export type SsoState =
  | { kind: "none" }
  | { kind: "required"; organizations: string[]; authorizationUrl: string | null }
  | { kind: "partial-results"; organizations: string[]; authorizationUrl: string | null };

/** One check/status attached to a commit, in forge-neutral nouns. */
export interface ForgeCheckRun {
  /** Stable forge identity for this check, independent of its display name. */
  id: string;
  name: string;
  outcome: "passing" | "failing" | "pending" | "neutral";
  /** The forge's one-line summary or description; empty when none. Never a full log. */
  summary: string;
  detailsUrl?: string;
}

export interface ForgeCiStatus {
  checks: ForgeCheckRun[];
  sso: SsoState;
  /** True when the forge could not prove the returned check set was complete. */
  incomplete: boolean;
}

/**
 * A pull request deep-fetched into Rennet nouns. GitHub is authoritative for
 * identity (which SHAs, whose review); local git is authoritative for content.
 * `cloneUrls` are what the worktree matcher maps onto a local clone by identity.
 */
export interface ForgePullRequest {
  ref: ForgePullRequestRef;
  title: string;
  /** The PR description body (markdown); the stated intent (#136). Empty string when none. */
  body: string;
  isDraft: boolean;
  /** The reviewed head commit OID — pinned locally at review start. */
  headOid: string;
  /** The base commit OID the head is diffed against. */
  baseOid: string;
  baseRef: string;
  headRef: string;
  /** https and/or ssh clone URLs, mapped onto the local worktree set by identity. */
  cloneUrls: string[];
  /** The forge's opaque node id; carried, never interpreted, outside the adapter. */
  forgeRef: string;
  changedFiles: number;
  /**
   * Whether the AUTHENTICATED viewer authored this PR (GitHub GraphQL
   * `viewerDidAuthor`). The ownership fact that tells an own PR from a teammate's,
   * so the hand-off routes the own-branch lane rather than the teammate Post-review
   * lane. Sourced from the same authenticated GraphQL call as the rest of the PR.
   */
  viewerDidAuthor: boolean;
  /** Non-fatal SSO state observed while fetching this PR. */
  sso: SsoState;
}

/** A unified-diff fallback fetched from the forge when the local clone is absent. */
export interface ForgeDiff {
  /** The unified diff text (`Accept: application/vnd.github.diff` on GitHub). */
  diff: string;
  sso: SsoState;
}

/** A pull request on the home surface, before it is opened for review. */
export interface ForgePullRequestSummary {
  ref: ForgePullRequestRef;
  title: string;
  isDraft: boolean;
  updatedAt: string;
  headOid: string;
  forgeRef: string;
}

/**
 * The home-surface list of open pull requests. `complete` is the load-bearing
 * field: it is false whenever SSO `partial-results` truncated the set OR the
 * forge's >1000 search ceiling was hit, so the UI shows a banner instead of
 * rendering a short/empty list as "you have no PRs" (§2, §6).
 */
export interface ForgePullRequestList {
  items: ForgePullRequestSummary[];
  sso: SsoState;
  /** False when the set may be truncated (SSO partial-results or the >1000 ceiling). */
  complete: boolean;
  /** True when the forge's result count exceeded the hard 1000-node search ceiling. */
  truncatedOver1000: boolean;
}

/**
 * The capability flags a forge advertises. The degradation logic (publish
 * flattening, anchoring) is written against these, so a weaker forge produces a
 * different flattening rather than a branch on the forge name (§5).
 */
export interface ForgeCapabilities {
  supportsThreadResolution: boolean;
  supportsBatchedReview: boolean;
  supportsMultiLineAnchors: boolean;
  supportsFileLevelThreads: boolean;
  /** The provider has no native three-way review event, so the signed body must name it. */
  requiresReviewVerdictInBody: boolean;
}

/**
 * The forge-neutral port. The changeset source depends on this interface, never
 * on a concrete adapter, which is what makes GitLab/Gitea a future implementation
 * rather than a future rewrite.
 */
export interface ForgePort {
  readonly capabilities: ForgeCapabilities;
  /** The home surface: open PRs, with SSO/truncation surfaced as `complete`. */
  listOpenPullRequests(): Promise<ForgePullRequestList>;
  /** Deep-fetch a PR into Rennet nouns (identity + SSO state). */
  fetchPullRequest(ref: ForgePullRequestRef): Promise<ForgePullRequest>;
  /** The unified-diff fallback for when the local clone is unavailable. */
  fetchDiff(ref: ForgePullRequestRef): Promise<ForgeDiff>;
  /** Per-check CI results for a commit, keyed by OID rather than a moving branch. */
  fetchCiStatus(
    ref: ForgePullRequestRef,
    headOid: string,
    signal?: AbortSignal,
  ): Promise<ForgeCiStatus>;
}
