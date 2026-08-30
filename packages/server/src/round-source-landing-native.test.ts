import type { AnchoredRoundSourceLandingFileSystem, GitExec } from "@rennet/adapters";
import type {
  RoundOperation,
  RoundOperationState,
  TransactionalRoundSourceLandingAttempt,
  TransactionalRoundSourceLandingReceipt,
} from "@rennet/protocol";
import { roundSourceLandingArtifactPaths, sha256Hex } from "@rennet/protocol";
import { describe, expect, it, vi } from "vitest";
import {
  createNativeRoundSourceLandingInjection,
  type NativeLandingHandle,
  supportsNativeRoundSourceLanding,
} from "./round-source-landing-native";

const workspace = {
  kind: "detached-worktree" as const,
  worktreePath: "/worker",
  sourceTreeOid: "source-tree",
  sourceParentHead: "source-parent",
  startedAt: 1,
  sourceHead: "source-head",
  preparedAt: 2,
};
const worker = {
  executionId: "worker-execution",
  startedAt: 3,
  completedAt: 4,
  diff: "diff",
  changedPaths: ["a.txt"],
  outcome: "completed" as const,
};
const gate = { outcome: "skipped" as const, reason: "not-configured" as const, settledAt: 5 };
const commits = {
  executionId: "commit-execution",
  baseHead: "source-head",
  startedAt: 6,
  from: "baseline",
  to: "worker-head",
  count: 1,
  committedAt: 7,
};

function operation(state: RoundOperationState): RoundOperation {
  const workOrderPrompt = "apply the reviewed ask";
  return {
    operationId: "operation-1",
    sessionId: "session-1",
    reviewId: "review-1",
    dispatchId: "dispatch-1",
    sourcePatchsetId: "patchset-1",
    askOccurrences: [{ id: "ask-1", revision: 1 }],
    roundNumber: 1,
    sourceTarget: { kind: "branch", branch: "main" },
    repoRoot: "/source",
    workOrderPrompt,
    workOrderDigest: sha256Hex(workOrderPrompt),
    gatePlan: { kind: "absent" },
    revision: 0,
    rerunRequested: false,
    createdAt: 0,
    updatedAt: 7,
    state,
  };
}

const unitId = "a".repeat(64);
const attempt: TransactionalRoundSourceLandingAttempt = {
  effect: "source-landing",
  strategy: "exclusive-move-v1",
  executionId: "landing-execution",
  baselineCommit: commits.from,
  workerHead: commits.to,
  startedAt: 8,
  units: [
    {
      id: unitId,
      path: "a.txt",
      baseline: {
        kind: "git",
        mode: "100644",
        oid: "1".repeat(40),
        rawSha256: "2".repeat(64),
      },
      target: {
        kind: "git",
        mode: "100644",
        oid: "3".repeat(40),
        rawSha256: "4".repeat(64),
      },
      ...roundSourceLandingArtifactPaths("landing-execution", unitId),
    },
  ],
  unitReceipts: [],
};

const receipt: TransactionalRoundSourceLandingReceipt = {
  ...attempt,
  unitReceipts: [{ unitId, outcome: "applied", landedAt: 9 }],
  outcome: "applied",
  landedAt: 9,
};

function fakeFileSystem(): AnchoredRoundSourceLandingFileSystem {
  return {
    ensureInternalExclusion: async () => ({
      source: "git-info-exclude",
      pattern: "/.rennet/round-landings/",
    }),
    inspect: async () => ({ kind: "absent" }),
    manifestLeafPaths: async () => [],
    ensureParent: async () => undefined,
    materializeTarget: async () => undefined,
    move: async () => ({ kind: "moved" }),
    remove: async () => undefined,
    removeEmptyParents: async () => undefined,
    removeEmptyDirectory: async () => "absent",
  };
}

const git: GitExec = async () => "";

function fakeHandle(close: () => void): NativeLandingHandle {
  return { fileSystem: fakeFileSystem(), git: async () => "", close };
}

function commitsSettled(): RoundOperation {
  return operation({ phase: "commits-settled", workspace, worker, gate, commits });
}

function sourceLanding(): RoundOperation {
  return operation({ phase: "source-landing", workspace, worker, gate, commits, landing: attempt });
}

function sourceLanded(): RoundOperation {
  return operation({ phase: "source-landed", workspace, worker, gate, commits, landing: receipt });
}

describe("native round source landing composition", () => {
  it("activates on POSIX daemons and retains the explicit native-Windows fallback", () => {
    expect(supportsNativeRoundSourceLanding("darwin")).toBe(true);
    expect(supportsNativeRoundSourceLanding("linux")).toBe(true);
    expect(supportsNativeRoundSourceLanding("win32")).toBe(false);
  });

  it("holds one rooted host across planning, every unit, and successful cleanup", async () => {
    const close = vi.fn();
    const openHandle = vi.fn(async () => fakeHandle(close));
    const observedFileSystems: AnchoredRoundSourceLandingFileSystem[] = [];
    const plan = vi.fn(async (input: { fileSystem: AnchoredRoundSourceLandingFileSystem }) => {
      observedFileSystems.push(input.fileSystem);
      return attempt;
    });
    const landUnit = vi.fn(async (input: { fileSystem: AnchoredRoundSourceLandingFileSystem }) => {
      observedFileSystems.push(input.fileSystem);
      return { unitId, outcome: "applied" as const, landedAt: 9 };
    });
    const cleanup = vi.fn(async (input: { fileSystem: AnchoredRoundSourceLandingFileSystem }) => {
      observedFileSystems.push(input.fileSystem);
    });
    const injection = createNativeRoundSourceLandingInjection({
      gitForRepo: () => git,
      openHandle,
      effects: { plan, landUnit, cleanup },
      createExecutionId: () => attempt.executionId,
      now: () => attempt.startedAt,
    });

    const planned = await injection.plan(commitsSettled());
    const unit = planned.units[0];
    if (unit === undefined) throw new Error("controlled landing attempt omitted its unit");
    await injection.landUnit({
      operation: sourceLanding(),
      attempt: planned,
      unit,
      fullPreflight: true,
    });
    await injection.cleanup({ operation: sourceLanded(), receipt });
    await injection.close();

    expect(openHandle).toHaveBeenCalledOnce();
    expect(observedFileSystems).toHaveLength(3);
    expect(new Set(observedFileSystems).size).toBe(1);
    expect(close).toHaveBeenCalledOnce();
  });

  it("closes a failed planning host and reconstructs a fresh one for the next drive", async () => {
    const close = vi.fn();
    const openHandle = vi.fn(async () => fakeHandle(close));
    let attempts = 0;
    const injection = createNativeRoundSourceLandingInjection({
      gitForRepo: () => git,
      openHandle,
      effects: {
        plan: async () => {
          attempts += 1;
          if (attempts === 1) throw new Error("controlled planning failure");
          return attempt;
        },
      },
    });

    await expect(injection.plan(commitsSettled())).rejects.toThrow("controlled planning failure");
    expect(close).toHaveBeenCalledOnce();
    await expect(injection.plan(commitsSettled())).resolves.toEqual(attempt);
    expect(openHandle).toHaveBeenCalledTimes(2);
    await injection.close();
    expect(close).toHaveBeenCalledTimes(2);
  });

  it("closes a still-constructing rooted host during server shutdown", async () => {
    let resolveHandle!: (handle: NativeLandingHandle) => void;
    const pendingHandle = new Promise<NativeLandingHandle>((resolve) => {
      resolveHandle = resolve;
    });
    const close = vi.fn();
    const openHandle = vi.fn(() => pendingHandle);
    const injection = createNativeRoundSourceLandingInjection({
      gitForRepo: () => git,
      openHandle,
      effects: { plan: async () => attempt },
    });

    const planning = injection.plan(commitsSettled());
    await vi.waitFor(() => expect(openHandle).toHaveBeenCalledOnce());
    const closing = injection.close();
    resolveHandle(fakeHandle(close));

    await closing;
    await expect(planning).rejects.toThrow("closed while opening a host");
    expect(close).toHaveBeenCalledOnce();
  });
});
