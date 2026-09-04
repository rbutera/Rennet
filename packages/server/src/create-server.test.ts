import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ForgeDetectionDeps,
  GenerationStore,
  type GitExec,
  type GitLabPrSubmissionCommand,
  RoundOperationStore,
  RoundRecordStore,
  SessionStore,
  SqliteReviewStore,
  TranscriptStore,
} from "@rennet/adapters";
import { type HarnessPort, mintSession } from "@rennet/core";
import type {
  Generation,
  LensBoard,
  Project,
  Review,
  RoundOperation,
  SidebarSession,
} from "@rennet/protocol";
import { generationIdForPatchset, ROUND_NO_REGEN, sha256Hex } from "@rennet/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  captureBranchPatchset,
  captureLandedBranchPatchset,
  createBoardDraftCoordinator,
  createCompositionBoardsForReview,
  createGitLabPrSubmissionResolver,
  createRennetServer,
  createRoundRegenerationProgressQueue,
  createRoundWorkerPort,
  createRoundWorkerRecoveryPort,
  createRoundWorkspacePlanner,
  reconcileRoundReceiptWithCommits,
  resolveCodingHarness,
  runResolvedCodingHarnessTurn,
  startProjectContextMaintenance,
} from "./create-server";
import { createGitHubTokenStore } from "./github-token-store";
import type { ProjectProcessJournalRecord } from "./project-process-journal";

type TestServer = Awaited<ReturnType<typeof createRennetServer>>;
type PreparationSession = {
  id: string;
  reviewId?: string;
  preparation?: SidebarSession["preparation"];
};

function codingPort(id: "claude-code" | "codex", version: string): HarnessPort {
  return {
    descriptor: { id, version },
  } as unknown as HarnessPort;
}

describe("coding-harness resolution", () => {
  it("selects Claude Code for a Claude-only host and reports the exact version", async () => {
    const claude = codingPort("claude-code", "2.1.220");
    const resolution = await resolveCodingHarness({
      resolveClaude: async () => claude,
      resolveCodex: async () => null,
    });

    expect(resolution).toEqual({
      status: "ready",
      selection: { id: "claude-code", version: "2.1.220" },
      port: claude,
    });
  });

  it("pins the first provider before running and refuses to substitute it on the next turn", async () => {
    const store = new SessionStore(mkdtempSync(join(tmpdir(), "rennet-harness-pin-")));
    store.save({
      ...mintSession("project-1", { id: () => "session-1", now: () => 1 }),
      harnessCursor: {
        harnessSessionId: "legacy-claude-session",
        lastAssistantMessageAnchor: "message-1",
        turnCount: 2,
      },
    });
    const codex = codingPort("codex", "0.146.0");
    const firstRun = vi.fn(async () => {
      expect(store.load("session-1")?.codingHarness).toEqual({
        id: "codex",
        version: "0.146.0",
      });
      expect(store.load("session-1")?.harnessCursor).toBeUndefined();
      return {
        status: "completed" as const,
        finalText: "done",
        turnDiff: "diff",
        filesTouched: ["a.ts"],
      };
    });

    const first = await runResolvedCodingHarnessTurn({
      sessionId: "session-1",
      sessionStore: store,
      resolveClaude: async () => null,
      resolveCodex: async () => codex,
      run: firstRun,
    });

    expect(firstRun).toHaveBeenCalledWith(codex, "session-1");
    expect(first.harness).toEqual({ id: "codex", version: "0.146.0" });
    expect(store.load("session-1")?.codingHarness).toEqual({
      id: "codex",
      version: "0.146.0",
    });
    expect(store.load("session-1")?.harnessCursor).toBeUndefined();

    const resolveClaude = vi.fn(async () => codingPort("claude-code", "2.1.220"));
    const secondRun = vi.fn(async () => ({
      status: "completed" as const,
      finalText: "wrong provider",
      turnDiff: "",
      filesTouched: [],
    }));
    const second = await runResolvedCodingHarnessTurn({
      sessionId: "session-1",
      sessionStore: store,
      resolveClaude,
      resolveCodex: async () => null,
      run: secondRun,
    });

    expect(second).toEqual({
      status: "failed",
      reason: "Codex is selected for this session but is not available on its execution host.",
      turnDiff: "",
      filesTouched: [],
    });
    expect(resolveClaude).not.toHaveBeenCalled();
    expect(secondRun).not.toHaveBeenCalled();
  });

  it("selects Codex for a Codex-only host and reports the exact version", async () => {
    const codex = codingPort("codex", "0.146.0");
    const resolution = await resolveCodingHarness({
      resolveClaude: async () => null,
      resolveCodex: async () => codex,
    });

    expect(resolution).toEqual({
      status: "ready",
      selection: { id: "codex", version: "0.146.0" },
      port: codex,
    });
  });

  it("keeps a session's pinned provider and never falls back when it disappears", async () => {
    const resolveCodex = vi.fn(async () => codingPort("codex", "0.146.0"));
    const resolution = await resolveCodingHarness({
      pinned: { id: "claude-code", version: "2.1.220" },
      resolveClaude: async () => null,
      resolveCodex,
    });

    expect(resolution).toEqual({
      status: "unavailable",
      reason:
        "Claude Code is selected for this session but is not available on its execution host.",
    });
    expect(resolveCodex).not.toHaveBeenCalled();
  });

  it("honors the host's enabled-harness configuration before choosing", async () => {
    const codex = codingPort("codex", "0.146.0");
    const resolution = await resolveCodingHarness({
      disabledHarnesses: ["claude"],
      resolveClaude: async () => codingPort("claude-code", "2.1.220"),
      resolveCodex: async () => codex,
    });

    expect(resolution).toMatchObject({
      status: "ready",
      selection: { id: "codex", version: "0.146.0" },
    });
  });

  it("uses the available provider when the other provider's discovery throws", async () => {
    const codex = codingPort("codex", "0.146.0");
    const resolution = await resolveCodingHarness({
      resolveClaude: async () => {
        throw new Error("broken claude executable");
      },
      resolveCodex: async () => codex,
    });

    expect(resolution).toEqual({
      status: "ready",
      selection: { id: "codex", version: "0.146.0" },
      port: codex,
    });
  });

  // The third #681 scenario: nothing configured resolves. The turn must fail typed and
  // spend nothing — a `run` that still fired would mean a provider was chosen anyway.
  it("fails typed and runs nothing when no configured harness is available", async () => {
    const run = vi.fn(async () => ({
      status: "completed" as const,
      finalText: "should never run",
      turnDiff: "",
      filesTouched: [],
    }));

    const outcome = await runResolvedCodingHarnessTurn({
      sessionStore: new SessionStore(mkdtempSync(join(tmpdir(), "rennet-harness-none-"))),
      resolveClaude: async () => null,
      resolveCodex: async () => null,
      run,
    });

    expect(outcome).toEqual({
      status: "failed",
      reason:
        "No enabled coding harness (Claude Code or Codex) is available on the execution host.",
      turnDiff: "",
      filesTouched: [],
    });
    expect(run).not.toHaveBeenCalled();
  });

  // The MISRESOLUTION control (#681): a resolver that hands back the wrong provider is
  // the silent-substitution shape the issue forbids. Deleting the descriptor check in
  // `resolveExact` turns this green-to-red — it is the only assertion that reaches it.
  it("refuses a resolver that answers a pinned provider with a different one", async () => {
    const resolution = await resolveCodingHarness({
      pinned: { id: "claude-code", version: "2.1.220" },
      resolveClaude: async () => codingPort("codex", "0.146.0"),
      resolveCodex: async () => null,
    });

    expect(resolution).toEqual({
      status: "unavailable",
      reason:
        "The claude-code resolver returned codex; refusing to run a different harness than the selected one.",
    });
  });

  // The SAME misresolution, on the path a first round actually takes: unpinned. The
  // pinned test above passed while this shape reported "No enabled coding harness" —
  // the unpinned branch skipped a wrong-provider port and fell through to the generic
  // line, throwing away what the resolver had returned. That is a wrong diagnosis, not
  // a vague one: it tells a user with both harnesses installed to go install one.
  // Deleting either `misresolution(...)` entry from the joined reason reddens this.
  it("keeps the sought/found mismatch in the reason when an unpinned resolver misresolves", async () => {
    const resolution = await resolveCodingHarness({
      resolveClaude: async () => codingPort("codex", "0.146.0"),
      resolveCodex: async () => codingPort("claude-code", "2.1.220"),
    });

    expect(resolution).toEqual({
      status: "unavailable",
      reason:
        "The claude-code resolver returned codex; refusing to run a different harness than the selected one.; " +
        "The codex resolver returned claude-code; refusing to run a different harness than the selected one.",
    });
    // The generic fallback must NOT be what a misresolution reports.
    expect(resolution.status === "unavailable" ? resolution.reason : "").not.toContain(
      "No enabled coding harness",
    );
  });

  // One resolver misresolving while the other is simply absent — the realistic single-
  // sided shape, and the one where the generic line was most convincing.
  it("names the misresolved provider even when the other resolver found nothing", async () => {
    const resolution = await resolveCodingHarness({
      resolveClaude: async () => null,
      resolveCodex: async () => codingPort("claude-code", "2.1.220"),
    });

    expect(resolution).toEqual({
      status: "unavailable",
      reason:
        "The codex resolver returned claude-code; refusing to run a different harness than the selected one.",
    });
  });
});

async function waitForReviewSession(
  server: TestServer,
  sessionId: string,
): Promise<PreparationSession> {
  let prepared: PreparationSession | undefined;
  await vi.waitFor(
    async () => {
      const listed = (await server.dispatch("session.list", {})) as {
        sessions: PreparationSession[];
      };
      prepared = listed.sessions.find((session) => session.id === sessionId);
      expect(prepared?.reviewId).toBeDefined();
    },
    { timeout: 15_000, interval: 20 },
  );
  return prepared as PreparationSession;
}

describe("project context maintenance", () => {
  const project = {
    id: "project-1",
    name: "Rennet",
    path: "/repo",
    openPath: "/repo",
  } as Project;

  const journal = (
    status: ProjectProcessJournalRecord["status"],
    phase: ProjectProcessJournalRecord["phase"],
  ): ProjectProcessJournalRecord => ({
    version: 1,
    runId: randomUUID(),
    projectId: project.id,
    status,
    phase,
    repos: [],
    failures:
      status === "failed"
        ? [{ repo: "rennet", path: "/repo", phase: "map", reason: "worker exited" }]
        : [],
    events: [],
  });

  it("resumes an interrupted run under its durable identity before starting rehydration", async () => {
    const interrupted = journal("running", "map");
    const resume = vi.fn(async () => ({ run: { status: "done" } }));
    const rehydrate = vi.fn(async () => undefined);
    const onError = vi.fn();

    startProjectContextMaintenance({
      projects: [project],
      loadRun: () => interrupted,
      resume,
      rehydrate,
      onError,
    });

    await vi.waitFor(() => expect(rehydrate).toHaveBeenCalledWith(project));
    expect(resume).toHaveBeenCalledWith(project, interrupted.runId);
    expect(onError).not.toHaveBeenCalled();
  });

  it("keeps failed work retryable instead of resuming it", () => {
    const failed = journal("failed", "map");
    const resume = vi.fn(async () => ({ run: { status: "done" } }));
    const rehydrate = vi.fn(async () => undefined);

    startProjectContextMaintenance({
      projects: [project],
      loadRun: () => failed,
      resume,
      rehydrate,
      onError: vi.fn(),
    });

    expect(resume).not.toHaveBeenCalled();
    expect(rehydrate).not.toHaveBeenCalled();
  });
});

describe("publish board-drafting coordination", () => {
  const review = {
    id: "review-boards",
    activePatchsetId: "patch-1",
    patchsets: [{ id: "patch-1" }],
  } as unknown as Review;

  it("shares concurrent work, evicts a failed attempt, and lets the next compose retry", async () => {
    let release!: (settled: boolean) => void;
    let calls = 0;
    const outcomes = [
      new Promise<boolean>((resolve) => {
        release = resolve;
      }),
      Promise.resolve(false),
      Promise.resolve(true),
    ];
    const ensure = createBoardDraftCoordinator(async () => {
      const outcome = outcomes[calls];
      calls += 1;
      return outcome ?? false;
    });

    const first = ensure(review);
    const joined = ensure(review);
    expect(joined).toBe(first);
    expect(calls).toBe(1);
    release(true);
    await expect(first).resolves.toBeUndefined();
    await expect(ensure(review)).rejects.toThrow("did not settle");
    await expect(ensure(review)).resolves.toBeUndefined();
    expect(calls).toBe(3);
  });

  it("waits for an aborted draft to unwind before an immediate retry starts", async () => {
    const firstController = new AbortController();
    const secondController = new AbortController();
    let releaseFirst!: () => void;
    let calls = 0;
    const ensure = createBoardDraftCoordinator(async (_review, _emit, signal) => {
      calls += 1;
      if (calls === 1) {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
        return !signal?.aborted;
      }
      return true;
    });

    const first = ensure(review, undefined, firstController.signal);
    await vi.waitFor(() => expect(calls).toBe(1));
    firstController.abort("cancelled");
    const retry = ensure(review, undefined, secondController.signal);
    expect(retry).not.toBe(first);
    expect(calls).toBe(1);
    releaseFirst();
    await expect(first).rejects.toThrow("did not settle");
    await expect(retry).resolves.toBeUndefined();
    expect(calls).toBe(2);
  });

  it("queues a fresh draft behind in-flight work when project context advances", async () => {
    let revision = "context-a";
    let releaseFirst!: () => void;
    const seen: string[] = [];
    const ensure = createBoardDraftCoordinator(
      async () => {
        seen.push(revision);
        if (seen.length === 1) {
          await new Promise<void>((resolve) => {
            releaseFirst = resolve;
          });
        }
        return true;
      },
      () => revision,
    );

    const first = ensure(review);
    await vi.waitFor(() => expect(seen).toEqual(["context-a"]));
    revision = "context-b";
    const refreshed = ensure(review);

    expect(refreshed).not.toBe(first);
    expect(seen).toEqual(["context-a"]);
    releaseFirst();
    await expect(first).resolves.toBeUndefined();
    await expect(refreshed).resolves.toBeUndefined();
    expect(seen).toEqual(["context-a", "context-b"]);
  });

  it("returns retryable drafting after failure, then exposes the exact settled named boards", async () => {
    const board = { boardId: "board-design", lens: "design" } as unknown as LensBoard;
    let stored: Generation | undefined;
    let attempts = 0;
    const source = createCompositionBoardsForReview({
      reviewById: () => review,
      loadGeneration: () => stored,
      ensureBoardDrafting: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("transient model failure");
        stored = {
          id: "gen:patch-1",
          patchsetId: "patch-1",
          lensBoards: { design: board.boardId },
          status: "live",
        };
      },
      readLensBoard: async () => board,
    });

    await expect(source(review.id, "gen:patch-1")).resolves.toEqual({ status: "drafting" });
    await expect(source(review.id, "gen:patch-1")).resolves.toEqual({
      status: "settled",
      boards: [board],
    });
    expect(attempts).toBe(2);
  });

  it("asks the caller to retry when generation A races a live review already advanced to B", async () => {
    const advanced = { ...review, activePatchsetId: "patch-2" } as Review;
    const generations = new Map<string, Generation>();
    const source = createCompositionBoardsForReview({
      reviewById: () => advanced,
      loadGeneration: (id) => generations.get(id),
      ensureBoardDrafting: async () => {
        generations.set("gen:patch-2", {
          id: "gen:patch-2",
          patchsetId: "patch-2",
          lensBoards: {},
          status: "live",
        });
      },
      readLensBoard: async () => undefined,
    });

    await expect(source(advanced.id, "gen:patch-1")).resolves.toEqual({ status: "drafting" });
  });
});

describe("round regeneration progress coordination", () => {
  it("keeps a throwing diagnostic sink outside the awaited report handoff queue", async () => {
    const order: string[] = [];
    let releaseReport!: () => void;
    const reportGate = new Promise<void>((resolve) => {
      releaseReport = resolve;
    });
    const progress = createRoundRegenerationProgressQueue({
      onDiagnostic: () => {
        throw new Error("console sink failed");
      },
      onReport: async () => {
        order.push("report-started");
        await reportGate;
        order.push("report-recorded");
      },
      onLens: () => order.push("lens-started"),
    });

    await expect(
      progress.emit({
        type: "report-diagnostic",
        milestone: { stage: "schema-parsed", elapsedMs: 7 },
      }),
    ).resolves.toBeUndefined();
    const report = progress.emit({ type: "report", reportBoardId: "report-board" });
    const lens = progress.emit({ type: "lens", lanes: [] });
    await vi.waitFor(() => expect(order).toEqual(["report-started"]));

    releaseReport();
    await expect(report).resolves.toBeUndefined();
    await expect(lens).resolves.toBeUndefined();
    await expect(progress.settle()).resolves.toBeUndefined();
    expect(order).toEqual(["report-started", "report-recorded", "lens-started"]);
  });
});

function provenGlab(
  path = "/usr/bin/glab",
  platform: NodeJS.Platform = process.platform,
): ForgeDetectionDeps {
  const directory = path.slice(0, path.lastIndexOf("/"));
  return {
    loginShellPath: async () => directory,
    envPath: directory,
    home: "/Users/rai",
    listDir: async (candidate) => (candidate === directory ? ["glab"] : []),
    isExecutable: async (candidate) => candidate === path,
    probeVersion: async (candidate) => (candidate === path ? "1.80.0" : null),
    probeAuth: async () => ({ kind: "authenticated" }),
    platform,
  };
}

describe("selected-branch patchset recapture", () => {
  it("captures the persisted landing range after both branch refs move", async () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), "rennet-branch-recapture-")));
    const runGit = (...args: string[]): string =>
      execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
    const git: GitExec = async (root, arguments_) =>
      execFileSync("git", arguments_, { cwd: root, encoding: "utf8" });

    try {
      runGit("init", "-b", "main");
      runGit("config", "user.email", "rennet@example.test");
      runGit("config", "user.name", "Rennet Test");
      writeFileSync(join(repo, "base.ts"), "export const base = true;\n");
      runGit("add", "base.ts");
      runGit("commit", "-m", "base");

      runGit("checkout", "-b", "feature/shared");
      writeFileSync(join(repo, "source.ts"), "export const source = true;\n");
      runGit("add", "source.ts");
      runGit("commit", "-m", "review source");
      const sourcePatchset = await captureBranchPatchset({
        git,
        locus: { kind: "host" },
        repoPath: repo,
        head: "feature/shared",
        base: "main",
        resolveProjectSnapshotId: async () => "snapshot-source",
      });

      writeFileSync(join(repo, "worker.ts"), "export const worker = true;\n");
      runGit("add", "worker.ts");
      runGit("commit", "-m", "landed worker result");
      const landedHead = runGit("rev-parse", "HEAD");

      runGit("checkout", "main");
      writeFileSync(join(repo, "base-after.ts"), "export const movedBase = true;\n");
      runGit("add", "base-after.ts");
      runGit("commit", "-m", "move base after landing");
      const movedBase = runGit("rev-parse", "HEAD");
      runGit("checkout", "feature/shared");
      runGit("merge", "--no-edit", "main");
      writeFileSync(join(repo, "head-after.ts"), "export const movedHead = true;\n");
      runGit("add", "head-after.ts");
      runGit("commit", "-m", "move head after landing");
      const movedHead = runGit("rev-parse", "HEAD");

      const liveRefCapture = await captureBranchPatchset({
        git,
        locus: { kind: "host" },
        repoPath: repo,
        head: "feature/shared",
        base: "main",
        resolveProjectSnapshotId: async () => "snapshot-live",
      });
      expect(liveRefCapture.repository.baseOid).toBe(movedBase);
      expect(liveRefCapture.repository.headOid).toBe(movedHead);
      expect(liveRefCapture.repository.baseOid).not.toBe(sourcePatchset.repository.baseOid);
      expect(liveRefCapture.repository.headOid).not.toBe(landedHead);

      const resolveProjectSnapshotId = vi.fn(async () => "snapshot-persisted");
      const recaptured = await captureLandedBranchPatchset({
        git,
        locus: { kind: "host" },
        repoPath: repo,
        headRef: "feature/shared",
        baseRef: "main",
        headOid: landedHead,
        baseOid: sourcePatchset.repository.baseOid,
        resolveProjectSnapshotId,
      });

      expect(recaptured.repository).toMatchObject({
        baseRef: "main",
        baseOid: sourcePatchset.repository.baseOid,
        headRef: "feature/shared",
        headOid: landedHead,
      });
      expect(recaptured.files.map((file) => file.path)).toEqual(["source.ts", "worker.ts"]);
      expect(recaptured.rawDiff).toContain("export const source = true;");
      expect(recaptured.rawDiff).toContain("export const worker = true;");
      expect(recaptured.rawDiff).not.toContain("movedBase");
      expect(recaptured.rawDiff).not.toContain("movedHead");
      expect(resolveProjectSnapshotId).toHaveBeenCalledWith(
        repo,
        sourcePatchset.repository.baseOid,
      );
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("the round runs in the session's bound root", () => {
  const operation = (): RoundOperation => ({
    operationId: "operation-1",
    sessionId: "session-1",
    reviewId: "review-1",
    dispatchId: "dispatch-1",
    sourcePatchsetId: "patchset-1",
    askOccurrences: [{ id: "ask-1", revision: 1 }],
    roundNumber: 1,
    sourceTarget: { kind: "branch", branch: "feat/test" },
    repoRoot: "/repo",
    workOrderPrompt: "apply the round",
    workOrderDigest: sha256Hex("apply the round"),
    revision: 0,
    rerunRequested: false,
    createdAt: 1,
    updatedAt: 1,
    state: { phase: "claimed" },
  });

  it("plans the first bound root that is ON the round's branch, creating nothing", async () => {
    // `/drafting` is the shape that made this necessary: a checkout DETACHED at the
    // reviewed head. Its head looks right and its branch is absent, so a planner that
    // took the first recorded root would commit the round somewhere the reviewer's branch
    // never moves — silently, with the review advancing anyway.
    const heads: Record<string, string> = { "/drafting": "bound-head", "/bound": "bound-head" };
    const branches: Record<string, string | undefined> = {
      "/drafting": undefined,
      "/bound": "feat/test",
    };
    const workspace = await createRoundWorkspacePlanner({
      candidateRoots: () => ["/drafting", "/bound"],
      reviewedHead: () => "reviewed-oid",
      headOf: async (root) => heads[root],
      branchOf: async (root) => branches[root],
      repositoryOf: async () => "/repo/.git",
      containsCommit: async () => true,
      now: () => 2,
    })(operation());

    expect(workspace).toEqual({
      kind: "bound-root",
      root: "/bound",
      sourceHead: "bound-head",
      preparedAt: 2,
    });
  });

  // A branch NAME is not a repository identity. Two repos in one workspace both carry
  // `feat/test`, and a name-only match takes whichever the candidate order yielded — the
  // wrong repo's tree under the right round's label, silently. `--git-common-dir` is the
  // contradiction that separates them: one value per repository, shared by every linked
  // worktree of it.
  it("refuses a same-named branch belonging to another repository", async () => {
    const repositories: Record<string, string> = {
      "/repo": "/repo/.git",
      "/other-repo": "/other-repo/.git",
      "/bound": "/repo/.git",
    };
    const workspace = await createRoundWorkspacePlanner({
      candidateRoots: () => ["/other-repo", "/bound"],
      reviewedHead: () => "reviewed-oid",
      headOf: async () => "bound-head",
      branchOf: async () => "feat/test",
      repositoryOf: async (root) => repositories[root],
      containsCommit: async () => true,
      now: () => 2,
    })(operation());
    expect(workspace.root).toBe("/bound");
  });

  // Amending, rebasing and resetting a branch are deliberate acts, and after a rebase the
  // reviewed commit is unreachable — a refusal telling the reviewer to "check it out
  // there" would be an instruction nobody can follow. So the round RUNS and the receipt
  // carries the fact; the successor patchset is a fresh capture from this head anyway.
  it("runs on a branch rewritten past the reviewed head, and records that", async () => {
    const workspace = await createRoundWorkspacePlanner({
      candidateRoots: () => ["/bound"],
      reviewedHead: () => "reviewed-oid",
      headOf: async () => "rebased-head",
      branchOf: async () => "feat/test",
      repositoryOf: async () => "/repo/.git",
      containsCommit: async () => false,
      now: () => 2,
    })(operation());
    expect(workspace).toEqual({
      kind: "bound-root",
      root: "/bound",
      sourceHead: "rebased-head",
      preparedAt: 2,
      branchRewritten: true,
    });
    // Control: the ordinary branch says nothing, so the flag is not a constant.
    const ordinary = await createRoundWorkspacePlanner({
      candidateRoots: () => ["/bound"],
      reviewedHead: () => "reviewed-oid",
      headOf: async () => "bound-head",
      branchOf: async () => "feat/test",
      repositoryOf: async () => "/repo/.git",
      containsCommit: async () => true,
      now: () => 2,
    })(operation());
    expect(ordinary).not.toHaveProperty("branchRewritten");
  });

  it("fails naming the branch and the roots it looked in", async () => {
    await expect(
      createRoundWorkspacePlanner({
        candidateRoots: () => ["/drafting", "/bound"],
        reviewedHead: () => "reviewed-oid",
        headOf: async () => "bound-head",
        // Nothing is on the branch at all.
        branchOf: async () => "some/other-branch",
        repositoryOf: async () => "/repo/.git",
        containsCommit: async () => true,
        now: () => 2,
      })(operation()),
    ).rejects.toThrow(/feat\/test.*\/drafting, \/bound/);
  });

  it("runs the worker turn in the bound root and keeps the turn's checkpoint as the receipt", async () => {
    const workspace = {
      kind: "bound-root" as const,
      root: "/bound",
      sourceHead: "bound-head",
      preparedAt: 3,
    };
    const workerAttempt = { executionId: "worker-1", startedAt: 3 };
    const runRoundTurn = vi.fn(async () => ({
      status: "completed" as const,
      finalText: "done",
      turnDiff: "diff --git a/x b/x\n",
      filesTouched: ["x"],
      checkpoint: { threadId: "thread-1", turnId: "turn-7", turnCount: 4 },
    }));

    const receipt = await createRoundWorkerPort({ runRoundTurn, now: () => 4 })({
      operation: {
        ...operation(),
        state: { phase: "worker-running", workspace, worker: workerAttempt },
      },
      attempt: workerAttempt,
    });

    // The turn is sent to the ROUND's OWN thread, in the bound root: session id plus
    // operation id, titled for the branch and the ordinal. `reviewId` still rides along
    // (the T3 project is the review's repository), but it is not the thread's key any
    // more — the session's chat thread is the reviewer's conversation, not this.
    expect(runRoundTurn).toHaveBeenCalledWith({
      repoRoot: "/bound",
      prompt: "apply the round",
      reviewId: "review-1",
      worktreePath: "/bound",
      sessionId: "session-1",
      operationId: "operation-1",
      title: "feat/test — round 1",
      branch: "feat/test",
    });
    expect(receipt.outcome).toBe("completed");
    expect(receipt.checkpoint).toEqual({ threadId: "thread-1", turnId: "turn-7", turnCount: 4 });
  });

  // Issue #811: a T3 checkpoint diffs the WORKING TREE, and a worker that obeyed the work
  // order and committed leaves that tree clean — so the checkpoint reported "0 files
  // changed" over a branch that had moved by two files and thirty lines.
  describe("the worker receipt after a commit", () => {
    const committed = {
      diff: "diff --git a/a.ts b/a.ts\n+committed\n",
      changedPaths: ["a.ts"],
    };

    it("takes its files from the commit range when the checkpoint's tree is clean", async () => {
      const reconciled = await reconcileRoundReceiptWithCommits(
        { outcome: "completed" as const, diff: "", changedPaths: [] as readonly string[] },
        { sourceHead: "head-before", committedDiff: async () => committed },
      );
      expect(reconciled).toEqual({ outcome: "completed", ...committed });
    });

    it("leaves an editing-but-not-committing turn's own evidence alone", async () => {
      // The range is empty because nothing was committed. The receipt keeps the working-tree
      // diff, which is what the coordinator's agreement check turns into a failed round with
      // "the turn changed 1 file but left no commit".
      const dirty = { diff: "diff --git a/a.ts b/a.ts\n+edited\n", changedPaths: ["a.ts"] };
      const committedDiff = vi.fn(async () => undefined);
      expect(
        await reconcileRoundReceiptWithCommits({ ...dirty }, { sourceHead: "h", committedDiff }),
      ).toEqual(dirty);
      // Not even consulted: a receipt that already has evidence is never second-guessed.
      expect(committedDiff).not.toHaveBeenCalled();
    });

    it("stays empty when the turn committed nothing and changed nothing", async () => {
      expect(
        await reconcileRoundReceiptWithCommits(
          { diff: "", changedPaths: [] as readonly string[] },
          { sourceHead: "h", committedDiff: async () => undefined },
        ),
      ).toEqual({ diff: "", changedPaths: [] });
    });
  });

  it("settles a restart from the turn's checkpoint, and fails naming the bound root without one", async () => {
    const workspace = {
      kind: "bound-root" as const,
      root: "/bound",
      sourceHead: "bound-head",
      preparedAt: 3,
    };
    const workerAttempt = { executionId: "worker-1", startedAt: 900 };
    const running: RoundOperation = {
      ...operation(),
      state: { phase: "worker-running", workspace, worker: workerAttempt },
    };

    const readCheckpoint = vi.fn(async () => ({
      checkpoint: { threadId: "thread-1", turnId: "turn-7", turnCount: 4 },
      status: "ready" as const,
      diff: "diff --git a/x b/x\n",
      filesTouched: ["x"],
    }));
    const settled = await createRoundWorkerRecoveryPort({ readCheckpoint, now: () => 1000 })({
      operation: running,
      attempt: workerAttempt,
    });
    // The read is scoped to the ROUND's own thread and to this attempt's start. The
    // prompt-text matching that used to be needed is gone with the thread sharing: the
    // only turns on this thread are this round's own attempts, and `since` separates a
    // retry from the attempt before it.
    expect(readCheckpoint).toHaveBeenCalledWith({
      repoRoot: "/bound",
      worktreePath: "/bound",
      since: 900,
      sessionId: "session-1",
      operationId: "operation-1",
      title: "feat/test — round 1",
      branch: "feat/test",
    });
    expect(settled.outcome).toBe("completed");
    expect(settled.changedPaths).toEqual(["x"]);
    expect(settled.checkpoint).toEqual({ threadId: "thread-1", turnId: "turn-7", turnCount: 4 });

    // A checkpoint T3 stamped "error" is a FAILED turn that happens to have left one.
    // Settling it as completed would take the round on to its gate and its successor
    // capture on work the agent itself reported as unfinished.
    const errored = await createRoundWorkerRecoveryPort({
      readCheckpoint: async () => ({
        checkpoint: { threadId: "thread-1", turnId: "turn-7", turnCount: 4 },
        status: "error" as const,
        diff: "diff --git a/x b/x\n",
        filesTouched: ["x"],
      }),
      now: () => 1000,
    })({ operation: running, attempt: workerAttempt });
    expect(errored.outcome).toBe("failed");
    // …and it keeps the partial diff, because those edits are real and on the branch.
    expect(errored.changedPaths).toEqual(["x"]);
    expect(
      errored.outcome === "failed" && errored.termination.kind === "error"
        ? errored.termination.reason
        : "",
    ).toContain("failed");

    const failed = await createRoundWorkerRecoveryPort({
      readCheckpoint: async () => undefined,
      now: () => 1000,
    })({ operation: running, attempt: workerAttempt });
    expect(failed.outcome).toBe("failed");
    // The reason names the BOUND ROOT — the reviewer's own checkout, where any partial
    // edits actually are — not a detached worktree they never see.
    expect(
      failed.outcome === "failed" && failed.termination.kind === "error"
        ? failed.termination.reason
        : "",
    ).toContain("/bound");
  });
});

// Pins design D4 (no module-level singletons — two servers in one process do not
// share mutable state) and D5 (shutdown is idempotent). The handle is {dispatch,
// shutdown}; the observable per-instance state we can reach without Electron is the
// dataDir-scoped store, so distinct dataDirs must yield distinct SQLite files.
describe("createRennetServer — instance isolation + shutdown (#377)", () => {
  const dirs: string[] = [];
  const make = () => {
    const dataDir = mkdtempSync(join(tmpdir(), "rennet-server-"));
    dirs.push(dataDir);
    return createRennetServer({ dataDir, env: {} });
  };
  // `createRennetServer` is async (#378: it resolves after the WS listener is
  // listening), so every construction below awaits the handle.
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("two instances own separate dataDir-scoped stores", async () => {
    const a = await make();
    const b = await make();
    // A shared module-level store would have opened ONE sqlite; each instance opening
    // its own file under its own dataDir is the visible proof the store is instance state.
    expect(existsSync(join(dirs[0] ?? "", "rennet.sqlite"))).toBe(true);
    expect(existsSync(join(dirs[1] ?? "", "rennet.sqlite"))).toBe(true);
    expect(a.dispatch).not.toBe(b.dispatch);
    expect(a.shutdown).not.toBe(b.shutdown);
    a.shutdown();
    b.shutdown();
  });

  it("shutdown is idempotent and instance-scoped", async () => {
    const a = await make();
    const b = await make();
    // Second shutdown of the same instance is a no-op (D5), and shutting a down never
    // reaches into b — each closes only its own watcher, rehydration, and store.
    expect(() => {
      a.shutdown();
      a.shutdown();
    }).not.toThrow();
    expect(() => b.shutdown()).not.toThrow();
  });
});

describe("session.mint — provider-qualified PR dispatch", () => {
  const dirs: string[] = [];
  const shutdowns: (() => void)[] = [];

  afterEach(() => {
    for (const shutdown of shutdowns.splice(0)) shutdown();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("returns the durable session before a held capture and cancels it in place", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "rennet-immediate-mint-state-"));
    const repo = mkdtempSync(join(tmpdir(), "rennet-immediate-mint-repo-"));
    dirs.push(dataDir, repo);
    execFileSync("git", ["init", "-b", "main"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "t"], { cwd: repo });
    writeFileSync(join(repo, "a.txt"), "one\n");
    execFileSync("git", ["add", "a.txt"], { cwd: repo });
    execFileSync("git", ["commit", "-m", "base"], { cwd: repo });
    writeFileSync(join(repo, "a.txt"), "one\ntwo\n");

    const server = await createRennetServer({
      dataDir,
      env: { RENNET_TEST_CAPTURE_PREPARATION_DELAY_MS: "30000" },
    });
    shutdowns.push(server.shutdown);
    const added = (await server.dispatch("projects.add", {
      commandId: randomUUID(),
      discovery: {
        path: repo,
        kind: "repo",
        repos: [{ name: "repo", path: repo, branches: 1 }],
        primaryBranch: "main",
      },
      includedRepos: ["repo"],
      primaryBranch: "main",
    })) as { project: { id: string } };

    const minted = (await server.dispatch("session.mint", {
      projectId: added.project.id,
      commandId: randomUUID(),
    })) as { session: PreparationSession | null };
    expect(minted.session?.preparation).toEqual({
      status: "capturing",
      step: "resolving-repository",
    });

    const cancelled = (await server.dispatch("session.cancelPreparation", {
      sessionId: minted.session?.id ?? "",
    })) as { session: PreparationSession | null };
    expect(cancelled.session?.preparation?.status).toBe("cancelled");
    expect(cancelled.session?.reviewId).toBeUndefined();

    const retried = (await server.dispatch("session.retryPreparation", {
      sessionId: minted.session?.id ?? "",
      commandId: randomUUID(),
    })) as { session: PreparationSession | null };
    expect(retried.session?.preparation).toEqual({
      status: "capturing",
      step: "resolving-repository",
    });
    await server.dispatch("session.cancelPreparation", {
      sessionId: minted.session?.id ?? "",
    });
  });

  it("reuses a capture that settles during cancellation before retrying boards", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "rennet-cancelled-capture-state-"));
    const repo = mkdtempSync(join(tmpdir(), "rennet-cancelled-capture-repo-"));
    dirs.push(dataDir, repo);
    execFileSync("git", ["init", "-b", "main"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "t"], { cwd: repo });
    writeFileSync(join(repo, "a.txt"), "one\n");
    execFileSync("git", ["add", "a.txt"], { cwd: repo });
    execFileSync("git", ["commit", "-m", "base"], { cwd: repo });
    writeFileSync(join(repo, "a.txt"), "one\ntwo\n");

    const server = await createRennetServer({
      dataDir,
      env: { RENNET_TEST_CAPTURE_SETTLEMENT_DELAY_MS: "30000" },
    });
    shutdowns.push(server.shutdown);
    const added = (await server.dispatch("projects.add", {
      commandId: randomUUID(),
      discovery: {
        path: repo,
        kind: "repo",
        repos: [{ name: "repo", path: repo, branches: 1 }],
        primaryBranch: "main",
      },
      includedRepos: ["repo"],
      primaryBranch: "main",
    })) as { project: { id: string } };
    const minted = (await server.dispatch("session.mint", {
      projectId: added.project.id,
      commandId: randomUUID(),
    })) as { session: PreparationSession | null };

    let capturedReviewId: string | undefined;
    await vi.waitFor(
      () => {
        const reader = new SqliteReviewStore(join(dataDir, "rennet.sqlite"));
        try {
          capturedReviewId = reader.latestReview()?.id;
        } finally {
          reader.close();
        }
        expect(capturedReviewId).toBeDefined();
      },
      { timeout: 15_000, interval: 20 },
    );
    await server.dispatch("session.cancelPreparation", {
      sessionId: minted.session?.id ?? "",
    });
    const retried = (await server.dispatch("session.retryPreparation", {
      sessionId: minted.session?.id ?? "",
      commandId: randomUUID(),
    })) as { session: PreparationSession | null };

    expect(retried.session?.reviewId).toBe(capturedReviewId);
    expect(retried.session?.preparation?.status).toBe("drafting");
    const reader = new SqliteReviewStore(join(dataDir, "rennet.sqlite"));
    try {
      expect(reader.latestReview()?.id).toBe(capturedReviewId);
    } finally {
      reader.close();
    }
    await server.dispatch("session.cancelPreparation", {
      sessionId: minted.session?.id ?? "",
    });
  }, 30_000);

  it("turns an interrupted preparation into a retryable failure after restart", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "rennet-preparation-restart-state-"));
    const repo = mkdtempSync(join(tmpdir(), "rennet-preparation-restart-repo-"));
    dirs.push(dataDir, repo);
    execFileSync("git", ["init", "-b", "main"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "t"], { cwd: repo });
    writeFileSync(join(repo, "a.txt"), "one\n");
    execFileSync("git", ["add", "a.txt"], { cwd: repo });
    execFileSync("git", ["commit", "-m", "base"], { cwd: repo });
    writeFileSync(join(repo, "a.txt"), "one\ntwo\n");

    const first = await createRennetServer({
      dataDir,
      env: { RENNET_TEST_CAPTURE_PREPARATION_DELAY_MS: "30000" },
    });
    shutdowns.push(first.shutdown);
    const added = (await first.dispatch("projects.add", {
      commandId: randomUUID(),
      discovery: {
        path: repo,
        kind: "repo",
        repos: [{ name: "repo", path: repo, branches: 1 }],
        primaryBranch: "main",
      },
      includedRepos: ["repo"],
      primaryBranch: "main",
    })) as { project: { id: string } };
    const minted = (await first.dispatch("session.mint", {
      projectId: added.project.id,
      commandId: randomUUID(),
    })) as { session: PreparationSession | null };
    expect(minted.session?.preparation?.status).toBe("capturing");
    first.shutdown();

    const restarted = await createRennetServer({
      dataDir,
      env: { RENNET_TEST_CAPTURE_PREPARATION_DELAY_MS: "30000" },
    });
    shutdowns.push(restarted.shutdown);
    const listed = (await restarted.dispatch("session.list", {})) as {
      sessions: PreparationSession[];
    };
    const recovered = listed.sessions.find((session) => session.id === minted.session?.id);
    expect(recovered?.preparation).toEqual({
      status: "failed",
      stage: "capture",
      reason: "Rennet restarted before preparation finished. Retry to continue.",
    });

    const retried = (await restarted.dispatch("session.retryPreparation", {
      sessionId: minted.session?.id ?? "",
      commandId: randomUUID(),
    })) as { session: PreparationSession | null };
    expect(retried.session?.preparation?.status).toBe("capturing");
    await restarted.dispatch("session.cancelPreparation", {
      sessionId: minted.session?.id ?? "",
    });
  });

  it("BINDS on a read when nothing bound at capture, instead of answering the clone", async () => {
    // The "next use retries" claim, executed. Two states reach this code path: a session
    // minted before the binding existed, and one whose first bind threw. Both have no
    // `boundRoot`, and the read paths used to fall back to the clone — which for a review of
    // a branch the clone is not on is the WRONG TREE, written into a thread's cwd where it is
    // fixed for the thread's life. Here the recorded binding is removed to reproduce that
    // state exactly, and a pure read command has to put it back.
    const dataDir = mkdtempSync(join(tmpdir(), "rennet-lazy-bind-data-"));
    const repo = realpathSync(mkdtempSync(join(tmpdir(), "rennet-lazy-bind-repo-")));
    dirs.push(dataDir, repo);
    const runGit = (...args: string[]): string =>
      execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
    runGit("init", "-b", "main");
    runGit("config", "user.email", "t@t");
    runGit("config", "user.name", "t");
    writeFileSync(join(repo, "a.txt"), "base\n");
    runGit("add", "a.txt");
    runGit("commit", "-m", "base");
    runGit("checkout", "-b", "feature/lazy");
    writeFileSync(join(repo, "a.txt"), "base\nfeature\n");
    runGit("add", "a.txt");
    runGit("commit", "-m", "feature");
    // The clone is left on `main`, so the review's branch is checked out NOWHERE and the
    // session must bind to a worktree Rennet creates — a different path from the clone, which
    // is what makes the fallback visible at all.
    runGit("checkout", "main");

    const server = await createRennetServer({ dataDir, env: {} });
    shutdowns.push(server.shutdown);
    const added = (await server.dispatch("projects.add", {
      commandId: randomUUID(),
      discovery: {
        path: repo,
        kind: "repo",
        repos: [{ name: "repo", path: repo, branches: 2 }],
        primaryBranch: "main",
      },
      includedRepos: ["repo"],
      primaryBranch: "main",
    })) as { project: { id: string } };
    const minted = (await server.dispatch("session.mint", {
      projectId: added.project.id,
      commandId: randomUUID(),
      branch: "feature/lazy",
    })) as { session: PreparationSession | null };
    const sessionId = minted.session?.id ?? "";
    const prepared = await waitForReviewSession(server, sessionId);

    const store = new SessionStore(join(dataDir, "sessions"));
    // `waitForReviewSession` returns as soon as the review is attached, which the capture does
    // just BEFORE it binds, so the binding is awaited here on its own.
    await vi.waitFor(() => expect(store.load(sessionId)?.boundRoot).toBeDefined(), {
      timeout: 15_000,
      interval: 20,
    });
    const bound = store.load(sessionId)?.boundRoot;
    expect(bound).not.toBe(repo);

    // Reproduce the unbound state a pre-wave record — or a bind that threw — leaves behind.
    const unbound = store.load(sessionId);
    if (unbound === undefined) throw new Error("the minted session was not persisted");
    const withoutBinding = { ...unbound };
    delete (withoutBinding as { boundRoot?: string }).boundRoot;
    store.save(withoutBinding);
    expect(store.load(sessionId)?.boundRoot).toBeUndefined();

    // A pure READ — no harness, no sidecar — and it has to bind rather than answer the clone.
    const transcript = (await server.dispatch("session.transcript", {
      reviewId: prepared.reviewId ?? "",
    })) as { trail: { workspace?: string } };
    // Byte-identical to the capture's answer, not merely the same directory: a re-bind finds
    // the worktree through git, which prints a realpath, and a differently-spelled `boundRoot`
    // retires the session's threads and re-keys the new ones on the alternate name.
    expect(transcript.trail.workspace).toBe(bound);
    expect(transcript.trail.workspace).not.toBe(repo);
    // ...and it RECORDED it, so the next read is a plain field read rather than a re-bind.
    expect(store.load(sessionId)?.boundRoot).toBe(bound);
  }, 30_000);

  it("keeps legacy repository + PR targets on the GitHub opener", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "rennet-legacy-pr-dispatch-"));
    const workspace = mkdtempSync(join(tmpdir(), "rennet-legacy-pr-workspace-"));
    const repo = mkdtempSync(join(workspace, "github-"));
    const gitlabRepo = mkdtempSync(join(workspace, "gitlab-"));
    dirs.push(dataDir, workspace);

    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
    git("init", "-b", "main");
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "widget.txt"), "base\n");
    git("add", "widget.txt");
    git("commit", "-m", "base");
    const baseOid = git("rev-parse", "HEAD");
    git("checkout", "-b", "feature");
    writeFileSync(join(repo, "widget.txt"), "base\nfeature\n");
    git("add", "widget.txt");
    git("commit", "-m", "feature");
    const headOid = git("rev-parse", "HEAD");
    git("remote", "add", "origin", "git@github.com:acme/widget.git");
    execFileSync("git", ["init", "-b", "main"], { cwd: gitlabRepo });
    execFileSync("git", ["remote", "add", "origin", "git@gitlab.com:acme/widget.git"], {
      cwd: gitlabRepo,
    });

    await createGitHubTokenStore(dataDir).setGitHubCredential({ token: "gho_legacy_target" });
    const httpFetch = vi.fn<typeof globalThis.fetch>((input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      const path = new URL(url).pathname;
      if (path === "/rate_limit") {
        return Promise.resolve(
          new Response(JSON.stringify({ resources: {} }), {
            status: 200,
            headers: {
              "content-type": "application/json",
              "X-OAuth-Scopes": "repo, workflow",
              "X-RateLimit-Limit": "5000",
            },
          }),
        );
      }
      if (path === "/user") {
        return Promise.resolve(
          new Response(JSON.stringify({ login: "rai" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );
      }
      if (path === "/graphql") {
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          variables?: { owner?: string; name?: string; number?: number };
        };
        expect(body.variables).toEqual({ owner: "acme", name: "widget", number: 7 });
        return Promise.resolve(
          new Response(
            JSON.stringify({
              data: {
                repository: {
                  pullRequest: {
                    number: 7,
                    title: "Legacy target",
                    body: "",
                    isDraft: false,
                    headRefOid: headOid,
                    baseRefOid: baseOid,
                    baseRefName: "main",
                    headRefName: "feature",
                    changedFiles: 1,
                    id: "PR_legacy_7",
                    viewerDidAuthor: true,
                  },
                },
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        );
      }
      return Promise.resolve(new Response("not found", { status: 404 }));
    });
    const server = await createRennetServer({ dataDir, env: {}, httpFetch });
    shutdowns.push(server.shutdown);
    const added = (await server.dispatch("projects.add", {
      commandId: randomUUID(),
      discovery: {
        path: workspace,
        kind: "workspace",
        repos: [
          { name: "gitlab", path: gitlabRepo, branches: 1 },
          { name: "github", path: repo, branches: 2 },
        ],
        primaryBranch: "main",
      },
      includedRepos: ["gitlab", "github"],
      primaryBranch: "main",
    })) as { project: { id: string } };

    const minted = (await server.dispatch("session.mint", {
      projectId: added.project.id,
      commandId: randomUUID(),
      branch: "feature",
      prNumber: 7,
      repository: "acme/widget.git",
    })) as {
      session: {
        id: string;
        repository?: string;
        forgeRepository?: { forge: string; owner: string; name: string };
        reviewId?: string;
      } | null;
    };

    expect(minted.session?.repository).toBe("acme/widget");
    expect(minted.session?.forgeRepository).toEqual({
      forge: "github",
      owner: "acme",
      name: "widget",
    });
    const prepared = await waitForReviewSession(server, minted.session?.id ?? "");
    expect(prepared.reviewId).toBeDefined();
    expect(httpFetch.mock.calls.some(([input]) => String(input).includes("/graphql"))).toBe(true);
    const listed = (await server.dispatch("session.list", {})) as { sessions: unknown[] };
    expect(listed.sessions).toHaveLength(1);
  });

  it("routes a same-coordinate GitLab MR without touching GitHub and reports missing glab", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "rennet-forge-dispatch-"));
    const workspace = mkdtempSync(join(tmpdir(), "rennet-forge-workspace-"));
    const githubRepo = mkdtempSync(join(workspace, "github-"));
    const gitlabRepo = mkdtempSync(join(workspace, "gitlab-"));
    dirs.push(dataDir, workspace);

    for (const [repo, remote] of [
      [githubRepo, "git@github.com:acme/widget.git"],
      [gitlabRepo, "git@gitlab.com:acme/widget.git"],
    ] as const) {
      execFileSync("git", ["init", "-b", "main"], { cwd: repo });
      execFileSync("git", ["remote", "add", "origin", remote], { cwd: repo });
    }

    const httpFetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.reject(new Error("GitHub transport must not be reached")),
    );
    const server = await createRennetServer({ dataDir, env: {}, httpFetch });
    shutdowns.push(server.shutdown);
    const added = (await server.dispatch("projects.add", {
      commandId: randomUUID(),
      discovery: {
        path: workspace,
        kind: "workspace",
        repos: [
          { name: "github", path: githubRepo, branches: 1 },
          { name: "gitlab", path: gitlabRepo, branches: 1 },
        ],
        primaryBranch: "main",
      },
      includedRepos: ["github", "gitlab"],
      primaryBranch: "main",
    })) as { project: { id: string } };

    const minted = (await server.dispatch("session.mint", {
      projectId: added.project.id,
      commandId: randomUUID(),
      branch: "main",
      prNumber: 7,
      repository: "acme/widget",
      forgeRepository: { forge: "gitlab", owner: "acme", name: "widget" },
    })) as { session: PreparationSession | null };
    expect(minted.session?.preparation?.status).toBe("capturing");
    let failed: PreparationSession | undefined;
    await vi.waitFor(
      async () => {
        const listed = (await server.dispatch("session.list", {})) as {
          sessions: PreparationSession[];
        };
        failed = listed.sessions.find((session) => session.id === minted.session?.id);
        expect(failed?.preparation?.status).toBe("failed");
      },
      { timeout: 4_000, interval: 20 },
    );
    const failedPreparation = failed?.preparation;
    if (failedPreparation?.status !== "failed") throw new Error("capture did not fail");
    expect(failedPreparation.reason).toContain("GitLab CLI is unavailable. Install `glab`");
    expect(httpFetch).not.toHaveBeenCalled();

    const listed = (await server.dispatch("session.list", {})) as { sessions: unknown[] };
    expect(listed.sessions).toHaveLength(1);
  });
});

describe("createRennetServer — GitLab submission composition", () => {
  const dirs: string[] = [];
  const shutdowns: (() => void)[] = [];

  afterEach(() => {
    for (const shutdown of shutdowns.splice(0)) shutdown();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("carries a WSL repository through the production GitLab resolver", async () => {
    const repositoryRoot = "\\\\wsl.localhost\\Ubuntu\\home\\rai\\widget";
    const commands: GitLabPrSubmissionCommand[] = [];
    const detectionDepsForLocus = vi.fn(async () => provenGlab("/usr/bin/glab", "linux"));
    const resolver = createGitLabPrSubmissionResolver({
      locusForRepo: () => ({ kind: "wsl", distro: "Ubuntu" }),
      detectionDepsForLocus,
      run: async (command) => {
        commands.push(command);
        return {
          exitCode: 0,
          stdout: `${JSON.stringify({
            iid: 42,
            web_url: "https://gitlab.com/acme/widget/-/merge_requests/42",
            state: "opened",
            source_branch: "feat/reviewed",
            target_branch: "main",
            source_project_id: 101,
            target_project_id: 101,
          })}\n`,
        };
      },
    });

    const submitter = await resolver(repositoryRoot);
    await expect(
      submitter.submitPullRequest({
        target: { repo: { forge: "gitlab", owner: "acme", name: "widget" } },
        submission: {
          title: "Reviewed change",
          body: "",
          base: "main",
          head: "feat/reviewed",
          draft: true,
        },
      }),
    ).resolves.toMatchObject({ number: 42, reused: true });

    expect(detectionDepsForLocus).toHaveBeenCalledWith({ kind: "wsl", distro: "Ubuntu" });
    expect(commands).toHaveLength(1);
    expect(commands[0]?.file).toBe("wsl.exe");
    expect(commands[0]?.args.slice(0, 7)).toEqual([
      "-d",
      "Ubuntu",
      "--cd",
      "/home/rai/widget",
      "-e",
      "/usr/bin/glab",
      "api",
    ]);
  });

  it("opens a GitLab merge request through the real registry and dispatch closure", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "rennet-gitlab-submit-data-"));
    const repo = realpathSync(mkdtempSync(join(tmpdir(), "rennet-gitlab-submit-repo-")));
    dirs.push(dataDir, repo);
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
    git("init", "-b", "main");
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "widget.txt"), "base\n");
    git("add", "widget.txt");
    git("commit", "-m", "base");
    git("checkout", "-b", "feat/reviewed");
    writeFileSync(join(repo, "widget.txt"), "base\nfeature\n");
    git("add", "widget.txt");
    git("commit", "-m", "feature");
    git("remote", "add", "origin", "git@gitlab.com:acme/widget.git");

    const submissionGit = vi.fn<GitExec>(async (root, arguments_) => {
      expect(root).toBe(repo);
      if (arguments_[0] === "remote") {
        return [
          "origin\tgit@gitlab.com:acme/widget.git (fetch)",
          "origin\tgit@gitlab.com:acme/widget.git (push)",
        ].join("\n");
      }
      if (arguments_[0] === "push") return "";
      throw new Error(`Unexpected forge-submission git call: ${arguments_.join(" ")}`);
    });
    const forgeSubmissionGitForLocus = vi.fn(() => submissionGit);
    const detectionDepsForLocus = vi.fn(async () => provenGlab());
    const commands: GitLabPrSubmissionCommand[] = [];
    let queryCount = 0;

    const server = await createRennetServer({
      dataDir,
      env: { RENNET_DISABLE_HARNESS: "1" },
      forgeSubmissionGitForLocus,
      gitLabPrSubmissionEffects: {
        detectionDepsForLocus,
        run: async (command) => {
          commands.push(command);
          if (command.args.includes("--paginate")) {
            queryCount += 1;
            return {
              exitCode: 0,
              stdout:
                queryCount === 1
                  ? ""
                  : `${JSON.stringify({
                      iid: 17,
                      web_url: "https://gitlab.com/acme/widget/-/merge_requests/17",
                      state: "opened",
                      source_branch: "feat/reviewed",
                      target_branch: "main",
                      source_project_id: 101,
                      target_project_id: 101,
                    })}\n`,
            };
          }
          if (command.args.includes("--method")) return { exitCode: 0, stdout: "{}" };
          throw new Error(`Unexpected glab command: ${command.args.join(" ")}`);
        },
      },
    });
    shutdowns.push(server.shutdown);

    const added = (await server.dispatch("projects.add", {
      commandId: randomUUID(),
      discovery: {
        path: repo,
        kind: "repo",
        repos: [{ name: "widget", path: repo, branches: 2 }],
        primaryBranch: "main",
      },
      includedRepos: ["widget"],
      primaryBranch: "main",
    })) as { project: { id: string } };
    const minted = (await server.dispatch("session.mint", {
      projectId: added.project.id,
      commandId: randomUUID(),
    })) as { session: { id: string; reviewId?: string } | null };
    const reviewId = (await waitForReviewSession(server, minted.session?.id ?? "")).reviewId ?? "";
    expect(reviewId).not.toBe("");

    const composed = (await server.dispatch("publish.compose", {
      commandId: randomUUID(),
      reviewId,
      mode: "pr",
    })) as {
      status: string;
      target: { repo: { forge: string; owner: string; name: string } };
      submission: {
        title: string;
        body: string;
        base: string;
        head: string;
        draft: boolean;
      };
      payload: string;
      compositionId: string;
    };
    expect(composed.status).toBe("pr");
    expect(composed.target).toEqual({
      repo: { forge: "gitlab", owner: "acme", name: "widget" },
    });

    await expect(
      server.dispatch("publish.submitPr", {
        commandId: randomUUID(),
        reviewId,
        target: composed.target,
        submission: composed.submission,
        payload: composed.payload,
        compositionId: composed.compositionId,
      }),
    ).resolves.toEqual({
      url: "https://gitlab.com/acme/widget/-/merge_requests/17",
      number: 17,
      reused: false,
    });

    expect(detectionDepsForLocus).toHaveBeenCalledWith({ kind: "host" });
    expect(forgeSubmissionGitForLocus).toHaveBeenCalledWith({ kind: "host" });
    expect(submissionGit.mock.calls).toEqual([
      [repo, ["remote", "-v"]],
      [repo, ["remote", "-v"]],
      [repo, ["remote", "-v"]],
      [repo, ["push", "origin", "refs/heads/feat/reviewed:refs/heads/feat/reviewed"]],
    ]);
    expect(commands).toHaveLength(3);
    expect(commands[1]).toMatchObject({
      file: "/usr/bin/glab",
      cwd: repo,
      stdin: JSON.stringify({
        source_branch: "feat/reviewed",
        target_branch: "main",
        title: "Draft: feat/reviewed",
        description: "",
      }),
    });
  }, 30_000);
});

describe("durable round execution recovery", () => {
  const dirs: string[] = [];
  const shutdowns: (() => void)[] = [];

  afterEach(() => {
    for (const shutdown of shutdowns.splice(0)) shutdown();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("restores an active round repository before recovering its report draft", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "rennet-round-root-recovery-data-"));
    const workspace = mkdtempSync(join(tmpdir(), "rennet-round-root-recovery-workspace-"));
    const primaryRepo = join(workspace, "primary");
    const includedRepo = join(workspace, "included");
    dirs.push(dataDir, workspace);
    for (const repo of [primaryRepo, includedRepo]) {
      execFileSync("git", ["init", "-b", "main", repo]);
      execFileSync("git", ["config", "user.email", "t@t"], { cwd: repo });
      execFileSync("git", ["config", "user.name", "t"], { cwd: repo });
      writeFileSync(join(repo, "a.ts"), "export const value = 1;\n");
      execFileSync("git", ["add", "a.ts"], { cwd: repo });
      execFileSync("git", ["commit", "-m", "base"], { cwd: repo });
    }
    writeFileSync(join(includedRepo, "a.ts"), "export const value = 2;\n");
    const sourceHead = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: includedRepo,
      encoding: "utf8",
    }).trim();

    const reviewId = "review-root-recovery";
    const sourcePatchsetId = "patchset-root-recovery";
    const sourcePatchset: Review["patchsets"][number] = {
      id: sourcePatchsetId,
      createdAt: "2026-09-01T00:00:00.000Z",
      repository: {
        id: "included",
        root: includedRepo,
        commonDir: join(includedRepo, ".git"),
        baseRef: "main",
        baseOid: sourceHead,
        headOid: sourceHead,
      },
      files: [],
      rawDiff: "",
      byteLength: 0,
      truncated: false,
    };
    const reviewStore = new SqliteReviewStore(join(dataDir, "rennet.sqlite"));
    reviewStore.appendRawForTesting(reviewId, "ReviewCreated", 1, {
      reviewId,
      patchset: sourcePatchset,
    });
    reviewStore.close();

    const sessionId = "session-root-recovery";
    const operationId = "operation-root-recovery";
    const operationStore = new RoundOperationStore(join(dataDir, "round-operations"));
    let operation = operationStore.claimIfIdle({
      operationId,
      sessionId,
      reviewId,
      dispatchId: "dispatch-root-recovery",
      sourcePatchsetId,
      askOccurrences: [{ id: "ask-root-recovery", revision: 1 }],
      roundNumber: 1,
      sourceTarget: { kind: "detached", head: sourceHead },
      repoRoot: includedRepo,
      workOrderPrompt: "recover the persisted report draft",
      workOrderDigest: sha256Hex("recover the persisted report draft"),
      revision: 0,
      rerunRequested: false,
      createdAt: 1,
      updatedAt: 1,
      state: { phase: "claimed" },
    });
    const transition = (state: RoundOperation["state"], updatedAt: number): void => {
      operation = operationStore.compareAndSwap(
        {
          sessionId: operation.sessionId,
          operationId: operation.operationId,
          revision: operation.revision,
        },
        { state, updatedAt },
      );
    };
    const workspaceReceipt = {
      kind: "bound-root" as const,
      root: includedRepo,
      sourceHead,
      preparedAt: 3,
    };
    transition({ phase: "prepared", workspace: workspaceReceipt }, 3);
    const workerAttempt = { executionId: "worker-root-recovery", startedAt: 4 };
    transition({ phase: "worker-running", workspace: workspaceReceipt, worker: workerAttempt }, 4);
    const workerReceipt = {
      ...workerAttempt,
      outcome: "completed" as const,
      completedAt: 5,
      diff: "diff --git a/a.ts b/a.ts\n+export const value = 2;",
      changedPaths: ["a.ts"],
    };
    transition({ phase: "worker-settled", workspace: workspaceReceipt, worker: workerReceipt }, 5);
    const commitAttempt = {
      executionId: "commit-root-recovery",
      baseHead: sourceHead,
      startedAt: 7,
    };
    transition(
      {
        phase: "committing",
        workspace: workspaceReceipt,
        worker: workerReceipt,
        commit: commitAttempt,
      },
      7,
    );
    const commits = {
      ...commitAttempt,
      from: sourceHead,
      to: `${sourceHead}-worker`,
      count: 1,
      committedAt: 8,
    };
    transition(
      {
        phase: "commits-settled",
        workspace: workspaceReceipt,
        worker: workerReceipt,
        commits,
      },
      8,
    );
    const recordingAttempt = {
      effect: "round-recording" as const,
      executionId: "recording-root-recovery",
      startedAt: 11,
    };
    transition(
      {
        phase: "round-recording",
        workspace: workspaceReceipt,
        worker: workerReceipt,
        commits,
        recording: recordingAttempt,
      },
      11,
    );
    const recording = { ...recordingAttempt, recordedAt: 12 };
    transition(
      {
        phase: "round-recorded",
        workspace: workspaceReceipt,
        worker: workerReceipt,
        commits,
        recording,
      },
      12,
    );
    transition(
      {
        phase: "report-drafting",
        workspace: workspaceReceipt,
        worker: workerReceipt,
        commits,
        recording,
        report: {
          executionId: "00000000-0000-4000-8000-000000000013",
          reportBoardId: "report-board-root-recovery",
          generation: "generation-root-recovery",
          boardIds: {
            design: "design-board-root-recovery",
            sequence: "sequence-board-root-recovery",
            decisions: "decisions-board-root-recovery",
            flagged: "flagged-board-root-recovery",
            noise: "noise-board-root-recovery",
            report: "report-board-root-recovery",
          },
          startedAt: 13,
        },
      },
      13,
    );
    operationStore.close();

    const server = await createRennetServer({
      dataDir,
      env: { RENNET_DISABLE_HARNESS: "1" },
    });
    shutdowns.push(server.shutdown);

    await vi.waitFor(
      () => {
        const recoveredStore = new RoundOperationStore(join(dataDir, "round-operations"));
        const recovered = recoveredStore.read(sessionId);
        recoveredStore.close();
        expect(recovered?.state.phase).toBe("failed");
        if (recovered?.state.phase !== "failed") return;
        expect(recovered.state.failure.reason).toContain("lost its session");
        expect(recovered.state.failure.reason).not.toContain("Repository access was not granted");
      },
      { timeout: 10_000, interval: 20 },
    );
    const recoveredReviewStore = new SqliteReviewStore(join(dataDir, "rennet.sqlite"));
    const recoveredReview = recoveredReviewStore.reviewById(reviewId);
    recoveredReviewStore.close();
    expect(recoveredReview?.activePatchsetId).not.toBe(sourcePatchsetId);
  }, 15_000);

  it("recovers a worker-running operation into preserved partial evidence without a second turn", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "rennet-round-recovery-data-"));
    const repo = realpathSync(mkdtempSync(join(tmpdir(), "rennet-round-recovery-repo-")));
    dirs.push(dataDir, repo);
    const git = (cwd: string, ...args: string[]) =>
      execFileSync("git", args, { cwd }).toString().trim();
    git(repo, "init", "-b", "main");
    git(repo, "config", "user.email", "t@t");
    git(repo, "config", "user.name", "t");
    writeFileSync(join(repo, "a.ts"), "export const value = 1;\n");
    git(repo, "add", "a.ts");
    git(repo, "commit", "-m", "base");
    const sourceHead = git(repo, "rev-parse", "HEAD");
    // The round's partial edits are in the reviewer's OWN checkout now — there is no
    // detached worktree to inspect them in (session-bound-workspace D2).
    writeFileSync(join(repo, "a.ts"), "export const value = 2;\n");
    const prompt = "apply the round";
    const attempt = { executionId: "worker-recovery", startedAt: 4 };
    const operation: RoundOperation = {
      operationId: "operation-recovery",
      sessionId: "session-recovery",
      reviewId: "review-recovery",
      dispatchId: "dispatch-recovery",
      sourcePatchsetId: "patchset-recovery",
      askOccurrences: [{ id: "ask-recovery", revision: 1 }],
      roundNumber: 1,
      sourceTarget: { kind: "branch", branch: "main" },
      repoRoot: repo,
      workOrderPrompt: prompt,
      workOrderDigest: sha256Hex(prompt),
      revision: 0,
      rerunRequested: false,
      createdAt: 1,
      updatedAt: 4,
      state: {
        phase: "worker-running",
        workspace: { kind: "bound-root", root: repo, sourceHead, preparedAt: 3 },
        worker: attempt,
      },
    };
    const operationStore = new RoundOperationStore(join(dataDir, "round-operations"));
    const claimed = operationStore.claimIfIdle({
      ...operation,
      updatedAt: 1,
      state: { phase: "claimed" },
    });
    const workspace = {
      kind: "bound-root" as const,
      root: repo,
      sourceHead,
      preparedAt: 3,
    };
    const prepared = operationStore.compareAndSwap(
      {
        sessionId: claimed.sessionId,
        operationId: claimed.operationId,
        revision: claimed.revision,
      },
      { state: { phase: "prepared", workspace }, updatedAt: 3 },
    );
    operationStore.compareAndSwap(
      {
        sessionId: prepared.sessionId,
        operationId: prepared.operationId,
        revision: prepared.revision,
      },
      { state: { phase: "worker-running", workspace, worker: attempt }, updatedAt: 4 },
    );
    operationStore.close();
    const runHandoffTurn = vi.fn(async () => {
      throw new Error("duplicate worker execution");
    });
    const server = await createRennetServer({
      dataDir,
      env: { RENNET_DISABLE_HARNESS: "1" },
      runRoundTurn: runHandoffTurn,
    });
    shutdowns.push(server.shutdown);

    await vi.waitFor(
      () => {
        const store = new RoundOperationStore(join(dataDir, "round-operations"));
        const recovered = store.read(operation.sessionId);
        store.close();
        expect(recovered?.state.phase).toBe("failed");
      },
      { timeout: 10_000, interval: 50 },
    );

    const recoveredStore = new RoundOperationStore(join(dataDir, "round-operations"));
    const recovered = recoveredStore.read(operation.sessionId);
    recoveredStore.close();
    expect(runHandoffTurn).not.toHaveBeenCalled();
    expect(recovered?.state.phase).toBe("failed");
    if (recovered?.state.phase !== "failed" || recovered.state.failure.at !== "worker") {
      throw new Error("expected interrupted worker recovery");
    }
    expect(recovered.state.failure.worker).toMatchObject({
      executionId: attempt.executionId,
      outcome: "failed",
    });
    // The reason points the reviewer at their OWN checkout, which is where the round's
    // partial edits actually are, and the recovery never touches them.
    expect(recovered.state.failure.reason).toContain(repo);
    expect(readFileSync(join(repo, "a.ts"), "utf8")).toBe("export const value = 2;\n");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The round dispatch's session, executed through the REAL server.
//
// `dispatchRound` is a closure in the composition root, so nothing had ever run its
// call site — which is why it silently lost the review id and the repository. This
// drives it end to end over a real git repo: add a project, start Current Checkout,
// stage an ask, dispatch. The round's coding turn fails for want of a harness, and
// that is fine — the session derivation runs first and is what is asserted.
// ─────────────────────────────────────────────────────────────────────────────
describe("round.dispatch mints onto the session the reads answer (the call site, run)", () => {
  const dirs: string[] = [];
  const shutdowns: (() => void)[] = [];
  afterEach(() => {
    for (const shutdown of shutdowns.splice(0)) shutdown();
    vi.unstubAllEnvs();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("takes the Current Checkout session rather than minting a second row beside it", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "rennet-round-site-"));
    // HOME is redirected as a BACKSTOP, not as the mechanism: every store honours `dataDir`
    // now, so nothing should reach it. The assertion at the end proves that rather than
    // assuming it — this test is the reason we know the stores used to escape.
    const home = mkdtempSync(join(tmpdir(), "rennet-round-home-"));
    vi.stubEnv("HOME", home);
    // The project is added under a SYMLINK to the repo, and git reports the resolved path —
    // so `Project.path` and `review.repositoryRoot` are two spellings of one directory. That
    // is the shape a single-path fixture cannot contain: without it `projectIdForRepoRoot`
    // misses, `projectIdOf` falls back to the raw path, and the round mints a second session
    // filed under a project id no sidebar row has. Built explicitly rather than relying on
    // macOS resolving `/var/folders`, so it bites on Linux too.
    const repo = realpathSync(mkdtempSync(join(tmpdir(), "rennet-round-repo-")));
    const linkDir = mkdtempSync(join(tmpdir(), "rennet-round-link-"));
    const repoLink = join(linkDir, "repo");
    symlinkSync(repo, repoLink);
    dirs.push(dataDir, home, repo, linkDir);
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo });
    git("init", "-b", "main");
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "a.txt"), "one\n");
    git("add", "a.txt");
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "x");
    // An uncommitted edit, so the working-tree capture has a real range to review.
    writeFileSync(join(repo, "a.txt"), "one\ntwo\n");

    const server = await createRennetServer({ dataDir, env: {} });
    shutdowns.push(server.shutdown);
    const added = (await server.dispatch("projects.add", {
      commandId: randomUUID(),
      discovery: {
        path: repoLink,
        kind: "repo",
        repos: [{ name: "repo", path: repoLink, branches: 1 }],
        primaryBranch: "main",
      },
      includedRepos: ["repo"],
      primaryBranch: "main",
    })) as { project: { id: string } };

    // The Current Checkout front door: no branch ⇒ a claim-LESS session, root-stamped,
    // holding the review. The only arm that can ever find it again is the holder arm.
    const minted = (await server.dispatch("session.mint", {
      projectId: added.project.id,
      commandId: randomUUID(),
    })) as { session: { id: string; reviewId?: string } | null };
    expect(minted.session).not.toBeNull();
    const checkoutId = minted.session?.id ?? "";
    const reviewId = (await waitForReviewSession(server, checkoutId)).reviewId ?? "";
    expect(reviewId).not.toBe(""); // the front door captured and ATTACHED
    expect(checkoutId).not.toBe(reviewId); // a randomUUID id, never the review's id

    // One addressed ask, so the bundle is non-empty and the round really dispatches.
    await server.dispatch("ask.stage", {
      sessionId: reviewId,
      ask: { id: randomUUID(), anchor: "the round", type: "request-change", body: "do the thing" },
    });
    const dispatched = (await server.dispatch("round.dispatch", { reviewId })) as {
      dispatched: boolean;
      acceptedOperation?: { operationId: string };
    };
    expect(dispatched.dispatched).toBe(true);
    expect(dispatched.acceptedOperation?.operationId).toBeTypeOf("string");
    const acceptedOperationId = dispatched.acceptedOperation?.operationId;

    // The kick runs BEHIND the command, so wait on a point that is downstream of the
    // session derivation: `dispatchRound` emits its first progress event only after
    // `enterRoundSession` has resolved. Waiting on a SEQUENCE, not a sleep.
    await vi.waitFor(
      async () => {
        const events = (await server.dispatch("session.roundEvents", { reviewId })) as {
          events: { type?: string; snapshot?: { operationId?: string } }[];
        };
        expect(
          events.events.some(
            (event) =>
              event.type === "operation" && event.snapshot?.operationId === acceptedOperationId,
          ),
        ).toBe(true);
      },
      { timeout: 15_000, interval: 50 },
    );

    // The assertion: the store holds ONE session, and it is the one the click made.
    // A call site that drops the review id mints a second row here.
    const listed = (await server.dispatch("session.list", {})) as {
      sessions: { id: string; projectId: string }[];
    };
    expect(listed.sessions.map((s) => s.id)).toEqual([checkoutId]);
    // And it is filed under the PROJECT, not under a path — the round resolved the symlinked
    // project path onto the review's resolved root rather than falling through to it.
    expect(listed.sessions[0]?.projectId).toBe(added.project.id);

    // HERMETIC: the session the round just wrote lives under THIS server's `dataDir`, and the
    // redirected home is untouched. Nine of the twelve stores used to ignore `dataDir` and
    // write to `~/.rennet` from anywhere — which is how an earlier run of this very test wrote
    // into the machine's real session store. A server given a `dataDir` now lives there.
    expect(existsSync(join(dataDir, "sessions", `${checkoutId}.json`))).toBe(true);
    expect(existsSync(join(home, ".rennet"))).toBe(false);
  }, 30_000);

  it("runs the round in the bound checkout, records its root, and recaptures the successor", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "rennet-round-equal-head-data-"));
    const repo = realpathSync(mkdtempSync(join(tmpdir(), "rennet-round-equal-head-repo-")));
    dirs.push(dataDir, repo);
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo }).toString().trim();
    git("init", "-b", "main");
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "a.txt"), "base\n");
    git("add", "a.txt");
    git("commit", "-m", "base");
    writeFileSync(join(repo, "a.txt"), "base\nreviewed\n");
    const head = git("rev-parse", "HEAD");
    let workerCalls = 0;
    let workerRepoRoot: string | undefined;
    let workerPrompt = "";
    let placeholderObserved = false;
    let roundSessionId = "";
    const server = await createRennetServer({
      dataDir,
      env: { RENNET_DISABLE_HARNESS: "1" },
      // The round worker is a turn in the SESSION'S BOUND ROOT and commits on the branch
      // itself — nothing lands a delta afterwards, so a turn that does not commit leaves
      // the round with zero commits, which is exactly what the coordinator refuses.
      //
      // It OBEYS the prompt about git rather than committing regardless: a fake that
      // always commits is what hid the shipped blocker, where the round carried the review
      // handoff's "do NOT commit" rule and every real round would have failed.
      runRoundTurn: async ({ repoRoot, prompt }: { repoRoot: string; prompt: string }) => {
        workerCalls += 1;
        workerRepoRoot = repoRoot;
        workerPrompt = prompt;
        writeFileSync(join(repoRoot, "a.txt"), "base\nreviewed\nworker change\n");
        if (!/do NOT commit/i.test(prompt)) {
          execFileSync("git", ["add", "a.txt"], { cwd: repoRoot });
          execFileSync("git", ["commit", "-m", "worker change"], { cwd: repoRoot });
        }
        return {
          status: "completed",
          finalText: "done",
          turnDiff: "diff --git a/a.txt b/a.txt\n+worker change",
          filesTouched: ["a.txt"],
          harness: { id: "codex", version: "0.146.0" },
          checkpoint: { threadId: "thread-round", turnId: "turn-round", turnCount: 1 },
        };
      },
      onRoundPlaceholderCommitted: ({ sessionId, dispatchId }) => {
        roundSessionId = sessionId;
        const operationStore = new RoundOperationStore(join(dataDir, "round-operations"));
        const operation = operationStore.read(sessionId);
        operationStore.close();
        expect(operation?.state.phase).toBe("round-recording");
        if (operation?.state.phase !== "round-recording") {
          throw new Error("round placeholder was recorded outside its durable recording attempt");
        }
        // The commits the round observed are the ones the worker made ON THE BRANCH, in
        // the bound root — never a replayed delta and never a blanket `git add -A`.
        expect(operation.state.workspace).toEqual({
          kind: "bound-root",
          root: repo,
          sourceHead: head,
          preparedAt: expect.any(Number),
        });
        expect(operation.state.commits.from).toBe(head);
        expect(operation.state.commits.count).toBe(1);
        expect(operation.state.recording.effect).toBe("round-recording");
        expect(readFileSync(join(repo, "a.txt"), "utf8")).toContain("worker change");
        const record = new RoundRecordStore(join(dataDir, "rounds"))
          .read(sessionId)
          .find((candidate) => candidate.dispatchId === dispatchId);
        expect(record?.outcome).toBe("completed");
        expect(record?.boardGeneration).toBe(ROUND_NO_REGEN);
        expect(record?.regeneration).toBe("pending");
        expect(record?.run).toEqual({
          startedAt: operation.createdAt,
          sourceTarget: operation.sourceTarget,
          harness: { id: "codex", version: "0.146.0" },
          workspaceRoot: repo,
          checkpoint: { threadId: "thread-round", turnId: "turn-round", turnCount: 1 },
        });
        // This hook runs before create-server enters PR-draft ripening. If placeholder
        // persistence moves behind that await, the record is absent and this control reds.
        placeholderObserved = true;
      },
    });
    shutdowns.push(server.shutdown);
    const added = (await server.dispatch("projects.add", {
      commandId: randomUUID(),
      discovery: {
        path: repo,
        kind: "repo",
        repos: [{ name: "repo", path: repo, branches: 1 }],
        primaryBranch: "main",
      },
      includedRepos: ["repo"],
      primaryBranch: "main",
    })) as { project: { id: string } };
    const minted = (await server.dispatch("session.mint", {
      projectId: added.project.id,
      commandId: randomUUID(),
    })) as { session: { id: string; reviewId?: string } | null };
    const sessionId = minted.session?.id ?? "";
    const reviewId = (await waitForReviewSession(server, sessionId)).reviewId ?? "";
    const before = (await server.dispatch("review.load", {
      commandId: randomUUID(),
      reviewId,
    })) as { review: Review };
    const priorPatchsetId = before.review.activePatchsetId;
    await server.dispatch("ask.stage", {
      sessionId: reviewId,
      ask: {
        id: "equal-head-ask",
        anchor: "a.txt:2",
        type: "request-change",
        body: "make the worker change",
      },
    });
    await server.dispatch("round.dispatch", { reviewId });

    await vi.waitFor(
      () => {
        const operationStore = new RoundOperationStore(join(dataDir, "round-operations"));
        const current = operationStore.read(sessionId);
        operationStore.close();
        if (current?.state.phase === "failed") {
          throw new Error(`controlled round failed: ${current.state.failure.reason}`);
        }
        expect(placeholderObserved).toBe(true);
      },
      { timeout: 15_000 },
    );
    await vi.waitFor(
      async () => {
        const loaded = (await server.dispatch("review.load", {
          commandId: randomUUID(),
          reviewId,
        })) as { review: Review };
        expect(loaded.review.activePatchsetId).not.toBe(priorPatchsetId);
        const operationStore = new RoundOperationStore(join(dataDir, "round-operations"));
        const operation = operationStore.read(roundSessionId);
        operationStore.close();
        const report =
          operation?.state.phase === "report-drafting"
            ? operation.state.report
            : operation?.state.phase === "failed" &&
                operation.state.failure.at === "report-drafting"
              ? operation.state.failure.report
              : undefined;
        const successor =
          report === undefined
            ? undefined
            : new GenerationStore(join(dataDir, "generations")).load(report.generation);
        expect(
          Object.keys(successor?.draftingBoardIds ?? {}).length +
            Object.keys(successor?.failedLenses ?? {}).length,
        ).toBeGreaterThan(0);
      },
      { timeout: 15_000, interval: 50 },
    );
    expect(workerCalls).toBe(1);
    // The turn ran in the session's bound root — the reviewer's own checkout — and the
    // branch moved there, which is the whole point: nothing replays a delta afterwards.
    expect(workerRepoRoot).toBe(repo);
    const afterRound = git("rev-parse", "HEAD");
    expect(afterRound).not.toBe(head);

    // The successor patchset is captured after the turn from the tree the round committed
    // in: its head is that checkout's head, not a detached worktree's. What this CANNOT
    // catch on its own is which recapture path ran — a current-checkout review recaptures
    // through `review.regenerate`, whose repo path and the bound root are the same value
    // here, so swapping one for the other leaves this green. The branch-landing capture's
    // own head argument is pinned by the operation-state assertions above.
    const after = (await server.dispatch("review.load", {
      commandId: randomUUID(),
      reviewId,
    })) as { review: Review };
    const successorPatchset = after.review.patchsets.find(
      (candidate) => candidate.id === after.review.activePatchsetId,
    );
    expect(successorPatchset?.repository.headOid).toBe(afterRound);

    // The work order is a FILE the prompt NAMES, not a payload the prompt carries: the
    // path in the prompt resolves, in the bound root, to the composed order. Asserting the
    // string alone would pass for a prompt naming a file nobody ever wrote.
    const named = /`?([\w./-]*\.rennet\/context\/[\w-]+\/work-order\.md)`?/.exec(workerPrompt);
    expect(named?.[1]).toBeDefined();
    const workOrderPath = join(repo, named?.[1] ?? "");
    expect(existsSync(workOrderPath)).toBe(true);
    expect(readFileSync(workOrderPath, "utf8")).toContain("make the worker change");
    expect(workerPrompt).not.toContain("make the worker change");

    // The worktree zoo is gone: no per-round worktree under the data dir, and the repo
    // still has exactly the one checkout the reviewer opened.
    expect(existsSync(join(dataDir, "round-worktrees"))).toBe(false);
    expect(git("worktree", "list").split(/\r?\n/).filter(Boolean)).toHaveLength(1);
  }, 30_000);

  // The fixture where the bound root and `review.repositoryRoot` are DIFFERENT DIRECTORIES.
  // Every other round test has them equal, so nothing in them can tell the two names apart.
  // Here the clone stays on `main` and the review's branch is checked out only in the worktree
  // the session binds to (#805), and the two have different heads for the whole run.
  it("runs a rewritten branch's round in the bound worktree, not the clone", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "rennet-round-elsewhere-data-"));
    const repo = realpathSync(mkdtempSync(join(tmpdir(), "rennet-round-elsewhere-repo-")));
    dirs.push(dataDir, repo);
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo }).toString().trim();
    git("init", "-b", "main");
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "a.txt"), "base\n");
    git("add", "a.txt");
    git("commit", "-m", "base");
    git("checkout", "-b", "feature/elsewhere");
    writeFileSync(join(repo, "a.txt"), "base\nreviewed\n");
    git("add", "a.txt");
    git("commit", "-m", "reviewed");
    const branchHead = git("rev-parse", "HEAD");
    // …and the clone goes back to `main`, where it stays. `review.repositoryRoot` is now a
    // tree that does not have the reviewed commit at its head at all.
    git("checkout", "main");
    const cloneHead = git("rev-parse", "HEAD");
    expect(cloneHead).not.toBe(branchHead);

    let workerRepoRoot: string | undefined;
    const server = await createRennetServer({
      dataDir,
      env: { RENNET_DISABLE_HARNESS: "1" },
      runRoundTurn: async ({ repoRoot, prompt }: { repoRoot: string; prompt: string }) => {
        workerRepoRoot = repoRoot;
        writeFileSync(join(repoRoot, "a.txt"), "base\nreviewed\nworker change\n");
        if (!/do NOT commit/i.test(prompt)) {
          execFileSync("git", ["add", "a.txt"], { cwd: repoRoot });
          execFileSync("git", ["commit", "-m", "worker change"], { cwd: repoRoot });
        }
        return {
          status: "completed",
          finalText: "done",
          turnDiff: "diff --git a/a.txt b/a.txt\n+worker change",
          filesTouched: ["a.txt"],
          harness: { id: "codex", version: "0.146.0" },
          checkpoint: { threadId: "thread-round", turnId: "turn-round", turnCount: 1 },
        };
      },
    });
    shutdowns.push(server.shutdown);
    const added = (await server.dispatch("projects.add", {
      commandId: randomUUID(),
      discovery: {
        path: repo,
        kind: "repo",
        repos: [{ name: "repo", path: repo, branches: 2 }],
        primaryBranch: "main",
      },
      includedRepos: ["repo"],
      primaryBranch: "main",
    })) as { project: { id: string } };
    const minted = (await server.dispatch("session.mint", {
      projectId: added.project.id,
      commandId: randomUUID(),
      branch: "feature/elsewhere",
    })) as { session: { id: string } | null };
    const sessionId = minted.session?.id ?? "";
    const reviewId = (await waitForReviewSession(server, sessionId)).reviewId ?? "";

    const store = new SessionStore(join(dataDir, "sessions"));
    await vi.waitFor(() => expect(store.load(sessionId)?.boundRoot).toBeDefined(), {
      timeout: 15_000,
      interval: 20,
    });
    const bound = store.load(sessionId)?.boundRoot ?? "";
    // The premise of the whole test: the two roots really are different directories.
    expect(bound).not.toBe(repo);

    const before = (await server.dispatch("review.load", {
      commandId: randomUUID(),
      reviewId,
    })) as { review: Review };
    const priorPatchsetId = before.review.activePatchsetId;

    // …and now the reviewer AMENDS the branch, in the workspace, after the capture. The
    // reviewed commit is unreachable from here on. That is a deliberate act, not a fault:
    // the round must still dispatch and complete, and say on its account that it ran
    // against a rewritten branch. Refusing would be a gate, and its "check it out there"
    // message would be an instruction nobody can follow.
    execFileSync("git", ["commit", "-q", "--amend", "-m", "reviewed, amended"], { cwd: bound });
    const amendedHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: bound })
      .toString()
      .trim();
    expect(amendedHead).not.toBe(branchHead);

    await server.dispatch("ask.stage", {
      sessionId: reviewId,
      ask: {
        id: "elsewhere-ask",
        anchor: "a.txt:2",
        type: "request-change",
        body: "make the worker change",
      },
    });
    await server.dispatch("round.dispatch", { reviewId });

    await vi.waitFor(
      async () => {
        const operationStore = new RoundOperationStore(join(dataDir, "round-operations"));
        const current = operationStore.read(sessionId);
        operationStore.close();
        // The successor is activated INSIDE `draftReport`, before its report seat runs — and
        // that seat cannot run with the harness disabled. So a failure at `report-drafting`
        // is this fixture's normal end and says nothing about the capture; anything earlier
        // is a real round failure and is reported rather than waited out.
        if (current?.state.phase === "failed" && current.state.failure.at !== "report-drafting") {
          throw new Error(
            `round failed at ${current.state.failure.at}: ${current.state.failure.reason}`,
          );
        }
        const loaded = (await server.dispatch("review.load", {
          commandId: randomUUID(),
          reviewId,
        })) as { review: Review };
        expect(loaded.review.activePatchsetId).not.toBe(priorPatchsetId);
      },
      { timeout: 20_000, interval: 50 },
    );

    // The turn ran in the BOUND worktree, and the branch moved THERE.
    expect(workerRepoRoot).toBe(bound);
    // …and the round completed on the rewritten branch, saying so on its account.
    const record = new RoundRecordStore(join(dataDir, "rounds"))
      .read(sessionId)
      .find((candidate) => candidate.run?.workspaceRoot === bound);
    expect(record?.run?.branchRewritten).toBe(true);
    const boundHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: bound }).toString().trim();
    expect(boundHead).not.toBe(amendedHead);
    // The clone never moved: it is still on `main`, at the commit it started on.
    expect(git("rev-parse", "HEAD")).toBe(cloneHead);

    const after = (await server.dispatch("review.load", {
      commandId: randomUUID(),
      reviewId,
    })) as { review: Review };
    const successor = after.review.patchsets.find(
      (candidate) => candidate.id === after.review.activePatchsetId,
    );
    // The successor advances to the commit the round made in the bound worktree, which is not
    // the clone's head.
    expect(successor?.repository.headOid).toBe(boundHead);
    expect(successor?.repository.headOid).not.toBe(cloneHead);

    // WHAT THIS CANNOT CATCH, established by running the control rather than reasoning about
    // it: pointing `draftReport`'s capture at `operation.repoRoot` instead of
    // `operation.state.workspace.root` leaves every assertion above GREEN. A linked worktree
    // shares the repository's objects and refs, and `captureLandedBranchPatchset` is handed
    // the head OID explicitly, so a branch capture answers identically from either directory.
    // The capture's ROOT is therefore not falsifiable by any fixture of this shape; what is
    // falsifiable, and what this test does own, is where the TURN ran — pointing
    // `candidateRoots` at the clone reddens it, because the clone is not on the branch.
  }, 40_000);

  it("restarts a completed no-code dispatch and runs a distinct queued second ask", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "rennet-round-restart-data-"));
    const repo = realpathSync(mkdtempSync(join(tmpdir(), "rennet-round-restart-repo-")));
    dirs.push(dataDir, repo);
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo }).toString().trim();
    git("init", "-b", "main");
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "a.txt"), "base\n");
    git("add", "a.txt");
    git("commit", "-m", "base");
    writeFileSync(join(repo, "a.txt"), "base\nreviewed\n");

    let workerCalls = 0;
    let crashedSessionId: string | undefined;
    let releaseFirstWorker = (): void => undefined;
    const firstWorkerGate = new Promise<void>((resolve) => {
      releaseFirstWorker = resolve;
    });
    let markFirstWorkerStarted = (): void => undefined;
    const firstWorkerStarted = new Promise<void>((resolve) => {
      markFirstWorkerStarted = resolve;
    });
    const first = await createRennetServer({
      dataDir,
      env: { RENNET_DISABLE_HARNESS: "1" },
      runRoundTurn: async () => {
        workerCalls += 1;
        markFirstWorkerStarted();
        await firstWorkerGate;
        return { status: "completed", finalText: "done", turnDiff: "", filesTouched: [] };
      },
      onRoundPlaceholderCommitted: ({ sessionId }) => {
        crashedSessionId = sessionId;
        const operationStore = new RoundOperationStore(join(dataDir, "round-operations"));
        const operation = operationStore.read(sessionId);
        operationStore.close();
        expect(operation?.state.phase).toBe("round-recording");
        if (operation?.state.phase !== "round-recording") {
          throw new Error("unchanged round was recorded outside its durable recording attempt");
        }
        expect(operation.state.commits.count).toBe(0);
        return new Promise<void>(() => undefined);
      },
    });
    shutdowns.push(first.shutdown);
    const added = (await first.dispatch("projects.add", {
      commandId: randomUUID(),
      discovery: {
        path: repo,
        kind: "repo",
        repos: [{ name: "repo", path: repo, branches: 1 }],
        primaryBranch: "main",
      },
      includedRepos: ["repo"],
      primaryBranch: "main",
    })) as { project: { id: string } };
    const minted = (await first.dispatch("session.mint", {
      projectId: added.project.id,
      commandId: randomUUID(),
    })) as { session: { id: string; reviewId?: string } | null };
    const sessionId = minted.session?.id ?? "";
    const reviewId = (await waitForReviewSession(first, sessionId)).reviewId ?? "";
    new TranscriptStore(join(dataDir, "transcripts")).append(sessionId, [
      {
        kind: "turn",
        id: "pre-round-history",
        speaker: "orchestrator",
        status: "complete",
        paragraphs: ["The review was already in progress."],
      },
    ]);
    const loaded = (await first.dispatch("review.load", {
      commandId: randomUUID(),
      reviewId,
    })) as { review: Review };
    const sourcePatchsetId = loaded.review.activePatchsetId;
    await first.dispatch("ask.stage", {
      sessionId: reviewId,
      ask: {
        id: "restart-ask",
        anchor: "a.txt:2",
        type: "request-change",
        body: "run this once",
      },
    });
    await first.dispatch("round.dispatch", { reviewId });
    await firstWorkerStarted;
    await first.dispatch("ask.stage", {
      sessionId: reviewId,
      ask: {
        id: "restart-ask-2",
        anchor: "a.txt:2",
        type: "request-change",
        body: "run this after restart",
      },
    });
    const queued = (await first.dispatch("round.dispatch", { reviewId })) as {
      acceptedOperation?: { rerunRequested?: boolean };
    };
    expect(queued.acceptedOperation?.rerunRequested).toBe(true);
    releaseFirstWorker();

    await vi.waitFor(
      async () => {
        const operationStore = new RoundOperationStore(join(dataDir, "round-operations"));
        const current = operationStore.read(sessionId);
        operationStore.close();
        if (current?.state.phase === "failed") {
          throw new Error(`controlled no-code round failed: ${current.state.failure.reason}`);
        }
        expect(crashedSessionId).toBeDefined();
        const records = new RoundRecordStore(join(dataDir, "rounds")).read(crashedSessionId ?? "");
        expect(records).toHaveLength(1);
        expect(records[0]?.regeneration).toBe("pending");
        const asks = (await first.dispatch("ask.read", { sessionId: reviewId })) as {
          projection: { stagedAsks: Record<string, unknown> };
        };
        expect(asks.projection.stagedAsks["restart-ask"]).toBeDefined();
        const transcript = (await first.dispatch("session.transcript", { reviewId })) as {
          rows: { id: string; paragraphs?: string[] }[];
        };
        expect(transcript.rows.map((row) => row.id)).toEqual([
          "pre-round-history",
          expect.stringMatching(/^round:.+:dispatch$/),
        ]);
      },
      { timeout: 15_000, interval: 50 },
    );
    first.shutdown();
    // If no-code completion falls through board collation, prior-generation loading reads
    // this corrupt row and the retry stays pending forever. Empty checkpoint evidence must
    // terminalize before any knowledge/design/prior-generation context is touched.
    writeFileSync(
      join(
        dataDir,
        "generations",
        `${encodeURIComponent(generationIdForPatchset(sourcePatchsetId))}.json`,
      ),
      "{corrupt",
    );

    const restarted = await createRennetServer({
      dataDir,
      env: { RENNET_DISABLE_HARNESS: "1" },
      runRoundTurn: async () => {
        workerCalls += 1;
        return { status: "completed", finalText: "duplicate", turnDiff: "", filesTouched: [] };
      },
    });
    shutdowns.push(restarted.shutdown);

    await vi.waitFor(
      async () => {
        const asks = (await restarted.dispatch("ask.read", { sessionId: reviewId })) as {
          projection: { stagedAsks: Record<string, unknown> };
        };
        expect(asks.projection.stagedAsks["restart-ask"]).toBeUndefined();
        expect(asks.projection.stagedAsks["restart-ask-2"]).toBeUndefined();
        const records = new RoundRecordStore(join(dataDir, "rounds")).read(crashedSessionId ?? "");
        expect(records).toHaveLength(2);
        expect(records.map((record) => record.boardGeneration)).toEqual([
          ROUND_NO_REGEN,
          ROUND_NO_REGEN,
        ]);
        expect(records.map((record) => record.regeneration)).toEqual(["not-needed", "not-needed"]);
      },
      { timeout: 15_000, interval: 50 },
    );
    // Production controls: deleting completed-record recovery reruns round one (three calls),
    // while dropping the durable rerun prevents round two (one call).
    expect(workerCalls).toBe(2);
    const transcript = (await restarted.dispatch("session.transcript", { reviewId })) as {
      rows: { id: string; paragraphs?: string[] }[];
    };
    expect(transcript.rows.map((row) => row.id)).toEqual([
      "pre-round-history",
      expect.stringMatching(/^round:.+:dispatch$/),
      expect.stringMatching(/^round:.+:return$/),
      expect.stringMatching(/^round:.+:dispatch$/),
      expect.stringMatching(/^round:.+:return$/),
    ]);
    expect(transcript.rows.at(-1)?.paragraphs?.[0]).toContain("Round 2 is back");
    expect(transcript.rows.at(-1)?.paragraphs?.[0]).toContain(
      "no code changes, so no successor report was drafted",
    );
  }, 30_000);
});
