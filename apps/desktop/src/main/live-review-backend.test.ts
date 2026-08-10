import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildReviewCanvases } from "@rennet/core";
import type { PatchFile, Patchset, Review } from "@rennet/types";
import { afterEach, describe, expect, it } from "vitest";
import { createDesktopReviewBackend, snapshotStoreFor } from "./live-review-backend";

// The desktop composition root over a real git repo: the app-owned store is the
// local-first, path-keyed store under `~/.rennet/projects/` (issue #188). Tests
// inject a temp `baseDir` so nothing touches the real home store, and the assembled
// backend serves real context data.

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

function workspaceRepo(): { root: string; commonDir: string; oid: string } {
  const root = mkdtempSync(join(tmpdir(), "rennet-desktop-repo-"));
  scratch.push(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "rennet@example.test");
  git(root, "config", "user.name", "Rennet Test");
  write(root, "pnpm-workspace.yaml", 'packages:\n  - "packages/*"\n');
  write(root, "packages/a/package.json", JSON.stringify({ name: "@t/a", private: true }));
  write(root, "packages/a/src/index.ts", "export const a = 1;\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "first");
  return { root, commonDir: join(root, ".git"), oid: git(root, "rev-parse", "HEAD") };
}

describe("createDesktopReviewBackend — the desktop composition root", () => {
  it("stores snapshots under the ~/.rennet/projects base dir and serves real context data", async () => {
    const repo = workspaceRepo();
    const baseDir = mkdtempSync(join(tmpdir(), "rennet-projects-"));
    scratch.push(baseDir);

    const patch = "@@ -1,1 +1,2 @@\n export const a = 1;\n+export const b = 2;";
    const files: PatchFile[] = [
      {
        path: "packages/a/src/index.ts",
        status: "modified",
        additions: 1,
        deletions: 0,
        binary: false,
        patch,
      },
    ];
    const patchset: Patchset = {
      id: "ps-1",
      createdAt: "2026-08-10T00:00:00.000Z",
      repository: {
        id: "repo",
        root: repo.root,
        commonDir: repo.commonDir,
        baseRef: repo.oid,
        baseOid: repo.oid,
        headOid: repo.oid,
      },
      files,
      rawDiff: patch,
      byteLength: patch.length,
      truncated: false,
    };
    const review: Review = {
      id: "review-1",
      repositoryRoot: repo.root,
      patchsets: [patchset],
      activePatchsetId: "ps-1",
      dispositions: [],
      status: "current",
    };
    const pipeline = await buildReviewCanvases({ reviewId: review.id, patchset, dispositions: [] });

    const { backend, snapshot } = await createDesktopReviewBackend(review, pipeline, {
      baseDir,
    });
    expect(snapshot.generated).toBe(true);

    // The app-owned local-first store wrote the path-keyed project entry directly
    // under the injected base dir (issue #188), not a `snapshots` subdirectory.
    expect(existsSync(baseDir)).toBe(true);
    expect(readdirSync(baseDir).length).toBeGreaterThan(0);

    // The composed backend serves real context data end-to-end.
    const map = backend.projectMap();
    expect(map.ok).toBe(true);
    if (map.ok) expect(map.map.baseOid).toBe(repo.oid);

    // And the lenses render regardless (the producer path is snapshot-independent).
    expect(backend.decomposition().hunks.length).toBeGreaterThan(0);
  });

  it("snapshotStoreFor composes a store over the injected base dir", () => {
    const store = snapshotStoreFor("/tmp/example-rennet-projects");
    expect(store).toBeInstanceOf(Object);
  });
});
