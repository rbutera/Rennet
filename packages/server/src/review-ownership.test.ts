import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  execaGit,
  ProjectSnapshotGenerator,
  ProjectSnapshotStore,
  resolveBaseRef,
} from "@rennet/adapters";
import type { Review } from "@rennet/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { loadReviewOwnership, type ReviewOwnershipDeps } from "./review-ownership";

// Covers the LIVE builder path (issue #35, F4): the blast-radius CODEOWNERS-overlap
// signal was dead in the real app because the composition never handed the pipeline
// ownership — a green producer test could not see it. This builds a REAL snapshot
// from a temp repo whose CODEOWNERS spans two owner groups, then reads the rules back
// through the exact chain the composition uses (resolveBaseRef → loadManifest →
// materialize → the ownership shard), so a regression that stops threading ownership
// reddens here.

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function write(root: string, path: string, content: string): void {
  const full = join(root, path);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
}

/** A minimal repo whose CODEOWNERS spans TWO owner groups (a real cross-owner file). */
function ownedRepo(): { root: string; storeDir: string; oid: string } {
  const root = mkdtempSync(join(tmpdir(), "rennet-own-"));
  const storeDir = mkdtempSync(join(tmpdir(), "rennet-ownstore-"));
  scratch.push(root, storeDir);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "rennet@example.test");
  git(root, "config", "user.name", "Rennet Test");
  write(root, "pnpm-workspace.yaml", 'packages:\n  - "packages/*"\n');
  write(root, "CODEOWNERS", "* @team/maintainers\npackages/a/** @team/a-owners\n");
  write(root, "packages/a/package.json", JSON.stringify({ name: "@t/a", private: true }));
  write(root, "packages/a/src/index.ts", "export const a = 1;\n");
  write(root, "packages/b/package.json", JSON.stringify({ name: "@t/b", private: true }));
  write(root, "packages/b/src/index.ts", "export const b = 1;\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "init");
  return { root, storeDir, oid: git(root, "rev-parse", "HEAD") };
}

function reviewFor(root: string): Pick<Review, "repositoryRoot"> {
  return { repositoryRoot: root };
}

describe("loadReviewOwnership — CODEOWNERS reach the blast-radius signal (F4)", () => {
  it("returns the built snapshot's ownership rules spanning both owner groups", async () => {
    const { root, storeDir, oid } = ownedRepo();
    const store = new ProjectSnapshotStore(storeDir);
    await new ProjectSnapshotGenerator({ store }).generate(root, { explicitBaseRef: oid });

    const deps: ReviewOwnershipDeps = {
      loadManifest: (repoKey) => store.loadManifest(repoKey),
      loadShard: (repoKey, digest) => store.loadShard(repoKey, digest),
      // The REAL resolver the composition uses — this is the chain F4 restores.
      resolveRepoKey: async (repositoryRoot) =>
        (await resolveBaseRef(repositoryRoot, { git: execaGit, explicitBaseRef: "main" })).repoKey,
    };

    const ownership = await loadReviewOwnership(deps, reviewFor(root));
    expect(ownership.map((rule) => rule.pattern)).toEqual(["*", "packages/a/**"]);
    // Two DISTINCT owner groups — exactly what makes the overlap signal fire.
    const owners = new Set(ownership.flatMap((rule) => [...rule.owners]));
    expect(owners).toEqual(new Set(["@team/maintainers", "@team/a-owners"]));
  });

  it("returns [] with no built snapshot — the signal degrades honestly, never a false single-owner claim", async () => {
    const { root, storeDir } = ownedRepo();
    const store = new ProjectSnapshotStore(storeDir); // never generated → no manifest
    const deps: ReviewOwnershipDeps = {
      loadManifest: (repoKey) => store.loadManifest(repoKey),
      loadShard: (repoKey, digest) => store.loadShard(repoKey, digest),
      resolveRepoKey: async (repositoryRoot) =>
        (await resolveBaseRef(repositoryRoot, { git: execaGit, explicitBaseRef: "main" })).repoKey,
    };
    expect(await loadReviewOwnership(deps, reviewFor(root))).toEqual([]);
  });

  it("returns [] when the repo key cannot be resolved (no throw)", async () => {
    const { root, storeDir } = ownedRepo();
    const store = new ProjectSnapshotStore(storeDir);
    const deps: ReviewOwnershipDeps = {
      loadManifest: (repoKey) => store.loadManifest(repoKey),
      loadShard: (repoKey, digest) => store.loadShard(repoKey, digest),
      resolveRepoKey: async () => null,
    };
    expect(await loadReviewOwnership(deps, reviewFor(root))).toEqual([]);
  });
});
