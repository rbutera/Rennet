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
    expect(pr.forgeRef).toBe("PR_kwabc");
    expect(pr.sso).toEqual({ kind: "none" });
    // Clone URLs derived from owner/name identity (never a path guess) so the
    // worktree matcher can map them onto a local clone.
    expect(pr.cloneUrls).toContain("https://github.com/acme/widget.git");
    expect(pr.cloneUrls.some((url) => url.includes("git@github.com:acme/widget"))).toBe(true);
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

  it("sends the token as a Bearer credential to the GraphQL endpoint", async () => {
    let seen: { url?: string; auth?: string; method?: string } = {};
    const http: HttpFetch = (url, init) => {
      seen = { url, auth: init?.headers?.Authorization, method: init?.method };
      return Promise.resolve(response(200, {}, prBody));
    };
    await new GitHubForgeAdapter({ http, token: "gho_secret" }).fetchPullRequest(ref);
    expect(seen.method).toBe("POST");
    expect(seen.url).toContain("/graphql");
    expect(seen.auth).toBe("Bearer gho_secret");
  });
});

describe("GitHubForgeAdapter.listOpenPullRequests — the SSO banner (acceptance #3)", () => {
  const listBody = JSON.stringify({
    data: {
      search: {
        issueCount: 2,
        nodes: [
          {
            number: 42,
            title: "Add the thing",
            isDraft: false,
            updatedAt: "2026-08-07T10:00:00Z",
            headRefOid: "aaaa1111",
            id: "PR_kwabc",
            repository: { nameWithOwner: "acme/widget" },
          },
        ],
      },
    },
  });

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
