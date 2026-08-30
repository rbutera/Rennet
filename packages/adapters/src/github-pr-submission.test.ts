import type { ForgePrSubmission, ForgePrSubmissionTarget } from "@rennet/core";
import { describe, expect, it } from "vitest";
import { createGitHubOctokit } from "./github-octokit";
import { GitHubPrSubmissionAdapter } from "./github-pr-submission";

const TARGET: ForgePrSubmissionTarget = {
  repo: { forge: "github", owner: "acme", name: "widget" },
};

const SUBMISSION: ForgePrSubmission = {
  title: "Reviewed change",
  body: "## Requested changes\n- fix it",
  base: "main",
  head: "feat/reviewed",
  draft: true,
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

interface RecordedCall {
  url: string;
  method: string;
  body?: unknown;
}

/** A recording adapter that answers each request from a scripted queue of responses. */
function adapter(responses: Response[]) {
  const calls: RecordedCall[] = [];
  let index = 0;
  let resolutions = 0;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    const next = responses[index];
    index += 1;
    if (!next) throw new Error(`no scripted response for call ${index}`);
    return next;
  };
  const octokit = createGitHubOctokit({ fetch, token: "tok" });
  return {
    port: new GitHubPrSubmissionAdapter({
      resolveOctokit: () => {
        resolutions += 1;
        return Promise.resolve(octokit);
      },
    }),
    calls,
    resolutionCount: () => resolutions,
  };
}

describe("GitHubPrSubmissionAdapter (issue #257 / #107)", () => {
  it("creates the PR when none is open, and carries a BRANCH ref as head (not a SHA)", async () => {
    const { port, calls, resolutionCount } = adapter([
      json(200, []), // no open PR from this head
      json(201, { html_url: "https://github.com/acme/widget/pull/12", number: 12 }),
    ]);
    const outcome = await port.submitPullRequest({ target: TARGET, submission: SUBMISSION });
    expect(outcome).toEqual({
      url: "https://github.com/acme/widget/pull/12",
      number: 12,
      reused: false,
    });
    // The lookup filters by `owner:head` against the base.
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url).toContain("head=acme%3Afeat%2Freviewed");
    expect(calls[0]?.url).toContain("base=main");
    // The create POSTs a branch ref as head, verbatim — never a commit SHA.
    expect(calls[1]?.method).toBe("POST");
    expect(calls[1]?.url).toBe("https://api.github.com/repos/acme/widget/pulls");
    expect(calls[1]?.body).toEqual({
      title: "Reviewed change",
      body: "## Requested changes\n- fix it",
      head: "feat/reviewed",
      base: "main",
      draft: true,
    });
    expect(resolutionCount()).toBe(1);
  });

  it("reuses an already-open PR from the same head (idempotent — never a second create)", async () => {
    const { port, calls } = adapter([
      json(200, [{ html_url: "https://github.com/acme/widget/pull/9", number: 9 }]),
    ]);
    const outcome = await port.submitPullRequest({ target: TARGET, submission: SUBMISSION });
    expect(outcome).toEqual({
      url: "https://github.com/acme/widget/pull/9",
      number: 9,
      reused: true,
    });
    // Only the lookup ran — no create was attempted.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("GET");
  });

  it("resolves a 422 race (a PR appeared between lookup and create) to the existing PR", async () => {
    const { port, resolutionCount } = adapter([
      json(200, []), // lookup: none yet
      json(422, { message: "A pull request already exists for acme:feat/reviewed." }),
      json(200, [{ html_url: "https://github.com/acme/widget/pull/15", number: 15 }]), // re-lookup
    ]);
    const outcome = await port.submitPullRequest({ target: TARGET, submission: SUBMISSION });
    expect(outcome).toEqual({
      url: "https://github.com/acme/widget/pull/15",
      number: 15,
      reused: true,
    });
    expect(resolutionCount()).toBe(1);
  });

  it("surfaces a create failure honestly (never a fabricated success)", async () => {
    const { port } = adapter([json(200, []), json(403, { message: "Resource not accessible" })]);
    await expect(
      port.submitPullRequest({ target: TARGET, submission: SUBMISSION }),
    ).rejects.toThrow(/Resource not accessible|403/);
  });
});
