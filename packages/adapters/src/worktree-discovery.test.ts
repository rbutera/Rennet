import { describe, expect, it } from "vitest";
import {
  discoverWorktreeIdentities,
  type LocalWorktree,
  matchWorktree,
  parseRemoteIdentity,
} from "./worktree-discovery";

describe("parseRemoteIdentity", () => {
  it("parses https, scp-style ssh, and ssh:// remotes to owner/name", () => {
    expect(parseRemoteIdentity("https://github.com/acme/widget.git")).toEqual({
      host: "github.com",
      owner: "acme",
      name: "widget",
    });
    expect(parseRemoteIdentity("git@github.com:acme/widget.git")).toEqual({
      host: "github.com",
      owner: "acme",
      name: "widget",
    });
    expect(parseRemoteIdentity("ssh://git@github.com/acme/widget")).toEqual({
      host: "github.com",
      owner: "acme",
      name: "widget",
    });
  });

  it("returns null for a non-forge remote", () => {
    expect(parseRemoteIdentity("/local/only/path")).toBeNull();
    expect(parseRemoteIdentity("")).toBeNull();
  });
});

describe("matchWorktree — by repo identity, never a path guess", () => {
  const worktrees: LocalWorktree[] = [
    {
      root: "/src/widget",
      commonDir: "/src/widget/.git",
      identities: [{ host: "github.com", owner: "acme", name: "widget" }],
    },
    {
      root: "/src/other",
      commonDir: "/src/other/.git",
      identities: [{ host: "github.com", owner: "acme", name: "other" }],
    },
  ];

  it("matches the worktree whose remote identity equals the PR's owner/name", () => {
    const match = matchWorktree({ owner: "acme", name: "widget" }, worktrees);
    expect(match?.root).toBe("/src/widget");
  });

  it("is case-insensitive on owner/name", () => {
    const match = matchWorktree({ owner: "ACME", name: "Widget" }, worktrees);
    expect(match?.root).toBe("/src/widget");
  });

  it("returns null when no worktree shares the identity (never guesses a path)", () => {
    expect(matchWorktree({ owner: "acme", name: "missing" }, worktrees)).toBeNull();
  });
});

describe("discoverWorktreeIdentities", () => {
  it("parses a worktree's remotes into identities via injected git", async () => {
    const git = (_root: string, args: string[]) => {
      if (args[0] === "remote" && args[1] === "-v") {
        return Promise.resolve(
          "origin\tgit@github.com:acme/widget.git (fetch)\n" +
            "origin\tgit@github.com:acme/widget.git (push)\n" +
            "upstream\thttps://github.com/acme/widget-upstream.git (fetch)\n",
        );
      }
      if (args[0] === "rev-parse" && args[1] === "--git-common-dir") {
        return Promise.resolve("/src/widget/.git\n");
      }
      return Promise.resolve("");
    };
    const worktree = await discoverWorktreeIdentities(git, "/src/widget");
    expect(worktree.root).toBe("/src/widget");
    expect(worktree.identities).toEqual([
      { host: "github.com", owner: "acme", name: "widget" },
      { host: "github.com", owner: "acme", name: "widget-upstream" },
    ]);
  });
});
