import {
  buildForgeReviewPost,
  canonicalReviewPayload,
  ForgeRateLimited,
  type ForgeReviewPost,
  type ForgeReviewTarget,
  type ReviewCommentInput,
} from "@rennet/core";
import { describe, expect, it } from "vitest";
import type { HttpFetch, HttpResponse } from "./github-auth";
import { buildGitHubReviewRequest, GitHubPublishAdapter } from "./github-publish";

const TARGET: ForgeReviewTarget = {
  ref: { repo: { forge: "github", owner: "rbutera", name: "rennet-egress-sandbox" }, number: 3 },
  forgeRef: "PR_kwSANDBOX",
  headOid: "cafe0003",
};

const CAPS = {
  supportsThreadResolution: true,
  supportsBatchedReview: true,
  supportsMultiLineAnchors: true,
  supportsFileLevelThreads: true,
};

function post(comments: ReviewCommentInput[], reviewId = "rev-1"): ForgeReviewPost {
  return buildForgeReviewPost(comments, {
    reviewId,
    target: TARGET,
    payload: canonicalReviewPayload(comments),
    capabilities: CAPS,
  });
}

function response(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): HttpResponse {
  return {
    status,
    headers: { get: (name) => headers[name] ?? headers[name.toLowerCase()] ?? null },
    text: () => Promise.resolve(JSON.stringify(body)),
  };
}

describe("buildGitHubReviewRequest (issue #21) — the dry-run evidence", () => {
  const singleLine = post([
    { path: "src/a.ts", line: 4, side: "RIGHT", type: "request-change", body: "rename" },
  ]);

  it("targets the GraphQL endpoint with a POST and the addPullRequestReview mutation", () => {
    const request = buildGitHubReviewRequest(singleLine);
    expect(request.endpoint).toBe("https://api.github.com/graphql");
    expect(request.method).toBe("POST");
    const body = request.body as { query: string; variables: { input: Record<string, unknown> } };
    expect(body.query).toContain("addPullRequestReview");
    expect(body.query).not.toContain("comments:"); // NEVER the deprecated batched field
  });

  it("pins the head as commitOID, posts as COMMENT, targets the PR node id", () => {
    const body = buildGitHubReviewRequest(singleLine).body as {
      variables: { input: { event: string; commitOID: string; pullRequestId: string } };
    };
    expect(body.variables.input.event).toBe("COMMENT");
    expect(body.variables.input.commitOID).toBe("cafe0003");
    expect(body.variables.input.pullRequestId).toBe("PR_kwSANDBOX");
  });

  it("maps a single-line thread with no startLine/startSide", () => {
    const body = buildGitHubReviewRequest(singleLine).body as {
      variables: { input: { threads: Record<string, unknown>[] } };
    };
    const thread = body.variables.input.threads[0];
    expect(thread).toMatchObject({ path: "src/a.ts", line: 4, side: "RIGHT" });
    expect(thread).not.toHaveProperty("startLine");
    expect(thread).not.toHaveProperty("startSide");
  });

  it("carries NO secret — the descriptor has no Authorization/Bearer/token", () => {
    // The bearer is a send-time HEADER, never part of the constructed descriptor.
    expect(JSON.stringify(buildGitHubReviewRequest(singleLine))).not.toMatch(
      /authorization|bearer|token/i,
    );
  });
});

describe("GitHubPublishAdapter.publishReview (issue #21) — idempotency", () => {
  /**
   * A stateful fake GitHub: the mutation records the created review (its body carries
   * the marker); the reviews query returns whatever has been created so far. So a
   * SECOND publish of the same post finds the marker and reuses it — proving that a
   * retry after a dropped outcome yields exactly one review.
   */
  function fakeGitHub(): { http: HttpFetch; mutationCount: () => number } {
    const created: { id: string; url: string; body: string }[] = [];
    let mutations = 0;
    const http: HttpFetch = (_url, init) => {
      const parsed = JSON.parse(init?.body ?? "{}") as {
        query: string;
        variables: { input?: { body?: string } };
      };
      if (parsed.query.includes("addPullRequestReview")) {
        mutations += 1;
        const node = {
          id: `PRR_${mutations}`,
          url: `https://github.com/o/r/pull/3#r${mutations}`,
          body: parsed.variables.input?.body ?? "",
        };
        created.push(node);
        return Promise.resolve(
          response(200, {
            data: { addPullRequestReview: { pullRequestReview: { id: node.id, url: node.url } } },
          }),
        );
      }
      // A reviews query — return the created reviews (one page).
      return Promise.resolve(
        response(200, {
          data: {
            repository: {
              pullRequest: {
                reviews: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: created },
              },
            },
          },
        }),
      );
    };
    return { http, mutationCount: () => mutations };
  }

  it("posts once, then reuses the marked review on retry — exactly one review", async () => {
    const { http, mutationCount } = fakeGitHub();
    const adapter = new GitHubPublishAdapter({
      http,
      resolveToken: () => Promise.resolve("test-token"),
    });
    const p = post([{ path: "a.ts", line: 1, side: "RIGHT", type: "comment", body: "x" }]);

    const first = await adapter.publishReview(p);
    expect(first.reused).toBe(false);
    expect(mutationCount()).toBe(1);

    // The outcome was "dropped" — the caller retries the SAME post.
    const second = await adapter.publishReview(p);
    expect(second.reused).toBe(true);
    expect(second.reviewRef).toBe(first.reviewRef);
    expect(mutationCount()).toBe(1); // NO second post — exactly one review
  });
});

describe("GitHubPublishAdapter — secondary rate limit (issue #21)", () => {
  it("throws ForgeRateLimited on a 403 with Retry-After, never a retry storm", async () => {
    let calls = 0;
    const http: HttpFetch = () => {
      calls += 1;
      return Promise.resolve(
        response(403, { message: "secondary rate limit" }, { "Retry-After": "42" }),
      );
    };
    const adapter = new GitHubPublishAdapter({
      http,
      resolveToken: () => Promise.resolve("test-token"),
    });
    const p = post([{ path: "a.ts", line: 1, side: "RIGHT", type: "comment", body: "x" }]);

    const error = await adapter.publishReview(p).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ForgeRateLimited);
    expect((error as ForgeRateLimited).retryAfterMs).toBe(42000);
    // The reviews query hit the limit and threw — it did NOT loop into more calls.
    expect(calls).toBe(1);
  });
});
