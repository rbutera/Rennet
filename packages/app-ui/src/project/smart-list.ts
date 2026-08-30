import type {
  ForgeRepoIdentity,
  LocalWork,
  ProjectDetail,
  PullRequest,
  SmartListCi,
  SmartListStage,
} from "@rennet/protocol";
import { repositoryIdentitiesAgree } from "./forge-repository";

/**
 * The unified smart list (issue #37), pure derivation.
 *
 * The project-detail surface is ONE list, no hard zones. This module folds the raw
 * host substrate (local work + pull requests + viewer) into rows that read
 * distinctly by state, then sorts and filters them. It is deliberately host-free
 * (`@rennet/ui` imports only types + protocol) so every rule here — dedupe,
 * ownership, needs-you, HOT sort, the filters — is unit-testable without Electron.
 *
 * The rules, from the corrected north star:
 *   • ONE list; rows visually distinct by state (local / my PR / teammate PR / merged).
 *   • Ownership is appearance + filter, NOT a hard wall: you edit what you own, you
 *     review what you did not author.
 *   • Default sort = HOT (recency of engagement) PLUS a relevance boost that floats a
 *     row up when it needs you (your review requested; your own PR's CI red).
 *   • Merged PR → auto read-only, with a clean-up affordance.
 *   • Dedupe: once a branch has a PR, the PR row wins and the local worktree becomes a
 *     "checked out locally" annotation on it. One item, one row.
 */

export type SmartRowKind = "local" | "pr";
/** The row's headline state — drives its distinct appearance and the status sort. */
export type SmartRowState = "local" | "open" | "merged" | "closed";

export interface SmartRow {
  id: string;
  kind: SmartRowKind;
  title: string;
  branch: string;
  author: string;
  /** Ownership: appearance + filter, not a wall. Local work is always yours. */
  mine: boolean;
  state: SmartRowState;
  /** The relevance boost: this row needs you (review requested, or your CI is red). */
  needsYou: boolean;
  /** Merged (and closed) PRs are read-only. */
  readOnly: boolean;
  /** Recency of engagement (ISO), the HOT-sort key. */
  lastActivityAt: string;
  /** Present on a pull-request row. */
  pr?: {
    number: number;
    /** The `owner/name` identity, so a click can target `owner/name#number`. */
    repository: string;
    /** Provider-qualified identity. Absent only for a legacy row. */
    forgeRepository?: ForgeRepoIdentity;
    ci: SmartListCi;
    reviewRequested: boolean;
    additions: number;
    deletions: number;
    changedFiles: number;
  };
  /** Present on a local-work row. */
  local?: {
    /** The `owner/name` identity — surfaced so the New Chat list can show a repo column
     *  (and drop it for a single-repo workspace) on local rows, not only PR rows. */
    repository: string;
    /** Provider-qualified identity. Absent for local-only and legacy rows. */
    forgeRepository?: ForgeRepoIdentity;
    dirty: boolean;
    /** `null` when the ahead/behind comparison could not be computed (base unresolvable). */
    ahead: number | null;
    behind: number | null;
    stage: SmartListStage;
  };
  /**
   * The dedupe annotation: a local worktree checked out for the branch this PR row
   * covers. Carried ON the PR row (the PR wins); the local row is dropped. `id` is the
   * worktree identifier (the clean-up target); `repository` + `branch` are the
   * composite that matched.
   */
  checkedOutLocally?: {
    id: string;
    repository: string;
    forgeRepository?: ForgeRepoIdentity;
    branch: string;
    dirty: boolean;
  };
}

/** Match the same branch in the same repository, preserving legacy unstamped rows. */
function sameRepositoryBranch(local: LocalWork, pr: PullRequest): boolean {
  return (
    local.branch === pr.branch &&
    repositoryIdentitiesAgree(
      { repository: local.repository, forgeRepository: local.forgeRepository },
      { repository: pr.repository, forgeRepository: pr.forgeRepository },
    )
  );
}

/** Fold the raw substrate into unified rows: dedupe, ownership, needs-you, read-only. */
export function buildSmartRows(detail: ProjectDetail): SmartRow[] {
  const viewer = detail.viewer.login;

  // Dedupe on the COMPOSITE (repository, branch), never the bare branch name:
  //  • a workspace can hold two repos that share a branch name — one must not swallow
  //    the other;
  //  • a branch can be reused across historical PRs — the live worktree must annotate
  //    exactly ONE of them (the most recently engaged), not every PR that reused it.
  // So each local worktree binds to the single most-recent PR sharing its key; that
  // PR gets the annotation and the local's own row is dropped. Every other PR (a
  // different repo, or a historical PR for the same key) keeps no annotation.
  const annotationByPrId = new Map<string, LocalWork>();
  const consumedLocalIds = new Set<string>();
  for (const local of detail.locals) {
    const candidates = detail.prs.filter((pr) => sameRepositoryBranch(local, pr));
    if (candidates.length === 0) continue;
    const current = candidates.reduce((latest, pr) =>
      pr.lastActivityAt > latest.lastActivityAt ? pr : latest,
    );
    annotationByPrId.set(current.id, local);
    consumedLocalIds.add(local.id);
  }

  const prRows = detail.prs.map((pr) => prRow(pr, viewer, annotationByPrId.get(pr.id)));
  const localRows = detail.locals
    .filter((local) => !consumedLocalIds.has(local.id))
    .map((local) => localRow(local, viewer));

  return [...prRows, ...localRows];
}

function prRow(pr: PullRequest, viewer: string, checkout: LocalWork | undefined): SmartRow {
  const mine = pr.author === viewer;
  const readOnly = pr.state !== "open";
  // Needs you: your review was requested, or it is your own open PR with red CI.
  // A merged/closed PR never needs you.
  const needsYou =
    pr.state === "open" && (pr.reviewRequestedFromViewer || (mine && pr.ci === "failing"));
  // HOT/Recent must reflect the LATER of remote PR activity and local checkout
  // activity: editing a checked-out branch after its last remote event is real
  // engagement and must not let the row go stale.
  const lastActivityAt =
    checkout && checkout.lastActivityAt > pr.lastActivityAt
      ? checkout.lastActivityAt
      : pr.lastActivityAt;
  return {
    id: pr.id,
    kind: "pr",
    title: pr.title,
    branch: pr.branch,
    author: pr.author,
    mine,
    state: pr.state,
    needsYou,
    readOnly,
    lastActivityAt,
    pr: {
      number: pr.number,
      repository: pr.repository,
      ...(pr.forgeRepository === undefined ? {} : { forgeRepository: pr.forgeRepository }),
      ci: pr.ci,
      reviewRequested: pr.reviewRequestedFromViewer,
      additions: pr.additions,
      deletions: pr.deletions,
      changedFiles: pr.changedFiles,
    },
    ...(checkout
      ? {
          checkedOutLocally: {
            id: checkout.id,
            repository: checkout.repository,
            ...(checkout.forgeRepository === undefined
              ? {}
              : { forgeRepository: checkout.forgeRepository }),
            branch: checkout.branch,
            dirty: checkout.dirty,
          },
        }
      : {}),
  };
}

function localRow(local: LocalWork, viewer: string): SmartRow {
  return {
    id: local.id,
    kind: "local",
    title: local.branch,
    branch: local.branch,
    author: local.author,
    // Local work is yours to turn into a PR; ownership matches the viewer.
    mine: local.author === viewer,
    state: "local",
    needsYou: false,
    readOnly: false,
    lastActivityAt: local.lastActivityAt,
    local: {
      repository: local.repository,
      ...(local.forgeRepository === undefined ? {} : { forgeRepository: local.forgeRepository }),
      dirty: local.dirty,
      ahead: local.ahead,
      behind: local.behind,
      stage: local.stage,
    },
  };
}

export type SmartSort = "hot" | "recent" | "author" | "status";

/** A status ranking for the "status" sort: attention first, then live, then done. */
const STATUS_RANK: Record<SmartRowState, number> = {
  open: 0,
  local: 1,
  merged: 2,
  closed: 3,
};

/** Sort a copy of the rows by the chosen mode. Default HOT = needs-you, then recent. */
export function sortSmartRows(rows: readonly SmartRow[], sort: SmartSort): SmartRow[] {
  const byRecency = (a: SmartRow, b: SmartRow) => b.lastActivityAt.localeCompare(a.lastActivityAt);
  const copy = [...rows];
  switch (sort) {
    case "hot":
      // The relevance boost: a row that needs you floats to the top, then recency.
      return copy.sort((a, b) => {
        if (a.needsYou !== b.needsYou) return a.needsYou ? -1 : 1;
        return byRecency(a, b);
      });
    case "recent":
      return copy.sort(byRecency);
    case "author":
      return copy.sort((a, b) => a.author.localeCompare(b.author) || byRecency(a, b));
    case "status":
      return copy.sort((a, b) => STATUS_RANK[a.state] - STATUS_RANK[b.state] || byRecency(a, b));
  }
}

export type SmartFilter = "all" | "needs-you" | "mine" | "local" | "prs";

/** Keep only the rows matching the filter (ownership + kind + attention). */
export function filterSmartRows(rows: readonly SmartRow[], filter: SmartFilter): SmartRow[] {
  switch (filter) {
    case "all":
      return [...rows];
    case "needs-you":
      return rows.filter((row) => row.needsYou);
    case "mine":
      return rows.filter((row) => row.mine);
    case "local":
      return rows.filter((row) => row.kind === "local");
    case "prs":
      return rows.filter((row) => row.kind === "pr");
  }
}

/** The per-filter counts, for the filter-chip labels. */
export function smartListCounts(rows: readonly SmartRow[]): Record<SmartFilter, number> {
  return {
    all: rows.length,
    "needs-you": rows.filter((row) => row.needsYou).length,
    mine: rows.filter((row) => row.mine).length,
    local: rows.filter((row) => row.kind === "local").length,
    prs: rows.filter((row) => row.kind === "pr").length,
  };
}
