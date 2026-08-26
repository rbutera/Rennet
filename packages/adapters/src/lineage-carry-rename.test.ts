import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { carryDispositionsByLineage, fileContentDigest } from "@rennet/core";
import type { Disposition } from "@rennet/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GitCaptureAdapter } from "./git-capture";

// win32 git operations on a cold disk exceed vitest's 5s default (measured 6-11s on
// lancelot); give this git-heavy suite room. Not a hang — the same tests pass fast on
// macOS/Linux and complete well under this ceiling on Windows.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

// Issue #16 High 3: prove with an ADAPTER-PRODUCED rename (not a synthetic
// `"X"`/`"X"` patch adapters never emit) that a real git rename does NOT carry a
// disposition onto the new path. A real rename's patch differs from the original
// in its `diff --git`/`index` headers, so continuation cannot be byte-verified —
// the disposition reopens (or orphans if the diff reports delete+add), and in
// neither case does the approval land on the renamed file. The safe invariant is
// asserted directly, independent of whether git's diff detected the rename.

const directories: string[] = [];

function git(root: string, ...arguments_: string[]): string {
  return execFileSync("git", arguments_, { cwd: root, encoding: "utf8" });
}

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("disposition carry across an adapter-produced git rename (issue #16)", () => {
  it("never carries an approval onto the renamed file — it reopens, never a wrong carry", async () => {
    const root = mkdtempSync(join(tmpdir(), "rennet-rename-"));
    directories.push(root);
    git(root, "init", "-q", "-b", "main");
    git(root, "config", "user.email", "rennet@example.test");
    git(root, "config", "user.name", "Rennet Test");
    writeFileSync(join(root, "old.ts"), "alpha\nbeta\n");
    git(root, "add", "old.ts");
    git(root, "commit", "-qm", "base");

    // Patchset 1: change old.ts on a feature branch, so a reviewer disposes on it.
    git(root, "checkout", "-qb", "feature");
    writeFileSync(join(root, "old.ts"), "alpha\nbeta\ngamma\n");
    git(root, "commit", "-qam", "edit old.ts");
    const adapter = new GitCaptureAdapter();
    const p1 = await adapter.capture(root);
    const oldFile = p1.files.find((file) => file.path === "old.ts");
    if (!oldFile) throw new Error("old.ts not captured in patchset 1");
    const approval: Disposition = {
      anchor: { path: "old.ts", contentDigest: fileContentDigest(oldFile) },
      type: "approve",
      body: "",
    };

    // Patchset 2: rename old.ts → new.ts (content unchanged from patchset 1).
    git(root, "mv", "old.ts", "new.ts");
    git(root, "commit", "-qm", "rename old.ts to new.ts");
    const p2 = await adapter.capture(root);

    // Sanity: the rename really happened at the adapter layer.
    expect(p2.files.some((file) => file.path === "new.ts")).toBe(true);

    const { carried, orphaned } = carryDispositionsByLineage([approval], p2);

    // THE SAFE INVARIANT: the approval never lands on the renamed file.
    expect(carried.map((d) => d.anchor.path)).not.toContain("new.ts");
    // And it does not carry at all — it reopens (dropped) or orphans; never a
    // wrong carry onto content the reviewer did not approve at that location.
    expect(carried).toEqual([]);
    expect([...carried, ...orphaned].length).toBeLessThanOrEqual(1);
  });
});
