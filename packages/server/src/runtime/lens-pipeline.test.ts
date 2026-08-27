import type { DeltaPacket, HarnessPort, LintContext, LintHunk, LintTarget } from "@rennet/core";
import type { DraftBoard, LensKind } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import {
  type BoardArrivalEvent,
  boardOutputSchema,
  draftToOps,
  runLensPipeline,
} from "./lens-pipeline";

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
