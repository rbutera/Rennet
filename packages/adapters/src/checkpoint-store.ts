import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CheckpointPort,
  type CheckpointRef,
  HOST_LOCUS,
  type Locus,
  locusCommand,
} from "@rennet/core";
import { execa } from "execa";
import { APP_OWNED_PATHSPEC } from "./git-range-diff";

// ─────────────────────────────────────────────────────────────────────────────
// The workspace checkpoint store — the CAPTURE side of the review→agent handoff
// loop (issue #18). It brackets a write-enabled agent turn so the exact turn diff
// can be extracted.
//
// VENDORED PATTERN — attribution: this is T3 Code's checkpoint-as-hidden-git-ref
// technique (`pingdotgg/t3code`, MIT: `CheckpointStore.ts`, `CheckpointDiffQuery.ts`,
// `checkpointing/Utils.ts`), described in the docsite context-assembly page and
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
const REVIEW_TREE_REF_PREFIX = "refs/rennet/review-trees/";
const CHECKPOINT_MESSAGE = "rennet: handoff checkpoint";

/**
 * The `GIT_INDEX_FILE` a checkpoint stages into. On the host it's a host temp path
 * passed via execa's `env`. Across the WSL boundary, execa's `env` does NOT reach
 * the distro process (WSLENV would be needed), so the checkpoint index lives at a
 * DISTRO temp path and the var is set INSIDE the distro by prefixing the spawn with
 * `env GIT_INDEX_FILE=… git …` (add-windows-support). `-e` passes it byte-verbatim.
 */
function checkpointIndexPath(locus: Locus): string {
  const name = `rennet-checkpoint-${randomUUID()}.index`;
  return locus.kind === "wsl" ? `/tmp/${name}` : join(tmpdir(), name);
}

/**
 * Build the checkpoint git spawn for a locus (pure, testable). On the host with a
 * `gitIndexFile` the var rides in execa's `env`; across the WSL boundary execa's env
 * does not reach the distro, so the spawn is prefixed `env GIT_INDEX_FILE=… git …`
 * inside the distro (add-windows-support). Returns the spawn plus the host-only env.
 */
export function checkpointGitCommand(
  locus: Locus,
  root: string,
  arguments_: string[],
  gitIndexFile?: string,
): { file: string; args: readonly string[]; cwd?: string; env?: NodeJS.ProcessEnv } {
  let program = "git";
  let programArgs = arguments_;
  if (gitIndexFile !== undefined && locus.kind === "wsl") {
    program = "env";
    programArgs = [`GIT_INDEX_FILE=${gitIndexFile}`, "git", ...arguments_];
  }
  const command = locusCommand(locus, program, programArgs, root);
  const env =
    gitIndexFile !== undefined && locus.kind === "host"
      ? { ...process.env, GIT_INDEX_FILE: gitIndexFile }
      : undefined;
  return { ...command, ...(env ? { env } : {}) };
}

async function runGit(
  locus: Locus,
  root: string,
  arguments_: string[],
  options: { reject?: boolean; gitIndexFile?: string } = {},
) {
  const { file, args, cwd, env } = checkpointGitCommand(
    locus,
    root,
    arguments_,
    options.gitIndexFile,
  );
  return execa(file, [...args], {
    ...(cwd === undefined ? {} : { cwd }),
    reject: options.reject ?? true,
    shell: false,
    stripFinalNewline: true,
    ...(env ? { env } : {}),
  });
}

async function git(
  locus: Locus,
  root: string,
  arguments_: string[],
  gitIndexFile?: string,
): Promise<string> {
  const result = await runGit(locus, root, arguments_, { gitIndexFile });
  return result.stdout;
}

/** Resolve HEAD's commit OID, or null in a repository with no commits yet. */
async function headOid(locus: Locus, root: string): Promise<string | null> {
  const result = await runGit(locus, root, ["rev-parse", "--verify", "--quiet", "HEAD"], {
    reject: false,
  });
  return result.exitCode === 0 && result.stdout ? result.stdout : null;
}

/**
 * Materialise the literal working tree in a throwaway index without changing the
 * user's real index. Seeding from the real index tree is load-bearing: an empty
 * temporary index followed by `add -A` silently omits a tracked path that is now
 * ignored (including a newly force-added path), even though it belongs to the
 * user's reviewed tree.
 *
 * App-owned board state is dropped from the temporary index BEFORE the tree is
 * written (#729, D6). This is the one place it can be dropped: every other fact a
 * capture derives — the reviewed-tree OID, the diff, the file list, byte counts,
 * intent and the patchset id — comes from this tree, so filtering downstream would
 * still leave a contaminated OID silently changing the review's identity every time
 * Rennet wrote a board. `git rm --cached` is index-only and never touches a file on
 * disk; `-f` skips the up-to-date check and `--ignore-unmatch` makes the usual case
 * (no board store at all) a no-op rather than an error.
 *
 * The removal covers the checkpoint store too, and should: a bracketed agent turn's
 * diff is what the AGENT changed, not what Rennet wrote beside it.
 *
 * Everything else under `.rennet/` stays. Tracked means intentional, so a
 * `.rennet/conventions.json` edit is captured like any other project file — and
 * `.rennet/boards-extra` is the user's, because the app never writes there.
 */
async function writeWorkingTree(locus: Locus, root: string, indexFile: string): Promise<string> {
  const indexTree = await git(locus, root, ["write-tree"]);
  await git(locus, root, ["read-tree", indexTree], indexFile);
  await git(locus, root, ["add", "-A"], indexFile);
  await git(
    locus,
    root,
    ["rm", "--cached", "-r", "-f", "--quiet", "--ignore-unmatch", "--", APP_OWNED_PATHSPEC],
    indexFile,
  );
  return git(locus, root, ["write-tree"], indexFile);
}

async function removeSnapshotIndex(locus: Locus, indexFile: string): Promise<void> {
  if (locus.kind === "host") {
    await rm(indexFile, { force: true });
    return;
  }
  const command = locusCommand(locus, "rm", ["-f", indexFile]);
  await execa(command.file, [...command.args], { reject: false, shell: false });
}

/**
 * Capture and retain the complete local working-tree state as a deterministic Git
 * tree. The ref points directly to the tree: no synthetic commit, author identity,
 * timestamp, branch, HEAD, or real-index mutation participates in the snapshot.
 */
export async function captureReviewedTree(
  root: string,
  locus: Locus = HOST_LOCUS,
): Promise<string> {
  const indexFile = checkpointIndexPath(locus);
  try {
    const tree = await writeWorkingTree(locus, root, indexFile);
    await git(locus, root, [
      "-c",
      "core.logAllRefUpdates=false",
      "update-ref",
      `${REVIEW_TREE_REF_PREFIX}${tree}`,
      tree,
    ]);
    return tree;
  } finally {
    await removeSnapshotIndex(locus, indexFile);
  }
}

/**
 * A checkpoint store bound to one repository root. Implements the node-free
 * `CheckpointPort` the core handoff orchestrator (`runHandoffTurn`) depends on, so
 * `core` never imports this git-bound module — the desktop composition root wires it.
 */
export class GitCheckpointStore implements CheckpointPort {
  /** The project's execution locus (add-windows-support). Defaults to the host. */
  constructor(
    private readonly root: string,
    private readonly locus: Locus = HOST_LOCUS,
  ) {}

  /**
   * Snapshot the current working tree into a hidden checkpoint ref and return it.
   * Uses a throwaway temp index so the user's real index is never touched; the
   * snapshot captures tracked modifications, deletions, and non-ignored untracked
   * files (the same content set `GitCaptureAdapter` captures), so the turn diff
   * between two checkpoints is exactly what the agent changed.
   */
  async capture(): Promise<CheckpointRef> {
    const indexFile = checkpointIndexPath(this.locus);
    try {
      const tree = await writeWorkingTree(this.locus, this.root, indexFile);
      const parent = await headOid(this.locus, this.root);
      const commit = await git(
        this.locus,
        this.root,
        parent
          ? ["commit-tree", tree, "-p", parent, "-m", CHECKPOINT_MESSAGE]
          : ["commit-tree", tree, "-m", CHECKPOINT_MESSAGE],
        indexFile,
      );
      const ref = `${CHECKPOINT_REF_PREFIX}${randomUUID()}`;
      // A hidden ref — off every branch. `-c core.logAllRefUpdates=false` suppresses a
      // reflog even when the user's config is `always` (Codex F5: without this, a
      // reflog IS written for refs/rennet/*, so the "reflog stays clean" claim only
      // holds when we force it off here).
      await git(this.locus, this.root, [
        "-c",
        "core.logAllRefUpdates=false",
        "update-ref",
        ref,
        commit,
      ]);
      return { ref, commit };
    } finally {
      // The temp index is disposable — never leave it behind. On the host it's a
      // host temp file; in the distro it's a distro temp file, removed in-distro.
      await this.removeCheckpointIndex(indexFile);
    }
  }

  /** Remove the throwaway checkpoint index at its locus (host fs vs in-distro rm). */
  private async removeCheckpointIndex(indexFile: string): Promise<void> {
    await removeSnapshotIndex(this.locus, indexFile);
  }

  /**
   * The turn diff: the tree-to-tree diff between two checkpoints, in the unified
   * `diff --git a/… b/…` format, for DISPLAY. `changedPaths` (not this) is the
   * authoritative file list — parsing this display diff loses quoted/spaced paths.
   */
  async diff(from: CheckpointRef, to: CheckpointRef): Promise<string> {
    return git(this.locus, this.root, [
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
    const out = await git(this.locus, this.root, [
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
    await runGit(this.locus, this.root, ["update-ref", "-d", ref.ref], { reject: false });
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
export async function repoHasSubmodules(
  repoRoot: string,
  locus: Locus = HOST_LOCUS,
): Promise<boolean> {
  const result = await runGit(locus, repoRoot, ["submodule", "status"], { reject: false });
  return result.exitCode === 0 && result.stdout.trim().length > 0;
}
