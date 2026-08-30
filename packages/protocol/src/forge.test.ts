import { describe, expect, it } from "vitest";
import { parseCommandInput } from "./commands";
import { forgeRepoIdentitySchema, forgeRepositorySlug, sameForgeRepository } from "./forge";
import { SessionModelSchema } from "./session";
import { localWorkSchema, pullRequestSchema, sidebarSessionSchema } from "./wire";

const github = { forge: "github", owner: "acme", name: "widget" } as const;
const gitlab = { forge: "gitlab", owner: "acme", name: "widget" } as const;

describe("ForgeRepoIdentity", () => {
  it("keeps the provider in identity when owner/name are identical", () => {
    expect(forgeRepoIdentitySchema.parse(github)).toEqual(github);
    expect(forgeRepositorySlug(github)).toBe("acme/widget");
    expect(sameForgeRepository(github, gitlab)).toBe(false);
  });

  it("keeps legacy session JSON readable without inventing a provider", () => {
    const legacy = JSON.parse(
      '{"id":"session-1","projectId":"project-1","repository":"acme/widget","claim":{"branch":"main","prNumber":7},"threads":[],"createdAt":1}',
    );
    const parsed = SessionModelSchema.parse(legacy);
    expect(parsed.repository).toBe("acme/widget");
    expect(parsed.forgeRepository).toBeUndefined();
  });

  it("carries matching structured identity through project rows, sessions, and mint", () => {
    const local = localWorkSchema.parse({
      id: "local-1",
      repository: "acme/widget",
      forgeRepository: github,
      branch: "main",
      author: "rai",
      dirty: false,
      ahead: 0,
      behind: 0,
      stage: "captured",
      lastActivityAt: "2026-08-30T00:00:00.000Z",
    });
    const pullRequest = pullRequestSchema.parse({
      id: "pr-7",
      number: 7,
      title: "Provider identity",
      repository: "acme/widget",
      forgeRepository: github,
      branch: "main",
      author: "rai",
      state: "open",
      reviewRequestedFromViewer: false,
      ci: "none",
      additions: 1,
      deletions: 0,
      changedFiles: 1,
      lastActivityAt: "2026-08-30T00:00:00.000Z",
    });
    const sidebar = sidebarSessionSchema.parse({
      id: "session-1",
      projectId: "project-1",
      title: "main",
      target: "your-pr",
      claim: { branch: "main", prNumber: 7 },
      repository: "acme/widget",
      forgeRepository: github,
      createdAt: 1,
    });
    const mint = parseCommandInput("session.mint", {
      projectId: "project-1",
      commandId: "6ba7b810-9dad-41d1-80b4-00c04fd430c8",
      branch: "main",
      prNumber: 7,
      repository: "acme/widget",
      forgeRepository: github,
    });

    expect(local.forgeRepository).toEqual(github);
    expect(pullRequest.forgeRepository).toEqual(github);
    expect(sidebar.forgeRepository).toEqual(github);
    expect(mint.forgeRepository).toEqual(github);
  });

  it("rejects a structured identity that contradicts its legacy owner/name", () => {
    const contradictory = { repository: "other/widget", forgeRepository: github };
    expect(
      localWorkSchema.safeParse({
        id: "local-1",
        ...contradictory,
        branch: "main",
        author: "rai",
        dirty: false,
        ahead: 0,
        behind: 0,
        stage: "captured",
        lastActivityAt: "2026-08-30T00:00:00.000Z",
      }).success,
    ).toBe(false);
    expect(
      pullRequestSchema.safeParse({
        id: "pr-7",
        number: 7,
        title: "Provider identity",
        ...contradictory,
        branch: "main",
        author: "rai",
        state: "open",
        reviewRequestedFromViewer: false,
        ci: "none",
        additions: 1,
        deletions: 0,
        changedFiles: 1,
        lastActivityAt: "2026-08-30T00:00:00.000Z",
      }).success,
    ).toBe(false);
    expect(
      sidebarSessionSchema.safeParse({
        id: "session-1",
        projectId: "project-1",
        title: "main",
        target: "your-pr",
        ...contradictory,
        createdAt: 1,
      }).success,
    ).toBe(false);
    expect(
      SessionModelSchema.safeParse({
        id: "session-1",
        projectId: "project-1",
        ...contradictory,
        threads: [],
        createdAt: 1,
      }).success,
    ).toBe(false);
    expect(() =>
      parseCommandInput("session.mint", {
        projectId: "project-1",
        commandId: "6ba7b810-9dad-41d1-80b4-00c04fd430c8",
        branch: "main",
        ...contradictory,
      }),
    ).toThrow(/same owner\/name/);
  });
});
