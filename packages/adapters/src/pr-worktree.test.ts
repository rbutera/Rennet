import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { execaGit } from "./git-range-diff";
import {
  ensurePrWorktree,
  prWorktreePath,
  readSetupLogTail,
  readSetupStatus,
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
    const path = prWorktreePath(dataDir, { owner: "acme", name: "widget" }, 7);
    const first = await ensurePrWorktree(execaGit, root, path, firstOid);
    expect(first).toEqual({ path, created: true });
    expect(readFileSync(join(path, "a.txt"), "utf8")).toBe("one\n");
    const again = await ensurePrWorktree(execaGit, root, path, firstOid);
    expect(again.created).toBe(false); // setup will not re-run on a plain re-open
  });

  it("replaces the checkout when the reviewed head is superseded", async () => {
    const { root, dataDir, firstOid, secondOid } = repo();
    const path = prWorktreePath(dataDir, { owner: "acme", name: "widget" }, 7);
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
