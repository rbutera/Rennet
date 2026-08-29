import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import type {
  RoundSourceLandingUnitReceipt,
  TransactionalRoundSourceLandingAttempt,
  TransactionalRoundSourceLandingReceipt,
} from "@rennet/protocol";
import { TransactionalRoundSourceLandingAttemptSchema } from "@rennet/protocol";
import { afterEach, describe, expect, it } from "vitest";
import type { ExclusiveNamespaceMover } from "./exclusive-namespace-move";
import { applyVisibilitySwitch } from "./map-visibility";
import { ProjectSnapshotStore } from "./project-snapshot-store";
import {
  type AnchoredRoundSourceLandingFileSystem,
  cleanupTransactionalRoundSourceLanding,
  planTransactionalRoundSourceLanding,
  RoundSourceLandingConflictError,
  landTransactionalRoundSourceUnit as runTransactionalRoundSourceUnit,
} from "./round-source-landing";
import {
  assertTestOnlyLandingRelativePath,
  bindTestOnlyRoundSourceLandingGit,
  createTestOnlyHostLandingFileSystem,
} from "./round-source-landing.test-only-unsafe-host";

const roots: string[] = [];
const FILTERED_BASELINE = Buffer.from("base\r\nline\n");
const FILTERED_CLEAN_EQUIVALENT = Buffer.from("base\nline\r\n");

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function gitInfoExcludePath(root: string): string {
  const gitPath = git(root, "rev-parse", "--git-path", "info/exclude");
  return isAbsolute(gitPath) ? gitPath : join(root, gitPath);
}

function transactionIgnoreMatch(
  root: string,
  path: string,
): { readonly source: string; readonly pattern: string; readonly path: string } {
  const output = git(root, "check-ignore", "-v", "--no-index", "--", path);
  const tab = output.lastIndexOf("\t");
  const patternSeparator = output.lastIndexOf(":", tab);
  const lineSeparator = output.lastIndexOf(":", patternSeparator - 1);
  if (tab < 0 || patternSeparator < 0 || lineSeparator < 0) {
    throw new Error(`unexpected git check-ignore output ${JSON.stringify(output)}`);
  }
  return {
    source: output.slice(0, lineSeparator),
    pattern: output.slice(patternSeparator + 1, tab),
    path: output.slice(tab + 1),
  };
}

function pathOccupied(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

function exclusiveRenameMover(): ExclusiveNamespaceMover {
  return {
    async move({ sourcePath, destinationPath }) {
      if (pathOccupied(destinationPath)) return { kind: "destination-exists", nativeCode: 17 };
      if (!pathOccupied(sourcePath)) return { kind: "path-missing", nativeCode: 2 };
      renameSync(sourcePath, destinationPath);
      return { kind: "moved" };
    },
  };
}

function fixture(): {
  readonly sourceRoot: string;
  readonly worktreePath: string;
  readonly baselineCommit: string;
  readonly workerHead: string;
} {
  const sourceRoot = mkdtempSync(join(tmpdir(), "rennet-landing-source-"));
  const worktreeParent = mkdtempSync(join(tmpdir(), "rennet-landing-worker-parent-"));
  const worktreePath = join(worktreeParent, "worker");
  roots.push(sourceRoot, worktreeParent);
  git(sourceRoot, "init", "-b", "main");
  git(sourceRoot, "config", "user.email", "landing@test.invalid");
  git(sourceRoot, "config", "user.name", "Landing Test");
  const isolatedExcludes = join(sourceRoot, ".git", "test-global-excludes");
  writeFileSync(isolatedExcludes, "");
  git(sourceRoot, "config", "core.excludesFile", isolatedExcludes);
  writeFileSync(join(sourceRoot, ".gitattributes"), "filtered.txt text eol=crlf\n");
  writeFileSync(join(sourceRoot, "delete.txt"), "delete me\n");
  writeFileSync(join(sourceRoot, "filtered.txt"), FILTERED_BASELINE);
  writeFileSync(join(sourceRoot, "replace.bin"), Buffer.from([0, 1, 2, 255]));
  writeFileSync(join(sourceRoot, "mode.sh"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(sourceRoot, "mode.sh"), 0o644);
  writeFileSync(join(sourceRoot, "link-target-a"), "a\n");
  writeFileSync(join(sourceRoot, "link-target-b"), "b\n");
  symlinkSync("link-target-a", join(sourceRoot, "current-link"));
  writeFileSync(join(sourceRoot, "unrelated.txt"), "baseline\n");
  mkdirSync(join(sourceRoot, "guarded"));
  writeFileSync(join(sourceRoot, "guarded", "leaf.txt"), "guarded baseline\n");
  writeFileSync(join(sourceRoot, "file-to-dir"), "old file\n");
  mkdirSync(join(sourceRoot, "dir-to-file"));
  writeFileSync(join(sourceRoot, "dir-to-file", "child.txt"), "old child\n");
  git(sourceRoot, "add", "-A");
  git(sourceRoot, "commit", "-m", "baseline");
  const baselineCommit = git(sourceRoot, "rev-parse", "HEAD");

  git(sourceRoot, "worktree", "add", "--detach", worktreePath, baselineCommit);
  unlinkSync(join(worktreePath, "delete.txt"));
  writeFileSync(join(worktreePath, "filtered.txt"), "worker\r\n");
  writeFileSync(join(worktreePath, "replace.bin"), Buffer.from([255, 4, 0, 3, 2, 1]));
  writeFileSync(join(worktreePath, "created.txt"), "created\n");
  writeFileSync(join(worktreePath, "guarded", "leaf.txt"), "guarded worker\n");
  chmodSync(join(worktreePath, "mode.sh"), 0o755);
  unlinkSync(join(worktreePath, "current-link"));
  symlinkSync("link-target-b", join(worktreePath, "current-link"));
  unlinkSync(join(worktreePath, "file-to-dir"));
  mkdirSync(join(worktreePath, "file-to-dir"));
  writeFileSync(join(worktreePath, "file-to-dir", "child.txt"), "new child\n");
  rmSync(join(worktreePath, "dir-to-file"), { recursive: true });
  writeFileSync(join(worktreePath, "dir-to-file"), "new file\n");
  git(worktreePath, "add", "-A");
  git(worktreePath, "commit", "-m", "worker target");
  const workerHead = git(worktreePath, "rev-parse", "HEAD");
  writeFileSync(join(sourceRoot, "unrelated.txt"), "user edit\n");
  return { sourceRoot, worktreePath, baselineCommit, workerHead };
}

function replacementFixture(fileCount: number): ReturnType<typeof fixture> {
  const sourceRoot = mkdtempSync(join(tmpdir(), "rennet-landing-scale-source-"));
  const worktreeParent = mkdtempSync(join(tmpdir(), "rennet-landing-scale-worker-parent-"));
  const worktreePath = join(worktreeParent, "worker");
  roots.push(sourceRoot, worktreeParent);
  git(sourceRoot, "init", "-b", "main");
  git(sourceRoot, "config", "user.email", "landing@test.invalid");
  git(sourceRoot, "config", "user.name", "Landing Test");
  const isolatedExcludes = join(sourceRoot, ".git", "test-global-excludes");
  writeFileSync(isolatedExcludes, "");
  git(sourceRoot, "config", "core.excludesFile", isolatedExcludes);
  for (let index = 0; index < fileCount; index += 1) {
    writeFileSync(join(sourceRoot, `replacement-${index}.txt`), `baseline ${index}\n`);
  }
  git(sourceRoot, "add", "-A");
  git(sourceRoot, "commit", "-m", "baseline");
  const baselineCommit = git(sourceRoot, "rev-parse", "HEAD");
  git(sourceRoot, "worktree", "add", "--detach", worktreePath, baselineCommit);
  for (let index = 0; index < fileCount; index += 1) {
    writeFileSync(join(worktreePath, `replacement-${index}.txt`), `target ${index}\n`);
  }
  git(worktreePath, "add", "-A");
  git(worktreePath, "commit", "-m", "worker target");
  const workerHead = git(worktreePath, "rev-parse", "HEAD");
  return { sourceRoot, worktreePath, baselineCommit, workerHead };
}

async function plan(
  current: ReturnType<typeof fixture>,
  onGitCall?: (arguments_: readonly string[]) => void,
): Promise<TransactionalRoundSourceLandingAttempt> {
  const fileSystem = createTestOnlyHostLandingFileSystem({
    sourceRoot: current.sourceRoot,
    workerRoot: current.worktreePath,
    mover: exclusiveRenameMover(),
    ...(onGitCall === undefined ? {} : { onGitCall }),
  });
  return planTransactionalRoundSourceLanding({
    git: bindTestOnlyRoundSourceLandingGit(current.worktreePath, onGitCall),
    fileSystem,
    executionId: "transaction-1",
    baselineCommit: current.baselineCommit,
    workerHead: current.workerHead,
    startedAt: 10,
  });
}

type TestLandingInput = {
  readonly sourceRoot: string;
  readonly worktreePath: string;
  readonly attempt: TransactionalRoundSourceLandingAttempt;
  readonly unit: TransactionalRoundSourceLandingAttempt["units"][number];
  readonly mover: ExclusiveNamespaceMover;
  readonly fileSystem?: AnchoredRoundSourceLandingFileSystem;
  readonly fullPreflight?: boolean;
  readonly now?: () => number;
};

function landTransactionalRoundSourceUnit(input: TestLandingInput) {
  const fileSystem =
    input.fileSystem ??
    createTestOnlyHostLandingFileSystem({
      sourceRoot: input.sourceRoot,
      workerRoot: input.worktreePath,
      mover: input.mover,
    });
  return runTransactionalRoundSourceUnit({
    fileSystem,
    attempt: input.attempt,
    unit: input.unit,
    fullPreflight: input.fullPreflight ?? input.attempt.unitReceipts.length === 0,
    ...(input.now === undefined ? {} : { now: input.now }),
  });
}

function recordRelativeFileSystemPaths(
  fileSystem: AnchoredRoundSourceLandingFileSystem,
  seen: string[],
): AnchoredRoundSourceLandingFileSystem {
  const record = (path: string) => {
    assertTestOnlyLandingRelativePath(path);
    seen.push(path);
  };
  return {
    ensureInternalExclusion(input) {
      record(input.artifactRoot);
      return fileSystem.ensureInternalExclusion(input);
    },
    inspect(input) {
      record(input.path);
      record(input.repoPath);
      return fileSystem.inspect(input);
    },
    manifestLeafPaths(input) {
      record(input.path);
      return fileSystem.manifestLeafPaths(input);
    },
    ensureParent(input) {
      record(input.path);
      return fileSystem.ensureParent(input);
    },
    materializeTarget(input) {
      record(input.sourcePath);
      record(input.destinationPath);
      return fileSystem.materializeTarget(input);
    },
    move(input) {
      record(input.sourcePath);
      record(input.destinationPath);
      return fileSystem.move(input);
    },
    remove(input) {
      record(input.path);
      return fileSystem.remove(input);
    },
    removeEmptyParents(input) {
      record(input.path);
      return fileSystem.removeEmptyParents(input);
    },
    removeEmptyDirectory(input) {
      record(input.path);
      return fileSystem.removeEmptyDirectory(input);
    },
  };
}

describe("transactional round source landing", () => {
  it("freezes a deterministic per-path manifest", async () => {
    const current = fixture();
    const first = await plan(current);
    const second = await plan(current);

    expect(second).toEqual(first);
    expect(first.units.map((unit) => unit.path)).toEqual([
      "dir-to-file/child.txt",
      "delete.txt",
      "file-to-dir",
      "current-link",
      "filtered.txt",
      "guarded/leaf.txt",
      "mode.sh",
      "replace.bin",
      "created.txt",
      "dir-to-file",
      "file-to-dir/child.txt",
    ]);
    expect(first.units.every((unit) => unit.stagePath.includes(unit.id))).toBe(true);
    expect(first.units.every((unit) => unit.backupPath.includes(unit.id))).toBe(true);

    const filtered = first.units.find((unit) => unit.path === "filtered.txt");
    if (filtered?.baseline.kind !== "git") {
      throw new Error("fixture did not produce a filtered baseline descriptor");
    }
    expect(filtered.baseline.rawSha256).toBe(
      createHash("sha256").update(FILTERED_BASELINE).digest("hex"),
    );
    const link = first.units.find((unit) => unit.path === "current-link");
    if (link?.baseline.kind !== "git" || link.target.kind !== "git") {
      throw new Error("fixture did not produce symlink descriptors");
    }
    expect(link.baseline.rawSha256).toBe(
      createHash("sha256").update("link-target-a").digest("hex"),
    );
    expect(link.target.rawSha256).toBe(createHash("sha256").update("link-target-b").digest("hex"));
    expect(
      TransactionalRoundSourceLandingAttemptSchema.parse(JSON.parse(JSON.stringify(first))),
    ).toEqual(first);
  });

  it("preflights every path before mutating the first unit", async () => {
    const current = fixture();
    const attempt = await plan(current);
    writeFileSync(join(current.sourceRoot, "created.txt"), "conflicting user file\n");
    const firstUnit = attempt.units[0];
    if (firstUnit === undefined) throw new Error("fixture did not produce a landing unit");

    await expect(
      landTransactionalRoundSourceUnit({
        sourceRoot: current.sourceRoot,
        worktreePath: current.worktreePath,
        attempt,
        unit: firstUnit,
        mover: exclusiveRenameMover(),
      }),
    ).rejects.toThrow(RoundSourceLandingConflictError);
    expect(readFileSync(join(current.sourceRoot, firstUnit.path), "utf8")).toBe("old child\n");
    expect(pathOccupied(join(current.sourceRoot, firstUnit.backupPath))).toBe(false);
  });

  it("preflights every future worker target before mutating the first unit", async () => {
    const current = fixture();
    const attempt = await plan(current);
    const firstUnit = attempt.units[0];
    const laterWorkerUnit = attempt.units.find((unit) => unit.path === "replace.bin");
    if (firstUnit === undefined || laterWorkerUnit === undefined) {
      throw new Error("fixture did not produce the expected landing units");
    }
    writeFileSync(
      join(current.worktreePath, laterWorkerUnit.path),
      "worker drift after planning\n",
    );

    await expect(
      landTransactionalRoundSourceUnit({
        sourceRoot: current.sourceRoot,
        worktreePath: current.worktreePath,
        attempt,
        unit: firstUnit,
        mover: exclusiveRenameMover(),
      }),
    ).rejects.toThrow("worker target is");
    expect(readFileSync(join(current.sourceRoot, firstUnit.path), "utf8")).toBe("old child\n");
    expect(pathOccupied(join(current.sourceRoot, firstUnit.backupPath))).toBe(false);
  });

  it("preflights every transaction artifact before mutating the first unit", async () => {
    const current = fixture();
    const attempt = await plan(current);
    const firstUnit = attempt.units[0];
    const laterUnit = attempt.units.at(-1);
    if (firstUnit === undefined || laterUnit === undefined) {
      throw new Error("fixture did not produce landing units");
    }
    const fileSystem = createTestOnlyHostLandingFileSystem({
      sourceRoot: current.sourceRoot,
      workerRoot: current.worktreePath,
      mover: exclusiveRenameMover(),
    });
    await fileSystem.ensureInternalExclusion({
      artifactRoot: assertTestOnlyLandingRelativePath(".rennet/round-landings"),
    });
    const laterStage = join(current.sourceRoot, laterUnit.stagePath);
    mkdirSync(dirname(laterStage), { recursive: true });
    writeFileSync(laterStage, "conflicting transaction artifact\n");

    await expect(
      landTransactionalRoundSourceUnit({
        sourceRoot: current.sourceRoot,
        worktreePath: current.worktreePath,
        attempt,
        unit: firstUnit,
        mover: exclusiveRenameMover(),
        fileSystem,
      }),
    ).rejects.toThrow("transaction stage is");
    expect(readFileSync(join(current.sourceRoot, firstUnit.path), "utf8")).toBe("old child\n");
    expect(pathOccupied(join(current.sourceRoot, firstUnit.backupPath))).toBe(false);
  });

  it("revalidates only the current unit after the drive's one full preflight", async () => {
    const current = fixture();
    let attempt = await plan(current);
    const firstUnit = attempt.units[0];
    const secondUnit = attempt.units[1];
    const laterUnit = attempt.units.find((unit) => unit.path === "replace.bin");
    if (firstUnit === undefined || secondUnit === undefined || laterUnit === undefined) {
      throw new Error("fixture did not produce the expected landing units");
    }
    const mover = exclusiveRenameMover();
    const firstReceipt = await landTransactionalRoundSourceUnit({
      sourceRoot: current.sourceRoot,
      worktreePath: current.worktreePath,
      attempt,
      unit: firstUnit,
      mover,
      fullPreflight: true,
    });
    attempt = { ...attempt, unitReceipts: [firstReceipt] };
    const laterBytes = Buffer.from("later unit changed after the full preflight\n");
    writeFileSync(join(current.sourceRoot, laterUnit.path), laterBytes);

    const receipt = await landTransactionalRoundSourceUnit({
      sourceRoot: current.sourceRoot,
      worktreePath: current.worktreePath,
      attempt,
      unit: secondUnit,
      mover,
      fullPreflight: false,
    });

    expect(receipt.unitId).toBe(secondUnit.id);
    expect(readFileSync(join(current.sourceRoot, laterUnit.path))).toEqual(laterBytes);
  });

  it("preserves clean-equivalent user bytes that changed after planning", async () => {
    const current = fixture();
    let attempt = TransactionalRoundSourceLandingAttemptSchema.parse(
      JSON.parse(JSON.stringify(await plan(current))),
    );
    const mover = exclusiveRenameMover();
    const filteredUnit = attempt.units.find((unit) => unit.path === "filtered.txt");
    if (filteredUnit?.baseline.kind !== "git") {
      throw new Error("fixture did not produce filtered.txt");
    }
    expect(FILTERED_CLEAN_EQUIVALENT.byteLength).toBe(FILTERED_BASELINE.byteLength);
    expect(filteredUnit.baseline.rawSha256).toBe(
      createHash("sha256").update(FILTERED_BASELINE).digest("hex"),
    );

    for (const unit of attempt.units) {
      if (unit.id === filteredUnit.id) break;
      const receipt = await landTransactionalRoundSourceUnit({
        sourceRoot: current.sourceRoot,
        worktreePath: current.worktreePath,
        attempt,
        unit,
        mover,
      });
      attempt = { ...attempt, unitReceipts: [...attempt.unitReceipts, receipt] };
    }

    const livePath = join(current.sourceRoot, filteredUnit.path);
    const baseFileSystem = createTestOnlyHostLandingFileSystem({
      sourceRoot: current.sourceRoot,
      workerRoot: current.worktreePath,
      mover,
    });
    let raced = false;
    const racingFileSystem: AnchoredRoundSourceLandingFileSystem = {
      ...baseFileSystem,
      async move(paths) {
        assertTestOnlyLandingRelativePath(paths.sourcePath);
        assertTestOnlyLandingRelativePath(paths.destinationPath);
        if (
          !raced &&
          paths.sourcePath === filteredUnit.path &&
          paths.destinationPath === filteredUnit.backupPath
        ) {
          raced = true;
          writeFileSync(livePath, FILTERED_CLEAN_EQUIVALENT);
          expect(git(current.sourceRoot, "diff", "--quiet", "--", filteredUnit.path)).toBe("");
        }
        return baseFileSystem.move(paths);
      },
    };

    await expect(
      landTransactionalRoundSourceUnit({
        sourceRoot: current.sourceRoot,
        worktreePath: current.worktreePath,
        attempt,
        unit: filteredUnit,
        mover,
        fileSystem: racingFileSystem,
      }),
    ).rejects.toThrow("restored the concurrent bytes to the live path");
    expect(raced).toBe(true);
    expect(readFileSync(livePath)).toEqual(FILTERED_CLEAN_EQUIVALENT);
    expect(pathOccupied(join(current.sourceRoot, filteredUnit.backupPath))).toBe(false);
  }, 30_000);

  it("keeps every Git execution linear when the manifest doubles", async () => {
    async function drive(
      fileCount: number,
    ): Promise<{ readonly calls: number; readonly units: number }> {
      const current = replacementFixture(fileCount);
      let calls = 0;
      const onGitCall = () => {
        calls += 1;
      };
      let attempt = await plan(current, onGitCall);
      const fileSystem = createTestOnlyHostLandingFileSystem({
        sourceRoot: current.sourceRoot,
        workerRoot: current.worktreePath,
        mover: exclusiveRenameMover(),
        onGitCall,
      });
      for (const [index, unit] of attempt.units.entries()) {
        const receipt = await runTransactionalRoundSourceUnit({
          fileSystem,
          attempt,
          unit,
          fullPreflight: index === 0,
        });
        attempt = { ...attempt, unitReceipts: [...attempt.unitReceipts, receipt] };
      }
      return { calls, units: attempt.units.length };
    }

    const n = await drive(4);
    const twoN = await drive(8);

    expect(twoN.units).toBe(n.units * 2);
    expect(twoN.calls).toBeGreaterThan(n.calls);
    expect(twoN.calls).toBeLessThanOrEqual(n.calls * 2);
  }, 30_000);

  it("re-inspects an unknown helper outcome before deciding whether to retry", async () => {
    const current = fixture();
    const attempt = await plan(current);
    const unit = attempt.units[0];
    if (unit === undefined) throw new Error("fixture did not produce a landing unit");
    let moves = 0;
    const movedButInterrupted: ExclusiveNamespaceMover = {
      async move({ sourcePath, destinationPath }) {
        moves += 1;
        renameSync(sourcePath, destinationPath);
        return { kind: "outcome-unknown", detail: "helper connection closed" };
      },
    };

    const receipt = await landTransactionalRoundSourceUnit({
      sourceRoot: current.sourceRoot,
      worktreePath: current.worktreePath,
      attempt,
      unit,
      mover: movedButInterrupted,
    });

    expect(receipt.outcome).toBe("applied");
    expect(moves).toBe(1);
    expect(existsSync(join(current.sourceRoot, unit.path))).toBe(false);
  });

  it("rolls a concurrent edit back to the live path before surfacing conflict", async () => {
    const current = fixture();
    const attempt = await plan(current);
    const unit = attempt.units[0];
    if (unit === undefined) throw new Error("fixture did not produce a landing unit");
    const delegate = exclusiveRenameMover();
    let raced = false;
    const editBeforeMove: ExclusiveNamespaceMover = {
      async move(paths) {
        if (!raced) {
          raced = true;
          writeFileSync(paths.sourcePath, "concurrent user edit\n");
        }
        return delegate.move(paths);
      },
    };

    await expect(
      landTransactionalRoundSourceUnit({
        sourceRoot: current.sourceRoot,
        worktreePath: current.worktreePath,
        attempt,
        unit,
        mover: editBeforeMove,
      }),
    ).rejects.toThrow("restored the concurrent bytes to the live path");
    expect(readFileSync(join(current.sourceRoot, unit.path), "utf8")).toBe(
      "concurrent user edit\n",
    );
    expect(pathOccupied(join(current.sourceRoot, unit.backupPath))).toBe(false);
  });

  it("restores bytes that change between preflight and the baseline move", async () => {
    const current = fixture();
    const attempt = await plan(current);
    const unit = attempt.units[0];
    if (unit === undefined) throw new Error("fixture did not produce a landing unit");
    const delegate = exclusiveRenameMover();
    let raced = false;
    const editBeforeMove: ExclusiveNamespaceMover = {
      async move(paths): Promise<never> {
        if (!raced) {
          raced = true;
          writeFileSync(paths.sourcePath, "concurrent user edit\n");
        }
        await delegate.move(paths);
        throw new Error("simulated process death after racing baseline move");
      },
    };

    await expect(
      landTransactionalRoundSourceUnit({
        sourceRoot: current.sourceRoot,
        worktreePath: current.worktreePath,
        attempt,
        unit,
        mover: editBeforeMove,
      }),
    ).rejects.toThrow("simulated process death");
    expect(pathOccupied(join(current.sourceRoot, unit.path))).toBe(false);

    await expect(
      landTransactionalRoundSourceUnit({
        sourceRoot: current.sourceRoot,
        worktreePath: current.worktreePath,
        attempt,
        unit,
        mover: delegate,
      }),
    ).rejects.toThrow("restored a concurrent edit stranded");
    expect(readFileSync(join(current.sourceRoot, unit.path), "utf8")).toBe(
      "concurrent user edit\n",
    );
    expect(pathOccupied(join(current.sourceRoot, unit.backupPath))).toBe(false);
  });

  it("keeps retained failure artifacts ignored by the client repository", async () => {
    const current = fixture();
    const attempt = await plan(current);
    const unit = attempt.units[0];
    if (unit === undefined) throw new Error("fixture did not produce a landing unit");
    const delegate = exclusiveRenameMover();
    let raced = false;
    let exclusionVerifiedBeforeMove = false;
    const crashAfterBackup: ExclusiveNamespaceMover = {
      async move(paths): Promise<never> {
        if (!raced) {
          raced = true;
          const match = transactionIgnoreMatch(current.sourceRoot, unit.backupPath);
          expect(match.source).toBe(
            git(current.sourceRoot, "rev-parse", "--git-path", "info/exclude"),
          );
          expect(match.pattern).toBe("/.rennet/round-landings/");
          expect(match.path).toBe(unit.backupPath);
          exclusionVerifiedBeforeMove = true;
          writeFileSync(paths.sourcePath, "concurrent user edit\n");
        }
        await delegate.move(paths);
        throw new Error("simulated process death after retaining the backup");
      },
    };

    await expect(
      landTransactionalRoundSourceUnit({
        sourceRoot: current.sourceRoot,
        worktreePath: current.worktreePath,
        attempt,
        unit,
        mover: crashAfterBackup,
      }),
    ).rejects.toThrow("simulated process death");
    expect(exclusionVerifiedBeforeMove).toBe(true);
    expect(pathOccupied(join(current.sourceRoot, unit.backupPath))).toBe(true);
    expect(
      git(
        current.sourceRoot,
        "status",
        "--porcelain",
        "--untracked-files=all",
        "--",
        ".rennet/round-landings",
      ),
    ).toBe("");
    expect(transactionIgnoreMatch(current.sourceRoot, unit.backupPath)).toEqual({
      source: git(current.sourceRoot, "rev-parse", "--git-path", "info/exclude"),
      pattern: "/.rennet/round-landings/",
      path: unit.backupPath,
    });

    const storeDir = mkdtempSync(join(tmpdir(), "rennet-landing-visibility-store-"));
    roots.push(storeDir);
    const store = new ProjectSnapshotStore(storeDir);
    for (const visibility of ["local", "git-visible"] as const) {
      await applyVisibilitySwitch(store, "landing-repo", current.sourceRoot, visibility);
      expect(transactionIgnoreMatch(current.sourceRoot, unit.backupPath).pattern).toBe(
        "/.rennet/round-landings/",
      );
    }
  });

  it("refuses to hide pre-existing Git-visible transaction namespace content", async () => {
    const current = fixture();
    const attempt = await plan(current);
    const unit = attempt.units[0];
    if (unit === undefined) throw new Error("fixture did not produce a landing unit");
    const userPath = join(current.sourceRoot, ".rennet", "round-landings", "user-owned.txt");
    mkdirSync(dirname(userPath), { recursive: true });
    writeFileSync(userPath, "user-owned visible content\n");
    const excludePath = gitInfoExcludePath(current.sourceRoot);
    const before = readFileSync(excludePath);

    await expect(
      landTransactionalRoundSourceUnit({
        sourceRoot: current.sourceRoot,
        worktreePath: current.worktreePath,
        attempt,
        unit,
        mover: exclusiveRenameMover(),
      }),
    ).rejects.toThrow(/visible|transaction namespace/i);

    expect(readFileSync(userPath, "utf8")).toBe("user-owned visible content\n");
    expect(readFileSync(excludePath)).toEqual(before);
    expect(
      git(
        current.sourceRoot,
        "status",
        "--porcelain",
        "--untracked-files=all",
        "--",
        ".rennet/round-landings",
      ),
    ).toContain("user-owned.txt");
  });

  it("keeps an at-boundary manifest-parent swap inside the anchored port", async () => {
    const current = fixture();
    let attempt = await plan(current);
    const mover = exclusiveRenameMover();
    const guardedUnit = attempt.units.find((unit) => unit.path === "guarded/leaf.txt");
    if (guardedUnit === undefined) throw new Error("fixture did not produce guarded/leaf.txt");

    for (const unit of attempt.units) {
      if (unit.id === guardedUnit.id) break;
      const receipt = await landTransactionalRoundSourceUnit({
        sourceRoot: current.sourceRoot,
        worktreePath: current.worktreePath,
        attempt,
        unit,
        mover,
      });
      attempt = { ...attempt, unitReceipts: [...attempt.unitReceipts, receipt] };
    }

    const externalRoot = mkdtempSync(join(tmpdir(), "rennet-landing-external-"));
    roots.push(externalRoot);
    const externalLeaf = join(externalRoot, "leaf.txt");
    writeFileSync(externalLeaf, "guarded baseline\n");
    const capturedParent = join(current.sourceRoot, "captured-guarded-parent");
    const baseFileSystem = createTestOnlyHostLandingFileSystem({
      sourceRoot: current.sourceRoot,
      workerRoot: current.worktreePath,
      mover,
    });
    const seenPaths: string[] = [];
    const recordingFileSystem = recordRelativeFileSystemPaths(baseFileSystem, seenPaths);
    let swapped = false;
    const adversarialFileSystem: AnchoredRoundSourceLandingFileSystem = {
      ...recordingFileSystem,
      async move(paths) {
        assertTestOnlyLandingRelativePath(paths.sourcePath);
        assertTestOnlyLandingRelativePath(paths.destinationPath);
        seenPaths.push(paths.sourcePath, paths.destinationPath);
        if (!swapped && paths.sourcePath === guardedUnit.path) {
          swapped = true;
          renameSync(join(current.sourceRoot, "guarded"), capturedParent);
          symlinkSync(externalRoot, join(current.sourceRoot, "guarded"));
        }
        return baseFileSystem.move(paths);
      },
    };

    await expect(
      landTransactionalRoundSourceUnit({
        sourceRoot: current.sourceRoot,
        worktreePath: current.worktreePath,
        attempt,
        unit: guardedUnit,
        mover,
        fileSystem: adversarialFileSystem,
      }),
    ).rejects.toThrow();

    expect(swapped).toBe(true);
    expect(seenPaths.length).toBeGreaterThan(0);
    expect(
      seenPaths.every(
        (path) =>
          !isAbsolute(path) &&
          !path.includes("\\") &&
          path.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
      ),
    ).toBe(true);
    expect(readFileSync(externalLeaf, "utf8")).toBe("guarded baseline\n");
    expect(readFileSync(join(capturedParent, "leaf.txt"), "utf8")).toBe("guarded baseline\n");
  }, 30_000);

  it.each(["rennet-root", "artifact-root"] as const)(
    "never writes through a symlinked %s",
    async (symlinkCase) => {
      const current = fixture();
      const attempt = await plan(current);
      const unit = attempt.units[0];
      if (unit === undefined) throw new Error("fixture did not produce a landing unit");
      const externalRoot = mkdtempSync(join(tmpdir(), "rennet-landing-artifact-external-"));
      roots.push(externalRoot);
      writeFileSync(join(externalRoot, "sentinel.txt"), "external sentinel\n");
      const mover = exclusiveRenameMover();
      const fileSystem = createTestOnlyHostLandingFileSystem({
        sourceRoot: current.sourceRoot,
        workerRoot: current.worktreePath,
        mover,
      });
      await fileSystem.ensureInternalExclusion({
        artifactRoot: assertTestOnlyLandingRelativePath(".rennet/round-landings"),
      });
      if (symlinkCase === "rennet-root") {
        symlinkSync(externalRoot, join(current.sourceRoot, ".rennet"));
      } else {
        mkdirSync(join(current.sourceRoot, ".rennet"));
        symlinkSync(externalRoot, join(current.sourceRoot, ".rennet", "round-landings"));
      }

      await expect(
        landTransactionalRoundSourceUnit({
          sourceRoot: current.sourceRoot,
          worktreePath: current.worktreePath,
          attempt,
          unit,
          mover,
          fileSystem,
        }),
      ).rejects.toThrow();

      expect(readFileSync(join(externalRoot, "sentinel.txt"), "utf8")).toBe("external sentinel\n");
      expect(readdirSync(externalRoot)).toEqual(["sentinel.txt"]);
    },
  );

  it("preserves a dangling symlink that wins the destination during publish", async () => {
    const current = fixture();
    let attempt = await plan(current);
    const delegate = exclusiveRenameMover();
    for (const unit of attempt.units) {
      if (unit.path === "current-link") {
        const stage = join(realpathSync(current.sourceRoot), unit.stagePath);
        const destinationWinner: ExclusiveNamespaceMover = {
          async move(paths) {
            if (paths.sourcePath === stage)
              symlinkSync("concurrent-missing", paths.destinationPath);
            return delegate.move(paths);
          },
        };
        await expect(
          landTransactionalRoundSourceUnit({
            sourceRoot: current.sourceRoot,
            worktreePath: current.worktreePath,
            attempt,
            unit,
            mover: destinationWinner,
          }),
        ).rejects.toThrow(RoundSourceLandingConflictError);
        expect(readlinkSync(join(current.sourceRoot, unit.path))).toBe("concurrent-missing");
        return;
      }
      const receipt = await landTransactionalRoundSourceUnit({
        sourceRoot: current.sourceRoot,
        worktreePath: current.worktreePath,
        attempt,
        unit,
        mover: delegate,
      });
      attempt = { ...attempt, unitReceipts: [...attempt.unitReceipts, receipt] };
    }
    throw new Error("fixture did not produce current-link");
  });

  it("lets concurrent actors converge on one staged target and namespace result", async () => {
    const current = fixture();
    let attempt = await plan(current);
    const mover = exclusiveRenameMover();
    for (const unit of attempt.units) {
      if (unit.path === "current-link") {
        const receipts = await Promise.all([
          landTransactionalRoundSourceUnit({
            sourceRoot: current.sourceRoot,
            worktreePath: current.worktreePath,
            attempt,
            unit,
            mover,
          }),
          landTransactionalRoundSourceUnit({
            sourceRoot: current.sourceRoot,
            worktreePath: current.worktreePath,
            attempt,
            unit,
            mover,
          }),
        ]);
        expect(receipts.every((receipt) => receipt.unitId === unit.id)).toBe(true);
        expect(readlinkSync(join(current.sourceRoot, unit.path))).toBe("link-target-b");
        return;
      }
      const receipt = await landTransactionalRoundSourceUnit({
        sourceRoot: current.sourceRoot,
        worktreePath: current.worktreePath,
        attempt,
        unit,
        mover,
      });
      attempt = { ...attempt, unitReceipts: [...attempt.unitReceipts, receipt] };
    }
    throw new Error("fixture did not produce current-link");
  });

  it("resumes from a durable stage and preserves binary, symlink, and Git mode identity", async () => {
    const current = fixture();
    let attempt = await plan(current);
    const mover = exclusiveRenameMover();
    const receipts: RoundSourceLandingUnitReceipt[] = [];

    for (const unit of attempt.units) {
      if (unit.path === "replace.bin") {
        let crashed = false;
        const crashAfterBackup: ExclusiveNamespaceMover = {
          async move(paths) {
            const outcome = await mover.move(paths);
            if (
              !crashed &&
              paths.sourcePath === join(realpathSync(current.sourceRoot), unit.path)
            ) {
              crashed = true;
              throw new Error("simulated process death after baseline move");
            }
            return outcome;
          },
        };
        await expect(
          landTransactionalRoundSourceUnit({
            sourceRoot: current.sourceRoot,
            worktreePath: current.worktreePath,
            attempt,
            unit,
            mover: crashAfterBackup,
          }),
        ).rejects.toThrow("simulated process death");
        expect(existsSync(join(current.sourceRoot, unit.path))).toBe(false);
        unlinkSync(join(current.worktreePath, unit.path));
      }

      const receipt = await landTransactionalRoundSourceUnit({
        sourceRoot: current.sourceRoot,
        worktreePath: current.worktreePath,
        attempt,
        unit,
        mover,
        now: () => 20 + receipts.length,
      });
      receipts.push(receipt);
      attempt = { ...attempt, unitReceipts: [...receipts] };
    }

    expect(existsSync(join(current.sourceRoot, "delete.txt"))).toBe(false);
    expect(readFileSync(join(current.sourceRoot, "created.txt"), "utf8")).toBe("created\n");
    expect(readFileSync(join(current.sourceRoot, "replace.bin"))).toEqual(
      Buffer.from([255, 4, 0, 3, 2, 1]),
    );
    expect(readFileSync(join(current.sourceRoot, "filtered.txt"))).toEqual(
      Buffer.from("worker\r\n"),
    );
    expect(readlinkSync(join(current.sourceRoot, "current-link"))).toBe("link-target-b");
    expect(lstatSync(join(current.sourceRoot, "mode.sh")).mode & 0o111).not.toBe(0);
    expect(readFileSync(join(current.sourceRoot, "dir-to-file"), "utf8")).toBe("new file\n");
    expect(readFileSync(join(current.sourceRoot, "file-to-dir", "child.txt"), "utf8")).toBe(
      "new child\n",
    );
    expect(readFileSync(join(current.sourceRoot, "unrelated.txt"), "utf8")).toBe("user edit\n");

    const receipt = {
      ...attempt,
      outcome: "applied",
      landedAt: 30,
    } satisfies TransactionalRoundSourceLandingReceipt;
    const replaceUnit = receipt.units.find((unit) => unit.path === "replace.bin");
    if (replaceUnit === undefined) throw new Error("fixture did not produce replace.bin");
    expect(existsSync(join(current.sourceRoot, replaceUnit.backupPath))).toBe(true);
    await cleanupTransactionalRoundSourceLanding({
      fileSystem: createTestOnlyHostLandingFileSystem({
        sourceRoot: current.sourceRoot,
        workerRoot: current.worktreePath,
        mover,
      }),
      receipt,
    });
    expect(existsSync(join(current.sourceRoot, ".rennet", "round-landings"))).toBe(true);
    expect(existsSync(join(current.sourceRoot, replaceUnit.backupPath))).toBe(false);
  }, 30_000);
});
