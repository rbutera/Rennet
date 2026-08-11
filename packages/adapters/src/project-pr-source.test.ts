import { pullRequestSchema } from "@rennet/protocol";
import { describe, expect, it, vi } from "vitest";
import type { HttpFetch, HttpResponse } from "./github-auth";
import { createGitHubProjectPrSource, parseForgeRepository } from "./project-pr-source";

/** A canned HTTP response with optional headers (defaults to a clean 200). */
function response(body: unknown, init?: { status?: number; sso?: string }): HttpResponse {
  const headers = new Map<string, string>();
  if (init?.sso) headers.set("X-GitHub-SSO", init.sso);
  return {
    status: init?.status ?? 200,
    headers: { get: (name) => headers.get(name) ?? null },
    text: async () => JSON.stringify(body),
  };
}

/** A GraphQL PR node with sensible defaults; override per case. */
function node(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "PR_1",
    number: 12,
    title: "Add glass tokens",
    state: "OPEN",
    updatedAt: "2026-08-10T00:00:00.000Z",
    additions: 40,
    deletions: 3,
    changedFiles: 5,
    headRefName: "feat/glass",
    author: { login: "octocat" },
    reviewRequests: { nodes: [] },
    commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] },
    ...overrides,
  };
}

/** Build an http that answers the viewer query and a scripted sequence of PR pages. */
function makeHttp(config: {
  viewer?: string | null;
  pages?: {
    nodes: Record<string, unknown>[];
    hasNextPage?: boolean;
    endCursor?: string | null;
    totalCount?: number;
  }[];
  repositoryNull?: boolean;
  status?: number;
  errors?: unknown;
}): { http: HttpFetch; calls: () => number } {
  let pageIndex = 0;
  let calls = 0;
  const http: HttpFetch = async (_url, init) => {
    calls += 1;
    const body = JSON.parse(init?.body ?? "{}") as { query: string };
    if (config.status && config.status !== 200) return response({}, { status: config.status });
    if (config.errors) return response({ errors: config.errors });
    // Match the PR query FIRST: OPEN_PRS_QUERY contains "requestedReviewer", so a bare
    // `includes("viewer")` would misroute it. "pullRequests" is unambiguous.
    if (!body.query.includes("pullRequests")) {
      return response({
        data: { viewer: config.viewer === null ? null : { login: config.viewer ?? "octocat" } },
      });
    }
    if (config.repositoryNull) return response({ data: { repository: null } });
    const page = config.pages?.[pageIndex] ?? { nodes: [], hasNextPage: false, endCursor: null };
    pageIndex += 1;
    return response({
      data: {
        repository: {
          pullRequests: {
            totalCount: page.totalCount ?? page.nodes.length,
            pageInfo: { hasNextPage: page.hasNextPage ?? false, endCursor: page.endCursor ?? null },
            nodes: page.nodes,
          },
        },
      },
    });
  };
  return { http, calls: () => calls };
}

describe("parseForgeRepository", () => {
  it("accepts exactly owner/name", () => {
    expect(parseForgeRepository("acme/widget")).toEqual({ owner: "acme", name: "widget" });
  });
  it("rejects the common-dir absolute-path fallback (leading slash / extra segments)", () => {
    expect(parseForgeRepository("/Users/x/repo/.git")).toBeNull();
    expect(parseForgeRepository("/repo/.git")).toBeNull();
  });
  it("rejects a single segment, three segments, whitespace, and empties", () => {
    expect(parseForgeRepository("widget")).toBeNull();
    expect(parseForgeRepository("a/b/c")).toBeNull();
    expect(parseForgeRepository("acme /widget")).toBeNull();
    expect(parseForgeRepository("acme/")).toBeNull();
    expect(parseForgeRepository("/widget")).toBeNull();
  });
});

describe("createGitHubProjectPrSource — resolveViewer", () => {
  it("returns the login and memoizes (one network call for repeated reads)", async () => {
    const { http, calls } = makeHttp({ viewer: "octocat" });
    const source = createGitHubProjectPrSource({ http, token: "t" });
    expect(await source.resolveViewer()).toBe("octocat");
    expect(await source.resolveViewer()).toBe("octocat");
    expect(calls()).toBe(1);
  });
  it("returns null when GitHub has no viewer (token without a user)", async () => {
    const { http } = makeHttp({ viewer: null });
    const source = createGitHubProjectPrSource({ http, token: "t" });
    expect(await source.resolveViewer()).toBeNull();
  });
});

describe("createGitHubProjectPrSource — listOpenPullRequests", () => {
  it("maps a node to the protocol PullRequest with byte-exact repository identity", async () => {
    const { http } = makeHttp({ viewer: "octocat", pages: [{ nodes: [node()] }] });
    const source = createGitHubProjectPrSource({ http, token: "t" });
    const { prs, truncated } = await source.listOpenPullRequests("acme/widget");
    expect(truncated).toBe(false);
    expect(prs).toHaveLength(1);
    expect(prs[0]).toEqual({
      id: "PR_1",
      number: 12,
      title: "Add glass tokens",
      repository: "acme/widget", // byte-exact so the renderer folds a local worktree in
      branch: "feat/glass",
      author: "octocat",
      state: "open",
      reviewRequestedFromViewer: false,
      ci: "passing",
      additions: 40,
      deletions: 3,
      changedFiles: 5,
      lastActivityAt: "2026-08-10T00:00:00.000Z",
    });
    expect(() => pullRequestSchema.parse(prs[0])).not.toThrow();
  });

  it("maps every status-check rollup state (none when there are no checks)", async () => {
    const cases: [string | null, string][] = [
      ["SUCCESS", "passing"],
      ["FAILURE", "failing"],
      ["ERROR", "failing"],
      ["PENDING", "pending"],
      ["EXPECTED", "pending"],
    ];
    for (const [rollup, expected] of cases) {
      const { http } = makeHttp({
        viewer: "octocat",
        pages: [
          {
            nodes: [
              node({ commits: { nodes: [{ commit: { statusCheckRollup: { state: rollup } } }] } }),
            ],
          },
        ],
      });
      const source = createGitHubProjectPrSource({ http, token: "t" });
      const { prs } = await source.listOpenPullRequests("acme/widget");
      expect(prs[0]?.ci).toBe(expected);
    }
    // No checks configured → a null rollup → "none" (honestly unknown, not passing).
    const { http } = makeHttp({
      viewer: "octocat",
      pages: [{ nodes: [node({ commits: { nodes: [{ commit: { statusCheckRollup: null } }] } })] }],
    });
    const source = createGitHubProjectPrSource({ http, token: "t" });
    const { prs } = await source.listOpenPullRequests("acme/widget");
    expect(prs[0]?.ci).toBe("none");
  });

  it("flags review-requested only when the viewer is among the requested reviewers", async () => {
    const withViewer = node({
      reviewRequests: { nodes: [{ requestedReviewer: { __typename: "User", login: "octocat" } }] },
    });
    const withoutViewer = node({
      id: "PR_2",
      reviewRequests: {
        nodes: [{ requestedReviewer: { __typename: "User", login: "someone-else" } }],
      },
    });
    const { http } = makeHttp({
      viewer: "octocat",
      pages: [{ nodes: [withViewer, withoutViewer] }],
    });
    const source = createGitHubProjectPrSource({ http, token: "t" });
    const { prs } = await source.listOpenPullRequests("acme/widget");
    expect(prs.find((p) => p.id === "PR_1")?.reviewRequestedFromViewer).toBe(true);
    expect(prs.find((p) => p.id === "PR_2")?.reviewRequestedFromViewer).toBe(false);
  });

  it("falls back to 'ghost' for a deleted author and to #number for an empty title", async () => {
    const { http } = makeHttp({
      viewer: "octocat",
      pages: [{ nodes: [node({ author: null, title: "" })] }],
    });
    const source = createGitHubProjectPrSource({ http, token: "t" });
    const { prs } = await source.listOpenPullRequests("acme/widget");
    expect(prs[0]?.author).toBe("ghost");
    expect(prs[0]?.title).toBe("#12");
  });

  it("returns an empty, complete result for a non-forge identity — no network call", async () => {
    const { http, calls } = makeHttp({ viewer: "octocat" });
    const source = createGitHubProjectPrSource({ http, token: "t" });
    const result = await source.listOpenPullRequests("/Users/x/repo/.git");
    expect(result).toEqual({ prs: [], truncated: false });
    expect(calls()).toBe(0); // never even resolves the viewer for a local-only repo
  });

  it("paginates through pages and reports truncated when more remain past the cap", async () => {
    const { http } = makeHttp({
      viewer: "octocat",
      pages: [
        { nodes: [node({ id: "PR_A" })], hasNextPage: true, endCursor: "c1" },
        { nodes: [node({ id: "PR_B" })], hasNextPage: true, endCursor: "c2" }, // still more, but cap = 2
      ],
    });
    const source = createGitHubProjectPrSource({ http, token: "t", maxPages: 2 });
    const { prs, truncated } = await source.listOpenPullRequests("acme/widget");
    expect(prs.map((p) => p.id)).toEqual(["PR_A", "PR_B"]);
    expect(truncated).toBe(true); // hasNextPage was still true at the cap
  });

  it("is complete when the last page has no next page", async () => {
    const { http } = makeHttp({
      viewer: "octocat",
      pages: [
        { nodes: [node({ id: "PR_A" })], hasNextPage: true, endCursor: "c1" },
        { nodes: [node({ id: "PR_B" })], hasNextPage: false, endCursor: null },
      ],
    });
    const source = createGitHubProjectPrSource({ http, token: "t", maxPages: 5 });
    const { prs, truncated } = await source.listOpenPullRequests("acme/widget");
    expect(prs.map((p) => p.id)).toEqual(["PR_A", "PR_B"]);
    expect(truncated).toBe(false);
  });

  it("marks truncated when SSO returns partial-results even on a single page", async () => {
    const { http } = makeHttp({ viewer: "octocat" });
    // Override: the PR page carries an SSO partial-results header.
    const partialHttp: HttpFetch = async (url, init) => {
      const body = JSON.parse(init?.body ?? "{}") as { query: string };
      if (!body.query.includes("pullRequests"))
        return response({ data: { viewer: { login: "octocat" } } });
      return response(
        {
          data: {
            repository: {
              pullRequests: {
                totalCount: 1,
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [node()],
              },
            },
          },
        },
        { sso: "partial-results; organizations=acme; url=https://github.com/orgs/acme/sso" },
      );
    };
    void http;
    const source = createGitHubProjectPrSource({ http: partialHttp, token: "t" });
    const { truncated } = await source.listOpenPullRequests("acme/widget");
    expect(truncated).toBe(true);
  });

  it("returns empty (not a false-complete crash) when the repo is not found / no access", async () => {
    const { http } = makeHttp({ viewer: "octocat", repositoryNull: true });
    const source = createGitHubProjectPrSource({ http, token: "t" });
    const { prs, truncated } = await source.listOpenPullRequests("acme/widget");
    expect(prs).toEqual([]);
    expect(truncated).toBe(false);
  });

  it("THROWS on a non-2xx response (never renders a failed fetch as zero PRs)", async () => {
    const { http } = makeHttp({ viewer: "octocat", status: 500 });
    const source = createGitHubProjectPrSource({ http, token: "t" });
    await expect(source.listOpenPullRequests("acme/widget")).rejects.toThrow(/500/);
  });

  it("THROWS on a GraphQL error payload with no data", async () => {
    const { http } = makeHttp({ errors: [{ message: "Bad credentials" }] });
    const source = createGitHubProjectPrSource({ http, token: "t" });
    await expect(source.resolveViewer()).rejects.toThrow(/no data/);
  });

  it("sends the bearer token and targets the GraphQL endpoint", async () => {
    const http = vi.fn<HttpFetch>(async () => response({ data: { viewer: { login: "octocat" } } }));
    const source = createGitHubProjectPrSource({
      http,
      token: "secret-token",
      graphqlUrl: "https://gh.test/graphql",
    });
    await source.resolveViewer();
    expect(http).toHaveBeenCalledWith(
      "https://gh.test/graphql",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer secret-token" }),
      }),
    );
  });
});
