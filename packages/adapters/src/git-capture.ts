import { createHash } from "node:crypto";
import { dirname, isAbsolute, posix, resolve } from "node:path";
import { detectLocus, type Locus, type PatchsetCapturePort, toWindowsView } from "@rennet/core";
import type { PatchFile, Patchset, PatchsetIntent } from "@rennet/protocol";
import { captureReviewedTree as captureReviewedWorkingTree } from "./checkpoint-store";
import {
  DEFAULT_VISIBLE_BYTE_LIMIT,
  execaGitFor,
  FILE_VISIBLE_BYTE_LIMIT,
  type GitExec,
  parseChangedPaths,
  parseCounts,
  visible,
} from "./git-range-diff";
import { snapshotSpec, specPathsOf } from "./patchset-intent-capture";

// The changed-path / numstat / truncation parsing lives in `git-range-diff` so
// the working-tree capture here and the commit-range capture there parse a diff
// identically. This adapter keeps the working-tree-specific pieces: base
// resolution and the pinned index+unstaged+untracked tree.

// Every git spawn goes through an injected, locus-aware runner (add-windows-support):
// host = `git` in cwd; WSL = `wsl.exe -d <distro> --cd <distro-cwd> -e git …`.
async function git(
  run: GitExec,
  repositoryPath: string,
  arguments_: string[],
  reject = true,
): Promise<string> {
  return run(repositoryPath, arguments_, { reject });
}

async function succeeds(
  run: GitExec,
  repositoryPath: string,
  arguments_: string[],
): Promise<boolean> {
  // `GitExec` surfaces failure as a throw (reject:true) or, with reject:false, a
  // resolved empty stdout — but we need the exit code. A non-zero exit under
  // reject:false does not throw, so a throw here means the command genuinely failed.
  try {
    await run(repositoryPath, arguments_, { reject: true });
    return true;
  } catch {
    return false;
  }
}

async function resolveBase(
  run: GitExec,
  repositoryRoot: string,
): Promise<{ baseRef: string; baseOid: string }> {
  const originHead = (
    await git(
      run,
      repositoryRoot,
      ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
      false,
    )
  ).trim();
  const candidates = [originHead, "origin/main", "origin/master", "main", "master"].filter(Boolean);
  let baseRef: string | undefined;
  for (const candidate of candidates) {
    if (await succeeds(run, repositoryRoot, ["rev-parse", "--verify", `${candidate}^{commit}`])) {
      baseRef = candidate;
      break;
    }
  }
  if (!baseRef) baseRef = "HEAD";
  const baseOid = (await git(run, repositoryRoot, ["merge-base", baseRef, "HEAD"])).trim();
  return { baseRef, baseOid };
}

export class GitCaptureAdapter implements PatchsetCapturePort {
  constructor(
    private readonly visibleByteLimit = DEFAULT_VISIBLE_BYTE_LIMIT,
    private readonly resolveProjectSnapshotId?: (
      repositoryRoot: string,
      baseOid: string,
    ) => Promise<string | undefined> | string | undefined,
    /**
     * Resolve the project's execution locus from the repo path (add-windows-support).
     * Defaults to auto-detection: a `\\wsl$` root ⇒ that distro, else host. The
     * composition passes a resolver that also honours the persisted override.
     */
    private readonly resolveLocus: (repositoryPath: string) => Locus = detectLocus,
    private readonly effects: {
      readonly gitFor?: (locus: Locus) => GitExec;
      readonly captureReviewedTree?: (root: string, locus: Locus) => Promise<string>;
    } = {},
  ) {}

  async capture(repositoryPath: string): Promise<Patchset> {
    // The locus follows the repo PATH (a `\\wsl$` project runs git in its distro).
    const locus = this.resolveLocus(repositoryPath);
    const run = (this.effects.gitFor ?? execaGitFor)(locus);
    const gitRoot = (await git(run, repositoryPath, ["rev-parse", "--show-toplevel"])).trim();
    const hostRoot = locus.kind === "wsl" ? toWindowsView(gitRoot, locus.distro) : gitRoot;
    const commonDirValue = (await git(run, gitRoot, ["rev-parse", "--git-common-dir"])).trim();
    const gitCommonDir =
      locus.kind === "wsl"
        ? commonDirValue.startsWith("/")
          ? commonDirValue
          : posix.resolve(gitRoot, commonDirValue)
        : isAbsolute(commonDirValue)
          ? commonDirValue
          : resolve(gitRoot, commonDirValue);
    const commonDir =
      locus.kind === "wsl" ? toWindowsView(gitCommonDir, locus.distro) : gitCommonDir;
    const headOid = (await git(run, gitRoot, ["rev-parse", "HEAD"])).trim();
    // The head's branch ref (the current branch name), for an own-branch PR `head`
    // (#107). `symbolic-ref --short -q` prints the branch and exits 0 on a branch,
    // and exits non-zero (empty, no throw with `reject=false`) on a detached HEAD —
    // where there is no branch to submit from, so `headRef` stays absent honestly.
    const headRef =
      (await git(run, gitRoot, ["symbolic-ref", "--short", "-q", "HEAD"], false)).trim() ||
      undefined;
    const { baseRef, baseOid } = await resolveBase(run, gitRoot);
    const reviewedTreeOid = await (this.effects.captureReviewedTree ?? captureReviewedWorkingTree)(
      gitRoot,
      locus,
    );

    const completeDiff = await git(run, gitRoot, [
      "diff",
      "--binary",
      "--full-index",
      "--no-ext-diff",
      "--no-textconv",
      baseOid,
      reviewedTreeOid,
      "--",
    ]);
    const changedPaths = parseChangedPaths(
      await git(run, gitRoot, ["diff", "--name-status", "-z", baseOid, reviewedTreeOid, "--"]),
    );
    const counts = parseCounts(
      await git(run, gitRoot, ["diff", "--numstat", "-z", baseOid, reviewedTreeOid, "--"]),
    );

    const files: PatchFile[] = [];
    for (const changedPath of changedPaths) {
      const patch = await git(run, gitRoot, [
        "diff",
        "--binary",
        "--full-index",
        "--no-ext-diff",
        "--no-textconv",
        baseOid,
        reviewedTreeOid,
        "--",
        ...(changedPath.previousPath === undefined ? [] : [changedPath.previousPath]),
        changedPath.path,
      ]);
      const fileCounts = counts.get(changedPath.path) ??
        counts.get(changedPath.previousPath ?? "") ?? {
          additions: null,
          deletions: null,
          binary: true,
        };
      files.push({
        ...changedPath,
        ...fileCounts,
        patch: visible(patch, FILE_VISIBLE_BYTE_LIMIT),
      });
    }

    files.sort((left, right) => left.path.localeCompare(right.path));
    const bytes = Buffer.from(completeDiff);
    const repository = {
      id: createHash("sha256").update(commonDir).digest("hex"),
      root: hostRoot,
      commonDir: locus.kind === "wsl" ? commonDir : resolve(dirname(commonDir), commonDir),
      baseRef,
      baseOid,
      headOid,
      reviewedTreeOid,
      ...(headRef !== undefined ? { headRef } : {}),
    };
    const id = createHash("sha256")
      .update(
        JSON.stringify({ repository, files: files.map(({ path, status }) => ({ path, status })) }),
      )
      .update(bytes)
      .digest("hex");

    const intent = await captureLocalIntent(run, gitRoot, baseOid, headOid, reviewedTreeOid, files);
    const projectSnapshotId = await this.resolveProjectSnapshotId?.(hostRoot, baseOid);

    return {
      id,
      createdAt: new Date().toISOString(),
      repository,
      files,
      rawDiff: visible(completeDiff, this.visibleByteLimit),
      byteLength: bytes.length,
      truncated: bytes.length > this.visibleByteLimit,
      ...(projectSnapshotId === undefined ? {} : { projectSnapshotId }),
      intent,
    };
  }
}

/**
 * Capture the intent surface for a local working-tree review (#136). There is no
 * PR, so `prBodyAbsent` is stamped honestly (never an empty string masquerading as
 * intent), and the available surface — the commit subjects between base and head —
 * is captured instead. The changeset's spec documents are snapshotted from their
 * current working-tree content, frozen so a later edit to the same file cannot
 * change what the review was captured against. The complete working tree is also
 * retained as `repository.reviewedTreeOid`; these inline snapshots remain for
 * compatibility with existing intent readers.
 */
async function captureLocalIntent(
  run: GitExec,
  gitRoot: string,
  baseOid: string,
  headOid: string,
  reviewedTreeOid: string,
  files: readonly PatchFile[],
): Promise<PatchsetIntent> {
  const log = await git(run, gitRoot, ["log", "--format=%s", `${baseOid}..${headOid}`], false);
  const commitSubjects = log
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const specSnapshots: ReturnType<typeof snapshotSpec>[] = [];
  for (const path of specPathsOf(files)) {
    try {
      const content = await git(run, gitRoot, ["show", `${reviewedTreeOid}:${path}`]);
      specSnapshots.push(snapshotSpec(path, content));
    } catch {
      // Deleted or unreadable in the working tree: omit it honestly.
    }
  }

  return {
    surface: "working-tree",
    prBodyAbsent: true,
    ...(commitSubjects.length > 0 ? { commitSubjects } : {}),
    ...(specSnapshots.length > 0 ? { specSnapshots } : {}),
  };
}
