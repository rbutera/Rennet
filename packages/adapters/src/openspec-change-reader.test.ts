import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readOpenSpecChange, selectedOpenSpecChangeName } from "./openspec-change-reader";

const tmpRoots: string[] = [];
afterEach(() => {
  for (const root of tmpRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Write a change on disk under a fresh temp repo root; return the root. */
function seedChange(name: string): string {
  const root = mkdtempSync(join(tmpdir(), "rennet-openspec-"));
  tmpRoots.push(root);
  const dir = join(root, "openspec", "changes", name);
  mkdirSync(join(dir, "specs", "cap-a"), { recursive: true });
  writeFileSync(
    join(dir, "proposal.md"),
    "## Why\n\nBecause it matters.\n\n## What Changes\n\n- **Thing.** the change\n",
  );
  writeFileSync(join(dir, "design.md"), "# Design\n\n## Overview\n\nThe shape.\n");
  writeFileSync(
    join(dir, "tasks.md"),
    "# Tasks\n\n## 1. Group\n\n- [x] 1.1 done\n- [ ] 1.2 todo\n",
  );
  writeFileSync(
    join(dir, "specs", "cap-a", "spec.md"),
    "## ADDED Requirements\n\n### Requirement: It works\n\nIt SHALL work.\n\n#### Scenario: happy\n\n- **WHEN** x\n- **THEN** y\n",
  );
  return root;
}

describe("selectedOpenSpecChangeName", () => {
  it("picks the change the changed paths touch under openspec/changes/", () => {
    expect(
      selectedOpenSpecChangeName(["openspec/changes/my-change/proposal.md", "src/other.ts"]),
    ).toBe("my-change");
  });

  it("is deterministic (first by sort) when a patchset touches more than one change", () => {
    expect(
      selectedOpenSpecChangeName([
        "openspec/changes/beta/tasks.md",
        "openspec/changes/alpha/proposal.md",
      ]),
    ).toBe("alpha");
  });

  it("returns null when no changed path is under openspec/changes/", () => {
    expect(selectedOpenSpecChangeName(["src/a.ts", "README.md"])).toBeNull();
  });
});

describe("readOpenSpecChange", () => {
  it("reads and parses the selected change's artifacts from the review root", async () => {
    const root = seedChange("my-change");
    const change = await readOpenSpecChange(root, [
      "openspec/changes/my-change/proposal.md",
      "openspec/changes/my-change/specs/cap-a/spec.md",
      "src/unrelated.ts",
    ]);
    expect(change).not.toBeNull();
    expect(change?.name).toBe("my-change");
    expect(change?.proposal).toBeDefined();
    expect(change?.design).toBeDefined();
    expect(change?.tasks?.total).toBe(2);
    expect(change?.tasks?.done).toBe(1);
    expect(change?.specDeltas.map((delta) => delta.capability)).toEqual(["cap-a"]);
    const requirement = change?.specDeltas[0]?.groups[0]?.requirements[0];
    expect(requirement?.name).toBe("It works");
    expect(requirement?.scenarios[0]?.steps[0]).toEqual({ keyword: "when", text: "x" });
    // A node carries its real artifact source (what makes a Spec disposition durable).
    expect(requirement?.source?.artifact).toBe("spec");
  });

  it("returns null when the reviewed patchset touches no openspec change", async () => {
    const root = seedChange("my-change");
    expect(await readOpenSpecChange(root, ["src/only.ts", "package.json"])).toBeNull();
  });

  it("omits an artifact that the change does not ship (design absent → undefined)", async () => {
    const root = mkdtempSync(join(tmpdir(), "rennet-openspec-"));
    tmpRoots.push(root);
    const dir = join(root, "openspec", "changes", "lean");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "proposal.md"), "## Why\n\nMinimal.\n");
    const change = await readOpenSpecChange(root, ["openspec/changes/lean/proposal.md"]);
    expect(change?.name).toBe("lean");
    expect(change?.proposal).toBeDefined();
    expect(change?.design).toBeUndefined();
    expect(change?.tasks).toBeUndefined();
    expect(change?.specDeltas).toEqual([]);
  });
});
