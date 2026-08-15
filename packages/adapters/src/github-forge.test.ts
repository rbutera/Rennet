import type { ForgePullRequestRef } from "@rennet/core";
import { describe, expect, it } from "vitest";
import type { HttpFetch } from "./github-auth";
import { GitHubForgeAdapter } from "./github-forge";

function response(
  status: number,
  headers: Record<string, string>,
  body: string,
): ReturnType<HttpFetch> extends Promise<infer R> ? R : never {
  const lower = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    status,
    headers: { get: (name: string) => lower.get(name.toLowerCase()) ?? null },
    text: () => Promise.resolve(body),
  };
}

const ref: ForgePullRequestRef = {
  repo: { forge: "github", owner: "acme", name: "widget" },
  number: 42,
};

const prBody = JSON.stringify({
  data: {
    repository: {
      pullRequest: {
        number: 42,
        title: "Add the thing",
        body: "Implements the thing.\n\nCloses #1.",
        isDraft: false,
        headRefOid: "aaaa1111",
        baseRefOid: "bbbb2222",
        baseRefName: "main",
        headRefName: "feature/thing",
        changedFiles: 3,
        id: "PR_kwabc",
      },
    },
  },
});

describe("GitHubForgeAdapter.fetchPullRequest", () => {
  it("deep-fetches a PR into Rennet nouns and derives clone URLs from identity", async () => {
    const http: HttpFetch = () => Promise.resolve(response(200, {}, prBody));
    const forge = new GitHubForgeAdapter({ http, token: "gho_x" });
    const pr = await forge.fetchPullRequest(ref);
    expect(pr.headOid).toBe("aaaa1111");
    expect(pr.baseOid).toBe("bbbb2222");
    expect(pr.baseRef).toBe("main");
    expect(pr.headRef).toBe("feature/thing");
    expect(pr.title).toBe("Add the thing");
    // The PR body is the stated intent (#136) — fetched, not just the title.
    expect(pr.body).toBe("Implements the thing.\n\nCloses #1.");
    expect(pr.forgeRef).toBe("PR_kwabc");
    expect(pr.sso).toEqual({ kind: "none" });
    // Clone URLs derived from owner/name identity (never a path guess) so the
    // worktree matcher can map them onto a local clone.
    expect(pr.cloneUrls).toContain("https://github.com/acme/widget.git");
    expect(pr.cloneUrls.some((url) => url.includes("git@github.com:acme/widget"))).toBe(true);
  });

  it("requests the body in the GraphQL document and maps a null body to an honest empty string", async () => {
    let sentQuery = "";
    const emptyBody = JSON.stringify({
      data: {
        repository: {
          pullRequest: {
            number: 42,
            title: "Add the thing",
            body: null,
            isDraft: false,
            headRefOid: "aaaa1111",
            baseRefOid: "bbbb2222",
            baseRefName: "main",
            headRefName: "feature/thing",
            changedFiles: 1,
            id: "PR_kwabc",
          },
        },
      },
    });
    const http: HttpFetch = (_url, init) => {
      sentQuery = JSON.parse(init?.body ?? "{}").query ?? "";
      return Promise.resolve(response(200, {}, emptyBody));
    };
    const pr = await new GitHubForgeAdapter({ http, token: "t" }).fetchPullRequest(ref);
    // GitHub returns `null` for a PR with no description; carry "" (an honest empty
    // body) so a consumer never confuses it with an unfetched surface.
    expect(pr.body).toBe("");
    // The document must actually request `body`, or the adapter only ever works
    // against a mock that happens to include it.
    expect(sentQuery).toContain("body");
  });

  it("parses X-GitHub-SSO on EVERY response and carries partial-results on the PR", async () => {
    const http: HttpFetch = () =>
      Promise.resolve(
        response(
          200,
          { "X-GitHub-SSO": "partial-results; organizations=ORG_7; url=https://github.com/sso" },
          prBody,
        ),
      );
    const forge = new GitHubForgeAdapter({ http, token: "gho_x" });
    const pr = await forge.fetchPullRequest(ref);
    expect(pr.sso.kind).toBe("partial-results");
  });

  it("sends the token as a Bearer credential AND the query+variables in the body", async () => {
    let seen: { url?: string; auth?: string; method?: string; body?: string } = {};
    const http: HttpFetch = (url, init) => {
      seen = {
        url,
        auth: init?.headers?.Authorization,
        method: init?.method,
        body: init?.body,
      };
      return Promise.resolve(response(200, {}, prBody));
    };
    await new GitHubForgeAdapter({ http, token: "gho_secret" }).fetchPullRequest(ref);
    expect(seen.method).toBe("POST");
    expect(seen.url).toContain("/graphql");
    expect(seen.auth).toBe("Bearer gho_secret");
    // The request body MUST carry the GraphQL document and the PR variables, or the
    // adapter only ever works against a mock — a real GitHub GraphQL POST with no
    // body returns an error and no PR ever opens (acceptance #1).
    expect(seen.body, "GraphQL request must send a body").toBeDefined();
    const payload = JSON.parse(seen.body ?? "{}") as { query?: string; variables?: unknown };
    expect(payload.query).toContain("pullRequest(number:$number)");
    expect(payload.variables).toEqual({ owner: "acme", name: "widget", number: 42 });
  });
});

describe("GitHubForgeAdapter.listOpenPullRequests — the SSO banner (acceptance #3)", () => {
  const node = {
    number: 42,
    title: "Add the thing",
    isDraft: false,
    updatedAt: "2026-08-07T10:00:00Z",
    headRefOid: "aaaa1111",
    id: "PR_kwabc",
    repository: { nameWithOwner: "acme/widget" },
  };
  // A consistent clean response: issueCount matches the returned node count.
  const listBody = JSON.stringify({ data: { search: { issueCount: 1, nodes: [node] } } });

  it("a partial-results response is INCOMPLETE (banner), never a bare empty/short list", async () => {
    const http: HttpFetch = () =>
      Promise.resolve(
        response(
          200,
          {
            "X-GitHub-SSO":
              "partial-results; organizations=ORG_7,ORG_8; url=https://github.com/sso",
          },
          listBody,
        ),
      );
    const list = await new GitHubForgeAdapter({ http, token: "t" }).listOpenPullRequests();
    // The list may still contain items, but it must be flagged incomplete so the
    // UI shows the SSO banner rather than trusting a truncated set.
    expect(list.complete).toBe(false);
    expect(list.sso.kind).toBe("partial-results");
    if (list.sso.kind !== "partial-results") throw new Error("unreachable");
    expect(list.sso.organizations).toEqual(["ORG_7", "ORG_8"]);
    expect(list.sso.authorizationUrl).toBe("https://github.com/sso");
  });

  it("a clean response is complete and maps items into Rennet nouns", async () => {
    const http: HttpFetch = () => Promise.resolve(response(200, {}, listBody));
    const list = await new GitHubForgeAdapter({ http, token: "t" }).listOpenPullRequests();
    expect(list.complete).toBe(true);
    expect(list.truncatedOver1000).toBe(false);
    expect(list.items).toHaveLength(1);
    expect(list.items[0]?.ref).toEqual({
      repo: { forge: "github", owner: "acme", name: "widget" },
      number: 42,
    });
  });

  it("a page returning fewer nodes than issueCount is INCOMPLETE (never complete)", async () => {
    // 60 involved PRs but the page (first: 50) returns fewer than issueCount: the
    // set is truncated by pagination, well under the 1000 ceiling. It must NOT
    // render as complete — the plan §2 invariant is "never render a truncated
    // list as complete", not "never render >1000 as complete".
    const paged = JSON.stringify({ data: { search: { issueCount: 60, nodes: [node] } } });
    const http: HttpFetch = () => Promise.resolve(response(200, {}, paged));
    const list = await new GitHubForgeAdapter({ http, token: "t" }).listOpenPullRequests();
    expect(list.complete).toBe(false);
    expect(list.truncatedOver1000).toBe(false);
  });

  it("issueCount over 1000 marks the set truncated and incomplete", async () => {
    const truncated = JSON.stringify({
      data: { search: { issueCount: 1500, nodes: [] } },
    });
    const http: HttpFetch = () => Promise.resolve(response(200, {}, truncated));
    const list = await new GitHubForgeAdapter({ http, token: "t" }).listOpenPullRequests();
    expect(list.truncatedOver1000).toBe(true);
    expect(list.complete).toBe(false);
  });
});

describe("GitHubForgeAdapter.fetchDiff — the REST fallback", () => {
  it("fetches the unified diff with the diff media type and parses SSO", async () => {
    let accept: string | undefined;
    const http: HttpFetch = (_url, init) => {
      accept = init?.headers?.Accept;
      return Promise.resolve(response(200, {}, "diff --git a/x b/x\n"));
    };
    const forge = new GitHubForgeAdapter({ http, token: "t" });
    const result = await forge.fetchDiff(ref);
    expect(accept).toBe("application/vnd.github.diff");
    expect(result.diff).toContain("diff --git");
    expect(result.sso).toEqual({ kind: "none" });
  });
});

describe("GitHubForgeAdapter.fetchCiStatus", () => {
  it("fetches the pinned head once and maps CheckRun plus legacy StatusContext nodes", async () => {
    let calls = 0;
    let request: { query?: string; variables?: unknown } = {};
    let capturedSignal: AbortSignal | undefined;
    const http: HttpFetch = (_url, init) => {
      calls += 1;
      capturedSignal = init?.signal;
      request = JSON.parse(init?.body ?? "{}") as typeof request;
      return Promise.resolve(
        response(
          200,
          {},
          JSON.stringify({
            data: {
              repository: {
                object: {
                  statusCheckRollup: {
                    contexts: {
                      pageInfo: { hasNextPage: false },
                      nodes: [
                        {
                          __typename: "CheckRun",
                          id: "CR_core",
                          name: "core:test",
                          status: "COMPLETED",
                          conclusion: "FAILURE",
                          title: "Tests failed",
                          summary: "pipeline.test.ts failed",
                          detailsUrl: "https://example.test/check/1",
                        },
                        {
                          __typename: "CheckRun",
                          id: "CR_build",
                          name: "build",
                          status: "IN_PROGRESS",
                          conclusion: null,
                          title: null,
                          summary: null,
                          detailsUrl: null,
                        },
                        {
                          __typename: "StatusContext",
                          context: "legacy/deploy",
                          state: "ERROR",
                          description: "deployment errored",
                          targetUrl: "https://example.test/status/1",
                        },
                        {
                          __typename: "StatusContext",
                          context: "legacy/queue",
                          state: "EXPECTED",
                          description: null,
                          targetUrl: null,
                        },
                      ],
                    },
                  },
                },
              },
            },
          }),
        ),
      );
    };

    const controller = new AbortController();
    const result = await new GitHubForgeAdapter({ http, token: "t" }).fetchCiStatus(
      ref,
      "deadbeef",
      controller.signal,
    );
    expect(calls).toBe(1);
    expect(request.query).toContain("statusCheckRollup");
    expect(request.query).toContain("... on CheckRun");
    expect(request.query).toContain("... on StatusContext");
    expect(request.query).toContain("pageInfo { hasNextPage }");
    expect(capturedSignal).toBe(controller.signal);
    expect(request.variables).toEqual({ owner: "acme", name: "widget", headOid: "deadbeef" });
    expect(result.checks).toEqual([
      {
        id: "CR_core",
        name: "core:test",
        outcome: "failing",
        summary: "pipeline.test.ts failed",
        detailsUrl: "https://example.test/check/1",
      },
      { id: "CR_build", name: "build", outcome: "pending", summary: "" },
      {
        id: "status-context:legacy/deploy\0https://example.test/status/1",
        name: "legacy/deploy",
        outcome: "failing",
        summary: "deployment errored",
        detailsUrl: "https://example.test/status/1",
      },
      {
        id: "status-context:legacy/queue\0",
        name: "legacy/queue",
        outcome: "pending",
        summary: "",
      },
    ]);
    expect(result.incomplete).toBe(false);
  });

  it.each([{ statusCheckRollup: null }, { statusCheckRollup: { contexts: { nodes: [] } } }])(
    "returns an honest empty check set for no checks",
    async (object) => {
      const http: HttpFetch = () =>
        Promise.resolve(response(200, {}, JSON.stringify({ data: { repository: { object } } })));
      await expect(
        new GitHubForgeAdapter({ http, token: "t" }).fetchCiStatus(ref, "deadbeef"),
      ).resolves.toEqual({ checks: [], sso: { kind: "none" }, incomplete: false });
    },
  );

  it("carries SSO partial-results so the caller can mark the signal incomplete", async () => {
    const http: HttpFetch = () =>
      Promise.resolve(
        response(
          200,
          { "X-GitHub-SSO": "partial-results; organizations=ORG_7; url=https://github.com/sso" },
          JSON.stringify({
            data: {
              repository: {
                object: { statusCheckRollup: { contexts: { nodes: [] } } },
              },
            },
          }),
        ),
      );
    const result = await new GitHubForgeAdapter({ http, token: "t" }).fetchCiStatus(
      ref,
      "deadbeef",
    );
    expect(result.sso).toEqual({
      kind: "partial-results",
      organizations: ["ORG_7"],
      authorizationUrl: "https://github.com/sso",
    });
    expect(result.incomplete).toBe(true);
  });

  it.each([
    {
      label: "a first-100 page with a hidden tail",
      body: {
        data: {
          repository: {
            object: {
              statusCheckRollup: {
                contexts: { nodes: [], pageInfo: { hasNextPage: true } },
              },
            },
          },
        },
      },
    },
    {
      label: "partial GraphQL data with errors",
      body: {
        data: {
          repository: {
            object: {
              statusCheckRollup: {
                contexts: { nodes: [], pageInfo: { hasNextPage: false } },
              },
            },
          },
        },
        errors: [{ message: "one context was not readable" }],
      },
    },
  ])("marks $label incomplete instead of treating it as a complete check set", async ({ body }) => {
    const http: HttpFetch = () => Promise.resolve(response(200, {}, JSON.stringify(body)));
    const result = await new GitHubForgeAdapter({ http, token: "t" }).fetchCiStatus(
      ref,
      "deadbeef",
    );
    expect(result.incomplete).toBe(true);
  });
});

describe("GitHubForgeAdapter.capabilities", () => {
  it("advertises GitHub's forge capabilities", () => {
    const forge = new GitHubForgeAdapter({
      http: () => Promise.reject(new Error("unused")),
      token: "t",
    });
    expect(forge.capabilities).toEqual({
      supportsThreadResolution: true,
      supportsBatchedReview: true,
      supportsMultiLineAnchors: true,
      supportsFileLevelThreads: true,
    });
  });
});
