import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
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

// ─────────────────────────────────────────────────────────────────────────────
// PRUNING REGISTRATIONS (workspace-settings D5, review findings Opus #2 / Codex P1).
//
// `git worktree prune` is REPO-WIDE. It takes no path, and there is no scoped verb for a
// registration whose directory is missing (`worktree remove` wants the directory to be
// there). So a guard that decides per registration and then issues one repo-wide prune is
// not a guard at all: the previous version asked only "does a Rennet session's recorded
// path name this?", and dropped a reviewer's own worktree — registered against an unmounted
// volume, nothing to do with Rennet — as collateral for pruning one of ours.
//
// The rule these cases pin, three parts, all of which must hold PER REGISTRATION, and the
// prune runs only when EVERY unreachable registration in the repository passes:
//
//   1. git reports it unreachable (`prunable`);
//   2. it is RENNET'S OWN — under the repository's resolved placement root, or on a
//      `rennet/*` branch;
//   3. no live session claims it, by work branch in this repository or by path in either
//      spelling.
//
// A stranded directory (deleted behind git's back) is how a test produces the `prunable`
// annotation: it is the same annotation an unmounted volume produces, and git cannot tell
// the difference — which is the entire reason this guard exists.
// ─────────────────────────────────────────────────────────────────────────────

interface PruneFixture {
  readonly root: string;
  readonly dataDir: string;
  readonly repo: string;
  /** The builtin placement root — what "Rennet's own, by path" means for this repository. */
  readonly worktreeRoot: string;
  /** Register a worktree of the repository on a new branch. */
  readonly register: (path: string, branch: string) => void;
  /** Delete a registered worktree's DIRECTORY behind git's back ⇒ git marks it prunable. */
  readonly strand: (path: string) => void;
  /** Every path `git worktree list` still registers. */
  readonly registrations: () => string[];
}

function pruneFixture(): PruneFixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rennet-prune-sweep-")));
  scratch.push(root);
  const dataDir = join(root, "data");
  const repo = join(root, "repo");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-q", "-b", "main"]);
  commit(repo, "README.md", "repo\n");
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
          branchCount: 1,
          primaryBranch: "main",
          openPath: repo,
          includedRepoPaths: [repo],
          addedAt: "2026-01-01T00:00:00.000Z",
          source: "local",
        },
      ],
    }),
  );
  return {
    root,
    dataDir,
    repo,
    worktreeRoot: join(dataDir, "worktrees"),
    register: (path, branch) => {
      mkdirSync(dirname(path), { recursive: true });
      git(repo, ["worktree", "add", "-q", "-b", branch, path, "refs/heads/main"]);
    },
    strand: (path) => rmSync(path, { recursive: true, force: true }),
    registrations: () =>
      git(repo, ["worktree", "list", "--porcelain"])
        .split("\n")
        .filter((line) => line.startsWith("worktree "))
        .map((line) => line.slice("worktree ".length)),
  };
}

describe("what the sweep may prune (workspace-settings D5)", () => {
  it("leaves the WHOLE repository alone when the unreachable registration is the reviewer's own", {
    timeout: 60_000,
  }, async () => {
    // (a) OPUS #2. Outside the placement root, not on a `rennet/*` branch: this is the
    // reviewer's worktree, and an unreachable one is a disconnected volume far more often
    // than a deleted directory. `git worktree repair` is their tool; Rennet does not get to
    // decide their registration is garbage.
    const fx = pruneFixture();
    const mine = join(fx.root, "mine");
    fx.register(mine, "mine");
    fx.strand(mine);

    const log = await startAndSweep(fx.dataDir);

    expect(fx.registrations()).toContain(mine);
    // S4: the LINE NAMES THE PATH. "Something held it" is a sentence the reviewer can do
    // nothing with; the whole reason to read this line is to learn which directory to
    // reconnect or remove.
    expect(log.some((line) => line.includes("pruned nothing") && line.includes(mine))).toBe(true);
  });

  it("leaves a Rennet worktree a live session claims under ANOTHER SPELLING of its path", {
    timeout: 60_000,
  }, async () => {
    // (b) CODEX P1, reproduced on macOS. Git prints the RESOLVED path; a session records
    // whatever spelling the daemon addressed the directory by, and on macOS every default
    // TMPDIR is a symlink. A raw string compare misses the pair — and so does `realpath`,
    // because the directory is GONE, which is the only state this question is ever asked
    // in. The claim here is a PATH claim and nothing else: the session records no
    // `workBranch`, so the branch matcher cannot rescue it and the path comparison is what
    // is under test.
    const fx = pruneFixture();
    const sibling = join(fx.worktreeRoot, "sibling", "rennet", "feat", "x");
    fx.register(sibling, "rennet/feat/x");
    fx.strand(sibling);
    // The same directory, spelled through a symlink to the fixture root.
    const link = join(dirname(fx.root), `${basename(fx.root)}-link`);
    symlinkSync(fx.root, link);
    scratch.push(link);
    seedSession(fx.dataDir, {
      id: "s-live",
      projectId: "p-1",
      threads: [],
      createdAt: 1,
      repositoryRoot: fx.repo,
      boundRoot: sibling.replace(fx.root, link),
    });

    const log = await startAndSweep(fx.dataDir);

    expect(fx.registrations()).toContain(sibling);
    expect(log.some((line) => line.includes("pruned nothing") && line.includes(sibling))).toBe(
      true,
    );
  });

  it("leaves a Rennet worktree a live session claims by WORK BRANCH, with no path at all", {
    timeout: 60_000,
  }, async () => {
    // The other matcher, on its own: a session that records a work branch and no bound root
    // (a crash between the branch write and the binding write) still claims the sibling its
    // work is on. Matched within THIS repository, because `rennet/main` can exist in two
    // repositories of one workspace project.
    const fx = pruneFixture();
    const sibling = join(fx.worktreeRoot, "sibling", "rennet", "feat", "y");
    fx.register(sibling, "rennet/feat/y");
    fx.strand(sibling);
    seedSession(fx.dataDir, {
      id: "s-branch",
      projectId: "p-1",
      threads: [],
      createdAt: 1,
      repositoryRoot: fx.repo,
      workBranch: "rennet/feat/y",
    });

    const log = await startAndSweep(fx.dataDir);

    expect(fx.registrations()).toContain(sibling);
    expect(log.some((line) => line.includes("pruned nothing") && line.includes(sibling))).toBe(
      true,
    );
  });

  it("does not COLLECT the sibling a work-branch-only claim protects from the prune (F3)", {
    timeout: 60_000,
  }, async () => {
    // CODEX'S REPRODUCTION. The prune guard and the orphan collection asked two different
    // questions about the same word. `pruneUnclaimedRegistrations` matched a claim by work
    // branch OR by either path spelling; `orphanedSiblings` matched by PATH ONLY. So a
    // session that recorded `workBranch` and no `boundRoot` — a crash between the branch
    // write and the binding write, which is exactly the state the sweep exists for — kept
    // its registration and lost its BRANCH AND ITS WORKTREE ten lines later. Collection is
    // the stronger act of the two; it was asking the weaker question.
    //
    // The fixture is the work-branch-claim one above PLUS the two facts collection needs to
    // actually fire: the reviewed branch exists, and the sibling is reachable from it (both
    // sit at `main`), so `collectSibling` would remove the worktree and delete the branch.
    // Without those the case is invisible — collection bails at "rennet/feat/y is gone".
    const fx = pruneFixture();
    git(fx.repo, ["branch", "feat/y", "refs/heads/main"]);
    const sibling = join(fx.worktreeRoot, "sibling", "rennet", "feat", "y");
    fx.register(sibling, "rennet/feat/y");
    seedSession(fx.dataDir, {
      id: "s-branch-only",
      projectId: "p-1",
      threads: [],
      createdAt: 1,
      repositoryRoot: fx.repo,
      workBranch: "rennet/feat/y",
    });

    const log = await startAndSweep(fx.dataDir);

    // The registration, the directory AND the branch: all three are what collection takes.
    expect(fx.registrations()).toContain(sibling);
    expect(existsSync(sibling)).toBe(true);
    expect(git(fx.repo, ["rev-parse", "refs/heads/rennet/feat/y"]).trim().length).toBeGreaterThan(
      0,
    );
    // And it was SKIPPED, not merely kept: `collectSibling` logs a reason for every sibling
    // it decides about, so a run that reached it would say so about this branch.
    expect(log.some((line) => line.includes("rennet/feat/y"))).toBe(false);
    expect(log.some((line) => line.includes("sibling sweep collected 0, kept 0"))).toBe(true);
  });

  it("PRUNES a Rennet worktree nothing claims, when it is the only unreachable one", {
    timeout: 60_000,
  }, async () => {
    // (c) THE CONTROL FOR ALL THREE ABOVE. Same shape, same stranding — the only differences
    // are that nothing claims it and nothing else in the repository is unreachable. Without
    // this the three refusals pass for a sweep that never prunes anything.
    //
    // And it is `feat/z`, not a `rennet/*` branch, deliberately: this is the "under the
    // resolved placement root" half of "Rennet's own", which the sibling cases do not reach.
    const fx = pruneFixture();
    const branchWorktree = join(fx.worktreeRoot, "repo-key", "feat", "z");
    fx.register(branchWorktree, "feat/z");
    fx.strand(branchWorktree);

    const log = await startAndSweep(fx.dataDir);

    expect(fx.registrations()).not.toContain(branchWorktree);
    expect(log.some((line) => line.includes("pruned 1 unreachable worktree registration(s)"))).toBe(
      true,
    );
  });

  it("prunes NOTHING when one prunable registration is Rennet's and another is not", {
    timeout: 60_000,
  }, async () => {
    // ALL-OR-NOTHING, which is the half a per-registration guard cannot express. Rennet's
    // own stranded sibling is prunable under the rule; the reviewer's is not; `prune` cannot
    // be told to take one and leave the other, so it is not run at all — and the log names
    // the one that held it, not the one it would have taken.
    const fx = pruneFixture();
    const sibling = join(fx.worktreeRoot, "sibling", "rennet", "feat", "x");
    const mine = join(fx.root, "mine");
    fx.register(sibling, "rennet/feat/x");
    fx.register(mine, "mine");
    fx.strand(sibling);
    fx.strand(mine);

    const log = await startAndSweep(fx.dataDir);

    expect(fx.registrations()).toContain(sibling);
    expect(fx.registrations()).toContain(mine);
    expect(log.some((line) => line.includes("pruned nothing") && line.includes(mine))).toBe(true);
  });
});
