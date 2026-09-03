import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { escapePath } from "@rennet/core";
import { afterEach, describe, expect, it } from "vitest";
import type { GitExec } from "./git-range-diff";
import {
  applyVisibilitySwitch,
  ensureManagedIgnoreBlock,
  previewVisibilitySwitch,
  recordedVisibility,
} from "./map-visibility";
import { ProjectSnapshotStore } from "./project-snapshot-store";

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0))
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
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
    // The session context directory (session-context-files 2.1): Rennet's own
    // purge-on-archive scratch, never the reviewer's to stage.
    expect(written).toContain("context/");
    expect(store.loadConfig("-k")?.visibility).toBe("local");
  });

  it("git-visible stops ignoring derived data, keeps `context/`, and preserves user lines", async () => {
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
    // The reviewer's derived data is theirs to stage now — that is the whole switch.
    expect(written).not.toContain("map/");
    expect(written).not.toContain("overlays/");
    expect(written).not.toContain("knowledge/");
    // Rennet's own per-session scratch stays out at EVERY visibility: it belongs to a
    // session, is purged when that session is archived, and is never the reviewer's.
    expect(written).toContain("context/");
    expect(store.loadConfig("-k")?.visibility).toBe("git-visible");
  });

  it("REFUSES the real switch when the project config is malformed, leaving BOTH files byte-identical (Rule 75, non-vacuous)", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rennet-vis4-"));
    const storeDir = mkdtempSync(join(tmpdir(), "rennet-vis4-store-"));
    scratch.push(repo, storeDir);
    const store = new ProjectSnapshotStore(storeDir);

    // A .gitignore with NO managed block, plus a malformed project config. The
    // target is `local` DELIBERATELY: it ADDS the managed block, so the switch's
    // write branch genuinely WOULD run (`preview.changed === true`). That is what
    // makes this non-vacuous — if the pre-write malformed guard were removed, the
    // `.gitignore` would actually be rewritten before `updateConfig` throws, and
    // the byte-identical assertion below would go red.
    mkdirSync(join(repo, ".rennet"), { recursive: true });
    const gitignore = join(repo, ".rennet", ".gitignore");
    const gitignoreBefore = "# untouched\nkeep.local\n";
    writeFileSync(gitignore, gitignoreBefore);
    // Sanity: this exact switch DOES change the file (the write branch is live).
    const preview = await previewVisibilitySwitch(repo, "local", readOnlyGit());
    expect(preview.changed).toBe(true);
    const configPath = store.paths("-k").configPath;
    mkdirSync(join(configPath, ".."), { recursive: true });
    const configBefore = '{ "version": 1, "visibility": "loc'; // truncated, unparseable
    writeFileSync(configPath, configBefore);

    // The REAL write path throws rather than half-applying.
    await expect(applyVisibilitySwitch(store, "-k", repo, "local", readOnlyGit())).rejects.toThrow(
      /malformed/,
    );

    // Neither file was touched — this is what makes the guard non-vacuous.
    expect(readFileSync(gitignore, "utf8")).toBe(gitignoreBefore);
    expect(readFileSync(configPath, "utf8")).toBe(configBefore);
  });
});

describe("ensureManagedIgnoreBlock (session-context-files 2.1)", () => {
  it("writes the managed block with `context/` into a repo Rennet has never mapped", () => {
    const repo = mkdtempSync(join(tmpdir(), "rennet-ensure-"));
    scratch.push(repo);

    expect(ensureManagedIgnoreBlock(repo)).toBe(true);
    const written = readFileSync(join(repo, ".rennet", ".gitignore"), "utf8");
    expect(written).toContain("rennet-managed");
    // The load-bearing entry: without this line a `git add -A` in the reviewer's own
    // checkout stages the session's context files. The control proving a MISSING entry
    // really does stage them is the never-staged pair in `packages/server`'s
    // `context-files.test.ts`, which runs a real `git add -A` with and without it.
    expect(written).toContain("context/");
  });

  it("recordedVisibility answers what the store holds, and `local` when it holds nothing", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rennet-recvis-"));
    const storeDir = mkdtempSync(join(tmpdir(), "rennet-recvis-store-"));
    scratch.push(repo, storeDir);
    const store = new ProjectSnapshotStore(storeDir);

    // A repo the store has never heard of is `local` — the default it would have had.
    expect(recordedVisibility(store, repo)).toBe("local");

    await applyVisibilitySwitch(store, escapePath(realpathSync(repo)), repo, "git-visible", () =>
      Promise.resolve(""),
    );
    expect(recordedVisibility(store, repo)).toBe("git-visible");
  });

  it("is idempotent: a second call writes nothing and leaves the file byte-identical", () => {
    const repo = mkdtempSync(join(tmpdir(), "rennet-ensure2-"));
    scratch.push(repo);

    ensureManagedIgnoreBlock(repo);
    const path = join(repo, ".rennet", ".gitignore");
    const first = readFileSync(path, "utf8");
    expect(ensureManagedIgnoreBlock(repo)).toBe(false);
    expect(readFileSync(path, "utf8")).toBe(first);
  });

  it("at `git-visible` leaves the derived-data entries OUT while still ignoring `context/`", () => {
    const repo = mkdtempSync(join(tmpdir(), "rennet-ensure-vis-"));
    scratch.push(repo);
    mkdirSync(join(repo, ".rennet"), { recursive: true });
    // What a repo the reviewer switched to `git-visible` looks like on disk.
    writeFileSync(
      join(repo, ".rennet", ".gitignore"),
      "# >>> rennet-managed (do not edit) >>>\ncontext/\n# <<< rennet-managed <<<\n",
    );

    // Nothing to do: `context/` is already there, and the derived entries must NOT come back.
    expect(ensureManagedIgnoreBlock(repo, "git-visible")).toBe(false);
    const written = readFileSync(join(repo, ".rennet", ".gitignore"), "utf8");
    expect(written).not.toContain("map/");
    expect(written).toContain("context/");

    // CONTROL: the same call at `local` — the visibility argument is load-bearing, not
    // decoration. Composing at a fixed `"local"` is exactly the bug: it silently undid a
    // `git-visible` switch while the settings store still read git-visible.
    expect(ensureManagedIgnoreBlock(repo, "local")).toBe(true);
    expect(readFileSync(join(repo, ".rennet", ".gitignore"), "utf8")).toContain("map/");
  });

  it("preserves user-authored lines and rewrites a stale managed block in place", () => {
    const repo = mkdtempSync(join(tmpdir(), "rennet-ensure3-"));
    scratch.push(repo);
    mkdirSync(join(repo, ".rennet"), { recursive: true });
    writeFileSync(
      join(repo, ".rennet", ".gitignore"),
      // A block written before `context/` existed — what an already-installed Rennet has.
      "# my own note\nscratch.local\n\n# >>> rennet-managed (do not edit) >>>\nmap/\n# <<< rennet-managed <<<\n",
    );

    expect(ensureManagedIgnoreBlock(repo)).toBe(true);
    const written = readFileSync(join(repo, ".rennet", ".gitignore"), "utf8");
    expect(written).toContain("# my own note");
    expect(written).toContain("scratch.local");
    expect(written).toContain("context/");
    // One managed block, not two.
    expect(written.match(/rennet-managed \(do not edit\)/g)).toHaveLength(1);
  });
});
