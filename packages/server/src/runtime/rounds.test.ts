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
import type { BenchmarkRun } from "@rennet/protocol";
import {
  type ComposedHandoffBundle,
  type DraftBoard,
  type FindingDisposition,
  findingRefKey,
  type Generation,
  type GenerationPhaseTiming,
  GenerationSchema,
  generationIdForDispatch,
  LENS_KINDS,
  lensAdmitsAbsence,
  ROUND_NO_REGEN,
  type RoundEvent,
  type RoundRunReceipt,
} from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import { type BoardsRuntime, createBoardsRuntime } from "../boards/boards-runtime";
import { withFakeT3Seats } from "../t3-seat-fake";
import type { BoardArrivalEvent, BoardMeta } from "./lens-pipeline";
import { buildRoundEvidenceManifest } from "./round-evidence-manifest";
import {
  createRoundsRuntime,
  freezeGeneration,
  mintGeneration,
  type RoundInput,
  type RoundsRuntimeDeps,
  revealFromGeneration,
  sameDraftingAttempt,
  withLensBoards,
} from "./rounds";

// ── Fakes (no live model — inject ports, the runtime is pure over the seams) ──

/** A round packet — carries a successor account, so the pipeline drafts the report FIRST. */
const ROUND_PACKET = {
  patchset: {
    id: "ps-1",
    createdAt: "",
    truncated: false,
    files: [],
    // The seat threads are titled from the session's claimed branch, falling back to this
    // base ref, so a packet without it is not a packet a generation can draft over.
    repository: { baseRef: "origin/main", baseOid: "base", headOid: "head" },
  },
  successorAccount: { asks: [] },
} as unknown as DeltaPacket;

const lintContextFor = (lens: LintTarget): LintContext => ({
  lens,
  regions: [{ path: "src/auth.ts", side: "head", start: 1, end: 200 }],
  files: new Map(),
});
const readPrompt = (file: string): string => `PROMPT_FILE:${file}`;
/**
 * Which lens a turn belongs to. The prompt-file marker names it on a DRAFTING turn; a
 * repair turn carries pointers and frozen ids and nothing else (session-bound-workspace
 * 3.2), so it is named by the session's seat label — `board.lens-draft.design` — which is
 * what the daemon's log and the token collector attribute a turn by too.
 */
const lensFromPrompt = (prompt: string, label?: string): string => {
  const marker = /PROMPT_FILE:prompts\/([a-z-]+)\.md/.exec(prompt)?.[1];
  if (marker !== undefined) return marker;
  const seat = label?.split(".").at(-1);
  if (seat === undefined) return "unknown";
  return seat.startsWith("flagged") ? "flagged" : seat;
};
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
  } as DraftBoard;
};

/** A fake Claude port that answers a lens-appropriate clean board every turn, or whatever
 *  `bodyFor` decides when a test needs a specific seat to answer something particular. */
function fakeClaudePort(
  captures: { prompt?: string; label?: string }[] = [],
  bodyFor: (prompt: string, label?: string) => unknown = (prompt, label) =>
    cleanBody(lensFromPrompt(prompt, label)),
): HarnessPort {
  return {
    createSession: async (options: { label?: string }) => {
      const capture: { prompt?: string; label?: string } = { label: options.label };
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
              structuredOutput: bodyFor(capture.prompt ?? "", capture.label),
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

/**
 * The Design seat's D6 return when the branch has no specification. The absence is the
 * seat's own claim now — there is no host bundle to settle the lane before drafting —
 * so every test that wants an absent Design lane drives it through the port.
 */
const noSpecBodyFor = (prompt: string): unknown =>
  lensFromPrompt(prompt) === "design" ? { absence: "no-spec" } : cleanBody(lensFromPrompt(prompt));

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

describe("durable reveal state (#725 7.2)", () => {
  const attempt = (over: Partial<Generation> = {}): Generation => ({
    ...mintGeneration("gen:ps-1", "ps-1"),
    draftingBoardIds: {
      design: "b:design",
      sequence: "b:sequence",
      decisions: "b:decisions",
      flagged: "b:flagged",
      noise: "b:noise",
    },
    draftingReportBoardId: "b:report",
    ...over,
  });

  it("reconstructs which lanes settled", () => {
    const reveal = revealFromGeneration(
      attempt({
        lensBoards: { sequence: "b:sequence", decisions: "b:decisions" },
        absentLenses: { noise: "no-noise" },
      }),
    );
    expect(Object.fromEntries(reveal.lanes.map((lane) => [lane.id, lane.status]))).toEqual({
      design: "queued",
      sequence: "drafted",
      decisions: "drafted",
      flagged: "queued",
      noise: "absent",
    });
  });

  it("reconstructs a RETRYABLE failure as pending, because the restart redraft re-runs it", () => {
    const retryable = revealFromGeneration(
      attempt({
        failedLenses: { flagged: "the drafting turn emitted no board" },
        failedLensAccounts: { flagged: { attempt: 0, classification: "retryable" } },
      }),
    );
    expect(retryable.lanes.find(({ id }) => id === "flagged")?.status).toBe("queued");
    // A TERMINAL failure has no redraft coming, so it reconstructs as settled-failed.
    const terminal = revealFromGeneration(
      attempt({
        failedLenses: { flagged: "no parseable board across 1 attempt" },
        failedLensAccounts: { flagged: { attempt: 1, classification: "terminal" } },
      }),
    );
    expect(terminal.lanes.find(({ id }) => id === "flagged")?.status).toBe("failed");
  });

  it("identifies a drafting attempt by its reserved slots, so a later attempt is not the same one", () => {
    const first = attempt();
    expect(sameDraftingAttempt(first, { ...first })).toBe(true);
    // A replacement attempt mints new slots.
    expect(sameDraftingAttempt(first, attempt({ draftingReportBoardId: "b:report-2" }))).toBe(
      false,
    );
    expect(
      sameDraftingAttempt(first, {
        ...first,
        draftingBoardIds: { ...first.draftingBoardIds, noise: "b:noise-2" },
      }),
    ).toBe(false);
    // A SETTLED generation has dropped its slots entirely — also not this attempt.
    const settled = withLensBoards(first, { boards: [] });
    expect(sameDraftingAttempt(first, settled)).toBe(false);
  });
});

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
          absence: "no-spec",
          omissions: [],
          blemishes: [],
          immutability: [],
        },
      ],
    });
    expect(gen.lensBoards).toEqual({});
    expect(gen.absentLenses).toEqual({ design: "no-spec" });
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

  it("persists the typed failure ACCOUNT beside the drafter's words (#549)", () => {
    const gen = withLensBoards(mintGeneration("g", "ps"), {
      boards: [
        {
          lens: "noise",
          failure: "noise lens: the drafting seat threw.",
          failureAccount: { attempt: 2, classification: "retryable" },
          omissions: [],
          blemishes: [],
          immutability: [],
        },
        {
          lens: "design",
          failure: "design lens: no runnable seat.",
          omissions: [],
          blemishes: [],
          immutability: [],
        },
      ],
    });
    expect(gen.failedLenses).toEqual({
      noise: "noise lens: the drafting seat threw.",
      design: "design lens: no runnable seat.",
    });
    // Only the lane that named an account carries one — an unaccounted failure stays
    // unaccounted rather than being defaulted to a classification nobody determined.
    expect(gen.failedLensAccounts).toEqual({
      noise: { attempt: 2, classification: "retryable" },
    });
  });

  it("refuses to persist an absence the lens does not admit, recording a failure (#549)", () => {
    // `no-spec` is Design's absence; Sequence admits none at all. A lens settling
    // another lens's absence is a producer defect, and persisting it would make the wrong
    // pairing indistinguishable from a real clean result forever after.
    const gen = withLensBoards(mintGeneration("g", "ps"), {
      boards: [
        {
          lens: "sequence",
          absence: "no-spec",
          omissions: [],
          blemishes: [],
          immutability: [],
        },
      ],
    });
    expect(gen.absentLenses).toBeUndefined();
    expect(gen.failedLenses?.sequence).toContain("does not admit");
    // RETRYABLE, not terminal: `terminal` in this model means the retries are spent, and
    // this lane has spent none — the attempt count beside it says so. A drafting attempt is
    // exactly what answers a seat that settled an absence its row does not admit.
    expect(gen.failedLensAccounts?.sequence).toEqual({ attempt: 0, classification: "retryable" });
    expect(lensAdmitsAbsence("sequence", "no-spec")).toBe(false);
    expect(lensAdmitsAbsence("design", "no-spec")).toBe(true);
  });

  it("clears a durable lens absence when that lens later produces a board", () => {
    const absent = withLensBoards(mintGeneration("g", "ps"), {
      boards: [
        {
          lens: "design",
          absence: "no-spec",
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
  it("binds the session-context writer to the DRAFTING root and the session id (session-context-files)", async () => {
    // The seats' cwd is `draftingRoot` when one is set — a range review's evidence
    // worktree — and a relative context path only resolves there, not under `repoRoot`.
    //
    // One runtime per case on purpose: a second `runRound` on the same runtime reuses the
    // durable attempt of the first and never re-enters the pipeline, so the two roots
    // would be compared against one run's writes.
    const rootsWrittenFor = async (over: Partial<RoundInput>): Promise<readonly string[]> => {
      const calls: { root: string; sessionId: string }[] = [];
      const runtime = createRoundsRuntime(
        withFakeT3Seats(
          baseDeps({
            writeSessionContext: (root, sessionId) => {
              calls.push({ root, sessionId });
              return `${root}/.rennet/context/${sessionId}`;
            },
          }),
        ),
      );
      await runtime.runRound(roundInput(over));
      expect(calls.length).toBeGreaterThan(0);
      expect(calls.every(({ sessionId }) => sessionId === "s1")).toBe(true);
      return calls.map(({ root }) => root);
    };

    expect([...new Set(await rootsWrittenFor({ draftingRoot: "/evidence-worktree" }))]).toEqual([
      "/evidence-worktree",
    ]);
    // Without a drafting root the writer is bound to the review root itself.
    expect([...new Set(await rootsWrittenFor({}))]).toEqual(["/pr-worktree"]);
  });

  it("records a RoundRecord pinning asks, commit range, minted+board generation, and report board", async () => {
    const runtime = createRoundsRuntime(withFakeT3Seats(baseDeps()));
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
      withFakeT3Seats(
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
      ),
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
      withFakeT3Seats(
        baseDeps({
          resolveClaudePort: async () =>
            fakeClaudePort([], (prompt, label) =>
              lensFromPrompt(prompt, label) === "flagged"
                ? ({
                    elements: [{ id: "invalid", kind: "not-a-kind", data: {} }],
                  } as unknown as DraftBoard)
                : cleanBody(lensFromPrompt(prompt, label)),
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
      ),
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
      withFakeT3Seats(
        baseDeps({
          persistGeneration: (gen) => generationStore.save(gen),
          recordRound: (sessionId, record) => roundStore.record(sessionId, record),
          readRounds: (sessionId) => roundStore.read(sessionId),
          loadGeneration: (id) => generationStore.load(id),
        }),
      ),
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
      withFakeT3Seats(baseDeps({ loadGeneration: (id) => new GenerationStore(genDir).load(id) })),
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
      withFakeT3Seats(
        baseDeps({
          // The report seat's own turn AND its post-process pass both answer the report
          // board — otherwise the editor pass would hand back prose and the typed outcomes
          // would read as dropped. (The lens drafters receive the report as CONTEXT, so the
          // post-process branch is keyed on the file it is polishing, not on the context.)
          resolveClaudePort: async () =>
            fakeClaudePort([], (prompt, label) => {
              const polishingReport =
                prompt.includes("prompts/post-process.md") && prompt.includes("round_outcome");
              return prompt.includes("prompts/report.md") || polishingReport
                ? reportBoard
                : cleanBody(lensFromPrompt(prompt, label));
            }),
        }),
      ),
    );
    const { record } = await runtime.runRound(roundInput({ asksDispatched: ["t1", "t2", "t3"] }));
    expect(record.asksDispatched).toHaveLength(3);
    expect(record.reworkCount).toBe(2);
  });

  it("a round whose report never drafted records NO rework count, not a zero", async () => {
    // No report seat resolves ⇒ no report board ⇒ the count is honestly unknown.
    const runtime = createRoundsRuntime(withFakeT3Seats(baseDeps()));
    const { record, pipeline } = await runtime.runRound(roundInput());
    // (The fake report board carries no `round_outcome` items, so the count is a real 0.)
    expect(record.reworkCount).toBe(0);
    expect(pipeline.report?.boardId).toBeDefined();
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
      withFakeT3Seats(
        baseDeps({
          ...durableDeps,
          resolveClaudePort: async () =>
            fakeClaudePort(firstCaptures, (prompt, label) =>
              lensFromPrompt(prompt, label) === "report"
                ? classification
                : cleanBody(lensFromPrompt(prompt, label)),
            ),
        }),
      ),
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
      withFakeT3Seats(
        baseDeps({
          ...durableDeps,
          resolveClaudePort: async () =>
            fakeClaudePort(retryCaptures, (prompt, label) => {
              if (lensFromPrompt(prompt, label) === "report") {
                throw new Error("a persisted report must not open another provider turn");
              }
              return cleanBody(lensFromPrompt(prompt, label));
            }),
        }),
      ),
    ).runRound({
      ...input,
      draftPlan: { generation: attempt.id, boardIds },
      onProgress: (event) => progress.push(event),
    });

    expect(retryCaptures.some(({ prompt }) => prompt?.includes("prompts/report.md"))).toBe(false);
    expect(retryCaptures.some(({ prompt }) => prompt?.includes("prompts/design.md"))).toBe(true);
    // #725 7.2 — a resumed attempt republishes the DURABLE reveal state before it clears
    // and redrafts, so the reconnecting surface sees what already settled rather than a
    // reset. The verified report handoff follows it.
    expect(progress[0]?.type).toBe("lens");
    expect(progress.find((event) => event.type === "report")).toBeDefined();
    expect(recovered.pipeline.report?.boardId).toBe(attempt.draftingReportBoardId);
    expect(recovered.record.reportBoard).toBe(attempt.draftingReportBoardId);
  });

  it("repeats the classifier call after a crash BETWEEN board apply and meta persistence", async () => {
    // Retitled honestly (#727 fix round): this crashes in `persistBoardMeta`, which the
    // pipeline calls AFTER `whiteboard.apply` — so the projection has already landed and
    // what this covers is the apply-to-meta window, not "before projection". The crash
    // BEFORE apply is the test immediately below.
    //
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
          fakeClaudePort(captures, (prompt, label) =>
            lensFromPrompt(prompt, label) === "report"
              ? classification
              : cleanBody(lensFromPrompt(prompt, label)),
          ),
      });

    const firstCaptures: { prompt?: string }[] = [];
    await expect(
      createRoundsRuntime(withFakeT3Seats(withClassifier(firstCaptures))).runRound(input),
    ).rejects.toThrow("crash before report projection");
    expect(
      firstCaptures.filter(({ prompt }) => prompt?.includes("prompts/report.md")),
    ).toHaveLength(1);
    expect(meta.load(boardIds.report)).toBeUndefined();

    const secondCaptures: { prompt?: string }[] = [];
    const recovered = await createRoundsRuntime(
      withFakeT3Seats(withClassifier(secondCaptures)),
    ).runRound(input);

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

  it("repeats the classifier call after a crash BEFORE the board apply and lands exactly one report", async () => {
    // The window the spec's recovery scenario actually names: the provider answered and
    // the process died before ANY durable projection. Crashing at `persistBoardMeta` (the
    // test above) is a later window — the board ops are already committed by then, so it
    // cannot see a report that half-projected. Here the seam sits in `service.apply`
    // itself, which `WhiteboardClient.apply` delegates to, and refuses the report board's
    // first write outright: zero report elements durable, then recovery.
    const repoRoot = mkdtempSync(join(tmpdir(), "rounds-report-preapply-repo-"));
    const meta = new BoardMetaStore(mkdtempSync(join(tmpdir(), "rounds-report-preapply-meta-")));
    const generations = new GenerationStore(
      mkdtempSync(join(tmpdir(), "rounds-report-preapply-generation-")),
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
    const boardIds = reservedBoardIds("report-preapply");
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

    let crashBeforeReportApply = true;
    // The seam: the board service the pipeline's `WhiteboardClient` writes through. It
    // throws for the report board's first apply, so nothing is appended at all.
    const crashingBoards: BoardsRuntime = {
      createRennetBoard: (boardId?: string) => boards.createRennetBoard(boardId),
      service: new Proxy(boards.service, {
        get(target, property, receiver) {
          if (property === "apply") {
            return (boardId: string, ...rest: unknown[]) => {
              if (boardId === boardIds.report && crashBeforeReportApply) {
                crashBeforeReportApply = false;
                throw new Error("crash before report apply");
              }
              return (target.apply as (...args: unknown[]) => unknown)(boardId, ...rest);
            };
          }
          const value = Reflect.get(target, property, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }),
    };
    const durableDeps = {
      boardsRuntimeFor: () => crashingBoards,
      persistBoardMeta: (_repo: string, record: Parameters<BoardMetaStore["save"]>[0]) =>
        meta.save(record),
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
          fakeClaudePort(captures, (prompt, label) =>
            lensFromPrompt(prompt, label) === "report"
              ? classification
              : cleanBody(lensFromPrompt(prompt, label)),
          ),
      });

    const firstCaptures: { prompt?: string }[] = [];
    await expect(
      createRoundsRuntime(withFakeT3Seats(withClassifier(firstCaptures))).runRound(input),
    ).rejects.toThrow("crash before report apply");
    expect(
      firstCaptures.filter(({ prompt }) => prompt?.includes("prompts/report.md")),
    ).toHaveLength(1);
    // ZERO report elements durable — the crash landed before a single op was appended.
    expect([...(await boards.service.getState(boardIds.report)).values()]).toHaveLength(0);
    expect(meta.load(boardIds.report)).toBeUndefined();

    const secondCaptures: { prompt?: string }[] = [];
    const recovered = await createRoundsRuntime(
      withFakeT3Seats(withClassifier(secondCaptures)),
    ).runRound(input);

    // Two provider calls across the two runs — explicitly allowed, and NOT what is
    // exactly-once. Exactly one projection is.
    expect(
      secondCaptures.filter(({ prompt }) => prompt?.includes("prompts/report.md")),
    ).toHaveLength(1);
    expect(recovered.pipeline.report?.boardId).toBe(boardIds.report);
    expect(meta.load(boardIds.report)?.lens).toBe("report");
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

    await createRoundsRuntime(withFakeT3Seats(baseDeps(durableDeps))).runRound(input);
    expect(LENS_KINDS.every((lens) => meta.load(boardIds[lens])?.lens === lens)).toBe(true);
    expect(meta.load(boardIds.report)?.lens).toBe("report");
    meta.remove(boardIds.report);
    expect(meta.load(boardIds.report)).toBeUndefined();

    const captures: { prompt?: string }[] = [];
    const recovered = await createRoundsRuntime(
      withFakeT3Seats(
        baseDeps({
          ...durableDeps,
          resolveClaudePort: async () => fakeClaudePort(captures),
        }),
      ),
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
      withFakeT3Seats(
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
      ),
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
      withFakeT3Seats(
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
      ),
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
    const input = roundInput();
    const first = await createRoundsRuntime(
      withFakeT3Seats(
        baseDeps({
          resolveClaudePort: async () =>
            fakeClaudePort([], (prompt, label) => {
              const lens = lensFromPrompt(prompt, label);
              if (lens === "design") return { absence: "no-spec" };
              if (
                lens === "decisions" ||
                lens === "flagged" ||
                (lens === "post-process" && prompt.includes('"elements":[]'))
              ) {
                return { elements: [] } as unknown as DraftBoard;
              }
              return cleanBody(lens);
            }),
          persistBoardMeta: (_repo, record) => meta.save(record),
          persistGeneration: (generation) => generations.save(generation),
          loadGeneration: (id) => generations.load(id),
        }),
      ),
    ).runRound(input);
    expect(first.boardGeneration.absentLenses?.design).toBe("no-spec");
    expect(first.boardGeneration.absentLenses?.decisions).toBe("no-decisions");
    expect(first.boardGeneration.absentLenses?.flagged).toBe("no-findings");
    expect(first.boardGeneration.lensBoards.sequence).toBeDefined();

    const recovered = await createRoundsRuntime(
      withFakeT3Seats(
        baseDeps({
          resolveClaudePort: async () => {
            throw new Error("complete evidence must reconstruct without a model");
          },
          loadDraftedBoards: (_repo, sessionId, generation) =>
            meta.listForGeneration(sessionId, generation),
          persistGeneration: (generation) => generations.save(generation),
          loadGeneration: (id) => generations.load(id),
        }),
      ),
    ).runRound(input);

    expect(recovered.pipeline.boards.find((outcome) => outcome.lens === "design")?.absence).toBe(
      "no-spec",
    );
    expect(recovered.pipeline.boards.find((outcome) => outcome.lens === "flagged")?.absence).toBe(
      "no-findings",
    );
    expect(recovered.pipeline.boards.find((outcome) => outcome.lens === "decisions")?.absence).toBe(
      "no-decisions",
    );
    expect(recovered.boardGeneration.absentLenses?.design).toBe("no-spec");
    expect(recovered.boardGeneration.absentLenses?.decisions).toBe("no-decisions");
    expect(recovered.boardGeneration.absentLenses?.flagged).toBe("no-findings");
    expect(recovered.boardGeneration.lensBoards.sequence).toBeDefined();
    expect(recovered.boardGeneration.lensBoards.design).toBeUndefined();
    expect(recovered.boardGeneration.lensBoards.decisions).toBeUndefined();
    expect(recovered.boardGeneration.lensBoards.flagged).toBeUndefined();
  });

  it("carries a failed lane's typed ACCOUNT across a restart, not just its words (#549)", async () => {
    const meta = new BoardMetaStore(mkdtempSync(join(tmpdir(), "rounds-account-meta-")));
    const generations = new GenerationStore(mkdtempSync(join(tmpdir(), "rounds-account-gen-")));
    const input = roundInput();
    const first = await createRoundsRuntime(
      withFakeT3Seats(
        baseDeps({
          resolveClaudePort: async () =>
            fakeClaudePort([], (prompt, label) => {
              const lens = lensFromPrompt(prompt, label);
              // The Noise seat completes every turn WITHOUT emitting — the production
              // no-board shape, which spends the ladder and settles terminal.
              return lens === "noise" ? undefined : cleanBody(lens);
            }),
          persistBoardMeta: (_repo, record) => meta.save(record),
          persistGeneration: (generation) => generations.save(generation),
          loadGeneration: (id) => generations.load(id),
        }),
      ),
    ).runRound(input);

    const drafted = first.pipeline.boards.find((outcome) => outcome.lens === "noise");
    expect(drafted?.failureAccount?.classification).toBe("terminal");
    expect(first.boardGeneration.failedLenses?.noise).toBeDefined();
    expect(first.boardGeneration.failedLensAccounts?.noise).toEqual(drafted?.failureAccount);

    // A FRESH runtime over the same on-disk evidence: no model, nothing in memory.
    const recovered = await createRoundsRuntime(
      withFakeT3Seats(
        baseDeps({
          resolveClaudePort: async () => {
            throw new Error("complete evidence must reconstruct without a model");
          },
          loadDraftedBoards: (_repo, sessionId, generation) =>
            meta.listForGeneration(sessionId, generation),
          persistGeneration: (generation) => generations.save(generation),
          loadGeneration: (id) => generations.load(id),
        }),
      ),
    ).runRound(input);

    const restored = recovered.pipeline.boards.find((outcome) => outcome.lens === "noise");
    expect(restored?.failure).toBe(first.boardGeneration.failedLenses?.noise);
    // The classification survives the restart. Before it was persisted, a reconstruction
    // had only the message and every restored failure read as terminal by default.
    expect(restored?.failureAccount).toEqual(drafted?.failureAccount);
  });

  it.each([
    { classification: "terminal" as const, redrafts: false },
    { classification: "retryable" as const, redrafts: true },
  ])(
    "re-drafts a $classification lens failure across a restart: $redrafts (#549)",
    async ({ classification, redrafts }) => {
      // The wedge this closes: every durable failure counted as complete lens evidence, so
      // a fresh runtime reconstructed a RETRYABLE failure off disk and never re-asked the
      // lens — a lane whose own account said it had attempts left could never spend one.
      // Scope of the control, stated exactly: each leg builds its OWN durable state from
      // the same script and then restamps one field, so within a leg the classification is
      // the only thing that differs between what the run wrote and what the restart reads.
      // The two legs are not compared byte-for-byte — nothing here asserts that — they are
      // constructed identically, which is what leaves the classification as the variable.
      const meta = new BoardMetaStore(mkdtempSync(join(tmpdir(), "rounds-restart-meta-")));
      const generations = new GenerationStore(mkdtempSync(join(tmpdir(), "rounds-restart-gen-")));
      const input = roundInput();
      const first = await createRoundsRuntime(
        withFakeT3Seats(
          baseDeps({
            resolveClaudePort: async () =>
              fakeClaudePort([], (prompt, label) => {
                const lens = lensFromPrompt(prompt, label);
                // The production no-board shape: the seat completes without emitting.
                return lens === "noise" ? undefined : cleanBody(lens);
              }),
            persistBoardMeta: (_repo, record) => meta.save(record),
            persistGeneration: (generation) => generations.save(generation),
            loadGeneration: (id) => generations.load(id),
          }),
        ),
      ).runRound(input);

      const settled = first.boardGeneration;
      expect(settled.failedLenses?.noise).toBeDefined();
      // Restamp the durable account, leaving the failure sentence and every BoardMeta
      // record exactly as the run left them: the classification is the only variable.
      generations.save({
        ...settled,
        failedLensAccounts: {
          ...settled.failedLensAccounts,
          noise: { attempt: 1, classification },
        },
      });

      // A FRESH runtime over that on-disk evidence. Its Noise seat now draws a real board,
      // so "did the lens re-draft?" is answered by whether a board arrives.
      let noiseTurns = 0;
      const recovered = await createRoundsRuntime(
        withFakeT3Seats(
          baseDeps({
            resolveClaudePort: async () =>
              fakeClaudePort([], (prompt, label) => {
                const lens = lensFromPrompt(prompt, label);
                if (lens === "noise") noiseTurns += 1;
                return cleanBody(lens);
              }),
            persistBoardMeta: (_repo, record) => meta.save(record),
            loadDraftedBoards: (_repo, sessionId, generation) =>
              meta.listForGeneration(sessionId, generation),
            persistGeneration: (generation) => generations.save(generation),
            loadGeneration: (id) => generations.load(id),
          }),
        ),
      ).runRound(input);

      const noise = recovered.pipeline.boards.find((outcome) => outcome.lens === "noise");
      expect(noiseTurns > 0).toBe(redrafts);
      if (redrafts) {
        // It spent the attempt its account promised, and the lens now holds a board.
        expect(noise?.failure).toBeUndefined();
        expect(noise?.boardId).toBeDefined();
        expect(recovered.boardGeneration.failedLenses?.noise).toBeUndefined();
      } else {
        // Retries spent: the reconstruction stands, and no model was asked.
        expect(noise?.failure).toBe(settled.failedLenses?.noise);
        expect(noise?.boardId).toBeUndefined();
      }
    },
  );

  it("clears a stale failure ACCOUNT with its failure when a partial attempt is persisted", async () => {
    // The retry path deletes the previous attempt's absences and failure sentences before
    // it writes the replacement attempt's identity — but it kept the ACCOUNTS. A crash
    // between that write and the settle then left a durable generation carrying a
    // classification for a failure that had already been cleared: an account about nothing,
    // and one a restart would have read as this attempt's verdict.
    const meta = new BoardMetaStore(mkdtempSync(join(tmpdir(), "rounds-stale-account-meta-")));
    const generations = new GenerationStore(
      mkdtempSync(join(tmpdir(), "rounds-stale-account-gen-")),
    );
    const input = roundInput();
    const first = await createRoundsRuntime(
      withFakeT3Seats(
        baseDeps({
          resolveClaudePort: async () =>
            fakeClaudePort([], (prompt, label) =>
              lensFromPrompt(prompt, label) === "noise"
                ? undefined
                : cleanBody(lensFromPrompt(prompt, label)),
            ),
          persistBoardMeta: (_repo, record) => meta.save(record),
          persistGeneration: (generation) => generations.save(generation),
          loadGeneration: (id) => generations.load(id),
        }),
      ),
    ).runRound(input);
    const settled = first.boardGeneration;
    expect(settled.failedLensAccounts?.noise).toBeDefined();
    // Retryable ⇒ the restart below takes the partial-evidence redraft path.
    generations.save({
      ...settled,
      failedLensAccounts: {
        ...settled.failedLensAccounts,
        noise: { attempt: 1, classification: "retryable" },
      },
    });

    // Every durable snapshot the redraft writes, in order — each one is a point a crash
    // could freeze, and the state a later reader would find.
    const snapshots: Generation[] = [];
    await createRoundsRuntime(
      withFakeT3Seats(
        baseDeps({
          resolveClaudePort: async () =>
            fakeClaudePort([], (prompt, label) => cleanBody(lensFromPrompt(prompt, label))),
          persistBoardMeta: (_repo, record) => meta.save(record),
          loadDraftedBoards: (_repo, sessionId, generation) =>
            meta.listForGeneration(sessionId, generation),
          persistGeneration: (generation) => {
            snapshots.push(generation);
            generations.save(generation);
          },
          loadGeneration: (id) => generations.load(id),
        }),
      ),
    ).runRound(input);

    expect(snapshots.length).toBeGreaterThan(0);
    for (const snapshot of snapshots) {
      for (const lens of LENS_KINDS) {
        // An account may only exist where its failure does — at every durable point, not
        // merely at the end.
        if (snapshot.failedLensAccounts?.[lens] !== undefined) {
          expect(snapshot.failedLenses?.[lens]).toBeDefined();
        }
      }
    }
    // …and the attempt record written BEFORE any lens settled — the crash window this is
    // about — carries neither half for the lane that had failed.
    const attempt = snapshots[0];
    expect(attempt?.failedLenses?.noise).toBeUndefined();
    expect(attempt?.failedLensAccounts?.noise).toBeUndefined();
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
      };

      await expect(
        createRoundsRuntime(
          withFakeT3Seats(
            baseDeps({
              ...durableDeps,
              resolveClaudePort: async () =>
                fakeClaudePort([], (prompt, label) =>
                  lensFromPrompt(prompt, label) === failedCoreLens
                    ? invalid
                    : cleanBody(lensFromPrompt(prompt, label)),
                ),
            }),
          ),
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
        withFakeT3Seats(
          baseDeps({
            ...durableDeps,
            resolveClaudePort: async () => fakeClaudePort(retryCaptures),
          }),
        ),
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
        withFakeT3Seats(
          baseDeps({
            ...durableDeps,
            resolveClaudePort: async () => {
              throw new Error("successful core evidence must reconstruct without a model");
            },
          }),
        ),
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
      withFakeT3Seats(
        baseDeps({
          resolveClaudePort: async () =>
            fakeClaudePort([], (prompt, label) =>
              lensFromPrompt(prompt, label) === "design"
                ? ({
                    elements: [{ id: "invalid", kind: "not-a-kind", data: {} }],
                  } as unknown as DraftBoard)
                : cleanBody(lensFromPrompt(prompt, label)),
            ),
          persistBoardMeta: (_repo, record) => meta.save(record),
          persistGeneration: (generation) => generations.save(generation),
          loadGeneration: (id) => generations.load(id),
        }),
      ),
    ).runRound(roundInput());
    const firstFailure = first.pipeline.boards.find(({ lens }) => lens === "design")?.failure;
    expect(firstFailure).toEqual(expect.any(String));
    expect(first.boardGeneration.failedLenses?.design).toBe(firstFailure);
    expect(Object.keys(first.boardGeneration.lensBoards)).toHaveLength(4);

    const recovered = await createRoundsRuntime(
      withFakeT3Seats(
        baseDeps({
          resolveClaudePort: async () => {
            throw new Error("complete failure evidence must reconstruct without a model");
          },
          loadDraftedBoards: (_repo, sessionId, generation) =>
            meta.listForGeneration(sessionId, generation),
          loadGeneration: (id) => generations.load(id),
        }),
      ),
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
      withFakeT3Seats(
        baseDeps({
          persistBoardMeta: (_repo, record) => meta.save(record),
          persistGeneration: (generation) => generations.save(generation),
          loadGeneration: (id) => generations.load(id),
        }),
      ),
    ).runRound(roundInput());
    const fourBoards = { ...seeded.boardGeneration.lensBoards };
    delete fourBoards.flagged;
    generations.save({ ...seeded.boardGeneration, lensBoards: fourBoards });
    let attemptWrites = 0;
    const captures: { prompt?: string }[] = [];

    const recovered = await createRoundsRuntime(
      withFakeT3Seats(
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
      ),
    ).runRound(roundInput());

    expect(attemptWrites).toBeGreaterThan(0);
    expect(captures.some(({ prompt }) => prompt?.includes("prompts/flagged.md"))).toBe(true);
    expect(recovered.pipeline.boards.map(({ lens }) => lens)).toEqual([...LENS_KINDS]);
    expect(recovered.boardGeneration.lensBoards.flagged).toBeDefined();

    const reconstructed = await createRoundsRuntime(
      withFakeT3Seats(
        baseDeps({
          resolveClaudePort: async () => {
            throw new Error("complete replacement evidence must reconstruct without a model");
          },
          loadDraftedBoards: (_repo, sessionId, generation) =>
            meta.listForGeneration(sessionId, generation),
          loadGeneration: (id) => generations.load(id),
        }),
      ),
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
      withFakeT3Seats(
        baseDeps({
          resolveClaudePort: async () => fakeClaudePort(captures),
          loadDraftedBoards: () => [],
          persistGeneration: (generation) => {
            if (generation.draftingBoardIds !== undefined) attemptWrites += 1;
            generations.save(generation);
          },
          loadGeneration: (id) => generations.load(id),
        }),
      ),
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
      withFakeT3Seats(
        baseDeps({
          persistBoardMeta: (_repo, meta) => completeMeta.save(meta),
          persistGeneration: (generation) => generationStore.save(generation),
          loadGeneration: (id) => generationStore.load(id),
        }),
      ),
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
      withFakeT3Seats(
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
      ),
    ).runRound(roundInput());

    expect(captures.some(({ prompt }) => prompt?.includes("prompts/flagged.md"))).toBe(true);
    expect(recoveryWrites).toContain("flagged");
    expect(recovered.boardGeneration.lensBoards.flagged).toBeDefined();

    const reconstructed = await createRoundsRuntime(
      withFakeT3Seats(
        baseDeps({
          resolveClaudePort: async () => {
            throw new Error("a complete generation must not re-draft");
          },
          loadDraftedBoards: (_repo, session, generation) =>
            partialMeta.listForGeneration(session, generation),
          persistGeneration: (generation) => generationStore.save(generation),
          loadGeneration: (id) => generationStore.load(id),
        }),
      ),
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
          fakeClaudePort([], (prompt, label) => {
            if (
              prompt.includes("prompts/flagged.md") ||
              (prompt.includes("prompts/post-process.md") && /"kind"\s*:\s*"finding"/.test(prompt))
            ) {
              return currentFlagged;
            }
            return cleanBody(lensFromPrompt(prompt, label));
          }),
        persistBoardMeta: (_repo, record) => meta.save(record),
        loadDraftedBoards: (_repo, sessionId, generation) =>
          meta.listForGeneration(sessionId, generation),
        persistGeneration: (generation) => generations.save(generation),
        loadGeneration: (id) => generations.load(id),
      });

    await expect(
      createRoundsRuntime(withFakeT3Seats(deps("attempt-a", previousFlagged, true))).runRound(
        input(),
      ),
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
    const recovered = await createRoundsRuntime(
      withFakeT3Seats(deps("attempt-b", retryFlagged, false)),
    ).runRound(input());
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
      withFakeT3Seats(baseDeps({ persistBoardMeta: (_repo, meta) => seedMeta.save(meta) })),
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
      withFakeT3Seats(
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
      ),
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
      withFakeT3Seats(baseDeps({ persistBoardMeta: (_repo, meta) => templates.save(meta) })),
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
      withFakeT3Seats(
        baseDeps({
          resolveClaudePort: async () => {
            throw new Error("complete exact-attempt evidence must reconstruct");
          },
          loadDraftedBoards: (_repo, sessionId, generation) =>
            evidence.listForGeneration(sessionId, generation),
          persistGeneration: (generation) => generations.save(generation),
          loadGeneration: (id) => generations.load(id),
        }),
      ),
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
      withFakeT3Seats(baseDeps({ resolveClaudePort: async () => fakeClaudePort(captures) })),
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
      withFakeT3Seats(
        baseDeps({
          recordRound: (_sessionId, record) => {
            order.push(`persisted:${record.regeneration}`);
          },
        }),
      ),
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
      withFakeT3Seats(baseDeps({ resolveClaudePort: async () => fakeClaudePort(captures) })),
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
      withFakeT3Seats(
        baseDeps({
          resolveClaudePort: async () => fakeClaudePort(captures),
          persistBoardMeta: (_repo, record) => meta.save(record),
          loadDraftedBoards: (_repo, sessionId, generation) =>
            meta.listForGeneration(sessionId, generation),
          persistGeneration: (generation) => generations.save(generation),
          loadGeneration: (id) => generations.load(id),
        }),
      ),
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
      withFakeT3Seats(
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
      ),
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
      withFakeT3Seats(
        baseDeps({
          persistBoardMeta: (_repo, meta) => metaStore.save(meta),
          loadDraftedBoards: (_repo, sessionId, generation) =>
            metaStore.listForGeneration(sessionId, generation),
          persistGeneration: (generation) => generationStore.save(generation),
          loadGeneration: (id) => generationStore.load(id),
          recordRound: (sessionId, record) => roundStore.record(sessionId, record),
          readRounds: (sessionId) => roundStore.read(sessionId),
        }),
      ),
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
      withFakeT3Seats(
        baseDeps({
          persistBoardMeta: (_repo, meta: BoardMeta) => metaStore.save(meta),
          loadDraftedBoards: (_repo, sessionId, generation) =>
            metaStore.listForGeneration(sessionId, generation),
        }),
      ),
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
      withFakeT3Seats(
        baseDeps({
          onBoardArrival: (event) => {
            arrivals.push(event);
          },
        }),
      ),
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
        withFakeT3Seats(
          baseDeps({
            resolveClaudePort: async () =>
              fakeClaudePort(captures, (prompt, label) =>
                lensFromPrompt(prompt, label) === "report"
                  ? classification
                  : cleanBody(lensFromPrompt(prompt, label)),
              ),
            onBoardArrival: (event) => {
              arrivals.push(event);
            },
          }),
        ),
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
      withFakeT3Seats(baseDeps({ persistBoardMeta: (_repo, meta: BoardMeta) => store.save(meta) })),
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
      withFakeT3Seats(
        baseDeps({
          // The disk gives out exactly between the two writes.
          persistGeneration: () => {
            throw new Error("disk went away");
          },
          recordRound: (sessionId, record) => roundStore.record(sessionId, record),
          readRounds: (sessionId) => roundStore.read(sessionId),
          loadGeneration: (id) => generationStore.load(id),
        }),
      ),
    );

    await expect(
      runtime.runRound(roundInput({ session: { id: "crashy" } as RoundInput["session"] })),
    ).rejects.toThrow("disk went away");

    // Restart: fresh stores over the SAME on-disk state. The round is honestly absent —
    // never a ledger row pointing at a generation that does not exist.
    const afterRestart = createRoundsRuntime(
      withFakeT3Seats(
        baseDeps({
          readRounds: (sessionId) => new RoundRecordStore(roundDir).read(sessionId),
          loadGeneration: (id) => new GenerationStore(genDir).load(id),
        }),
      ),
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
      withFakeT3Seats(
        baseDeps({
          resolveClaudePort: async () => fakeClaudePort([], noSpecBodyFor),
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
      ),
    );

    await expect(
      first.runRound(
        roundInput({
          session: { id: sessionId } as RoundInput["session"],
        }),
      ),
    ).rejects.toThrow("crashed after board metadata");
    expect(generationStore.load("gen:ps-1")?.absentLenses).toEqual({
      design: "no-spec",
    });
    expect(metaStore.listForGeneration(sessionId, "gen:ps-1").length).toBeGreaterThan(0);

    const restarted = createRoundsRuntime(
      withFakeT3Seats(
        baseDeps({
          resolveClaudePort: async () => {
            throw new Error("durable evidence must not re-draft");
          },
          loadDraftedBoards: (_repo, session, generation) =>
            metaStore.listForGeneration(session, generation),
          persistGeneration: (generation) => generationStore.save(generation),
          loadGeneration: (id) => generationStore.load(id),
        }),
      ),
    );
    const recovered = await restarted.runRound(
      roundInput({
        session: { id: sessionId } as RoundInput["session"],
      }),
    );
    expect(recovered.boardGeneration.absentLenses).toEqual({ design: "no-spec" });
    expect(recovered.boardGeneration.lensBoards).not.toHaveProperty("design");
  });

  it("persists each lane's settlement and the per-phase timings as they land", async () => {
    const writes: Generation[] = [];
    // A real durable store, not just a write log: the claim being tested is about what a
    // reader FINDS after the round, and a filtered write log answers a different question.
    // The final settle overwrote the record for months while the log still showed the
    // timings some earlier write had carried.
    const store = new Map<string, Generation>();
    const runtime = createRoundsRuntime(
      withFakeT3Seats(
        baseDeps({
          persistGeneration: (generation) => {
            const snapshot = JSON.parse(JSON.stringify(generation)) as Generation;
            writes.push(snapshot);
            store.set(snapshot.id, snapshot);
          },
          loadGeneration: (id) => store.get(id),
        }),
      ),
    );
    const outcome = await runtime.runRound(roundInput());

    // Settlements land one lane at a time: the reveal writes run from no board to some.
    const revealed = writes
      .filter(({ draftingBoardIds }) => draftingBoardIds !== undefined)
      .map(({ lensBoards }) => Object.keys(lensBoards).length);
    expect(Math.max(...revealed)).toBeGreaterThan(0);
    expect(Math.min(...revealed)).toBe(0);

    // ── The DURABLE record, read back after the round settled ──
    // Not `writes.filter(...).at(-1)`: that steps over the last write, which is the one
    // that used to erase all of this. What a reconnecting client (or #726's benchmark
    // reader) sees is `loadGeneration`, so that is what gets asserted.
    const durable = runtime.generation(outcome.boardGeneration.id);
    expect(durable).toBeDefined();

    // Spend rides the same durable record (#737), and it is the LAST write that a reader
    // finds: the final settle used to erase it (#741 review). The scripted harness reports
    // no usage on its result frames, so every turn is honestly unmeasured, never zero.
    expect(durable?.usage).toBeDefined();
    expect(durable?.usage?.turns).toBeGreaterThan(0);
    expect(durable?.usage?.unmeasuredTurns).toBe(durable?.usage?.turns);
    expect(durable?.usage?.reportedUsd).toBeNull();
    const lastWriteOfThisGeneration = writes.filter(({ id }) => id === durable?.id).at(-1);
    expect(lastWriteOfThisGeneration?.usage).toEqual(durable?.usage);

    // Per-phase timings ride the same durable record, versioned from day one.
    const timed = durable?.timings;
    expect(timed?.version).toBe(1);
    const phases = new Set(timed?.phases.map(({ phase }) => phase));
    expect(phases.has("report")).toBe(true);
    expect(phases.has("lens-draft")).toBe(true);
    expect(phases.has("lens-post-process")).toBe(true);
    expect(phases.has("reveal")).toBe(true);
    // Time-to-first-core-board is measured from the round's own start and names the lane
    // that got there first — one of the three core lenses, never Design or Noise.
    const firstCore = timed?.phases.find(({ phase }) => phase === "first-core-board");
    expect(["sequence", "decisions", "flagged"]).toContain(firstCore?.lens);
    expect(timed?.phases.filter(({ phase }) => phase === "first-core-board")).toHaveLength(1);
    // Every durable record satisfies the wire contract, including the lens/phase
    // discrimination — a lane record naming no lane would parse nowhere else.
    expect(GenerationSchema.safeParse(durable).success).toBe(true);
  });

  it("carries the reveal's timings into the round's FAILURE writes too", async () => {
    // The two error paths persist the generation before throwing. They take the same
    // record the final settle does, so a round that dies still leaves behind what it
    // measured — the failure is exactly when someone wants to read it.
    const store = new Map<string, Generation>();
    const runtime = createRoundsRuntime(
      withFakeT3Seats(
        baseDeps({
          // Sequence admits no absence, so an empty Sequence board is a MISSING required core
          // lens — one of the two paths that persists the generation and then throws.
          resolveClaudePort: async () =>
            fakeClaudePort([], (prompt, label) => {
              const lens = lensFromPrompt(prompt, label);
              return lens === "sequence" ? { elements: [] } : cleanBody(lens);
            }),
          persistGeneration: (generation) => {
            store.set(generation.id, JSON.parse(JSON.stringify(generation)) as Generation);
          },
          loadGeneration: (id) => store.get(id),
        }),
      ),
    );
    await expect(runtime.runRound(roundInput())).rejects.toThrow(
      "The required core lens sequence did not produce review evidence",
    );

    // That path persists `withLensBoards(...)` and THEN throws — the same write the final
    // settle makes. It carries what the run measured, because a round that died is exactly
    // when someone reads the timings.
    const durable = store.get("gen:ps-1");
    expect(durable?.draftingBoardIds).toBeUndefined();
    expect(durable?.timings?.phases.some(({ phase }) => phase === "reveal")).toBe(true);
  });

  it("measures time-to-first-core-board from the CALLER's origin, not this runtime's entry", async () => {
    const runWithOrigin = async (
      firstBoardWaitOriginMs?: number,
    ): Promise<GenerationPhaseTiming | undefined> => {
      const store = new Map<string, Generation>();
      // A scripted clock that only moves when the runtime asks it to, so the origin is the
      // ONLY thing that can differ between the two runs below.
      let ticks = 10_000;
      const runtime = createRoundsRuntime(
        withFakeT3Seats(
          baseDeps({
            now: () => {
              ticks += 1;
              return ticks;
            },
            persistGeneration: (generation) => {
              store.set(generation.id, JSON.parse(JSON.stringify(generation)) as Generation);
            },
            loadGeneration: (id) => store.get(id),
          }),
        ),
      );
      await runtime.runRound(
        roundInput(firstBoardWaitOriginMs === undefined ? {} : { firstBoardWaitOriginMs }),
      );
      return store
        .get("gen:ps-1")
        ?.timings?.phases.find(({ phase }) => phase === "first-core-board");
    };

    // The caller's origin is 9_000 ticks BEFORE the runtime's clock starts — the board
    // minting, cleanup, attempt persistence and provider resolution the reviewer waits
    // through before this runtime would have started counting.
    const carried = await runWithOrigin(1_000);
    expect(carried?.startedAtMs).toBe(1_000);
    expect(carried?.durationMs).toBeGreaterThan(9_000);

    // With no origin supplied the runtime falls back to its own start — honest about being
    // a lower bound, and measurably a different number.
    const fallback = await runWithOrigin();
    expect(fallback?.startedAtMs).toBeGreaterThan(10_000);
    expect(fallback?.durationMs).toBeLessThan(1_000);
  });

  it("refuses a superseded attempt the SCREEN as well as the disk", async () => {
    // A rejected reveal write means a later attempt owns the generation. Announcing the
    // board anyway put this dead attempt's work on every connected client, under the live
    // generation's label — refused on disk, granted the screen.
    const run = async (supersede: boolean) => {
      const arrivals: string[] = [];
      const laneFrames: string[][] = [];
      let attemptRecord: Generation | undefined;
      const runtime = createRoundsRuntime(
        withFakeT3Seats(
          baseDeps({
            persistGeneration: (generation) => {
              attemptRecord ??= JSON.parse(JSON.stringify(generation)) as Generation;
            },
            loadGeneration: () => {
              if (attemptRecord === undefined) return undefined;
              return supersede
                ? { ...attemptRecord, draftingReportBoardId: "board:a-later-attempt" }
                : attemptRecord;
            },
            onBoardArrival: (event) => {
              // The report's handoff is not a reveal write and takes its own branch; the
              // supersession gate is about the five LENS settlements.
              if (event.lens !== "report") arrivals.push(event.lens);
            },
          }),
        ),
      );
      const round = runtime.runRound(
        roundInput({
          onProgress: (event) => {
            if (event.type === "lens") {
              // `done` is the ARRIVAL's status (it carries the carried/reworked verdict).
              // `drafted` comes from the BoardMeta write, which is a different seam and a
              // different write — this test is about the arrival sink.
              laneFrames.push(
                event.lanes.filter((lane) => lane.status === "done").map(({ id }) => id),
              );
            }
          },
        }),
      );
      // A superseded attempt now refuses the WHOLE round (#816 review P1): it throws at the
      // ownership boundary rather than filing a result a later attempt owns. The owned arm
      // still resolves, which is what keeps the assertions below about supersession rather
      // than about a round that fails for any reason.
      if (supersede) await expect(round).rejects.toThrow(/superseded/);
      else await round;
      return { arrivals, laneFrames };
    };

    // Control: the attempt still owns the generation, so the sink fires and lanes settle.
    const owned = await run(false);
    expect(owned.arrivals.length).toBeGreaterThan(0);
    expect(Math.max(...owned.laneFrames.map((frame) => frame.length))).toBeGreaterThan(0);

    // Superseded: not one arrival reached the broadcast sink, and no lane frame ever
    // claimed a settled board.
    const dead = await run(true);
    expect(dead.arrivals).toEqual([]);
    expect(Math.max(...dead.laneFrames.map((frame) => frame.length), 0)).toBe(0);
  });

  // ── #813 through the PRODUCTION wiring (#816 review P1) ──
  //
  // The pipeline test injects `onLensFailure` and the bench test injects an already-failed
  // lane; neither touches `createRoundsRuntime`, so reverting the callback wiring, deleting
  // the double-settle skip, or restoring the unchecked backstop left both green. These two
  // drive the real runtime.
  //
  /** A Claude port whose Design seat settles with NO structured output (the drive's own
   *  failure) while every other lens seat waits on `gate`. The report seat answers at once,
   *  because it is what releases the lens seats to start at all. */
  const designFailsWhileSiblingsWait = (gate: Promise<void>): HarnessPort =>
    ({
      createSession: async (options: { label?: string }) => {
        const capture: { prompt?: string; label?: string } = { label: options.label };
        return {
          send: async (input: { prompt: string }) => {
            capture.prompt = input.prompt;
          },
          close: async () => undefined,
          events: (async function* () {
            const lens = lensFromPrompt(capture.prompt ?? "", capture.label);
            if (lens !== "design" && lens !== "report") await gate;
            yield {
              kind: "session.ended",
              native: {},
              outcome: {
                status: "completed",
                // Design: absent structured output ⇒ the drafting ladder never parses a
                // board and the lane settles failed. Design is not a required core lens,
                // so the round still completes and the terminal writes still happen —
                // which is what lets the second test see them suppressed.
                ...(lens === "design" ? {} : { structuredOutput: cleanBody(lens) }),
              },
            };
          })(),
        } as unknown as Awaited<ReturnType<HarnessPort["createSession"]>>;
      },
    }) as unknown as HarnessPort;

  const designLaneIn = (lanes: readonly { id: string; status: string }[]) =>
    lanes.find(({ id }) => id === "design")?.status;

  it("settles a failed lane on disk and on screen before its siblings finish, once", async () => {
    let releaseSiblings = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseSiblings = resolve;
    });
    let announceDesignFailed = (): void => undefined;
    const designFailed = new Promise<void>((resolve) => {
      announceDesignFailed = resolve;
    });

    const laneFrames: string[][] = [];
    /** The SAME frames unprojected. The `id:status` view above drops the thread refs and
     *  live lines, so two different frames collapse onto one string in it — which would
     *  make the duplicate-frame check below fire on every thread binding. */
    const wholeFrames: string[] = [];
    const writes: Generation[] = [];
    /** The frames and writes as they stood the instant Design's lane read `failed`. */
    let atFailure: { frames: number; durable: boolean } | undefined;

    const runtime = createRoundsRuntime(
      withFakeT3Seats(
        baseDeps({
          resolveClaudePort: async () => designFailsWhileSiblingsWait(gate),
          persistGeneration: (generation) => {
            writes.push(JSON.parse(JSON.stringify(generation)) as Generation);
          },
        }),
      ),
    );
    const round = runtime.runRound(
      roundInput({
        onProgress: (event) => {
          if (event.type !== "lens") return;
          laneFrames.push(event.lanes.map((lane) => `${lane.id}:${lane.status}`));
          wholeFrames.push(JSON.stringify(event.lanes));
          if (designLaneIn(event.lanes) !== "failed" || atFailure !== undefined) return;
          atFailure = {
            frames: laneFrames.length,
            durable: writes.some(({ failedLenses }) => failedLenses?.design !== undefined),
          };
          announceDesignFailed();
        },
      }),
    );

    // THE TIMING IS THE CLAIM. If the settlement moved back behind the pipeline's own
    // return, this await never resolves and the test dies by timeout rather than by a
    // wrong value — the four sibling seats are still parked on `gate`.
    await designFailed;
    // Durable before the screen, by the same write: the lane a reviewer sees failed is a
    // lane the daemon has already recorded as failed.
    expect(atFailure?.durable).toBe(true);
    // …and not one sibling had settled when it happened: `queued` and `running` are the
    // two unsettled states, and every other lane was in one of them.
    const atThatMoment = laneFrames[(atFailure?.frames ?? 1) - 1] ?? [];
    expect(atThatMoment).toContain("design:failed");
    expect(
      atThatMoment.filter(
        (entry) =>
          !entry.startsWith("design:") && !entry.endsWith(":queued") && !entry.endsWith(":running"),
      ),
    ).toEqual([]);

    releaseSiblings();
    await round;

    // EXACTLY ONE settlement. The backstop after the pipeline settles the same lens again,
    // and a second settlement re-emits a byte-identical snapshot. Every other emitter on
    // this path changes something in the frame it emits (`set` changes a status, `thread`
    // returns early on an unchanged ref, `progress` changes a line) and `refresh()` is
    // never called here, so a frame identical to the one before it IS the double settle.
    const repeated = wholeFrames.filter(
      (frame, index) => index > 0 && frame === wholeFrames[index - 1],
    );
    expect(repeated).toEqual([]);
    // The lane reached `failed` exactly once, counted as transitions rather than as
    // occurrences — a settled lane is repeated in every later snapshot by design.
    const transitions = laneFrames.filter(
      (frame, index) =>
        frame.includes("design:failed") && !(laneFrames[index - 1] ?? []).includes("design:failed"),
    );
    expect(transitions).toHaveLength(1);
    expect(laneFrames.at(-1)).toContain("design:failed");
  });

  it("announces no failed lane and files nothing when the attempt was superseded", async () => {
    const run = async (supersede: boolean) => {
      let releaseSiblings = (): void => undefined;
      const gate = new Promise<void>((resolve) => {
        releaseSiblings = resolve;
      });
      const laneFrames: string[][] = [];
      const writes: Generation[] = [];
      let attemptRecord: Generation | undefined;
      const runtime = createRoundsRuntime(
        withFakeT3Seats(
          baseDeps({
            resolveClaudePort: async () => designFailsWhileSiblingsWait(gate),
            persistGeneration: (generation) => {
              const snapshot = JSON.parse(JSON.stringify(generation)) as Generation;
              writes.push(snapshot);
              attemptRecord ??= snapshot;
            },
            loadGeneration: () => {
              if (attemptRecord === undefined) return undefined;
              return supersede
                ? { ...attemptRecord, draftingReportBoardId: "board:a-later-attempt" }
                : attemptRecord;
            },
          }),
        ),
      );
      const round = runtime.runRound(
        roundInput({
          onProgress: (event) => {
            if (event.type !== "lens") return;
            laneFrames.push(event.lanes.map((lane) => `${lane.id}:${lane.status}`));
          },
        }),
      );
      // Nothing gates the assertions here: the failure is what we are watching for, and it
      // must not reach the screen at all, so there is no moment to synchronise on. The
      // siblings are released immediately and the whole round is awaited.
      releaseSiblings();
      if (supersede) await expect(round).rejects.toThrow(/superseded/);
      else await round;
      return { laneFrames, writes };
    };

    // Control: the attempt owns its generation, so the failed lane DOES reach the screen
    // and the terminal write DOES land. Without this the assertions below would pass over
    // a round that simply never failed a lane.
    const owned = await run(false);
    expect(owned.laneFrames.some((frame) => frame.includes("design:failed"))).toBe(true);
    expect(owned.writes.some(({ lensBoards }) => Object.keys(lensBoards).length > 0)).toBe(true);

    const dead = await run(true);
    // The backstop used to call `lanes.failed` directly, outside the ownership check — so a
    // dead attempt whose reveal callbacks had all been refused still pushed five failed
    // lanes onto every connected client, over a live attempt that may already have
    // succeeded. Not one frame claims a settled lane now.
    expect(dead.laneFrames.some((frame) => frame.includes("design:failed"))).toBe(false);
    // …and nothing terminal was written under the generation id a later attempt holds.
    expect(dead.writes.some(({ lensBoards }) => Object.keys(lensBoards).length > 0)).toBe(false);
    expect(dead.writes.some(({ failedLenses }) => failedLenses !== undefined)).toBe(false);
  });

  it("rejects a reveal write from a superseded generation attempt", async () => {
    const runAndCollect = async (supersedeAfterAttempt: boolean): Promise<Generation[]> => {
      const writes: Generation[] = [];
      let attemptRecord: Generation | undefined;
      const runtime = createRoundsRuntime(
        withFakeT3Seats(
          baseDeps({
            persistGeneration: (generation) => {
              const snapshot = JSON.parse(JSON.stringify(generation)) as Generation;
              writes.push(snapshot);
              attemptRecord ??= snapshot;
            },
            loadGeneration: () => {
              if (attemptRecord === undefined) return undefined;
              return supersedeAfterAttempt
                ? // A LATER attempt took the generation over: it minted its own report slot,
                  // so this run's remaining reveal writes belong to nobody.
                  { ...attemptRecord, draftingReportBoardId: "board:a-later-attempt" }
                : attemptRecord;
            },
          }),
        ),
      );
      const round = runtime.runRound(roundInput());
      if (supersedeAfterAttempt) await expect(round).rejects.toThrow(/superseded/);
      else await round;
      return writes;
    };

    // NO FILTER (#816 review P1). This used to look only at writes carrying
    // `draftingBoardIds`, which excluded the attempt's TERMINAL writes — and those were
    // exactly the ones the gate did not cover: `withLensBoards`, the frozen predecessor
    // and the round record all went to `deps.persistGeneration` directly, and
    // `GenerationStore.save` overwrites by generation id. So the filter hid the hole it
    // was meant to be watching. Every write this attempt makes is now in scope.

    // Control first: with the durable record still naming THIS attempt, the writes land —
    // so the assertion below is about supersession, not about a missing seam.
    const current = await runAndCollect(false);
    expect(current.some(({ timings }) => timings !== undefined)).toBe(true);
    expect(current.some(({ lensBoards }) => Object.keys(lensBoards).length > 0)).toBe(true);

    const superseded = await runAndCollect(true);
    // Not one write carried a settlement or a timing. What remains is the attempt write
    // alone — nothing this dead attempt produced was folded into, or laid over, the
    // generation a later attempt now owns.
    expect(superseded.some(({ timings }) => timings !== undefined)).toBe(false);
    expect(superseded.some(({ lensBoards }) => Object.keys(lensBoards).length > 0)).toBe(false);
    expect(superseded.some(({ failedLenses }) => failedLenses !== undefined)).toBe(false);
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
      withFakeT3Seats(
        baseDeps({
          resolveClaudePort: async () =>
            fakeClaudePort([], (prompt, label) => {
              const lens = lensFromPrompt(prompt, label);
              if (lens === "design") return { absence: "no-spec" };
              if (lens === "flagged") {
                announceFlaggedDraft();
                return { elements: [] } as unknown as DraftBoard;
              }
              return cleanBody(lens);
            }),
          persistGeneration: async (generation) => {
            const snapshot = copyGeneration(generation);
            const absent = Object.keys(snapshot.absentLenses ?? {});
            // ONE write carries exactly the design absence: design's own absence
            // notification, which settles while the other four lens seats are already
            // running (the seat reports `no-spec` now, so the attempt write at mint carries
            // no absence at all). That single save is the one this test delays.
            if (snapshot.draftingBoardIds !== undefined && absent.length === 1) {
              designOnlyWrites += 1;
              if (designOnlyWrites === 1) {
                announceDelayedSave();
                await delayedSaveRelease;
              }
            }
            durable = snapshot;
          },
        }),
      ),
    );

    const run = runtime.runRound(
      roundInput({
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
      design: "no-spec",
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
    const runtime = createRoundsRuntime(withFakeT3Seats(baseDeps()));
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
    const runtime = createRoundsRuntime(withFakeT3Seats(baseDeps()));
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

    const runtime = createRoundsRuntime(withFakeT3Seats(baseDeps()));
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

// ── The benchmark archive's terminal boundary (#731 N3/N4, O2) ──
//
// The archive used to be taken the moment the pipeline returned, which is several throws
// too early: `runOnce` still has to find lens boards, verify the drafted report and check
// the required core lenses. A generation rejected by any of those was archived as
// `complete`, so the exported failure rate was the rate at which the PIPELINE threw rather
// than the rate at which a round failed. These tests drive the real runtime and read what
// it archived.

describe("what a round archives, and when (#731 N3)", () => {
  function archiving(over: Partial<RoundsRuntimeDeps> = {}): {
    deps: RoundsRuntimeDeps;
    recorded: BenchmarkRun[];
  } {
    const recorded: BenchmarkRun[] = [];
    return { deps: baseDeps({ recordBenchmark: (run) => recorded.push(run), ...over }), recorded };
  }

  it("archives a COMPLETE run once, identified by generation and attempt", async () => {
    const { deps, recorded } = archiving();
    await createRoundsRuntime(withFakeT3Seats(deps)).runRound(roundInput());
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.outcome).toBe("complete");
    expect(recorded[0]?.kind).toBe("generation");
    // Identity is (generation, attempt) — not a clock reading, which is what made two
    // records of one generation indistinguishable.
    expect(recorded[0]?.attempt).toBe(0);
    expect(recorded[0]?.id).toBe(`${recorded[0]?.subject.generationId}:0`);
    expect(recorded[0]?.producer).toBe("daemon");
  });

  it("archives a generation rejected by the required-core-lens check as FAILED", async () => {
    // THE regression. The pipeline returned normally here — boards were drafted — and the
    // round was then rejected downstream. Archiving at the pipeline's return filed this as
    // a complete run.
    const invalid = {
      elements: [{ id: "invalid", kind: "not-a-kind", data: {} }],
    };
    const { deps, recorded } = archiving({
      resolveClaudePort: async () =>
        fakeClaudePort([], (prompt, label) =>
          lensFromPrompt(prompt, label) === "sequence"
            ? invalid
            : cleanBody(lensFromPrompt(prompt, label)),
        ),
    });
    await expect(createRoundsRuntime(withFakeT3Seats(deps)).runRound(roundInput())).rejects.toThrow(
      "required core lens sequence",
    );
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.outcome).toBe("failed");
    expect(recorded[0]?.failure).toContain("required core lens sequence");
  });

  /** A drafting port whose turn dies, so `runLensPipeline` itself throws. */
  function dyingPort(message: string): HarnessPort {
    return {
      createSession: async () => {
        throw new Error(message);
      },
    } as unknown as HarnessPort;
  }

  it("archives ONE failed run when the pipeline itself throws (#731 O2)", async () => {
    const { deps, recorded } = archiving({
      resolveClaudePort: async () => dyingPort("the drafting turn fell over"),
    });
    await expect(
      createRoundsRuntime(withFakeT3Seats(deps)).runRound(roundInput()),
    ).rejects.toThrow();
    // One record, not one per lane and not none: the run is the unit, and its failure
    // carries the runner's own words.
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.outcome).toBe("failed");
    expect(recorded[0]?.failure).toEqual(expect.any(String));
    expect(recorded[0]?.failure?.length).toBeGreaterThan(0);
  });

  it("calls a cancelled round ABORTED, not failed (#731 O2)", async () => {
    // A reviewer who walked away is not a defect, and a pipeline whose cancellations were
    // counted as failures would report a failure rate made of people changing their minds.
    const { deps, recorded } = archiving({
      resolveClaudePort: async () => dyingPort("cancelled"),
    });
    await expect(
      createRoundsRuntime(withFakeT3Seats(deps)).runRound(
        roundInput({ signal: AbortSignal.abort() }),
      ),
    ).rejects.toThrow();
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.outcome).toBe("aborted");
    // The control on the discrimination: the SAME failure with no aborted signal is
    // `failed`, so this is reading the signal rather than the error.
    const plain = archiving({ resolveClaudePort: async () => dyingPort("cancelled") });
    await expect(
      createRoundsRuntime(withFakeT3Seats(plain.deps)).runRound(roundInput()),
    ).rejects.toThrow();
    expect(plain.recorded[0]?.outcome).toBe("failed");
  });

  it("archives NOTHING for an attempt a later one superseded", async () => {
    // `persistReveal` refuses the durable write when another attempt owns the generation.
    // Archiving anyway would file a dead attempt's latency under the live generation's id —
    // the same wrong-content publish the durable check exists to prevent, one surface over.
    const superseded: Generation = {
      ...PREV_GEN,
      id: "gen:ps-1",
      draftingBoardIds: { design: "someone-elses-board" },
      draftingReportBoardId: "someone-elses-report",
    };
    // The FIRST read is `runOnce` selecting the generation to draft; every later read is a
    // reveal write checking whether it still owns it. The steal happens in between.
    let reads = 0;
    const { deps, recorded } = archiving({
      persistGeneration: () => undefined,
      loadGeneration: () => {
        reads += 1;
        return reads > 1 ? superseded : undefined;
      },
    });
    await createRoundsRuntime(withFakeT3Seats(deps))
      .runRound(roundInput())
      .catch(() => undefined);
    expect(reads).toBeGreaterThan(1);
    expect(recorded).toEqual([]);
  });
});
