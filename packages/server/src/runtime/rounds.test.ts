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
import type { ComposedHandoffBundle, DraftBoard, Generation, RoundEvent } from "@rennet/protocol";
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
        close: async () => {
          /* nothing to release */
        },
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
