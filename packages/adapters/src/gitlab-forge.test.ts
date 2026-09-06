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
    created_at: "2026-08-28T09:00:00Z",
    updated_at: "2026-08-30T12:00:00Z",
    author: { username: "rai", avatar_url: "https://gitlab.example/uploads/rai.png" },
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
          authorAvatarUrl: "https://gitlab.example/uploads/rai.png",
          ci: "passing",
          changedFiles: 7,
          createdAt: "2026-08-28T09:00:00Z",
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

  it("sends the exact previewed body in the marker note and reconciles a retry", async () => {
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
    expect(post.body).toMatch(/^\*\*Rennet review verdict: Changes requested\*\*/);
    expect(post.body).toContain("`src/a.ts:4`");
    expect(adapter.buildReviewRequest(post).requests[0]).toEqual({
      endpoint: "projects/acme%2Fplatform%2Fwidget/merge_requests/42/notes",
      method: "POST",
      body: { body: post.body },
    });
    await expect(adapter.publishReview(post)).resolves.toEqual({
      reviewRef: "77",
      url: "https://gitlab.com/acme/platform/widget/-/merge_requests/42#note_77",
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
      ok(mr()),
      ok({ id: 88, body: post.body, web_url: null }),
      ok({ approved: true }),
    ]);
    const request = adapter.buildReviewRequest(post);
    expect(request.requests).toEqual([
      {
        endpoint: "projects/acme%2Fplatform%2Fwidget/merge_requests/42/notes",
        method: "POST",
        body: { body: post.body },
      },
      {
        endpoint: "projects/acme%2Fplatform%2Fwidget/merge_requests/42/approve",
        method: "POST",
        body: { sha: "head42" },
      },
    ]);

    await expect(adapter.publishReview(post)).resolves.toEqual({
      reviewRef: "88",
      url: "https://gitlab.com/acme/platform/widget/-/merge_requests/42#note_88",
      reused: false,
    });
    expect(calls.map((call) => call.args[1])).toEqual([
      expect.stringContaining("/notes?"),
      expect.stringContaining("/merge_requests/42"),
      expect.stringContaining("/notes"),
      expect.stringContaining("/approve"),
    ]);
    expect(calls[2]?.stdin).toBe(JSON.stringify({ body: post.body }));
    expect(calls[3]?.stdin).toBe(JSON.stringify({ sha: "head42" }));

    const existing = {
      id: 88,
      body: `landed\n\n<!-- rennet:review:${post.marker} -->`,
      web_url: null,
    };
    const retry = scripted([
      ok(existing),
      ok({ username: "rai" }),
      ok({ approved_by: [{ user: { username: "rai" } }] }),
    ]);
    await expect(retry.adapter.publishReview(post)).resolves.toMatchObject({
      reviewRef: "88",
      reused: true,
    });
    expect(retry.calls.map((call) => call.args[1])).toEqual([
      expect.stringContaining("/notes?"),
      "user",
      expect.stringContaining("/approvals"),
    ]);
    expect(retry.calls.some((call) => call.args[1]?.endsWith("/approve"))).toBe(false);
  });

  it("does not repeat an approval after its response is lost and the marker note reconciles", async () => {
    const artifact = { opener: "The reviewed head is ready.", comments: [], bodyNotes: [] };
    let approvalMutations = 0;
    let approvalStateReads = 0;
    let noteMutations = 0;
    let viewerApproved = false;
    const notes: { id: number; body: string }[] = [];
    const run: GitLabForgeCommandRunner = async (command) => {
      const endpoint = command.args[1] ?? "";
      if (endpoint.includes("/notes?")) {
        return ok(notes.map((note) => JSON.stringify(note)).join("\n"));
      }
      if (endpoint === "user") return ok({ username: "rai" });
      if (endpoint.endsWith("/approvals")) {
        approvalStateReads += 1;
        return ok({
          approved_by: viewerApproved ? [{ user: { username: "rai" } }] : [],
        });
      }
      if (endpoint.endsWith("/merge_requests/42")) return ok(mr());
      if (endpoint.endsWith("/merge_requests/42/notes")) {
        noteMutations += 1;
        const parsed: unknown = JSON.parse(command.stdin ?? "{}");
        if (
          typeof parsed !== "object" ||
          parsed === null ||
          !("body" in parsed) ||
          typeof parsed.body !== "string"
        ) {
          throw new Error("GitLab note body is missing");
        }
        const body = parsed.body;
        notes.push({ id: 88, body });
        return ok({ id: 88, body, web_url: null });
      }
      if (endpoint.endsWith("/merge_requests/42/approve")) {
        approvalMutations += 1;
        viewerApproved = true;
        if (approvalMutations === 1) {
          throw new Error("socket closed after GitLab accepted the approval");
        }
        return ok({ approved: true });
      }
      throw new Error(`unexpected command: ${command.args.join(" ")}`);
    };
    const adapter = new GitLabForgeAdapter({
      detectionDeps: detection(),
      locus: { kind: "host" },
      repositoryRoot: "/code/widget",
      run,
    });
    const post = buildForgeReviewPost(artifact, {
      reviewId: "review-42",
      target: TARGET,
      payload: canonicalReviewPayload(artifact),
      verdict: "APPROVE",
      capabilities: adapter.capabilities,
    });

    await expect(adapter.publishReview(post)).rejects.toThrow(/unreachable/i);
    await expect(adapter.publishReview(post)).resolves.toEqual({
      reviewRef: "88",
      url: "https://gitlab.com/acme/platform/widget/-/merge_requests/42#note_88",
      reused: true,
    });
    expect(noteMutations).toBe(1);
    expect(approvalMutations).toBe(1);
    expect(approvalStateReads).toBe(1);
  });

  it("finishes a note-only approval retry after checking the current head", async () => {
    const artifact = { opener: "The reviewed head is ready.", comments: [], bodyNotes: [] };
    const adapterForCapabilities = new GitLabForgeAdapter({
      detectionDeps: detection(),
      locus: { kind: "host" },
      repositoryRoot: "/code/widget",
      run: vi.fn(),
    });
    const post = buildForgeReviewPost(artifact, {
      reviewId: "review-42",
      target: TARGET,
      payload: canonicalReviewPayload(artifact),
      verdict: "APPROVE",
      capabilities: adapterForCapabilities.capabilities,
    });
    const existing = { id: 88, body: post.body, web_url: null };
    const { adapter, calls } = scripted([
      ok(existing),
      ok({ username: "rai" }),
      ok({ approved_by: [] }),
      ok(mr()),
      ok({ approved: true }),
    ]);

    await expect(adapter.publishReview(post)).resolves.toEqual({
      reviewRef: "88",
      url: "https://gitlab.com/acme/platform/widget/-/merge_requests/42#note_88",
      reused: true,
    });
    expect(calls.map((call) => call.args[1])).toEqual([
      expect.stringContaining("/notes?"),
      "user",
      expect.stringContaining("/approvals"),
      expect.stringMatching(/\/merge_requests\/42$/),
      expect.stringMatching(/\/merge_requests\/42\/approve$/),
    ]);
    expect(calls.filter((call) => call.args[1]?.endsWith("/notes"))).toHaveLength(0);
  });

  it("refuses a moved head before finishing a note-only approval retry", async () => {
    const artifact = { opener: "The reviewed head is ready.", comments: [], bodyNotes: [] };
    const adapterForCapabilities = new GitLabForgeAdapter({
      detectionDeps: detection(),
      locus: { kind: "host" },
      repositoryRoot: "/code/widget",
      run: vi.fn(),
    });
    const post = buildForgeReviewPost(artifact, {
      reviewId: "review-42",
      target: TARGET,
      payload: canonicalReviewPayload(artifact),
      verdict: "APPROVE",
      capabilities: adapterForCapabilities.capabilities,
    });
    const { adapter, calls } = scripted([
      ok({ id: 88, body: post.body, web_url: null }),
      ok({ username: "rai" }),
      ok({ approved_by: [] }),
      ok(mr({ sha: "new-head" })),
    ]);

    await expect(adapter.publishReview(post)).rejects.toThrow(/head moved/i);
    expect(calls.map((call) => call.args[1])).toEqual([
      expect.stringContaining("/notes?"),
      "user",
      expect.stringContaining("/approvals"),
      expect.stringMatching(/\/merge_requests\/42$/),
    ]);
    expect(calls.some((call) => call.args[1]?.endsWith("/approve"))).toBe(false);
  });

  it("checks the live head before creating a note", async () => {
    const artifact = { opener: "The reviewed head is ready.", comments: [], bodyNotes: [] };
    const adapterForCapabilities = new GitLabForgeAdapter({
      detectionDeps: detection(),
      locus: { kind: "host" },
      repositoryRoot: "/code/widget",
      run: vi.fn(),
    });
    const post = buildForgeReviewPost(artifact, {
      reviewId: "review-42",
      target: TARGET,
      payload: canonicalReviewPayload(artifact),
      capabilities: adapterForCapabilities.capabilities,
    });
    const { adapter, calls } = scripted([ok(""), ok(mr({ sha: "new-head" }))]);

    await expect(adapter.publishReview(post)).rejects.toThrow(/head moved/i);
    expect(calls).toHaveLength(2);
    expect(calls.some((call) => call.args.includes("--method"))).toBe(false);
  });

  it("returns the canonical note URL when GitLab omits web_url", async () => {
    const artifact = { opener: "This is ready for review.", comments: [], bodyNotes: [] };
    const adapterForCapabilities = new GitLabForgeAdapter({
      detectionDeps: detection(),
      locus: { kind: "host" },
      repositoryRoot: "/code/widget",
      run: vi.fn(),
    });
    const post = buildForgeReviewPost(artifact, {
      reviewId: "review-42",
      target: TARGET,
      payload: canonicalReviewPayload(artifact),
      capabilities: adapterForCapabilities.capabilities,
    });
    const { adapter } = scripted([ok(""), ok(mr()), ok({ id: 91, body: post.body })]);

    await expect(adapter.publishReview(post)).resolves.toMatchObject({
      url: "https://gitlab.com/acme/platform/widget/-/merge_requests/42#note_91",
    });
  });

  it("reconciles a note whose response was lost without creating a duplicate", async () => {
    const artifact = { opener: "This is ready for review.", comments: [], bodyNotes: [] };
    const notes: { id: number; body: string }[] = [];
    let noteMutations = 0;
    const run: GitLabForgeCommandRunner = async (command) => {
      const endpoint = command.args[1] ?? "";
      if (endpoint.includes("/notes?")) {
        return ok(notes.map((note) => JSON.stringify(note)).join("\n"));
      }
      if (endpoint.endsWith("/merge_requests/42")) return ok(mr());
      if (endpoint.endsWith("/merge_requests/42/notes")) {
        noteMutations += 1;
        const body = JSON.parse(command.stdin ?? "{}") as { body: string };
        notes.push({ id: 101, body: body.body });
        throw new Error("socket closed after GitLab created the note");
      }
      throw new Error(`unexpected command: ${command.args.join(" ")}`);
    };
    const adapter = new GitLabForgeAdapter({
      detectionDeps: detection(),
      locus: { kind: "host" },
      repositoryRoot: "/code/widget",
      run,
    });
    const post = buildForgeReviewPost(artifact, {
      reviewId: "review-42",
      target: TARGET,
      payload: canonicalReviewPayload(artifact),
      capabilities: adapter.capabilities,
    });

    await expect(adapter.publishReview(post)).rejects.toThrow(/unreachable/i);
    await expect(adapter.publishReview(post)).resolves.toEqual({
      reviewRef: "101",
      url: "https://gitlab.com/acme/platform/widget/-/merge_requests/42#note_101",
      reused: true,
    });
    expect(noteMutations).toBe(1);
  });

  it("does not classify an arbitrary glab failure as authentication", async () => {
    const { adapter } = scripted([{ exitCode: 1, stdout: "500 Internal Server Error" }]);

    const error = await adapter.fetchDiff(REF).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toMatchObject({ reason: "authentication" });
    expect((error as Error).message).toContain("500 Internal Server Error");
  });

  it("fails honestly before execution when glab is absent", async () => {
    const { adapter, calls } = scripted([], false);

    await expect(adapter.fetchDiff(REF)).rejects.toThrow("Install `glab`");
    expect(calls).toEqual([]);
  });
});
