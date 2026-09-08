import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "@rennet/adapters";
import type { SessionModel } from "@rennet/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { createRennetServer } from "./create-server";

// The sibling sweep, DRIVEN THROUGH THE DAEMON (workspace-settings D5, review finding W3).
//
// `orphanedSiblings` and `collectSibling` were each unit-tested and each correct, and the
// sweep still collected nothing for a release: the loop read `settingsComposition` before
// its `const` initialiser had run, the ReferenceError landed in the `catch` that skips an
// unreadable repository, and every repository was skipped. Nothing was wrong with the
// pieces; the WIRING was wrong, and only a test that starts a real daemon can see it.
//
// So this file starts `createRennetServer` against a fixture on disk and asserts what the
// daemon did to it. It also reads the daemon LOG, which is the second half of the same
// finding: a sweep that says nothing cannot be told apart from a sweep that did not run.

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  });
}

function commit(dir: string, name: string, body: string): void {
  writeFileSync(join(dir, name), body);
  git(dir, ["add", "."]);
  git(dir, ["commit", "-q", "-m", name]);
}

/**
 * A repository on `feat/x`, a sibling worktree under the daemon's own worktree root, and a
 * `projects.json` naming the repository — the state a daemon that crashed mid-session
 * leaves behind.
 *
 * The sibling is placed at the SIBLING's own path (`<root>/<repoKey>/rennet/feat/x`), which
 * is where the bind puts it; the sweep matches on the branch prefix and the root, so the
 * exact leaf is not what it keys on, but the fixture should be the shape production writes.
 */
function fixture(options: { ahead: boolean }): {
  dataDir: string;
  repo: string;
  sibling: string;
} {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rennet-sibling-sweep-")));
  scratch.push(root);
  const dataDir = join(root, "data");
  const repo = join(root, "repo");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-q", "-b", "main"]);
  commit(repo, "README.md", "repo\n");
  git(repo, ["checkout", "-q", "-b", "feat/x"]);
  commit(repo, "feature.txt", "feature\n");
  // Back to `main`, so the sibling is the only worktree on anything Rennet made.
  git(repo, ["checkout", "-q", "main"]);

  const sibling = join(dataDir, "worktrees", "sibling", "rennet", "feat", "x");
  mkdirSync(join(dataDir, "worktrees", "sibling", "rennet", "feat"), { recursive: true });
  git(repo, ["worktree", "add", "-b", "rennet/feat/x", sibling, "refs/heads/feat/x"]);
  if (options.ahead) commit(sibling, "round.txt", "unpushed round work\n");

  writeFileSync(
    join(dataDir, "projects.json"),
    JSON.stringify({
      projects: [
        {
          id: "p-1",
          name: "repo",
          path: repo,
          kind: "repo",
          repoCount: 1,
          branchCount: 2,
          primaryBranch: "main",
          openPath: repo,
          includedRepoPaths: [repo],
          addedAt: "2026-01-01T00:00:00.000Z",
          source: "local",
        },
      ],
    }),
  );
  return { dataDir, repo, sibling };
}

/** A live session record on disk, exactly as the store writes one. */
function seedSession(dataDir: string, session: SessionModel): void {
  new SessionStore(join(dataDir, "sessions")).save(session);
}

/** Wait for `predicate` over the growing log, or fail naming everything that was said. */
async function until(log: string[], predicate: (log: string[]) => boolean): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!predicate(log)) {
    if (Date.now() > deadline) throw new Error(`never happened: ${log.join(" | ")}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Start a daemon over `dataDir`, capture its sibling log, and stop it. */
async function startAndSweep(dataDir: string): Promise<string[]> {
  const log: string[] = [];
  const server = await createRennetServer({
    dataDir,
    env: {},
    siblingCollectionLog: (message) => void log.push(message),
  });
  try {
    // The sweep is fire-and-forget at start; the count line is its last act, so waiting for
    // it is waiting for the whole sweep rather than for an arbitrary number of ticks.
    await until(log, (lines) => lines.some((line) => line.includes("sibling sweep collected")));
  } finally {
    server.shutdown();
  }
  return log;
}

describe("the daemon's sibling sweep (workspace-settings D5, review finding W3)", () => {
  it("collects an ORPHANED reachable sibling on start, and says so", {
    timeout: 60_000,
  }, async () => {
    // Nothing is ahead: the sibling's tip is `feat/x`'s own, so its commits are reachable
    // and D5 collects both the worktree and the branch. No session claims it.
    const { dataDir, repo, sibling } = fixture({ ahead: false });

    const log = await startAndSweep(dataDir);

    expect(existsSync(sibling)).toBe(false);
    expect(() => git(repo, ["rev-parse", "--verify", "refs/heads/rennet/feat/x"])).toThrow();
    // The log distinguishes "collected nothing" from "failed everywhere" — the shape the
    // temporal-dead-zone bug wore. Both the per-sibling sentence and the count are here.
    expect(log.some((line) => line.includes("rennet/feat/x is reachable from feat/x"))).toBe(true);
    expect(log).toContain("rennet: sibling sweep collected 1, kept 0");
  });

  it("SKIPS a sibling a live session is bound to", { timeout: 60_000 }, async () => {
    // The control. Same fixture, same reachable sibling — the only difference is a live
    // session recording that directory as its bound root. A sweep that deleted it would
    // delete a workspace someone is working in, which is why the claim check exists.
    const { dataDir, repo, sibling } = fixture({ ahead: false });
    seedSession(dataDir, {
      id: "s-live",
      projectId: "p-1",
      threads: [],
      createdAt: 1,
      repositoryRoot: repo,
      boundRoot: sibling,
      workBranch: "rennet/feat/x",
    });

    const log = await startAndSweep(dataDir);

    expect(existsSync(sibling)).toBe(true);
    expect(git(repo, ["rev-parse", "refs/heads/rennet/feat/x"]).trim().length).toBeGreaterThan(0);
    expect(log).toContain("rennet: sibling sweep collected 0, kept 0");
  });

  it("KEEPS an orphaned sibling that is AHEAD, with its worktree, and says why", {
    timeout: 60_000,
  }, async () => {
    // Unpushed round commits exist on no other ref. D5 keeps both and the log carries the
    // sentence the inventory row shows.
    const { dataDir, repo, sibling } = fixture({ ahead: true });

    const log = await startAndSweep(dataDir);

    expect(existsSync(join(sibling, "round.txt"))).toBe(true);
    expect(git(repo, ["rev-parse", "refs/heads/rennet/feat/x"]).trim().length).toBeGreaterThan(0);
    expect(log.some((line) => line.includes("rennet/feat/x holds commits feat/x does not"))).toBe(
      true,
    );
    expect(log).toContain("rennet: sibling sweep collected 0, kept 1");
  });
});

describe("the archive's own collection (workspace-settings D5, review finding W3)", () => {
  /** Start a daemon, archive `sessionId` through the real command, and read the log. */
  async function archive(
    dataDir: string,
    sessionId: string,
  ): Promise<{ log: string[]; store: SessionStore }> {
    const log: string[] = [];
    const server = await createRennetServer({
      dataDir,
      env: {},
      siblingCollectionLog: (message) => void log.push(message),
    });
    try {
      await until(log, (lines) => lines.some((line) => line.includes("sibling sweep collected")));
      log.length = 0;
      await server.dispatch("session.archive", {
        commandId: crypto.randomUUID(),
        sessionId,
        archived: true,
      });
      // Fire-and-forget, by design (an archive must not wait on git). The log line is the
      // decision, so waiting for it is waiting for the collection itself.
      await until(log, (lines) => lines.length > 0);
    } finally {
      server.shutdown();
    }
    return { log, store: new SessionStore(join(dataDir, "sessions")) };
  }

  const live = (id: string, repo: string, sibling: string): SessionModel => ({
    id,
    projectId: "p-1",
    threads: [],
    createdAt: 1,
    repositoryRoot: repo,
    boundRoot: sibling,
    workBranch: "rennet/feat/x",
  });

  it("KEEPS the sibling when another live session is bound to it", {
    timeout: 60_000,
  }, async () => {
    // THE REVIEW FINDING. Sessions share a sibling exactly as they share a checkout, and
    // the archive had no claim check at all: archiving one of two sessions deleted the
    // worktree the other was committing in. The sweep has always asked; the archive did not.
    const { dataDir, repo, sibling } = fixture({ ahead: false });
    seedSession(dataDir, live("s-1", repo, sibling));
    seedSession(dataDir, live("s-2", repo, sibling));

    const { log, store } = await archive(dataDir, "s-1");

    expect(existsSync(sibling)).toBe(true);
    expect(git(repo, ["rev-parse", "refs/heads/rennet/feat/x"]).trim().length).toBeGreaterThan(0);
    expect(log).toContain("rennet: kept rennet/feat/x — another live session is bound to it");
    // The archived session keeps its binding: nothing was collected, so nothing is stale.
    expect(store.load("s-1")?.boundRoot).toBe(sibling);
  });

  it("collects the sibling and CLEARS the archived session's workspace", {
    timeout: 60_000,
  }, async () => {
    // The control for the pair above: the same fixture with only one session. The sibling
    // goes — and so does the session's record of it, because a recorded root that is not on
    // disk is a pointer at a deleted directory, and every turn a later un-archive spawns
    // would run in it. Cleared, the next use re-binds.
    const { dataDir, repo, sibling } = fixture({ ahead: false });
    seedSession(dataDir, live("s-1", repo, sibling));

    const { log, store } = await archive(dataDir, "s-1");

    expect(existsSync(sibling)).toBe(false);
    expect(() => git(repo, ["rev-parse", "--verify", "refs/heads/rennet/feat/x"])).toThrow();
    expect(log.some((line) => line.includes("rennet/feat/x is reachable from feat/x"))).toBe(true);
    const after = store.load("s-1");
    expect(after?.boundRoot).toBeUndefined();
    expect(after?.workBranch).toBeUndefined();
  });
});
