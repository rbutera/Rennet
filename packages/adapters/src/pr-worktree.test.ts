import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { execaGit } from "./git-range-diff";
import {
  assertWorktreePattern,
  branchWorktreePath,
  defaultWorktreePlacement,
  ensurePrWorktree,
  prWorktreePath,
  readSetupLogTail,
  readSetupStatus,
  renderWorktreePattern,
  resolveWorktreeRoot,
  runPrWorktreeSetup,
} from "./pr-worktree";

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0))
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

/** A repo with two commits; returns both OIDs (the "old head" and "new head"). */
function repo(): { root: string; dataDir: string; firstOid: string; secondOid: string } {
  const root = mkdtempSync(join(tmpdir(), "rennet-prwt-"));
  const dataDir = mkdtempSync(join(tmpdir(), "rennet-prwt-data-"));
  scratch.push(root, dataDir);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "rennet@example.test");
  git(root, "config", "user.name", "Rennet Test");
  writeFileSync(join(root, "a.txt"), "one\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "one");
  const firstOid = git(root, "rev-parse", "HEAD");
  writeFileSync(join(root, "a.txt"), "two\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "two");
  const secondOid = git(root, "rev-parse", "HEAD");
  return { root, dataDir, firstOid, secondOid };
}

describe("ensurePrWorktree", () => {
  it("creates a detached worktree at the head OID, and a re-open reuses it", async () => {
    const { root, dataDir, firstOid } = repo();
    const placement = defaultWorktreePlacement(dataDir);
    const path = prWorktreePath(placement.root, placement.prPattern, {
      owner: "acme",
      name: "widget",
      number: 7,
    });
    const first = await ensurePrWorktree(execaGit, root, path, firstOid);
    expect(first).toEqual({ path, created: true });
    expect(readFileSync(join(path, "a.txt"), "utf8")).toBe("one\n");
    const again = await ensurePrWorktree(execaGit, root, path, firstOid);
    expect(again.created).toBe(false); // setup will not re-run on a plain re-open
  });

  it("replaces the checkout when the reviewed head is superseded", async () => {
    const { root, dataDir, firstOid, secondOid } = repo();
    const placement = defaultWorktreePlacement(dataDir);
    const path = prWorktreePath(placement.root, placement.prPattern, {
      owner: "acme",
      name: "widget",
      number: 7,
    });
    await ensurePrWorktree(execaGit, root, path, firstOid);
    const replaced = await ensurePrWorktree(execaGit, root, path, secondOid);
    expect(replaced.created).toBe(true);
    expect(readFileSync(join(path, "a.txt"), "utf8")).toBe("two\n");
  });
});

describe("runPrWorktreeSetup", () => {
  function worktreeWithSetup(lines: string): string {
    const dir = mkdtempSync(join(tmpdir(), "rennet-setup-"));
    scratch.push(dir);
    mkdirSync(join(dir, ".rennet"), { recursive: true });
    writeFileSync(join(dir, ".rennet", "setup"), lines);
    return dir;
  }

  it("reports `none` (and runs nothing) when there is no setup file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rennet-setup-"));
    scratch.push(dir);
    expect(await runPrWorktreeSetup(dir)).toEqual({ status: "none" });
    expect(readSetupStatus(dir)).toEqual({ status: "none" });
  });

  it("runs commands sequentially in the worktree, records ok + the log", async () => {
    const dir = worktreeWithSetup("# bootstrap\necho hello > out.txt\necho done\n");
    const status = await runPrWorktreeSetup(dir);
    expect(status).toEqual({ status: "ok" });
    expect(readSetupStatus(dir)).toEqual({ status: "ok" });
    expect(readFileSync(join(dir, "out.txt"), "utf8")).toBe("hello\n");
    expect(readSetupLogTail(dir)).toContain("done");
  });

  it("records the failing command + exit code and stops (setup never throws)", async () => {
    const dir = worktreeWithSetup("exit 3\necho never > never.txt\n");
    const status = await runPrWorktreeSetup(dir);
    expect(status).toEqual({ status: "failed", command: "exit 3", exitCode: 3 });
    expect(readSetupStatus(dir)).toEqual({ status: "failed", command: "exit 3", exitCode: 3 });
    expect(existsSync(join(dir, "never.txt"))).toBe(false); // later commands did not run
  });
});

describe("worktree placement (workspace-settings D1/D2)", () => {
  const dataDir = "/data";
  const placement = defaultWorktreePlacement(dataDir);

  it("the two builtin patterns reproduce the previous release's paths BYTE-FOR-BYTE", () => {
    // The literals on the right are the shapes the old signatures hardcoded:
    // `join(dataDir, "worktrees", repoKey, ...branch.split("/"))` and
    // `join(dataDir, "worktrees", owner, name, `pr-${n}`)`. An install that has never
    // touched a rung must place nothing differently, so these are written out rather
    // than recomputed from the same helper that produces them.
    expect(
      branchWorktreePath(placement.root, placement.pattern, {
        repo: "-Users-rai-orbital",
        name: "orbital",
        branch: "feat/thing",
      }),
    ).toBe(join(dataDir, "worktrees", "-Users-rai-orbital", "feat", "thing"));
    expect(
      prWorktreePath(placement.root, placement.prPattern, {
        owner: "acme",
        name: "widget",
        number: 7,
      }),
    ).toBe(join(dataDir, "worktrees", "acme", "widget", "pr-7"));
    // The branch keeps its slashes as SEPARATORS, so `feat/a-b` and `feat-a-b` stay two
    // directories — the mapping is injective, exactly as before.
    expect(
      branchWorktreePath(placement.root, placement.pattern, { repo: "k", branch: "feat-a-b" }),
    ).toBe(join(dataDir, "worktrees", "k", "feat-a-b"));
  });

  it("a custom pattern places by its own tokens", () => {
    expect(
      branchWorktreePath("/trees", "{owner}/{name}/{branch}", {
        repo: "-Users-rai-orbital",
        name: "orbital",
        owner: "acme",
        branch: "feat/x",
      }),
    ).toBe(join("/trees", "acme", "orbital", "feat", "x"));
    expect(
      prWorktreePath("/trees", "{repo}/pr-{number}", { repo: "-r", name: "orbital", number: 12 }),
    ).toBe(join("/trees", "-r", "pr-12"));
  });

  it("REFUSES an escape, an unknown token and an absolute pattern, each with its reason", () => {
    const tokens = { repo: "k", name: "orbital", owner: "acme", branch: "feat/x" };
    expect(() => renderWorktreePattern("/trees", "../{branch}", tokens)).toThrow(
      /outside the worktree root/,
    );
    // An escape that only shows up after normalisation is refused on the RENDERED path.
    expect(() => renderWorktreePattern("/trees", "{repo}/../../{branch}", tokens)).toThrow(
      /outside the worktree root/,
    );
    expect(() => renderWorktreePattern("/trees", "{nope}/{branch}", tokens)).toThrow(
      /unknown token \{nope\}/,
    );
    expect(() => renderWorktreePattern("/trees", "/abs/{branch}", tokens)).toThrow(/absolute/);
    // The root ITSELF is not a worktree path: a pattern that renders to nothing under it
    // would put every repository's checkout in one directory.
    expect(() => renderWorktreePattern("/trees", ".", tokens)).toThrow(/outside the worktree root/);
    expect(() => renderWorktreePattern("/trees", "   ", tokens)).toThrow(/names no path/);
  });

  it("REFUSES a token this placement does not carry, rather than guessing a value", () => {
    // `{number}` is a pull-request token; a branch has none. And a caller that could not
    // resolve a forge remote does not silently get `local` — the pattern is refused.
    expect(() =>
      branchWorktreePath("/trees", "{branch}-{number}", { repo: "k", branch: "x" }),
    ).toThrow(/unknown token \{number\}/);
    expect(() =>
      branchWorktreePath("/trees", "{owner}/{branch}", { repo: "k", branch: "x" }),
    ).toThrow(/\{owner\} has no value/);
  });

  it("assertWorktreePattern validates a pattern before it is stored, per grammar", () => {
    expect(() => assertWorktreePattern("branch", "{repo}/{branch}")).not.toThrow();
    expect(() => assertWorktreePattern("pull-request", "{owner}/{name}/pr-{number}")).not.toThrow();
    // The two grammars are distinct: a branch pattern may not ask for a number, and a
    // pull-request pattern may not ask for a branch.
    expect(() => assertWorktreePattern("branch", "{repo}/pr-{number}")).toThrow(/unknown token/);
    expect(() => assertWorktreePattern("pull-request", "{branch}")).toThrow(/unknown token/);
    expect(() => assertWorktreePattern("branch", "../{branch}")).toThrow(/outside/);
  });

  it("resolves the root: unset ⇒ the data dir, `~` expands, relative resolves against it", () => {
    expect(resolveWorktreeRoot(dataDir, undefined)).toBe(join(dataDir, "worktrees"));
    expect(resolveWorktreeRoot(dataDir, "  ")).toBe(join(dataDir, "worktrees"));
    expect(resolveWorktreeRoot(dataDir, "/elsewhere/trees")).toBe("/elsewhere/trees");
    expect(resolveWorktreeRoot(dataDir, "~/trees")).toBe(join(homedir(), "trees"));
    // A relative value resolves against the DATA DIR, never the daemon's cwd.
    expect(resolveWorktreeRoot("/data", "trees")).toBe(join("/data", "trees"));
  });
});
