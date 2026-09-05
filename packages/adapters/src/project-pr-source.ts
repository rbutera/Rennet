import type { Octokit } from "@octokit/core";
import {
  type ForgeRepoIdentity,
  forgeRepositorySlug,
  type PullRequest,
  type PullRequestState,
  type SmartListCi,
} from "@rennet/protocol";
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
 * ── SCOPE, stated honestly ───────────────────────────────────────────────────
 *  • State-filtered (historical-PR review): OPEN by default, MERGED/CLOSED on
 *    request, recent-first, paginated up to a bounded ceiling. `truncated` is set
 *    ONLY when the requested set genuinely exceeds that ceiling or SSO returns
 *    partial-results — deep merged history routinely trips it and honestly renders
 *    as a partial list. The renderer's merged→read-only (retrospective) path folds
 *    the surfaced rows; no local sync of history is ever kept.
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
   * Pull requests for one provider-qualified repository in the given states. A source must
   * reject another provider before making a request; the project registry selects it first.
   */
  listPullRequests(
    repository: ForgeRepoIdentity,
    states?: readonly PullRequestState[],
  ): Promise<{ prs: PullRequest[]; truncated: boolean }>;
}

export type ProjectPrSourceUnavailableReason = "tooling" | "authentication" | "network";

/**
 * A provider-local availability failure that may omit that provider's rows without
 * hiding healthy local or sibling-forge rows. Invalid provider data still throws.
 */
export class ProjectPrSourceUnavailable extends Error {
  constructor(
    readonly forge: string,
    readonly reason: ProjectPrSourceUnavailableReason,
    readonly repair: string,
  ) {
    super(repair);
    this.name = "ProjectPrSourceUnavailable";
  }
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

const PRS_QUERY = `query($owner:String!,$name:String!,$states:[PullRequestState!]!,$cursor:String){
  repository(owner:$owner,name:$name){
    pullRequests(states:$states, first:${PAGE_SIZE}, after:$cursor, orderBy:{field:UPDATED_AT, direction:DESC}){
      totalCount
      pageInfo{ hasNextPage endCursor }
      nodes{
        id number title state createdAt updatedAt additions deletions changedFiles headRefName
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
  createdAt: string;
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

/** OPEN | CLOSED | MERGED → the protocol's lowercase state. */
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

function mapNode(
  node: GraphqlPrNode,
  forgeRepository: ForgeRepoIdentity,
  viewerLogin: string | null,
): PullRequest {
  const reviewRequestedFromViewer =
    viewerLogin !== null &&
    node.reviewRequests.nodes.some((request) => request.requestedReviewer?.login === viewerLogin);
  const rollup = node.commits.nodes[0]?.commit.statusCheckRollup ?? null;
  return {
    id: node.id,
    number: node.number,
    // A GitHub PR title is always present, but guard the protocol's min(1) anyway.
    title: node.title.length > 0 ? node.title : `#${node.number}`,
    repository: forgeRepositorySlug(forgeRepository),
    forgeRepository,
    branch: node.headRefName,
    // A deleted-account author is GitHub's "ghost"; never an empty string (min(1)).
    author: node.author?.login ?? "ghost",
    viewerDidAuthor: viewerLogin !== null && node.author?.login === viewerLogin,
    state: mapState(node.state),
    reviewRequestedFromViewer,
    ci: mapCi(rollup),
    additions: node.additions,
    deletions: node.deletions,
    changedFiles: node.changedFiles,
    createdAt: node.createdAt,
    lastActivityAt: node.updatedAt,
  };
}

/**
 * How many per-repo PR list fetches one source instance runs at once — shared
 * across EVERY load through the instance, not per call. The source is a memoized
 * singleton on the server, so two overlapping `project.detail` loads would
 * otherwise stack their per-call caps (2 x 4 = 8 in flight); one semaphore at
 * construction keeps the instance-wide worst case at 4 x the request deadline.
 */
const MAX_CONCURRENT_LIST_FETCHES = 4;

/** A slot-passing semaphore: release hands the slot straight to the next waiter. */
function createSemaphore(limit: number): <T>(run: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiters: (() => void)[] = [];
  const release = () => {
    const waiter = waiters.shift();
    if (waiter) waiter();
    else active -= 1;
  };
  return async (run) => {
    if (active < limit) active += 1;
    else await new Promise<void>((resolve) => waiters.push(resolve));
    try {
      return await run();
    } finally {
      release();
    }
  };
}

/** The GitHub GraphQL implementation of `ProjectPrSource`. */
export function createGitHubProjectPrSource(config: GitHubProjectPrSourceConfig): ProjectPrSource {
  const maxPages = config.maxPages ?? DEFAULT_MAX_PAGES;
  const withListSlot = createSemaphore(MAX_CONCURRENT_LIST_FETCHES);
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

  // One page of PRs in the requested states. Kept out of the pagination loop with an
  // explicit return type so the generic `graphql` call is not deferred through the
  // loop's control-flow.
  async function fetchPrsPage(
    owner: string,
    name: string,
    states: readonly PullRequestState[],
    cursor: string | null,
  ): Promise<{ page: OpenPrsPage | null; partial: boolean }> {
    const result = await graphql<{ repository: { pullRequests: OpenPrsPage } | null }>(PRS_QUERY, {
      owner,
      name,
      // The protocol's lowercase states map 1:1 onto GitHub's GraphQL enum.
      states: states.map((state) => state.toUpperCase()),
      cursor,
    });
    return { page: result.data.repository?.pullRequests ?? null, partial: result.partial };
  }

  async function listPullRequests(
    repository: ForgeRepoIdentity,
    states: readonly PullRequestState[] = ["open"],
  ): Promise<{ prs: PullRequest[]; truncated: boolean }> {
    if (repository.forge !== "github") {
      throw new Error(`GitHub project source cannot list ${repository.forge} repositories`);
    }
    const viewer = await resolveViewer();

    const prs: PullRequest[] = [];
    let cursor: string | null = null;
    let pages = 0;
    let hasNext = false;
    let sawPartial = false;
    do {
      const { page, partial } = await fetchPrsPage(
        repository.owner,
        repository.name,
        states,
        cursor,
      );
      if (partial) sawPartial = true;
      if (!page) break; // repo not found / no access → no rows, and no false completeness claim below
      for (const prNode of page.nodes) prs.push(mapNode(prNode, repository, viewer));
      cursor = page.pageInfo.endCursor;
      hasNext = page.pageInfo.hasNextPage;
      pages += 1;
    } while (hasNext && cursor && pages < maxPages);

    // Truncated ONLY when there is genuinely more than we paged through, or SSO
    // truncated a page. A repo whose whole set fits in <= maxPages is complete;
    // deep merged/closed history routinely exceeds it and honestly reads partial.
    return { prs, truncated: hasNext || sawPartial };
  }

  return {
    resolveViewer,
    listPullRequests: (repository, states) =>
      withListSlot(() => listPullRequests(repository, states)),
  };
}
