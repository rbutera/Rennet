import type { ForgeCiStatus, ForgePort } from "@rennet/core";
import type { ForgeRepoIdentity, Project } from "@rennet/protocol";
import { describe, expect, it, vi } from "vitest";
import {
  createForgeRegistry,
  fetchForgeCiStatus,
  openProjectPullRequest,
  type ProjectPullRequestOpener,
  repositoryIdentityAgrees,
  resolveProjectContextRepository,
  resolveProjectRepositoryRoot,
} from "./project-forge-registry";

const GITHUB_WIDGET = {
  forge: "github",
  owner: "acme",
  name: "widget",
} satisfies ForgeRepoIdentity;
const GITLAB_WIDGET = {
  forge: "gitlab",
  owner: "acme",
  name: "widget",
} satisfies ForgeRepoIdentity;

const PROJECT = {
  id: "project",
  name: "workspace",
  path: "/workspace",
  kind: "workspace",
  repoCount: 2,
  branchCount: 2,
  primaryBranch: "main",
  openPath: "/workspace/github",
  includedRepoPaths: ["/workspace/github", "/workspace/gitlab"],
  addedAt: "2026-08-30T00:00:00.000Z",
  source: "local",
} satisfies Project;

describe("forge registry", () => {
  it("reports exact provider membership", () => {
    const registry = createForgeRegistry([{ forge: "github", implementation: "github" }]);

    expect(registry.has("github")).toBe(true);
    expect(registry.has("gitlab")).toBe(false);
    expect(registry.has("GitHub")).toBe(false);
  });

  it("never routes a same-coordinate GitLab PR through the GitHub opener", async () => {
    const review = { id: "github-review" };
    const github = vi.fn<ProjectPullRequestOpener<typeof review>>(async () => review);
    const registry = createForgeRegistry([{ forge: "github", implementation: github }]);

    await expect(
      openProjectPullRequest(registry, {
        commandId: "command",
        repository: GITLAB_WIDGET,
        number: 7,
        repoPath: "/workspace/gitlab",
        retrospective: false,
      }),
    ).rejects.toThrow('No pull-request opener is registered for forge "gitlab"');
    expect(github).not.toHaveBeenCalled();

    await expect(
      openProjectPullRequest(registry, {
        commandId: "command",
        repository: GITHUB_WIDGET,
        number: 7,
        repoPath: "/workspace/github",
        retrospective: false,
      }),
    ).resolves.toBe(review);
    expect(github).toHaveBeenCalledOnce();
    expect(github).toHaveBeenCalledWith({
      commandId: "command",
      repository: GITHUB_WIDGET,
      number: 7,
      repoPath: "/workspace/github",
      retrospective: false,
    });
  });

  it("routes CI by forge and forwards the exact ref, head OID, and signal", async () => {
    const githubStatus = {
      checks: [],
      sso: { kind: "none" },
      incomplete: false,
    } satisfies ForgeCiStatus;
    const gitlabStatus = {
      checks: [
        {
          id: "gitlab-pipeline",
          name: "pipeline",
          outcome: "passing",
          summary: "passed",
        },
      ],
      sso: { kind: "none" },
      incomplete: false,
    } satisfies ForgeCiStatus;
    const githubFetch = vi.fn<ForgePort["fetchCiStatus"]>(async () => githubStatus);
    const gitlabFetch = vi.fn<ForgePort["fetchCiStatus"]>(async () => gitlabStatus);
    const registry = createForgeRegistry<Pick<ForgePort, "fetchCiStatus">>([
      { forge: "github", implementation: { fetchCiStatus: githubFetch } },
      { forge: "gitlab", implementation: { fetchCiStatus: gitlabFetch } },
    ]);
    const gitlabRef = { repo: GITLAB_WIDGET, number: 7 };
    const gitlabController = new AbortController();

    await expect(
      fetchForgeCiStatus(registry, gitlabRef, "gitlab-head", gitlabController.signal),
    ).resolves.toBe(gitlabStatus);
    expect(gitlabFetch).toHaveBeenCalledOnce();
    expect(gitlabFetch).toHaveBeenCalledWith(gitlabRef, "gitlab-head", gitlabController.signal);
    expect(githubFetch).not.toHaveBeenCalled();

    const githubRef = { repo: GITHUB_WIDGET, number: 11 };
    const githubController = new AbortController();
    await expect(
      fetchForgeCiStatus(registry, githubRef, "github-head", githubController.signal),
    ).resolves.toBe(githubStatus);
    expect(githubFetch).toHaveBeenCalledOnce();
    expect(githubFetch).toHaveBeenCalledWith(githubRef, "github-head", githubController.signal);
    expect(gitlabFetch).toHaveBeenCalledOnce();

    const bitbucketRef = {
      repo: { forge: "bitbucket", owner: "acme", name: "widget" },
      number: 13,
    };
    await expect(fetchForgeCiStatus(registry, bitbucketRef, "bitbucket-head")).rejects.toThrow(
      'No CI status source is registered for forge "bitbucket"',
    );
    expect(githubFetch).toHaveBeenCalledOnce();
    expect(gitlabFetch).toHaveBeenCalledOnce();
  });

  it("resolves the root by forge when two providers share owner/name", async () => {
    const identityByRoot = new Map([
      ["/workspace/github", { repository: "acme/widget", forgeRepository: GITHUB_WIDGET }],
      ["/workspace/gitlab", { repository: "acme/widget", forgeRepository: GITLAB_WIDGET }],
    ]);

    await expect(
      resolveProjectRepositoryRoot({
        project: PROJECT,
        target: { repository: "acme/widget", forgeRepository: GITLAB_WIDGET },
        identityForRoot: async (root) => {
          const identity = identityByRoot.get(root);
          if (identity === undefined) throw new Error(`missing identity for ${root}`);
          return identity;
        },
      }),
    ).resolves.toBe("/workspace/gitlab");
  });

  it("keeps the legacy owner/name fallback when either side lacks forge identity", async () => {
    await expect(
      resolveProjectRepositoryRoot({
        project: PROJECT,
        target: { repository: "acme/widget" },
        identityForRoot: async (root) => ({
          repository: root === "/workspace/github" ? "other/repo" : "acme/widget",
          forgeRepository: root === "/workspace/github" ? GITHUB_WIDGET : undefined,
        }),
      }),
    ).resolves.toBe("/workspace/gitlab");
  });

  it("selects the exact member map in a two-repository workspace", async () => {
    const identityByRoot = new Map([
      [
        "/workspace/github",
        {
          repository: "acme/widget",
          forgeRepository: GITHUB_WIDGET,
        },
      ],
      [
        "/workspace/gitlab",
        {
          repository: "acme/widget",
          forgeRepository: GITLAB_WIDGET,
        },
      ],
    ]);
    const identityForRoot = async (root: string) => {
      const identity = identityByRoot.get(root);
      if (identity === undefined) throw new Error(`missing identity for ${root}`);
      return identity;
    };

    await expect(
      resolveProjectContextRepository({
        project: PROJECT,
        target: { repository: "acme/widget", forgeRepository: GITLAB_WIDGET },
        identityForRoot,
      }),
    ).resolves.toEqual({ kind: "resolved", repositoryRoot: "/workspace/gitlab" });

    // Positive control: changing only the repository address must select the other map.
    await expect(
      resolveProjectContextRepository({
        project: PROJECT,
        target: { repository: "acme/widget", forgeRepository: GITHUB_WIDGET },
        identityForRoot,
      }),
    ).resolves.toEqual({ kind: "resolved", repositoryRoot: "/workspace/github" });
  });

  it("returns member identities for an unaddressed multi-repository project", async () => {
    await expect(
      resolveProjectContextRepository({
        project: PROJECT,
        target: {},
        identityForRoot: async (root) =>
          root === "/workspace/github"
            ? { repository: "acme/widget", forgeRepository: GITHUB_WIDGET }
            : { repository: "acme/widget", forgeRepository: GITLAB_WIDGET },
      }),
    ).resolves.toEqual({
      kind: "members",
      members: [
        { repository: "acme/widget", forgeRepository: GITHUB_WIDGET },
        { repository: "acme/widget", forgeRepository: GITLAB_WIDGET },
      ],
    });
  });

  it("does not fall back to the primary repository when a named member is absent", async () => {
    await expect(
      resolveProjectContextRepository({
        project: PROJECT,
        target: {
          repository: "acme/missing",
          forgeRepository: { forge: "github", owner: "acme", name: "missing" },
        },
        identityForRoot: async (root) =>
          root === "/workspace/github"
            ? { repository: "acme/widget", forgeRepository: GITHUB_WIDGET }
            : { repository: "acme/widget", forgeRepository: GITLAB_WIDGET },
      }),
    ).resolves.toEqual({ kind: "missing" });
  });

  it("derives owner/name before comparing one-sided structured identities", () => {
    expect(
      repositoryIdentityAgrees({ repository: "other/repo" }, { forgeRepository: GITHUB_WIDGET }),
    ).toBe(false);
    expect(
      repositoryIdentityAgrees({ repository: "acme/widget" }, { forgeRepository: GITHUB_WIDGET }),
    ).toBe(true);
    expect(repositoryIdentityAgrees({}, { forgeRepository: GITHUB_WIDGET })).toBe(true);
  });
});
