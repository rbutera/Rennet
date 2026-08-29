import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readdir,
  readlink,
  rm,
  rmdir,
  symlink,
} from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import {
  type RoundSourceLandingPathDescriptor,
  type RoundSourceLandingUnit,
  type RoundSourceLandingUnitReceipt,
  roundSourceLandingArtifactPaths,
  sha256Hex,
  type TransactionalRoundSourceLandingAttempt,
  TransactionalRoundSourceLandingAttemptSchema,
  type TransactionalRoundSourceLandingReceipt,
} from "@rennet/protocol";
import type { ExclusiveNamespaceMover } from "./exclusive-namespace-move";
import type { GitExec } from "./git-range-diff";

const TRANSACTION_ROOT = ".rennet/round-landings";

type ObservedPathDescriptor =
  | RoundSourceLandingPathDescriptor
  | { readonly kind: "directory" }
  | { readonly kind: "unsupported"; readonly detail: string };

type RawChangedPath = {
  readonly path: string;
  readonly baseline: RoundSourceLandingPathDescriptor;
  readonly target: RoundSourceLandingPathDescriptor;
};

export class RoundSourceLandingConflictError extends Error {
  constructor(path: string, detail: string) {
    super(`round source landing conflicts at ${path}: ${detail}`);
    this.name = "RoundSourceLandingConflictError";
  }
}

function descriptorFromRaw(mode: string, oid: string): RoundSourceLandingPathDescriptor {
  if (mode === "000000") return { kind: "absent" };
  if (mode !== "100644" && mode !== "100755" && mode !== "120000") {
    throw new Error(`Git returned unsupported mode ${mode}`);
  }
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(oid)) {
    throw new Error(`Git returned invalid object id ${oid}`);
  }
  return { kind: "git", mode, oid };
}

function parseRawChanges(output: string): RawChangedPath[] {
  if (output.length === 0) return [];
  const fields = output.split("\0");
  const changes: RawChangedPath[] = [];
  for (let index = 0; index < fields.length - 1; index += 2) {
    const header = fields[index];
    const path = fields[index + 1];
    if (header === undefined || path === undefined || header.length === 0 || path.length === 0) {
      throw new Error("Git returned a malformed raw source-landing manifest");
    }
    const match = /^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([A-Z][0-9]*)$/.exec(header);
    if (match === null) {
      throw new Error(
        `Git returned malformed raw source-landing metadata ${JSON.stringify(header)}`,
      );
    }
    const [, baselineMode, targetMode, baselineOid, targetOid, status] = match;
    if (
      baselineMode === undefined ||
      targetMode === undefined ||
      baselineOid === undefined ||
      targetOid === undefined ||
      status === undefined
    ) {
      throw new Error("Git omitted source-landing metadata fields");
    }
    if (status.startsWith("R") || status.startsWith("C")) {
      throw new Error("Git detected a rename or copy despite --no-renames");
    }
    changes.push({
      path,
      baseline: descriptorFromRaw(baselineMode, baselineOid),
      target: descriptorFromRaw(targetMode, targetOid),
    });
  }
  if (fields.at(-1) !== "") {
    throw new Error("Git raw source-landing manifest is not NUL-terminated");
  }
  return changes;
}

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function pathDepth(path: string): number {
  return path.split("/").length;
}

function changeRank(change: RawChangedPath): number {
  if (change.target.kind === "absent") return 0;
  if (change.baseline.kind === "absent") return 2;
  return 1;
}

function orderChanges(changes: readonly RawChangedPath[]): RawChangedPath[] {
  return [...changes].sort((left, right) => {
    const rank = changeRank(left) - changeRank(right);
    if (rank !== 0) return rank;
    if (left.target.kind === "absent") {
      const depth = pathDepth(right.path) - pathDepth(left.path);
      if (depth !== 0) return depth;
    }
    if (left.baseline.kind === "absent") {
      const depth = pathDepth(left.path) - pathDepth(right.path);
      if (depth !== 0) return depth;
    }
    return comparePaths(left.path, right.path);
  });
}

function descriptorIdentity(descriptor: RoundSourceLandingPathDescriptor): string {
  return descriptor.kind === "absent" ? "absent" : `${descriptor.mode}:${descriptor.oid}`;
}

function unitIdFor(change: RawChangedPath, ordinal: number): string {
  return sha256Hex(
    `${ordinal}\0${change.path}\0${descriptorIdentity(change.baseline)}\0${descriptorIdentity(change.target)}`,
  );
}

function transactionKey(executionId: string): string {
  return sha256Hex(executionId).slice(0, 24);
}

async function resolveCommit(git: GitExec, worktreePath: string, ref: string): Promise<string> {
  return (await git(worktreePath, ["rev-parse", "--verify", `${ref}^{commit}`])).trim();
}

export async function planTransactionalRoundSourceLanding(input: {
  readonly git: GitExec;
  readonly worktreePath: string;
  readonly executionId: string;
  readonly baselineCommit: string;
  readonly workerHead: string;
  readonly startedAt: number;
}): Promise<TransactionalRoundSourceLandingAttempt> {
  const baselineCommit = await resolveCommit(input.git, input.worktreePath, input.baselineCommit);
  const workerHead = await resolveCommit(input.git, input.worktreePath, input.workerHead);
  const mergeBase = (
    await input.git(input.worktreePath, ["merge-base", baselineCommit, workerHead])
  ).trim();
  if (mergeBase !== baselineCommit) {
    throw new Error(`round baseline ${baselineCommit} is not an ancestor of ${workerHead}`);
  }
  const changes = orderChanges(
    parseRawChanges(
      await input.git(input.worktreePath, [
        "diff",
        "--raw",
        "-z",
        "--no-renames",
        "--full-index",
        "--abbrev=64",
        `${baselineCommit}..${workerHead}`,
      ]),
    ),
  );
  const units = changes.map((change, ordinal): RoundSourceLandingUnit => {
    if (change.path === ".rennet" || change.path.startsWith(".rennet/")) {
      throw new RoundSourceLandingConflictError(
        change.path,
        "the changed path overlaps Rennet's local transaction namespace",
      );
    }
    const id = unitIdFor(change, ordinal);
    return { id, ...change, ...roundSourceLandingArtifactPaths(input.executionId, id) };
  });
  return TransactionalRoundSourceLandingAttemptSchema.parse({
    effect: "source-landing",
    strategy: "exclusive-move-v1",
    executionId: input.executionId,
    baselineCommit,
    workerHead,
    startedAt: input.startedAt,
    units,
    unitReceipts: [],
  });
}

function absoluteRepoPath(repoRoot: string, repoPath: string): string {
  const root = resolve(repoRoot);
  const absolute = resolve(root, ...repoPath.split("/"));
  if (absolute !== root && !absolute.startsWith(`${root}${sep}`)) {
    throw new Error(`repository-relative path escaped its root: ${repoPath}`);
  }
  return absolute;
}

function errorCode(error: unknown): string | undefined {
  if (!(error instanceof Error) || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function oidLengthFor(unit: RoundSourceLandingUnit): 40 | 64 {
  const descriptor = unit.target.kind === "git" ? unit.target : unit.baseline;
  if (descriptor.kind !== "git") {
    throw new RoundSourceLandingConflictError(unit.path, "unit has no Git object endpoint");
  }
  return descriptor.oid.length === 64 ? 64 : 40;
}

function gitBlobOid(bytes: Uint8Array, oidLength: 40 | 64): string {
  const hash = createHash(oidLength === 64 ? "sha256" : "sha1");
  hash.update(`blob ${bytes.byteLength}\0`);
  hash.update(bytes);
  return hash.digest("hex");
}

async function inspectPath(input: {
  readonly git: GitExec;
  readonly gitRoot: string;
  readonly absolutePath: string;
  readonly repoPath: string;
  readonly attrSource: string;
  readonly oidLength: 40 | 64;
}): Promise<ObservedPathDescriptor> {
  let stats: Awaited<ReturnType<typeof lstat>>;
  try {
    stats = await lstat(input.absolutePath);
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") return { kind: "absent" };
    throw error;
  }
  if (stats.isSymbolicLink()) {
    const target = await readlink(input.absolutePath, { encoding: "buffer" });
    return { kind: "git", mode: "120000", oid: gitBlobOid(target, input.oidLength) };
  }
  if (stats.isFile()) {
    const diskPath = relative(resolve(input.gitRoot), resolve(input.absolutePath));
    if (
      diskPath.length === 0 ||
      diskPath === ".." ||
      diskPath.startsWith(`..${sep}`) ||
      isAbsolute(diskPath)
    ) {
      throw new Error(`landing inspection escaped its Git root: ${input.absolutePath}`);
    }
    const oid = (
      await input.git(input.gitRoot, [
        "-c",
        `attr.tree=${input.attrSource}`,
        "hash-object",
        `--path=${input.repoPath}`,
        "--",
        diskPath.split(sep).join("/"),
      ])
    ).trim();
    if (!new RegExp(`^[0-9a-f]{${input.oidLength}}$`).test(oid)) {
      throw new Error(`Git returned invalid landing object id ${oid}`);
    }
    return {
      kind: "git",
      mode: (stats.mode & 0o111) === 0 ? "100644" : "100755",
      oid,
    };
  }
  if (stats.isDirectory()) return { kind: "directory" };
  return { kind: "unsupported", detail: "path is not a regular file, symlink, or directory" };
}

async function inspectUnitPath(input: {
  readonly git: GitExec;
  readonly gitRoot: string;
  readonly absolutePath: string;
  readonly attempt: TransactionalRoundSourceLandingAttempt;
  readonly unit: RoundSourceLandingUnit;
  readonly endpoint: "baseline" | "target";
}): Promise<ObservedPathDescriptor> {
  return inspectPath({
    git: input.git,
    gitRoot: input.gitRoot,
    absolutePath: input.absolutePath,
    repoPath: input.unit.path,
    attrSource:
      input.endpoint === "baseline" ? input.attempt.baselineCommit : input.attempt.workerHead,
    oidLength: oidLengthFor(input.unit),
  });
}

function sameDescriptor(
  observed: ObservedPathDescriptor,
  expected: RoundSourceLandingPathDescriptor,
): boolean {
  if (observed.kind !== expected.kind) return false;
  if (observed.kind === "absent" || expected.kind === "absent") return true;
  if (observed.kind !== "git" || expected.kind !== "git") return false;
  return observed.mode === expected.mode && observed.oid === expected.oid;
}

function sameObserved(left: ObservedPathDescriptor, right: ObservedPathDescriptor): boolean {
  if (left.kind !== right.kind) return false;
  switch (left.kind) {
    case "absent":
    case "directory":
      return true;
    case "git":
      return right.kind === "git" && left.mode === right.mode && left.oid === right.oid;
    case "unsupported":
      return right.kind === "unsupported" && left.detail === right.detail;
    default: {
      const _exhaustive: never = left;
      return _exhaustive;
    }
  }
}

function describeObserved(descriptor: ObservedPathDescriptor): string {
  switch (descriptor.kind) {
    case "absent":
      return "absent";
    case "git":
      return `${descriptor.mode}:${descriptor.oid}`;
    case "directory":
      return "directory";
    case "unsupported":
      return descriptor.detail;
    default: {
      const _exhaustive: never = descriptor;
      return _exhaustive;
    }
  }
}

async function manifestLeafPaths(root: string, repoPath: string): Promise<string[]> {
  const absolute = absoluteRepoPath(root, repoPath);
  const entries = await readdir(absolute, { withFileTypes: true });
  const leaves: string[] = [];
  for (const entry of entries) {
    const childPath = `${repoPath}/${entry.name}`;
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      leaves.push(...(await manifestLeafPaths(root, childPath)));
    } else {
      leaves.push(childPath);
    }
  }
  return leaves;
}

async function directoryIsManifestStructure(
  git: GitExec,
  repoRoot: string,
  repoPath: string,
  attempt: TransactionalRoundSourceLandingAttempt,
): Promise<boolean> {
  const descendants = attempt.units.filter((unit) => unit.path.startsWith(`${repoPath}/`));
  if (descendants.length === 0) return false;
  const unitsByPath = new Map(descendants.map((unit) => [unit.path, unit]));
  const leaves = await manifestLeafPaths(repoRoot, repoPath);
  for (const leaf of leaves) {
    const unit = unitsByPath.get(leaf);
    if (unit === undefined) return false;
    const absolutePath = absoluteRepoPath(repoRoot, leaf);
    const observedBaseline = await inspectUnitPath({
      git,
      gitRoot: repoRoot,
      absolutePath,
      attempt,
      unit,
      endpoint: "baseline",
    });
    const observedTarget =
      observedBaseline.kind === "git"
        ? await inspectUnitPath({
            git,
            gitRoot: repoRoot,
            absolutePath,
            attempt,
            unit,
            endpoint: "target",
          })
        : observedBaseline;
    if (
      !sameDescriptor(observedBaseline, unit.baseline) &&
      !sameDescriptor(observedTarget, unit.target)
    ) {
      return false;
    }
  }
  return true;
}

async function matchesEndpoint(input: {
  readonly git: GitExec;
  readonly repoRoot: string;
  readonly path: string;
  readonly observed: ObservedPathDescriptor;
  readonly expected: RoundSourceLandingPathDescriptor;
  readonly attempt: TransactionalRoundSourceLandingAttempt;
}): Promise<boolean> {
  if (sameDescriptor(input.observed, input.expected)) return true;
  return (
    input.expected.kind === "absent" &&
    input.observed.kind === "directory" &&
    (await directoryIsManifestStructure(input.git, input.repoRoot, input.path, input.attempt))
  );
}

function assertArtifactPaths(
  attempt: TransactionalRoundSourceLandingAttempt,
  unit: RoundSourceLandingUnit,
): void {
  const expected = roundSourceLandingArtifactPaths(attempt.executionId, unit.id);
  if (unit.stagePath !== expected.stagePath || unit.backupPath !== expected.backupPath) {
    throw new RoundSourceLandingConflictError(unit.path, "transaction artifact paths changed");
  }
}

async function preflightAll(
  git: GitExec,
  repoRoot: string,
  attempt: TransactionalRoundSourceLandingAttempt,
): Promise<void> {
  for (const [index, unit] of attempt.units.entries()) {
    assertArtifactPaths(attempt, unit);
    const absolutePath = absoluteRepoPath(repoRoot, unit.path);
    const observedBaseline = await inspectUnitPath({
      git,
      gitRoot: repoRoot,
      absolutePath,
      attempt,
      unit,
      endpoint: "baseline",
    });
    const observedTarget =
      observedBaseline.kind === "git"
        ? await inspectUnitPath({
            git,
            gitRoot: repoRoot,
            absolutePath,
            attempt,
            unit,
            endpoint: "target",
          })
        : observedBaseline;
    const matchesBaseline = await matchesEndpoint({
      git,
      repoRoot,
      path: unit.path,
      observed: observedBaseline,
      expected: unit.baseline,
      attempt,
    });
    const matchesTarget = await matchesEndpoint({
      git,
      repoRoot,
      path: unit.path,
      observed: observedTarget,
      expected: unit.target,
      attempt,
    });
    const backup = await inspectUnitPath({
      git,
      gitRoot: repoRoot,
      absolutePath: absoluteRepoPath(repoRoot, unit.backupPath),
      attempt,
      unit,
      endpoint: "baseline",
    });
    const stage = await inspectUnitPath({
      git,
      gitRoot: repoRoot,
      absolutePath: absoluteRepoPath(repoRoot, unit.stagePath),
      attempt,
      unit,
      endpoint: "target",
    });
    const backupMatchesBaseline =
      unit.baseline.kind === "git" && sameDescriptor(backup, unit.baseline);
    const stageMatchesTarget = unit.target.kind === "git" && sameDescriptor(stage, unit.target);
    if (backup.kind !== "absent" && !backupMatchesBaseline) {
      throw new RoundSourceLandingConflictError(
        unit.path,
        `transaction backup is ${describeObserved(backup)}`,
      );
    }
    if (stage.kind !== "absent" && !stageMatchesTarget) {
      throw new RoundSourceLandingConflictError(
        unit.path,
        `transaction stage is ${describeObserved(stage)}`,
      );
    }
    const recoverablePublish =
      observedBaseline.kind === "absent" &&
      unit.baseline.kind === "git" &&
      backupMatchesBaseline &&
      unit.target.kind === "git" &&
      stageMatchesTarget;
    if (!matchesBaseline && !matchesTarget && !recoverablePublish) {
      throw new RoundSourceLandingConflictError(
        unit.path,
        `expected baseline or target, found ${describeObserved(observedBaseline)}`,
      );
    }
    if (index < attempt.unitReceipts.length && !matchesTarget) {
      throw new RoundSourceLandingConflictError(
        unit.path,
        "a durably landed unit no longer matches its target",
      );
    }
  }
}

async function materializeStage(input: {
  readonly git: GitExec;
  readonly sourceRoot: string;
  readonly worktreePath: string;
  readonly attempt: TransactionalRoundSourceLandingAttempt;
  readonly unit: RoundSourceLandingUnit;
  readonly mover: ExclusiveNamespaceMover;
}): Promise<void> {
  if (input.unit.target.kind === "absent") return;
  const stage = absoluteRepoPath(input.sourceRoot, input.unit.stagePath);
  const observedStage = await inspectUnitPath({
    git: input.git,
    gitRoot: input.sourceRoot,
    absolutePath: stage,
    attempt: input.attempt,
    unit: input.unit,
    endpoint: "target",
  });
  if (sameDescriptor(observedStage, input.unit.target)) return;
  if (observedStage.kind !== "absent") {
    throw new RoundSourceLandingConflictError(
      input.unit.path,
      `staged target is ${describeObserved(observedStage)}`,
    );
  }
  const workerSource = absoluteRepoPath(input.worktreePath, input.unit.path);
  const observedWorkerSource = await inspectUnitPath({
    git: input.git,
    gitRoot: input.worktreePath,
    absolutePath: workerSource,
    attempt: input.attempt,
    unit: input.unit,
    endpoint: "target",
  });
  if (!sameDescriptor(observedWorkerSource, input.unit.target)) {
    throw new RoundSourceLandingConflictError(
      input.unit.path,
      `worker target is ${describeObserved(observedWorkerSource)}`,
    );
  }
  await mkdir(dirname(stage), { recursive: true });
  const preparation = `${stage}.prepare-${randomUUID()}`;
  if (input.unit.target.mode === "120000") {
    await symlink(await readlink(workerSource, { encoding: "buffer" }), preparation);
  } else {
    await copyFile(workerSource, preparation);
    await chmod(preparation, input.unit.target.mode === "100755" ? 0o755 : 0o644);
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const outcome = await input.mover.move({
      sourcePath: preparation,
      destinationPath: stage,
    });
    const [materialized, pending] = await Promise.all([
      inspectUnitPath({
        git: input.git,
        gitRoot: input.sourceRoot,
        absolutePath: stage,
        attempt: input.attempt,
        unit: input.unit,
        endpoint: "target",
      }),
      inspectUnitPath({
        git: input.git,
        gitRoot: input.sourceRoot,
        absolutePath: preparation,
        attempt: input.attempt,
        unit: input.unit,
        endpoint: "target",
      }),
    ]);
    if (sameDescriptor(materialized, input.unit.target)) {
      await rm(preparation, { force: true });
      return;
    }
    if (
      outcome.kind === "outcome-unknown" &&
      materialized.kind === "absent" &&
      sameDescriptor(pending, input.unit.target) &&
      attempt === 0
    ) {
      continue;
    }
    await rm(preparation, { force: true });
    throw new RoundSourceLandingConflictError(
      input.unit.path,
      `materialized stage is ${describeObserved(materialized)} after ${outcome.kind}`,
    );
  }
}

async function removeEmptyParents(path: string, root: string): Promise<void> {
  const resolvedRoot = resolve(root);
  let current = dirname(path);
  while (current !== resolvedRoot && current.startsWith(`${resolvedRoot}${sep}`)) {
    try {
      await rmdir(current);
    } catch (error) {
      const code = errorCode(error);
      if (code === "ENOENT") {
        current = dirname(current);
        continue;
      }
      if (code === "ENOTEMPTY" || code === "EEXIST") return;
      throw error;
    }
    current = dirname(current);
  }
}

async function ensureNamespaceAbsent(path: string, repoPath: string): Promise<void> {
  let stats: Awaited<ReturnType<typeof lstat>>;
  try {
    stats = await lstat(path);
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") return;
    throw error;
  }
  if (!stats.isDirectory()) {
    throw new RoundSourceLandingConflictError(repoPath, "target namespace is occupied");
  }
  try {
    await rmdir(path);
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOTEMPTY" || code === "EEXIST") {
      throw new RoundSourceLandingConflictError(repoPath, "target directory is not empty");
    }
    throw error;
  }
}

async function moveAndReconcile(input: {
  readonly mover: ExclusiveNamespaceMover;
  readonly repoPath: string;
  readonly sourcePath: string;
  readonly destinationPath: string;
  readonly descriptor: RoundSourceLandingPathDescriptor;
  readonly inspect: (path: string) => Promise<ObservedPathDescriptor>;
  readonly restoreUnexpectedDestination?: boolean;
}): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const outcome = await input.mover.move({
      sourcePath: input.sourcePath,
      destinationPath: input.destinationPath,
    });
    const [source, destination] = await Promise.all([
      input.inspect(input.sourcePath),
      input.inspect(input.destinationPath),
    ]);
    if (source.kind === "absent" && sameDescriptor(destination, input.descriptor)) return;
    if (
      source.kind === "absent" &&
      destination.kind !== "absent" &&
      input.restoreUnexpectedDestination === true &&
      (outcome.kind === "moved" || outcome.kind === "outcome-unknown")
    ) {
      const restoreOutcome = await input.mover.move({
        sourcePath: input.destinationPath,
        destinationPath: input.sourcePath,
      });
      const [restoredSource, clearedDestination] = await Promise.all([
        input.inspect(input.sourcePath),
        input.inspect(input.destinationPath),
      ]);
      if (sameObserved(restoredSource, destination) && clearedDestination.kind === "absent") {
        throw new RoundSourceLandingConflictError(
          input.repoPath,
          "source changed after preflight; restored the concurrent bytes to the live path",
        );
      }
      throw new RoundSourceLandingConflictError(
        input.repoPath,
        `source changed after preflight and rollback returned ${restoreOutcome.kind}; live path is ${describeObserved(restoredSource)}`,
      );
    }
    const unchanged = sameDescriptor(source, input.descriptor) && destination.kind === "absent";
    if (outcome.kind === "outcome-unknown" && unchanged && attempt === 0) continue;
    const detail =
      outcome.kind === "helper-unavailable" || outcome.kind === "outcome-unknown"
        ? outcome.detail
        : outcome.kind === "moved"
          ? "helper reported a move but namespace state disagrees"
          : `helper returned ${outcome.kind} (${outcome.nativeCode})`;
    throw new RoundSourceLandingConflictError(input.repoPath, detail);
  }
}

async function compatibleArtifact(input: {
  readonly path: string;
  readonly expected: RoundSourceLandingPathDescriptor;
  readonly unitPath: string;
  readonly inspect: (path: string) => Promise<ObservedPathDescriptor>;
}): Promise<boolean> {
  const observed = await input.inspect(input.path);
  if (observed.kind === "absent") return false;
  if (!sameDescriptor(observed, input.expected)) {
    throw new RoundSourceLandingConflictError(
      input.unitPath,
      `transaction artifact is ${describeObserved(observed)}`,
    );
  }
  return true;
}

async function restoreStrandedConcurrentEdit(input: {
  readonly git: GitExec;
  readonly sourceRoot: string;
  readonly attempt: TransactionalRoundSourceLandingAttempt;
  readonly unit: RoundSourceLandingUnit;
  readonly mover: ExclusiveNamespaceMover;
}): Promise<void> {
  if (input.unit.baseline.kind === "absent") return;
  const destination = absoluteRepoPath(input.sourceRoot, input.unit.path);
  const backup = absoluteRepoPath(input.sourceRoot, input.unit.backupPath);
  const inspectBaseline = (absolutePath: string) =>
    inspectUnitPath({
      git: input.git,
      gitRoot: input.sourceRoot,
      absolutePath,
      attempt: input.attempt,
      unit: input.unit,
      endpoint: "baseline",
    });
  const [observedDestination, observedBackup] = await Promise.all([
    inspectBaseline(destination),
    inspectBaseline(backup),
  ]);
  if (
    observedDestination.kind !== "absent" ||
    observedBackup.kind === "absent" ||
    sameDescriptor(observedBackup, input.unit.baseline)
  ) {
    return;
  }
  const outcome = await input.mover.move({ sourcePath: backup, destinationPath: destination });
  const [restoredDestination, clearedBackup] = await Promise.all([
    inspectBaseline(destination),
    inspectBaseline(backup),
  ]);
  if (sameObserved(restoredDestination, observedBackup) && clearedBackup.kind === "absent") {
    throw new RoundSourceLandingConflictError(
      input.unit.path,
      "restored a concurrent edit stranded by an interrupted baseline move",
    );
  }
  throw new RoundSourceLandingConflictError(
    input.unit.path,
    `could not restore a stranded concurrent edit after ${outcome.kind}; live path is ${describeObserved(restoredDestination)}`,
  );
}

export async function landTransactionalRoundSourceUnit(input: {
  readonly git: GitExec;
  readonly sourceRoot: string;
  readonly worktreePath: string;
  readonly attempt: TransactionalRoundSourceLandingAttempt;
  readonly unit: RoundSourceLandingUnit;
  readonly mover: ExclusiveNamespaceMover;
  readonly now?: () => number;
}): Promise<RoundSourceLandingUnitReceipt> {
  const nextUnit = input.attempt.units[input.attempt.unitReceipts.length];
  if (nextUnit?.id !== input.unit.id) {
    throw new RoundSourceLandingConflictError(
      input.unit.path,
      "unit is not the next manifest item",
    );
  }
  await restoreStrandedConcurrentEdit(input);
  await preflightAll(input.git, input.sourceRoot, input.attempt);
  const destination = absoluteRepoPath(input.sourceRoot, input.unit.path);
  const stage = absoluteRepoPath(input.sourceRoot, input.unit.stagePath);
  const backup = absoluteRepoPath(input.sourceRoot, input.unit.backupPath);
  const inspectBaseline = (absolutePath: string) =>
    inspectUnitPath({
      git: input.git,
      gitRoot: input.sourceRoot,
      absolutePath,
      attempt: input.attempt,
      unit: input.unit,
      endpoint: "baseline",
    });
  const inspectTarget = (absolutePath: string) =>
    inspectUnitPath({
      git: input.git,
      gitRoot: input.sourceRoot,
      absolutePath,
      attempt: input.attempt,
      unit: input.unit,
      endpoint: "target",
    });
  let observedDestination = await inspectBaseline(destination);
  const observedTarget =
    observedDestination.kind === "git" ? await inspectTarget(destination) : observedDestination;
  const destinationIsTarget = await matchesEndpoint({
    git: input.git,
    repoRoot: input.sourceRoot,
    path: input.unit.path,
    observed: observedTarget,
    expected: input.unit.target,
    attempt: input.attempt,
  });
  if (destinationIsTarget) {
    if (input.unit.baseline.kind !== "absent") {
      await compatibleArtifact({
        path: backup,
        expected: input.unit.baseline,
        unitPath: input.unit.path,
        inspect: inspectBaseline,
      });
    } else {
      const observedBackup = await inspectBaseline(backup);
      if (observedBackup.kind !== "absent") {
        throw new RoundSourceLandingConflictError(
          input.unit.path,
          `unexpected create backup is ${describeObserved(observedBackup)}`,
        );
      }
    }
    const observedStage = await inspectTarget(stage);
    if (observedStage.kind !== "absent" && !sameDescriptor(observedStage, input.unit.target)) {
      throw new RoundSourceLandingConflictError(
        input.unit.path,
        `staged target is ${describeObserved(observedStage)}`,
      );
    }
    return {
      unitId: input.unit.id,
      outcome: "already-applied",
      landedAt: (input.now ?? Date.now)(),
    };
  }

  const destinationIsBaseline = await matchesEndpoint({
    git: input.git,
    repoRoot: input.sourceRoot,
    path: input.unit.path,
    observed: observedDestination,
    expected: input.unit.baseline,
    attempt: input.attempt,
  });
  let backupExists = false;
  if (input.unit.baseline.kind === "absent") {
    const observedBackup = await inspectBaseline(backup);
    if (observedBackup.kind !== "absent") {
      throw new RoundSourceLandingConflictError(
        input.unit.path,
        `unexpected create backup is ${describeObserved(observedBackup)}`,
      );
    }
  } else {
    backupExists = await compatibleArtifact({
      path: backup,
      expected: input.unit.baseline,
      unitPath: input.unit.path,
      inspect: inspectBaseline,
    });
  }

  await materializeStage({
    git: input.git,
    sourceRoot: input.sourceRoot,
    worktreePath: input.worktreePath,
    attempt: input.attempt,
    unit: input.unit,
    mover: input.mover,
  });

  if (destinationIsBaseline && input.unit.baseline.kind !== "absent") {
    if (backupExists) {
      throw new RoundSourceLandingConflictError(
        input.unit.path,
        "baseline exists at both destination and backup",
      );
    }
    await mkdir(dirname(backup), { recursive: true });
    await moveAndReconcile({
      mover: input.mover,
      repoPath: input.unit.path,
      sourcePath: destination,
      destinationPath: backup,
      descriptor: input.unit.baseline,
      inspect: inspectBaseline,
      restoreUnexpectedDestination: true,
    });
    await removeEmptyParents(destination, input.sourceRoot);
    observedDestination = await inspectBaseline(destination);
  } else if (!destinationIsBaseline) {
    const recoverablePublish =
      observedDestination.kind === "absent" &&
      input.unit.baseline.kind !== "absent" &&
      backupExists;
    if (!recoverablePublish) {
      throw new RoundSourceLandingConflictError(
        input.unit.path,
        `expected resumable baseline, found ${describeObserved(observedDestination)}`,
      );
    }
  }

  if (input.unit.target.kind !== "absent") {
    if (observedDestination.kind === "directory") {
      await ensureNamespaceAbsent(destination, input.unit.path);
    }
    await mkdir(dirname(destination), { recursive: true });
    await moveAndReconcile({
      mover: input.mover,
      repoPath: input.unit.path,
      sourcePath: stage,
      destinationPath: destination,
      descriptor: input.unit.target,
      inspect: inspectTarget,
    });
  }
  const landed = await inspectTarget(destination);
  if (!sameDescriptor(landed, input.unit.target)) {
    throw new RoundSourceLandingConflictError(
      input.unit.path,
      `target reconciliation ended at ${describeObserved(landed)}`,
    );
  }
  return { unitId: input.unit.id, outcome: "applied", landedAt: (input.now ?? Date.now)() };
}

export async function cleanupTransactionalRoundSourceLanding(input: {
  readonly sourceRoot: string;
  readonly receipt: TransactionalRoundSourceLandingReceipt;
}): Promise<void> {
  for (const unit of input.receipt.units) assertArtifactPaths(input.receipt, unit);
  await rm(
    absoluteRepoPath(
      input.sourceRoot,
      `${TRANSACTION_ROOT}/${transactionKey(input.receipt.executionId)}`,
    ),
    { recursive: true, force: true },
  );
}
