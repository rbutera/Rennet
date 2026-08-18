import type { Octokit } from "@octokit/core";
import type { PullRequest, SmartListCi } from "@rennet/protocol";
import { headerGet } from "./github-octokit";
import { parseGitHubSso } from "./github-sso";

/**
 * The LIVE remote-PR half of the project-detail substrate (issue #37, wave B2).
 *
 * Wave B1 filled the LOCAL half of `ProjectDetail` (worktrees + branches from real
 * git) and left `prs: []` as the documented stub. This module fills that half: for a
 * forge repo identity (`owner/name`), it queries GitHub's GraphQL API for the OPEN
 * pull requests — mine and teammates' alike — and maps each to the protocol
 * `PullRequest` the renderer's `smart-list` derivation already folds, dedupes and
 * sorts. It also resolves the signed-in GitHub login, which becomes the viewer
 * identity so ownership (`mine`) reads correctly against BOTH the PR author (a GitHub
 * login) and local work (pinned to that same login upstream).
 *
 * ── Contract with the sibling waves ──────────────────────────────────────────
 *  • `repository` is emitted as `owner/name`, BYTE-IDENTICAL to the identity
 *    `project-detail-source.ts` computes from the origin remote, so the renderer's
 *    composite `(repository, branch)` dedupe folds a local worktree into its PR row.
 *  • The viewer login pins ownership: `project-detail-source` sets local-work author
 *    to this login when auth resolves, so a checked-out branch still reads as "mine".
 *
 * ── SCOPE (B2), stated honestly ──────────────────────────────────────────────
 *  • OPEN pull requests only, fully paginated up to a bounded ceiling. `truncated`
 *    is set ONLY when the open set genuinely exceeds that ceiling or SSO returns
 *    partial-results — it keeps the ">1000 upstream" banner's meaning, never firing
 *    for an ordinary repo. The renderer's merged→read-only+clean-up path is real but
 *    only triggers once a merged PR is surfaced; live merged-PR surfacing (a
 *    per-branch merged lookup, so old closed history is never dragged in) is a
 *    deferred follow-up. Everything below the typed boundary is unchanged.
 *  • A hard failure (non-200, GraphQL errors) THROWS rather than returning an empty
 *    list, so a broken fetch never renders as "complete, zero PRs" (a lying empty).
 *    Auth is resolved BEFORE this source is constructed: no GitHub token ⇒ no source
 *    is wired ⇒ `prs` stays empty (the B1 local-only surface), never a failed fetch.
 */

/** The boundary the project-detail source consumes; a GitHub impl is provided below. */
export interface ProjectPrSource {
  /** The signed-in GitHub login, or `null` when the viewer query returns none. */
  resolveViewer(): Promise<string | null>;
  /**
   * Open pull requests for a forge repo `owner/name`. A non-forge identity (the
   * common-dir fallback) yields an empty, complete result — it has no PRs to fetch.
   */
  listOpenPullRequests(repository: string): Promise<{ prs: PullRequest[]; truncated: boolean }>;
}

export interface GitHubProjectPrSourceConfig {
  /** A token-bound client from `createGitHubOctokit`. The token never leaves it. */
  octokit: Octokit;
  /** How many 50-node pages to page through before declaring the set truncated. */
  maxPages?: number;
}

const PAGE_SIZE = 50;
const DEFAULT_MAX_PAGES = 5;

const VIEWER_QUERY = `query{ viewer{ login } }`;

const OPEN_PRS_QUERY = `query($owner:String!,$name:String!,$cursor:String){
  repository(owner:$owner,name:$name){
    pullRequests(states:OPEN, first:${PAGE_SIZE}, after:$cursor, orderBy:{field:UPDATED_AT, direction:DESC}){
      totalCount
      pageInfo{ hasNextPage endCursor }
      nodes{
        id number title state updatedAt additions deletions changedFiles headRefName
        author{ login }
        reviewRequests(first:50){ nodes{ requestedReviewer{ __typename ... on User { login } } } }
        commits(last:1){ nodes{ commit{ statusCheckRollup{ state } } } }
      }
    }
  }
}`;

interface GraphqlPrNode {
  id: string;
  number: number;
  title: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  updatedAt: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  headRefName: string;
  /** `null` when the PR author's account was deleted (GitHub's "ghost"). */
  author: { login: string } | null;
  reviewRequests: {
    nodes: { requestedReviewer: { __typename: string; login?: string } | null }[];
  };
  commits: { nodes: { commit: { statusCheckRollup: { state: string } | null } }[] };
}

interface OpenPrsPage {
  totalCount: number;
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
  nodes: GraphqlPrNode[];
}

/**
 * A forge identity is exactly `owner/name`: two non-empty segments, no leading slash,
 * no whitespace. The common-dir fallback that `project-detail-source` emits for a
 * local-only repo is an absolute path (leading slash, more segments) → `null`, so no
 * PR fetch is attempted for it. This disambiguation is the SAME rule both halves must
 * agree on, exported so the detail source can pre-filter its roots without a network
 * call.
 */
export function parseForgeRepository(repository: string): { owner: string; name: string } | null {
  if (/\s/.test(repository)) return null;
  if (repository.startsWith("/")) return null;
  const parts = repository.split("/");
  if (parts.length !== 2) return null;
  const [owner, name] = parts;
  if (!owner || !name) return null;
  return { owner, name };
}

/**
 * Map GitHub's status-check rollup to the protocol CI enum. A PR with NO checks
 * configured has a `null` rollup → "none" (honestly unknown, not "passing"); the
 * queued/expected states are "pending"; error IS a failure.
 */
function mapCi(rollup: { state: string } | null | undefined): SmartListCi {
  switch (rollup?.state) {
    case "SUCCESS":
      return "passing";
    case "FAILURE":
    case "ERROR":
      return "failing";
    case "PENDING":
    case "EXPECTED":
      return "pending";
    default:
      return "none";
  }
}

/** OPEN | CLOSED | MERGED → the protocol's lowercase state (defensive: OPEN-only query). */
function mapState(state: GraphqlPrNode["state"]): PullRequest["state"] {
  switch (state) {
    case "MERGED":
      return "merged";
    case "CLOSED":
      return "closed";
    default:
      return "open";
  }
}

function mapNode(node: GraphqlPrNode, repository: string, viewerLogin: string | null): PullRequest {
  const reviewRequestedFromViewer =
    viewerLogin !== null &&
    node.reviewRequests.nodes.some((request) => request.requestedReviewer?.login === viewerLogin);
  const rollup = node.commits.nodes[0]?.commit.statusCheckRollup ?? null;
  return {
    id: node.id,
    number: node.number,
    // A GitHub PR title is always present, but guard the protocol's min(1) anyway.
    title: node.title.length > 0 ? node.title : `#${node.number}`,
    repository,
    branch: node.headRefName,
    // A deleted-account author is GitHub's "ghost"; never an empty string (min(1)).
    author: node.author?.login ?? "ghost",
    state: mapState(node.state),
    reviewRequestedFromViewer,
    ci: mapCi(rollup),
    additions: node.additions,
    deletions: node.deletions,
    changedFiles: node.changedFiles,
    lastActivityAt: node.updatedAt,
  };
}

/** The GitHub GraphQL implementation of `ProjectPrSource`. */
export function createGitHubProjectPrSource(config: GitHubProjectPrSourceConfig): ProjectPrSource {
  const maxPages = config.maxPages ?? DEFAULT_MAX_PAGES;
  let viewerLogin: string | null | undefined;

  async function graphql<T>(
    query: string,
    variables: Record<string, unknown>,
  ): Promise<{ data: T; partial: boolean }> {
    // `octokit.request` (not `octokit.graphql`) so the `X-GitHub-SSO` header stays
    // visible; octokit throws on a non-2xx, keeping the hard-failure invariant
    // (a broken fetch never renders as "complete, zero PRs").
    const res = await config.octokit.request("POST /graphql", { query, variables });
    const sso = parseGitHubSso(headerGet(res.headers, "X-GitHub-SSO"));
    const parsed = res.data as { data?: T; errors?: unknown };
    if (!parsed.data) {
      throw new Error(`GitHub GraphQL returned no data: ${JSON.stringify(parsed.errors ?? {})}`);
    }
    return { data: parsed.data, partial: sso.kind === "partial-results" };
  }

  async function resolveViewer(): Promise<string | null> {
    if (viewerLogin !== undefined) return viewerLogin;
    const { data } = await graphql<{ viewer: { login: string } | null }>(VIEWER_QUERY, {});
    viewerLogin = data.viewer?.login ?? null;
    return viewerLogin;
  }

  // One page of open PRs. Kept out of the pagination loop with an explicit return type
  // so the generic `graphql` call is not deferred through the loop's control-flow.
  async function fetchOpenPrsPage(
    owner: string,
    name: string,
    cursor: string | null,
  ): Promise<{ page: OpenPrsPage | null; partial: boolean }> {
    const result = await graphql<{ repository: { pullRequests: OpenPrsPage } | null }>(
      OPEN_PRS_QUERY,
      { owner, name, cursor },
    );
    return { page: result.data.repository?.pullRequests ?? null, partial: result.partial };
  }

  async function listOpenPullRequests(
    repository: string,
  ): Promise<{ prs: PullRequest[]; truncated: boolean }> {
    const identity = parseForgeRepository(repository);
    if (!identity) return { prs: [], truncated: false };
    const viewer = await resolveViewer();

    const prs: PullRequest[] = [];
    let cursor: string | null = null;
    let pages = 0;
    let hasNext = false;
    let sawPartial = false;
    do {
      const { page, partial } = await fetchOpenPrsPage(identity.owner, identity.name, cursor);
      if (partial) sawPartial = true;
      if (!page) break; // repo not found / no access → no rows, and no false completeness claim below
      for (const prNode of page.nodes) prs.push(mapNode(prNode, repository, viewer));
      cursor = page.pageInfo.endCursor;
      hasNext = page.pageInfo.hasNextPage;
      pages += 1;
    } while (hasNext && cursor && pages < maxPages);

    // Truncated ONLY when there is genuinely more than we paged through, or SSO
    // truncated a page. A repo whose whole open set fits in <= maxPages is complete.
    return { prs, truncated: hasNext || sawPartial };
  }

  return { resolveViewer, listOpenPullRequests };
}
