import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import {
  cleanupTransactionalRoundSourceLanding,
  createNativeRoundSourceLandingFileSystem,
  type GitExec,
  landTransactionalRoundSourceUnit,
  type NativeRoundSourceLandingFileSystemHandle,
  planTransactionalRoundSourceLanding,
} from "@rennet/adapters";
import type { RoundOperation, TransactionalRoundSourceLandingAttempt } from "@rennet/protocol";
import type { RoundExecutionPorts } from "./runtime/round-execution";

export interface RoundSourceLandingInjection {
  readonly plan: (
    operation: RoundOperation,
  ) => TransactionalRoundSourceLandingAttempt | Promise<TransactionalRoundSourceLandingAttempt>;
  readonly landUnit: NonNullable<RoundExecutionPorts["landSourceUnit"]>;
  readonly cleanup: NonNullable<RoundExecutionPorts["cleanupSourceLanding"]>;
}

export interface NativeRoundSourceLandingInjection extends RoundSourceLandingInjection {
  close(): Promise<void>;
}

export interface NativeLandingHandle extends NativeRoundSourceLandingFileSystemHandle {
  readonly git: Parameters<typeof planTransactionalRoundSourceLanding>[0]["git"];
}

export interface NativeLandingRoots {
  readonly sourceRoot: string;
  readonly workerRoot: string;
}

interface ActiveNativeLanding {
  readonly roots: NativeLandingRoots;
  readonly handle: Promise<NativeLandingHandle>;
  closed: boolean;
}

interface NativeLandingEffects {
  readonly plan: typeof planTransactionalRoundSourceLanding;
  readonly landUnit: typeof landTransactionalRoundSourceUnit;
  readonly cleanup: typeof cleanupTransactionalRoundSourceLanding;
}

export interface CreateNativeRoundSourceLandingInjectionInput {
  readonly gitForRepo: (repoRoot: string) => GitExec;
  readonly openHandle?: (roots: NativeLandingRoots) => Promise<NativeLandingHandle>;
  readonly effects?: Partial<NativeLandingEffects>;
  readonly createExecutionId?: () => string;
  readonly now?: () => number;
}

function boundGit(git: GitExec, root: string): NativeLandingHandle["git"] {
  return (arguments_, options) => git(root, [...arguments_], options);
}

function absoluteGitPath(output: string, label: string): string {
  const path = output.replace(/\r?\n$/, "");
  if (!isAbsolute(path) || path.includes("\n") || path.includes("\r")) {
    throw new Error(`Git returned an invalid absolute ${label}: ${JSON.stringify(output)}`);
  }
  return path;
}

async function openProductionHandle(
  roots: NativeLandingRoots,
  gitForRepo: (repoRoot: string) => GitExec,
): Promise<NativeLandingHandle> {
  const sourceGit = boundGit(gitForRepo(roots.sourceRoot), roots.sourceRoot);
  const workerGit = boundGit(gitForRepo(roots.workerRoot), roots.workerRoot);
  const infoExcludePath = absoluteGitPath(
    await sourceGit(["rev-parse", "--path-format=absolute", "--git-path", "info/exclude"]),
    "Git info/exclude path",
  );
  return {
    ...createNativeRoundSourceLandingFileSystem({
      sourceRoot: roots.sourceRoot,
      workerRoot: roots.workerRoot,
      infoExcludePath,
      sourceGit,
      workerGit,
    }),
    git: workerGit,
  };
}

function landingRoots(operation: RoundOperation): NativeLandingRoots {
  if (!("workspace" in operation.state)) {
    throw new Error(`Round source landing has no prepared workspace in ${operation.state.phase}.`);
  }
  return {
    sourceRoot: operation.repoRoot,
    workerRoot: operation.state.workspace.worktreePath,
  };
}

function sameRoots(left: NativeLandingRoots, right: NativeLandingRoots): boolean {
  return left.sourceRoot === right.sourceRoot && left.workerRoot === right.workerRoot;
}

function combinedFailure(effectError: unknown, closeError: unknown): AggregateError {
  return new AggregateError(
    [effectError, closeError],
    "Native round source landing and rooted-host cleanup both failed.",
  );
}

export function supportsNativeRoundSourceLanding(
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform !== "win32";
}

export function createNativeRoundSourceLandingInjection(
  input: CreateNativeRoundSourceLandingInjectionInput,
): NativeRoundSourceLandingInjection {
  const effects: NativeLandingEffects = {
    plan: input.effects?.plan ?? planTransactionalRoundSourceLanding,
    landUnit: input.effects?.landUnit ?? landTransactionalRoundSourceUnit,
    cleanup: input.effects?.cleanup ?? cleanupTransactionalRoundSourceLanding,
  };
  const openHandle = input.openHandle ?? ((roots) => openProductionHandle(roots, input.gitForRepo));
  const active = new Map<string, ActiveNativeLanding>();
  let closed = false;
  let closePromise: Promise<void> | undefined;

  const closeEntry = async (entry: ActiveNativeLanding): Promise<void> => {
    if (entry.closed) return;
    entry.closed = true;
    const handle = await entry.handle;
    handle.close();
  };

  const release = async (operationId: string): Promise<void> => {
    const entry = active.get(operationId);
    if (entry === undefined) return;
    active.delete(operationId);
    await closeEntry(entry);
  };

  const failAfterRelease = async (operationId: string, error: unknown): Promise<never> => {
    try {
      await release(operationId);
    } catch (closeError) {
      throw combinedFailure(error, closeError);
    }
    throw error;
  };

  const handleFor = async (operation: RoundOperation): Promise<NativeLandingHandle> => {
    if (closed) throw new Error("Native round source landing composition is closed.");
    const roots = landingRoots(operation);
    const existing = active.get(operation.operationId);
    if (existing !== undefined) {
      if (!sameRoots(existing.roots, roots)) {
        throw new Error("Round source landing roots changed within one durable operation.");
      }
      const handle = await existing.handle;
      if (closed || existing.closed) {
        throw new Error("Native round source landing composition closed while opening a host.");
      }
      return handle;
    }
    const entry: ActiveNativeLanding = {
      roots,
      handle: Promise.resolve().then(() => openHandle(roots)),
      closed: false,
    };
    active.set(operation.operationId, entry);
    try {
      const handle = await entry.handle;
      if (closed || entry.closed) {
        throw new Error("Native round source landing composition closed while opening a host.");
      }
      return handle;
    } catch (error) {
      if (active.get(operation.operationId) === entry) active.delete(operation.operationId);
      throw error;
    }
  };

  const close = (): Promise<void> => {
    if (closePromise !== undefined) return closePromise;
    closed = true;
    const entries = [...active.values()];
    active.clear();
    closePromise = Promise.allSettled(entries.map(closeEntry)).then((results) => {
      const failures = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (failures.length > 0) {
        throw new AggregateError(failures, "Could not close native round source landing hosts.");
      }
    });
    return closePromise;
  };

  return {
    async plan(operation) {
      if (operation.state.phase !== "commits-settled") {
        throw new Error("Round source landing planned before commits settled.");
      }
      try {
        const handle = await handleFor(operation);
        return await effects.plan({
          git: handle.git,
          fileSystem: handle.fileSystem,
          executionId: (input.createExecutionId ?? randomUUID)(),
          baselineCommit: operation.state.commits.from,
          workerHead: operation.state.commits.to,
          startedAt: (input.now ?? Date.now)(),
        });
      } catch (error) {
        return failAfterRelease(operation.operationId, error);
      }
    },

    async landUnit(unitInput) {
      try {
        const handle = await handleFor(unitInput.operation);
        return await effects.landUnit({
          fileSystem: handle.fileSystem,
          attempt: unitInput.attempt,
          unit: unitInput.unit,
          fullPreflight: unitInput.fullPreflight,
          now: input.now,
        });
      } catch (error) {
        return failAfterRelease(unitInput.operation.operationId, error);
      }
    },

    async cleanup(cleanupInput) {
      let effectError: unknown;
      try {
        const handle = await handleFor(cleanupInput.operation);
        await effects.cleanup({
          fileSystem: handle.fileSystem,
          receipt: cleanupInput.receipt,
        });
      } catch (error) {
        effectError = error;
      }
      try {
        await release(cleanupInput.operation.operationId);
      } catch (closeError) {
        if (effectError !== undefined) throw combinedFailure(effectError, closeError);
        throw closeError;
      }
      if (effectError !== undefined) throw effectError;
    },

    close,
  };
}
