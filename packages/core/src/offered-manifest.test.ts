import type { PatchFile, Patchset } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import { decompose } from "./decomposition";
import { buildOfferedManifest } from "./offered-manifest";

// ── A tiny real changeset: b.ts imports a.ts, plus one lockfile (mechanical) ─

function file(path: string, patch: string, extra: Partial<PatchFile> = {}): PatchFile {
  return {
    path,
    status: "modified",
    additions: null,
    deletions: null,
    binary: false,
    patch,
    ...extra,
  };
}

function patch(path: string, lines: string[]): string {
  const oldCount = lines.filter((l) => l[0] === "-" || l[0] === " ").length;
  const newCount = lines.filter((l) => l[0] === "+" || l[0] === " ").length;
  return (
    `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n` +
    `@@ -1,${oldCount} +1,${newCount} @@\n${lines.join("\n")}\n`
  );
}

const PATCHSET: Patchset = {
  id: "ps_1",
  createdAt: "2026-01-01T00:00:00.000Z",
  repository: {
    id: "repo",
    root: "/repo",
    commonDir: "/repo/.git",
    baseRef: "origin/main",
    baseOid: "0".repeat(40),
    headOid: "1".repeat(40),
  },
  files: [
    file("src/a.ts", patch("src/a.ts", ["+export const a = 1;"])),
    file("src/b.ts", patch("src/b.ts", ['+import { a } from "./a";', "+export const b = a + 1;"])),
    file("pnpm-lock.yaml", patch("pnpm-lock.yaml", ["+  resolution: {integrity: sha512-xxx}"])),
  ],
  rawDiff: "",
  byteLength: 0,
  truncated: false,
};

const DECOMPOSITION = decompose(PATCHSET);

describe("buildOfferedManifest", () => {
  it("offers exactly the substantive hunks (mechanical hunks are the noise floor's)", () => {
    const manifest = buildOfferedManifest(DECOMPOSITION);
    const substantiveHunkIds = DECOMPOSITION.classifications
      .filter((classification) => classification.kind === "substantive")
      .map((classification) => classification.hunkId);
    expect(manifest.occurrences.map((occurrence) => occurrence.id).sort()).toEqual(
      [...substantiveHunkIds].sort(),
    );
    expect(manifest.occurrences.every((occurrence) => occurrence.kind === "hunk")).toBe(true);
    // The lockfile hunk is mechanical, so it is not offered.
    expect(manifest.occurrences.length).toBeLessThan(DECOMPOSITION.hunks.length);
  });
});
