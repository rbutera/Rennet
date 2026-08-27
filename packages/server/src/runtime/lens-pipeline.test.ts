import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WhiteboardClient } from "@rennet/adapters";
import type { DeltaPacket, HarnessPort, LintContext, LintHunk, LintTarget } from "@rennet/core";
import type { DraftBoard, LensKind } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import { createBoardsRuntime } from "../boards/boards-runtime";
import {
  type BoardArrivalEvent,
  type BoardMeta,
  boardOutputSchema,
  composeReviewDraft,
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

  it("topologically orders a referenced element before its citer (finding 2)", () => {
    // Authoring order puts the finding BEFORE the code_ref it cites — the board
    // service would reject that as a bad-ref, so the ops must be reordered.
    const board = mkBoard([mkFinding("f1", "cites c1", ["c1"]), mkCodeRef("c1", "src/a.ts", 1, 2)]);
    const ids = draftToOps(board).map((o) => o.element.id);
    expect(ids.indexOf("c1")).toBeLessThan(ids.indexOf("f1"));
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
    // Seat B is namespaced (finding 7) — its solo finding keeps its raising model's concurrence under `b:f2`.
    expect(concurrenceOf(merged, "b:f2")).toEqual([
      { model: "Claude", agree: 0, total: 1 },
      { model: "Codex", agree: 1, total: 1 },
    ]);
  });

  it("namespaces seat B so its finding never resolves seat A's colliding id (finding 7)", () => {
    // Both seats independently minted the id `c1` for DIFFERENT code regions.
    const a = mkBoard([
      mkFinding("f1", "Claude's concern in auth", ["c1"]),
      mkCodeRef("c1", "src/auth.ts", 11, 12),
    ]);
    const b = mkBoard([
      mkFinding("f2", "Codex's concern in a DIFFERENT file", ["c1"]),
      mkCodeRef("c1", "src/other.ts", 3, 4),
    ]);
    const merged = reconcileFlaggedBoards(a, b, labels);

    // Both solo findings survive (different anchors).
    expect(merged.elements.filter((e) => e.kind === "finding")).toHaveLength(2);
    // Seat B's finding must cite seat B's OWN code_ref (other.ts), not seat A's c1 (auth.ts).
    const f2 = merged.elements.find((e) =>
      (e.data as { concern?: string } | undefined)?.concern?.includes("DIFFERENT"),
    );
    const citedId = (f2?.data as { code: string[] } | undefined)?.code[0] ?? "";
    const cited = merged.elements.find((e) => e.id === citedId);
    expect((cited?.data as { path: string } | undefined)?.path).toBe("src/other.ts");
    // Seat A's c1 (auth.ts) survives untouched under its own id.
    const seatAref = merged.elements.find((e) => e.id === "c1");
    expect((seatAref?.data as { path: string } | undefined)?.path).toBe("src/auth.ts");
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

describe("composeReviewDraft — the authored composition write-through (C2)", () => {
  const prose = (id: string, markdown: string): DraftBoard["elements"][number] =>
    ({
      id,
      kind: "prose",
      data: { author: flaggedAuthor, markdown },
    }) as unknown as DraftBoard["elements"][number];

  it("authors connective prose, computes the mechanical carry, and screens the register", async () => {
    const keep = prose("keep", "This section is unchanged across generations.");
    const previous = new Map([["design", mkBoard([keep])] as const]);
    const current = new Map([
      ["design", mkBoard([keep, prose("new1", "A fresh observation.")])] as const,
    ]);

    const result = await composeReviewDraft({
      boards: current,
      previous,
      voicePromptText: "VOICE RULES",
      authorTurn: (p) =>
        `AUTHORED for ${p.includes("VOICE RULES") ? "voice" : "?"}: the change reads cleanly.`,
      lintCtx: { files: new Map() },
    });

    expect(result.prose).toContain("the change reads cleanly");
    // The byte-identical element carried; the new one did not.
    expect([...(result.carried.get("design") ?? [])]).toEqual(["keep"]);
    // Clean prose (no machinery, no citations) ⇒ no register violations.
    expect(result.violations).toEqual([]);
  });

  it("flags machinery vocabulary in the review register (visible, never blocking)", async () => {
    const result = await composeReviewDraft({
      boards: new Map(),
      voicePromptText: "VOICE",
      authorTurn: () => "This lens board was drafted by an agent seat.",
      lintCtx: { files: new Map() },
    });
    expect(result.violations.length).toBeGreaterThan(0);
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

  it("seeds each drafter turn with the DeltaPacket + lens prompt + host schema (D1)", async () => {
    const captures: { model?: string; prompt?: string }[] = [];
    await runLensPipeline({
      claudePort: fakeClaudePort(captures, (p) => cleanBody(lensFromPrompt(p))),
      codexExecutor: null,
      repoRoot: "/pr-worktree",
      deltaPacket: PACKET,
      hunks: [] as LintHunk[],
      lintContextFor,
      readPrompt,
      whiteboard: fakeWhiteboard([]),
      boardIdFor: (lens) => `board:${lens}`,
    });
    const designTurn = captures.find((c) => c.prompt?.includes("design.md"))?.prompt ?? "";
    expect(designTurn).toContain("PROMPT_FILE:prompts/design.md"); // the lens prompt
    expect(designTurn).toContain("ps-1"); // the inlined DeltaPacket (patchset id)
    expect(designTurn).toContain("hostSchema"); // the host board schema
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
    // Both models concurred on the matched finding — it collapses to ONE (its id is
    // whichever seat's summary was clearer, so look it up by kind, not a fixed id).
    const flaggedBoard = flagged?.board as DraftBoard | undefined;
    const matched = (flaggedBoard?.elements ?? []).filter((e) => e.kind === "finding");
    expect(matched).toHaveLength(1);
    const conc = concurrenceOf(flaggedBoard as DraftBoard, matched[0]?.id ?? "");
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

  it("runs the authored composition when a composeTurn is supplied (C2)", async () => {
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
      composeTurn: () => "The change is coherent and ready for review.",
      reviewDraftLintCtx: { files: new Map() },
    });
    expect(result.composition?.prose).toBe("The change is coherent and ready for review.");
    expect(result.composition?.violations).toEqual([]);
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

// ── Persistence honesty (findings 2/3/6) ─────────────────────────────────────

describe("runLensPipeline — persistence honesty (findings 2/3/6)", () => {
  const FLAGGED_HUNKS: LintHunk[] = [
    { id: "h1", path: "src/auth.ts", newStart: 10, newLines: 5 },
    { id: "h2", path: "src/util.ts", newStart: 1, newLines: 3 },
  ];
  const flaggedCtx: LintContext = {
    lens: "flagged",
    hunks: FLAGGED_HUNKS,
    files: new Map([
      ["src/auth.ts", 200],
      ["src/util.ts", 50],
    ]),
  };
  // A flagged board whose finding is authored BEFORE the code_ref it cites (the
  // bad-ref hazard) and that consciously skips h2.
  const flaggedBody = (): DraftBoard =>
    mkBoard(
      [
        mkFinding("f1", "The refresh token is classified as an error before its code is read.", [
          "c1",
        ]),
        mkCodeRef("c1", "src/auth.ts", 11, 12),
      ],
      [{ hunk: "h2", reason: "The util rename is mechanical — the Noise board owns it." }],
    );
  const bodyForFlagged = (prompt: string): unknown => {
    const lens = lensFromPrompt(prompt);
    if (lens === "flagged") return flaggedBody();
    if (lens === "post-process") {
      const ctx = /rennet:layer context>>>\n(\{.*)/s.exec(prompt);
      return ctx ? (JSON.parse(ctx[1] as string).board as unknown) : { elements: [] };
    }
    return cleanBody(lens);
  };

  it("a real board service rejects raw finding-before-code_ref order but accepts draftToOps order (finding 2)", async () => {
    const root = await mkdtemp(join(tmpdir(), "lens-pipeline-"));
    try {
      const runtime = createBoardsRuntime(root);
      const client = new WhiteboardClient(runtime.service);
      const board = flaggedBody();

      // Raw authoring order (finding first) is a bad-ref — the exact hazard finding 2 names.
      const rawId = await runtime.createRennetBoard();
      const rawOps = board.elements.map((element) => ({ op: "create" as const, element }));
      const raw = await client.apply(rawId, rawOps as never, "lens:flagged");
      expect(raw.response.ok).toBe(false);

      // draftToOps reorders the code_ref ahead of its citer → accepted.
      const okId = await runtime.createRennetBoard();
      const ok = await client.apply(okId, draftToOps(board) as never, "lens:flagged");
      expect(ok.response.ok).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("writes through a REAL board service and persists skippedHunks durably (findings 2/3)", async () => {
    const root = await mkdtemp(join(tmpdir(), "lens-pipeline-"));
    try {
      const runtime = createBoardsRuntime(root);
      const client = new WhiteboardClient(runtime.service);
      const lenses: LintTarget[] = ["design", "sequence", "decisions", "flagged", "noise"];
      const boardIds = new Map<LintTarget, string>();
      for (const l of lenses) boardIds.set(l, await runtime.createRennetBoard());

      const meta: BoardMeta[] = [];
      const arrivals: BoardArrivalEvent[] = [];
      const result = await runLensPipeline({
        claudePort: fakeClaudePort([], bodyForFlagged),
        codexExecutor: null,
        repoRoot: "/pr-worktree",
        deltaPacket: PACKET,
        hunks: FLAGGED_HUNKS,
        lintContextFor: (l) => (l === "flagged" ? flaggedCtx : lintContextFor(l)),
        readPrompt,
        whiteboard: client,
        boardIdFor: (l) => boardIds.get(l) ?? "",
        onBoardArrival: (e) => arrivals.push(e),
        persistBoardMeta: (m) => {
          meta.push(m);
        },
      });

      // The finding-before-code_ref board was ACCEPTED (draftToOps reordering worked
      // through the real service) — not a silent failure.
      const flagged = result.boards.find((b) => b.lens === "flagged");
      expect(flagged?.failure).toBeUndefined();

      // Reconstruct the flagged board from the ACTUAL event log — both elements landed.
      const flaggedId = boardIds.get("flagged") ?? "";
      const state = await runtime.service.getState(flaggedId);
      expect(state.has("f1")).toBe(true);
      expect(state.has("c1")).toBe(true);

      // skippedHunks survived persistence via the durable metadata seam — the event
      // log carries only elements, so this is the finding-3 durability proof.
      const flaggedMeta = meta.find((m) => m.lens === "flagged");
      expect(flaggedMeta?.skippedHunks).toEqual([
        { hunk: "h2", reason: "The util rename is mechanical — the Noise board owns it." },
      ]);
      // Every accepted board announced its arrival (after cross-lens coverage).
      expect(arrivals.map((a) => a.lens)).toContain("flagged");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("surfaces a rejected board write as a lens failure and does not announce it (finding 2)", async () => {
    const applied: Applied[] = [];
    const arrivals: BoardArrivalEvent[] = [];
    const rejecting = {
      apply: async (boardId: string, ops: readonly unknown[], actor: string) => {
        applied.push({ boardId, ops, actor });
        return { response: { ok: false, code: "bad-ref" }, ops } as never;
      },
    };
    const result = await runLensPipeline({
      claudePort: fakeClaudePort([], (p) => cleanBody(lensFromPrompt(p))),
      codexExecutor: null,
      repoRoot: "/pr-worktree",
      deltaPacket: PACKET,
      hunks: [] as LintHunk[],
      lintContextFor,
      readPrompt,
      whiteboard: rejecting,
      boardIdFor: (l) => `board:${l}`,
      onBoardArrival: (e) => arrivals.push(e),
    });
    for (const o of result.boards) expect(o.failure).toBeDefined();
    // A rejected write is never announced as arrived.
    expect(arrivals).toEqual([]);
  });

  it("surfaces a never-parseable drafter as a lens failure, never an empty board (finding 6)", async () => {
    const applied: Applied[] = [];
    const result = await runLensPipeline({
      claudePort: fakeClaudePort([], () => ({ not: "a board" })), // never parses
      codexExecutor: null,
      repoRoot: "/pr-worktree",
      deltaPacket: PACKET,
      hunks: [] as LintHunk[],
      lintContextFor,
      readPrompt,
      whiteboard: fakeWhiteboard(applied),
      boardIdFor: (l) => `board:${l}`,
    });
    for (const o of result.boards) {
      expect(o.failure).toBeDefined();
      expect(o.board).toBeUndefined();
    }
    expect(applied).toEqual([]); // no board ever written
  });

  it("degrades a thrown drafting turn to a recorded failure, never an uncaught throw (finding 6/opus F1)", async () => {
    const throwingPort = {
      createSession: async () => {
        throw new Error("live claude crashed");
      },
    } as unknown as HarnessPort;
    const applied: Applied[] = [];
    const result = await runLensPipeline({
      claudePort: throwingPort,
      codexExecutor: null,
      repoRoot: "/pr-worktree",
      deltaPacket: PACKET,
      hunks: [] as LintHunk[],
      lintContextFor,
      readPrompt,
      whiteboard: fakeWhiteboard(applied),
      boardIdFor: (l) => `board:${l}`,
    });
    for (const o of result.boards) expect(o.failure).toBeDefined();
    expect(applied).toEqual([]);
  });
});
