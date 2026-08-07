import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ForgePort, ForgePullRequest, ForgePullRequestRef } from "@rennet/core";
import { decompose } from "@rennet/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { execaGit } from "./git-range-diff";
import {
  GitHubChangesetSource,
  type GitObjectPinner,
  type WorktreeProvider,
} from "./github-changeset-source";
import { discoverWorktreeIdentities } from "./worktree-discovery";

const directories: string[] = [];

function git(root: string, ...arguments_: string[]): string {
  return execFileSync("git", arguments_, { cwd: root, encoding: "utf8" });
}

/** A real clone whose `origin` remote is `acme/widget`, with a base and head commit. */
function clonedRepo(): { root: string; baseOid: string; headOid: string } {
  const root = mkdtempSync(join(tmpdir(), "rennet-src-"));
  directories.push(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "rennet@example.test");
  git(root, "config", "user.name", "Rennet Test");
  git(root, "remote", "add", "origin", "git@github.com:acme/widget.git");
  writeFileSync(join(root, "app.ts"), "export const a = 1;\n");
  git(root, "add", "app.ts");
  git(root, "commit", "-qm", "base");
  const baseOid = git(root, "rev-parse", "HEAD").trim();
  git(root, "checkout", "-qb", "feature");
  writeFileSync(join(root, "app.ts"), "export const a = 1;\nexport const b = 2;\n");
  git(root, "add", "app.ts");
  git(root, "commit", "-qm", "feature");
  const headOid = git(root, "rev-parse", "HEAD").trim();
  return { root, baseOid, headOid };
}

const ref: ForgePullRequestRef = {
  repo: { forge: "github", owner: "acme", name: "widget" },
  number: 7,
};

function forgeReturning(pr: ForgePullRequest, diff = "diff --git a/x.ts b/x.ts\n"): ForgePort {
  return {
    capabilities: {
      supportsThreadResolution: true,
      supportsBatchedReview: true,
      supportsMultiLineAnchors: true,
      supportsFileLevelThreads: true,
    },
    listOpenPullRequests: () =>
      Promise.resolve({
        items: [],
        sso: { kind: "none" },
        complete: true,
        truncatedOver1000: false,
      }),
    fetchPullRequest: () => Promise.resolve(pr),
    fetchDiff: () => Promise.resolve({ diff, sso: { kind: "none" } }),
  };
}

function prFrom(baseOid: string, headOid: string): ForgePullRequest {
  return {
    ref,
    title: "Add b",
    isDraft: false,
    headOid,
    baseOid,
    baseRef: "main",
    headRef: "feature",
    cloneUrls: ["git@github.com:acme/widget.git"],
    forgeRef: "PR_7",
    changedFiles: 1,
    sso: { kind: "none" },
  };
}

/** A pinner that PROVES the OIDs are reachable locally (the real one would fetch first). */
const provingPinner: GitObjectPinner = {
  pin: (root, oids) => {
    for (const oid of oids) execFileSync("git", ["cat-file", "-e", oid], { cwd: root });
    return Promise.resolve();
  },
};

function worktreesOf(root: string): WorktreeProvider {
  return { list: () => Promise.all([discoverWorktreeIdentities(execaGit, root)]) };
}

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("GitHubChangesetSource — local-diff-first (acceptance #1, #4)", () => {
  it("opens a PR as an immutable patchset diffed from the local clone, feeding the canvases", async () => {
    const { root, baseOid, headOid } = clonedRepo();
    const source = new GitHubChangesetSource({
      forge: forgeReturning(prFrom(baseOid, headOid)),
      git: execaGit,
      pin: provingPinner,
      worktrees: worktreesOf(root),
    });
    const result = await source.open(ref);
    expect(result.patchset.source).toBe("github-local");
    expect(result.patchset.degraded).toBeUndefined();
    // Byte-identical to the local `git diff base...head`.
    expect(result.patchset.rawDiff).toBe(git(root, "diff", `${baseOid}...${headOid}`));
    // Feeds the same canvases: it decomposes like any patchset.
    const decomposition = decompose(result.patchset);
    expect(decomposition.hunks.length).toBeGreaterThan(0);
    expect(result.pin).not.toBeNull();
  });

  it("pins the reviewed head at review start (proves the OIDs are reachable locally)", async () => {
    const { root, baseOid, headOid } = clonedRepo();
    const pin = { pin: vi.fn(provingPinner.pin) } satisfies GitObjectPinner;
    const source = new GitHubChangesetSource({
      forge: forgeReturning(prFrom(baseOid, headOid)),
      git: execaGit,
      pin,
      worktrees: worktreesOf(root),
    });
    await source.open(ref);
    expect(pin.pin).toHaveBeenCalledWith(root, [baseOid, headOid]);
  });
});

describe("GitHubChangesetSource — the degraded REST fallback (acceptance #4)", () => {
  it("shows the degraded badge when no local clone matches the PR's identity", async () => {
    // No worktree provided → the identity match fails → REST fallback.
    const source = new GitHubChangesetSource({
      forge: forgeReturning(
        prFrom("bbbb", "aaaa"),
        "diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -0,0 +1 @@\n+export const x = 1;\n",
      ),
      git: execaGit,
      pin: provingPinner,
      worktrees: { list: () => Promise.resolve([]) },
    });
    const result = await source.open(ref);
    expect(result.patchset.source).toBe("github-rest");
    expect(result.patchset.degraded).toBe(true);
    expect(result.patchset.degradationReason?.length ?? 0).toBeGreaterThan(0);
    expect(result.patchset.files.map((file) => file.path)).toContain("x.ts");
    expect(result.pin).toBeNull();
  });
});

describe("GitHubChangesetSource — force-push resilience (acceptance #5)", () => {
  it("reproduces the originally-reviewed patchset from the pin after a force-push, and a moved head mints a NEW patchset", async () => {
    const { root, baseOid, headOid } = clonedRepo();
    const source = new GitHubChangesetSource({
      forge: forgeReturning(prFrom(baseOid, headOid)),
      git: execaGit,
      pin: provingPinner,
      worktrees: worktreesOf(root),
    });
    const first = await source.open(ref);
    expect(first.pin).not.toBeNull();
    if (!first.pin) throw new Error("unreachable");

    // Simulate a force-push: the feature branch head moves to a new commit.
    writeFileSync(
      join(root, "app.ts"),
      "export const a = 1;\nexport const b = 2;\nexport const c = 3;\n",
    );
    git(root, "add", "app.ts");
    git(root, "commit", "-qm", "force-pushed head");
    const movedHead = git(root, "rev-parse", "HEAD").trim();
    expect(movedHead).not.toBe(headOid);

    // Reproducing from the ORIGINAL pin yields the byte-identical reviewed state.
    const reproduced = await source.reproduce(first.pin);
    expect(reproduced.id).toBe(first.patchset.id);
    expect(reproduced.rawDiff).toBe(first.patchset.rawDiff);

    // Opening against the moved head mints a NEW, distinct patchset (never a rewrite).
    const moved = new GitHubChangesetSource({
      forge: forgeReturning(prFrom(baseOid, movedHead)),
      git: execaGit,
      pin: provingPinner,
      worktrees: worktreesOf(root),
    });
    const second = await moved.open(ref);
    expect(second.patchset.id).not.toBe(first.patchset.id);
    expect(second.patchset.repository.headOid).toBe(movedHead);
  });
});
