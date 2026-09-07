import { pullRequestSchema } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import { createGitHubOctokit } from "./github-octokit";
import { createGitHubProjectPrSource, parseForgeRepository } from "./project-pr-source";

const GITHUB_REPOSITORY = { forge: "github", owner: "acme", name: "widget" } as const;

/** A canned JSON response with optional headers (defaults to a clean 200). */
function response(body: unknown, init?: { status?: number; sso?: string }): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: {
      "content-type": "application/json",
      ...(init?.sso ? { "X-GitHub-SSO": init.sso } : {}),
    },
  });
}

/** A GraphQL PR node with sensible defaults; override per case. */
function node(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "PR_1",
    number: 12,
    title: "Add glass tokens",
    state: "OPEN",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-10T00:00:00.000Z",
    additions: 40,
    deletions: 3,
    changedFiles: 5,
    headRefName: "feat/glass",
    author: { login: "octocat", avatarUrl: "https://avatars.example/octocat.png" },
    reviewRequests: { nodes: [] },
    commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] },
    ...overrides,
  };
}

/** Build a fetch that answers the viewer query and a scripted sequence of PR pages. */
function makeFetch(config: {
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
}): { fetch: typeof globalThis.fetch; calls: () => number } {
  let pageIndex = 0;
  let calls = 0;
  const fetch: typeof globalThis.fetch = async (_input, init) => {
    calls += 1;
    const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as { query: string };
    if (config.status && config.status !== 200) return response({}, { status: config.status });
    if (config.errors) return response({ errors: config.errors });
    // Match the PR query FIRST: OPEN_PRS_QUERY contains "requestedReviewer", so a bare
    // `includes("viewer")` would misroute it. "pullRequests" is unambiguous.
    if (!body.query.includes("pullRequests")) {
      return response({
        data: {
          viewer:
            config.viewer === null
              ? null
              : {
                  login: config.viewer ?? "octocat",
                  avatarUrl: "https://avatars.example/viewer.png",
                },
        },
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
  return { fetch, calls: () => calls };
}

function sourceFor(fetch: typeof globalThis.fetch, maxPages?: number) {
  const octokit = createGitHubOctokit({ fetch, token: "t" });
  return createGitHubProjectPrSource({
    octokit,
    ...(maxPages === undefined ? {} : { maxPages }),
  });
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
  it("returns the login and avatar and memoizes (one network call for repeated reads)", async () => {
    const { fetch, calls } = makeFetch({ viewer: "octocat" });
    const source = sourceFor(fetch);
    const viewer = { login: "octocat", avatarUrl: "https://avatars.example/viewer.png" };
    expect(await source.resolveViewer()).toEqual(viewer);
    expect(await source.resolveViewer()).toEqual(viewer);
    expect(calls()).toBe(1);
  });
  it("returns null when GitHub has no viewer (token without a user)", async () => {
    const { fetch } = makeFetch({ viewer: null });
    const source = sourceFor(fetch);
    expect(await source.resolveViewer()).toBeNull();
  });
});

describe("createGitHubProjectPrSource — listPullRequests", () => {
  it("maps a node to the protocol PullRequest with byte-exact repository identity", async () => {
    const { fetch } = makeFetch({ viewer: "octocat", pages: [{ nodes: [node()] }] });
    const source = sourceFor(fetch);
    const { prs, truncated } = await source.listPullRequests(GITHUB_REPOSITORY);
    expect(truncated).toBe(false);
    expect(prs).toHaveLength(1);
    expect(prs[0]).toEqual({
      id: "PR_1",
      number: 12,
      title: "Add glass tokens",
      repository: "acme/widget", // byte-exact so the renderer folds a local worktree in
      forgeRepository: GITHUB_REPOSITORY,
      branch: "feat/glass",
      author: "octocat",
      authorAvatarUrl: "https://avatars.example/octocat.png",
      viewerDidAuthor: true,
      state: "open",
      reviewRequestedFromViewer: false,
      ci: "passing",
      additions: 40,
      deletions: 3,
      changedFiles: 5,
      createdAt: "2026-08-01T00:00:00.000Z",
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
      const { fetch } = makeFetch({
        viewer: "octocat",
        pages: [
          {
            nodes: [
              node({ commits: { nodes: [{ commit: { statusCheckRollup: { state: rollup } } }] } }),
            ],
          },
        ],
      });
      const { prs } = await sourceFor(fetch).listPullRequests(GITHUB_REPOSITORY);
      expect(prs[0]?.ci).toBe(expected);
    }
    // No checks configured → a null rollup → "none" (honestly unknown, not passing).
    const { fetch } = makeFetch({
      viewer: "octocat",
      pages: [{ nodes: [node({ commits: { nodes: [{ commit: { statusCheckRollup: null } }] } })] }],
    });
    const { prs } = await sourceFor(fetch).listPullRequests(GITHUB_REPOSITORY);
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
    const { fetch } = makeFetch({
      viewer: "octocat",
      pages: [{ nodes: [withViewer, withoutViewer] }],
    });
    const { prs } = await sourceFor(fetch).listPullRequests(GITHUB_REPOSITORY);
    expect(prs.find((p) => p.id === "PR_1")?.reviewRequestedFromViewer).toBe(true);
    expect(prs.find((p) => p.id === "PR_2")?.reviewRequestedFromViewer).toBe(false);
  });

  it("falls back to 'ghost' for a deleted author and to #number for an empty title", async () => {
    const { fetch } = makeFetch({
      viewer: "octocat",
      pages: [{ nodes: [node({ author: null, title: "" })] }],
    });
    const { prs } = await sourceFor(fetch).listPullRequests(GITHUB_REPOSITORY);
    expect(prs[0]?.author).toBe("ghost");
    expect(prs[0]).not.toHaveProperty("authorAvatarUrl"); // a ghost has no face to show
    expect(prs[0]?.title).toBe("#12");
  });

  it("rejects a non-GitHub identity before making a network call", async () => {
    const { fetch, calls } = makeFetch({ viewer: "octocat" });
    await expect(
      sourceFor(fetch).listPullRequests({ forge: "gitlab", owner: "acme", name: "widget" }),
    ).rejects.toThrow(/cannot list gitlab/);
    expect(calls()).toBe(0);
  });

  it("paginates through pages and reports truncated when more remain past the cap", async () => {
    const { fetch } = makeFetch({
      viewer: "octocat",
      pages: [
        { nodes: [node({ id: "PR_A" })], hasNextPage: true, endCursor: "c1" },
        { nodes: [node({ id: "PR_B" })], hasNextPage: true, endCursor: "c2" }, // still more, but cap = 2
      ],
    });
    const { prs, truncated } = await sourceFor(fetch, 2).listPullRequests(GITHUB_REPOSITORY);
    expect(prs.map((p) => p.id)).toEqual(["PR_A", "PR_B"]);
    expect(truncated).toBe(true); // hasNextPage was still true at the cap
  });

  it("is complete when the last page has no next page", async () => {
    const { fetch } = makeFetch({
      viewer: "octocat",
      pages: [
        { nodes: [node({ id: "PR_A" })], hasNextPage: true, endCursor: "c1" },
        { nodes: [node({ id: "PR_B" })], hasNextPage: false, endCursor: null },
      ],
    });
    const { prs, truncated } = await sourceFor(fetch, 5).listPullRequests(GITHUB_REPOSITORY);
    expect(prs.map((p) => p.id)).toEqual(["PR_A", "PR_B"]);
    expect(truncated).toBe(false);
  });

  it("marks truncated when SSO returns partial-results even on a single page", async () => {
    const partialFetch: typeof globalThis.fetch = async (_input, init) => {
      const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
        query: string;
      };
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
    const { truncated } = await sourceFor(partialFetch).listPullRequests(GITHUB_REPOSITORY);
    expect(truncated).toBe(true);
  });

  it("requests OPEN by default and the uppercased GraphQL states when history is asked for", async () => {
    const seenStates: unknown[] = [];
    const fetch: typeof globalThis.fetch = async (_input, init) => {
      const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
        query: string;
        variables?: { states?: unknown };
      };
      if (!body.query.includes("pullRequests")) {
        return response({ data: { viewer: { login: "octocat" } } });
      }
      seenStates.push(body.variables?.states);
      return response({
        data: {
          repository: {
            pullRequests: {
              totalCount: 1,
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [node({ state: "MERGED" })],
            },
          },
        },
      });
    };
    const source = sourceFor(fetch);
    await source.listPullRequests(GITHUB_REPOSITORY);
    const { prs } = await source.listPullRequests(GITHUB_REPOSITORY, ["merged", "closed"]);
    expect(seenStates).toEqual([["OPEN"], ["MERGED", "CLOSED"]]);
    // The mapped state round-trips so the renderer's read-only (retrospective) fold fires.
    expect(prs[0]?.state).toBe("merged");
  });

  it("returns empty (not a false-complete crash) when the repo is not found / no access", async () => {
    const { fetch } = makeFetch({ viewer: "octocat", repositoryNull: true });
    const { prs, truncated } = await sourceFor(fetch).listPullRequests(GITHUB_REPOSITORY);
    expect(prs).toEqual([]);
    expect(truncated).toBe(false);
  });

  it("THROWS on a non-2xx response (never renders a failed fetch as zero PRs)", async () => {
    const { fetch } = makeFetch({ viewer: "octocat", status: 500 });
    const error = await sourceFor(fetch)
      .listPullRequests(GITHUB_REPOSITORY)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as { status?: number }).status).toBe(500);
  });

  it("THROWS on a GraphQL error payload with no data", async () => {
    const { fetch } = makeFetch({ errors: [{ message: "Bad credentials" }] });
    await expect(sourceFor(fetch).resolveViewer()).rejects.toThrow(/no data/);
  });

  it("sends the token credential and targets the GraphQL endpoint", async () => {
    let seen: { url?: string; auth?: string | null } = {};
    const fetch: typeof globalThis.fetch = async (input, init) => {
      seen = { url: String(input), auth: new Headers(init?.headers).get("authorization") };
      return response({ data: { viewer: { login: "octocat" } } });
    };
    const octokit = createGitHubOctokit({ fetch, token: "secret-token" });
    await createGitHubProjectPrSource({ octokit }).resolveViewer();
    expect(seen.url).toContain("/graphql");
    expect(seen.auth).toBe("token secret-token");
  });
});
