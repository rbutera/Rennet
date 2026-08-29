import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type {
  RoundSourceLandingUnitReceipt,
  TransactionalRoundSourceLandingAttempt,
  TransactionalRoundSourceLandingReceipt,
} from "@rennet/protocol";
import { afterEach, describe, expect, it } from "vitest";
import type { ExclusiveNamespaceMover } from "./exclusive-namespace-move";
import { execaGit } from "./git-range-diff";
import {
  cleanupTransactionalRoundSourceLanding,
  planTransactionalRoundSourceLanding,
  RoundSourceLandingConflictError,
  landTransactionalRoundSourceUnit as runTransactionalRoundSourceUnit,
} from "./round-source-landing";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
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
  writeFileSync(join(sourceRoot, ".gitattributes"), "filtered.txt text eol=crlf\n");
  writeFileSync(join(sourceRoot, "delete.txt"), "delete me\n");
  writeFileSync(join(sourceRoot, "filtered.txt"), "baseline\r\n");
  writeFileSync(join(sourceRoot, "replace.bin"), Buffer.from([0, 1, 2, 255]));
  writeFileSync(join(sourceRoot, "mode.sh"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(sourceRoot, "mode.sh"), 0o644);
  writeFileSync(join(sourceRoot, "link-target-a"), "a\n");
  writeFileSync(join(sourceRoot, "link-target-b"), "b\n");
  symlinkSync("link-target-a", join(sourceRoot, "current-link"));
  writeFileSync(join(sourceRoot, "unrelated.txt"), "baseline\n");
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

async function plan(
  current: ReturnType<typeof fixture>,
): Promise<TransactionalRoundSourceLandingAttempt> {
  return planTransactionalRoundSourceLanding({
    git: execaGit,
    worktreePath: current.worktreePath,
    executionId: "transaction-1",
    baselineCommit: current.baselineCommit,
    workerHead: current.workerHead,
    startedAt: 10,
  });
}

function landTransactionalRoundSourceUnit(
  input: Omit<Parameters<typeof runTransactionalRoundSourceUnit>[0], "git">,
) {
  return runTransactionalRoundSourceUnit({ ...input, git: execaGit });
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
      "mode.sh",
      "replace.bin",
      "created.txt",
      "dir-to-file",
      "file-to-dir/child.txt",
    ]);
    expect(first.units.every((unit) => unit.stagePath.includes(unit.id))).toBe(true);
    expect(first.units.every((unit) => unit.backupPath.includes(unit.id))).toBe(true);
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

  it("preflights every transaction artifact before mutating the first unit", async () => {
    const current = fixture();
    const attempt = await plan(current);
    const firstUnit = attempt.units[0];
    const laterUnit = attempt.units.at(-1);
    if (firstUnit === undefined || laterUnit === undefined) {
      throw new Error("fixture did not produce landing units");
    }
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
      }),
    ).rejects.toThrow("transaction stage is");
    expect(readFileSync(join(current.sourceRoot, firstUnit.path), "utf8")).toBe("old child\n");
    expect(pathOccupied(join(current.sourceRoot, firstUnit.backupPath))).toBe(false);
  });

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

  it("preserves a dangling symlink that wins the destination during publish", async () => {
    const current = fixture();
    let attempt = await plan(current);
    const delegate = exclusiveRenameMover();
    for (const unit of attempt.units) {
      if (unit.path === "current-link") {
        const stage = join(current.sourceRoot, unit.stagePath);
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

  it("resumes a replace after the baseline move and preserves every Git entry shape", async () => {
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
            if (!crashed && paths.sourcePath === join(current.sourceRoot, unit.path)) {
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
    await cleanupTransactionalRoundSourceLanding({ sourceRoot: current.sourceRoot, receipt });
    expect(existsSync(join(current.sourceRoot, ".rennet", "round-landings"))).toBe(true);
    expect(existsSync(join(current.sourceRoot, replaceUnit.backupPath))).toBe(false);
  });
});
