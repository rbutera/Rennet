import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  purgeSessionContext,
  type SessionContextFile,
  sessionContextDir,
  sweepOrphanedSessionContext,
  writeSessionContext,
} from "./context-files";
import { createDispatchRuntime, type DispatchDeps } from "./dispatch/runtime";
import { sessionHandlers } from "./dispatch/session";
import { sweepIfArchived } from "./t3/threads";

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0))
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function scratchDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

const files: readonly SessionContextFile[] = [
  {
    name: "round.json",
    body: JSON.stringify({ asks: ["ask-1"], reportBoard: "report-1" }),
    holds: "the asks this round dispatched and the frozen report board.",
    readWhen: "before drafting a regeneration.",
  },
  {
    name: "boards/design.json",
    body: JSON.stringify({ lens: "design", claims: [] }),
    holds: "the Design board as it was drafted.",
    readWhen: "when composing the review.",
  },
];

describe("writeSessionContext (session-context-files 2.2)", () => {
  it("writes the files and a README index naming each one, what it holds and when to read it", () => {
    const root = scratchDir("rennet-ctx-write-");

    const dir = writeSessionContext(root, "sess-1", files);

    expect(dir).toBe(sessionContextDir(root, "sess-1"));
    expect(JSON.parse(readFileSync(join(dir, "round.json"), "utf8"))).toEqual({
      asks: ["ask-1"],
      reportBoard: "report-1",
    });
    // A nested name creates its directory rather than throwing.
    expect(existsSync(join(dir, "boards", "design.json"))).toBe(true);

    const index = readFileSync(join(dir, "README.md"), "utf8");
    // One line per file, carrying all three facts the spec requires.
    for (const file of files) {
      const line = index.split("\n").find((row) => row.includes(file.name));
      expect(line).toBeDefined();
      expect(line).toContain(file.holds);
      expect(line).toContain(file.readWhen);
    }
  });

  it("carries earlier entries forward, so a later turn's write cannot orphan them", () => {
    // Several turn kinds write into ONE session directory at different moments (a seat's
    // context, then a verification turn's pointers). Each write re-renders the index; a
    // re-render that only listed its own files would leave a directory listing that lies
    // about its own directory, while the earlier prompts still name those files.
    const root = scratchDir("rennet-ctx-merge-");
    writeSessionContext(root, "sess-1", files);
    const dir = writeSessionContext(root, "sess-1", [
      {
        name: "verification/F1.json",
        body: JSON.stringify({ turn: "finding-verification" }),
        holds: "where one finding's code is.",
        readWhen: "before verifying that finding.",
      },
    ]);

    const index = readFileSync(join(dir, "README.md"), "utf8");
    expect(index).toContain("`round.json`");
    expect(index).toContain("`boards/design.json`");
    expect(index).toContain("`verification/F1.json`");
    // And a re-write of an existing name replaces its entry rather than doubling it.
    writeSessionContext(
      root,
      "sess-1",
      files.slice(0, 1).map((file) => ({ ...file, holds: "the asks, restated." })),
    );
    const rewritten = readFileSync(join(dir, "README.md"), "utf8");
    expect(rewritten.split("\n").filter((row) => row.includes("`round.json`"))).toHaveLength(1);
    expect(rewritten).toContain("the asks, restated.");
    expect(rewritten).toContain("`verification/F1.json`");
  });

  it("ensures the managed ignore block BEFORE the first file lands", () => {
    const root = scratchDir("rennet-ctx-ignore-");

    writeSessionContext(root, "sess-1", files);

    const ignore = readFileSync(join(root, ".rennet", ".gitignore"), "utf8");
    expect(ignore).toContain("context/");
    expect(ignore).toContain("rennet-managed");
  });
});

describe("purgeSessionContext (session-context-files 2.2)", () => {
  it("removes the directory, and is a no-op for a session that never had one", () => {
    const root = scratchDir("rennet-ctx-purge-");
    writeSessionContext(root, "sess-1", files);
    writeSessionContext(root, "sess-2", files);

    expect(purgeSessionContext(root, "sess-1")).toBe(true);
    expect(existsSync(sessionContextDir(root, "sess-1"))).toBe(false);
    // The sibling session's files are untouched — the purge is per session, not per root.
    expect(existsSync(sessionContextDir(root, "sess-2"))).toBe(true);

    // Absent directory: answers false, never throws (an archive may not fail on scratch).
    expect(() => purgeSessionContext(root, "never-existed")).not.toThrow();
    expect(purgeSessionContext(root, "never-existed")).toBe(false);
    expect(() => purgeSessionContext(join(root, "no-such-root"), "sess-1")).not.toThrow();
  });
});

describe("archive purges the session's context (session-context-files 2.2)", () => {
  /** The `session.archive` handler over a stub store, with the purge dep the host wires. */
  function archiveDispatch(root: string) {
    const purged: string[] = [];
    const rt = createDispatchRuntime({
      service: { reviewById: () => undefined },
      sessions: {
        list: () => [],
        setArchived: (id: string, archived: boolean) => ({
          id,
          projectId: "p1",
          title: "t",
          target: "your-branch" as const,
          createdAt: 1,
          ...(archived ? { archived: true } : {}),
        }),
      },
      purgeSessionContext: (sessionId: string) => {
        purged.push(sessionId);
        purgeSessionContext(root, sessionId);
      },
    } as unknown as DispatchDeps);
    return { handlers: sessionHandlers(rt), purged };
  }

  it("purges on archive, and leaves the files alone on un-archive (control)", async () => {
    const root = scratchDir("rennet-ctx-archive-");
    writeSessionContext(root, "sess-1", files);
    const { handlers, purged } = archiveDispatch(root);

    // The control first: un-archiving is NOT the deletion boundary, so nothing is purged.
    await handlers["session.archive"]({ sessionId: "sess-1", archived: false });
    expect(purged).toEqual([]);
    expect(existsSync(sessionContextDir(root, "sess-1"))).toBe(true);

    await handlers["session.archive"]({ sessionId: "sess-1", archived: true });
    expect(purged).toEqual(["sess-1"]);
    expect(existsSync(sessionContextDir(root, "sess-1"))).toBe(false);
  });

  it("the round's re-sweep purges a session archived under it, and skips a live one (control)", async () => {
    const root = scratchDir("rennet-ctx-resweep-");
    writeSessionContext(root, "live", files);
    writeSessionContext(root, "archived", files);
    const forget = async () => 0;
    const purge = (sessionId: string) => void purgeSessionContext(root, sessionId);

    // A round that outlived an archive wrote its context AFTER `session.archive` purged.
    await sweepIfArchived({ id: "archived", archivedAt: 42 }, forget, purge);
    expect(existsSync(sessionContextDir(root, "archived"))).toBe(false);

    // Control: the ordinary live session keeps every file its next turn will read.
    await sweepIfArchived({ id: "live" }, forget, purge);
    expect(existsSync(sessionContextDir(root, "live"))).toBe(true);
  });
});

describe("sweepOrphanedSessionContext (session-context-files 2.2)", () => {
  it("removes a crashed session's directory at start, keeps a live one, and logs the count", () => {
    const rootA = scratchDir("rennet-ctx-sweepa-");
    const rootB = scratchDir("rennet-ctx-sweepb-");
    writeSessionContext(rootA, "gone", files);
    writeSessionContext(rootA, "alive", files);
    // The second repo of a workspace: `openPath` names only the first, so a sweep that
    // looked at project roots alone would leave this one behind forever.
    writeSessionContext(rootB, "also-gone", files);
    const logged: string[] = [];

    const removed = sweepOrphanedSessionContext([rootA, rootB], new Set(["alive"]), (message) =>
      logged.push(message),
    );

    expect(removed).toBe(2);
    expect(existsSync(sessionContextDir(rootA, "gone"))).toBe(false);
    expect(existsSync(sessionContextDir(rootB, "also-gone"))).toBe(false);
    // Control: matching is on a POSITIVE contradiction (the id is absent from the store),
    // so a session the store still holds keeps its files.
    expect(existsSync(sessionContextDir(rootA, "alive"))).toBe(true);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain("2");
  });

  it("says nothing and removes nothing when every directory belongs to a live session", () => {
    const root = scratchDir("rennet-ctx-sweepc-");
    writeSessionContext(root, "alive", files);
    const logged: string[] = [];

    expect(sweepOrphanedSessionContext([root], new Set(["alive"]), (m) => logged.push(m))).toBe(0);
    expect(logged).toEqual([]);
    // A root with no context directory at all is skipped, not a throw.
    expect(sweepOrphanedSessionContext([join(root, "nope")], new Set())).toBe(0);
  });
});

// ── Never staged (session-context-files, "Context is never staged") ───────────
//
// The assertion that matters runs a REAL `git add -A` in a REAL repository, because the
// claim is about what git's index does, not about what a string contains. The control is
// the same repository with the `context/` line taken back out of the managed block: the
// file IS staged then, which is what proves the entry is load-bearing rather than the
// `.rennet/` prefix or some ambient ignore doing the work.

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" });
}

function initRepo(prefix: string): string {
  const repo = scratchDir(prefix);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test");
  writeFileSync(join(repo, "README.md"), "a repo\n");
  return repo;
}

const stagedPaths = (repo: string): string[] =>
  git(repo, "diff", "--cached", "--name-only").split("\n").filter(Boolean);

describe("a context file is never staged", () => {
  it("survives `git add -A` unstaged", () => {
    const repo = initRepo("rennet-ctx-git-");

    writeSessionContext(repo, "sess-1", files);
    git(repo, "add", "-A");

    const staged = stagedPaths(repo);
    expect(staged).toContain("README.md"); // the add really ran
    expect(staged.some((path) => path.startsWith(".rennet/context/"))).toBe(false);
  });

  it("CONTROL: with the `context/` entry removed, the same add DOES stage it", () => {
    const repo = initRepo("rennet-ctx-git-control-");

    writeSessionContext(repo, "sess-1", files);
    // Exactly the one line under test, taken back out. Everything else is identical.
    const ignorePath = join(repo, ".rennet", ".gitignore");
    const withoutEntry = readFileSync(ignorePath, "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "context/")
      .join("\n");
    mkdirSync(join(repo, ".rennet"), { recursive: true });
    writeFileSync(ignorePath, withoutEntry);
    git(repo, "add", "-A");

    expect(stagedPaths(repo)).toContain(".rennet/context/sess-1/round.json");
  });
});
