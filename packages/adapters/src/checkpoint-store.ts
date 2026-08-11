import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CheckpointPort, CheckpointRef } from "@rennet/core";
import { execa } from "execa";

// ─────────────────────────────────────────────────────────────────────────────
// The workspace checkpoint store — the CAPTURE side of the review→agent handoff
// loop (issue #18). It brackets a write-enabled agent turn so the exact turn diff
// can be extracted.
//
// VENDORED PATTERN — attribution: this is T3 Code's checkpoint-as-hidden-git-ref
// technique (`pingdotgg/t3code`, MIT: `CheckpointStore.ts`, `CheckpointDiffQuery.ts`,
// `checkpointing/Utils.ts`), described in [[T3 Code Integration Research]] §1 and
// mandated by Contracts §2.1. The mechanism:
//
//   • Snapshot the working tree (tracked + untracked, .gitignore respected) into a
//     TEMPORARY git index (`GIT_INDEX_FILE`), never the user's real index — so
//     `git add`/`git status` in their shell are untouched.
//   • `write-tree` that temp index into a tree object, `commit-tree` it under HEAD,
//     and point a HIDDEN ref at it (`refs/rennet/checkpoints/*`) — not on any branch,
//     so `git branch`/`git log` never show it and the reflog stays clean.
//   • The turn diff is the tree-to-tree `git diff` between two checkpoints.
//
// R33 (Rennet never pushes source code) is upheld structurally elsewhere: this store
// only writes LOCAL objects and LOCAL refs and never contacts a remote. It creates no
// commit on the user's branch and moves neither HEAD nor any branch.
// ─────────────────────────────────────────────────────────────────────────────

/** The hidden ref namespace — off every branch, so it never shows in log/branch. */
const CHECKPOINT_REF_PREFIX = "refs/rennet/checkpoints/";
const CHECKPOINT_MESSAGE = "rennet: handoff checkpoint";

async function git(root: string, arguments_: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  const result = await execa("git", arguments_, {
    cwd: root,
    shell: false,
    stripFinalNewline: true,
    ...(env ? { env } : {}),
  });
  return result.stdout;
}

/** Resolve HEAD's commit OID, or null in a repository with no commits yet. */
async function headOid(root: string): Promise<string | null> {
  const result = await execa("git", ["rev-parse", "--verify", "--quiet", "HEAD"], {
    cwd: root,
    reject: false,
    shell: false,
    stripFinalNewline: true,
  });
  return result.exitCode === 0 && result.stdout ? result.stdout : null;
}

/**
 * A checkpoint store bound to one repository root. Implements the node-free
 * `CheckpointPort` the core handoff orchestrator (`runHandoffTurn`) depends on, so
 * `core` never imports this git-bound module — the desktop composition root wires it.
 */
export class GitCheckpointStore implements CheckpointPort {
  constructor(private readonly root: string) {}

  /**
   * Snapshot the current working tree into a hidden checkpoint ref and return it.
   * Uses a throwaway temp index so the user's real index is never touched; the
   * snapshot captures tracked modifications, deletions, and non-ignored untracked
   * files (the same content set `GitCaptureAdapter` captures), so the turn diff
   * between two checkpoints is exactly what the agent changed.
   */
  async capture(): Promise<CheckpointRef> {
    const indexFile = join(tmpdir(), `rennet-checkpoint-${randomUUID()}.index`);
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_INDEX_FILE: indexFile };
    try {
      // An empty temp index + `add -A` stages the LITERAL working tree (all present,
      // non-ignored files). No pathspec, no deletions-vs-HEAD subtlety: the resulting
      // tree is the working tree as it stands right now.
      await git(this.root, ["add", "-A"], env);
      const tree = await git(this.root, ["write-tree"], env);
      const parent = await headOid(this.root);
      const commit = await git(
        this.root,
        parent
          ? ["commit-tree", tree, "-p", parent, "-m", CHECKPOINT_MESSAGE]
          : ["commit-tree", tree, "-m", CHECKPOINT_MESSAGE],
        env,
      );
      const ref = `${CHECKPOINT_REF_PREFIX}${randomUUID()}`;
      // A hidden ref — off every branch, so `git branch`/`git log`/the reflog stay clean.
      await git(this.root, ["update-ref", ref, commit]);
      return { ref, commit };
    } finally {
      // The temp index is disposable — never leave it behind.
      await rm(indexFile, { force: true });
    }
  }

  /**
   * The turn diff: the tree-to-tree diff between two checkpoints, in the same
   * `diff --git a/… b/…` unified format `GitCaptureAdapter` and the review pipeline
   * read, so `filesTouchedByDiff` parses it identically.
   */
  async diff(from: CheckpointRef, to: CheckpointRef): Promise<string> {
    return git(this.root, [
      "diff",
      "--no-color",
      "--no-ext-diff",
      "--no-textconv",
      from.commit,
      to.commit,
    ]);
  }

  /**
   * Delete a checkpoint ref once the loop no longer needs it (hygiene — the objects
   * become unreachable and are pruned by ordinary `git gc`). Best-effort: a missing
   * ref is not an error.
   */
  async discard(ref: CheckpointRef): Promise<void> {
    await execa("git", ["update-ref", "-d", ref.ref], {
      cwd: this.root,
      reject: false,
      shell: false,
    });
  }
}
