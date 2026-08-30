import type { ForgeRepoIdentity, Project } from "@rennet/protocol";
import { describe, expect, it, vi } from "vitest";
import {
  createProjectForgeRegistry,
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

describe("project forge registry", () => {
  it("never routes a same-coordinate GitLab PR through the GitHub opener", async () => {
    const review = { id: "github-review" };
    const github = vi.fn<ProjectPullRequestOpener<typeof review>>(async () => review);
    const registry = createProjectForgeRegistry([{ forge: "github", implementation: github }]);

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
