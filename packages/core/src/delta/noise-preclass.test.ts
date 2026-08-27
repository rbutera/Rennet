import type { PatchFile } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import { buildHunkIndex } from "./hunk-index";
import { preclassifyNoise } from "./noise-preclass";

function file(path: string): PatchFile {
  return {
    path,
    status: "modified",
    additions: 1,
    deletions: 1,
    binary: false,
    patch: ["@@ -1,2 +1,2 @@", " unchanged", "-old", "+new"].join("\n"),
  };
}

function factsFor(path: string) {
  return preclassifyNoise(buildHunkIndex({ files: [file(path)] }));
}

describe("preclassifyNoise", () => {
  it.each([
    ["pnpm-lock.yaml", "lockfile"],
    ["sub/package-lock.json", "lockfile"],
    ["openspec/changes/b05/tasks.openspec.yaml", "generated-scaffold"],
    ["dist/bundle.js", "generated-output"],
    ["assets/app.min.js", "generated-output"],
    ["assets/app.js.map", "generated-output"],
  ] as const)("%s fires the %s rule", (path, rule) => {
    const facts = factsFor(path);
    expect(facts).toHaveLength(1);
    expect(facts[0]?.rule).toBe(rule);
    // The fact carries WHICH rule judged it and the path it judged.
    expect(facts[0]?.reason).toContain(path);
  });

  it("yields no fact for a plain source hunk", () => {
    expect(factsFor("packages/core/src/delta/hunk-index.ts")).toEqual([]);
  });

  it.each([["routes.map"], ["build/config.ts"], ["generated/schema.ts"]])(
    "does not overreach: hand-authorable path %s yields no fact",
    (path) => {
      expect(factsFor(path)).toEqual([]);
    },
  );

  it("stamps every hunk of a matching file, addressed by hunk id", () => {
    const patch = ["@@ -1,2 +1,2 @@", " a", "-b", "+c", "@@ -9,2 +9,2 @@", " d", "-e", "+f"].join(
      "\n",
    );
    const index = buildHunkIndex({
      files: [{ ...file("yarn.lock"), patch }, file("src/real.ts")],
    });
    const facts = preclassifyNoise(index);
    expect(facts.map((f) => f.hunkId)).toEqual(
      index.hunks.filter((h) => h.path === "yarn.lock").map((h) => h.id),
    );
    expect(facts).toHaveLength(2);
  });
});
