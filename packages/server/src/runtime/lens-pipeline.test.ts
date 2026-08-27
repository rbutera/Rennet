import type { DeltaPacket, HarnessPort, LintContext, LintHunk, LintTarget } from "@rennet/core";
import type { DraftBoard, LensKind } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import {
  type BoardArrivalEvent,
  boardOutputSchema,
  draftToOps,
  reconcileFlaggedBoards,
  runLensPipeline,
  stampSingleSeatConcurrence,
} from "./lens-pipeline";

// ── Flagged-board fixtures (5.2) ────────────────────────────────────────────────

const flaggedAuthor = { kind: "lens-agent" as const, id: "flagged-seat" };
const mkCodeRef = (
  id: string,
  path: string,
  start: number,
  end: number,
): DraftBoard["elements"][number] =>
  ({
    id,
    kind: "code_ref",
    data: {
      author: flaggedAuthor,
      patchset_id: "ps-1",
      path,
      side: "head",
      start_line: start,
      end_line: end,
    },
  }) as unknown as DraftBoard["elements"][number];
const mkFinding = (
  id: string,
  concern: string,
  code: string[],
  severity = "high",
): DraftBoard["elements"][number] =>
  ({
    id,
    kind: "finding",
    data: { author: flaggedAuthor, severity, concern, code, concurrence: [], status: "open" },
  }) as unknown as DraftBoard["elements"][number];
const mkBoard = (elements: DraftBoard["elements"], skippedHunks: unknown[] = []): DraftBoard =>
  ({ elements, skippedHunks }) as unknown as DraftBoard;
const concurrenceOf = (board: DraftBoard, id: string): { model: string; agree: number }[] =>
  (
    board.elements.find((e) => e.id === id)?.data as {
      concurrence?: { model: string; agree: number }[];
    }
  )?.concurrence ?? [];

// ── Fixtures ──────────────────────────────────────────────────────────────────

/** A minimal DeltaPacket — the pipeline inlines it into every prompt; content is opaque here. */
const PACKET = {
  patchset: { id: "ps-1", createdAt: "", truncated: false, files: [] },
} as unknown as DeltaPacket;

/** The per-lens lint context: empty hunks/files ⇒ a single innocent prose element is clean. */
const lintContextFor = (lens: LintTarget): LintContext => ({
  lens,
  hunks: [],
  files: new Map(),
});

/** One innocent prose element per lens — a Tier-B authoring kind admitted on every lens board. */
const cleanBody = (lens: string): DraftBoard =>
  ({
    elements: [
      {
        id: `${lens}-p1`,
        kind: "prose",
        data: {
          author: { kind: "lens-agent", id: `${lens}-seat` },
          markdown: "This change reads cleanly.",
        },
      },
    ],
  }) as unknown as DraftBoard;

/** A fake Claude port: captures the resolved model per session and answers a lens-appropriate board. */
function fakeClaudePort(
  captures: { model?: string; prompt?: string }[],
  bodyFor: (prompt: string) => unknown,
): HarnessPort {
  return {
    createSession: async (options: { model?: string }) => {
      const capture: { model?: string; prompt?: string } = { model: options.model };
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
            outcome: { status: "completed", structuredOutput: bodyFor(capture.prompt ?? "") },
          };
        })(),
      } as unknown as Awaited<ReturnType<HarnessPort["createSession"]>>;
    },
  } as unknown as HarnessPort;
}

/** readPrompt returns a per-file marker so the fake body can recover which lens/seat it is. */
const readPrompt = (file: string): string => `PROMPT_FILE:${file}`;

/** Recover the lens from the marker the fake prompt carries (design.md → design, report.md → report). */
function lensFromPrompt(prompt: string): string {
  const match = /PROMPT_FILE:prompts\/([a-z-]+)\.md/.exec(prompt);
  return match?.[1] ?? "unknown";
}

interface Applied {
  readonly boardId: string;
  readonly ops: readonly unknown[];
  readonly actor: string;
}

function fakeWhiteboard(applied: Applied[]) {
  return {
    apply: async (boardId: string, ops: readonly unknown[], actor: string) => {
      applied.push({ boardId, ops, actor });
      return { response: { ok: true }, ops } as never;
    },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("draftToOps", () => {
  it("projects each draft element into one create op (the host is the sole op writer)", () => {
    const board = { elements: [{ id: "a", kind: "prose", data: {} }] } as unknown as DraftBoard;
    expect(draftToOps(board)).toEqual([{ op: "create", element: board.elements[0] }]);
  });
});

describe("boardOutputSchema", () => {
  it("derives a JSON schema from the frozen DraftBoardSchema (never hand-authored)", () => {
    const schema = boardOutputSchema() as Record<string, unknown>;
    expect(schema).toBeTypeOf("object");
    // Memoized — the same object every call.
    expect(boardOutputSchema()).toBe(schema);
  });
});

describe("reconcileFlaggedBoards — the Flagged dual seat merge (J1/J2)", () => {
  const labels = { a: "Claude", b: "Codex" };

  it("collapses a matched pair to the clearer finding with BOTH models concurring", () => {
    const a = mkBoard([mkFinding("f1", "short", ["c1"]), mkCodeRef("c1", "src/auth.ts", 11, 12)]);
    const b = mkBoard([
      mkFinding("f2", "a materially clearer, longer summary of the same concern", ["c2"]),
      mkCodeRef("c2", "src/auth.ts", 11, 12),
    ]);
    const merged = reconcileFlaggedBoards(a, b, labels);
    const findings = merged.elements.filter((e) => e.kind === "finding");
    expect(findings).toHaveLength(1);
    // The clearer (longer) summary — seat B's — is kept, with both models agreeing 1/1.
    const conc = concurrenceOf(merged, findings[0]?.id ?? "");
    expect(conc).toEqual([
      { model: "Claude", agree: 1, total: 1 },
      { model: "Codex", agree: 1, total: 1 },
    ]);
  });

  it("keeps two solo findings, each with the raising model agreeing and the other at zero", () => {
    const a = mkBoard([
      mkFinding("f1", "only Claude saw this", ["c1"]),
      mkCodeRef("c1", "src/auth.ts", 11, 12),
    ]);
    const b = mkBoard([
      mkFinding("f2", "only Codex saw this", ["c2"]),
      mkCodeRef("c2", "src/other.ts", 3, 4),
    ]);
    const merged = reconcileFlaggedBoards(a, b, labels);
    expect(merged.elements.filter((e) => e.kind === "finding")).toHaveLength(2);
    expect(concurrenceOf(merged, "f1")).toEqual([
      { model: "Claude", agree: 1, total: 1 },
      { model: "Codex", agree: 0, total: 1 },
    ]);
    expect(concurrenceOf(merged, "f2")).toEqual([
      { model: "Claude", agree: 0, total: 1 },
      { model: "Codex", agree: 1, total: 1 },
    ]);
  });
});

describe("stampSingleSeatConcurrence — the honest single-seat degrade", () => {
  it("stamps every finding with the one running model's concurrence", () => {
    const board = mkBoard([
      mkFinding("f1", "concern", ["c1"]),
      mkCodeRef("c1", "src/auth.ts", 11, 12),
    ]);
    const stamped = stampSingleSeatConcurrence(board, "Claude");
    expect(concurrenceOf(stamped, "f1")).toEqual([{ model: "Claude", agree: 1, total: 1 }]);
  });
});

describe("runLensPipeline — the real drafting path (fake harness, no live model)", () => {
  it("drafts all five lenses, writes each board via whiteboard, and emits arrival on freeze", async () => {
    const captures: { model?: string; prompt?: string }[] = [];
    const applied: Applied[] = [];
    const arrivals: BoardArrivalEvent[] = [];

    const bodyFor = (prompt: string): unknown => {
      const lens = lensFromPrompt(prompt);
      // The post-process editor pass is identity here — echo whatever board it is handed.
      if (lens === "post-process") {
        const ctx = /rennet:layer context>>>\n(\{.*)/s.exec(prompt);
        return ctx ? (JSON.parse(ctx[1] as string).board as unknown) : { elements: [] };
      }
      return cleanBody(lens);
    };

    const result = await runLensPipeline({
      claudePort: fakeClaudePort(captures, bodyFor),
      codexExecutor: null,
      repoRoot: "/pr-worktree",
      deltaPacket: PACKET,
      hunks: [] as LintHunk[],
      lintContextFor,
      readPrompt,
      whiteboard: fakeWhiteboard(applied),
      boardIdFor: (lens) => `board:${lens}`,
      onBoardArrival: (event) => arrivals.push(event),
    });

    // Five lens boards, each written once, each announced on freeze.
    const lenses: LensKind[] = ["design", "sequence", "decisions", "flagged", "noise"];
    expect(result.boards.map((b) => b.lens)).toEqual(lenses);
    for (const outcome of result.boards) {
      expect(outcome.failure).toBeUndefined();
      expect(outcome.board?.elements.length).toBeGreaterThan(0);
    }
    expect(applied.map((a) => a.boardId)).toEqual(lenses.map((l) => `board:${l}`));
    // Every op is a create — the host writes the drafter's board on its behalf.
    for (const a of applied) {
      for (const op of a.ops as { op: string }[]) expect(op.op).toBe("create");
    }
    expect(arrivals.map((a) => a.lens)).toEqual(lenses);
    // Coverage: no hunks ⇒ nothing uncovered.
    expect(result.coverage).toEqual([]);
  });

  it("council-routes each seat to the right model (claude-only scenario)", async () => {
    const captures: { model?: string; prompt?: string }[] = [];
    const applied: Applied[] = [];

    await runLensPipeline({
      claudePort: fakeClaudePort(captures, (p) => cleanBody(lensFromPrompt(p))),
      codexExecutor: null,
      repoRoot: "/pr-worktree",
      deltaPacket: PACKET,
      hunks: [] as LintHunk[],
      lintContextFor,
      readPrompt,
      whiteboard: fakeWhiteboard(applied),
      boardIdFor: (lens) => `board:${lens}`,
    });

    const modelFor = (file: string): string | undefined =>
      captures.find((c) => c.prompt?.includes(file))?.model;
    // The council's claude-only table: the deep reading-surface lenses on opus, noise on haiku, flagged on sonnet.
    expect(modelFor("prompts/design.md")).toBe("opus-4.8");
    expect(modelFor("prompts/noise.md")).toBe("haiku");
    expect(modelFor("prompts/flagged.md")).toBe("sonnet-5");
  });

  it("runs the Flagged lens as a dual seat under both harnesses — cross-model concurrence", async () => {
    const claudeCaptures: { model?: string; prompt?: string }[] = [];
    const codexCaptures: { model?: string; prompt?: string }[] = [];
    const applied: Applied[] = [];

    // A clean flagged board both seats return: a grounded finding citing c1 (covers
    // h1), h2 consciously skipped — passes the flagged lens lint.
    const flaggedBody = (): unknown =>
      mkBoard(
        [
          mkFinding("f1", "The refresh token is classified as an error before its code is read.", [
            "c1",
          ]),
          mkCodeRef("c1", "src/auth.ts", 11, 12),
        ],
        [{ hunk: "h2", reason: "The util rename is mechanical — the Noise board owns it." }],
      );
    const bodyFor = (prompt: string): unknown => {
      const lens = lensFromPrompt(prompt);
      if (lens === "flagged") return flaggedBody();
      if (lens === "post-process") {
        const ctx = /rennet:layer context>>>\n(\{.*)/s.exec(prompt);
        return ctx ? (JSON.parse(ctx[1] as string).board as unknown) : { elements: [] };
      }
      return cleanBody(lens);
    };
    const codexExecutor = async (req: { model: string; prompt: string }) => {
      codexCaptures.push({ model: req.model, prompt: req.prompt });
      return { output: bodyFor(req.prompt) };
    };

    const flaggedCtx: LintContext = {
      lens: "flagged",
      hunks: [
        { id: "h1", path: "src/auth.ts", newStart: 10, newLines: 5 },
        { id: "h2", path: "src/util.ts", newStart: 1, newLines: 3 },
      ],
      files: new Map([
        ["src/auth.ts", 200],
        ["src/util.ts", 50],
      ]),
    };

    const result = await runLensPipeline({
      claudePort: fakeClaudePort(claudeCaptures, bodyFor),
      codexExecutor: codexExecutor as never,
      repoRoot: "/pr-worktree",
      deltaPacket: PACKET,
      hunks: [] as LintHunk[],
      lintContextFor: (lens) => (lens === "flagged" ? flaggedCtx : lintContextFor(lens)),
      readPrompt,
      whiteboard: fakeWhiteboard(applied),
      boardIdFor: (lens) => `board:${lens}`,
    });

    const flagged = result.boards.find((b) => b.lens === "flagged");
    expect(flagged?.failure).toBeUndefined();
    // Both models concurred on the matched finding.
    const conc = concurrenceOf(flagged?.board as DraftBoard, "f1");
    expect(conc).toEqual([
      { model: "Claude", agree: 1, total: 1 },
      { model: "Codex", agree: 1, total: 1 },
    ]);
    // Each seat was forced to its own provider's flagged pick.
    expect(
      claudeCaptures.some((c) => c.prompt?.includes("flagged.md") && c.model === "sonnet-5"),
    ).toBe(true);
    expect(
      codexCaptures.some((c) => c.prompt?.includes("flagged.md") && c.model === "gpt-5.6-sol"),
    ).toBe(true);
  });

  it("runs the round-report FIRST on a round and threads it into the lens drafters (D3/R58)", async () => {
    const captures: { model?: string; prompt?: string }[] = [];
    const applied: Applied[] = [];
    const arrivals: BoardArrivalEvent[] = [];

    // A round: the packet carries a successor account ⇒ the report drafts first.
    const roundPacket = {
      patchset: { id: "ps-1", createdAt: "", truncated: false, files: [] },
      successorAccount: { asks: [] },
    } as unknown as DeltaPacket;

    await runLensPipeline({
      claudePort: fakeClaudePort(captures, (p) => cleanBody(lensFromPrompt(p))),
      codexExecutor: null,
      repoRoot: "/pr-worktree",
      deltaPacket: roundPacket,
      hunks: [] as LintHunk[],
      lintContextFor,
      readPrompt,
      whiteboard: fakeWhiteboard(applied),
      boardIdFor: (lens) => `board:${lens}`,
      onBoardArrival: (event) => arrivals.push(event),
    });

    // The report board is written and announced BEFORE any lens board.
    expect(applied[0]?.boardId).toBe("board:report");
    expect(arrivals[0]?.lens).toBe("report");
    // The report seat routed to the round-report pick (claude-only ⇒ sonnet-5).
    expect(captures.find((c) => c.prompt?.includes("report.md"))?.model).toBe("sonnet-5");
    // Every LENS drafter prompt carried the round report as input.
    const lensPrompts = captures.filter((c) => c.prompt?.includes("design.md"));
    expect(lensPrompts.every((c) => c.prompt?.includes("roundReport"))).toBe(true);
  });

  it("does NOT run the round-report on a first generation (no successor account)", async () => {
    const applied: Applied[] = [];
    const result = await runLensPipeline({
      claudePort: fakeClaudePort([], (p) => cleanBody(lensFromPrompt(p))),
      codexExecutor: null,
      repoRoot: "/pr-worktree",
      deltaPacket: PACKET,
      hunks: [] as LintHunk[],
      lintContextFor,
      readPrompt,
      whiteboard: fakeWhiteboard(applied),
      boardIdFor: (lens) => `board:${lens}`,
    });
    expect(result.report).toBeUndefined();
    expect(applied.some((a) => a.boardId === "board:report")).toBe(false);
  });

  it("records an honest failure (never a throw) when no harness resolves the seat", async () => {
    const applied: Applied[] = [];
    const result = await runLensPipeline({
      claudePort: null,
      codexExecutor: null,
      repoRoot: "/pr-worktree",
      deltaPacket: PACKET,
      hunks: [] as LintHunk[],
      lintContextFor,
      readPrompt,
      whiteboard: fakeWhiteboard(applied),
      boardIdFor: (lens) => `board:${lens}`,
    });
    expect(applied).toEqual([]);
    for (const outcome of result.boards) expect(outcome.failure).toBeDefined();
  });
});
