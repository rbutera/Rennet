import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { GitExec } from "./git-range-diff";
import { applyVisibilitySwitch, previewVisibilitySwitch } from "./map-visibility";
import { ProjectSnapshotStore } from "./project-snapshot-store";

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * A git stub that DISALLOWS every mutating command — it throws on anything but a
 * read-only `ls-files`. This is how we assert the visibility switch never stages,
 * un-stages, or commits (spec A.2: "the git index is unchanged").
 */
function readOnlyGit(tracked: string[] = []): GitExec {
  return async (_root, args) => {
    if (args[0] !== "ls-files") {
      throw new Error(`visibility switch ran a mutating git command: git ${args.join(" ")}`);
    }
    return tracked.map((path) => `${path}\0`).join("");
  };
}

describe("map-visibility switch (A.2)", () => {
  it("previews the exclusion state and discloses pre-tracked files, writing nothing", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rennet-vis-"));
    scratch.push(repo);
    const preview = await previewVisibilitySwitch(
      repo,
      "local",
      readOnlyGit([".rennet/map/manifest.json"]),
    );
    expect(preview.target).toBe("local");
    expect(preview.before).toBe("");
    expect(preview.after).toContain("map/");
    expect(preview.after).toContain("rennet-managed");
    expect(preview.changed).toBe(true);
    expect(preview.preTracked).toEqual([".rennet/map/manifest.json"]);
    // Preview writes nothing.
    expect(() => readFileSync(join(repo, ".rennet", ".gitignore"), "utf8")).toThrow();
  });

  it("apply writes the Rennet-managed .gitignore + records config, never mutating git", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rennet-vis2-"));
    const storeDir = mkdtempSync(join(tmpdir(), "rennet-vis2-store-"));
    scratch.push(repo, storeDir);
    const store = new ProjectSnapshotStore(storeDir);

    await applyVisibilitySwitch(store, "-k", repo, "local", readOnlyGit());
    const written = readFileSync(join(repo, ".rennet", ".gitignore"), "utf8");
    expect(written).toContain("map/");
    expect(written).toContain("overlays/");
    expect(written).toContain("knowledge/");
    expect(store.loadConfig("-k")?.visibility).toBe("local");
  });

  it("git-visible removes the managed block but preserves user-authored lines", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rennet-vis3-"));
    const storeDir = mkdtempSync(join(tmpdir(), "rennet-vis3-store-"));
    scratch.push(repo, storeDir);
    const store = new ProjectSnapshotStore(storeDir);

    // Seed a .gitignore with a user line + a stale managed block.
    mkdirSync(join(repo, ".rennet"), { recursive: true });
    writeFileSync(
      join(repo, ".rennet", ".gitignore"),
      "# my own note\nscratch.local\n\n# >>> rennet-managed (do not edit) >>>\nmap/\n# <<< rennet-managed <<<\n",
    );

    await applyVisibilitySwitch(store, "-k", repo, "git-visible", readOnlyGit());
    const written = readFileSync(join(repo, ".rennet", ".gitignore"), "utf8");
    expect(written).toContain("# my own note");
    expect(written).toContain("scratch.local");
    expect(written).not.toContain("rennet-managed");
    expect(written).not.toContain("map/");
    expect(store.loadConfig("-k")?.visibility).toBe("git-visible");
  });

  it("REFUSES the real switch when the project config is malformed, leaving BOTH files byte-identical (Rule 75, non-vacuous)", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rennet-vis4-"));
    const storeDir = mkdtempSync(join(tmpdir(), "rennet-vis4-store-"));
    scratch.push(repo, storeDir);
    const store = new ProjectSnapshotStore(storeDir);

    // A user-authored .gitignore that the switch WOULD rewrite, and a malformed
    // project config that the switch WOULD overwrite via updateConfig.
    mkdirSync(join(repo, ".rennet"), { recursive: true });
    const gitignore = join(repo, ".rennet", ".gitignore");
    const gitignoreBefore = "# untouched\nkeep.local\n";
    writeFileSync(gitignore, gitignoreBefore);
    const configPath = store.paths("-k").configPath;
    mkdirSync(join(configPath, ".."), { recursive: true });
    const configBefore = '{ "version": 1, "visibility": "loc'; // truncated, unparseable
    writeFileSync(configPath, configBefore);

    // The REAL write path throws rather than half-applying.
    await expect(
      applyVisibilitySwitch(store, "-k", repo, "git-visible", readOnlyGit()),
    ).rejects.toThrow(/malformed/);

    // Neither file was touched — this is what makes the guard non-vacuous.
    expect(readFileSync(gitignore, "utf8")).toBe(gitignoreBefore);
    expect(readFileSync(configPath, "utf8")).toBe(configBefore);
  });
});
