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
      // A hidden ref — off every branch. `-c core.logAllRefUpdates=false` suppresses a
      // reflog even when the user's config is `always` (Codex F5: without this, a
      // reflog IS written for refs/rennet/*, so the "reflog stays clean" claim only
      // holds when we force it off here).
      await git(this.root, ["-c", "core.logAllRefUpdates=false", "update-ref", ref, commit]);
      return { ref, commit };
    } finally {
      // The temp index is disposable — never leave it behind.
      await rm(indexFile, { force: true });
    }
  }

  /**
   * The turn diff: the tree-to-tree diff between two checkpoints, in the unified
   * `diff --git a/… b/…` format, for DISPLAY. `changedPaths` (not this) is the
   * authoritative file list — parsing this display diff loses quoted/spaced paths.
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
   * The STRUCTURAL changed-path list between two checkpoints (Codex F7): `git diff
   * --name-only -z` NUL-delimits paths and never quotes them, so a path containing a
   * tab, space, or quote is returned intact — unlike parsing the `diff --git` headers,
   * where such a path renders as `"a/…" "b/…"` and is silently dropped.
   */
  async changedPaths(from: CheckpointRef, to: CheckpointRef): Promise<readonly string[]> {
    const out = await git(this.root, [
      "diff",
      "--name-only",
      "-z",
      "--no-ext-diff",
      from.commit,
      to.commit,
    ]);
    return out.split("\0").filter((path) => path.length > 0);
  }

  /** Delete a checkpoint ref once the loop no longer needs it — best-effort hygiene. */
  async discard(ref: CheckpointRef): Promise<void> {
    await execa("git", ["update-ref", "-d", ref.ref], {
      cwd: this.root,
      reject: false,
      shell: false,
    });
  }
}

/**
 * Whether a repository contains git submodules (Codex F6). A coding agent's edits
 * INSIDE a submodule leave the superproject's gitlink OID unchanged, so the checkpoint
 * turn diff and the patchset capture — both of which read the superproject — cannot
 * see them. The handoff refuses such repos rather than silently losing those edits;
 * recursive submodule checkpointing is the follow-up. `git submodule status` lists one
 * line per submodule (empty when there are none).
 */
export async function repoHasSubmodules(repoRoot: string): Promise<boolean> {
  const result = await execa("git", ["submodule", "status"], {
    cwd: repoRoot,
    reject: false,
    shell: false,
    stripFinalNewline: true,
  });
  return result.exitCode === 0 && result.stdout.trim().length > 0;
}
