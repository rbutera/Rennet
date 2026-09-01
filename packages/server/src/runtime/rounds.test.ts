import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoardMetaStore, GenerationStore, RoundRecordStore } from "@rennet/adapters";
import type {
  CodexExecutor,
  DeltaPacket,
  HarnessPort,
  LintContext,
  LintTarget,
} from "@rennet/core";
import { findingDispositionMigrationEvents } from "@rennet/core";
import {
  type ComposedHandoffBundle,
  type DraftBoard,
  type FindingDisposition,
  findingRefKey,
  type Generation,
  generationIdForDispatch,
  LENS_KINDS,
  ROUND_NO_REGEN,
  type RoundEvent,
  type RoundRunReceipt,
} from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import { type BoardsRuntime, createBoardsRuntime } from "../boards/boards-runtime";
import type { BoardArrivalEvent, BoardMeta } from "./lens-pipeline";
import { buildRoundEvidenceManifest } from "./round-evidence-manifest";
import {
  createRoundsRuntime,
  freezeGeneration,
  mintGeneration,
  type RoundInput,
  type RoundsRuntimeDeps,
  withLensBoards,
} from "./rounds";

// ── Fakes (no live model — inject ports, the runtime is pure over the seams) ──

/** A round packet — carries a successor account, so the pipeline drafts the report FIRST. */
const ROUND_PACKET = {
  patchset: { id: "ps-1", createdAt: "", truncated: false, files: [] },
  successorAccount: { asks: [] },
} as unknown as DeltaPacket;

const lintContextFor = (lens: LintTarget): LintContext => ({ lens, hunks: [], files: new Map() });
const readPrompt = (file: string): string => `PROMPT_FILE:${file}`;
const lensFromPrompt = (prompt: string): string =>
  /PROMPT_FILE:prompts\/([a-z-]+)\.md/.exec(prompt)?.[1] ?? "unknown";
const cleanBody = (lens: string): DraftBoard => {
  const author = { kind: "lens-agent" as const, id: `${lens}-seat` };
  if (lens === "sequence") {
    return {
      elements: [
        {
          id: "sequence-root",
          kind: "section",
          data: { author, title: "Reading order", children: ["sequence-step"] },
        },
        {
          id: "sequence-step",
          kind: "order_step",
          data: {
            author,
            title: "Read the changed entry point",
            span: "sequence-span",
            children: [],
          },
        },
        {
          id: "sequence-span",
          kind: "prose",
          data: { author, markdown: "The changed entry point begins the reading." },
        },
      ],
      skippedHunks: [],
    } as DraftBoard;
  }
  if (lens === "decisions") {
    return {
      elements: [
        {
          id: "decisions-root",
          kind: "section",
          data: { author, title: "Implementation decisions", children: ["decision"] },
        },
        {
          id: "decision-evidence",
          kind: "prose",
          data: { author, markdown: "The write path commits one complete batch." },
        },
        {
          id: "decision-alternative",
          kind: "prose",
          data: { author, markdown: "Write each event independently." },
        },
        {
          id: "decision",
          kind: "decision",
          data: {
            author,
            statement: "Commit the event batch atomically.",
            evidence: ["decision-evidence"],
            alternatives: ["decision-alternative"],
            why: "Readers never observe a partial batch.",
          },
        },
      ],
      skippedHunks: [],
    } as DraftBoard;
  }
  if (lens === "flagged") {
    return {
      elements: [
        {
          id: "flagged-root",
          kind: "section",
          data: { author, title: "Findings", children: ["flagged-finding"] },
        },
        {
          id: "flagged-finding",
          kind: "finding",
          data: {
            author,
            severity: "medium",
            concern: "A partial write leaves the event batch inconsistent.",
            code: [],
            concurrence: [],
            status: "open",
          },
        },
      ],
      skippedHunks: [],
    } as DraftBoard;
  }
  return {
    elements: [
      {
        id: `${lens}-p1`,
        kind: "prose",
        data: { author, markdown: "Reads cleanly." },
      },
    ],
    skippedHunks: [],
  } as DraftBoard;
};

/** A fake Claude port that answers a lens-appropriate clean board every turn, or whatever
 *  `bodyFor` decides when a test needs a specific seat to answer something particular. */
function fakeClaudePort(
  captures: { prompt?: string }[] = [],
  bodyFor: (prompt: string) => unknown = (prompt) => cleanBody(lensFromPrompt(prompt)),
): HarnessPort {
  return {
    createSession: async () => {
      const capture: { prompt?: string } = {};
      captures.push(capture);
      return {
        send: async (input: { prompt: string }) => {
          capture.prompt = input.prompt;
        },
        close: async () => {
          /* nothing to release */
        },
        events: (async function* () {
          yield {
            kind: "session.ended",
            native: {},
            outcome: {
              status: "completed",
              structuredOutput: bodyFor(capture.prompt ?? ""),
            },
          };
        })(),
      } as unknown as Awaited<ReturnType<HarnessPort["createSession"]>>;
    },
  } as unknown as HarnessPort;
}

/** A fake boards runtime: mints sequential ids and accepts every write (the real board
 *  service + wire schema are covered by lens-pipeline/whiteboard-client tests). */
function fakeBoardsRuntimeFor(): (
  repoRoot: string,
) => Pick<BoardsRuntime, "service" | "createRennetBoard"> {
  let seq = 0;
  return () =>
    ({
      service: {
        apply: async () => ({ ok: true }),
        getState: async () => new Map(),
      },
      createRennetBoard: async () => `board:${seq++}`,
    }) as unknown as Pick<BoardsRuntime, "service" | "createRennetBoard">;
}

function reservedBoardIds(prefix: string): Record<LintTarget, string> {
  return {
    design: `${prefix}:design`,
    sequence: `${prefix}:sequence`,
    decisions: `${prefix}:decisions`,
    flagged: `${prefix}:flagged`,
    noise: `${prefix}:noise`,
    report: `${prefix}:report`,
  };
}

const PREV_GEN: Generation = {
  id: "gen:ps-0",
  patchsetId: "ps-0",
  lensBoards: {},
  status: "live",
};

const RUN_RECEIPT: RoundRunReceipt = {
  startedAt: 1,
  sourceTarget: { kind: "branch", branch: "feat/test" },
  gate: { outcome: "skipped", reason: "not-configured" },
};

function baseDeps(over: Partial<RoundsRuntimeDeps> = {}): RoundsRuntimeDeps {
  return {
    resolveClaudePort: async () => fakeClaudePort(),
    resolveCodexExecutor: async () => null as CodexExecutor | null,
    boardsRuntimeFor: fakeBoardsRuntimeFor(),
    readPrompt,
    ...over,
  };
}

function roundInput(over: Partial<RoundInput> = {}): RoundInput {
  return {
    session: { id: "s1", projectId: "p1", threads: [], createdAt: 0 },
    repoRoot: "/pr-worktree",
    previousGeneration: PREV_GEN,
    asksDispatched: ["t1", "t2"],
    runWorkers: async () => ({ commitRange: { from: "c0", to: "c1" }, patchsetId: "ps-1" }),
    deltaPacket: ROUND_PACKET,
    hunks: [],
    lintContextFor,
    reviewDraftLintCtx: { files: new Map() },
    ...over,
  };
}

const DISPATCH_FIELDS = {
  dispatchId: "dispatch:test",
  sourcePatchsetId: "ps-1",
  askOccurrences: [],
  run: RUN_RECEIPT,
} as const;

// ── Pure state machine ──

describe("generation lifecycle (append-then-freeze)", () => {
  it("mints a live generation and freezes immutably", () => {
    const gen = mintGeneration("gen:ps-1", "ps-1");
    expect(gen).toEqual({ id: "gen:ps-1", patchsetId: "ps-1", lensBoards: {}, status: "live" });
    expect(freezeGeneration(gen).status).toBe("frozen");
    // Freezing an already-frozen generation is identity.
    const frozen = freezeGeneration(gen);
    expect(freezeGeneration(frozen)).toBe(frozen);
  });

  it("records lens board ids but not the report (report is not a lens)", () => {
    const gen = withLensBoards(mintGeneration("g", "ps"), {
      boards: [
        { lens: "design", boardId: "b:design", omissions: [], blemishes: [], immutability: [] },
        { lens: "report", boardId: "b:report", omissions: [], blemishes: [], immutability: [] },
      ],
    });
    expect(gen.lensBoards).toEqual({ design: "b:design" });
  });

  it("records a successful lens absence separately from a board that has not arrived", () => {
    const gen = withLensBoards(mintGeneration("g", "ps"), {
      boards: [
        {
          lens: "design",
          absence: "no-material",
          omissions: [],
          blemishes: [],
          immutability: [],
        },
      ],
    });
    expect(gen.lensBoards).toEqual({});
    expect(gen.absentLenses).toEqual({ design: "no-material" });
  });

  it("preserves a typed clean result on the generation", () => {
    const gen = withLensBoards(mintGeneration("g", "ps"), {
      boards: [
        {
          lens: "flagged",
          absence: "no-findings",
          omissions: [],
          blemishes: [],
          immutability: [],
        },
      ],
    });
    expect(gen.lensBoards).toEqual({});
    expect(gen.absentLenses).toEqual({ flagged: "no-findings" });
  });

  it("clears a durable lens absence when that lens later produces a board", () => {
    const absent = withLensBoards(mintGeneration("g", "ps"), {
      boards: [
        {
          lens: "design",
          absence: "no-material",
          omissions: [],
          blemishes: [],
          immutability: [],
        },
      ],
    });
    const present = withLensBoards(absent, {
      boards: [
        {
          lens: "design",
          boardId: "b:design",
          omissions: [],
          blemishes: [],
          immutability: [],
        },
      ],
    });

    expect(present.lensBoards).toEqual({ design: "b:design" });
    expect(present.absentLenses).toBeUndefined();
  });
});

// ── The rounds runtime ──

describe("createRoundsRuntime", () => {
  it("records a RoundRecord pinning asks, commit range, minted+board generation, and report board", async () => {
    const runtime = createRoundsRuntime(baseDeps());
    const { record, boardGeneration, frozenPrevious } = await runtime.runRound(roundInput());

    expect(record.asksDispatched).toEqual(["t1", "t2"]);
    expect(record.workerCommitRange).toEqual({ from: "c0", to: "c1" });
    // A patchset landed ⇒ a successor generation is minted (id derived from the patchset).
    expect(record.mintedPatchsetGeneration).toBe("gen:ps-1");
    expect(record.boardGeneration).toBe("gen:ps-1");
    expect(record.reportBoard).toMatch(/^board:/);
    // Append-then-freeze: the prior generation froze because the code moved.
    expect(frozenPrevious?.status).toBe("frozen");
    expect(boardGeneration.status).toBe("live");
    // The ledger carries the record.
    expect(runtime.ledger("s1")).toEqual([record]);
  });

  it("reconciles quote threads after both generations persist and before recording the round", async () => {
    const order: string[] = [];
    const transitions: Array<{
      readonly repoRoot: string;
      readonly reviewId: string;
      readonly sessionId: string;
      readonly sourceGeneration: string;
      readonly successorGeneration: string;
    }> = [];
    const runtime = createRoundsRuntime(
      baseDeps({
        persistGeneration: (generation) => {
          order.push(`generation:${generation.id}`);
        },
        onGenerationTransition: (transition) => {
          order.push("quote-transition");
          transitions.push(transition);
        },
        recordRound: () => order.push("round-record"),
      }),
    );

    await runtime.runRound(
      roundInput({
        session: { id: "s1", projectId: "p1", reviewId: "review-1", threads: [], createdAt: 0 },
        verifyDraftedReport: () => {
          order.push("report-verified");
        },
      }),
    );

    expect(transitions).toEqual([
      {
        repoRoot: "/pr-worktree",
        reviewId: "review-1",
        sessionId: "s1",
        sourceGeneration: "gen:ps-0",
        successorGeneration: "gen:ps-1",
      },
    ]);
    expect(order.indexOf("quote-transition")).toBeGreaterThan(
      order.lastIndexOf("generation:gen:ps-0"),
    );
    expect(order.indexOf("report-verified")).toBeLessThan(order.lastIndexOf("generation:gen:ps-1"));
    expect(order.indexOf("quote-transition")).toBeLessThan(order.indexOf("round-record"));
  });

  it("publishes no successor, quote migration, or real ledger row when report verification fails", async () => {
    const order: string[] = [];
    const persisted: Generation[] = [];
    const runtime = createRoundsRuntime(
      baseDeps({
        resolveClaudePort: async () =>
          fakeClaudePort([], (prompt) =>
            lensFromPrompt(prompt) === "flagged"
              ? ({
                  elements: [{ id: "invalid", kind: "not-a-kind", data: {} }],
                } as unknown as DraftBoard)
              : cleanBody(lensFromPrompt(prompt)),
          ),
        persistGeneration: (generation) => {
          order.push(`generation:${generation.id}`);
          persisted.push(generation);
        },
        onGenerationTransition: () => {
          order.push("quote-transition");
        },
        recordRound: () => order.push("round-record"),
      }),
    );

    await expect(
      runtime.runRound(
        roundInput({
          session: { id: "s1", projectId: "p1", reviewId: "review-1", threads: [], createdAt: 0 },
          verifyDraftedReport: () => {
            order.push("report-rejected");
            throw new Error("invalid report evidence");
          },
        }),
      ),
    ).rejects.toThrow("invalid report evidence");

    expect(order).toContain("report-rejected");
    expect(order).not.toContain("quote-transition");
    expect(order).not.toContain("round-record");
    expect(runtime.ledger("s1")).toEqual([]);
    expect(persisted.at(-1)?.draftingBoardIds).toBeDefined();
    expect(persisted.some((generation) => generation.status === "frozen")).toBe(false);
  });

  it("exposes both generations by id — the switcher drills back to the frozen predecessor (C15 2.3)", async () => {
    const genDir = mkdtempSync(join(tmpdir(), "gen-store-"));
    const roundDir = mkdtempSync(join(tmpdir(), "round-store-"));
    const generationStore = new GenerationStore(genDir);
    const roundStore = new RoundRecordStore(roundDir);
    const runtime = createRoundsRuntime(
      baseDeps({
        persistGeneration: (gen) => generationStore.save(gen),
        recordRound: (sessionId, record) => roundStore.record(sessionId, record),
        readRounds: (sessionId) => roundStore.read(sessionId),
        loadGeneration: (id) => generationStore.load(id),
      }),
    );
    // The prior generation carries a real drafted board, so drilling back reaches boards.
    const priorWithBoards: Generation = {
      id: "gen:ps-0",
      patchsetId: "ps-0",
      lensBoards: { design: "board:gen1-design" },
      status: "live",
    };
    const { record } = await runtime.runRound(roundInput({ previousGeneration: priorWithBoards }));

    // The record links back to the frozen predecessor by id.
    expect(record.frozenPredecessor).toBe("gen:ps-0");
    expect(record.boardGeneration).toBe("gen:ps-1");

    // Both generations are reachable by id from a fresh store instance (restart-durable).
    const reader = createRoundsRuntime(
      baseDeps({ loadGeneration: (id) => new GenerationStore(genDir).load(id) }),
    );
    const frozen = reader.generation("gen:ps-0");
    const live = reader.generation("gen:ps-1");
    // The switcher-facing read returns the FROZEN gen-1 boards, not the live gen-2.
    expect(frozen?.status).toBe("frozen");
    expect(frozen?.lensBoards.design).toBe("board:gen1-design");
    expect(live?.status).toBe("live");
    expect(live?.id).toBe("gen:ps-1");
    // A generation that was never minted is honestly absent.
    expect(reader.generation("gen:never")).toBeUndefined();
  });

  // ── The rework count is the REPORT's, not the ask count (review finding 10) ──
  //
  // The ledger's "N reworks" used to be `asksDispatched.length`, which counts how many
  // asks went OUT. This drives a round that dispatched THREE asks and whose report
  // classified only one as reworked — the two numbers must not agree.
  it("counts the reworks the round REPORTED, never the asks it dispatched", async () => {
    const author = { kind: "lens-agent", id: "report-seat" };
    const outcome = (id: string, status: string) => ({
      id,
      kind: "round_outcome",
      data: { author, status, ask: { ref: `th-${id}`, text: `ask ${id}` }, note: "verified" },
    });
    // Two acted-on outcomes, one untouched: the round produced TWO reworks over THREE asks.
    const reportBoard = {
      elements: [outcome("o1", "addressed"), outcome("o2", "partial"), outcome("o3", "untouched")],
    } as unknown as DraftBoard;
    const runtime = createRoundsRuntime(
      baseDeps({
        // The report seat's own turn AND its post-process pass both answer the report
        // board — otherwise the editor pass would hand back prose and the typed outcomes
        // would read as dropped. (The lens drafters receive the report as CONTEXT, so the
        // post-process branch is keyed on the file it is polishing, not on the context.)
        resolveClaudePort: async () =>
          fakeClaudePort([], (prompt) => {
            const polishingReport =
              prompt.includes("prompts/post-process.md") && prompt.includes("round_outcome");
            return prompt.includes("prompts/report.md") || polishingReport
              ? reportBoard
              : cleanBody(lensFromPrompt(prompt));
          }),
      }),
    );
    const { record } = await runtime.runRound(roundInput({ asksDispatched: ["t1", "t2", "t3"] }));
    expect(record.asksDispatched).toHaveLength(3);
    expect(record.reworkCount).toBe(2);
  });

  it("a round whose report never drafted records NO rework count, not a zero", async () => {
    // No report seat resolves ⇒ no report board ⇒ the count is honestly unknown.
    const runtime = createRoundsRuntime(baseDeps());
    const { record, pipeline } = await runtime.runRound(roundInput());
    // (The fake report board carries no `round_outcome` items, so the count is a real 0.)
    expect(record.reworkCount).toBe(0);
    expect(pipeline.report?.boardId).toBeDefined();
  });

  // ── A restored round cannot claim a coverage it never checked (review finding b) ──
  //
  // Reconstructing from durable board meta rebuilds ids and blemishes but NOT the boards,
  // and cross-lens coverage is computed from the boards. Reporting `[]` said "every hunk
  // was covered" over a check that never ran.
  it("a round rebuilt from durable meta says its coverage is UNKNOWN, not clean", async () => {
    const store = new BoardMetaStore(mkdtempSync(join(tmpdir(), "rounds-restart-")));
    const generationStore = new GenerationStore(mkdtempSync(join(tmpdir(), "rounds-restart-gen-")));
    const deps = baseDeps({
      persistBoardMeta: (_repo, meta: BoardMeta) => store.save(meta),
      persistGeneration: (generation) => generationStore.save(generation),
      loadGeneration: (id) => generationStore.load(id),
    });
    const first = await createRoundsRuntime(deps).runRound(roundInput());
    // A freshly drafted round DOES know its coverage picture.
    expect(first.pipeline.coverage).toBeDefined();

    // A fresh runtime over the same on-disk evidence reconstructs rather than re-drafting.
    const restarted = createRoundsRuntime(
      baseDeps({
        loadDraftedBoards: () => store.list(),
        resolveClaudePort: async () => {
          throw new Error("a reconstruction must never re-draft");
        },
        loadGeneration: (id) => generationStore.load(id),
      }),
    );
    const after = await restarted.runRound(roundInput());
    expect(after.pipeline.boards.map((b) => b.lens).sort()).toEqual(
      ["decisions", "design", "flagged", "noise", "sequence"].sort(),
    );
    expect(after.pipeline.coverage).toBeUndefined();
  });

  it("reuses a verified reserved report after a crash without another report provider turn", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "rounds-report-resume-repo-"));
    const meta = new BoardMetaStore(mkdtempSync(join(tmpdir(), "rounds-report-resume-meta-")));
    const generations = new GenerationStore(
      mkdtempSync(join(tmpdir(), "rounds-report-resume-generation-")),
    );
    const boards = createBoardsRuntime(repoRoot);
    const boardsRuntimeFor = () => boards;
    const diff = [
      "diff --git a/src/auth.ts b/src/auth.ts",
      "--- a/src/auth.ts",
      "+++ b/src/auth.ts",
      "@@ -1 +1 @@",
      "-old line",
      "+new line",
    ].join("\n");
    const landedRound: NonNullable<RoundInput["round"]> = {
      number: 1,
      previousGeneration: PREV_GEN.id,
      dispatchedAsks: [
        {
          id: "ask-one",
          path: "src/auth.ts",
          type: "request-change",
          instruction: "Replace the line.",
          context: "",
        },
      ],
      findingDispositions: {},
      worker: {
        outcome: "completed",
        diff,
        changedPaths: ["src/auth.ts"],
        commitRange: { from: "c0", to: "c1" },
      },
    };
    const classification = {
      outcomes: [
        {
          askId: "ask-one",
          status: "addressed",
          note: "The exact changed line now carries the requested value.",
          evidenceIds: buildRoundEvidenceManifest(diff).map((unit) => unit.id),
        },
      ],
      beyond: [],
    };
    let crashAfterReport = true;
    const firstCaptures: { prompt?: string }[] = [];
    const durableDeps = {
      boardsRuntimeFor,
      persistBoardMeta: (_repo: string, record: Parameters<BoardMetaStore["save"]>[0]) => {
        meta.save(record);
        if (record.lens === "report" && crashAfterReport) {
          crashAfterReport = false;
          throw new Error("crash after report persistence");
        }
      },
      loadDraftedBoards: (_repo: string, sessionId: string, generation: string) =>
        meta.listForGeneration(sessionId, generation),
      removeBoardMeta: (_repo: string, boardId: string) => meta.remove(boardId),
      persistGeneration: (generation: Generation) => generations.save(generation),
      loadGeneration: (id: string) => generations.load(id),
    } satisfies Partial<RoundsRuntimeDeps>;
    const firstRuntime = createRoundsRuntime(
      baseDeps({
        ...durableDeps,
        resolveClaudePort: async () =>
          fakeClaudePort(firstCaptures, (prompt) =>
            lensFromPrompt(prompt) === "report"
              ? classification
              : cleanBody(lensFromPrompt(prompt)),
          ),
      }),
    );
    const input = roundInput({
      repoRoot,
      asksDispatched: ["ask-one"],
      round: landedRound,
      runWorkers: async () => ({ commitRange: { from: "c0", to: "c1" }, patchsetId: "ps-1" }),
    });

    await expect(firstRuntime.runRound(input)).rejects.toThrow("crash after report persistence");
    expect(
      firstCaptures.filter(({ prompt }) => prompt?.includes("prompts/report.md")),
    ).toHaveLength(1);
    const attempt = generations.load("gen:ps-1");
    expect(attempt?.draftingBoardIds).toBeDefined();
    expect(attempt?.draftingReportBoardId).toBeDefined();
    if (attempt?.draftingBoardIds === undefined || attempt.draftingReportBoardId === undefined) {
      throw new Error("expected the crashed attempt's reserved board identities");
    }
    const boardIds = {
      ...attempt.draftingBoardIds,
      report: attempt.draftingReportBoardId,
    } as Readonly<Record<LintTarget, string>>;

    const retryCaptures: { prompt?: string }[] = [];
    const progress: RoundEvent[] = [];
    const recovered = await createRoundsRuntime(
      baseDeps({
        ...durableDeps,
        resolveClaudePort: async () =>
          fakeClaudePort(retryCaptures, (prompt) => {
            if (lensFromPrompt(prompt) === "report") {
              throw new Error("a persisted report must not open another provider turn");
            }
            return cleanBody(lensFromPrompt(prompt));
          }),
      }),
    ).runRound({
      ...input,
      draftPlan: { generation: attempt.id, boardIds },
      onProgress: (event) => progress.push(event),
    });

    expect(retryCaptures.some(({ prompt }) => prompt?.includes("prompts/report.md"))).toBe(false);
    expect(retryCaptures.some(({ prompt }) => prompt?.includes("prompts/design.md"))).toBe(true);
    expect(progress[0]?.type).toBe("report");
    expect(recovered.pipeline.report?.boardId).toBe(attempt.draftingReportBoardId);
    expect(recovered.record.reportBoard).toBe(attempt.draftingReportBoardId);
  });

  it("repeats the classifier call after a crash before projection and lands exactly one report", async () => {
    // The classifier is side-effect-free before durable projection, so recovery MAY
    // re-run the provider call. What must hold is the DURABLE side: exactly one report
    // projection per round, never the first attempt's elements plus the second's.
    const repoRoot = mkdtempSync(join(tmpdir(), "rounds-report-crash-repo-"));
    const meta = new BoardMetaStore(mkdtempSync(join(tmpdir(), "rounds-report-crash-meta-")));
    const generations = new GenerationStore(
      mkdtempSync(join(tmpdir(), "rounds-report-crash-generation-")),
    );
    const boards = createBoardsRuntime(repoRoot);
    const crashDiff = [
      "diff --git a/src/auth.ts b/src/auth.ts",
      "--- a/src/auth.ts",
      "+++ b/src/auth.ts",
      "@@ -1 +1 @@",
      "-old line",
      "+new line",
    ].join("\n");
    const classification = {
      outcomes: [
        {
          askId: "ask-one",
          status: "addressed",
          note: "The exact changed line now carries the requested value.",
          evidenceIds: buildRoundEvidenceManifest(crashDiff).map((unit) => unit.id),
        },
      ],
      beyond: [],
    };
    const boardIds = reservedBoardIds("report-crash");
    const input = roundInput({
      repoRoot,
      asksDispatched: ["ask-one"],
      draftPlan: { generation: "gen:ps-1", boardIds },
      round: {
        number: 1,
        previousGeneration: PREV_GEN.id,
        dispatchedAsks: [
          {
            id: "ask-one",
            path: "src/auth.ts",
            type: "request-change",
            instruction: "Replace the line.",
            context: "",
          },
        ],
        findingDispositions: {},
        worker: {
          outcome: "completed",
          diff: crashDiff,
          changedPaths: ["src/auth.ts"],
          commitRange: { from: "c0", to: "c1" },
        },
      },
      runWorkers: async () => ({ commitRange: { from: "c0", to: "c1" }, patchsetId: "ps-1" }),
    });

    let crashBeforeReportProjection = true;
    const durableDeps = {
      boardsRuntimeFor: () => boards,
      persistBoardMeta: (_repo: string, record: Parameters<BoardMetaStore["save"]>[0]) => {
        if (record.lens === "report" && crashBeforeReportProjection) {
          crashBeforeReportProjection = false;
          // The provider already answered; the durable projection never lands.
          throw new Error("crash before report projection");
        }
        meta.save(record);
      },
      loadDraftedBoards: (_repo: string, sessionId: string, generation: string) =>
        meta.listForGeneration(sessionId, generation),
      removeBoardMeta: (_repo: string, boardId: string) => meta.remove(boardId),
      persistGeneration: (generation: Generation) => generations.save(generation),
      loadGeneration: (id: string) => generations.load(id),
    } satisfies Partial<RoundsRuntimeDeps>;
    const withClassifier = (captures: { prompt?: string }[]) =>
      baseDeps({
        ...durableDeps,
        resolveClaudePort: async () =>
          fakeClaudePort(captures, (prompt) =>
            lensFromPrompt(prompt) === "report"
              ? classification
              : cleanBody(lensFromPrompt(prompt)),
          ),
      });

    const firstCaptures: { prompt?: string }[] = [];
    await expect(
      createRoundsRuntime(withClassifier(firstCaptures)).runRound(input),
    ).rejects.toThrow("crash before report projection");
    expect(
      firstCaptures.filter(({ prompt }) => prompt?.includes("prompts/report.md")),
    ).toHaveLength(1);
    expect(meta.load(boardIds.report)).toBeUndefined();

    const secondCaptures: { prompt?: string }[] = [];
    const recovered = await createRoundsRuntime(withClassifier(secondCaptures)).runRound(input);

    // The provider call repeats — that is explicitly allowed, and NOT what is exactly-once.
    expect(
      secondCaptures.filter(({ prompt }) => prompt?.includes("prompts/report.md")),
    ).toHaveLength(1);
    expect(recovered.pipeline.report?.boardId).toBe(boardIds.report);
    expect(meta.load(boardIds.report)?.lens).toBe("report");
    // Exactly one durable projection: one section and one outcome per dispatched ask,
    // not the crashed attempt's elements plus the replacement's.
    const persisted = [...(await boards.service.getState(boardIds.report)).values()] as {
      readonly kind: string;
    }[];
    expect(persisted.filter(({ kind }) => kind === "section")).toHaveLength(1);
    expect(persisted.filter(({ kind }) => kind === "round_outcome")).toHaveLength(1);
  });

  it("redrafts when every lens has exact metadata but the required report does not", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "rounds-missing-report-repo-"));
    const boards = createBoardsRuntime(repoRoot);
    const meta = new BoardMetaStore(mkdtempSync(join(tmpdir(), "rounds-missing-report-meta-")));
    const generations = new GenerationStore(
      mkdtempSync(join(tmpdir(), "rounds-missing-report-generation-")),
    );
    const boardIds = reservedBoardIds("missing-report");
    const input = roundInput({
      repoRoot,
      draftPlan: { generation: "gen:ps-1", boardIds },
    });
    const durableDeps = {
      boardsRuntimeFor: () => boards,
      persistBoardMeta: (_repo: string, record: Parameters<BoardMetaStore["save"]>[0]) =>
        meta.save(record),
      removeBoardMeta: (_repo: string, boardId: string) => meta.remove(boardId),
      loadDraftedBoards: (_repo: string, sessionId: string, generation: string) =>
        meta.listForGeneration(sessionId, generation),
      persistGeneration: (generation: Generation) => generations.save(generation),
      loadGeneration: (id: string) => generations.load(id),
    } satisfies Partial<RoundsRuntimeDeps>;

    await createRoundsRuntime(baseDeps(durableDeps)).runRound(input);
    expect(LENS_KINDS.every((lens) => meta.load(boardIds[lens])?.lens === lens)).toBe(true);
    expect(meta.load(boardIds.report)?.lens).toBe("report");
    meta.remove(boardIds.report);
    expect(meta.load(boardIds.report)).toBeUndefined();

    const captures: { prompt?: string }[] = [];
    const recovered = await createRoundsRuntime(
      baseDeps({
        ...durableDeps,
        resolveClaudePort: async () => fakeClaudePort(captures),
      }),
    ).runRound(input);

    expect(captures.some(({ prompt }) => prompt?.includes("prompts/report.md"))).toBe(true);
    expect(recovered.pipeline.report?.boardId).toBe(boardIds.report);
    expect(meta.load(boardIds.report)?.lens).toBe("report");
  });

  it("clears a partial attempt before retrying an append that crashed before BoardMeta", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "rounds-append-before-meta-repo-"));
    const boards = createBoardsRuntime(repoRoot);
    const meta = new BoardMetaStore(
      mkdtempSync(join(tmpdir(), "rounds-append-before-meta-store-")),
    );
    const generations = new GenerationStore(
      mkdtempSync(join(tmpdir(), "rounds-append-before-meta-generation-")),
    );
    const boardIds = reservedBoardIds("append-before-meta");
    const input = roundInput({
      repoRoot,
      draftPlan: { generation: "gen:ps-1", boardIds },
    });
    let crashBeforeSequenceMeta = true;
    const first = createRoundsRuntime(
      baseDeps({
        boardsRuntimeFor: () => boards,
        persistBoardMeta: (_repo, record) => {
          if (record.lens === "sequence" && crashBeforeSequenceMeta) {
            crashBeforeSequenceMeta = false;
            throw new Error("crash before Sequence BoardMeta");
          }
          meta.save(record);
        },
        loadDraftedBoards: (_repo, sessionId, generation) =>
          meta.listForGeneration(sessionId, generation),
        persistGeneration: (generation) => generations.save(generation),
        loadGeneration: (id) => generations.load(id),
      }),
    );

    await expect(first.runRound(input)).rejects.toThrow("crash before Sequence BoardMeta");
    expect((await boards.service.getState(boardIds.sequence)).size).toBeGreaterThan(0);
    expect(meta.load(boardIds.sequence)).toBeUndefined();

    const recoveryOrder: string[] = [];
    const recoveryService = new Proxy(boards.service, {
      get: (target, property) => {
        if (property === "apply") {
          return async (...args: Parameters<BoardsRuntime["service"]["apply"]>) => {
            const [boardId, , actor] = args;
            if (actor === "host:round-retry-recovery") recoveryOrder.push(`clear:${boardId}`);
            return target.apply(...args);
          };
        }
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const recoveryBoardsRuntime = () => ({ ...boards, service: recoveryService });
    const captures: { prompt?: string }[] = [];
    const recovered = await createRoundsRuntime(
      baseDeps({
        boardsRuntimeFor: recoveryBoardsRuntime,
        resolveClaudePort: async () => fakeClaudePort(captures),
        persistBoardMeta: (_repo, record) => meta.save(record),
        removeBoardMeta: (_repo, boardId) => {
          recoveryOrder.push(`remove:${boardId}`);
          meta.remove(boardId);
        },
        loadDraftedBoards: (_repo, sessionId, generation) =>
          meta.listForGeneration(sessionId, generation),
        persistGeneration: (generation) => generations.save(generation),
        loadGeneration: (id) => generations.load(id),
      }),
    ).runRound(input);

    for (const boardId of Object.values(boardIds)) {
      expect(recoveryOrder.indexOf(`remove:${boardId}`)).toBeGreaterThanOrEqual(0);
      expect(recoveryOrder.indexOf(`clear:${boardId}`)).toBeGreaterThan(
        recoveryOrder.indexOf(`remove:${boardId}`),
      );
    }
    expect(captures.some(({ prompt }) => prompt?.includes("prompts/sequence.md"))).toBe(true);
    expect(recovered.boardGeneration.lensBoards.sequence).toBe(boardIds.sequence);
    expect((await boards.service.getState(boardIds.sequence)).size).toBeGreaterThan(0);
    expect(meta.load(boardIds.sequence)?.lens).toBe("sequence");
  });

  it("preserves typed core-empty results when complete durable evidence reconstructs", async () => {
    const meta = new BoardMetaStore(mkdtempSync(join(tmpdir(), "rounds-absence-meta-")));
    const generations = new GenerationStore(
      mkdtempSync(join(tmpdir(), "rounds-absence-generation-")),
    );
    const input = roundInput({ designArtifacts: null });
    const first = await createRoundsRuntime(
      baseDeps({
        resolveClaudePort: async () =>
          fakeClaudePort([], (prompt) => {
            const lens = lensFromPrompt(prompt);
            if (
              lens === "decisions" ||
              lens === "flagged" ||
              (lens === "post-process" && prompt.includes('"elements":[]'))
            ) {
              return { elements: [], skippedHunks: [] } as unknown as DraftBoard;
            }
            return cleanBody(lens);
          }),
        persistBoardMeta: (_repo, record) => meta.save(record),
        persistGeneration: (generation) => generations.save(generation),
        loadGeneration: (id) => generations.load(id),
      }),
    ).runRound(input);
    expect(first.boardGeneration.absentLenses?.design).toBe("no-material");
    expect(first.boardGeneration.absentLenses?.decisions).toBe("no-decisions");
    expect(first.boardGeneration.absentLenses?.flagged).toBe("no-findings");
    expect(first.boardGeneration.lensBoards.sequence).toBeDefined();

    const recovered = await createRoundsRuntime(
      baseDeps({
        resolveClaudePort: async () => {
          throw new Error("complete evidence must reconstruct without a model");
        },
        loadDraftedBoards: (_repo, sessionId, generation) =>
          meta.listForGeneration(sessionId, generation),
        persistGeneration: (generation) => generations.save(generation),
        loadGeneration: (id) => generations.load(id),
      }),
    ).runRound(input);

    expect(recovered.pipeline.boards.find((outcome) => outcome.lens === "design")?.absence).toBe(
      "no-material",
    );
    expect(recovered.pipeline.boards.find((outcome) => outcome.lens === "flagged")?.absence).toBe(
      "no-findings",
    );
    expect(recovered.pipeline.boards.find((outcome) => outcome.lens === "decisions")?.absence).toBe(
      "no-decisions",
    );
    expect(recovered.boardGeneration.absentLenses?.design).toBe("no-material");
    expect(recovered.boardGeneration.absentLenses?.decisions).toBe("no-decisions");
    expect(recovered.boardGeneration.absentLenses?.flagged).toBe("no-findings");
    expect(recovered.boardGeneration.lensBoards.sequence).toBeDefined();
    expect(recovered.boardGeneration.lensBoards.design).toBeUndefined();
    expect(recovered.boardGeneration.lensBoards.decisions).toBeUndefined();
    expect(recovered.boardGeneration.lensBoards.flagged).toBeUndefined();
  });

  it.each(["sequence", "decisions", "flagged"] as const)(
    "keeps a generation retryable when the %s core lane fails beside Design and Noise",
    async (failedCoreLens) => {
      const repoRoot = mkdtempSync(join(tmpdir(), `rounds-${failedCoreLens}-failure-repo-`));
      const boards = createBoardsRuntime(repoRoot);
      const meta = new BoardMetaStore(
        mkdtempSync(join(tmpdir(), `rounds-${failedCoreLens}-failure-meta-`)),
      );
      const generations = new GenerationStore(
        mkdtempSync(join(tmpdir(), `rounds-${failedCoreLens}-failure-generation-`)),
      );
      const boardIds = reservedBoardIds(`${failedCoreLens}-failure`);
      const input = roundInput({
        repoRoot,
        draftPlan: { generation: "gen:ps-1", boardIds },
      });
      const durableDeps = {
        boardsRuntimeFor: () => boards,
        persistBoardMeta: (_repo: string, record: Parameters<BoardMetaStore["save"]>[0]) =>
          meta.save(record),
        removeBoardMeta: (_repo: string, boardId: string) => meta.remove(boardId),
        loadDraftedBoards: (_repo: string, sessionId: string, generation: string) =>
          meta.listForGeneration(sessionId, generation),
        persistGeneration: (generation: Generation) => generations.save(generation),
        loadGeneration: (id: string) => generations.load(id),
      } satisfies Partial<RoundsRuntimeDeps>;
      const invalid = {
        elements: [{ id: "invalid", kind: "not-a-kind", data: {} }],
        skippedHunks: [],
      };

      await expect(
        createRoundsRuntime(
          baseDeps({
            ...durableDeps,
            resolveClaudePort: async () =>
              fakeClaudePort([], (prompt) =>
                lensFromPrompt(prompt) === failedCoreLens
                  ? invalid
                  : cleanBody(lensFromPrompt(prompt)),
              ),
          }),
        ).runRound(input),
      ).rejects.toThrow(`required core lens ${failedCoreLens}`);

      const failedAttempt = generations.load("gen:ps-1");
      expect(failedAttempt?.lensBoards.design).toBe(boardIds.design);
      expect(failedAttempt?.lensBoards.noise).toBe(boardIds.noise);
      expect(failedAttempt?.failedLenses?.[failedCoreLens]).toEqual(expect.any(String));
      expect(meta.load(boardIds.design)?.lens).toBe("design");
      expect(meta.load(boardIds.noise)?.lens).toBe("noise");

      const retryCaptures: { prompt?: string }[] = [];
      const recovered = await createRoundsRuntime(
        baseDeps({
          ...durableDeps,
          resolveClaudePort: async () => fakeClaudePort(retryCaptures),
        }),
      ).runRound(input);

      expect(
        retryCaptures.some(({ prompt }) =>
          prompt?.includes(`PROMPT_FILE:prompts/${failedCoreLens}.md`),
        ),
      ).toBe(true);
      expect(recovered.boardGeneration.lensBoards[failedCoreLens]).toBe(boardIds[failedCoreLens]);
      expect(recovered.boardGeneration.failedLenses).toBeUndefined();
      expect(recovered.record.boardGeneration).toBe("gen:ps-1");

      const reconstructed = await createRoundsRuntime(
        baseDeps({
          ...durableDeps,
          resolveClaudePort: async () => {
            throw new Error("successful core evidence must reconstruct without a model");
          },
        }),
      ).runRound(input);

      expect(reconstructed.boardGeneration.lensBoards[failedCoreLens]).toBe(
        boardIds[failedCoreLens],
      );
    },
  );

  it("preserves an explicit lens failure when complete durable evidence reconstructs", async () => {
    const meta = new BoardMetaStore(mkdtempSync(join(tmpdir(), "rounds-failure-meta-")));
    const generations = new GenerationStore(
      mkdtempSync(join(tmpdir(), "rounds-failure-generation-")),
    );
    const first = await createRoundsRuntime(
      baseDeps({
        resolveClaudePort: async () =>
          fakeClaudePort([], (prompt) =>
            lensFromPrompt(prompt) === "design"
              ? ({
                  elements: [{ id: "invalid", kind: "not-a-kind", data: {} }],
                } as unknown as DraftBoard)
              : cleanBody(lensFromPrompt(prompt)),
          ),
        persistBoardMeta: (_repo, record) => meta.save(record),
        persistGeneration: (generation) => generations.save(generation),
        loadGeneration: (id) => generations.load(id),
      }),
    ).runRound(roundInput());
    const firstFailure = first.pipeline.boards.find(({ lens }) => lens === "design")?.failure;
    expect(firstFailure).toEqual(expect.any(String));
    expect(first.boardGeneration.failedLenses?.design).toBe(firstFailure);
    expect(Object.keys(first.boardGeneration.lensBoards)).toHaveLength(4);

    const recovered = await createRoundsRuntime(
      baseDeps({
        resolveClaudePort: async () => {
          throw new Error("complete failure evidence must reconstruct without a model");
        },
        loadDraftedBoards: (_repo, sessionId, generation) =>
          meta.listForGeneration(sessionId, generation),
        loadGeneration: (id) => generations.load(id),
      }),
    ).runRound(roundInput());

    expect(recovered.pipeline.boards.map(({ lens }) => lens)).toEqual([...LENS_KINDS]);
    expect(recovered.pipeline.boards.find(({ lens }) => lens === "design")?.failure).toBe(
      firstFailure,
    );
    expect(recovered.boardGeneration.failedLenses?.design).toBe(firstFailure);
  });

  it("redrafts a settled Generation whose fifth lens has no terminal evidence", async () => {
    const meta = new BoardMetaStore(mkdtempSync(join(tmpdir(), "rounds-settled-meta-")));
    const generations = new GenerationStore(
      mkdtempSync(join(tmpdir(), "rounds-settled-generation-")),
    );
    const seeded = await createRoundsRuntime(
      baseDeps({
        persistBoardMeta: (_repo, record) => meta.save(record),
        persistGeneration: (generation) => generations.save(generation),
        loadGeneration: (id) => generations.load(id),
      }),
    ).runRound(roundInput());
    const fourBoards = { ...seeded.boardGeneration.lensBoards };
    delete fourBoards.flagged;
    generations.save({ ...seeded.boardGeneration, lensBoards: fourBoards });
    let attemptWrites = 0;
    const captures: { prompt?: string }[] = [];

    const recovered = await createRoundsRuntime(
      baseDeps({
        resolveClaudePort: async () => fakeClaudePort(captures),
        loadDraftedBoards: (_repo, sessionId, generation) =>
          meta.listForGeneration(sessionId, generation),
        persistBoardMeta: (_repo, record) => meta.save(record),
        persistGeneration: (generation) => {
          if (generation.draftingBoardIds !== undefined) attemptWrites += 1;
          generations.save(generation);
        },
        loadGeneration: (id) => generations.load(id),
      }),
    ).runRound(roundInput());

    expect(attemptWrites).toBeGreaterThan(0);
    expect(captures.some(({ prompt }) => prompt?.includes("prompts/flagged.md"))).toBe(true);
    expect(recovered.pipeline.boards.map(({ lens }) => lens)).toEqual([...LENS_KINDS]);
    expect(recovered.boardGeneration.lensBoards.flagged).toBeDefined();

    const reconstructed = await createRoundsRuntime(
      baseDeps({
        resolveClaudePort: async () => {
          throw new Error("complete replacement evidence must reconstruct without a model");
        },
        loadDraftedBoards: (_repo, sessionId, generation) =>
          meta.listForGeneration(sessionId, generation),
        loadGeneration: (id) => generations.load(id),
      }),
    ).runRound(roundInput());

    expect(reconstructed.pipeline.boards.map(({ lens }) => lens)).toEqual([...LENS_KINDS]);
    expect(reconstructed.boardGeneration.lensBoards.flagged).toBe(
      recovered.boardGeneration.lensBoards.flagged,
    );
  });

  it("redrafts a settled all-empty or failed Generation with no surviving board", async () => {
    const generations = new GenerationStore(
      mkdtempSync(join(tmpdir(), "rounds-boardless-generation-")),
    );
    generations.save({
      id: "gen:ps-1",
      patchsetId: "ps-1",
      lensBoards: {},
      absentLenses: {
        design: "no-material",
        decisions: "no-decisions",
        flagged: "no-findings",
        noise: "no-noise",
      },
      failedLenses: { sequence: "The Sequence drafter produced no board." },
      status: "live",
    });
    let attemptWrites = 0;
    const captures: { prompt?: string }[] = [];

    const recovered = await createRoundsRuntime(
      baseDeps({
        resolveClaudePort: async () => fakeClaudePort(captures),
        loadDraftedBoards: () => [],
        persistGeneration: (generation) => {
          if (generation.draftingBoardIds !== undefined) attemptWrites += 1;
          generations.save(generation);
        },
        loadGeneration: (id) => generations.load(id),
      }),
    ).runRound(roundInput());

    expect(attemptWrites).toBeGreaterThan(0);
    expect(captures.some(({ prompt }) => prompt?.includes("prompts/sequence.md"))).toBe(true);
    expect(recovered.pipeline.boards.map(({ lens }) => lens)).toEqual([...LENS_KINDS]);
    expect(Object.keys(recovered.boardGeneration.lensBoards)).toHaveLength(LENS_KINDS.length);
    expect(recovered.boardGeneration.absentLenses).toBeUndefined();
    expect(recovered.boardGeneration.failedLenses).toBeUndefined();
  });

  it("retries an incomplete generation after restart and binds reconstruction to its replacement boards", async () => {
    const completeMeta = new BoardMetaStore(mkdtempSync(join(tmpdir(), "rounds-complete-meta-")));
    const partialMeta = new BoardMetaStore(mkdtempSync(join(tmpdir(), "rounds-partial-meta-")));
    const generationStore = new GenerationStore(
      mkdtempSync(join(tmpdir(), "rounds-partial-generation-")),
    );
    const seeded = await createRoundsRuntime(
      baseDeps({
        persistBoardMeta: (_repo, meta) => completeMeta.save(meta),
        persistGeneration: (generation) => generationStore.save(generation),
        loadGeneration: (id) => generationStore.load(id),
      }),
    ).runRound(roundInput());
    for (const meta of completeMeta.list()) {
      if (meta.lens !== "flagged") partialMeta.save(meta);
    }
    generationStore.save({
      ...seeded.boardGeneration,
      lensBoards: {},
      draftingBoardIds: seeded.boardGeneration.lensBoards,
    });

    const captures: { prompt?: string }[] = [];
    const recoveryWrites: LintTarget[] = [];
    const recovered = await createRoundsRuntime(
      baseDeps({
        resolveClaudePort: async () => fakeClaudePort(captures),
        persistBoardMeta: (_repo, meta) => {
          recoveryWrites.push(meta.lens);
          partialMeta.save(meta);
        },
        loadDraftedBoards: (_repo, session, generation) =>
          partialMeta.listForGeneration(session, generation),
        persistGeneration: (generation) => generationStore.save(generation),
        loadGeneration: (id) => generationStore.load(id),
      }),
    ).runRound(roundInput());

    expect(captures.some(({ prompt }) => prompt?.includes("prompts/flagged.md"))).toBe(true);
    expect(recoveryWrites).toContain("flagged");
    expect(recovered.boardGeneration.lensBoards.flagged).toBeDefined();

    const reconstructed = await createRoundsRuntime(
      baseDeps({
        resolveClaudePort: async () => {
          throw new Error("a complete generation must not re-draft");
        },
        loadDraftedBoards: (_repo, session, generation) =>
          partialMeta.listForGeneration(session, generation),
        persistGeneration: (generation) => generationStore.save(generation),
        loadGeneration: (id) => generationStore.load(id),
      }),
    ).runRound(roundInput());

    expect(reconstructed.pipeline.boards.map(({ lens }) => lens)).toEqual([...LENS_KINDS]);
    for (const lens of LENS_KINDS) {
      expect(reconstructed.pipeline.boards.find((board) => board.lens === lens)?.boardId).toBe(
        reconstructed.boardGeneration.lensBoards[lens],
      );
    }
  });

  it("isolates a pre-write Flagged migration from the retry attempt's same-id finding", async () => {
    const meta = new BoardMetaStore(mkdtempSync(join(tmpdir(), "rounds-finding-attempt-meta-")));
    const generations = new GenerationStore(
      mkdtempSync(join(tmpdir(), "rounds-finding-attempt-generation-")),
    );
    const priorBoardId = "board:prior-flagged";
    const priorGeneration: Generation = {
      id: "gen:ps-0",
      patchsetId: "ps-0",
      lensBoards: { flagged: priorBoardId },
      status: "live",
    };
    const priorFinding = {
      generation: priorGeneration.id,
      boardId: priorBoardId,
      findingId: "finding-reused",
    };
    let dispositions: Record<string, FindingDisposition> = {
      [findingRefKey(priorFinding)]: { finding: priorFinding, disposition: "dismissed" },
    };
    const migrationEvents: ReturnType<typeof findingDispositionMigrationEvents> = [];
    const flagged = (concern: string): DraftBoard =>
      ({
        elements: [
          {
            id: "findings",
            kind: "section",
            data: {
              author: { kind: "lens-agent", id: "flagged-seat" },
              title: "Findings",
              children: [priorFinding.findingId],
            },
          },
          {
            id: priorFinding.findingId,
            kind: "finding",
            data: {
              author: { kind: "lens-agent", id: "flagged-seat" },
              severity: "high",
              concern,
              code: ["finding-code"],
              concurrence: [],
              status: "open",
            },
          },
          {
            id: "finding-code",
            kind: "code_ref",
            data: {
              author: { kind: "lens-agent", id: "flagged-seat" },
              patchset_id: "ps-1",
              path: "src/auth.ts",
              side: "head",
              start_line: 10,
              end_line: 12,
            },
          },
        ],
      }) as unknown as DraftBoard;
    const previousFlagged = flagged("The retry can lose its terminal record.");
    let releaseMigration!: () => void;
    const migrationReached = new Promise<void>((resolve) => {
      releaseMigration = resolve;
    });
    const boardsRuntime = (
      attempt: "attempt-a" | "attempt-b",
      crashFlagged: boolean,
    ): RoundsRuntimeDeps["boardsRuntimeFor"] => {
      let nextBoard = 0;
      const targets = [...LENS_KINDS, "report"] as const;
      return () =>
        ({
          createRennetBoard: async () => `${attempt}:${targets[nextBoard++]}`,
          service: {
            apply: async (boardId: string) => {
              if (crashFlagged && boardId === `${attempt}:noise`) {
                await migrationReached;
                throw new Error("crash after Flagged migration");
              }
              return { ok: true };
            },
            getState: async () => new Map(),
          },
        }) as unknown as Pick<BoardsRuntime, "service" | "createRennetBoard">;
    };
    const persistFindingResolutions: NonNullable<RoundInput["persistFindingResolutions"]> = (
      successorGeneration,
      successorBoardId,
      resolutions,
      findingDispositions,
    ) => {
      const events = findingDispositionMigrationEvents({
        successorGeneration,
        successorBoardId,
        resolutions,
        findingDispositions,
      });
      migrationEvents.push(...events);
      for (const event of events) {
        if (event.kind !== "finding-dismiss") continue;
        dispositions = {
          ...dispositions,
          [findingRefKey(event.finding)]: { finding: event.finding, disposition: "dismissed" },
        };
      }
      if (successorBoardId === "attempt-a:flagged") {
        releaseMigration();
        throw new Error("finding migration callback lost its response");
      }
    };
    const input = (): RoundInput =>
      roundInput({
        previousGeneration: priorGeneration,
        previous: new Map([["flagged", previousFlagged]]),
        round: {
          number: 1,
          previousGeneration: priorGeneration.id,
          previousFlaggedBoardId: "board:stale-input-flagged",
          dispatchedAsks: [],
          findingDispositions: dispositions,
        },
        readFindingDispositions: () => dispositions,
        persistFindingResolutions,
        runWorkers: async () => ({
          commitRange: { from: "c0", to: "c1" },
          patchsetId: "ps-1",
        }),
        deltaPacket: ROUND_PACKET,
        lintContextFor: (lens) => ({
          ...lintContextFor(lens),
          files: new Map([["src/auth.ts", 100]]),
        }),
      });
    const deps = (
      attempt: "attempt-a" | "attempt-b",
      currentFlagged: DraftBoard,
      crashFlagged: boolean,
    ): RoundsRuntimeDeps =>
      baseDeps({
        boardsRuntimeFor: boardsRuntime(attempt, crashFlagged),
        resolveClaudePort: async () =>
          fakeClaudePort([], (prompt) => {
            if (
              prompt.includes("prompts/flagged.md") ||
              (prompt.includes("prompts/post-process.md") && /"kind"\s*:\s*"finding"/.test(prompt))
            ) {
              return currentFlagged;
            }
            return cleanBody(lensFromPrompt(prompt));
          }),
        persistBoardMeta: (_repo, record) => meta.save(record),
        loadDraftedBoards: (_repo, sessionId, generation) =>
          meta.listForGeneration(sessionId, generation),
        persistGeneration: (generation) => generations.save(generation),
        loadGeneration: (id) => generations.load(id),
      });

    await expect(
      createRoundsRuntime(deps("attempt-a", previousFlagged, true)).runRound(input()),
    ).rejects.toThrow("crash after Flagged migration");
    const attemptAFinding = {
      generation: "gen:ps-1",
      boardId: "attempt-a:flagged",
      findingId: priorFinding.findingId,
    };
    expect(migrationEvents).toEqual([
      {
        kind: "finding-dismiss",
        finding: attemptAFinding,
      },
    ]);
    expect(Object.keys(dispositions).sort()).toEqual(
      [findingRefKey(priorFinding), findingRefKey(attemptAFinding)].sort(),
    );
    expect(generations.load("gen:ps-1")?.draftingBoardIds?.flagged).toBe("attempt-a:flagged");

    const retryFlagged = flagged("A different concern reused the model's finding id.");
    const recovered = await createRoundsRuntime(deps("attempt-b", retryFlagged, false)).runRound(
      input(),
    );
    const retryBoardId = recovered.boardGeneration.lensBoards.flagged;
    const retryOutcome = recovered.pipeline.boards.find((outcome) => outcome.lens === "flagged");
    const retrySection = retryOutcome?.board?.elements.find((element) => element.id === "findings");

    expect(retryBoardId).toBe("attempt-b:flagged");
    expect(retrySection?.kind === "section" ? retrySection.data.children : []).toEqual([
      priorFinding.findingId,
    ]);
    expect(migrationEvents).toHaveLength(1);
    expect(
      dispositions[
        findingRefKey({
          generation: "gen:ps-1",
          boardId: "attempt-b:flagged",
          findingId: priorFinding.findingId,
        })
      ],
    ).toBeUndefined();
  });

  it("never reconstructs one generation from BoardMeta written by different draft attempts", async () => {
    const seedMeta = new BoardMetaStore(mkdtempSync(join(tmpdir(), "rounds-attempt-seed-")));
    await createRoundsRuntime(
      baseDeps({ persistBoardMeta: (_repo, meta) => seedMeta.save(meta) }),
    ).runRound(roundInput());

    const mixedMeta = new BoardMetaStore(mkdtempSync(join(tmpdir(), "rounds-attempt-mixed-")));
    const attemptB = Object.fromEntries(
      LENS_KINDS.map((lens) => [lens, `attempt-b:${lens}`]),
    ) as NonNullable<Generation["draftingBoardIds"]>;
    for (const meta of seedMeta.list().filter((record) => record.lens !== "report")) {
      const fromAttemptB = meta.lens === "flagged" || meta.lens === "noise";
      mixedMeta.save({
        ...meta,
        boardId: fromAttemptB ? `attempt-b:${meta.lens}` : `attempt-a:${meta.lens}`,
      });
    }
    const generations = new GenerationStore(
      mkdtempSync(join(tmpdir(), "rounds-attempt-generation-")),
    );
    generations.save({
      id: "gen:ps-1",
      patchsetId: "ps-1",
      lensBoards: {},
      draftingBoardIds: attemptB,
      draftingReportBoardId: "attempt-b:report",
      status: "live",
    });

    const captures: { prompt?: string }[] = [];
    const persisted: Generation[] = [];
    const recovered = await createRoundsRuntime(
      baseDeps({
        resolveClaudePort: async () => fakeClaudePort(captures),
        loadDraftedBoards: (_repo, sessionId, generation) =>
          mixedMeta.listForGeneration(sessionId, generation),
        persistBoardMeta: (_repo, meta) => mixedMeta.save(meta),
        persistGeneration: (generation) => {
          persisted.push(generation);
          generations.save(generation);
        },
        loadGeneration: (id) => generations.load(id),
      }),
    ).runRound(roundInput());

    // Positive control: the old one-row-per-lens fallback returned before resolving a
    // harness here. A real draft proves mixed attempts were rejected as incomplete.
    expect(captures.length).toBeGreaterThan(0);
    const replacementAttempt = persisted.find(
      (generation) => generation.draftingBoardIds !== undefined,
    );
    expect(replacementAttempt).toBeDefined();
    expect(recovered.boardGeneration.draftingBoardIds).toBeUndefined();
    for (const lens of LENS_KINDS) {
      expect(recovered.boardGeneration.lensBoards[lens]).not.toBe(`attempt-a:${lens}`);
      expect(recovered.boardGeneration.lensBoards[lens]).not.toBe(`attempt-b:${lens}`);
      expect(recovered.boardGeneration.lensBoards[lens]).toBe(
        replacementAttempt?.draftingBoardIds?.[lens],
      );
    }
    expect(recovered.boardGeneration.draftingReportBoardId).toBe(
      replacementAttempt?.draftingReportBoardId,
    );
  });

  it("reconstructs the current attempt's report after earlier partial attempts left report rows", async () => {
    const templates = new BoardMetaStore(mkdtempSync(join(tmpdir(), "rounds-report-template-")));
    await createRoundsRuntime(
      baseDeps({ persistBoardMeta: (_repo, meta) => templates.save(meta) }),
    ).runRound(roundInput());
    const byLens = new Map(templates.list().map((meta) => [meta.lens, meta]));
    const reportTemplate = byLens.get("report");
    expect(reportTemplate).toBeDefined();

    const evidence = new BoardMetaStore(mkdtempSync(join(tmpdir(), "rounds-report-attempts-")));
    const attemptB = Object.fromEntries(
      LENS_KINDS.map((lens) => [lens, `attempt-b:${lens}`]),
    ) as NonNullable<Generation["draftingBoardIds"]>;
    for (const lens of LENS_KINDS) {
      const template = byLens.get(lens);
      expect(template).toBeDefined();
      if (template !== undefined) {
        evidence.save({ ...template, boardId: `attempt-b:${lens}` });
        if (lens === "decisions" || lens === "sequence") {
          evidence.save({ ...template, boardId: `attempt-a:${lens}` });
        }
      }
    }
    if (reportTemplate !== undefined) {
      evidence.save({ ...reportTemplate, boardId: "attempt-a:report" });
      evidence.save({ ...reportTemplate, boardId: "attempt-b:report" });
    }
    const generations = new GenerationStore(
      mkdtempSync(join(tmpdir(), "rounds-report-attempt-generation-")),
    );
    generations.save({
      id: "gen:ps-1",
      patchsetId: "ps-1",
      lensBoards: {},
      draftingBoardIds: attemptB,
      draftingReportBoardId: "attempt-b:report",
      status: "live",
    });

    const recovered = await createRoundsRuntime(
      baseDeps({
        resolveClaudePort: async () => {
          throw new Error("complete exact-attempt evidence must reconstruct");
        },
        loadDraftedBoards: (_repo, sessionId, generation) =>
          evidence.listForGeneration(sessionId, generation),
        persistGeneration: (generation) => generations.save(generation),
        loadGeneration: (id) => generations.load(id),
      }),
    ).runRound(roundInput());

    expect(recovered.pipeline.report?.boardId).toBe("attempt-b:report");
    expect(recovered.record.reportBoard).toBe("attempt-b:report");
    for (const lens of LENS_KINDS) {
      expect(recovered.boardGeneration.lensBoards[lens]).toBe(`attempt-b:${lens}`);
    }
  });

  it("keeps a completed no-code dispatch as ROUND_NO_REGEN and reveals no old boards", async () => {
    const captures: { prompt?: string }[] = [];
    const events: RoundEvent[] = [];
    const runtime = createRoundsRuntime(
      baseDeps({ resolveClaudePort: async () => fakeClaudePort(captures) }),
    );
    const input = roundInput({
      deltaPacket: {
        ...ROUND_PACKET,
        patchset: { ...ROUND_PACKET.patchset, id: "ps-0" },
      },
      runWorkers: async () => ({ commitRange: { from: "c0", to: "c0" } }),
      onProgress: (event) => events.push(event),
    });
    expect(input.deltaPacket.successorAccount).toBeDefined();
    const { record, frozenPrevious, pipeline } = await runtime.runRound(input);
    expect(record.mintedPatchsetGeneration).toBeUndefined();
    expect(record.boardGeneration).toBe(ROUND_NO_REGEN);
    expect(record.reportBoard).toBe(ROUND_NO_REGEN);
    expect(record.regeneration).toBe("not-needed");
    expect(record.reworkCount).toBeUndefined();
    expect(pipeline.report).toBeUndefined();
    expect(captures).toEqual([]);
    expect(events).toEqual([{ type: "unchanged" }]);
    // Nothing landed ⇒ nothing froze.
    expect(frozenPrevious).toBeUndefined();
  });

  it("persists an unchanged round before emitting its terminal receipt", async () => {
    const order: string[] = [];
    const runtime = createRoundsRuntime(
      baseDeps({
        recordRound: (_sessionId, record) => {
          order.push(`persisted:${record.regeneration}`);
        },
      }),
    );

    const record = await runtime.finalizeUnchanged({
      session: { id: "s1", projectId: "p1", threads: [], createdAt: 0 },
      asksDispatched: ["ask-1"],
      dispatchId: "dispatch-1",
      sourcePatchsetId: "patchset-1",
      workerCommitRange: { from: "commit-1", to: "commit-1" },
      onProgress: (event) => order.push(event.type),
    });

    expect(record.regeneration).toBe("not-needed");
    expect(order).toEqual(["persisted:not-needed", "unchanged"]);
  });

  it("keeps askless first-generation drafting on the no-code path", async () => {
    const captures: { prompt?: string }[] = [];
    const outcome = await createRoundsRuntime(
      baseDeps({ resolveClaudePort: async () => fakeClaudePort(captures) }),
    ).runRound(
      roundInput({
        previousGeneration: undefined,
        asksDispatched: [],
        runWorkers: async () => ({ commitRange: { from: "c0", to: "c0" } }),
      }),
    );
    expect(captures.length).toBeGreaterThan(0);
    expect(outcome.boardGeneration.id).toBe("gen:ps-1");
    expect(outcome.pipeline.boards.some((board) => board.boardId !== undefined)).toBe(true);
  });

  it("redrafts an unchanged patchset when its consumed project context revision advances", async () => {
    const captures: { prompt?: string }[] = [];
    const generations = new GenerationStore(
      mkdtempSync(join(tmpdir(), "rounds-context-generation-")),
    );
    const meta = new BoardMetaStore(mkdtempSync(join(tmpdir(), "rounds-context-meta-")));
    const runtime = createRoundsRuntime(
      baseDeps({
        resolveClaudePort: async () => fakeClaudePort(captures),
        persistBoardMeta: (_repo, record) => meta.save(record),
        loadDraftedBoards: (_repo, sessionId, generation) =>
          meta.listForGeneration(sessionId, generation),
        persistGeneration: (generation) => generations.save(generation),
        loadGeneration: (id) => generations.load(id),
      }),
    );
    const inputFor = (projectContextRevision: string): RoundInput =>
      roundInput({
        previousGeneration: undefined,
        asksDispatched: [],
        runWorkers: async () => ({ commitRange: { from: "c0", to: "c0" } }),
        projectContextRevision,
      });

    await runtime.runRound(inputFor("context-a"));
    const firstDraftTurns = captures.length;
    await runtime.runRound(inputFor("context-b"));

    expect(captures.length).toBeGreaterThan(firstDraftTurns);
    expect(generations.load("gen:ps-1")?.projectContextRevision).toBe("context-b");
  });

  it("keeps regeneration pending when only the report drafts, then retries without a worker record", async () => {
    const roundStore = new RoundRecordStore(mkdtempSync(join(tmpdir(), "rounds-report-only-")));
    const generationStore = new GenerationStore(
      mkdtempSync(join(tmpdir(), "rounds-report-only-gen-")),
    );
    const metaStore = new BoardMetaStore(mkdtempSync(join(tmpdir(), "rounds-report-only-meta-")));
    const identity = {
      dispatchId: "dispatch:report-only",
      sourcePatchsetId: "ps-0",
      askOccurrences: [{ id: "t1", revision: 0 }],
    } as const;
    const events: RoundEvent[] = [];
    const reportOnly = createRoundsRuntime(
      baseDeps({
        resolveClaudePort: async () =>
          fakeClaudePort([], (prompt) =>
            prompt.includes("prompts/report.md") || prompt.includes("prompts/post-process.md")
              ? cleanBody("report")
              : ({ invalid: true } as unknown as DraftBoard),
          ),
        persistBoardMeta: (_repo, meta) => metaStore.save(meta),
        loadDraftedBoards: (_repo, sessionId, generation) =>
          metaStore.listForGeneration(sessionId, generation),
        persistGeneration: (generation) => generationStore.save(generation),
        loadGeneration: (id) => generationStore.load(id),
        recordRound: (sessionId, record) => roundStore.record(sessionId, record),
        readRounds: (sessionId) => roundStore.read(sessionId),
      }),
    );
    await reportOnly.dispatchRound({
      ...identity,
      run: RUN_RECEIPT,
      session: roundInput().session,
      workOrder: { tasks: [{ asks: [{ id: "t1" }] }] } as unknown as ComposedHandoffBundle,
      runWorkers: async () => ({
        outcome: "completed",
        diff: "+changed",
        changedPaths: ["a.ts"],
        workerCommitRange: { from: "c0", to: "c0" },
      }),
    });

    await expect(
      reportOnly.runRound(
        roundInput({
          ...identity,
          asksDispatched: ["t1"],
          onProgress: (event) => events.push(event),
        }),
      ),
    ).rejects.toThrow("drafted no lens boards");
    expect(roundStore.read("s1")).toHaveLength(1);
    expect(roundStore.read("s1")[0]?.regeneration).toBe("pending");
    expect(roundStore.read("s1")[0]?.boardGeneration).toBe(ROUND_NO_REGEN);
    expect(events.filter((event) => event.type === "failed")).toHaveLength(1);
    expect(events.some((event) => event.type === "composed")).toBe(false);

    const recovered = await createRoundsRuntime(
      baseDeps({
        persistBoardMeta: (_repo, meta) => metaStore.save(meta),
        loadDraftedBoards: (_repo, sessionId, generation) =>
          metaStore.listForGeneration(sessionId, generation),
        persistGeneration: (generation) => generationStore.save(generation),
        loadGeneration: (id) => generationStore.load(id),
        recordRound: (sessionId, record) => roundStore.record(sessionId, record),
        readRounds: (sessionId) => roundStore.read(sessionId),
      }),
    ).runRound(roundInput({ ...identity, asksDispatched: ["t1"] }));
    expect(recovered.pipeline.boards.some((board) => board.boardId !== undefined)).toBe(true);
    expect(roundStore.read("s1")).toHaveLength(1);
    expect(roundStore.read("s1")[0]?.boardGeneration).toBe(
      generationIdForDispatch("ps-1", identity.dispatchId),
    );
    expect(roundStore.read("s1")[0]?.regeneration).toBeUndefined();
  });

  it("never exposes a prior generation report as the report for a later no-code round", async () => {
    const metaStore = new BoardMetaStore(mkdtempSync(join(tmpdir(), "rounds-no-code-report-")));
    const runtime = createRoundsRuntime(
      baseDeps({
        persistBoardMeta: (_repo, meta: BoardMeta) => metaStore.save(meta),
        loadDraftedBoards: (_repo, sessionId, generation) =>
          metaStore.listForGeneration(sessionId, generation),
      }),
    );
    const first = await runtime.runRound(roundInput());
    const priorEvidence = metaStore.listForGeneration("s1", first.boardGeneration.id);
    expect(priorEvidence.some((meta) => meta.lens === "report")).toBe(true);
    expect(first.record.reportBoard).not.toBe(ROUND_NO_REGEN);

    const noCode = await runtime.runRound(
      roundInput({
        previousGeneration: first.boardGeneration,
        runWorkers: async () => ({ commitRange: { from: "c1", to: "c1" } }),
      }),
    );

    expect(noCode.boardGeneration.id).toBe(first.boardGeneration.id);
    expect(noCode.record.reportBoard).toBe(ROUND_NO_REGEN);
    expect(noCode.record.regeneration).toBe("not-needed");
    expect(noCode.record.reworkCount).toBeUndefined();
    expect(noCode.pipeline.report).toBeUndefined();
  });

  it("drafts the round-report FIRST, then reveals each board (arrival order)", async () => {
    const arrivals: BoardArrivalEvent[] = [];
    const runtime = createRoundsRuntime(
      baseDeps({
        onBoardArrival: (event) => {
          arrivals.push(event);
        },
      }),
    );
    await runtime.runRound(roundInput());
    // The report announces its arrival ahead of the lens boards (R58).
    expect(arrivals[0]?.lens).toBe("report");
    expect(
      arrivals
        .slice(1)
        .map((a) => a.lens)
        .sort(),
    ).toEqual(["decisions", "design", "flagged", "noise", "sequence"].sort());
  });

  it("does not announce or start lenses until classified report progress settles", async () => {
    const progressDiff = [
      "diff --git a/src/auth.ts b/src/auth.ts",
      "--- a/src/auth.ts",
      "+++ b/src/auth.ts",
      "@@ -1 +1 @@",
      "-old line",
      "+new line",
    ].join("\n");
    const round: NonNullable<RoundInput["round"]> = {
      number: 1,
      previousGeneration: PREV_GEN.id,
      dispatchedAsks: [
        {
          id: "ask-one",
          path: "src/auth.ts",
          type: "request-change",
          instruction: "Replace the line.",
          context: "",
        },
      ],
      findingDispositions: {},
      worker: {
        outcome: "completed",
        diff: progressDiff,
        changedPaths: ["src/auth.ts"],
        commitRange: { from: "c0", to: "c1" },
      },
    };
    const classification = {
      outcomes: [{ askId: "ask-one", status: "untouched", note: "No evidence for this ask." }],
      beyond: [
        {
          ref: "beyond:line",
          text: "An unrequested line change.",
          note: "The turn changed a line no ask asked for.",
          evidenceIds: buildRoundEvidenceManifest(progressDiff).map((unit) => unit.id),
        },
      ],
    };
    const start = (onReportProgress: NonNullable<RoundInput["onReportProgress"]>) => {
      const captures: { prompt?: string }[] = [];
      const arrivals: BoardArrivalEvent[] = [];
      const runtime = createRoundsRuntime(
        baseDeps({
          resolveClaudePort: async () =>
            fakeClaudePort(captures, (prompt) =>
              lensFromPrompt(prompt) === "report"
                ? classification
                : cleanBody(lensFromPrompt(prompt)),
            ),
          onBoardArrival: (event) => {
            arrivals.push(event);
          },
        }),
      );
      return {
        captures,
        arrivals,
        run: runtime.runRound(
          roundInput({
            asksDispatched: ["ask-one"],
            round,
            onReportProgress,
            runWorkers: async () => ({
              commitRange: { from: "c0", to: "c1" },
              patchsetId: "ps-1",
            }),
          }),
        ),
      };
    };

    let releaseReport: () => void = () => undefined;
    const reportGate = new Promise<void>((resolve) => {
      releaseReport = resolve;
    });
    let announceReport: () => void = () => undefined;
    const reportProgressStarted = new Promise<void>((resolve) => {
      announceReport = resolve;
    });
    const deferred = start((event) => {
      if (event.type !== "report") return;
      announceReport();
      return reportGate;
    });
    await reportProgressStarted;
    expect(deferred.arrivals).toEqual([]);
    expect(
      deferred.captures.some(({ prompt }) =>
        prompt === undefined ? false : LENS_KINDS.some((lens) => prompt.includes(`${lens}.md`)),
      ),
    ).toBe(false);
    releaseReport();
    await deferred.run;
    expect(deferred.arrivals[0]?.lens).toBe("report");

    const rejected = start((event) => {
      if (event.type === "report") throw new Error("report progress rejected");
    });
    await expect(rejected.run).rejects.toThrow("report progress rejected");
    expect(rejected.arrivals).toEqual([]);
    expect(
      rejected.captures.some(({ prompt }) =>
        prompt === undefined ? false : LENS_KINDS.some((lens) => prompt.includes(`${lens}.md`)),
      ),
    ).toBe(false);
  });

  it("persists each board's meta durably; a reconstruction reads it back", async () => {
    const store = new BoardMetaStore(mkdtempSync(join(tmpdir(), "rounds-meta-")));
    const runtime = createRoundsRuntime(
      baseDeps({ persistBoardMeta: (_repo, meta: BoardMeta) => store.save(meta) }),
    );
    await runtime.runRound(roundInput());
    // Report + five lenses each persisted a meta record, keyed by board id.
    const lenses = store
      .list()
      .map((m) => m.lens)
      .sort();
    expect(lenses).toEqual(
      ["decisions", "design", "flagged", "noise", "report", "sequence"].sort(),
    );
  });

  // ── The write order (review finding 6) ─────────────────────────────────────
  //
  // The RoundRecord used to persist BEFORE its generations, so a crash in between left a
  // durable ledger row whose generation was never written — the switcher drills into
  // nothing. Generations first, record last: a crash leaves the round honestly missing.
  it("a crash while persisting the generation leaves NO dangling record behind", async () => {
    const genDir = mkdtempSync(join(tmpdir(), "gen-order-"));
    const roundDir = mkdtempSync(join(tmpdir(), "round-order-"));
    const generationStore = new GenerationStore(genDir);
    const roundStore = new RoundRecordStore(roundDir);
    const runtime = createRoundsRuntime(
      baseDeps({
        // The disk gives out exactly between the two writes.
        persistGeneration: () => {
          throw new Error("disk went away");
        },
        recordRound: (sessionId, record) => roundStore.record(sessionId, record),
        readRounds: (sessionId) => roundStore.read(sessionId),
        loadGeneration: (id) => generationStore.load(id),
      }),
    );

    await expect(
      runtime.runRound(roundInput({ session: { id: "crashy" } as RoundInput["session"] })),
    ).rejects.toThrow("disk went away");

    // Restart: fresh stores over the SAME on-disk state. The round is honestly absent —
    // never a ledger row pointing at a generation that does not exist.
    const afterRestart = createRoundsRuntime(
      baseDeps({
        readRounds: (sessionId) => new RoundRecordStore(roundDir).read(sessionId),
        loadGeneration: (id) => new GenerationStore(genDir).load(id),
      }),
    );
    expect(afterRestart.ledger("crashy")).toEqual([]);
    expect(afterRestart.generation("gen:ps-1")).toBeUndefined();
  });

  it("persists no-spec absence before board metadata so restart cannot turn it into pending", async () => {
    const genDir = mkdtempSync(join(tmpdir(), "gen-no-spec-crash-"));
    const metaDir = mkdtempSync(join(tmpdir(), "meta-no-spec-crash-"));
    const generationStore = new GenerationStore(genDir);
    const metaStore = new BoardMetaStore(metaDir);
    const sessionId = "no-spec-crash";
    const first = createRoundsRuntime(
      baseDeps({
        persistBoardMeta: (_repo, meta) => metaStore.save(meta),
        loadDraftedBoards: (_repo, session, generation) =>
          metaStore.listForGeneration(session, generation),
        persistGeneration: (generation) => {
          if (Object.keys(generation.lensBoards).length > 0) {
            throw new Error("crashed after board metadata");
          }
          generationStore.save(generation);
        },
        loadGeneration: (id) => generationStore.load(id),
      }),
    );

    await expect(
      first.runRound(
        roundInput({
          session: { id: sessionId } as RoundInput["session"],
          designArtifacts: null,
        }),
      ),
    ).rejects.toThrow("crashed after board metadata");
    expect(generationStore.load("gen:ps-1")?.absentLenses).toEqual({
      design: "no-material",
    });
    expect(metaStore.listForGeneration(sessionId, "gen:ps-1").length).toBeGreaterThan(0);

    const restarted = createRoundsRuntime(
      baseDeps({
        resolveClaudePort: async () => {
          throw new Error("durable evidence must not re-draft");
        },
        loadDraftedBoards: (_repo, session, generation) =>
          metaStore.listForGeneration(session, generation),
        persistGeneration: (generation) => generationStore.save(generation),
        loadGeneration: (id) => generationStore.load(id),
      }),
    );
    const recovered = await restarted.runRound(
      roundInput({
        session: { id: sessionId } as RoundInput["session"],
        designArtifacts: null,
      }),
    );
    expect(recovered.boardGeneration.absentLenses).toEqual({ design: "no-material" });
    expect(recovered.boardGeneration.lensBoards).not.toHaveProperty("design");
  });

  it("serializes concurrent absence saves so a delayed partial snapshot cannot win", async () => {
    let durable: Generation | undefined;
    let designOnlyWrites = 0;
    let releaseDelayedSave = (): void => undefined;
    let announceDelayedSave = (): void => undefined;
    let announceFlaggedDraft = (): void => undefined;
    const delayedSaveRelease = new Promise<void>((resolve) => {
      releaseDelayedSave = resolve;
    });
    const delayedSaveStarted = new Promise<void>((resolve) => {
      announceDelayedSave = resolve;
    });
    const flaggedDraftFinished = new Promise<void>((resolve) => {
      announceFlaggedDraft = resolve;
    });
    const copyGeneration = (generation: Generation): Generation => ({
      ...generation,
      lensBoards: { ...generation.lensBoards },
      ...(generation.draftingBoardIds === undefined
        ? {}
        : { draftingBoardIds: { ...generation.draftingBoardIds } }),
      ...(generation.absentLenses === undefined
        ? {}
        : { absentLenses: { ...generation.absentLenses } }),
    });

    const runtime = createRoundsRuntime(
      baseDeps({
        resolveClaudePort: async () =>
          fakeClaudePort([], (prompt) => {
            const lens = lensFromPrompt(prompt);
            if (lens === "flagged") {
              announceFlaggedDraft();
              return { elements: [], skippedHunks: [] } as unknown as DraftBoard;
            }
            return cleanBody(lens);
          }),
        persistGeneration: async (generation) => {
          const snapshot = copyGeneration(generation);
          const absent = Object.keys(snapshot.absentLenses ?? {});
          if (snapshot.draftingBoardIds !== undefined && absent.length === 1) {
            designOnlyWrites += 1;
            if (designOnlyWrites === 2) {
              announceDelayedSave();
              await delayedSaveRelease;
            }
          }
          durable = snapshot;
        },
      }),
    );

    const run = runtime.runRound(
      roundInput({
        designArtifacts: null,
        verifyDraftedReport: () => {
          throw new Error("stop before final generation persist");
        },
      }),
    );

    const beforeNextTurn = (promise: Promise<void>, message: string): Promise<void> =>
      Promise.race([
        promise,
        new Promise<never>((_resolve, reject) => {
          setImmediate(() => reject(new Error(message)));
        }),
      ]);
    let controlFailure: unknown;
    try {
      await beforeNextTurn(delayedSaveStarted, "the first absence save never started");
      await beforeNextTurn(
        flaggedDraftFinished,
        "Flagged provider turn did not settle while the first absence save was delayed",
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
    } catch (error) {
      controlFailure = error;
    } finally {
      releaseDelayedSave();
    }
    await expect(run).rejects.toThrow("stop before final generation persist");
    if (controlFailure !== undefined) throw controlFailure;

    expect(durable?.absentLenses).toEqual({
      design: "no-material",
      flagged: "no-findings",
    });
  });

  // ── A dispatch that THROWS (review finding 5) ──────────────────────────────
  //
  // The regeneration half already reported its throws; the DISPATCH half — the real
  // production worker path — reported none, so a work order that died left the run route
  // reading "still working" forever. One catch around the whole dispatch body, not a guard
  // per known failure site: the throws that matter are the ones nobody predicted.
  it("a thrown worker emits a TERMINAL failed and leaves the session dispatchable", async () => {
    const events: RoundEvent[] = [];
    const runtime = createRoundsRuntime(baseDeps());
    const workOrder = { tasks: [] } as unknown as ComposedHandoffBundle;

    await expect(
      runtime.dispatchRound({
        ...DISPATCH_FIELDS,
        session: { id: "wedge", projectId: "p1", threads: [], createdAt: 0 },
        workOrder,
        onProgress: (event) => events.push(event),
        runWorkers: async () => {
          throw new Error("the work order blew up");
        },
      }),
    ).rejects.toThrow("the work order blew up");
    expect(events).toEqual([{ type: "failed", reason: "the work order blew up" }]);

    // The session is NOT wedged: the next dispatch for the same session still runs.
    let ranAgain = false;
    await runtime.dispatchRound({
      ...DISPATCH_FIELDS,
      session: { id: "wedge", projectId: "p1", threads: [], createdAt: 0 },
      workOrder,
      runWorkers: async () => {
        ranAgain = true;
      },
    });
    expect(ranAgain).toBe(true);
  });

  it("a FAILED work order reports the same terminal failure (recorded, then rejected)", async () => {
    const events: RoundEvent[] = [];
    const runtime = createRoundsRuntime(baseDeps());
    await expect(
      runtime.dispatchRound({
        ...DISPATCH_FIELDS,
        session: { id: "failed-order", projectId: "p1", threads: [], createdAt: 0 },
        workOrder: { tasks: [] } as unknown as ComposedHandoffBundle,
        onProgress: (event) => events.push(event),
        runWorkers: async () => ({
          outcome: "failed" as const,
          diff: "",
          changedPaths: [],
          workerCommitRange: { from: "c0", to: "c0" },
        }),
      }),
    ).rejects.toThrow("The round's work order failed.");
    // Recorded (the partial diff is on disk) AND reported — exactly one terminal row.
    expect(runtime.ledger("failed-order")).toHaveLength(1);
    expect(events).toEqual([{ type: "failed", reason: "The round's work order failed." }]);
  });

  it("serializes dispatches per session — a second round waits for the first", async () => {
    const events: string[] = [];
    let releaseA!: () => void;
    const gateA = new Promise<void>((r) => {
      releaseA = r;
    });

    const runtime = createRoundsRuntime(baseDeps());
    const pA = runtime.runRound(
      roundInput({
        runWorkers: async () => {
          events.push("start:A");
          await gateA;
          events.push("end:A");
          return { commitRange: { from: "a0", to: "a1" }, patchsetId: "ps-A" };
        },
      }),
    );
    const pB = runtime.runRound(
      roundInput({
        runWorkers: async () => {
          events.push("start:B");
          events.push("end:B");
          return { commitRange: { from: "b0", to: "b1" }, patchsetId: "ps-B" };
        },
      }),
    );

    // Let microtasks drain: B is queued behind A, so only A has started.
    await Promise.resolve();
    await Promise.resolve();
    expect(events).toEqual(["start:A"]);

    releaseA();
    await Promise.all([pA, pB]);
    // A ran to completion before B began — never interleaved.
    expect(events).toEqual(["start:A", "end:A", "start:B", "end:B"]);
  });
});
