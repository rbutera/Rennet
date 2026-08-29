import { randomUUID } from "node:crypto";
import {
  type RoundSourceLandingPathDescriptor,
  type RoundSourceLandingUnit,
  type RoundSourceLandingUnitReceipt,
  roundSourceLandingArtifactPaths,
  roundSourceLandingPreparationPath,
  roundSourceLandingTransactionPath,
  sha256Hex,
  type TransactionalRoundSourceLandingAttempt,
  TransactionalRoundSourceLandingAttemptSchema,
  type TransactionalRoundSourceLandingReceipt,
} from "@rennet/protocol";
import type { ExclusiveNamespaceMoveOutcome } from "./exclusive-namespace-move";

const TRANSACTION_ROOT = ".rennet/round-landings";
const TRANSACTION_EXCLUDE_RULE = `/${TRANSACTION_ROOT}/`;

type GitTreePathDescriptor =
  | { readonly kind: "absent" }
  | {
      readonly kind: "git";
      readonly mode: "100644" | "100755" | "120000";
      readonly oid: string;
    };

export type RoundSourceLandingObservedPathDescriptor =
  | RoundSourceLandingPathDescriptor
  | { readonly kind: "directory" }
  | { readonly kind: "unsupported"; readonly detail: string };

declare const roundSourceLandingRelativePath: unique symbol;

export type RoundSourceLandingRelativePath = string & {
  readonly [roundSourceLandingRelativePath]: true;
};

/**
 * A root-handle capability, not a string-path filesystem facade.
 *
 * Implementations must capture the source and worker root directory handles exactly once. Every
 * component of every branded path must be resolved beneath the selected captured handle without
 * traversing a symlink or reparse point, and every inspection or mutation must be performed
 * handle-relative at the syscall that observes or changes the namespace. A lexical containment
 * check or an lstat followed by an absolute-path syscall does not satisfy this contract.
 *
 * `inspect` must derive `rawSha256` and the filtered Git object id from the same immutable file-byte
 * or symlink-payload snapshot. It must never hash a symlink target. The other methods carry the same
 * no-follow, handle-relative guarantee, including preparation artifacts and recursive cleanup.
 */
export interface AnchoredRoundSourceLandingFileSystem {
  /**
   * Installs and verifies the permanent Git-info exclusion before any artifact write. It must
   * refuse visible pre-existing content and append idempotently without clobbering concurrent
   * info/exclude edits.
   */
  ensureInternalExclusion(input: {
    readonly artifactRoot: RoundSourceLandingRelativePath;
  }): Promise<{
    readonly source: "git-info-exclude";
    readonly pattern: string;
  }>;
  inspect(input: {
    readonly root: "source" | "worker";
    readonly path: RoundSourceLandingRelativePath;
    readonly repoPath: RoundSourceLandingRelativePath;
    readonly attrSource: string;
    readonly oidLength: 40 | 64;
  }): Promise<RoundSourceLandingObservedPathDescriptor>;
  manifestLeafPaths(input: {
    readonly root: "source" | "worker";
    readonly path: RoundSourceLandingRelativePath;
  }): Promise<readonly string[]>;
  /** Creates parents beneath the captured source root. */
  ensureParent(input: { readonly path: RoundSourceLandingRelativePath }): Promise<void>;
  /** Copies one worker-root leaf snapshot to a source-root artifact without following ancestors. */
  materializeTarget(input: {
    readonly sourcePath: RoundSourceLandingRelativePath;
    readonly destinationPath: RoundSourceLandingRelativePath;
    readonly mode: "100644" | "100755" | "120000";
  }): Promise<void>;
  /** Exclusively moves between two paths beneath the captured source root. */
  move(input: {
    readonly sourcePath: RoundSourceLandingRelativePath;
    readonly destinationPath: RoundSourceLandingRelativePath;
  }): Promise<ExclusiveNamespaceMoveOutcome>;
  /** Removes only beneath the captured source root. */
  remove(input: {
    readonly path: RoundSourceLandingRelativePath;
    readonly recursive?: boolean;
  }): Promise<void>;
  removeEmptyParents(input: { readonly path: RoundSourceLandingRelativePath }): Promise<void>;
  removeEmptyDirectory(input: {
    readonly path: RoundSourceLandingRelativePath;
  }): Promise<"absent" | "removed" | "not-empty" | "not-directory">;
}

/** Git execution already bound to the captured worker repository; it accepts no filesystem root. */
export type BoundRoundSourceLandingGit = (
  arguments_: readonly string[],
  options?: { readonly reject?: boolean },
) => Promise<string>;

type ObservedPathDescriptor = RoundSourceLandingObservedPathDescriptor;

type RawChangedPath = {
  readonly path: string;
  readonly baseline: GitTreePathDescriptor;
  readonly target: GitTreePathDescriptor;
};

type FrozenChangedPath = {
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

function descriptorFromRaw(mode: string, oid: string): GitTreePathDescriptor {
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
  return descriptor.kind === "absent"
    ? "absent"
    : `${descriptor.mode}:${descriptor.oid}:${descriptor.rawSha256}`;
}

function unitIdFor(change: FrozenChangedPath, ordinal: number): string {
  return sha256Hex(
    `${ordinal}\0${change.path}\0${descriptorIdentity(change.baseline)}\0${descriptorIdentity(change.target)}`,
  );
}

async function resolveCommit(git: BoundRoundSourceLandingGit, ref: string): Promise<string> {
  return (await git(["rev-parse", "--verify", `${ref}^{commit}`])).trim();
}

export async function planTransactionalRoundSourceLanding(input: {
  readonly git: BoundRoundSourceLandingGit;
  readonly fileSystem: AnchoredRoundSourceLandingFileSystem;
  readonly executionId: string;
  readonly baselineCommit: string;
  readonly workerHead: string;
  readonly startedAt: number;
}): Promise<TransactionalRoundSourceLandingAttempt> {
  const baselineCommit = await resolveCommit(input.git, input.baselineCommit);
  const workerHead = await resolveCommit(input.git, input.workerHead);
  const mergeBase = (await input.git(["merge-base", baselineCommit, workerHead])).trim();
  if (mergeBase !== baselineCommit) {
    throw new Error(`round baseline ${baselineCommit} is not an ancestor of ${workerHead}`);
  }
  const changes = orderChanges(
    parseRawChanges(
      await input.git([
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
  const units: RoundSourceLandingUnit[] = [];
  for (const [ordinal, change] of changes.entries()) {
    if (change.path === ".rennet" || change.path.startsWith(".rennet/")) {
      throw new RoundSourceLandingConflictError(
        change.path,
        "the changed path overlaps Rennet's local transaction namespace",
      );
    }
    const frozen = {
      path: change.path,
      baseline: await freezeEndpointDescriptor({
        fileSystem: input.fileSystem,
        root: "source",
        repoPath: change.path,
        expected: change.baseline,
        attrSource: baselineCommit,
      }),
      target: await freezeEndpointDescriptor({
        fileSystem: input.fileSystem,
        root: "worker",
        repoPath: change.path,
        expected: change.target,
        attrSource: workerHead,
      }),
    } satisfies FrozenChangedPath;
    const id = unitIdFor(frozen, ordinal);
    units.push({ id, ...frozen, ...roundSourceLandingArtifactPaths(input.executionId, id) });
  }
  const attempt = TransactionalRoundSourceLandingAttemptSchema.parse({
    effect: "source-landing",
    strategy: "exclusive-move-v1",
    executionId: input.executionId,
    baselineCommit,
    workerHead,
    startedAt: input.startedAt,
    units,
    unitReceipts: [],
  });
  await assertPlannedAbsentEndpoints(input.fileSystem, attempt);
  return attempt;
}

function oidLengthFor(unit: RoundSourceLandingUnit): 40 | 64 {
  const descriptor = unit.target.kind === "git" ? unit.target : unit.baseline;
  if (descriptor.kind !== "git") {
    throw new RoundSourceLandingConflictError(unit.path, "unit has no Git object endpoint");
  }
  return descriptor.oid.length === 64 ? 64 : 40;
}

function landingRelativePath(path: string): RoundSourceLandingRelativePath {
  if (
    path.length === 0 ||
    path.startsWith("/") ||
    path.includes("\0") ||
    path.includes("\\") ||
    path.split("/").some((part) => part.length === 0 || part === "." || part === "..")
  ) {
    throw new Error(`landing path is not normalized and repository-relative: ${path}`);
  }
  return path as RoundSourceLandingRelativePath;
}

async function freezeEndpointDescriptor(input: {
  readonly fileSystem: AnchoredRoundSourceLandingFileSystem;
  readonly root: "source" | "worker";
  readonly repoPath: string;
  readonly expected: GitTreePathDescriptor;
  readonly attrSource: string;
}): Promise<RoundSourceLandingPathDescriptor> {
  if (input.expected.kind === "absent") return input.expected;
  const repoPath = landingRelativePath(input.repoPath);
  const observed = await input.fileSystem.inspect({
    root: input.root,
    path: repoPath,
    repoPath,
    attrSource: input.attrSource,
    oidLength: input.expected.oid.length === 64 ? 64 : 40,
  });
  if (
    observed.kind !== "git" ||
    observed.mode !== input.expected.mode ||
    observed.oid !== input.expected.oid
  ) {
    throw new RoundSourceLandingConflictError(
      input.repoPath,
      `planned Git endpoint is ${describeObserved(observed)}`,
    );
  }
  return observed;
}

async function inspectUnitPath(input: {
  readonly fileSystem: AnchoredRoundSourceLandingFileSystem;
  readonly root: "source" | "worker";
  readonly path: string;
  readonly attempt: TransactionalRoundSourceLandingAttempt;
  readonly unit: RoundSourceLandingUnit;
  readonly endpoint: "baseline" | "target";
}): Promise<ObservedPathDescriptor> {
  const path = landingRelativePath(input.path);
  return input.fileSystem.inspect({
    root: input.root,
    path,
    repoPath: landingRelativePath(input.unit.path),
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
  return (
    observed.mode === expected.mode &&
    observed.oid === expected.oid &&
    observed.rawSha256 === expected.rawSha256
  );
}

function sameObserved(left: ObservedPathDescriptor, right: ObservedPathDescriptor): boolean {
  if (left.kind !== right.kind) return false;
  switch (left.kind) {
    case "absent":
    case "directory":
      return true;
    case "git":
      return (
        right.kind === "git" &&
        left.mode === right.mode &&
        left.oid === right.oid &&
        left.rawSha256 === right.rawSha256
      );
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
      return `${descriptor.mode}:${descriptor.oid}:${descriptor.rawSha256}`;
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

async function directoryIsManifestStructure(
  fileSystem: AnchoredRoundSourceLandingFileSystem,
  root: "source" | "worker",
  repoPath: string,
  attempt: TransactionalRoundSourceLandingAttempt,
): Promise<boolean> {
  const descendants = attempt.units.filter((unit) => unit.path.startsWith(`${repoPath}/`));
  if (descendants.length === 0) return false;
  const unitsByPath = new Map(descendants.map((unit) => [unit.path, unit]));
  const leaves = await fileSystem.manifestLeafPaths({ root, path: landingRelativePath(repoPath) });
  for (const leaf of leaves) {
    landingRelativePath(leaf);
    const unit = unitsByPath.get(leaf);
    if (unit === undefined) return false;
    const observedBaseline = await inspectUnitPath({
      fileSystem,
      root,
      path: leaf,
      attempt,
      unit,
      endpoint: "baseline",
    });
    const observedTarget =
      observedBaseline.kind === "git"
        ? await inspectUnitPath({
            fileSystem,
            root,
            path: leaf,
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
  readonly fileSystem: AnchoredRoundSourceLandingFileSystem;
  readonly root: "source" | "worker";
  readonly path: string;
  readonly observed: ObservedPathDescriptor;
  readonly expected: RoundSourceLandingPathDescriptor;
  readonly attempt: TransactionalRoundSourceLandingAttempt;
}): Promise<boolean> {
  if (sameDescriptor(input.observed, input.expected)) return true;
  return (
    input.expected.kind === "absent" &&
    input.observed.kind === "directory" &&
    (await directoryIsManifestStructure(input.fileSystem, input.root, input.path, input.attempt))
  );
}

async function assertPlannedAbsentEndpoints(
  fileSystem: AnchoredRoundSourceLandingFileSystem,
  attempt: TransactionalRoundSourceLandingAttempt,
): Promise<void> {
  for (const unit of attempt.units) {
    for (const endpoint of ["baseline", "target"] as const) {
      if (unit[endpoint].kind !== "absent") continue;
      const root = endpoint === "baseline" ? "source" : "worker";
      const observed = await inspectUnitPath({
        fileSystem,
        root,
        path: unit.path,
        attempt,
        unit,
        endpoint,
      });
      if (
        !(await matchesEndpoint({
          fileSystem,
          root,
          path: unit.path,
          observed,
          expected: unit[endpoint],
          attempt,
        }))
      ) {
        throw new RoundSourceLandingConflictError(
          unit.path,
          `${endpoint} endpoint is ${describeObserved(observed)}`,
        );
      }
    }
  }
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

async function preflightUnit(
  fileSystem: AnchoredRoundSourceLandingFileSystem,
  attempt: TransactionalRoundSourceLandingAttempt,
  unit: RoundSourceLandingUnit,
  index: number,
): Promise<void> {
  assertArtifactPaths(attempt, unit);
  const stage = await inspectUnitPath({
    fileSystem,
    root: "source",
    path: unit.stagePath,
    attempt,
    unit,
    endpoint: "target",
  });
  const stageMatchesTarget = unit.target.kind === "git" && sameDescriptor(stage, unit.target);
  if (stage.kind !== "absent" && !stageMatchesTarget) {
    throw new RoundSourceLandingConflictError(
      unit.path,
      `transaction stage is ${describeObserved(stage)}`,
    );
  }
  if (index >= attempt.unitReceipts.length && !stageMatchesTarget) {
    const workerTarget = await inspectUnitPath({
      fileSystem,
      root: "worker",
      path: unit.path,
      attempt,
      unit,
      endpoint: "target",
    });
    if (
      !(await matchesEndpoint({
        fileSystem,
        root: "worker",
        path: unit.path,
        observed: workerTarget,
        expected: unit.target,
        attempt,
      }))
    ) {
      throw new RoundSourceLandingConflictError(
        unit.path,
        `worker target is ${describeObserved(workerTarget)}`,
      );
    }
  }
  const observedBaseline = await inspectUnitPath({
    fileSystem,
    root: "source",
    path: unit.path,
    attempt,
    unit,
    endpoint: "baseline",
  });
  const observedTarget =
    observedBaseline.kind === "git"
      ? await inspectUnitPath({
          fileSystem,
          root: "source",
          path: unit.path,
          attempt,
          unit,
          endpoint: "target",
        })
      : observedBaseline;
  const matchesBaseline = await matchesEndpoint({
    fileSystem,
    root: "source",
    path: unit.path,
    observed: observedBaseline,
    expected: unit.baseline,
    attempt,
  });
  const matchesTarget = await matchesEndpoint({
    fileSystem,
    root: "source",
    path: unit.path,
    observed: observedTarget,
    expected: unit.target,
    attempt,
  });
  const backup = await inspectUnitPath({
    fileSystem,
    root: "source",
    path: unit.backupPath,
    attempt,
    unit,
    endpoint: "baseline",
  });
  const backupMatchesBaseline =
    unit.baseline.kind === "git" && sameDescriptor(backup, unit.baseline);
  if (backup.kind !== "absent" && !backupMatchesBaseline) {
    throw new RoundSourceLandingConflictError(
      unit.path,
      `transaction backup is ${describeObserved(backup)}`,
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

async function preflightAll(
  fileSystem: AnchoredRoundSourceLandingFileSystem,
  attempt: TransactionalRoundSourceLandingAttempt,
): Promise<void> {
  for (const [index, unit] of attempt.units.entries()) {
    await preflightUnit(fileSystem, attempt, unit, index);
  }
}

async function materializeStage(input: {
  readonly fileSystem: AnchoredRoundSourceLandingFileSystem;
  readonly attempt: TransactionalRoundSourceLandingAttempt;
  readonly unit: RoundSourceLandingUnit;
}): Promise<void> {
  if (input.unit.target.kind === "absent") return;
  const stage = input.unit.stagePath;
  const observedStage = await inspectUnitPath({
    fileSystem: input.fileSystem,
    root: "source",
    path: stage,
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
  const observedWorkerSource = await inspectUnitPath({
    fileSystem: input.fileSystem,
    root: "worker",
    path: input.unit.path,
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
  const preparation = roundSourceLandingPreparationPath(
    input.attempt.executionId,
    input.unit.id,
    randomUUID(),
  );
  await input.fileSystem.ensureParent({ path: landingRelativePath(preparation) });
  await input.fileSystem.materializeTarget({
    sourcePath: landingRelativePath(input.unit.path),
    destinationPath: landingRelativePath(preparation),
    mode: input.unit.target.mode,
  });
  await input.fileSystem.ensureParent({ path: landingRelativePath(stage) });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const outcome = await input.fileSystem.move({
      sourcePath: landingRelativePath(preparation),
      destinationPath: landingRelativePath(stage),
    });
    const materialized = await inspectUnitPath({
      fileSystem: input.fileSystem,
      root: "source",
      path: stage,
      attempt: input.attempt,
      unit: input.unit,
      endpoint: "target",
    });
    const pending = await inspectUnitPath({
      fileSystem: input.fileSystem,
      root: "source",
      path: preparation,
      attempt: input.attempt,
      unit: input.unit,
      endpoint: "target",
    });
    if (sameDescriptor(materialized, input.unit.target)) {
      await input.fileSystem.remove({ path: landingRelativePath(preparation) });
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
    await input.fileSystem.remove({ path: landingRelativePath(preparation) });
    throw new RoundSourceLandingConflictError(
      input.unit.path,
      `materialized stage is ${describeObserved(materialized)} after ${outcome.kind}`,
    );
  }
}

async function ensureNamespaceAbsent(
  fileSystem: AnchoredRoundSourceLandingFileSystem,
  path: string,
  repoPath: string,
): Promise<void> {
  const outcome = await fileSystem.removeEmptyDirectory({ path: landingRelativePath(path) });
  if (outcome === "absent" || outcome === "removed") return;
  throw new RoundSourceLandingConflictError(
    repoPath,
    outcome === "not-empty" ? "target directory is not empty" : "target namespace is occupied",
  );
}

async function moveAndReconcile(input: {
  readonly fileSystem: AnchoredRoundSourceLandingFileSystem;
  readonly repoPath: string;
  readonly sourcePath: string;
  readonly destinationPath: string;
  readonly descriptor: RoundSourceLandingPathDescriptor;
  readonly inspect: (path: string) => Promise<ObservedPathDescriptor>;
  readonly restoreUnexpectedDestination?: boolean;
}): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const outcome = await input.fileSystem.move({
      sourcePath: landingRelativePath(input.sourcePath),
      destinationPath: landingRelativePath(input.destinationPath),
    });
    const source = await input.inspect(input.sourcePath);
    const destination = await input.inspect(input.destinationPath);
    if (source.kind === "absent" && sameDescriptor(destination, input.descriptor)) return;
    if (
      source.kind === "absent" &&
      destination.kind !== "absent" &&
      input.restoreUnexpectedDestination === true &&
      (outcome.kind === "moved" || outcome.kind === "outcome-unknown")
    ) {
      const restoreOutcome = await input.fileSystem.move({
        sourcePath: landingRelativePath(input.destinationPath),
        destinationPath: landingRelativePath(input.sourcePath),
      });
      const restoredSource = await input.inspect(input.sourcePath);
      const clearedDestination = await input.inspect(input.destinationPath);
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
  readonly fileSystem: AnchoredRoundSourceLandingFileSystem;
  readonly attempt: TransactionalRoundSourceLandingAttempt;
  readonly unit: RoundSourceLandingUnit;
}): Promise<void> {
  if (input.unit.baseline.kind === "absent") return;
  const destination = input.unit.path;
  const backup = input.unit.backupPath;
  const inspectBaseline = (path: string) =>
    inspectUnitPath({
      fileSystem: input.fileSystem,
      root: "source",
      path,
      attempt: input.attempt,
      unit: input.unit,
      endpoint: "baseline",
    });
  const observedDestination = await inspectBaseline(destination);
  const observedBackup = await inspectBaseline(backup);
  if (
    observedDestination.kind !== "absent" ||
    observedBackup.kind === "absent" ||
    sameDescriptor(observedBackup, input.unit.baseline)
  ) {
    return;
  }
  await input.fileSystem.ensureParent({ path: landingRelativePath(destination) });
  const outcome = await input.fileSystem.move({
    sourcePath: landingRelativePath(backup),
    destinationPath: landingRelativePath(destination),
  });
  const restoredDestination = await inspectBaseline(destination);
  const clearedBackup = await inspectBaseline(backup);
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

async function ensureInternalExclusion(
  fileSystem: AnchoredRoundSourceLandingFileSystem,
  unitPath: string,
): Promise<void> {
  const exclusion = await fileSystem.ensureInternalExclusion({
    artifactRoot: landingRelativePath(TRANSACTION_ROOT),
  });
  if (exclusion.source !== "git-info-exclude" || exclusion.pattern !== TRANSACTION_EXCLUDE_RULE) {
    throw new RoundSourceLandingConflictError(
      unitPath,
      "transaction namespace exclusion was not verified in Git info/exclude",
    );
  }
}

export async function landTransactionalRoundSourceUnit(input: {
  readonly fileSystem: AnchoredRoundSourceLandingFileSystem;
  readonly attempt: TransactionalRoundSourceLandingAttempt;
  readonly unit: RoundSourceLandingUnit;
  /** True exactly for the first unit invocation of each coordinator drive or recovery. */
  readonly fullPreflight: boolean;
  readonly now?: () => number;
}): Promise<RoundSourceLandingUnitReceipt> {
  const nextUnit = input.attempt.units[input.attempt.unitReceipts.length];
  if (nextUnit?.id !== input.unit.id) {
    throw new RoundSourceLandingConflictError(
      input.unit.path,
      "unit is not the next manifest item",
    );
  }
  await ensureInternalExclusion(input.fileSystem, input.unit.path);
  await restoreStrandedConcurrentEdit(input);
  if (input.fullPreflight) {
    await preflightAll(input.fileSystem, input.attempt);
  } else {
    await preflightUnit(
      input.fileSystem,
      input.attempt,
      input.unit,
      input.attempt.unitReceipts.length,
    );
  }
  const destination = input.unit.path;
  const stage = input.unit.stagePath;
  const backup = input.unit.backupPath;
  const inspectBaseline = (path: string) =>
    inspectUnitPath({
      fileSystem: input.fileSystem,
      root: "source",
      path,
      attempt: input.attempt,
      unit: input.unit,
      endpoint: "baseline",
    });
  const inspectTarget = (path: string) =>
    inspectUnitPath({
      fileSystem: input.fileSystem,
      root: "source",
      path,
      attempt: input.attempt,
      unit: input.unit,
      endpoint: "target",
    });
  let observedDestination = await inspectBaseline(destination);
  const observedTarget =
    observedDestination.kind === "git" ? await inspectTarget(destination) : observedDestination;
  const destinationIsTarget = await matchesEndpoint({
    fileSystem: input.fileSystem,
    root: "source",
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
    fileSystem: input.fileSystem,
    root: "source",
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
    fileSystem: input.fileSystem,
    attempt: input.attempt,
    unit: input.unit,
  });

  if (destinationIsBaseline && input.unit.baseline.kind !== "absent") {
    if (backupExists) {
      throw new RoundSourceLandingConflictError(
        input.unit.path,
        "baseline exists at both destination and backup",
      );
    }
    await input.fileSystem.ensureParent({ path: landingRelativePath(backup) });
    await moveAndReconcile({
      fileSystem: input.fileSystem,
      repoPath: input.unit.path,
      sourcePath: destination,
      destinationPath: backup,
      descriptor: input.unit.baseline,
      inspect: inspectBaseline,
      restoreUnexpectedDestination: true,
    });
    await input.fileSystem.removeEmptyParents({ path: landingRelativePath(destination) });
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
      await ensureNamespaceAbsent(input.fileSystem, destination, input.unit.path);
    }
    await input.fileSystem.ensureParent({ path: landingRelativePath(destination) });
    await moveAndReconcile({
      fileSystem: input.fileSystem,
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
  readonly fileSystem: AnchoredRoundSourceLandingFileSystem;
  readonly receipt: TransactionalRoundSourceLandingReceipt;
}): Promise<void> {
  for (const unit of input.receipt.units) assertArtifactPaths(input.receipt, unit);
  const transactionPath = roundSourceLandingTransactionPath(input.receipt.executionId);
  await input.fileSystem.remove({ path: landingRelativePath(transactionPath), recursive: true });
}
