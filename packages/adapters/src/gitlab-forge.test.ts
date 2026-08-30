import {
  buildForgeReviewPost,
  canonicalReviewPayload,
  type ForgePullRequestRef,
  type ForgeReviewTarget,
} from "@rennet/core";
import { describe, expect, it, vi } from "vitest";
import type { ForgeDetectionDeps } from "./forge-discovery";
import {
  GitLabForgeAdapter,
  type GitLabForgeCommandResult,
  type GitLabForgeCommandRunner,
} from "./gitlab-forge";

const GLAB = "/opt/homebrew/bin/glab";
const REPOSITORY = { forge: "gitlab", owner: "acme/platform", name: "widget" } as const;
const REF: ForgePullRequestRef = { repo: REPOSITORY, number: 42 };
const TARGET: ForgeReviewTarget = { ref: REF, forgeRef: "9001", headOid: "head42" };

function detection(present = true): ForgeDetectionDeps {
  return {
    loginShellPath: async () => "/opt/homebrew/bin",
    envPath: "",
    home: "/Users/rai",
    listDir: async (directory) => (present && directory === "/opt/homebrew/bin" ? ["glab"] : []),
    isExecutable: async (path) => path === GLAB,
    probeVersion: async (path) => (path === GLAB ? "1.80.0" : null),
    probeAuth: async () => ({ kind: "authenticated" }),
    platform: "darwin",
  };
}

function mr(overrides: Record<string, unknown> = {}) {
  return {
    id: 9001,
    iid: 42,
    title: "Make the forge seam real",
    description: "Shared operations",
    draft: false,
    state: "opened",
    sha: "head42",
    diff_refs: { base_sha: "base42", head_sha: "head42" },
    target_branch: "main",
    source_branch: "feat/forge",
    changes_count: "7",
    updated_at: "2026-08-30T12:00:00Z",
    author: { username: "rai" },
    reviewers: [{ username: "reviewer" }],
    head_pipeline: { status: "success" },
    web_url: "https://gitlab.com/acme/platform/widget/-/merge_requests/42",
    ...overrides,
  };
}

function scripted(responses: readonly (GitLabForgeCommandResult | Error)[], present = true) {
  let index = 0;
  const calls: Parameters<GitLabForgeCommandRunner>[0][] = [];
  const run: GitLabForgeCommandRunner = async (command) => {
    calls.push(command);
    const response = responses[index++];
    if (response === undefined) throw new Error(`missing response ${index}`);
    if (response instanceof Error) throw response;
    return response;
  };
  return {
    adapter: new GitLabForgeAdapter({
      detectionDeps: detection(present),
      locus: { kind: "host" },
      repositoryRoot: "/code/widget",
      run,
    }),
    calls,
  };
}

const ok = (value: unknown): GitLabForgeCommandResult => ({
  exitCode: 0,
  stdout: typeof value === "string" ? value : JSON.stringify(value),
});

describe("GitLabForgeAdapter", () => {
  it("lists merge requests with nested project identity and omits unavailable line totals", async () => {
    const { adapter, calls } = scripted([ok({ username: "reviewer" }), ok(mr())]);

    const result = await adapter.listPullRequests(REPOSITORY);

    expect(result).toEqual({
      prs: [
        expect.objectContaining({
          number: 42,
          forgeRepository: REPOSITORY,
          reviewRequestedFromViewer: true,
          viewerDidAuthor: false,
          ci: "passing",
          changedFiles: 7,
        }),
      ],
      truncated: false,
    });
    expect(result.prs[0]).not.toHaveProperty("additions");
    expect(result.prs[0]).not.toHaveProperty("deletions");
    expect(calls[1]?.args.join(" ")).toContain("projects/acme%2Fplatform%2Fwidget/merge_requests");
  });

  it("deep-fetches pinned OIDs, raw diff, and exact commit statuses through glab", async () => {
    const { adapter, calls } = scripted([
      ok(mr()),
      ok({ username: "rai" }),
      ok("diff --git a/a.ts b/a.ts\n"),
      ok([{ id: 1, name: "test", status: "failed", description: "1 failed" }]),
    ]);

    await expect(adapter.fetchPullRequest(REF)).resolves.toMatchObject({
      headOid: "head42",
      baseOid: "base42",
      viewerDidAuthor: true,
      forgeRef: "9001",
    });
    await expect(adapter.fetchDiff(REF)).resolves.toMatchObject({
      diff: expect.stringContaining("a.ts"),
    });
    await expect(adapter.fetchCiStatus(REF, "head42")).resolves.toMatchObject({
      checks: [expect.objectContaining({ name: "test", outcome: "failing" })],
      incomplete: false,
    });
    expect(calls.map((call) => call.file)).toEqual([GLAB, GLAB, GLAB, GLAB]);
    expect(calls[2]?.args).toContain(
      "projects/acme%2Fplatform%2Fwidget/merge_requests/42/raw_diffs",
    );
  });

  it("folds threads into a marker-bearing note and reconciles a retry before posting", async () => {
    const artifact = {
      opener: "This is ready for review.",
      comments: [
        {
          path: "src/a.ts",
          line: 4,
          side: "RIGHT" as const,
          type: "request-change" as const,
          body: "rename",
        },
      ],
      bodyNotes: [],
    };
    const post = buildForgeReviewPost(artifact, {
      reviewId: "review-42",
      target: TARGET,
      payload: canonicalReviewPayload(artifact),
      capabilities: new GitLabForgeAdapter({
        detectionDeps: detection(),
        locus: { kind: "host" },
        repositoryRoot: "/code/widget",
        run: vi.fn(),
      }).capabilities,
    });
    const existing = {
      id: 77,
      body: `landed\n\n<!-- rennet:review:${post.marker} -->`,
      web_url: null,
    };
    const { adapter, calls } = scripted([ok(existing)]);

    expect(post.threads).toEqual([]);
    expect(post.body).toContain("`src/a.ts:4`");
    expect(adapter.buildReviewRequest(post).requests[0]).toMatchObject({
      endpoint: "projects/acme%2Fplatform%2Fwidget/merge_requests/42/notes",
      method: "POST",
      body: { body: expect.stringContaining("Changes requested") },
    });
    await expect(adapter.publishReview(post)).resolves.toEqual({
      reviewRef: "77",
      url: null,
      reused: true,
    });
    expect(calls).toHaveLength(1);
    expect(JSON.stringify(adapter.buildReviewRequest(post))).not.toMatch(
      /authorization|bearer|token/i,
    );
  });

  it("previews and sends a marker note before a head-pinned approval, then reconciles retries", async () => {
    const artifact = { opener: "The reviewed head is ready.", comments: [], bodyNotes: [] };
    const post = buildForgeReviewPost(artifact, {
      reviewId: "review-42",
      target: TARGET,
      payload: canonicalReviewPayload(artifact),
      verdict: "APPROVE",
      capabilities: new GitLabForgeAdapter({
        detectionDeps: detection(),
        locus: { kind: "host" },
        repositoryRoot: "/code/widget",
        run: vi.fn(),
      }).capabilities,
    });
    expect(post.event).toBe("APPROVE");

    const { adapter, calls } = scripted([
      ok(""),
      ok({ id: 88, body: post.body, web_url: null }),
      ok({ approved: true }),
    ]);
    const request = adapter.buildReviewRequest(post);
    expect(request.requests).toEqual([
      expect.objectContaining({
        endpoint: "projects/acme%2Fplatform%2Fwidget/merge_requests/42/notes",
        body: { body: expect.stringContaining(post.marker) },
      }),
      {
        endpoint: "projects/acme%2Fplatform%2Fwidget/merge_requests/42/approve",
        method: "POST",
        body: { sha: "head42" },
      },
    ]);

    await expect(adapter.publishReview(post)).resolves.toEqual({
      reviewRef: "88",
      url: null,
      reused: false,
    });
    expect(calls.map((call) => call.args[1])).toEqual([
      expect.stringContaining("/notes?"),
      expect.stringContaining("/notes"),
      expect.stringContaining("/approve"),
    ]);
    expect(calls[2]?.stdin).toBe(JSON.stringify({ sha: "head42" }));

    const existing = {
      id: 88,
      body: `landed\n\n<!-- rennet:review:${post.marker} -->`,
      web_url: null,
    };
    const retry = scripted([ok(existing), ok({ approved: true })]);
    await expect(retry.adapter.publishReview(post)).resolves.toMatchObject({
      reviewRef: "88",
      reused: true,
    });
    expect(retry.calls).toHaveLength(2);
    expect(retry.calls[1]?.args).toContain(
      "projects/acme%2Fplatform%2Fwidget/merge_requests/42/approve",
    );
    expect(retry.calls[1]?.stdin).toBe(JSON.stringify({ sha: "head42" }));
  });

  it("fails honestly before execution when glab is absent", async () => {
    const { adapter, calls } = scripted([], false);

    await expect(adapter.fetchDiff(REF)).rejects.toThrow("Install `glab`");
    expect(calls).toEqual([]);
  });
});
