import type {
  ForgeCapabilities,
  ForgeDiff,
  ForgePort,
  ForgePullRequest,
  ForgePullRequestList,
  ForgePullRequestRef,
  ForgePullRequestSummary,
  SsoState,
} from "@rennet/core";
import type { HttpFetch } from "./github-auth";
import { parseGitHubSso } from "./github-sso";

/**
 * The GitHub implementation of `ForgePort` (GitHub Integration Plan §2/§5).
 *
 * Every GitHub-specific fact lives behind this class: the GraphQL documents, the
 * REST diff media type, the clone-URL shapes. It parses `X-GitHub-SSO` on EVERY
 * response and lifts a partial-results directive into a first-class `SsoState`, so
 * a truncated surface is never rendered as complete. All HTTP goes through the
 * injected `http`, so no test touches the network and the token never leaves this
 * process. GitHub is authoritative for identity here; git owns the diff content.
 */

export interface GitHubForgeConfig {
  http: HttpFetch;
  /** The bearer token from the auth ladder. Held in memory only, never persisted. */
  token: string;
  graphqlUrl?: string;
  apiBaseUrl?: string;
}

const GRAPHQL_URL = "https://api.github.com/graphql";
const API_BASE = "https://api.github.com";
/** GitHub's hard ceiling: a search returns at most 1000 nodes; past that it silently empties. */
const SEARCH_CEILING = 1000;

const PR_QUERY = `query($owner:String!,$name:String!,$number:Int!){
  repository(owner:$owner,name:$name){
    pullRequest(number:$number){
      number title body isDraft headRefOid baseRefOid baseRefName headRefName changedFiles id
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

  private authHeaders(accept: string): Record<string, string> {
    return { Authorization: `Bearer ${this.config.token}`, Accept: accept };
  }

  private async graphql<T>(
    query: string,
    variables: Record<string, unknown>,
  ): Promise<{ data: T; sso: SsoState }> {
    const url = this.config.graphqlUrl ?? GRAPHQL_URL;
    const res = await this.config.http(url, {
      method: "POST",
      headers: {
        ...this.authHeaders("application/vnd.github+json"),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
    });
    const sso = parseGitHubSso(res.headers.get("X-GitHub-SSO"));
    const parsed = JSON.parse(await res.text()) as { data?: T; errors?: unknown };
    if (!parsed.data) {
      throw new Error(`GraphQL returned no data: ${JSON.stringify(parsed.errors ?? {})}`);
    }
    return { data: parsed.data, sso };
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
      sso,
    };
  }

  async fetchDiff(ref: ForgePullRequestRef): Promise<ForgeDiff> {
    const base = this.config.apiBaseUrl ?? API_BASE;
    const url = `${base}/repos/${ref.repo.owner}/${ref.repo.name}/pulls/${ref.number}`;
    const res = await this.config.http(url, {
      method: "GET",
      headers: this.authHeaders("application/vnd.github.diff"),
    });
    const sso = parseGitHubSso(res.headers.get("X-GitHub-SSO"));
    return { diff: await res.text(), sso };
  }
}
