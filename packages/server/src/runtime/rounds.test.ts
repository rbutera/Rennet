import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoardMetaStore } from "@rennet/adapters";
import type {
  CodexExecutor,
  DeltaPacket,
  HarnessPort,
  LintContext,
  LintTarget,
} from "@rennet/core";
import type { DraftBoard, Generation } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import type { BoardsRuntime } from "../boards/boards-runtime";
import type { BoardArrivalEvent, BoardMeta } from "./lens-pipeline";
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
const cleanBody = (lens: string): DraftBoard =>
  ({
    elements: [
      {
        id: `${lens}-p1`,
        kind: "prose",
        data: { author: { kind: "lens-agent", id: `${lens}-seat` }, markdown: "Reads cleanly." },
      },
    ],
  }) as unknown as DraftBoard;

/** A fake Claude port that answers a lens-appropriate clean board every turn. */
function fakeClaudePort(captures: { prompt?: string }[] = []): HarnessPort {
  return {
    createSession: async () => {
      const capture: { prompt?: string } = {};
      captures.push(capture);
      return {
        send: async (input: { prompt: string }) => {
          capture.prompt = input.prompt;
        },
        close: async () => {},
        events: (async function* () {
          yield {
            kind: "session.ended",
            native: {},
            outcome: {
              status: "completed",
              structuredOutput: cleanBody(lensFromPrompt(capture.prompt ?? "")),
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
      service: { apply: async () => ({ ok: true }) },
      createRennetBoard: async () => `board:${seq++}`,
    }) as unknown as Pick<BoardsRuntime, "service" | "createRennetBoard">;
}

const PREV_GEN: Generation = {
  id: "gen:ps-0",
  patchsetId: "ps-0",
  lensBoards: {},
  status: "live",
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
    ...over,
  };
}

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

  it("re-reports against the existing generation when no patchset landed", async () => {
    const runtime = createRoundsRuntime(baseDeps());
    const { record, frozenPrevious } = await runtime.runRound(
      roundInput({
        runWorkers: async () => ({ commitRange: { from: "c0", to: "c0" } }),
      }),
    );
    expect(record.mintedPatchsetGeneration).toBeUndefined();
    expect(record.boardGeneration).toBe("gen:ps-0");
    // Nothing landed ⇒ nothing froze.
    expect(frozenPrevious).toBeUndefined();
  });

  it("drafts the round-report FIRST, then reveals each board (arrival order)", async () => {
    const arrivals: BoardArrivalEvent[] = [];
    const runtime = createRoundsRuntime(baseDeps({ onBoardArrival: (e) => arrivals.push(e) }));
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

  it("serializes dispatches per session — a second round waits for the first", async () => {
    const events: string[] = [];
    let releaseA: () => void = () => {};
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
