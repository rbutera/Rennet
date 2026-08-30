import type { Octokit } from "@octokit/core";
import type {
  ForgeCapabilities,
  ForgePublishOutcome,
  ForgePublishPort,
  ForgeRequestDescriptor,
  ForgeReviewEvent,
  ForgeReviewPost,
  ForgeReviewTarget,
} from "@rennet/core";
import { extractMarker, ForgeRateLimited } from "@rennet/core";
import { headerGet, requestErrorHeaders, requestErrorStatus } from "./github-octokit";

/**
 * The GitHub implementation of `ForgePublishPort` (issue #21) — the first real
 * egress: a decomposed Rennet review landing on a pull request AS THE USER.
 *
 * Every GitHub-specific fact lives behind this class: the GraphQL mutation
 * (`addPullRequestReview` with `threads:`, NEVER the deprecated `comments:`), the
 * `commitOID` pin, the node-id (`pullRequestId`) it posts against, the secondary
 * rate-limit signatures. Nothing GitHub leaks past it (the caller works in
 * `ForgeReviewPost`/`ForgeReviewTarget` nouns).
 *
 * SAFETY, made structural where possible:
 *   • `buildReviewRequest` is PURE and network-free (the primary dry-run evidence)
 *     and never touches the token: the bearer is an Authorization HEADER added only
 *     at real send, so a dry-run descriptor carries no secret.
 *   • The review `event` is the resolved verdict from the signed descriptor (derived from
 *     the dispositions, or an explicit override), so the previewed verdict is the posted one.
 *   • The token is resolved LAZILY (`resolveOctokit`) once per top-level operation,
 *     so constructing the adapter and building a dry-run request need no live
 *     credential, while one reconcile/publish cannot change identity between pages.
 *   • `publishReview` queries for the idempotency marker BEFORE posting and returns
 *     the existing review if found, so a retry after a dropped outcome yields exactly
 *     one review — and a secondary rate limit throws `ForgeRateLimited`, never a
 *     retry storm.
 */

export interface GitHubPublishConfig {
  /**
   * The token-bound client resolver from the auth ladder. Called only on a real
   * send (`findExistingReview` / `publishReview`), never for `buildReviewRequest`,
   * so a dry-run needs no credential. The token never leaves the client.
   */
  resolveOctokit: () => Promise<Octokit>;
  graphqlUrl?: string;
}

const GRAPHQL_URL = "https://api.github.com/graphql";

const ADD_REVIEW_MUTATION = `mutation($input: AddPullRequestReviewInput!) {
  addPullRequestReview(input: $input) {
    pullRequestReview { id url state }
  }
}`;

const REVIEWS_QUERY = `query($owner:String!,$name:String!,$number:Int!,$cursor:String){
  repository(owner:$owner,name:$name){
    pullRequest(number:$number){
      reviews(first:100, after:$cursor){
        pageInfo{ hasNextPage endCursor }
        nodes{ id url body }
      }
    }
  }
}`;

/** A single GraphQL `DraftPullRequestReviewThread` input. */
interface DraftThread {
  path: string;
  line: number;
  startLine?: number;
  side: "LEFT" | "RIGHT";
  startSide?: "LEFT" | "RIGHT";
  body: string;
}

/** The `addPullRequestReview` input variables — the exact bytes a real send posts. */
interface AddReviewInput {
  pullRequestId: string;
  commitOID: string;
  event: ForgeReviewEvent;
  body: string;
  threads: DraftThread[];
}

/**
 * Construct the exact `addPullRequestReview` request for a post WITHOUT sending it.
 * Pure — no token, no network. This is BOTH the dry-run evidence and the body a real
 * send serialises, so the previewed request equals the sent request by construction.
 * `pullRequestId` is the PR node id (`forgeRef`), `commitOID` pins the reviewed head,
 * and `event` is the exact APPROVE, REQUEST_CHANGES, or COMMENT value in the descriptor.
 */
export function buildGitHubReviewRequest(
  post: ForgeReviewPost,
  graphqlUrl: string = GRAPHQL_URL,
): ForgeRequestDescriptor {
  const threads: DraftThread[] = post.threads.map((thread) => ({
    path: thread.path,
    line: thread.line,
    ...(thread.startLine !== undefined
      ? { startLine: thread.startLine, startSide: thread.side }
      : {}),
    side: thread.side,
    body: thread.body,
  }));
  const input: AddReviewInput = {
    pullRequestId: post.target.forgeRef,
    commitOID: post.target.headOid,
    // The resolved verdict from the signed review (derived from the dispositions, or an
    // explicit override). A review tool posts the actual previewed verdict.
    event: post.event,
    body: post.body,
    threads,
  };
  return {
    requests: [
      {
        endpoint: graphqlUrl,
        method: "POST",
        body: { query: ADD_REVIEW_MUTATION, variables: { input } },
      },
    ],
  };
}

interface ReviewNode {
  id: string;
  url: string | null;
  body: string;
}

interface ReviewsPage {
  repository: {
    pullRequest: {
      reviews: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: ReviewNode[];
      };
    };
  };
}

interface AddReviewResult {
  addPullRequestReview: { pullRequestReview: { id: string; url: string | null } };
}

/**
 * Detect a GitHub secondary rate limit on a response and throw `ForgeRateLimited`,
 * so the caller backs off on GitHub's own schedule rather than retrying into a storm
 * (#21 / backlog bead 96). Recognises a 403/429 carrying `Retry-After`, an
 * `X-RateLimit-Remaining: 0` with a reset, or a secondary-limit message body.
 */
function throwIfRateLimited(
  status: number,
  headers: Record<string, string | number | undefined>,
): void {
  if (status !== 403 && status !== 429) return;
  const retryAfter = headerGet(headers, "Retry-After");
  if (retryAfter !== null) {
    const seconds = Number(retryAfter);
    throw new ForgeRateLimited(
      Number.isNaN(seconds) ? null : seconds * 1000,
      `HTTP ${status} with Retry-After`,
    );
  }
  const remaining = headerGet(headers, "X-RateLimit-Remaining");
  const reset = headerGet(headers, "X-RateLimit-Reset");
  if (remaining === "0" && reset !== null) {
    const resetMs = Number(reset) * 1000;
    const waitMs = Number.isNaN(resetMs) ? null : Math.max(0, resetMs - Date.now());
    throw new ForgeRateLimited(waitMs, `HTTP ${status} with X-RateLimit-Reset`);
  }
  // A 403/429 with no rate-limit headers is still treated as a backoff signal rather
  // than a retry: the secondary-limit body message is the last recognisable form.
  throw new ForgeRateLimited(null, `HTTP ${status} secondary rate limit`);
}

export class GitHubPublishAdapter implements ForgePublishPort {
  readonly capabilities: ForgeCapabilities = {
    supportsThreadResolution: true,
    supportsBatchedReview: true,
    supportsMultiLineAnchors: true,
    supportsFileLevelThreads: true,
  };

  constructor(private readonly config: GitHubPublishConfig) {}

  buildReviewRequest(post: ForgeReviewPost): ForgeRequestDescriptor {
    return buildGitHubReviewRequest(post, this.config.graphqlUrl ?? GRAPHQL_URL);
  }

  private async graphql<T>(
    octokit: Octokit,
    query: string,
    variables: Record<string, unknown>,
  ): Promise<{ data: T; errors?: unknown }> {
    let res: Awaited<ReturnType<Octokit["request"]>>;
    try {
      // `octokit.request` (not `octokit.graphql`) so response headers stay visible
      // and the GraphQL error envelope is ours to interpret.
      res = await octokit.request("POST /graphql", { query, variables });
    } catch (error) {
      // Octokit throws on 4xx; a 403/429 is GitHub's secondary rate limit —
      // surface it as a backoff signal, never a bare failure or a retry.
      const status = requestErrorStatus(error);
      if (status !== null) throwIfRateLimited(status, requestErrorHeaders(error));
      throw error;
    }
    const parsed = res.data as { data?: T; errors?: unknown };
    // A GraphQL secondary rate limit can also arrive as a 200 with a RATE_LIMITED
    // error type — surface it as a backoff, not a bare failure.
    if (parsed.errors && isRateLimitedError(parsed.errors)) {
      throw new ForgeRateLimited(null, "GraphQL RATE_LIMITED");
    }
    if (!parsed.data) {
      throw new Error(`GraphQL returned no data: ${JSON.stringify(parsed.errors ?? {})}`);
    }
    return { data: parsed.data, errors: parsed.errors };
  }

  private async fetchReviewsPage(
    octokit: Octokit,
    target: ForgeReviewTarget,
    cursor: string | null,
  ): Promise<ReviewsPage> {
    const { data } = await this.graphql<ReviewsPage>(octokit, REVIEWS_QUERY, {
      owner: target.ref.repo.owner,
      name: target.ref.repo.name,
      number: target.ref.number,
      cursor,
    });
    return data;
  }

  private async findExistingReviewWith(
    octokit: Octokit,
    target: ForgeReviewTarget,
    marker: string,
  ): Promise<ForgePublishOutcome | null> {
    let cursor: string | null = null;
    // Bound the reconcile scan so a pathological PR cannot loop forever; the marker
    // is written by the most recent post, so it surfaces on the first pages.
    for (let page = 0; page < 20; page += 1) {
      const fetched = await this.fetchReviewsPage(octokit, target, cursor);
      const reviews = fetched.repository.pullRequest.reviews;
      for (const node of reviews.nodes) {
        if (extractMarker(node.body) === marker) {
          return { reviewRef: node.id, url: node.url, reused: true };
        }
      }
      if (!reviews.pageInfo.hasNextPage) break;
      cursor = reviews.pageInfo.endCursor;
    }
    return null;
  }

  async findExistingReview(
    target: ForgeReviewTarget,
    marker: string,
  ): Promise<ForgePublishOutcome | null> {
    const octokit = await this.config.resolveOctokit();
    return this.findExistingReviewWith(octokit, target, marker);
  }

  async publishReview(post: ForgeReviewPost): Promise<ForgePublishOutcome> {
    const octokit = await this.config.resolveOctokit();
    // Query-before-post idempotency (R17 / #21): if a review carrying THIS post's
    // marker already exists, a prior send landed even if its outcome was dropped —
    // reuse it rather than double-post, so a retry yields exactly one review.
    const existing = await this.findExistingReviewWith(octokit, post.target, post.marker);
    if (existing) return existing;

    const request = this.buildReviewRequest(post).requests[0];
    if (request === undefined) throw new Error("GitHub review request is missing.");
    const { data } = await this.graphql<AddReviewResult>(
      octokit,
      ADD_REVIEW_MUTATION,
      (request.body as { variables: Record<string, unknown> }).variables,
    );
    const review = data.addPullRequestReview.pullRequestReview;
    return { reviewRef: review.id, url: review.url, reused: false };
  }
}

/** Whether a GraphQL `errors` array carries a RATE_LIMITED type (secondary limit). */
function isRateLimitedError(errors: unknown): boolean {
  return (
    Array.isArray(errors) &&
    errors.some(
      (error) =>
        typeof error === "object" &&
        error !== null &&
        (error as { type?: unknown }).type === "RATE_LIMITED",
    )
  );
}
