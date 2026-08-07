import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decompose } from "@rennet/core";
import { afterEach, describe, expect, it } from "vitest";
import { captureRangePatchset, execaGit } from "./git-range-diff";

const directories: string[] = [];

function git(root: string, ...arguments_: string[]): string {
  return execFileSync("git", arguments_, { cwd: root, encoding: "utf8" });
}

/** A repo with a base commit on `main` and a feature commit on `feature`. */
function repositoryWithRange(): { root: string; baseOid: string; headOid: string } {
  const root = mkdtempSync(join(tmpdir(), "rennet-range-"));
  directories.push(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "rennet@example.test");
  git(root, "config", "user.name", "Rennet Test");
  writeFileSync(join(root, "app.ts"), "export const a = 1;\n");
  git(root, "add", "app.ts");
  git(root, "commit", "-qm", "base");
  const baseOid = git(root, "rev-parse", "HEAD").trim();
  git(root, "checkout", "-qb", "feature");
  writeFileSync(join(root, "app.ts"), "export const a = 1;\nexport const b = 2;\n");
  writeFileSync(join(root, "added.ts"), "export const c = 3;\n");
  git(root, "add", "app.ts", "added.ts");
  git(root, "commit", "-qm", "feature");
  const headOid = git(root, "rev-parse", "HEAD").trim();
  return { root, baseOid, headOid };
}

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("captureRangePatchset", () => {
  it("produces a rawDiff byte-identical to `git diff base...head`", async () => {
    const { root, baseOid, headOid } = repositoryWithRange();
    const patchset = await captureRangePatchset(execaGit, {
      root,
      baseOid,
      headOid,
      baseRef: "main",
    });
    // On a fresh repo (no diff.* config), the adapter's determinism flags
    // (--no-ext-diff --no-textconv) are no-ops, so its rawDiff equals a bare
    // `git diff base...head` byte-for-byte. That is the acceptance criterion.
    const bare = git(root, "diff", `${baseOid}...${headOid}`);
    expect(patchset.rawDiff).toBe(bare);
    expect(patchset.source).toBe("github-local");
    expect(patchset.degraded).toBeUndefined();
  });

  it("uses three-dot base...head semantics (an advanced base leaks no base-only changes)", async () => {
    // A PR's diff is `git diff base...head` (three-dot): the change relative to the
    // MERGE-BASE, exactly what GitHub renders — NOT `base..head` (two-dot), which
    // would fold the base branch's own advancement in as spurious deletions.
    const root = mkdtempSync(join(tmpdir(), "rennet-threedot-"));
    directories.push(root);
    git(root, "init", "-q", "-b", "main");
    git(root, "config", "user.email", "rennet@example.test");
    git(root, "config", "user.name", "Rennet Test");
    writeFileSync(join(root, "app.ts"), "export const a = 1;\n");
    git(root, "add", "app.ts");
    git(root, "commit", "-qm", "merge-base");
    // The PR head branches from the merge-base and adds `b`.
    git(root, "checkout", "-qb", "feature");
    writeFileSync(join(root, "app.ts"), "export const a = 1;\nexport const b = 2;\n");
    git(root, "add", "app.ts");
    git(root, "commit", "-qm", "feature: add b");
    const headOid = git(root, "rev-parse", "HEAD").trim();
    // Meanwhile the base branch ADVANCES past the merge-base with its own new file.
    git(root, "checkout", "-q", "main");
    writeFileSync(join(root, "base-only.ts"), "export const m = 1;\n");
    git(root, "add", "base-only.ts");
    git(root, "commit", "-qm", "main advances");
    const baseOid = git(root, "rev-parse", "HEAD").trim();

    const patchset = await captureRangePatchset(execaGit, {
      root,
      baseOid,
      headOid,
      baseRef: "main",
    });

    const threeDot = git(root, "diff", `${baseOid}...${headOid}`);
    const twoDot = git(root, "diff", `${baseOid}..${headOid}`);
    // The fixture genuinely distinguishes the two semantics (guards against a
    // vacuous linear-history test where `..` == `...`).
    expect(threeDot).not.toBe(twoDot);
    // The adapter must produce the three-dot bytes...
    expect(patchset.rawDiff).toBe(threeDot);
    // ...so the base branch's own file never appears as a spurious deletion.
    expect(patchset.files.map((file) => file.path)).toEqual(["app.ts"]);
    expect(patchset.rawDiff).not.toContain("base-only.ts");
  });

  it("captures the changed files with counts and status", async () => {
    const { root, baseOid, headOid } = repositoryWithRange();
    const patchset = await captureRangePatchset(execaGit, {
      root,
      baseOid,
      headOid,
      baseRef: "main",
    });
    expect(patchset.files.map((file) => file.path)).toEqual(["added.ts", "app.ts"]);
    const added = patchset.files.find((file) => file.path === "added.ts");
    expect(added?.status).toBe("added");
    const app = patchset.files.find((file) => file.path === "app.ts");
    expect(app?.status).toBe("modified");
    expect(app?.additions).toBe(1);
  });

  it("is immutable: two captures of the same pinned OIDs share an identity", async () => {
    const { root, baseOid, headOid } = repositoryWithRange();
    const first = await captureRangePatchset(execaGit, { root, baseOid, headOid, baseRef: "main" });
    const second = await captureRangePatchset(execaGit, {
      root,
      baseOid,
      headOid,
      baseRef: "main",
    });
    expect(second.id).toBe(first.id);
    expect(second.rawDiff).toBe(first.rawDiff);
  });

  it("feeds the same canvases: the patchset decomposes with totality over its files", async () => {
    const { root, baseOid, headOid } = repositoryWithRange();
    const patchset = await captureRangePatchset(execaGit, {
      root,
      baseOid,
      headOid,
      baseRef: "main",
    });
    const decomposition = decompose(patchset);
    // Every hunk is placed in exactly one chunk (or residue) — the decomposition
    // floor's totality guarantee, identical to a locally-captured patchset.
    const placed = new Set<string>();
    for (const chunk of decomposition.chunks) for (const id of chunk.hunkIds) placed.add(id);
    for (const item of decomposition.residue) placed.add(item.hunkId);
    expect(placed.size).toBe(decomposition.hunks.length);
    expect(decomposition.hunks.length).toBeGreaterThan(0);
    const files = new Set(decomposition.chunks.flatMap((chunk) => chunk.filePaths));
    expect(files).toContain("app.ts");
    expect(files).toContain("added.ts");
  });
});
