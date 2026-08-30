import type { ForgeCiStatus, ForgePort } from "@rennet/core";
import type { ForgeRepoIdentity, Project } from "@rennet/protocol";
import { describe, expect, it, vi } from "vitest";
import {
  createForgeRegistry,
  type ForgeProvider,
  fetchForgeCiStatus,
  openProjectPullRequest,
  type ProjectPullRequestOpener,
  repositoryIdentityAgrees,
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
    const status = {
      checks: [],
      sso: { kind: "none" },
      incomplete: false,
    } satisfies ForgeCiStatus;
    const githubFetch = vi.fn<ForgePort["fetchCiStatus"]>(async () => status);
    const registry = createForgeRegistry<Pick<ForgeProvider, "fetchCiStatus">>([
      { forge: "github", implementation: { fetchCiStatus: githubFetch } },
    ]);
    const gitlabRef = { repo: GITLAB_WIDGET, number: 7 };

    await expect(fetchForgeCiStatus(registry, gitlabRef, "gitlab-head")).rejects.toThrow(
      'No CI status source is registered for forge "gitlab"',
    );
    expect(githubFetch).not.toHaveBeenCalled();

    const githubRef = { repo: GITHUB_WIDGET, number: 11 };
    const controller = new AbortController();
    await expect(
      fetchForgeCiStatus(registry, githubRef, "github-head", controller.signal),
    ).resolves.toBe(status);
    expect(githubFetch).toHaveBeenCalledOnce();
    expect(githubFetch).toHaveBeenCalledWith(githubRef, "github-head", controller.signal);
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
