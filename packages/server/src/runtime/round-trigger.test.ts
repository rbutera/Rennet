import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CodexExecutor, type HarnessPort, lintReviewDraft } from "@rennet/core";
import type {
  DraftBoard,
  Generation,
  KnowledgeSet,
  PatchFile,
  Patchset,
  Review,
  RoundEvent,
  SessionModel,
  SuccessorAccount,
} from "@rennet/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type BoardsRuntime, createBoardsRuntime } from "../boards/boards-runtime";
import {
  assembleRoundCollation,
  type BoardRegenerationDeps,
  runBoardRegeneration,
} from "./round-collation";
import { createRoundsRuntime, mintGeneration, type RoundInput } from "./rounds";

// ─────────────────────────────────────────────────────────────────────────────
// C15 task 1.5 — the runRound TRIGGER, integration-tested with FAKE ports (no live
// call). Proves the collation bridge assembled by `assembleRoundCollation` drives
// `runRound` to a minted generation with the round-report drafting BEFORE the
// lenses, and that a trigger with no prior generation still mints gen-1 without
// error (the honest first-generation degrade). The model is the only fake — every
// other seam (boards runtime, generation lifecycle, the round serializer) is real.
// ─────────────────────────────────────────────────────────────────────────────

const PATCH = ["@@ -1,2 +1,2 @@", " const a = 1;", "-const b = 2;", "+const b = 3;"].join("\n");

function patchset(): Patchset {
  const file: PatchFile = {
    path: "src/a.ts",
    status: "modified",
    additions: 1,
    deletions: 1,
    binary: false,
    patch: PATCH,
  };
  return {
    id: "ps-trigger",
    createdAt: "2026-01-01T00:00:00.000Z",
    repository: {
      id: "repo",
      root: "/repo",
      commonDir: "/repo/.git",
      baseRef: "origin/main",
      baseOid: "0".repeat(40),
      headOid: "1".repeat(40),
    },
    files: [file],
    rawDiff: "",
    byteLength: 0,
    truncated: false,
  };
}

// Records the ORDER seats are asked to draft, and answers a clean board per lens —
// so the test can assert the round-report drafts before any lens (R58/D3).
function orderedFakeClaudePort(order: string[]): HarnessPort {
  const lensFromPrompt = (p: string): string =>
    /PROMPT_FILE:prompts\/([a-z-]+)\.md/.exec(p)?.[1] ?? "unknown";
  const board = (lens: string): DraftBoard =>
    ({
      elements: [
        {
          id: `${lens}-p1`,
          kind: "prose",
          data: { author: { kind: "lens-agent", id: `${lens}-seat` }, markdown: "Reads cleanly." },
        },
      ],
    }) as unknown as DraftBoard;
  return {
    createSession: async () => {
      const cap: { prompt?: string } = {};
      return {
        send: async (input: { prompt: string }) => {
          cap.prompt = input.prompt;
        },
        close: async () => {
          /* nothing to release */
        },
        events: (async function* () {
          const lens = lensFromPrompt(cap.prompt ?? "");
          order.push(lens);
          yield {
            kind: "session.ended",
            native: {},
            outcome: { status: "completed", structuredOutput: board(lens) },
          };
        })(),
      } as unknown as Awaited<ReturnType<HarnessPort["createSession"]>>;
    },
  } as unknown as HarnessPort;
}

const readPrompt = (file: string): string => `PROMPT_FILE:${file}`;
const session: SessionModel = {
  id: "trigger-session",
  projectId: "/repo",
  threads: [],
  createdAt: Date.now(),
} as unknown as SessionModel;

describe("C15 1.5 — runRound trigger over the assembled collation (fake ports)", () => {
  let root: string;
  let boards: BoardsRuntime;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "c15-trigger-"));
    boards = createBoardsRuntime(root);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function runtimeWith(order: string[]) {
    return createRoundsRuntime({
      resolveClaudePort: async () => orderedFakeClaudePort(order),
      resolveCodexExecutor: async () => null as CodexExecutor | null,
      boardsRuntimeFor: () => ({
        service: boards.service,
        createRennetBoard: boards.createRennetBoard,
      }),
      readPrompt,
    });
  }

  it("mints a new generation with the report drafting before the lenses (a landed round)", async () => {
    const order: string[] = [];
    const successorAccount: SuccessorAccount = { asks: [], beyondAsks: [] };
    const collation = assembleRoundCollation({
      patchset: patchset(),
      knowledge: {
        schemaVersion: 1,
        repoKey: "repo",
        baseOid: "0".repeat(40),
        snapshotFingerprint: "fp",
        generator: "t",
        statements: [],
      },
      dossier: [],
      successorAccount,
    });
    const previousGeneration = mintGeneration("gen:ps-prior", "ps-prior");

    const outcome = await runtimeWith(order).runRound({
      session,
      repoRoot: root,
      previousGeneration,
      asksDispatched: ["t-1"],
      // The worker moved code (a new patchset landed) ⇒ a successor generation mints.
      runWorkers: async () => ({ commitRange: { from: "c0", to: "c1" }, patchsetId: "ps-landed" }),
      ...collation,
    });

    // A real successor generation minted; the prior froze because the code moved.
    expect(outcome.boardGeneration.id).toBe("gen:ps-landed");
    expect(outcome.frozenPrevious?.id).toBe("gen:ps-prior");
    // The round-report drafted FIRST — before any lens (it gates the regeneration).
    expect(order[0]).toBe("report");
    expect(outcome.pipeline.report?.board).toBeDefined();
    // The lens boards came back too.
    expect(outcome.pipeline.boards.filter((b) => b.board !== undefined).length).toBeGreaterThan(0);
  });

  it("degrades to a first-generation draft when no successor account, without error", async () => {
    const order: string[] = [];
    const collation = assembleRoundCollation({
      patchset: patchset(),
      knowledge: {
        schemaVersion: 1,
        repoKey: "repo",
        baseOid: "0".repeat(40),
        snapshotFingerprint: "fp",
        generator: "t",
        statements: [],
      },
      dossier: [],
      // no successorAccount ⇒ first-generation (non-round): the report does NOT draft first.
    });
    const previousGeneration: Generation = mintGeneration("gen:ps-first", "ps-first");

    const events: RoundEvent[] = [];
    const outcome = await runtimeWith(order).runRound({
      session: { ...session, id: "first-gen-session" } as SessionModel,
      repoRoot: root,
      previousGeneration,
      asksDispatched: [],
      // Nothing landed ⇒ re-report against the existing generation, no successor mint.
      runWorkers: async () => ({ commitRange: { from: "c0", to: "c0" } }),
      onProgress: (event) => events.push(event),
      ...collation,
    });

    // No crash; the existing generation is re-used (nothing landed), no report seat ran.
    expect(outcome.boardGeneration.id).toBe("gen:ps-first");
    expect(outcome.frozenPrevious).toBeUndefined();
    expect(order).not.toContain("report"); // non-round ⇒ report does not gate

    // …and the LIVE CHANNEL says so honestly. This is the commonest shape of "the coding
    // agent ran and changed nothing", and asserting only "no crash" is what let the run
    // view stall on it: the round emits NO `report` event at all, and the terminal event
    // is the one the run machine has to be able to accept without one.
    expect(events.map((e) => e.type)).not.toContain("report");
    expect(events.at(-1)?.type).toBe("composed");
  });

  // ── Coverage, through the REAL path (review finding 11) ───────────────────
  //
  // The flip-to-red control for coverage used to call `assertCoverage` on the side, which
  // only ever proved the helper works. This drives an uncovered hunk through `runRound`
  // itself: the drafters answer prose-only boards that teach nothing, so the round's own
  // coverage verdict must name the patchset's hunk. A pipeline that stopped asserting
  // coverage — the failure that matters — would pass the old control and fail this one.
  it("a hunk no board teaches comes back as the round's own coverage violation", async () => {
    const collation = assembleRoundCollation({
      patchset: patchset(),
      knowledge: KNOWLEDGE,
      dossier: [],
      successorAccount: { asks: [], beyondAsks: [] },
    });
    // The collation bridge really derived a hunk from the patchset — otherwise the
    // assertion below would pass over an empty universe.
    expect(collation.hunks).toHaveLength(1);
    const hunkId = collation.hunks[0]?.id;

    const outcome = await runtimeWith([]).runRound({
      session: { ...session, id: "coverage-session" } as SessionModel,
      repoRoot: root,
      asksDispatched: [],
      runWorkers: async () => ({ commitRange: { from: "c0", to: "c1" }, patchsetId: "ps-cov" }),
      ...collation,
    });

    const coverage = outcome.pipeline.coverage;
    expect(coverage, "a freshly drafted round must know its coverage picture").toBeDefined();
    expect((coverage ?? []).map((v) => v.ruleId)).toContain("every-hunk-covered");
    expect((coverage ?? []).map((v) => v.elementRef)).toContain(`/hunks/${hunkId}`);

    // The same round over an EMPTY hunk universe reports nothing — the verdict tracks the
    // real patchset rather than being a constant the assertion above could not tell apart.
    const empty = await runtimeWith([]).runRound({
      session: { ...session, id: "coverage-empty-session" } as SessionModel,
      repoRoot: root,
      asksDispatched: [],
      runWorkers: async () => ({ commitRange: { from: "c0", to: "c1" }, patchsetId: "ps-cov-2" }),
      ...collation,
      hunks: [],
      lintContextFor: (lens) => ({ ...collation.lintContextFor(lens), hunks: [] }),
    });
    expect(empty.pipeline.coverage).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The POST-REWORK diff (C15 1.5, review finding 1). The boards a round mints must
// describe the tree the WORKER left, not the one it was handed. The trigger used to
// source its patchset from the pre-worker closure, so every regenerated board
// described the diff the round had just changed — while the UI called it the delta.
// The seams below are fakes; the ORDER under test is the real one.
// ─────────────────────────────────────────────────────────────────────────────

const PRE_LINE = "+  return `Hi ${name}`;";
const POST_LINE = "+  return `Hello, ${name}!`;";

/** A one-file patchset whose single added line is `added` — the content the drafters read. */
function greetPatchset(id: string, added: string): Patchset {
  return {
    ...patchset(),
    id,
    files: [
      {
        path: "src/greet.ts",
        status: "modified",
        additions: 1,
        deletions: 1,
        binary: false,
        patch: [
          "@@ -1,3 +1,3 @@",
          " export function greet(name: string): string {",
          "-  return `Hey ${name}`;",
          added,
          " }",
        ].join("\n"),
      },
    ],
  };
}

const KNOWLEDGE: KnowledgeSet = {
  schemaVersion: 1,
  repoKey: "repo",
  baseOid: "0".repeat(40),
  snapshotFingerprint: "fp",
  generator: "t",
  statements: [],
};

describe("C15 1.5 — the regeneration drafts over the POST-worker patchset", () => {
  /** A review that starts on the pre-worker patchset; `recapture` activates the successor,
   *  exactly as `review.regenerate` does after the worker's tree lands. */
  function reviewHarness() {
    const pre = greetPatchset("ps-pre", PRE_LINE);
    const post = greetPatchset("ps-post", POST_LINE);
    let review = {
      id: "rev-1",
      repositoryRoot: "/repo",
      activePatchsetId: pre.id,
      patchsets: [pre],
      dispositions: [],
      status: "current",
    } as unknown as Review;
    const seen: RoundInput[] = [];
    const events: RoundEvent[] = [];
    return {
      seen,
      events,
      deps: {
        recapture: async () => {
          review = {
            ...review,
            patchsets: [pre, post],
            activePatchsetId: post.id,
            successorAccount: { asks: [], beyondAsks: [] },
          } as unknown as Review;
        },
        reviewNow: () => review,
        knowledgeFor: () => ({ set: KNOWLEDGE, snapshot: null }),
        // No generation has ever been minted for this session — an honest first generation.
        priorGeneration: async () => undefined,
        runRound: async (input: RoundInput) => {
          seen.push(input);
          return undefined;
        },
        emit: (event: RoundEvent) => events.push(event),
      },
    };
  }

  // W5 -- the whole-tree citation grounding is best-effort. `fileInventory` reads git,
  // and a repo git cannot answer (a tree with no text files makes `git grep` exit 1)
  // must leave the boards drafting on the diff-derived inventories, which is the
  // behaviour before W5 -- never sink a landed round over a lint input.

  it("uses the tree inventory for citation grounding when the reader answers", async () => {
    const { deps, seen } = reviewHarness();
    await runBoardRegeneration(
      {
        ...deps,
        fileInventory: async () => ({
          head: new Map([["src/untouched.ts", 400]]),
          base: new Map([["src/untouched.ts", 380]]),
        }),
      },
      {
        session,
        repoRoot: "/repo",
        priorPatchsetId: "ps-pre",
        asksDispatched: ["t-1"],
        worked: { commitRange: { from: "c0", to: "c1" }, patchsetId: "c1" },
      },
    );
    const ctx = seen[0]?.lintContextFor("design");
    expect(ctx?.files.get("src/untouched.ts")).toBe(400);
    expect(ctx?.baseFiles?.get("src/untouched.ts")).toBe(380);
  });

  // W5 finding 2 — the composed review draft is the surface the reviewer READS, and it
  // was linted against an empty inventory: no composition root ever supplied
  // `reviewDraftLintCtx`, so every real `path:line` in the draft came back "does not
  // resolve". Visible-never-blocking, so nothing was deleted — the draft was just
  // papered with false ungrounded marks. It must carry the boards' own head inventory.
  it("grounds the composed review draft on the same head inventory as the boards", async () => {
    const { deps, seen } = reviewHarness();
    await runBoardRegeneration(
      {
        ...deps,
        fileInventory: async () => ({
          head: new Map([["src/untouched.ts", 400]]),
          base: new Map(),
        }),
      },
      {
        session,
        repoRoot: "/repo",
        priorPatchsetId: "ps-pre",
        asksDispatched: ["t-1"],
        worked: { commitRange: { from: "c0", to: "c1" }, patchsetId: "c1" },
      },
    );
    const ctx = seen[0]?.reviewDraftLintCtx;
    if (ctx === undefined) throw new Error("the round carried no review-draft lint context");
    expect(ctx.files).toEqual(seen[0]?.lintContextFor("design").files);

    const prose = "The refresh guard at src/untouched.ts:200 is correct.";
    expect(lintReviewDraft(prose, ctx)).toEqual([]);
    // POSITIVE CONTROL: the `{ files: new Map() }` default this used to fall back to.
    expect(lintReviewDraft(prose, { files: new Map() }).map((v) => v.ruleId)).toEqual([
      "citation-resolves",
    ]);
  });

  it("degrades to the diff-derived inventories when the tree read REJECTS", async () => {
    const { deps, seen, events } = reviewHarness();
    await runBoardRegeneration(
      {
        ...deps,
        fileInventory: async () => {
          throw new Error("fatal: no text files in the tree");
        },
      },
      {
        session,
        repoRoot: "/repo",
        priorPatchsetId: "ps-pre",
        asksDispatched: ["t-1"],
        worked: { commitRange: { from: "c0", to: "c1" }, patchsetId: "c1" },
      },
    );
    // The round still drafted, on the diff-derived universe...
    expect(seen[0]?.lintContextFor("design").patchsetId).toBe("ps-post");
    // ...and the failure never reached the terminal handler.
    expect(events.filter((e) => e.type === "failed")).toEqual([]);
  });

  it("degrades when the tree reader throws SYNCHRONOUSLY, not just on a rejection", async () => {
    const { deps, seen, events } = reviewHarness();
    await runBoardRegeneration(
      {
        ...deps,
        fileInventory: (() => {
          throw new Error("boom before the promise exists");
        }) as unknown as NonNullable<BoardRegenerationDeps["fileInventory"]>,
      },
      {
        session,
        repoRoot: "/repo",
        priorPatchsetId: "ps-pre",
        asksDispatched: ["t-1"],
        worked: { commitRange: { from: "c0", to: "c1" }, patchsetId: "c1" },
      },
    );
    expect(seen[0]?.lintContextFor("design").patchsetId).toBe("ps-post");
    expect(events.filter((e) => e.type === "failed")).toEqual([]);
  });

  it("hands the drafters the worker's OWN diff, and files it under the successor generation", async () => {
    const { deps, seen } = reviewHarness();
    await runBoardRegeneration(deps, {
      session,
      repoRoot: "/repo",
      priorPatchsetId: "ps-pre",
      asksDispatched: ["t-1"],
      worked: { commitRange: { from: "c0", to: "c1" }, patchsetId: "c1" },
    });

    const input = seen[0];
    if (input === undefined) throw new Error("runRound was never called");
    // THE LIE THIS GUARDS: the packet the six drafters read must carry the POST-rework
    // line. Sourced pre-worker, it carries the line the round just replaced.
    const body = input.deltaPacket.hunks.hunks.flatMap((h) => h.body);
    expect(body).toContain(POST_LINE);
    expect(body).not.toContain(PRE_LINE);
    expect(input.deltaPacket.patchset.id).toBe("ps-post");
    // The lint universe the boards are checked against is the same successor patchset.
    expect(input.lintContextFor("design").patchsetId).toBe("ps-post");
    // The successor account stamped by that re-capture is what makes it a ROUND.
    expect(input.deltaPacket.successorAccount).toBeDefined();
    // The minted generation is keyed to the successor PATCHSET (not the HEAD oid), and it
    // succeeds the generation the pre-worker patchset carried.
    expect(await input.runWorkers()).toEqual({
      commitRange: { from: "c0", to: "c1" },
      patchsetId: "ps-post",
    });
    // No prior generation was ever minted for this session, so the round is a first
    // generation — it does not claim a predecessor it does not have.
    expect(input.previousGeneration).toBeUndefined();
  });

  it("a turn that moved nothing re-reports against the existing generation, no successor mint", async () => {
    const { deps, seen } = reviewHarness();
    await runBoardRegeneration(deps, {
      session,
      repoRoot: "/repo",
      priorPatchsetId: "ps-pre",
      asksDispatched: [],
      // No patchsetId ⇒ HEAD never moved ⇒ no re-capture, so the review stays on ps-pre.
      worked: { commitRange: { from: "c0", to: "c0" } },
    });

    const input = seen[0];
    if (input === undefined) throw new Error("runRound was never called");
    expect(input.deltaPacket.patchset.id).toBe("ps-pre");
    expect(await input.runWorkers()).toEqual({ commitRange: { from: "c0", to: "c0" } });
  });

  it("closes the live channel on a terminal failed when the regeneration throws — never a stall", async () => {
    const { deps, events } = reviewHarness();
    await runBoardRegeneration(
      {
        ...deps,
        recapture: async () => {
          throw new Error("the re-capture died");
        },
      },
      {
        session,
        repoRoot: "/repo",
        priorPatchsetId: "ps-pre",
        asksDispatched: [],
        worked: { commitRange: { from: "c0", to: "c1" }, patchsetId: "c1" },
      },
    );
    expect(events).toEqual([{ type: "failed", reason: "the re-capture died" }]);
  });
});
