import type { ForgePrSubmission, ForgePrSubmissionTarget } from "@rennet/core";
import { describe, expect, it } from "vitest";
import type { HttpFetch, HttpResponse } from "./github-auth";
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

function response(status: number, body: unknown): HttpResponse {
  return {
    status,
    headers: { get: () => null },
    text: () => Promise.resolve(JSON.stringify(body)),
  };
}

interface RecordedCall {
  url: string;
  method: string;
  body?: unknown;
}

/** A recording HttpFetch that answers each call from a scripted queue of responses. */
function scriptedHttp(responses: HttpResponse[]): {
  http: HttpFetch;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  let index = 0;
  const http: HttpFetch = async (url, init) => {
    calls.push({
      url,
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(init.body) : undefined,
    });
    const next = responses[index];
    index += 1;
    if (!next) throw new Error(`no scripted response for call ${index}`);
    return next;
  };
  return { http, calls };
}

function adapter(responses: HttpResponse[]) {
  const { http, calls } = scriptedHttp(responses);
  return {
    port: new GitHubPrSubmissionAdapter({ http, resolveToken: async () => "tok" }),
    calls,
  };
}

describe("GitHubPrSubmissionAdapter (issue #257 / #107)", () => {
  it("creates the PR when none is open, and carries a BRANCH ref as head (not a SHA)", async () => {
    const { port, calls } = adapter([
      response(200, []), // no open PR from this head
      response(201, { html_url: "https://github.com/acme/widget/pull/12", number: 12 }),
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
  });

  it("reuses an already-open PR from the same head (idempotent — never a second create)", async () => {
    const { port, calls } = adapter([
      response(200, [{ html_url: "https://github.com/acme/widget/pull/9", number: 9 }]),
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
    const { port } = adapter([
      response(200, []), // lookup: none yet
      response(422, { message: "A pull request already exists for acme:feat/reviewed." }),
      response(200, [{ html_url: "https://github.com/acme/widget/pull/15", number: 15 }]), // re-lookup
    ]);
    const outcome = await port.submitPullRequest({ target: TARGET, submission: SUBMISSION });
    expect(outcome).toEqual({
      url: "https://github.com/acme/widget/pull/15",
      number: 15,
      reused: true,
    });
  });

  it("surfaces a create failure honestly (never a fabricated success)", async () => {
    const { port } = adapter([
      response(200, []),
      response(403, { message: "Resource not accessible" }),
    ]);
    await expect(
      port.submitPullRequest({ target: TARGET, submission: SUBMISSION }),
    ).rejects.toThrow(/HTTP 403/);
  });
});
