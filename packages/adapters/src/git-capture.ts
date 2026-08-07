import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import type { PatchsetCapturePort } from "@rennet/core";
import type { PatchFile, Patchset } from "@rennet/types";
import { execa } from "execa";
import {
  type Counts,
  DEFAULT_VISIBLE_BYTE_LIMIT,
  FILE_VISIBLE_BYTE_LIMIT,
  parseChangedPaths,
  parseCounts,
  visible,
} from "./git-range-diff";

// The changed-path / numstat / truncation parsing lives in `git-range-diff` so
// the working-tree capture here and the commit-range capture there parse a diff
// identically. This adapter keeps the working-tree-specific pieces: base
// resolution, untracked-file synthesis, and the index+unstaged+untracked union.

async function git(repositoryPath: string, arguments_: string[], reject = true): Promise<string> {
  const result = await execa("git", arguments_, {
    cwd: repositoryPath,
    reject,
    shell: false,
    stripFinalNewline: false,
  });
  return result.stdout;
}

async function succeeds(repositoryPath: string, arguments_: string[]): Promise<boolean> {
  const result = await execa("git", arguments_, {
    cwd: repositoryPath,
    reject: false,
    shell: false,
  });
  return result.exitCode === 0;
}

function quotedGitPath(path: string): string {
  return JSON.stringify(`b/${path}`);
}

async function untrackedPatch(
  repositoryRoot: string,
  path: string,
): Promise<{ patch: string; counts: Counts }> {
  const bytes = await readFile(resolve(repositoryRoot, path));
  if (bytes.includes(0)) {
    return {
      patch: `diff --git ${JSON.stringify(`a/${path}`)} ${quotedGitPath(path)}\nnew file mode 100644\nBinary files /dev/null and ${quotedGitPath(path)} differ\n`,
      counts: { additions: null, deletions: null, binary: true },
    };
  }
  const text = bytes.toString("utf8");
  const lines = text.length === 0 ? [] : text.replace(/\n$/, "").split("\n");
  const body = lines.map((line) => `+${line}`).join("\n");
  return {
    patch: [
      `diff --git ${JSON.stringify(`a/${path}`)} ${quotedGitPath(path)}`,
      "new file mode 100644",
      "--- /dev/null",
      `+++ ${quotedGitPath(path)}`,
      `@@ -0,0 +1,${lines.length} @@`,
      body,
      "",
    ].join("\n"),
    counts: { additions: lines.length, deletions: 0, binary: false },
  };
}

async function resolveBase(repositoryRoot: string): Promise<{ baseRef: string; baseOid: string }> {
  const originHead = (
    await git(
      repositoryRoot,
      ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
      false,
    )
  ).trim();
  const candidates = [originHead, "origin/main", "origin/master", "main", "master"].filter(Boolean);
  let baseRef: string | undefined;
  for (const candidate of candidates) {
    if (await succeeds(repositoryRoot, ["rev-parse", "--verify", `${candidate}^{commit}`])) {
      baseRef = candidate;
      break;
    }
  }
  if (!baseRef) baseRef = "HEAD";
  const baseOid = (await git(repositoryRoot, ["merge-base", baseRef, "HEAD"])).trim();
  return { baseRef, baseOid };
}

export class GitCaptureAdapter implements PatchsetCapturePort {
  constructor(private readonly visibleByteLimit = DEFAULT_VISIBLE_BYTE_LIMIT) {}

  async capture(repositoryPath: string): Promise<Patchset> {
    const root = (await git(repositoryPath, ["rev-parse", "--show-toplevel"])).trim();
    const commonDirValue = (await git(root, ["rev-parse", "--git-common-dir"])).trim();
    const commonDir = isAbsolute(commonDirValue) ? commonDirValue : resolve(root, commonDirValue);
    const headOid = (await git(root, ["rev-parse", "HEAD"])).trim();
    const { baseRef, baseOid } = await resolveBase(root);

    const trackedDiff = await git(root, [
      "diff",
      "--binary",
      "--full-index",
      "--no-ext-diff",
      "--no-textconv",
      baseOid,
      "--",
    ]);
    const changedPaths = parseChangedPaths(
      await git(root, ["diff", "--name-status", "-z", baseOid, "--"]),
    );
    const counts = parseCounts(await git(root, ["diff", "--numstat", "-z", baseOid, "--"]));
    const untrackedPaths = (await git(root, ["ls-files", "--others", "--exclude-standard", "-z"]))
      .split("\0")
      .filter(Boolean);

    const files: PatchFile[] = [];
    for (const changedPath of changedPaths) {
      const patch = await git(root, [
        "diff",
        "--binary",
        "--full-index",
        "--no-ext-diff",
        "--no-textconv",
        baseOid,
        "--",
        changedPath.path,
      ]);
      const fileCounts = counts.get(changedPath.path) ?? {
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

    const untrackedPatches: string[] = [];
    for (const path of untrackedPaths) {
      const { patch, counts: fileCounts } = await untrackedPatch(root, path);
      untrackedPatches.push(patch);
      files.push({
        path,
        status: "added",
        ...fileCounts,
        patch: visible(patch, FILE_VISIBLE_BYTE_LIMIT),
      });
    }

    files.sort((left, right) => left.path.localeCompare(right.path));
    const completeDiff = [trackedDiff, ...untrackedPatches].filter(Boolean).join("\n");
    const bytes = Buffer.from(completeDiff);
    const repository = {
      id: createHash("sha256").update(commonDir).digest("hex"),
      root,
      commonDir: resolve(dirname(commonDir), commonDir),
      baseRef,
      baseOid,
      headOid,
    };
    const id = createHash("sha256")
      .update(
        JSON.stringify({ repository, files: files.map(({ path, status }) => ({ path, status })) }),
      )
      .update(bytes)
      .digest("hex");

    return {
      id,
      createdAt: new Date().toISOString(),
      repository,
      files,
      rawDiff: visible(completeDiff, this.visibleByteLimit),
      byteLength: bytes.length,
      truncated: bytes.length > this.visibleByteLimit,
    };
  }
}
