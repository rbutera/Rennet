import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
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
import {
  generationIdForPatchset,
  parseCommandOutput,
  ROUND_NO_REGEN,
  roundSourceLandingTransactionPath,
  sha256Hex,
} from "@rennet/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  captureBranchPatchset,
  captureLandedBranchPatchset,
  coverageSeatFor,
  createBoardDraftCoordinator,
  createCompositionBoardsForReview,
  createGitLabPrSubmissionResolver,
  createRennetServer,
  createRoundRegenerationProgressQueue,
  createRoundSourceLandingPorts,
  createRoundWorkerPort,
  createRoundWorkspacePlanner,
  type HandoffTurnExecution,
  type RoundSourceLandingInjection,
  resolveCodingHarness,
  runResolvedCodingHarnessTurn,
  startProjectContextMaintenance,
} from "./create-server";
import { createGitHubTokenStore } from "./github-token-store";
import type { ProjectProcessJournalRecord } from "./project-process-journal";
import type { RoundExecutionPorts } from "./runtime/round-execution";

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

describe("requirement-coverage seat provenance (#681 residue, C14 D3)", () => {
  it("runs on a resolved Claude seat and stamps the harness that ran it", () => {
    const claude = codingPort("claude-code", "2.1.220");
    expect(
      coverageSeatFor({
        status: "ready",
        selection: { id: "claude-code", version: "2.1.220" },
        port: claude,
      }),
    ).toEqual({
      kind: "claude",
      port: claude,
      harness: { id: "claude-code", version: "2.1.220" },
    });
  });

  it("reports a typed absence naming Codex when Codex is what resolved", () => {
    const seat = coverageSeatFor({
      status: "ready",
      selection: { id: "codex", version: "0.146.0" },
      port: codingPort("codex", "0.146.0"),
    });

    expect(seat).toEqual({
      kind: "absent",
      coverage: {
        status: "unavailable",
        edges: [],
        harness: { id: "codex", version: "0.146.0" },
        reason:
          "Requirement coverage needs a Claude Code seat; this repository resolved Codex 0.146.0. No mapping was attempted.",
      },
    });
    // NOT "failed": nothing ran, so nothing broke. The distinction is the whole point.
    expect(seat.kind === "absent" && seat.coverage.status).not.toBe("failed");
  });

  it("carries the resolution's own account when no harness resolved at all", () => {
    expect(
      coverageSeatFor({
        status: "unavailable",
        reason:
          "No enabled coding harness (Claude Code or Codex) is available on the execution host.",
      }),
    ).toEqual({
      kind: "absent",
      coverage: {
        status: "unavailable",
        edges: [],
        reason:
          "Requirement coverage needs a Claude Code seat. No enabled coding harness (Claude Code or Codex) is available on the execution host.",
      },
    });
  });
});

// The unit tests above exercise `coverageSeatFor` directly, which proves the branch but
// not that PRODUCTION reaches it: `runLiveCoverage` could go back to calling
// `claudeAdapterForRepo` and every one of them would stay green. This drives the real
// `openspec.coverage` command through a composed server whose only harness is Codex.
//
// POSITIVE CONTROL (run 2026-09-01, restored after): replace `runLiveCoverage`'s
// `coverageSeatFor(await resolveCodingHarness(...))` with a direct
// `await claudeAdapterForRepo(review.repositoryRoot)` + no-adapter guard. This reddens —
// the command answers `failed` with no harness and no reason, and the wire refinement
// on `unavailable` is never reached.
describe("openspec.coverage through a composed Codex-only server (#681 residue, C14 D3)", () => {
  const dirs: string[] = [];
  const shutdowns: (() => void)[] = [];

  afterEach(() => {
    for (const shutdown of shutdowns.splice(0)) shutdown();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("answers a typed unavailable naming Codex and spends no coverage turn", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "rennet-coverage-codex-data-"));
    const repo = realpathSync(mkdtempSync(join(tmpdir(), "rennet-coverage-codex-repo-")));
    dirs.push(dataDir, repo);
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
    git("init", "-b", "main");
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    git("config", "core.excludesFile", "/dev/null");
    const specPath = "openspec/changes/coverage-seat/specs/coverage/spec.md";
    mkdirSync(join(repo, "openspec", "changes", "coverage-seat", "specs", "coverage"), {
      recursive: true,
    });
    writeFileSync(join(repo, "src.ts"), "export const value = 'base';\n");
    writeFileSync(
      join(repo, "openspec", "changes", "coverage-seat", "proposal.md"),
      "## Why\n\nThe coverage seat needs a Claude Code harness.\n",
    );
    writeFileSync(
      join(repo, specPath),
      "## ADDED Requirements\n\n### Requirement: The coverage seat is honest\n\nIt SHALL name what resolved.\n\n#### Scenario: codex only\n\n- **WHEN** only Codex resolves\n- **THEN** no mapping is attempted\n",
    );
    git("add", "-A");
    git("commit", "-m", "base");
    git("checkout", "-b", "feat/coverage");
    writeFileSync(join(repo, "src.ts"), "export const value = 'reviewed';\n");
    writeFileSync(
      join(repo, specPath),
      "## ADDED Requirements\n\n### Requirement: The coverage seat is honest\n\nIt SHALL name what resolved instead.\n\n#### Scenario: codex only\n\n- **WHEN** only Codex resolves\n- **THEN** no mapping is attempted\n",
    );
    git("add", "-A");
    git("commit", "-m", "reviewed");

    // The coverage turn's only observable spend: constructing a session on the port. A
    // Codex-only host must never reach it, so this throwing spy is both the assertion
    // and a trap — a seat that ran anyway fails loudly instead of silently mapping.
    const createSession = vi.fn(async () => {
      throw new Error("the coverage seat must not run a turn on a Codex-only host");
    });
    const codexOnly = {
      descriptor: { id: "codex", version: "0.146.0", displayName: "Codex", binaryPath: "/codex" },
      health: async () => ({ state: "ready", version: "0.146.0" }),
      createSession,
    } as unknown as HarnessPort;

    const server = await createRennetServer({
      dataDir,
      env: { RENNET_DISABLE_HARNESS: "1" },
      testHarnessPort: codexOnly,
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
    })) as { session: { id: string } | null };
    const reviewId = (await waitForReviewSession(server, minted.session?.id ?? "")).reviewId ?? "";
    expect(reviewId).not.toBe("");

    // `parseCommandOutput` is the wire boundary, so this also proves the refined
    // `unavailable` shape survives the trip rather than only the in-process object.
    const coverage = parseCommandOutput(
      "openspec.coverage",
      await server.dispatch("openspec.coverage", { reviewId }),
    );
    expect(coverage).toEqual({
      status: "unavailable",
      edges: [],
      harness: { id: "codex", version: "0.146.0" },
      reason:
        "Requirement coverage needs a Claude Code seat; this repository resolved Codex 0.146.0. No mapping was attempted.",
    });
    expect(createSession).not.toHaveBeenCalled();
  }, 30_000);
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

describe("round worker execution context", () => {
  it("carries a distro-native WSL branch capture through the round planner and worker", async () => {
    const git: GitExec = async (_root, arguments_) => {
      if (arguments_[0] === "rev-parse" && arguments_[1] === "--show-toplevel") {
        return "/home/rai/repo\n";
      }
      if (arguments_[0] === "rev-parse" && arguments_[1] === "--verify") {
        return "worker-head\n";
      }
      if (arguments_[0] === "rev-parse" && arguments_[1] === "--git-common-dir") {
        return "/home/rai/repo/.git\n";
      }
      if (arguments_[0] === "merge-base") return "base-head\n";
      if (arguments_[0] === "diff") return "";
      throw new Error(`unexpected git call: ${arguments_.join(" ")}`);
    };
    const resolveProjectSnapshotId = vi.fn(async () => "snapshot-1");
    const patchset = await captureBranchPatchset({
      git,
      locus: { kind: "wsl", distro: "Ubuntu" },
      repoPath: "\\\\wsl.localhost\\Ubuntu\\home\\rai\\repo",
      head: "feat/test",
      base: "main",
      resolveProjectSnapshotId,
    });
    const sourceRepoRoot = patchset.repository.root;
    expect(resolveProjectSnapshotId).toHaveBeenCalledWith(sourceRepoRoot, "base-head");
    const prompt = "apply the round";
    const operation: RoundOperation = {
      operationId: "operation-1",
      sessionId: "session-1",
      reviewId: "review-1",
      dispatchId: "dispatch-1",
      sourcePatchsetId: "patchset-1",
      askOccurrences: [{ id: "ask-1", revision: 1 }],
      roundNumber: 1,
      sourceTarget: { kind: "branch", branch: "feat/test" },
      repoRoot: sourceRepoRoot,
      workOrderPrompt: prompt,
      workOrderDigest: sha256Hex(prompt),
      gatePlan: { kind: "absent" },
      revision: 0,
      rerunRequested: false,
      createdAt: 1,
      updatedAt: 1,
      state: { phase: "claimed" },
    };
    const planner = createRoundWorkspacePlanner({
      dataDir: "C:\\Users\\rai\\AppData\\Roaming\\Rennet",
      sourceRepositoryFor: () => patchset.repository,
      now: () => 2,
    });
    const workspace = planner(operation);
    const key = sha256Hex(operation.operationId).slice(0, 32);
    const expectedWorktree = `\\\\wsl.localhost\\Ubuntu\\home\\rai\\repo\\.git\\rennet-round-worktrees\\${key}`;
    expect(workspace.worktreePath).toBe(expectedWorktree);
    expect(workspace.worktreePath).not.toContain("C:\\Users");

    const workerAttempt = { executionId: "worker-1", startedAt: 3 };
    const workerRunning: RoundOperation = {
      ...operation,
      state: {
        phase: "worker-running",
        workspace: { ...workspace, sourceHead: "source-head", preparedAt: 3 },
        worker: workerAttempt,
      },
    };
    const runHandoffTurn = vi.fn(async () => ({
      status: "completed" as const,
      finalText: "done",
      turnDiff: "",
      filesTouched: [],
      harness: { id: "codex" as const, version: "0.146.0" },
    }));
    const receipt = await createRoundWorkerPort({ runHandoffTurn, now: () => 4 })({
      operation: workerRunning,
      attempt: workerAttempt,
    });

    expect(runHandoffTurn).toHaveBeenCalledWith({
      repoRoot: expectedWorktree,
      prompt,
      sessionId: operation.sessionId,
      execution: {
        kind: "wsl",
        distro: "Ubuntu",
        cwd: `/home/rai/repo/.git/rennet-round-worktrees/${key}`,
      },
    });
    expect(receipt.harness).toEqual({ id: "codex", version: "0.146.0" });
  });
});

describe("round source landing composition", () => {
  it("keeps legacy landing as the default and wires the complete injected unit operation", () => {
    const legacyPlan: RoundExecutionPorts["planSourceLanding"] = () => ({
      effect: "source-landing",
      executionId: "legacy-landing",
      baselineCommit: "baseline",
      workerHead: "worker",
      startedAt: 1,
    });
    const legacyLand: RoundExecutionPorts["landSourceChanges"] = async ({ attempt }) => ({
      ...attempt,
      outcome: "applied",
      landedAt: 2,
    });
    const injection = {
      plan: vi.fn(async () => ({
        effect: "source-landing" as const,
        strategy: "exclusive-move-v1" as const,
        executionId: "transactional-landing",
        baselineCommit: "baseline",
        workerHead: "worker",
        startedAt: 3,
        units: [],
        unitReceipts: [],
      })),
      landUnit: vi.fn<NonNullable<RoundExecutionPorts["landSourceUnit"]>>(),
      cleanup: vi.fn<NonNullable<RoundExecutionPorts["cleanupSourceLanding"]>>(),
    } satisfies RoundSourceLandingInjection;

    const defaults = createRoundSourceLandingPorts({
      planLegacy: legacyPlan,
      landLegacy: legacyLand,
    });
    expect(defaults.planSourceLanding).toBe(legacyPlan);
    expect(defaults.landSourceChanges).toBe(legacyLand);
    expect(defaults.landSourceUnit).toBeUndefined();
    expect(defaults.cleanupSourceLanding).toBeUndefined();

    const injected = createRoundSourceLandingPorts({
      planLegacy: legacyPlan,
      landLegacy: legacyLand,
      injection,
    });
    expect(injected.planSourceLanding).toBe(injection.plan);
    expect(injected.landSourceChanges).toBe(legacyLand);
    expect(injected.landSourceUnit).toBe(injection.landUnit);
    expect(injected.cleanupSourceLanding).toBe(injection.cleanup);
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
    const recoveryWorktree = join(workspace, "recovery-worktree");
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
      gatePlan: { kind: "absent" },
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
    const workspaceAttempt = {
      kind: "detached-worktree" as const,
      worktreePath: recoveryWorktree,
      sourceTreeOid: sourceHead,
      sourceParentHead: sourceHead,
      startedAt: 2,
    };
    transition({ phase: "workspace-preparing", workspace: workspaceAttempt }, 2);
    const workspaceReceipt = { ...workspaceAttempt, sourceHead, preparedAt: 3 };
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
    const gate = { outcome: "skipped" as const, reason: "not-configured" as const, settledAt: 6 };
    transition(
      { phase: "gate-settled", workspace: workspaceReceipt, worker: workerReceipt, gate },
      6,
    );
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
        gate,
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
        gate,
        commits,
      },
      8,
    );
    const landingAttempt = {
      effect: "source-landing" as const,
      executionId: "landing-root-recovery",
      baselineCommit: sourceHead,
      workerHead: commits.to,
      startedAt: 9,
    };
    transition(
      {
        phase: "source-landing",
        workspace: workspaceReceipt,
        worker: workerReceipt,
        gate,
        commits,
        landing: landingAttempt,
      },
      9,
    );
    const landing = { ...landingAttempt, outcome: "applied" as const, landedAt: 10 };
    transition(
      {
        phase: "source-landed",
        workspace: workspaceReceipt,
        worker: workerReceipt,
        gate,
        commits,
        landing,
      },
      10,
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
        gate,
        commits,
        landing,
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
        gate,
        commits,
        landing,
        recording,
      },
      12,
    );
    transition(
      {
        phase: "report-drafting",
        workspace: workspaceReceipt,
        worker: workerReceipt,
        gate,
        commits,
        landing,
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
    const worktreeParent = mkdtempSync(join(tmpdir(), "rennet-round-recovery-worktree-"));
    const worktree = join(worktreeParent, "worker");
    dirs.push(dataDir, repo, worktreeParent);
    const git = (cwd: string, ...args: string[]) =>
      execFileSync("git", args, { cwd }).toString().trim();
    git(repo, "init", "-b", "main");
    git(repo, "config", "user.email", "t@t");
    git(repo, "config", "user.name", "t");
    writeFileSync(join(repo, "a.ts"), "export const value = 1;\n");
    git(repo, "add", "a.ts");
    git(repo, "commit", "-m", "base");
    const sourceHead = git(repo, "rev-parse", "HEAD");
    const sourceTreeOid = git(repo, "rev-parse", `${sourceHead}^{tree}`);
    git(repo, "worktree", "add", "--detach", worktree, sourceHead);
    writeFileSync(join(worktree, "a.ts"), "export const value = 2;\n");
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
      gatePlan: { kind: "absent" },
      revision: 0,
      rerunRequested: false,
      createdAt: 1,
      updatedAt: 4,
      state: {
        phase: "worker-running",
        workspace: {
          kind: "detached-worktree",
          worktreePath: worktree,
          sourceTreeOid,
          sourceParentHead: sourceHead,
          sourceHead,
          startedAt: 2,
          preparedAt: 3,
        },
        worker: attempt,
      },
    };
    const operationStore = new RoundOperationStore(join(dataDir, "round-operations"));
    const claimed = operationStore.claimIfIdle({
      ...operation,
      updatedAt: 1,
      state: { phase: "claimed" },
    });
    const workspaceAttempt = {
      kind: "detached-worktree" as const,
      worktreePath: worktree,
      sourceTreeOid,
      sourceParentHead: sourceHead,
      startedAt: 2,
    };
    const preparing = operationStore.compareAndSwap(
      {
        sessionId: claimed.sessionId,
        operationId: claimed.operationId,
        revision: claimed.revision,
      },
      {
        state: { phase: "workspace-preparing", workspace: workspaceAttempt },
        updatedAt: 2,
      },
    );
    const workspace = { ...workspaceAttempt, sourceHead, preparedAt: 3 };
    const prepared = operationStore.compareAndSwap(
      {
        sessionId: preparing.sessionId,
        operationId: preparing.operationId,
        revision: preparing.revision,
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
      runHandoffTurn,
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
      changedPaths: ["a.ts"],
    });
    if (!("outcome" in recovered.state.failure.worker)) {
      throw new Error("expected reconstructed worker receipt");
    }
    expect(recovered.state.failure.worker.diff).toContain("+export const value = 2;");
    expect(recovered.state.failure.reason).toContain(worktree);
    expect(readFileSync(join(worktree, "a.ts"), "utf8")).toBe("export const value = 2;\n");
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

  it("recaptures and starts successor drafting from checkpoint diff even when HEAD stays equal", async () => {
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
    let workerExecution: HandoffTurnExecution | undefined;
    let placeholderObserved = false;
    let roundSessionId = "";
    const server = await createRennetServer({
      dataDir,
      env: { RENNET_DISABLE_HARNESS: "1" },
      runHandoffTurn: async ({ repoRoot, execution }) => {
        workerCalls += 1;
        workerExecution = execution;
        writeFileSync(join(repoRoot, "a.txt"), "base\nreviewed\nworker change\n");
        return {
          status: "completed",
          finalText: "done",
          turnDiff: "diff --git a/a.txt b/a.txt\n+worker change",
          filesTouched: ["a.txt"],
          harness: { id: "codex", version: "0.146.0" },
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
        expect(operation.state.landing.outcome).toBe("applied");
        if (process.platform !== "win32") {
          expect(operation.state.landing.strategy).toBe("exclusive-move-v1");
          if (operation.state.landing.strategy !== "exclusive-move-v1") {
            throw new Error("POSIX production round did not use rooted transactional landing");
          }
          expect(operation.state.landing.units.map((unit) => unit.path)).toEqual(["a.txt"]);
          expect(operation.state.landing.unitReceipts).toHaveLength(1);
          expect(
            existsSync(
              join(repo, roundSourceLandingTransactionPath(operation.state.landing.executionId)),
            ),
          ).toBe(false);
          const infoExcludePath = git(
            "rev-parse",
            "--path-format=absolute",
            "--git-path",
            "info/exclude",
          );
          expect(
            readFileSync(infoExcludePath, "utf8")
              .split(/\r?\n/)
              .filter((line) => line === "/.rennet/round-landings/"),
          ).toHaveLength(1);
        }
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
          gate: { outcome: "skipped", reason: "not-configured" },
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
    expect(workerExecution).toEqual({ kind: "host" });
    expect(git("rev-parse", "HEAD")).toBe(head);
  }, 30_000);

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
      runHandoffTurn: async () => {
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
        expect(operation.state.landing.outcome).toBe("unchanged");
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
      runHandoffTurn: async () => {
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
