import {
  buildForgeReviewPost,
  canonicalReviewPayload,
  ForgeRateLimited,
  type ForgeReviewPost,
  type ForgeReviewTarget,
  type ReviewCommentInput,
} from "@rennet/core";
import { describe, expect, it } from "vitest";
import { createGitHubOctokit } from "./github-octokit";
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
  requiresReviewVerdictInBody: false,
};

function post(comments: ReviewCommentInput[], reviewId = "rev-1"): ForgeReviewPost {
  const artifact = { opener: "The change is ready for focused review.", comments, bodyNotes: [] };
  return buildForgeReviewPost(artifact, {
    reviewId,
    target: TARGET,
    payload: canonicalReviewPayload(artifact),
    capabilities: CAPS,
  });
}

function postWithVerdict(verdict: "APPROVE" | "COMMENT"): ForgeReviewPost {
  const artifact = {
    opener: "The change is ready for focused review.",
    comments: [],
    bodyNotes: [],
  };
  return buildForgeReviewPost(artifact, {
    reviewId: "rev-verdict",
    target: TARGET,
    payload: canonicalReviewPayload(artifact),
    capabilities: CAPS,
    verdict,
  });
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function adapterOver(respond: (body: { query: string; variables: never }) => Response) {
  const fetch: typeof globalThis.fetch = async (_input, init) => {
    const parsed = JSON.parse(typeof init?.body === "string" ? init.body : "{}");
    return respond(parsed);
  };
  const octokit = createGitHubOctokit({ fetch, token: "test-token" });
  return new GitHubPublishAdapter({ resolveOctokit: () => Promise.resolve(octokit) });
}

describe("buildGitHubReviewRequest (issue #21) — the dry-run evidence", () => {
  const singleLine = post([
    { path: "src/a.ts", line: 4, side: "RIGHT", type: "request-change", body: "rename" },
  ]);

  it("targets the GraphQL endpoint with a POST and the addPullRequestReview mutation", () => {
    const request = buildGitHubReviewRequest(singleLine);
    expect(request.requests[0]?.endpoint).toBe("https://api.github.com/graphql");
    expect(request.requests[0]?.method).toBe("POST");
    const body = request.requests[0]?.body as {
      query: string;
      variables: { input: Record<string, unknown> };
    };
    expect(body.query).toContain("addPullRequestReview");
    expect(body.query).not.toContain("comments:"); // NEVER the deprecated batched field
  });

  it("pins the head as commitOID, posts the derived verdict, targets the PR node id", () => {
    const body = buildGitHubReviewRequest(singleLine).requests[0]?.body as {
      variables: { input: { event: string; commitOID: string; pullRequestId: string } };
    };
    // singleLine carries a request-change ⇒ the derived verdict is REQUEST_CHANGES.
    expect(body.variables.input.event).toBe("REQUEST_CHANGES");
    expect(body.variables.input.commitOID).toBe("cafe0003");
    expect(body.variables.input.pullRequestId).toBe("PR_kwSANDBOX");
  });

  it("maps a single-line thread with no startLine/startSide", () => {
    const body = buildGitHubReviewRequest(singleLine).requests[0]?.body as {
      variables: { input: { threads: Record<string, unknown>[] } };
    };
    const thread = body.variables.input.threads[0];
    expect(thread).toMatchObject({ path: "src/a.ts", line: 4, side: "RIGHT" });
    expect(thread).not.toHaveProperty("startLine");
    expect(thread).not.toHaveProperty("startSide");
  });

  it("maps a multi-line thread as startLine through line on the same side", () => {
    const ranged = post([
      {
        path: "src/a.ts",
        startLine: 8,
        line: 10,
        side: "LEFT",
        type: "request-change",
        body: "restore this block",
      },
    ]);
    const body = buildGitHubReviewRequest(ranged).requests[0]?.body as {
      variables: { input: { threads: Record<string, unknown>[] } };
    };

    expect(body.variables.input.threads[0]).toMatchObject({
      path: "src/a.ts",
      startLine: 8,
      startSide: "LEFT",
      line: 10,
      side: "LEFT",
    });
  });

  it("passes the resolved verdict through to the wire (APPROVE / REQUEST_CHANGES / COMMENT)", () => {
    // The wire posts the post's resolved verdict — a review tool must post the actual
    // verdict. Derived from the dispositions here; an override is exercised in the core
    // + dispatch tests.
    const eventOf = (p: ForgeReviewPost): string => {
      const request = buildGitHubReviewRequest(p).requests[0];
      if (request === undefined) throw new Error("request missing");
      return (
        request.body as {
          variables: { input: { event: string } };
        }
      ).variables.input.event;
    };
    expect(
      eventOf(post([{ path: "a.ts", line: 1, side: "RIGHT", type: "approve", body: "ok" }])),
    ).toBe("APPROVE");
    expect(
      eventOf(post([{ path: "a.ts", line: 1, side: "RIGHT", type: "request-change", body: "no" }])),
    ).toBe("REQUEST_CHANGES");
    expect(
      eventOf(post([{ path: "a.ts", line: 1, side: "RIGHT", type: "comment", body: "fyi" }])),
    ).toBe("COMMENT");
  });

  it("carries NO secret — the descriptor has no Authorization/Bearer/token", () => {
    // The bearer is a send-time credential, never part of the constructed descriptor.
    expect(JSON.stringify(buildGitHubReviewRequest(singleLine))).not.toMatch(
      /authorization|bearer|token/i,
    );
  });
});

describe("GitHubPublishAdapter.publishReview (issue #21) — idempotency", () => {
  it("uses one resolved credential across paginated reconcile and the mutation", async () => {
    let resolutions = 0;
    let reviewPages = 0;
    const fetch: typeof globalThis.fetch = async (_input, init) => {
      const parsed = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
        query: string;
      };
      if (parsed.query.includes("addPullRequestReview")) {
        return json(200, {
          data: {
            addPullRequestReview: {
              pullRequestReview: { id: "PRR_1", url: "https://github.com/o/r/pull/3#r1" },
            },
          },
        });
      }
      reviewPages += 1;
      return json(200, {
        data: {
          repository: {
            pullRequest: {
              headRefOid: TARGET.headOid,
              reviews: {
                pageInfo: {
                  hasNextPage: reviewPages === 1,
                  endCursor: reviewPages === 1 ? "next" : null,
                },
                nodes: [],
              },
            },
          },
        },
      });
    };
    const octokit = createGitHubOctokit({ fetch, token: "operation-token" });
    const adapter = new GitHubPublishAdapter({
      resolveOctokit: () => {
        resolutions += 1;
        return Promise.resolve(octokit);
      },
    });

    const outcome = await adapter.publishReview(
      post([{ path: "a.ts", line: 1, side: "RIGHT", type: "comment", body: "x" }]),
    );

    expect(outcome.reused).toBe(false);
    expect(reviewPages).toBe(2);
    expect(resolutions).toBe(1);
  });

  /**
   * A stateful fake GitHub: the mutation records the created review (its body carries
   * the marker); the reviews query returns whatever has been created so far. So a
   * SECOND publish of the same post finds the marker and reuses it — proving that a
   * retry after a dropped outcome yields exactly one review.
   */
  function fakeGitHub() {
    const created: { id: string; url: string; body: string }[] = [];
    let mutations = 0;
    const adapter = adapterOver((parsed) => {
      const { query, variables } = parsed as unknown as {
        query: string;
        variables: { input?: { body?: string } };
      };
      if (query.includes("addPullRequestReview")) {
        mutations += 1;
        const node = {
          id: `PRR_${mutations}`,
          url: `https://github.com/o/r/pull/3#r${mutations}`,
          body: variables.input?.body ?? "",
        };
        created.push(node);
        return json(200, {
          data: { addPullRequestReview: { pullRequestReview: { id: node.id, url: node.url } } },
        });
      }
      // A reviews query — return the created reviews (one page).
      return json(200, {
        data: {
          repository: {
            pullRequest: {
              headRefOid: TARGET.headOid,
              reviews: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: created },
            },
          },
        },
      });
    });
    return { adapter, mutationCount: () => mutations };
  }

  it("posts once, then reuses the marked review on retry — exactly one review", async () => {
    const { adapter, mutationCount } = fakeGitHub();
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

  it("refuses a moved head before the review mutation", async () => {
    let mutations = 0;
    const adapter = adapterOver((parsed) => {
      if (parsed.query.includes("addPullRequestReview")) mutations += 1;
      return json(200, {
        data: {
          repository: {
            pullRequest: {
              headRefOid: "new-head",
              reviews: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
            },
          },
        },
      });
    });

    await expect(adapter.publishReview(post([]))).rejects.toThrow(/head moved/i);
    expect(mutations).toBe(0);
  });

  it("reconciles a mutation whose response was lost without posting twice", async () => {
    const created: { id: string; url: string; body: string }[] = [];
    let mutations = 0;
    let loseFirstMutationResponse = true;
    const adapter = adapterOver((parsed) => {
      const { query, variables } = parsed as unknown as {
        query: string;
        variables: { input?: { body?: string } };
      };
      if (query.includes("addPullRequestReview")) {
        mutations += 1;
        const node = {
          id: `PRR_${mutations}`,
          url: `https://github.com/o/r/pull/3#pullrequestreview-${mutations}`,
          body: variables.input?.body ?? "",
        };
        created.push(node);
        if (loseFirstMutationResponse) {
          loseFirstMutationResponse = false;
          throw new Error("socket closed after GitHub committed the mutation");
        }
        return json(200, {
          data: { addPullRequestReview: { pullRequestReview: node } },
        });
      }
      return json(200, {
        data: {
          repository: {
            pullRequest: {
              headRefOid: TARGET.headOid,
              reviews: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: created },
            },
          },
        },
      });
    });
    const review = post([]);

    await expect(adapter.publishReview(review)).rejects.toThrow(/socket closed/);
    await expect(adapter.publishReview(review)).resolves.toMatchObject({
      reviewRef: "PRR_1",
      reused: true,
    });
    expect(mutations).toBe(1);
  });

  it("posts a changed verdict as a new review when the body content is otherwise identical", async () => {
    const { adapter, mutationCount } = fakeGitHub();
    const comment = postWithVerdict("COMMENT");
    const approve = postWithVerdict("APPROVE");

    expect(comment.body.replace(comment.marker, approve.marker)).toBe(approve.body);
    expect(comment.marker).not.toBe(approve.marker);

    await adapter.publishReview(comment);
    const outcome = await adapter.publishReview(approve);

    expect(outcome.reused).toBe(false);
    expect(mutationCount()).toBe(2);
  });

  it("reuses one landed review when authored prose contains an earlier marker-shaped comment", async () => {
    const { adapter, mutationCount } = fakeGitHub();
    const quoted = "f".repeat(64);
    const artifact = {
      opener: `The docs quote <!-- rennet:review:${quoted} --> as an example.`,
      comments: [],
      bodyNotes: [],
    };
    const p = buildForgeReviewPost(artifact, {
      reviewId: "rev-quoted-marker",
      target: TARGET,
      payload: canonicalReviewPayload(artifact),
      capabilities: CAPS,
      verdict: "COMMENT",
    });

    const first = await adapter.publishReview(p);
    const retry = await adapter.publishReview(p);

    expect(first.reused).toBe(false);
    expect(retry.reused).toBe(true);
    expect(retry.reviewRef).toBe(first.reviewRef);
    expect(mutationCount()).toBe(1);
  });
});

describe("GitHubPublishAdapter — secondary rate limit (issue #21)", () => {
  it("throws ForgeRateLimited on a 403 with Retry-After, never a retry storm", async () => {
    let calls = 0;
    const adapter = adapterOver(() => {
      calls += 1;
      return json(403, { message: "secondary rate limit" }, { "Retry-After": "42" });
    });
    const p = post([{ path: "a.ts", line: 1, side: "RIGHT", type: "comment", body: "x" }]);

    const error = await adapter.publishReview(p).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ForgeRateLimited);
    expect((error as ForgeRateLimited).retryAfterMs).toBe(42000);
    // The reviews query hit the limit and threw — it did NOT loop into more calls.
    expect(calls).toBe(1);
  });
});
