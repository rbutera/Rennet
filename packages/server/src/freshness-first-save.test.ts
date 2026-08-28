import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Review } from "@rennet/protocol";
import { afterEach, expect, it } from "vitest";
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
 * A committed repository of `files` source files spread over directories. The size is
 * load-bearing: chokidar arms its watches as it walks, so the walk has to still be
 * running when the save below lands. A one-file fixture (what the desktop e2e uses)
 * finishes walking in a few milliseconds and cannot reach this defect at all.
 */
function repoOf(files: number): string {
  const root = mkdtempSync(join(tmpdir(), "rennet-601-daemon-"));
  scratch.push(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "rennet@example.test");
  git(root, "config", "user.name", "Rennet Test");
  for (let i = 0; i < files; i += 1) {
    write(root, `src/d${Math.floor(i / 100)}/f${i}.ts`, `export const value = ${i};\n`);
  }
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "init");
  // The change under review: one edited file in the working tree.
  write(root, "src/d0/f0.ts", "export const value = 2;\n");
  return root;
}

/**
 * #601, driven through the real daemon: the reviewer's FIRST save after a fresh capture
 * must stale the review.
 *
 * This is the harm, not the mechanism. `review.checkFreshness` short-circuits on the
 * repository-dirty flag to avoid a git diff per window focus, and that flag is fed by a
 * chokidar watcher started at the end of `review.capture`. chokidar arms its watches file
 * by file as it walks the tree and `ignoreInitial: true` suppresses everything it meets on
 * the way, so a save landing before the walk reaches that file is never reported — not
 * late, gone. The review then answers "current" over a diff that no longer matches the
 * reviewer's tree, with nothing on screen to say so. Measured on this repo before the fix:
 * the daemon was seen answering "current" nine seconds after a real edit.
 *
 * Everything here is real — the server, its watcher, git, and the working tree. The only
 * thing staged is the sequence, which is the one the app performs: capture, the renderer's
 * freshness ask as the review lands on screen, the reviewer's save, and the ask that fires
 * when they come back to the window.
 */
it("stales the review on the first save after a capture", { timeout: 120_000 }, async () => {
  const repo = repoOf(1_000);
  const dataDir = mkdtempSync(join(tmpdir(), "rennet-601-data-"));
  scratch.push(dataDir);
  const server = await createRennetServer({ dataDir, env: {} });
  const ask = async (
    command: Parameters<typeof server.dispatch>[0],
    input: Record<string, unknown>,
  ) =>
    (await server.dispatch(command, { commandId: crypto.randomUUID(), ...input })) as {
      review: Review;
    };
  try {
    await server.dispatch("repository.choose", { path: repo });
    const captured = await ask("review.capture", { repoPath: repo });
    expect(captured.review.status).toBe("current");
    // The root the review is actually pinned to (macOS resolves the temp dir's symlink).
    const root = captured.review.repositoryRoot;

    // The renderer asks about freshness as the review appears. Nothing has happened yet,
    // so this ask clears the dirty flag — and on a real repository the watcher is still
    // walking when it does. This is the step that used to lose the next save.
    await ask("review.checkFreshness", { reviewId: captured.review.id, repoPath: root });

    // The reviewer's first save.
    write(root, "src/d0/f0.ts", "export const value = 3;\n");

    // They come back to the window, which is what asks.
    const after = await ask("review.checkFreshness", {
      reviewId: captured.review.id,
      repoPath: root,
    });
    // `invalid` is exactly what puts the "you are reading the older tree" notice on screen.
    expect(after.review.status).toBe("invalid");
  } finally {
    server.shutdown();
  }
});
