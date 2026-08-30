import { describe, expect, it } from "vitest";
import {
  discoverWorktreeIdentities,
  type LocalWorktree,
  matchWorktree,
  parseRemoteIdentity,
  resolveForgeRemote,
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

  it("preserves every nested GitLab namespace segment for scp and URL remotes", () => {
    const first = parseRemoteIdentity("git@gitlab.com:division-a/shared/widget.git");
    const second = parseRemoteIdentity("https://gitlab.com/division-b/shared/widget.git");

    expect(first).toEqual({
      host: "gitlab.com",
      owner: "division-a/shared",
      name: "widget",
    });
    expect(second).toEqual({
      host: "gitlab.com",
      owner: "division-b/shared",
      name: "widget",
    });
    expect(first).not.toEqual(second);
  });

  it("returns null for a non-forge remote", () => {
    expect(parseRemoteIdentity("/local/only/path")).toBeNull();
    expect(parseRemoteIdentity("")).toBeNull();
  });
});

describe("matchWorktree — by repo identity, never a path guess", () => {
  const worktrees: LocalWorktree[] = [
    {
      root: "/src/gitlab-widget",
      commonDir: "/src/gitlab-widget/.git",
      identities: [{ host: "gitlab.com", owner: "acme", name: "widget" }],
    },
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
    const match = matchWorktree({ forge: "github", owner: "acme", name: "widget" }, worktrees);
    expect(match?.root).toBe("/src/widget");
  });

  it("is case-insensitive on forge and owner/name", () => {
    const match = matchWorktree({ forge: "GITHUB", owner: "ACME", name: "Widget" }, worktrees);
    expect(match?.root).toBe("/src/widget");
  });

  it("does not match a same-coordinate repository on another forge", () => {
    const match = matchWorktree({ forge: "gitlab", owner: "acme", name: "widget" }, worktrees);
    expect(match?.root).toBe("/src/gitlab-widget");
  });

  it("returns null when no worktree shares the identity (never guesses a path)", () => {
    expect(
      matchWorktree({ forge: "github", owner: "acme", name: "missing" }, worktrees),
    ).toBeNull();
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

describe("resolveForgeRemote — the single source for push + PR-repo", () => {
  const gitReturning = (remoteVerbose: string) => (_root: string, args: string[]) =>
    args[0] === "remote" && args[1] === "-v" ? Promise.resolve(remoteVerbose) : Promise.resolve("");

  it("prefers origin among GitHub remotes (name + identity share one source)", async () => {
    // origin is a fork, upstream is the canonical repo — the push AND the PR must both
    // go to origin (your own repo), never split across the two.
    const git = gitReturning(
      "origin\tgit@github.com:me/widget.git (fetch)\n" +
        "origin\tgit@github.com:me/widget.git (push)\n" +
        "upstream\thttps://github.com/acme/widget.git (fetch)\n" +
        "upstream\thttps://github.com/acme/widget.git (push)\n",
    );
    const remote = await resolveForgeRemote(git, "/src/widget");
    expect(remote).toEqual({
      name: "origin",
      identity: { host: "github.com", owner: "me", name: "widget" },
    });
  });

  it("falls back to the first GitHub remote when there is no origin", async () => {
    const git = gitReturning("github\thttps://github.com/acme/widget.git (fetch)\n");
    const remote = await resolveForgeRemote(git, "/src/widget");
    expect(remote).toEqual({
      name: "github",
      identity: { host: "github.com", owner: "acme", name: "widget" },
    });
  });

  it("ignores a non-github remote, and returns null when none point at GitHub", async () => {
    const git = gitReturning(
      "origin\tgit@gitlab.com:acme/widget.git (fetch)\n" +
        "origin\tgit@gitlab.com:acme/widget.git (push)\n",
    );
    // A non-github origin must NOT be handed to the github adapter — resolve to null so
    // the caller reports honestly that there is nowhere to open a PR.
    expect(await resolveForgeRemote(git, "/src/widget")).toBeNull();
  });
});
