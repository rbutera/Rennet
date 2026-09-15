import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { baselineAdvanceDepsFor } from "./baseline-advance-watcher";
import { execaGit } from "./git-range-diff";
import { ProjectSnapshotGenerator } from "./project-snapshot-generator";
import { ensureProjectSnapshotPin } from "./project-snapshot-pin";
import { resolveBaseRef } from "./project-snapshot-source";
import { ProjectSnapshotStore } from "./project-snapshot-store";

// Real git plus a real snapshot build on a cold disk exceeds vitest's 5s default;
// the sibling git fixtures in this package take the same allowance.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const scratch: string[] = [];

afterEach(() => {
  for (const directory of scratch.splice(0))
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function git(root: string, ...arguments_: string[]): string {
  return execFileSync("git", arguments_, { cwd: root, encoding: "utf8" }).trim();
}

function scratchDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(directory);
  return directory;
}

function write(root: string, path: string, body: string): void {
  writeFileSync(join(root, path), body);
}

function commit(root: string, path: string, body: string): string {
  write(root, path, body);
  git(root, "add", path);
  git(root, "commit", "-qm", `add ${path}`);
  return git(root, "rev-parse", "HEAD");
}

/** An empty repository on `main`, configured to commit without a global identity. */
function repository(prefix: string): string {
  const root = scratchDirectory(prefix);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "rennet@example.test");
  git(root, "config", "user.name", "Rennet Test");
  return root;
}

/**
 * A clone whose `origin/main` is FRESHER than its local `main`: a sibling's commit
 * landed on the remote and was fetched, but nobody pulled. This is the shape the map's
 * baseline and the capture's base used to disagree about (repo-map-primary-base) —
 * git resolves the bare name `main` to `refs/heads/main`, the stale one.
 *
 * The tree carries a `package.json` so the snapshot generator has a workspace to read.
 */
function staleLocalMain(): { root: string; localTip: string; remoteTip: string } {
  const origin = scratchDirectory("rennet-snapshot-source-origin-");
  git(origin, "init", "-q", "--bare", "-b", "main");
  const root = repository("rennet-snapshot-source-");
  git(root, "remote", "add", "origin", origin);
  write(root, "package.json", JSON.stringify({ name: "fixture", private: true }));
  git(root, "add", "package.json");
  git(root, "commit", "-qm", "package.json");
  const localTip = commit(root, "index.ts", "export const value = 1;\n");
  git(root, "push", "-q", "origin", "main");

  const sibling = scratchDirectory("rennet-snapshot-source-sibling-");
  git(sibling, "clone", "-q", origin, sibling);
  git(sibling, "config", "user.email", "sibling@example.test");
  git(sibling, "config", "user.name", "Sibling");
  const remoteTip = commit(sibling, "sibling.ts", "export const sibling = 2;\n");
  git(sibling, "push", "-q", "origin", "main");

  git(root, "fetch", "-q", "origin");
  expect(git(root, "rev-parse", "main")).toBe(localTip);
  expect(git(root, "rev-parse", "origin/main")).toBe(remoteTip);
  return { root, localTip, remoteTip };
}

describe("resolveBaseRef — the branch-name tiers resolve the primary base", () => {
  it("takes the newest spelling of an explicit branch name, not git's local-first one", async () => {
    const { root, localTip, remoteTip } = staleLocalMain();

    const resolved = await resolveBaseRef(root, { git: execaGit, explicitBaseRef: "main" });

    expect(resolved.baseOid).toBe(remoteTip);
    expect(resolved.baseOid).not.toBe(localTip);
    // Which spelling won is what `baseRef` reports; the tier label is unchanged.
    expect(resolved.baseRef).toBe("origin/main");
    expect(resolved.baseRefResolution).toBe("explicit-setting");
  });

  it("takes the same commit from `origin/HEAD` when no caller names the branch", async () => {
    const { root, remoteTip } = staleLocalMain();
    git(root, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");

    const resolved = await resolveBaseRef(root, { git: execaGit });

    expect(resolved.baseOid).toBe(remoteTip);
    expect(resolved.baseRefResolution).toBe("symbolic-head");
  });

  it("takes a local branch that is AHEAD of the ref `origin/HEAD` names", async () => {
    // The case that separates this tier from the one it replaces: `origin/HEAD` still
    // names `origin/main`, and the old tier resolved that ref and stopped there. The
    // resolver reads the NAME out of `origin/HEAD` and then picks the newest spelling
    // of it, which here is the local branch (repo-map-primary-base, D1).
    const { root, remoteTip } = staleLocalMain();
    git(root, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    git(root, "checkout", "-q", "main");
    git(root, "merge", "-q", "--ff-only", "origin/main");
    const ahead = commit(root, "local.ts", "export const local = 3;\n");

    const resolved = await resolveBaseRef(root, { git: execaGit });

    expect(resolved.baseOid).toBe(ahead);
    expect(resolved.baseOid).not.toBe(remoteTip);
    expect(resolved.baseRef).toBe("main");
    expect(resolved.baseRefResolution).toBe("symbolic-head");
  });

  it("takes the local branch when it is the newer spelling", async () => {
    const { root } = staleLocalMain();
    git(root, "checkout", "-q", "main");
    git(root, "merge", "-q", "--ff-only", "origin/main");
    const ahead = commit(root, "local.ts", "export const local = 3;\n");

    const resolved = await resolveBaseRef(root, { git: execaGit, explicitBaseRef: "main" });

    expect(resolved.baseOid).toBe(ahead);
    expect(resolved.baseRef).toBe("main");
    expect(resolved.baseRefResolution).toBe("explicit-setting");
  });

  it("takes an explicit object id verbatim — it names no branch in this clone", async () => {
    const { root, localTip, remoteTip } = staleLocalMain();

    const resolved = await resolveBaseRef(root, { git: execaGit, explicitBaseRef: localTip });

    // The OID the caller pinned, NOT the newest spelling of anything.
    expect(resolved.baseOid).toBe(localTip);
    expect(resolved.baseRef).toBe(localTip);
    expect(resolved.baseOid).not.toBe(remoteTip);
    expect(resolved.baseRefResolution).toBe("explicit-setting");
  });

  it("still fails closed with no primary branch, no origin/HEAD and no upstream", async () => {
    const root = scratchDirectory("rennet-snapshot-source-orphan-");
    // No `main`, no `master`, no remote: nothing in this clone names a primary branch.
    git(root, "init", "-q", "-b", "work");
    git(root, "config", "user.email", "rennet@example.test");
    git(root, "config", "user.name", "Rennet Test");
    commit(root, "index.ts", "export const value = 1;\n");

    await expect(resolveBaseRef(root, { git: execaGit })).rejects.toThrow(
      /could not resolve the default-branch ref/,
    );
  });
});

describe("the repo-map writers agree on one base OID", () => {
  it("leaves the watcher's re-resolve matching the manifest a capture just pinned", async () => {
    const { root, localTip, remoteTip } = staleLocalMain();
    git(root, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    const store = new ProjectSnapshotStore(scratchDirectory("rennet-snapshot-source-store-"));

    // A capture whose patchset is based at the merge-base (local `main`'s tip): the pin
    // builds the default-base map and overlays to the patchset's own OID.
    await ensureProjectSnapshotPin(store, root, localTip);

    const repoKey = (await resolveBaseRef(root, { git: execaGit })).repoKey;
    const manifestBaseOid = store.loadManifest(repoKey)?.baseOid;
    // The watcher's own seam, wired exactly as `proactive-rehydration.ts` wires it:
    // the project's recorded primary branch as the explicit ref.
    const deps = baselineAdvanceDepsFor({
      repoRoot: root,
      repoKey,
      store,
      generator: new ProjectSnapshotGenerator({ store }),
      explicitBaseRef: "main",
    });

    // Equal means the watcher's no-movement rule holds: no delta pass is enqueued, and
    // the next capture finds the map already at the commit it wants. Under the old
    // local-first resolution these were `localTip` and `remoteTip` — the ping-pong.
    expect(await deps.resolveCurrentBaseOid()).toBe(manifestBaseOid);
    expect(manifestBaseOid).toBe(remoteTip);
  });
});
