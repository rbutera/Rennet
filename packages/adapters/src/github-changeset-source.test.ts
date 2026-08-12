import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ForgePort, ForgePullRequest, ForgePullRequestRef } from "@rennet/core";
import { decompose } from "@rennet/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { execaGit } from "./git-range-diff";
import {
  createRefPinner,
  GitHubChangesetSource,
  type GitObjectPinner,
  ReviewedOidUnavailableError,
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

function prFrom(
  baseOid: string,
  headOid: string,
  body = "Adds the second export.\n\nCloses #4.",
): ForgePullRequest {
  return {
    ref,
    title: "Add b",
    body,
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
      resolveProjectSnapshotId: async (repoRoot, oid) => {
        expect(repoRoot).toBe(root);
        expect(oid).toBe(baseOid);
        return "project-snapshot";
      },
    });
    const result = await source.open(ref);
    expect(result.patchset.source).toBe("github-local");
    expect(result.patchset.degraded).toBeUndefined();
    expect(result.patchset.projectSnapshotId).toBe("project-snapshot");
    // Byte-identical to the local `git diff base...head`.
    expect(result.patchset.rawDiff).toBe(git(root, "diff", `${baseOid}...${headOid}`));
    // Feeds the same canvases: it decomposes like any patchset.
    const decomposition = decompose(result.patchset);
    expect(decomposition.hunks.length).toBeGreaterThan(0);
    expect(result.pin).not.toBeNull();
    // The deep-fetched PR is carried (issue #21) so the caller can build the real
    // post-target: the forge node id (`forgeRef`) a real GitHub egress posts against.
    expect(result.pullRequest.forgeRef).toBe("PR_7");
    expect(result.pullRequest.ref).toEqual(ref);
    expect(result.pullRequest.headOid).toBe(headOid);
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

  it("survives a REAL force-push (divergent head + GC prune) via the ref pinner", async () => {
    const { root, baseOid, headOid } = clonedRepo();
    const source = new GitHubChangesetSource({
      forge: forgeReturning(prFrom(baseOid, headOid)),
      git: execaGit,
      // The REAL pinner: writes a protective ref so GC cannot reap the reviewed head.
      pin: createRefPinner(execaGit),
      worktrees: worktreesOf(root),
    });
    const first = await source.open(ref);
    if (!first.pin) throw new Error("unreachable");

    // A REAL force-push: the feature branch is reset to a DIVERGENT commit, so the
    // originally-reviewed head is no longer reachable from ANY branch (unlike a
    // fast-forward, where the old head survives merely as an ancestor).
    git(root, "checkout", "-q", "main");
    git(root, "branch", "-qD", "feature");
    git(root, "checkout", "-qb", "feature");
    writeFileSync(join(root, "app.ts"), "export const a = 1;\nexport const divergent = 9;\n");
    git(root, "add", "app.ts");
    git(root, "commit", "-qm", "force-pushed divergent head");

    // Prove the reviewed head is now off every branch — only the rennet pin ref
    // points at it, so an unprotected object would be pruned below.
    expect(git(root, "branch", "--contains", headOid).trim()).toBe("");
    const refsPointingAt = git(root, "for-each-ref", "--points-at", headOid, "--format=%(refname)")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    expect(refsPointingAt).toEqual([`refs/rennet/pins/${headOid}`]);

    // Now GC everything unreachable. Without the pin ref, the reviewed head object
    // would be gone and `reproduce` would throw "bad revision".
    git(root, "reflog", "expire", "--expire=now", "--all");
    git(root, "gc", "--prune=now", "--quiet");

    // The protective ref kept the reviewed head alive: reproduce still yields the
    // byte-identical originally-reviewed patchset.
    const reproduced = await source.reproduce(first.pin);
    expect(reproduced.id).toBe(first.patchset.id);
    expect(reproduced.rawDiff).toBe(first.patchset.rawDiff);
  });
});

/** A clone whose feature commit ALSO edits a committed spec document. */
function clonedRepoWithSpec(specHeadContent: string): {
  root: string;
  baseOid: string;
  headOid: string;
} {
  const root = mkdtempSync(join(tmpdir(), "rennet-spec-"));
  directories.push(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "rennet@example.test");
  git(root, "config", "user.name", "Rennet Test");
  git(root, "remote", "add", "origin", "git@github.com:acme/widget.git");
  execFileSync("mkdir", ["-p", join(root, "specs")]);
  writeFileSync(join(root, "app.ts"), "export const a = 1;\n");
  writeFileSync(join(root, "specs", "spec.md"), "# Spec\n\nThe original rule.\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "base");
  const baseOid = git(root, "rev-parse", "HEAD").trim();
  git(root, "checkout", "-qb", "feature");
  writeFileSync(join(root, "app.ts"), "export const a = 1;\nexport const b = 2;\n");
  writeFileSync(join(root, "specs", "spec.md"), specHeadContent);
  git(root, "add", ".");
  git(root, "commit", "-qm", "feature");
  const headOid = git(root, "rev-parse", "HEAD").trim();
  return { root, baseOid, headOid };
}

describe("GitHubChangesetSource — change-intent capture (#136)", () => {
  it("freezes the PR title and body onto the patchset intent (github-pr surface)", async () => {
    const { root, baseOid, headOid } = clonedRepo();
    const source = new GitHubChangesetSource({
      forge: forgeReturning(prFrom(baseOid, headOid, "Body of the PR.\n\nDetail.")),
      git: execaGit,
      pin: provingPinner,
      worktrees: worktreesOf(root),
    });
    const { patchset } = await source.open(ref);
    expect(patchset.intent).toBeDefined();
    expect(patchset.intent?.surface).toBe("github-pr");
    expect(patchset.intent?.prTitle).toBe("Add b");
    expect(patchset.intent?.prBody).toBe("Body of the PR.\n\nDetail.");
    expect(patchset.intent?.prBodyAbsent).toBeUndefined();
    // Intent rides ALONGSIDE identity: stamping it does not change the content id.
    const decomposition = decompose(patchset);
    expect(decomposition.hunks.length).toBeGreaterThan(0);
  });

  it("records an empty PR body as an honest absence, never an empty-string intent (AC4)", async () => {
    const { root, baseOid, headOid } = clonedRepo();
    const source = new GitHubChangesetSource({
      forge: forgeReturning(prFrom(baseOid, headOid, "")),
      git: execaGit,
      pin: provingPinner,
      worktrees: worktreesOf(root),
    });
    const { patchset } = await source.open(ref);
    expect(patchset.intent?.prBody).toBeUndefined();
    expect(patchset.intent?.prBodyAbsent).toBe(true);
  });

  it("snapshots the changeset's spec set from the COMMITTED head, immune to a later working-tree edit (AC1)", async () => {
    const headSpec = "# Spec\n\nThe shipped rule.\n";
    const { root, baseOid, headOid } = clonedRepoWithSpec(headSpec);
    const source = new GitHubChangesetSource({
      forge: forgeReturning(prFrom(baseOid, headOid)),
      git: execaGit,
      pin: provingPinner,
      worktrees: worktreesOf(root),
    });
    const first = await source.open(ref);
    const snap = first.patchset.intent?.specSnapshots?.find((s) => s.path === "specs/spec.md");
    expect(snap?.content).toBe(headSpec);
    expect(snap?.digest.length).toBe(64);

    // Edit the spec in the working tree AFTER capture. Re-opening at the SAME head
    // still snapshots the committed content — the frozen intent is byte-identical
    // before and after the local edit.
    writeFileSync(join(root, "specs", "spec.md"), "# Spec\n\nLATER edit.\n");
    const second = await source.open(ref);
    const snap2 = second.patchset.intent?.specSnapshots?.find((s) => s.path === "specs/spec.md");
    expect(snap2?.content).toBe(headSpec);
  });

  it("the degraded REST path freezes PR title/body but honestly omits the spec set", async () => {
    const source = new GitHubChangesetSource({
      forge: forgeReturning(
        prFrom("bbbb", "aaaa", "REST body."),
        "diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -0,0 +1 @@\n+export const x = 1;\n",
      ),
      git: execaGit,
      pin: provingPinner,
      worktrees: { list: () => Promise.resolve([]) },
    });
    const { patchset } = await source.open(ref);
    expect(patchset.intent?.surface).toBe("github-rest");
    expect(patchset.intent?.prTitle).toBe("Add b");
    expect(patchset.intent?.prBody).toBe("REST body.");
    // No clone on disk ⇒ no committed spec content to read ⇒ honestly absent.
    expect(patchset.intent?.specSnapshots).toBeUndefined();
  });

  it("a moved head mints a new patchset with its OWN frozen intent; the prior is unchanged (R28, AC3)", async () => {
    const { root, baseOid, headOid } = clonedRepo();
    const first = await new GitHubChangesetSource({
      forge: forgeReturning(prFrom(baseOid, headOid, "First intent.")),
      git: execaGit,
      pin: provingPinner,
      worktrees: worktreesOf(root),
    }).open(ref);

    // Force-push: the head moves to a new commit with a re-stated intent.
    writeFileSync(
      join(root, "app.ts"),
      "export const a = 1;\nexport const b = 2;\nexport const c = 3;\n",
    );
    git(root, "add", "app.ts");
    git(root, "commit", "-qm", "moved");
    const movedHead = git(root, "rev-parse", "HEAD").trim();

    const second = await new GitHubChangesetSource({
      forge: forgeReturning(prFrom(baseOid, movedHead, "Second intent.")),
      git: execaGit,
      pin: provingPinner,
      worktrees: worktreesOf(root),
    }).open(ref);

    expect(second.patchset.id).not.toBe(first.patchset.id);
    expect(second.patchset.intent?.prBody).toBe("Second intent.");
    // The prior patchset's intent is never rewritten by the newer capture.
    expect(first.patchset.intent?.prBody).toBe("First intent.");
  });
});

/**
 * A "server" repo whose PR head is reachable ONLY via `refs/pull/7/head` (the
 * source branch is deleted, the squash/rebase-merge shape), paired with a clone
 * that has the base but has NEVER fetched the head. The clone's `origin` is the
 * fetchable server; a second `github` remote carries the identity the worktree
 * matcher keys on (a real clone's single `origin` is both at once — split here so
 * the fetch stays hermetic instead of reaching github.com).
 */
function serverWithPrHeadAndCloneMissingIt(): {
  cloneRoot: string;
  baseOid: string;
  headOid: string;
} {
  const server = mkdtempSync(join(tmpdir(), "rennet-srv-"));
  directories.push(server);
  git(server, "init", "-q", "-b", "main");
  git(server, "config", "user.email", "rennet@example.test");
  git(server, "config", "user.name", "Rennet Test");
  writeFileSync(join(server, "app.ts"), "export const a = 1;\n");
  git(server, "add", "app.ts");
  git(server, "commit", "-qm", "base");
  const baseOid = git(server, "rev-parse", "HEAD").trim();
  git(server, "checkout", "-qb", "feature");
  writeFileSync(join(server, "app.ts"), "export const a = 1;\nexport const b = 2;\n");
  git(server, "add", "app.ts");
  git(server, "commit", "-qm", "feature");
  const headOid = git(server, "rev-parse", "HEAD").trim();
  // Publish the PR head ref the way GitHub does, then delete the branch so the head
  // is reachable ONLY via refs/pull/7/head — exactly what a squash-merge leaves.
  git(server, "update-ref", "refs/pull/7/head", headOid);
  git(server, "checkout", "-q", "main");
  git(server, "branch", "-qD", "feature");

  const cloneRoot = mkdtempSync(join(tmpdir(), "rennet-clone-"));
  directories.push(cloneRoot);
  git(cloneRoot, "init", "-q", "-b", "main");
  git(cloneRoot, "config", "user.email", "rennet@example.test");
  git(cloneRoot, "config", "user.name", "Rennet Test");
  git(cloneRoot, "remote", "add", "origin", server);
  git(cloneRoot, "remote", "add", "github", "git@github.com:acme/widget.git");
  git(cloneRoot, "fetch", "-q", "origin", "main");
  git(cloneRoot, "update-ref", "refs/heads/main", "FETCH_HEAD");
  return { cloneRoot, baseOid, headOid };
}

/** A base-only server + clone: the PR head is neither local nor fetchable anywhere. */
function serverBaseOnlyClone(): { cloneRoot: string; baseOid: string } {
  const server = mkdtempSync(join(tmpdir(), "rennet-srv-"));
  directories.push(server);
  git(server, "init", "-q", "-b", "main");
  git(server, "config", "user.email", "rennet@example.test");
  git(server, "config", "user.name", "Rennet Test");
  writeFileSync(join(server, "app.ts"), "export const a = 1;\n");
  git(server, "add", "app.ts");
  git(server, "commit", "-qm", "base");
  const baseOid = git(server, "rev-parse", "HEAD").trim();

  const cloneRoot = mkdtempSync(join(tmpdir(), "rennet-clone-"));
  directories.push(cloneRoot);
  git(cloneRoot, "init", "-q", "-b", "main");
  git(cloneRoot, "config", "user.email", "rennet@example.test");
  git(cloneRoot, "config", "user.name", "Rennet Test");
  git(cloneRoot, "remote", "add", "origin", server);
  git(cloneRoot, "remote", "add", "github", "git@github.com:acme/widget.git");
  git(cloneRoot, "fetch", "-q", "origin", "main");
  git(cloneRoot, "update-ref", "refs/heads/main", "FETCH_HEAD");
  return { cloneRoot, baseOid };
}

describe("GitHubChangesetSource — fetch-before-pin for squash/rebase-merged PRs (#193)", () => {
  it("fetches a reviewed head OID that is not yet local, then pins and diffs it", async () => {
    const { cloneRoot, baseOid, headOid } = serverWithPrHeadAndCloneMissingIt();
    // Precondition: the reviewed head really is absent from the clone before review.
    expect(() => git(cloneRoot, "cat-file", "-e", headOid)).toThrow();

    const pin = { pin: vi.fn(provingPinner.pin) } satisfies GitObjectPinner;
    const source = new GitHubChangesetSource({
      forge: forgeReturning(prFrom(baseOid, headOid)),
      git: execaGit,
      pin,
      worktrees: worktreesOf(cloneRoot),
    });
    const result = await source.open(ref);

    // The head was fetched into the local object store BEFORE the pin ran (the
    // proving pinner would have thrown on a missing object otherwise)...
    expect(() => git(cloneRoot, "cat-file", "-e", headOid)).not.toThrow();
    expect(pin.pin).toHaveBeenCalledWith(cloneRoot, [baseOid, headOid]);
    // ...and the outcome is a real LOCAL diff, not the degraded REST fallback.
    expect(result.patchset.source).toBe("github-local");
    expect(result.patchset.degraded).toBeUndefined();
    expect(result.pin?.headOid).toBe(headOid);
    expect(result.patchset.rawDiff).toBe(git(cloneRoot, "diff", `${baseOid}...${headOid}`));
  });

  it("fails closed with a typed error when the reviewed head cannot be fetched", async () => {
    const { cloneRoot, baseOid } = serverBaseOnlyClone();
    const unreachableHead = "0".repeat(40);
    const source = new GitHubChangesetSource({
      forge: forgeReturning(prFrom(baseOid, unreachableHead)),
      git: execaGit,
      pin: provingPinner,
      worktrees: worktreesOf(cloneRoot),
    });

    const error = await source.open(ref).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ReviewedOidUnavailableError);
    expect((error as ReviewedOidUnavailableError).missingOids).toContain(unreachableHead);
    // The head that could not be fetched is named in the message (honest, actionable).
    expect((error as Error).message).toContain(unreachableHead);
  });
});
