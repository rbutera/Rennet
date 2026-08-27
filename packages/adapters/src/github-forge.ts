import type { Octokit } from "@octokit/core";
import type {
  ForgeCapabilities,
  ForgeCheckRun,
  ForgeCiStatus,
  ForgeDiff,
  ForgePort,
  ForgePullRequest,
  ForgePullRequestList,
  ForgePullRequestRef,
  ForgePullRequestSummary,
  SsoState,
} from "@rennet/core";
import { headerGet } from "./github-octokit";
import { parseGitHubSso } from "./github-sso";

/**
 * The GitHub implementation of `ForgePort` (GitHub Integration Plan §2/§5).
 *
 * Every GitHub-specific fact lives behind this class: the GraphQL documents, the
 * REST diff media type, the clone-URL shapes. It parses `X-GitHub-SSO` on EVERY
 * response and lifts a partial-results directive into a first-class `SsoState`, so
 * a truncated surface is never rendered as complete. All HTTP goes through the
 * injected `octokit` (a fake `fetch` in tests), so no test touches the network and
 * the token never leaves this process. GitHub is authoritative for identity here; git owns the diff content.
 */

export interface GitHubForgeConfig {
  /** A token-bound client from `createGitHubOctokit`. The token never leaves it. */
  octokit: Octokit;
}

/** GitHub's hard ceiling: a search returns at most 1000 nodes; past that it silently empties. */
const SEARCH_CEILING = 1000;

const PR_QUERY = `query($owner:String!,$name:String!,$number:Int!){
  repository(owner:$owner,name:$name){
    pullRequest(number:$number){
      number title body isDraft headRefOid baseRefOid baseRefName headRefName changedFiles id viewerDidAuthor
    }
  }
}`;

const HOME_QUERY = `query($q:String!){
  search(query:$q, type: ISSUE, first: 50){
    issueCount
    nodes{ ... on PullRequest {
      number title isDraft updatedAt headRefOid id repository{ nameWithOwner }
    } }
  }
}`;

const CI_STATUS_QUERY = `query($owner:String!,$name:String!,$headOid:GitObjectID!){
  repository(owner:$owner,name:$name){
    object(oid:$headOid){ ... on Commit {
      statusCheckRollup{
        contexts(first:100){
          pageInfo { hasNextPage }
          nodes{
          __typename
          ... on CheckRun { id name status conclusion title summary detailsUrl }
          ... on StatusContext { context state description targetUrl }
        } }
      }
    } }
  }
}`;

interface GraphqlPr {
  number: number;
  title: string;
  /** Nullable on GitHub: a PR with no description returns `null`, mapped to "". */
  body: string | null;
  isDraft: boolean;
  headRefOid: string;
  baseRefOid: string;
  baseRefName: string;
  headRefName: string;
  changedFiles: number;
  id: string;
  viewerDidAuthor: boolean;
}

interface GraphqlSearchNode {
  number: number;
  title: string;
  isDraft: boolean;
  updatedAt: string;
  headRefOid: string;
  id: string;
  repository: { nameWithOwner: string };
}

interface GraphqlCheckRun {
  __typename: "CheckRun";
  id: string;
  name: string;
  status: string;
  conclusion: string | null;
  title: string | null;
  summary: string | null;
  detailsUrl: string | null;
}

interface GraphqlStatusContext {
  __typename: "StatusContext";
  context: string;
  state: string;
  description: string | null;
  targetUrl: string | null;
}

type GraphqlCheckContext = GraphqlCheckRun | GraphqlStatusContext;

function mapCheckRun(node: GraphqlCheckRun): ForgeCheckRun {
  const outcome: ForgeCheckRun["outcome"] =
    node.status !== "COMPLETED"
      ? "pending"
      : node.conclusion === "SUCCESS"
        ? "passing"
        : node.conclusion === "NEUTRAL" || node.conclusion === "SKIPPED"
          ? "neutral"
          : "failing";
  return {
    id: node.id,
    name: node.name,
    outcome,
    summary: node.summary ?? node.title ?? "",
    ...(node.detailsUrl === null ? {} : { detailsUrl: node.detailsUrl }),
  };
}

function mapStatusContext(node: GraphqlStatusContext): ForgeCheckRun {
  const outcome: ForgeCheckRun["outcome"] =
    node.state === "SUCCESS"
      ? "passing"
      : node.state === "PENDING" || node.state === "EXPECTED"
        ? "pending"
        : node.state === "FAILURE" || node.state === "ERROR"
          ? "failing"
          : "neutral";
  return {
    id: `status-context:${node.context}\0${node.targetUrl ?? ""}`,
    name: node.context,
    outcome,
    summary: node.description ?? "",
    ...(node.targetUrl === null ? {} : { detailsUrl: node.targetUrl }),
  };
}

/** Clone URLs derived from repo identity — never a path guess; the matcher maps these. */
function cloneUrls(owner: string, name: string): string[] {
  return [
    `https://github.com/${owner}/${name}.git`,
    `git@github.com:${owner}/${name}.git`,
    `ssh://git@github.com/${owner}/${name}.git`,
  ];
}

export class GitHubForgeAdapter implements ForgePort {
  readonly capabilities: ForgeCapabilities = {
    supportsThreadResolution: true,
    supportsBatchedReview: true,
    supportsMultiLineAnchors: true,
    supportsFileLevelThreads: true,
  };

  constructor(private readonly config: GitHubForgeConfig) {}

  private async graphql<T>(
    query: string,
    variables: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<{ data: T; sso: SsoState; incomplete: boolean }> {
    // `octokit.request` (not `octokit.graphql`) so the response HEADERS stay
    // visible — `X-GitHub-SSO` must be parsed on every response.
    const res = await this.config.octokit.request("POST /graphql", {
      query,
      variables,
      ...(signal === undefined ? {} : { request: { signal } }),
    });
    const sso = parseGitHubSso(headerGet(res.headers, "X-GitHub-SSO"));
    const parsed = res.data as { data?: T; errors?: unknown };
    if (!parsed.data) {
      throw new Error(`GraphQL returned no data: ${JSON.stringify(parsed.errors ?? {})}`);
    }
    const incomplete =
      (parsed.errors !== undefined &&
        (!Array.isArray(parsed.errors) || parsed.errors.length > 0)) ||
      sso.kind === "partial-results";
    return { data: parsed.data, sso, incomplete };
  }

  async listOpenPullRequests(): Promise<ForgePullRequestList> {
    const { data, sso } = await this.graphql<{
      search: { issueCount: number; nodes: GraphqlSearchNode[] };
    }>(HOME_QUERY, { q: "is:pr is:open involves:@me archived:false" });
    const items: ForgePullRequestSummary[] = data.search.nodes.map((node) => {
      const [owner, name] = node.repository.nameWithOwner.split("/");
      return {
        ref: {
          repo: { forge: "github", owner: owner ?? "", name: name ?? "" },
          number: node.number,
        },
        title: node.title,
        isDraft: node.isDraft,
        updatedAt: node.updatedAt,
        headOid: node.headRefOid,
        forgeRef: node.id,
      };
    });
    const truncatedOver1000 = data.search.issueCount > SEARCH_CEILING;
    // A short/empty list is NEVER "complete" when SSO truncated it, the ceiling was
    // hit, OR the page returned fewer nodes than the total match count (ordinary
    // pagination past `first: 50`). The invariant is "never render a truncated list
    // as complete", not just the >1000 case — the UI must show a banner.
    const truncatedByPage = items.length < data.search.issueCount;
    const complete = sso.kind !== "partial-results" && !truncatedOver1000 && !truncatedByPage;
    return { items, sso, complete, truncatedOver1000 };
  }

  async fetchPullRequest(ref: ForgePullRequestRef): Promise<ForgePullRequest> {
    const { data, sso } = await this.graphql<{ repository: { pullRequest: GraphqlPr } }>(PR_QUERY, {
      owner: ref.repo.owner,
      name: ref.repo.name,
      number: ref.number,
    });
    const pr = data.repository.pullRequest;
    return {
      ref,
      title: pr.title,
      // GitHub returns `null` for an empty description; carry "" so a consumer
      // distinguishes "no body" (an honest empty) from an unfetched surface.
      body: pr.body ?? "",
      isDraft: pr.isDraft,
      headOid: pr.headRefOid,
      baseOid: pr.baseRefOid,
      baseRef: pr.baseRefName,
      headRef: pr.headRefName,
      cloneUrls: cloneUrls(ref.repo.owner, ref.repo.name),
      forgeRef: pr.id,
      changedFiles: pr.changedFiles,
      viewerDidAuthor: pr.viewerDidAuthor,
      sso,
    };
  }

  async fetchDiff(ref: ForgePullRequestRef): Promise<ForgeDiff> {
    const res = await this.config.octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
      owner: ref.repo.owner,
      repo: ref.repo.name,
      pull_number: ref.number,
      mediaType: { format: "diff" },
    });
    const sso = parseGitHubSso(headerGet(res.headers, "X-GitHub-SSO"));
    return { diff: res.data as unknown as string, sso };
  }

  async fetchCiStatus(
    ref: ForgePullRequestRef,
    headOid: string,
    signal?: AbortSignal,
  ): Promise<ForgeCiStatus> {
    const { data, sso, incomplete } = await this.graphql<{
      repository: {
        object: {
          statusCheckRollup: {
            contexts: {
              nodes: GraphqlCheckContext[];
              pageInfo?: { hasNextPage: boolean };
            };
          } | null;
        } | null;
      };
    }>(
      CI_STATUS_QUERY,
      {
        owner: ref.repo.owner,
        name: ref.repo.name,
        headOid,
      },
      signal,
    );
    if (data.repository.object === null) {
      throw new Error(`GitHub returned no commit for reviewed head ${headOid}`);
    }
    const contexts = data.repository.object.statusCheckRollup?.contexts;
    const nodes = contexts?.nodes ?? [];
    return {
      checks: nodes.map((node) =>
        node.__typename === "CheckRun" ? mapCheckRun(node) : mapStatusContext(node),
      ),
      sso,
      incomplete: incomplete || (contexts?.pageInfo?.hasNextPage ?? false),
    };
  }
}
