import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  BoardMetaStore,
  GenerationStore,
  RoundOperationStore,
  SessionStore,
} from "@rennet/adapters";
import {
  type CommandOutput,
  commandIdFor,
  generationIdForPatchset,
  LENS_KINDS,
  parseCommandOutput,
} from "@rennet/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRennetServer, type RennetServer } from "./create-server";
import {
  OWNER_LOOP_ROUND_ONE_ASK,
  OWNER_LOOP_ROUND_ONE_BODY,
  OWNER_LOOP_ROUND_TWO_ASK,
  OWNER_LOOP_ROUND_TWO_BODY,
  OWNER_LOOP_SEQUENCE_QUOTE,
  OWNER_LOOP_SOURCE,
  OWNER_LOOP_SPEC,
  writeOwnerLoopScriptedHarnessPlan,
} from "./owner-loop-proof-fixture";
import { loadScriptedHarnessPlan, loadScriptedT3Seats } from "./scripted-harness-plan";

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root }).toString().trim();
}

function writeRepoFile(root: string, path: string, contents: string): void {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

function seedTargetRepo(root: string): void {
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "rennet@example.test");
  git(root, "config", "user.name", "Rennet Test");
  git(root, "config", "core.excludesFile", "/dev/null");
  writeRepoFile(root, ".gitignore", ".rennet/\n");
  writeRepoFile(root, OWNER_LOOP_SOURCE, "export const ownerValue = 'base';\n");
  writeRepoFile(
    root,
    "package.json",
    `${JSON.stringify({
      private: true,
      scripts: {
        check:
          "node --eval \"const text = require('node:fs').readFileSync('src/owner.ts', 'utf8'); if (!text.includes('round-')) process.exit(1)\"",
      },
    })}\n`,
  );
  writeRepoFile(
    root,
    OWNER_LOOP_SPEC,
    [
      "## ADDED Requirements",
      "",
      "### Requirement: Keep the owner-loop value source-backed",
      "The system SHALL keep the owner-loop value source-backed.",
      "",
      "#### Scenario: Review the owner loop",
      "WHEN the owner loop is reviewed",
      "THEN the current value remains source-backed.",
      "",
      `Implementation: \`${OWNER_LOOP_SOURCE}\``,
      "",
    ].join("\n"),
  );
  git(root, "add", ".gitignore", OWNER_LOOP_SOURCE, OWNER_LOOP_SPEC, "package.json");
  git(root, "commit", "-qm", "base");
  git(root, "remote", "add", "origin", "git@github.com:owner/target.git");
  git(root, "checkout", "-qb", "feature/shared");
  writeRepoFile(root, OWNER_LOOP_SOURCE, "export const ownerValue = 'reviewed';\n");
  git(root, "add", OWNER_LOOP_SOURCE);
  git(root, "commit", "-qm", "reviewed owner value");
  git(root, "checkout", "-q", "main");
}

function seedDecoyRepo(root: string): void {
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "rennet@example.test");
  git(root, "config", "user.name", "Rennet Test");
  git(root, "config", "core.excludesFile", "/dev/null");
  writeRepoFile(root, ".gitignore", ".rennet/\n");
  writeRepoFile(root, OWNER_LOOP_SOURCE, "export const ownerValue = 'decoy-base';\n");
  git(root, "add", ".gitignore", OWNER_LOOP_SOURCE);
  git(root, "commit", "-qm", "decoy base");
  git(root, "remote", "add", "origin", "git@github.com:owner/decoy.git");
  git(root, "checkout", "-qb", "feature/shared");
  writeRepoFile(root, OWNER_LOOP_SOURCE, "export const ownerValue = 'decoy-reviewed';\n");
  git(root, "add", OWNER_LOOP_SOURCE);
  git(root, "commit", "-qm", "decoy reviewed value");
  git(root, "checkout", "-q", "main");
}

function invocationRecords(path: string): Array<Record<string, unknown>> {
  const text = readFileSync(path, "utf8").trim();
  return text === "" ? [] : text.split("\n").map((line) => JSON.parse(line));
}

async function waitForPreparedSession(server: RennetServer, sessionId: string): Promise<string> {
  let reviewId = "";
  await vi.waitFor(
    async () => {
      const listed = parseCommandOutput("session.list", await server.dispatch("session.list", {}));
      const session = listed.sessions.find((candidate) => candidate.id === sessionId);
      if (session?.preparation?.status === "failed") {
        throw new Error(session.preparation.reason);
      }
      expect(session?.preparation).toBeUndefined();
      expect(session?.reviewId).toBeDefined();
      reviewId = session?.reviewId ?? "";
    },
    { timeout: 30_000, interval: 25 },
  );
  return reviewId;
}

async function waitForFiveBoards(
  server: RennetServer,
  reviewId: string,
  generation: string,
  patchsetId: string,
): Promise<Map<string, string>> {
  const boardIds = new Map<string, string>();
  await vi.waitFor(
    async () => {
      for (const lens of LENS_KINDS) {
        const read = parseCommandOutput(
          "board.read",
          await server.dispatch("board.read", { reviewId, generation, lens }),
        );
        expect(read.failure).toBeUndefined();
        expect(read.absence).toBeUndefined();
        expect(read.board?.generation).toBe(generation);
        if (read.board !== null) boardIds.set(lens, read.board.boardId);
        if (!read.board?.elements.some((element) => element.kind === "code_ref")) {
          throw new Error(`${lens} board lost its code anchor: ${JSON.stringify(read.board)}`);
        }
        const refs = read.board?.elements.filter((element) => element.kind === "code_ref") ?? [];
        expect(refs.every((element) => element.data.path === OWNER_LOOP_SOURCE)).toBe(true);
        const currentLensRef = refs.find((element) => element.id === `${lens}-code`);
        if (currentLensRef?.data.patchset_id !== patchsetId) {
          throw new Error(
            `${lens} board lost its current-patchset citation: ${JSON.stringify({ patchsetId, refs })}`,
          );
        }
      }
    },
    { timeout: 30_000, interval: 50 },
  );
  return boardIds;
}

async function expectFrozenBoardsRemainReadable(
  server: RennetServer,
  reviewId: string,
  generation: string,
  boardIds: ReadonlyMap<string, string>,
): Promise<void> {
  for (const lens of LENS_KINDS) {
    const read = parseCommandOutput(
      "board.read",
      await server.dispatch("board.read", { reviewId, generation, lens }),
    );
    expect(read.board?.generation).toBe(generation);
    expect(read.board?.boardId).toBe(boardIds.get(lens));
  }
}

async function waitForRoundReturn(
  server: RennetServer,
  dataDir: string,
  sessionId: string,
  reviewId: string,
  expectedRounds: number,
  consumedAsk: string,
  invocationLog: string,
): Promise<CommandOutput<"session.rounds">["records"]> {
  let records: CommandOutput<"session.rounds">["records"] = [];
  await vi.waitFor(
    async () => {
      const rounds = parseCommandOutput(
        "session.rounds",
        await server.dispatch("session.rounds", { reviewId }),
      );
      const asks = parseCommandOutput(
        "ask.read",
        await server.dispatch("ask.read", { sessionId: reviewId }),
      );
      const operationStore = new RoundOperationStore(join(dataDir, "round-operations"));
      const operation = operationStore.read(sessionId);
      operationStore.close();
      if (operation?.state.phase === "failed") {
        throw new Error(
          `owner-loop round failed: ${operation.state.failure.reason}; rounds=${JSON.stringify(rounds.records)}; invocations=${JSON.stringify(invocationRecords(invocationLog))}`,
        );
      }
      expect(rounds.records).toHaveLength(expectedRounds);
      expect(asks.projection.stagedAsks[consumedAsk]).toBeUndefined();
      expect(operation?.state.phase).toBe("completed");
      if (operation?.state.phase === "completed") {
        expect(operation.state.returnedAt).toBeDefined();
        expect(operation.state.landing.strategy).toBe("branch-ref-v1");
        if (operation.state.landing.strategy === "branch-ref-v1") {
          expect(operation.state.landing.branch).toBe("feature/shared");
        }
      }
      records = rounds.records;
    },
    { timeout: 45_000, interval: 50 },
  );
  return records;
}

describe("#685 owner loop through a real server", () => {
  const dirs: string[] = [];
  const shutdowns: Array<() => void> = [];

  afterEach(() => {
    for (const shutdown of shutdowns.splice(0)) shutdown();
    vi.unstubAllEnvs();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("keeps one exact repository coherent across Context Map, five boards, two rounds, and restart", async () => {
    const root = mkdtempSync(join(tmpdir(), "rennet-owner-loop-685-"));
    const home = join(root, "home");
    const dataDir = join(root, "data");
    const workspace = join(root, "workspace");
    mkdirSync(join(workspace, "target"), { recursive: true });
    mkdirSync(join(workspace, "decoy"), { recursive: true });
    const target = realpathSync(join(workspace, "target"));
    const decoy = realpathSync(join(workspace, "decoy"));
    mkdirSync(home, { recursive: true });
    mkdirSync(dataDir, { recursive: true });
    dirs.push(root);
    seedTargetRepo(target);
    seedDecoyRepo(decoy);
    const { planPath, invocationLog } = writeOwnerLoopScriptedHarnessPlan(root);
    // The board seats run on the sidecar and nowhere else (session-bound-workspace 5.7),
    // so the same plan is served as SEAT THREADS: one thread per seat per generation, with
    // every attempt a further turn on it. `scriptedSeats.threads` is what the assertions
    // below read to see which seat opened which thread, and with what.
    const scriptedSeats = loadScriptedT3Seats(planPath);
    vi.stubEnv("HOME", home);
    const env = {
      ...process.env,
      HOME: home,
      RENNET_DISABLE_HARNESS: "1",
    };

    const first = await createRennetServer({
      dataDir,
      env,
      testHarnessPort: loadScriptedHarnessPlan(planPath),
      testT3Seats: scriptedSeats.resolve,
    });
    shutdowns.push(first.shutdown);
    const added = parseCommandOutput(
      "projects.add",
      await first.dispatch("projects.add", {
        commandId: randomUUID(),
        discovery: {
          path: workspace,
          kind: "workspace",
          repos: [
            { name: "target", path: target, branches: 2 },
            { name: "decoy", path: decoy, branches: 2 },
          ],
          primaryBranch: "main",
          source: "local",
        },
        includedRepos: ["target", "decoy"],
        primaryBranch: "main",
      }),
    );
    const context = parseCommandOutput(
      "project.process",
      await first.dispatch("project.process", {
        commandId: commandIdFor(`project.process:${added.project.id}`),
        projectId: added.project.id,
      }),
    );
    if (context.run?.status === "failed") throw new Error(context.run.reason);
    expect(context.run?.status).toBe("done");
    expect(context.repos.map((repo) => [repo.path, repo.ok])).toEqual([
      [target, true],
      [decoy, true],
    ]);
    const minted = parseCommandOutput(
      "session.mint",
      await first.dispatch("session.mint", {
        projectId: added.project.id,
        commandId: randomUUID(),
        branch: "feature/shared",
        repository: "owner/target",
      }),
    );
    expect(minted.session).not.toBeNull();
    const sessionId = minted.session?.id ?? "";
    const reviewId = await waitForPreparedSession(first, sessionId);
    const initial = parseCommandOutput(
      "review.load",
      await first.dispatch("review.load", { commandId: randomUUID(), reviewId }),
    ).review;
    expect(initial.repositoryRoot).toBe(target);
    expect(initial.patchsets.at(-1)?.files.map((file) => file.path)).toContain(OWNER_LOOP_SOURCE);
    expect(git(decoy, "show", `feature/shared:${OWNER_LOOP_SOURCE}`)).toContain("decoy-reviewed");

    const initialGeneration = generationIdForPatchset(initial.activePatchsetId);
    const initialBoardIds = await waitForFiveBoards(
      first,
      reviewId,
      initialGeneration,
      initial.activePatchsetId,
    );
    // Every board that just landed came off a SIDECAR SEAT THREAD, one per seat, opened in
    // the checkout the review is bound to — there is no ephemeral leg left for one to have
    // taken (session-bound-workspace 5.7). The seam recorded the whole `threadFor` input,
    // so the binding fields are asserted as the runtime actually passed them.
    const seatsOfGeneration = scriptedSeats.threads.filter(({ threadId }) =>
      threadId.includes(initialGeneration),
    );
    expect(seatsOfGeneration.map(({ seat }) => seat).sort()).toEqual([
      "decisions",
      "design",
      "flagged-claude",
      "noise",
      "sequence",
    ]);
    for (const thread of seatsOfGeneration) {
      expect(thread.created.provider, thread.seat).toBe("claudeAgent");
      expect(thread.created.model, thread.seat).toEqual(expect.any(String));
      // One turn per seat on a clean draft: the board passed lint, so no repair followed.
      expect(thread.prompts, thread.seat).toHaveLength(1);
      // The seat is pointed at the checkout and at its context directory, never handed
      // the change: the drafting turn names the diff command and the directory, and the
      // agent reads what it decides it needs.
      expect(thread.prompts[0], thread.seat).toContain("git diff");
      expect(thread.prompts[0], thread.seat).toContain(".rennet/context/");
    }

    const missing = parseCommandOutput(
      "board.read",
      await first.dispatch("board.read", {
        reviewId,
        generation: "gen:missing-positive-control",
        lens: "sequence",
      }),
    );
    expect(missing.board).toBeNull();

    await first.dispatch("ask.quoteOpen", {
      sessionId: reviewId,
      threadId: "owner-loop-quote",
      thread: {
        anchor: OWNER_LOOP_SEQUENCE_QUOTE,
        target: "sequence-step",
        generation: initialGeneration,
        lifecycle: "attached",
        messages: [{ author: "user", text: "Keep this reading anchor." }],
      },
    });
    await first.dispatch("ask.stage", {
      sessionId: reviewId,
      ask: {
        id: OWNER_LOOP_ROUND_ONE_ASK,
        anchor: `${OWNER_LOOP_SOURCE}:1`,
        type: "request-change",
        body: OWNER_LOOP_ROUND_ONE_BODY,
      },
    });
    const roundOneDispatch = parseCommandOutput(
      "round.dispatch",
      await first.dispatch("round.dispatch", { reviewId }),
    );
    expect(roundOneDispatch.dispatched).toBe(true);
    const afterRoundOne = await waitForRoundReturn(
      first,
      dataDir,
      sessionId,
      reviewId,
      1,
      OWNER_LOOP_ROUND_ONE_ASK,
      invocationLog,
    );
    const roundOneGeneration = afterRoundOne[0]?.boardGeneration ?? "";
    expect(afterRoundOne[0]?.run?.gate).toMatchObject({
      outcome: "passed",
      command: "npm run check",
    });
    expect(roundOneGeneration).not.toBe(initialGeneration);
    expect(afterRoundOne[0]?.frozenPredecessor).toBe(initialGeneration);

    // session-context-files: PRODUCTION wired the one writer. `createRennetServer` builds
    // the rounds runtime, and the dep that carries the writer is optional — so a
    // composition root that forgot it still compiles and every seat silently drafts with
    // no context directory at all. This asserts the daemon's own round wrote the
    // classifier's evidence under the root the seats were dispatched with, and stamped
    // that root on the session so the archive purge can find it again. Delete the
    // `writeSessionContext` line in `create-server.ts` and this reddens.
    const sessionStore = new SessionStore(join(dataDir, "sessions"));
    const roundOneSession = sessionStore.load(sessionId);
    expect(roundOneSession?.contextRoot).toBeDefined();
    const contextDir = join(roundOneSession?.contextRoot ?? "", ".rennet", "context", sessionId);
    expect(existsSync(join(contextDir, "evidence.json"))).toBe(true);
    expect(existsSync(join(contextDir, "round.json"))).toBe(true);
    const operationStore = new RoundOperationStore(join(dataDir, "round-operations"));
    const completedRoundOne = operationStore.read(sessionId);
    operationStore.close();
    if (
      completedRoundOne?.state.phase !== "completed" ||
      completedRoundOne.state.result.kind !== "changed"
    ) {
      throw new Error("round one completed without its changed-operation receipt");
    }
    const reportHandoff = completedRoundOne.state.result.report.handoff;
    if (reportHandoff === undefined) {
      throw new Error("round one completed without its durable report handoff");
    }
    const reportMeta = new BoardMetaStore(join(dataDir, "board-meta")).load(
      reportHandoff.reportBoardId,
    );
    expect(reportMeta).toMatchObject({
      lens: "report",
      boardId: reportHandoff.reportBoardId,
      session: sessionId,
      generation: reportHandoff.generation,
      document: reportHandoff.report.document,
    });
    const hotRoundEvents = parseCommandOutput(
      "session.roundEvents",
      await first.dispatch("session.roundEvents", { reviewId }),
    );
    expect(
      hotRoundEvents.events.find(
        (event) =>
          event.type === "report" &&
          event.operationId === completedRoundOne.operationId &&
          event.reportBoardId === reportHandoff.reportBoardId,
      ),
    ).toMatchObject({
      type: "report",
      operationRevision: reportHandoff.operationRevision,
      report: reportHandoff.report,
    });
    const roundOneBoardIds = await waitForFiveBoards(
      first,
      reviewId,
      roundOneGeneration,
      afterRoundOne[0]?.resultPatchsetId ?? "",
    );
    const afterRoundOneAsks = parseCommandOutput(
      "ask.read",
      await first.dispatch("ask.read", { sessionId: reviewId }),
    );
    expect(afterRoundOneAsks.projection.quoteThreads["owner-loop-quote"]).toMatchObject({
      lifecycle: "attached",
      target: "sequence-step",
      generation: roundOneGeneration,
    });

    first.shutdown();
    shutdowns.pop();
    const editRecordsBeforeRestart = invocationRecords(invocationLog).filter(
      (record) => record.kind === "edit",
    );
    expect(editRecordsBeforeRestart.map((record) => record.stepId)).toEqual(["round-one-edit"]);

    const restarted = await createRennetServer({
      dataDir,
      env,
      testHarnessPort: loadScriptedHarnessPlan(planPath),
      testT3Seats: scriptedSeats.resolve,
    });
    shutdowns.push(restarted.shutdown);
    parseCommandOutput("projects.list", await restarted.dispatch("projects.list", {}));
    const durableRounds = parseCommandOutput(
      "session.rounds",
      await restarted.dispatch("session.rounds", { reviewId }),
    );
    expect(durableRounds.records).toHaveLength(1);
    const coldRoundEvents = parseCommandOutput(
      "session.roundEvents",
      await restarted.dispatch("session.roundEvents", { reviewId }),
    );
    expect(
      coldRoundEvents.events.find(
        (event) =>
          event.type === "report" &&
          event.operationId === completedRoundOne.operationId &&
          event.reportBoardId === reportHandoff.reportBoardId,
      ),
    ).toMatchObject({
      type: "report",
      operationRevision: reportHandoff.operationRevision,
      report: reportHandoff.report,
    });
    expect(
      invocationRecords(invocationLog).filter((record) => record.kind === "edit"),
    ).toHaveLength(1);

    await restarted.dispatch("ask.stage", {
      sessionId: reviewId,
      ask: {
        id: OWNER_LOOP_ROUND_TWO_ASK,
        anchor: `${OWNER_LOOP_SOURCE}:1`,
        type: "request-change",
        body: OWNER_LOOP_ROUND_TWO_BODY,
      },
    });
    const roundTwoDispatch = parseCommandOutput(
      "round.dispatch",
      await restarted.dispatch("round.dispatch", { reviewId }),
    );
    expect(roundTwoDispatch.dispatched).toBe(true);
    const afterRoundTwo = await waitForRoundReturn(
      restarted,
      dataDir,
      sessionId,
      reviewId,
      2,
      OWNER_LOOP_ROUND_TWO_ASK,
      invocationLog,
    );
    const roundTwoGeneration = afterRoundTwo[1]?.boardGeneration ?? "";
    expect(afterRoundTwo[1]?.run?.gate).toMatchObject({
      outcome: "passed",
      command: "npm run check",
    });
    expect(roundTwoGeneration).not.toBe(roundOneGeneration);
    expect(afterRoundTwo[1]?.frozenPredecessor).toBe(roundOneGeneration);
    await waitForFiveBoards(
      restarted,
      reviewId,
      roundTwoGeneration,
      afterRoundTwo[1]?.resultPatchsetId ?? "",
    );
    const afterRoundTwoAsks = parseCommandOutput(
      "ask.read",
      await restarted.dispatch("ask.read", { sessionId: reviewId }),
    );
    expect(afterRoundTwoAsks.projection.quoteThreads["owner-loop-quote"]).toMatchObject({
      lifecycle: "attached",
      target: "sequence-step",
      generation: roundTwoGeneration,
    });
    await expectFrozenBoardsRemainReadable(restarted, reviewId, initialGeneration, initialBoardIds);
    await expectFrozenBoardsRemainReadable(
      restarted,
      reviewId,
      roundOneGeneration,
      roundOneBoardIds,
    );

    const generations = new GenerationStore(join(dataDir, "generations"));
    expect(generations.load(initialGeneration)?.status).toBe("frozen");
    expect(generations.load(roundOneGeneration)?.status).toBe("frozen");
    expect(generations.load(roundTwoGeneration)?.status).toBe("live");
    const finalReview = parseCommandOutput(
      "review.load",
      await restarted.dispatch("review.load", { commandId: randomUUID(), reviewId }),
    ).review;
    expect(finalReview.activePatchsetId).toBe(generations.load(roundTwoGeneration)?.patchsetId);
    expect(git(target, "branch", "--show-current")).toBe("main");
    expect(readFileSync(join(target, OWNER_LOOP_SOURCE), "utf8")).toBe(
      "export const ownerValue = 'base';\n",
    );
    expect(git(target, "show", `main:${OWNER_LOOP_SOURCE}`)).toBe(
      "export const ownerValue = 'base';",
    );
    expect(git(target, "show", `feature/shared:${OWNER_LOOP_SOURCE}`)).toBe(
      "export const ownerValue = 'round-two';",
    );
    expect(git(target, "status", "--porcelain")).toBe("");
    expect(git(decoy, "branch", "--show-current")).toBe("main");
    expect(readFileSync(join(decoy, OWNER_LOOP_SOURCE), "utf8")).toBe(
      "export const ownerValue = 'decoy-base';\n",
    );
    expect(git(decoy, "show", `feature/shared:${OWNER_LOOP_SOURCE}`)).toBe(
      "export const ownerValue = 'decoy-reviewed';",
    );
    expect(git(decoy, "status", "--porcelain")).toBe("");

    const editRecords = invocationRecords(invocationLog).filter((record) => record.kind === "edit");
    expect(editRecords.map((record) => record.stepId)).toEqual([
      "round-one-edit",
      "round-two-edit",
    ]);
    expect(editRecords.every((record) => record.cwd !== target)).toBe(true);
    expect(
      editRecords.every(
        (record) =>
          typeof record.cwd === "string" &&
          record.cwd.startsWith(realpathSync(join(dataDir, "round-worktrees"))),
      ),
    ).toBe(true);
    expect(editRecords[1]?.resumed).toBe(true);
    const records = invocationRecords(invocationLog);
    const targetBoardSteps = new Set([
      "design",
      "sequence",
      "decisions",
      "flagged",
      "noise",
      "report-round-one",
      "report-round-two",
      "post-process",
    ]);
    // Board seats draft in the review's EVIDENCE worktree — a detached checkout
    // pinned at the reviewed head — never in the ambient clone, whose checked-out
    // ref (main, holding BASE bytes) is unrelated to the reviewed branch.
    const evidenceRoot = realpathSync(join(dataDir, "worktrees", "review", reviewId));
    const boardRecords = records.filter((record) => targetBoardSteps.has(String(record.stepId)));
    expect(boardRecords.length).toBeGreaterThan(0);
    expect(
      boardRecords.every(
        (record) => typeof record.cwd === "string" && realpathSync(record.cwd) === evidenceRoot,
      ),
    ).toBe(true);
    expect(boardRecords.some((record) => record.cwd === target)).toBe(false);
    // The load-bearing half: a seat reading the source file at its cwd observes
    // the REVIEWED bytes (the final round's content), not the clone's base bytes.
    expect(readFileSync(join(evidenceRoot, OWNER_LOOP_SOURCE), "utf8")).toBe(
      "export const ownerValue = 'round-two';\n",
    );
    for (const stepId of ["design", "sequence", "decisions", "flagged", "noise"]) {
      expect(records.filter((record) => record.stepId === stepId)).toHaveLength(3);
    }
    expect(records.filter((record) => record.stepId === "report-round-one")).toHaveLength(1);
    expect(records.filter((record) => record.stepId === "report-round-two")).toHaveLength(1);
    // 3.7 — the handoff compose turn RAN, once per dispatched round. Before the plan
    // carried a step for it the scripted port had no answer, the compose port failed and
    // the core router fell to the mechanical floor: a real turn on the owner loop's path
    // that this proof went green without ever exercising. Asserting the count is what
    // makes the step load-bearing — deleting it takes this to 0, not to a silent floor.
    expect(records.filter((record) => record.stepId === "compose-work-order")).toHaveLength(2);
  }, 120_000);

  // A dev daemon whose sidecar bundle is not built used to reach the lanes as
  // "this caller composed no sidecar seam" — true of the composition, useless to whoever
  // has to fix it. `create-server.ts` wires the seat runtime unconditionally now, so the
  // supervisor's own answer is what the reader gets.
  it("names the unbuilt sidecar bundle on every lane when no bundle path resolved", async () => {
    const root = mkdtempSync(join(tmpdir(), "rennet-no-bundle-"));
    const home = join(root, "home");
    const dataDir = join(root, "data");
    const workspace = join(root, "workspace");
    mkdirSync(join(workspace, "target"), { recursive: true });
    const target = realpathSync(join(workspace, "target"));
    mkdirSync(home, { recursive: true });
    mkdirSync(dataDir, { recursive: true });
    dirs.push(root);
    seedTargetRepo(target);
    const { planPath } = writeOwnerLoopScriptedHarnessPlan(root);
    vi.stubEnv("HOME", home);

    // No `t3BundlePath` and no `testT3Seats`: exactly the shape a `pnpm dev` daemon has
    // before `nx run t3code-server:build`. The scripted harness is still resolved, so the
    // council routes normally and the ONLY thing missing is the sidecar.
    const server = await createRennetServer({
      dataDir,
      env: { ...process.env, HOME: home, RENNET_DISABLE_HARNESS: "1" },
      testHarnessPort: loadScriptedHarnessPlan(planPath),
    });
    shutdowns.push(server.shutdown);
    const added = parseCommandOutput(
      "projects.add",
      await server.dispatch("projects.add", {
        commandId: randomUUID(),
        discovery: {
          path: workspace,
          kind: "workspace",
          repos: [{ name: "target", path: target, branches: 2 }],
          primaryBranch: "main",
          source: "local",
        },
        includedRepos: ["target"],
        primaryBranch: "main",
      }),
    );
    await server.dispatch("project.process", {
      commandId: commandIdFor(`project.process:${added.project.id}`),
      projectId: added.project.id,
    });
    const minted = parseCommandOutput(
      "session.mint",
      await server.dispatch("session.mint", {
        projectId: added.project.id,
        commandId: randomUUID(),
        branch: "feature/shared",
        repository: "owner/target",
      }),
    );
    // Preparation fails, because no lane can draft — and the reason it reports is the
    // supervisor's own, per lens, not the composition's.
    const reason = await waitForPreparedSession(server, minted.session?.id ?? "").then(
      () => "the session prepared with no sidecar",
      (error: unknown) => String(error),
    );
    for (const lens of LENS_KINDS) expect(reason, lens).toContain(`${lens}:`);
    expect(reason).toContain("T3 sidecar unavailable");
    // The CAUSE, not the composition: the path the reader has to build.
    expect(reason).toContain("vendor/t3code/apps/server/dist/bin.mjs");
    expect(reason).not.toContain("composed no sidecar seam");
  }, 60_000);
});
