import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Review } from "@rennet/protocol";
import { afterEach, expect, it } from "vitest";
import { createBoardsRuntime } from "./boards/boards-runtime";
import { createRennetServer } from "./create-server";

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(root: string, ...arguments_: string[]): void {
  execFileSync("git", arguments_, { cwd: root, stdio: "ignore" });
}

function write(root: string, relativePath: string, contents: string): void {
  const target = join(root, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

/**
 * A committed repository that does NOT ignore `.rennet/`.
 *
 * That absence is the fixture. #729 only ever reproduced in a repository with no
 * Rennet ignore rule — and `boards-runtime` used to claim the ignore rule existed and
 * had been "verified against the repo `.gitignore`", which is how the defect survived
 * review. Both files under `.rennet` here are the USER's: house rules Rennet reads,
 * and a directory whose name merely starts the same way as the app-owned prefix.
 */
function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "rennet-729-repo-"));
  scratch.push(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "rennet@example.test");
  git(root, "config", "user.name", "Rennet Test");
  write(root, "src/app.ts", "export const value = 1;\n");
  write(root, ".rennet/conventions.json", '{"rules":[]}\n');
  write(root, ".rennet/boards-extra/notes.md", "the user's own notes\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "init");
  // The change under review, left uncommitted — the shape a landed round produces.
  write(root, "src/app.ts", "export const value = 2;\n");
  return root;
}

/**
 * The #729 journey, driven through the real daemon twice over one data directory.
 *
 * Capture a review, let Rennet write board state into the repository it is reviewing,
 * restart the daemon (a fresh watcher reports the tree dirty, so the freshness ask runs
 * a REAL capture rather than short-circuiting), and ask again. `mutate` runs against the
 * working tree before the restart; the controls use it to change something the review
 * actually covers.
 */
async function restartAndRecheck(mutate?: (root: string) => void): Promise<Review> {
  const repo = repository();
  const dataDir = mkdtempSync(join(tmpdir(), "rennet-729-data-"));
  scratch.push(dataDir);

  const first = await createRennetServer({ dataDir, env: {} });
  let reviewId: string;
  let root: string;
  try {
    await first.dispatch("repository.choose", { path: repo });
    const captured = (await first.dispatch("review.capture", {
      commandId: crypto.randomUUID(),
      repoPath: repo,
    })) as { review: Review };
    expect(captured.review.status).toBe("current");
    reviewId = captured.review.id;
    // The root the review is pinned to (macOS resolves the temp dir's symlink).
    root = captured.review.repositoryRoot;

    // Rennet writes a board, through the real runtime and therefore into the real
    // location — so if the store ever moves, this stops proving anything and says so.
    const boards = createBoardsRuntime(root);
    await boards.createRennetBoard();
    await boards.createRennetBoard();
    // …and the reviewer, with no ignore rule to stop them, stages what appeared.
    git(root, "add", "-A");

    mutate?.(root);
  } finally {
    first.shutdown();
  }

  const second = await createRennetServer({ dataDir, env: {} });
  try {
    await second.dispatch("repository.choose", { path: root });
    await second.dispatch("review.load", { commandId: crypto.randomUUID(), reviewId });
    const rechecked = (await second.dispatch("review.checkFreshness", {
      commandId: crypto.randomUUID(),
      reviewId,
      repoPath: root,
    })) as { review: Review };
    return rechecked.review;
  } finally {
    second.shutdown();
  }
}

it("keeps a review current across a restart after Rennet wrote its own boards", {
  timeout: 120_000,
}, async () => {
  const review = await restartAndRecheck();
  expect(review.status).toBe("current");
  // Not merely "not stale": nothing may be queued behind it either. A candidate
  // patchset whose only difference is app-owned board state is the same lie with a
  // quieter presentation.
  expect(review.pendingPatchsetId).toBeUndefined();
});

it("POSITIVE CONTROL: an edited reviewed source file still invalidates", {
  timeout: 120_000,
}, async () => {
  const review = await restartAndRecheck((root) => {
    write(root, "src/app.ts", "export const value = 3;\n");
  });
  expect(review.status).toBe("invalid");
});

it("POSITIVE CONTROL: an edited tracked .rennet project file still invalidates", {
  timeout: 120_000,
}, async () => {
  // The asymmetry D6 turns on. Excluding all of `.rennet` — the obvious shortcut,
  // and what the watcher used to do — passes the first test here and fails this one.
  const review = await restartAndRecheck((root) => {
    write(root, ".rennet/conventions.json", '{"rules":["one"]}\n');
  });
  expect(review.status).toBe("invalid");
});

it("POSITIVE CONTROL: the prefix boundary is the user's, and an edit there invalidates", {
  timeout: 120_000,
}, async () => {
  const review = await restartAndRecheck((root) => {
    write(root, ".rennet/boards-extra/notes.md", "the user's own notes, edited\n");
  });
  expect(review.status).toBe("invalid");
});
