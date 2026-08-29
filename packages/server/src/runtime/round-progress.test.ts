import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BoardMetaStore,
  DESIGN_ARTIFACT_LIMITS,
  type DesignArtifactSet,
  GenerationStore,
} from "@rennet/adapters";
import type { CodexExecutor, HarnessPort, LintTarget } from "@rennet/core";
import type {
  ComposableAsk,
  DraftBoard,
  KnowledgeSet,
  LensLane,
  PatchFile,
  Patchset,
  Review,
  RoundEvent,
  SessionModel,
} from "@rennet/protocol";
import { currentGenerationId, parseDraft } from "@rennet/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type BoardsRuntime, createBoardsRuntime } from "../boards/boards-runtime";
import {
  assembleRoundCollation,
  readPriorGeneration,
  runBoardRegeneration,
} from "./round-collation";
import { RoundProgressHub } from "./round-progress";
import { createRoundsRuntime, mintGeneration, type RoundOutcome } from "./rounds";

// ─────────────────────────────────────────────────────────────────────────────
// C15 cluster 3 — the LIVE round-progress channel, at its real seams.
//
//  • 3.1 — the hub's log semantics, and the events a REAL `runRound` emits: the
//    round-report's arrival, per-lens lanes, the composed generation. A regeneration
//    that throws emits a TERMINAL `failed` rather than leaving the run mid-phase.
//  • 3.3 — the CARRY-FORWARD lane label. The positive control is the one that can lie:
//    a lens whose sections actually changed must NOT read "carrying forward". The label
//    derives from `isCarriedForward` over the stamps `stampDeltas` wrote, so the lane
//    and the board's section markers are one signal.
//
// The model seats are the only fakes; the boards runtime, the generation lifecycle, the
// delta stamps and the round serializer are all real.
// ─────────────────────────────────────────────────────────────────────────────

/** A settled lens lane's verdict, read off the arm that carries one — `undefined` for a
 *  lane that has not settled (review finding 8: `queued`/`running` HAVE no verdict, and
 *  the union no longer lets a test reach for one). */
function verdictOf(lanes: readonly LensLane[], id: string): string | undefined {
  const lane = lanes.find((l) => l.id === id);
  return lane?.status === "done" ? lane.verdict : undefined;
}

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
    id: "ps-progress",
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

/** The same patchset under another id — one activation per round in the lineage test. */
const patchsetAt = (id: string): Patchset => ({ ...patchset(), id });

const KNOWLEDGE: KnowledgeSet = {
  schemaVersion: 1,
  repoKey: "repo",
  baseOid: "0".repeat(40),
  snapshotFingerprint: "fp",
  generator: "t",
  statements: [],
};

const NO_MATERIAL_DESIGN_ARTIFACTS: DesignArtifactSet = {
  changedPaths: ["src/a.ts"],
  omittedChangedPathCount: 0,
  candidates: [
    {
      id: "openspec:unrelated-feature",
      format: "openspec",
      name: "unrelated-feature",
      nameSourceBytes: 17,
      nameTruncated: false,
      relevance: { kind: "repository-candidate" },
      artifacts: [
        {
          path: "openspec/changes/unrelated-feature/proposal.md",
          role: "proposal",
          content: "# Unrelated feature\n\nThis change governs billing notifications.",
          sourceBytes: 63,
          truncated: false,
        },
      ],
      omittedArtifactCount: 0,
    },
  ],
  omittedCandidateCount: 0,
  limits: DESIGN_ARTIFACT_LIMITS,
};

const author = { kind: "lens-agent", id: "seat" };

/** A schema-valid board carrying ONE section whose child prose says `body`. Two boards
 *  built with the same `body` have an identical section subtree ⇒ the section carries;
 *  a different `body` reworks it. This is the lever the 3.3 control pulls. */
function sectioned(body: string): DraftBoard {
  const parsed = parseDraft({
    elements: [
      { id: "s1", kind: "section", data: { author, title: "Findings", children: ["p1"] } },
      { id: "p1", kind: "prose", data: { author, markdown: body } },
    ],
  });
  if (!parsed.ok) throw new Error(`fixture not schema-valid: ${JSON.stringify(parsed.issues)}`);
  return parsed.value;
}

/**
 * A claude port that answers each DRAFTING turn with `outputFor(lens)`. The pipeline funnels
 * every drafted board through a post-process turn (`prompts/post-process.md`) on the same
 * seat; that turn must hand back the board it was given, so the fake replays the last
 * drafted board for it. (Answering post-process with a fresh board silently replaced a
 * lens's re-draft — which is exactly what the 3.3 control caught.)
 */
function fakeClaudePort(outputFor: (lens: string) => unknown): HarnessPort {
  const lensFromPrompt = (p: string): string =>
    /PROMPT_FILE:prompts\/([a-z-]+)\.md/.exec(p)?.[1] ?? "unknown";
  let lastDrafted: unknown;
  const answer = (prompt: string): unknown => {
    const lens = lensFromPrompt(prompt);
    if (lens === "post-process" && lastDrafted !== undefined) return lastDrafted;
    lastDrafted = outputFor(lens);
    return lastDrafted;
  };
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
          yield {
            kind: "session.ended",
            native: {},
            outcome: { status: "completed", structuredOutput: answer(cap.prompt ?? "") },
          };
        })(),
      } as unknown as Awaited<ReturnType<HarnessPort["createSession"]>>;
    },
  } as unknown as HarnessPort;
}

const readPrompt = (file: string): string => `PROMPT_FILE:${file}`;
const session: SessionModel = {
  id: "progress-session",
  projectId: "/repo",
  threads: [],
  createdAt: Date.now(),
} as unknown as SessionModel;

const collationFor = () =>
  assembleRoundCollation({
    patchset: patchset(),
    knowledge: KNOWLEDGE,
    dossier: [],
    // A successor account makes this a ROUND: the report drafts first and the delta
    // stamps run against `previous`.
    successorAccount: { asks: [], beyondAsks: [] },
  });

describe("RoundProgressHub — the append-only round log (C15 3.1)", () => {
  it("records events in order and answers a cold read", () => {
    const hub = new RoundProgressHub();
    hub.emit("rev-1", { type: "dispatched" });
    hub.emit("rev-1", { type: "gate" });
    expect(hub.read("rev-1").map((e) => e.type)).toEqual(["dispatched", "gate"]);
    // A review with no round is honestly empty, never a fabricated phase.
    expect(hub.read("rev-2")).toEqual([]);
  });

  it("a new dispatch resets the log so the prior round's `composed` never replays", () => {
    const hub = new RoundProgressHub();
    hub.emit("rev-1", { type: "dispatched" });
    hub.emit("rev-1", { type: "composed", generation: "gen-1" });
    hub.emit("rev-1", { type: "dispatched" });
    expect(hub.read("rev-1").map((e) => e.type)).toEqual(["dispatched"]);
  });

  it("pushes every recorded event to the live sink", () => {
    const pushed: Array<{ reviewId: string; event: RoundEvent }> = [];
    const hub = new RoundProgressHub((reviewId, event) => pushed.push({ reviewId, event }));
    hub.sinkFor("rev-9")({ type: "report", reportBoardId: "b-1" });
    hub.sinkFor("rev-9")({ type: "composed", generation: "gen-1" });
    // The hub STAMPS each event with its position in the review's log (review finding 7),
    // so the client can merge the catch-up read with the push instead of one overwriting
    // the other. The seq is the hub's, not the caller's.
    expect(pushed).toEqual([
      { reviewId: "rev-9", event: { type: "report", reportBoardId: "b-1", seq: 0 } },
      { reviewId: "rev-9", event: { type: "composed", generation: "gen-1", seq: 1 } },
    ]);
  });

  it("the seq keeps climbing across rounds, so a finished round's events stay older", () => {
    const hub = new RoundProgressHub();
    hub.emit("rev-10", { type: "dispatched" });
    hub.emit("rev-10", { type: "composed", generation: "gen-1" });
    // A second dispatch CLEARS the log but not the counter: were it reset, round one's
    // terminal event would share a seq with round two's and could clobber it on merge.
    hub.emit("rev-10", { type: "dispatched" });
    expect(hub.read("rev-10").map((e) => e.seq)).toEqual([2]);
  });
});

describe("runRound emits the real regeneration progress (C15 3.1/3.3)", () => {
  let root: string;
  let boards: BoardsRuntime;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "c15-progress-"));
    boards = createBoardsRuntime(root);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function runtimeWith(outputFor: (lens: string) => unknown) {
    return createRoundsRuntime({
      resolveClaudePort: async () => fakeClaudePort(outputFor),
      resolveCodexExecutor: async () => null as CodexExecutor | null,
      boardsRuntimeFor: () => ({
        service: boards.service,
        createRennetBoard: boards.createRennetBoard,
      }),
      readPrompt,
    });
  }

  it("walks report → lens lanes → composed, with the generation the reveal lands on", async () => {
    const events: RoundEvent[] = [];
    const outcome = await runtimeWith(() => sectioned("same")).runRound({
      session,
      repoRoot: root,
      previousGeneration: mintGeneration("gen:ps-prior", "ps-prior"),
      asksDispatched: ["t-1"],
      runWorkers: async () => ({ commitRange: { from: "c0", to: "c1" }, patchsetId: "ps-landed" }),
      onProgress: (event) => events.push(event),
      ...collationFor(),
    });

    const types = events.map((e) => e.type);
    // The report announces FIRST (it gates the regeneration and IS the greeting), the
    // lens lanes stream beneath it, and the round terminates at `composed`.
    expect(types[0]).toBe("report");
    expect(types.at(-1)).toBe("composed");
    expect(types.filter((t) => t === "lens").length).toBeGreaterThan(0);
    // The composed event carries the generation the reveal opens — the real minted id.
    const composed = events.at(-1);
    expect(composed).toEqual({ type: "composed", generation: outcome.boardGeneration.id });
    expect(outcome.boardGeneration.id).toBe("gen:ps-landed");
    // Every lens has a lane in the final snapshot, and they all settle.
    const lastLens = [...events].reverse().find((e) => e.type === "lens");
    expect(lastLens?.type === "lens" && lastLens.lanes.map((l) => l.id)).toEqual([
      "design",
      "sequence",
      "decisions",
      "flagged",
      "noise",
    ]);
  });

  it("emits a TERMINAL failed event when the regeneration throws — never silence", async () => {
    const events: RoundEvent[] = [];
    await expect(
      runtimeWith(() => sectioned("same")).runRound({
        session: { ...session, id: "failing-session" } as SessionModel,
        repoRoot: root,
        previousGeneration: mintGeneration("gen:ps-prior", "ps-prior"),
        asksDispatched: [],
        runWorkers: async () => {
          throw new Error("the worker died");
        },
        onProgress: (event) => events.push(event),
        ...collationFor(),
      }),
    ).rejects.toThrow("the worker died");
    expect(events).toEqual([{ type: "failed", reason: "the worker died" }]);
  });

  // ── 3.3 — the carry-forward lane label, the control that can lie ──
  //
  // Lens `design` re-drafts with CHANGED section content; every other lens re-drafts
  // byte-identically. The prior generation's boards are handed in as `previous`, so
  // `stampDeltas` marks design's section `reworked` and leaves the others unstamped.
  // The lane labels must follow that same fact — and only that fact.
  it("a lens whose sections changed does NOT read 'carrying forward'", async () => {
    const events: RoundEvent[] = [];
    const previous = new Map<LintTarget, DraftBoard>(
      (["design", "sequence", "decisions", "flagged", "noise", "report"] as LintTarget[]).map(
        (lens) => [lens, sectioned("generation one")],
      ),
    );

    await runtimeWith((lens) =>
      // Only `design` moved this generation; the rest are byte-identical carries.
      sectioned(lens === "design" ? "generation two" : "generation one"),
    ).runRound({
      session: { ...session, id: "carry-session" } as SessionModel,
      repoRoot: root,
      previousGeneration: mintGeneration("gen:ps-prior", "ps-prior"),
      asksDispatched: [],
      runWorkers: async () => ({ commitRange: { from: "c0", to: "c1" }, patchsetId: "ps-carry" }),
      previous,
      onProgress: (event) => events.push(event),
      ...collationFor(),
    });

    const settled = [...events].reverse().find((e) => e.type === "lens");
    if (settled?.type !== "lens") throw new Error("no lens lanes were emitted");
    // THE LIE THIS GUARDS: design's sections changed, so its lane must read reworked.
    expect(verdictOf(settled.lanes, "design")).toBe("reworked");
    expect(verdictOf(settled.lanes, "design")).not.toBe("carrying-forward");
    // The untouched lenses carried — the same signal their section markers render.
    for (const lens of ["sequence", "decisions", "flagged", "noise"]) {
      expect(verdictOf(settled.lanes, lens)).toBe("carrying-forward");
    }

    // …and design never read "carrying forward" at ANY point in the stream, not just at
    // the end. A lane that settles before its verdict is known has to claim SOMETHING,
    // and whatever it claims is a guess the reviewer watches for the length of the round.
    const everyLane = events.flatMap((e) => (e.type === "lens" ? e.lanes : []));
    expect(everyLane.filter((l) => l.id === "design" && l.status === "done")).not.toHaveLength(0);
    for (const lane of everyLane) {
      if (lane.id === "design" && lane.status === "done") expect(lane.verdict).toBe("reworked");
    }
    // The window between a board landing and its arrival is `drafted` — the honest name
    // for "written, verdict not known yet", and the state that replaced the early settle.
    expect(everyLane.some((lane) => lane.status === "drafted")).toBe(true);
  });

  // ── A round whose drafters failed (review finding 4) ───────────────────────
  //
  // A failed regeneration used to end on `composed` — the reveal control appearing over
  // boards nobody wrote — and to file the PRE-MINTED (empty) report board id in the
  // ledger as if the report seat had written it.
  it("no seat resolves: terminal failed, and no report is recorded that was never written", async () => {
    const events: RoundEvent[] = [];
    const noSeats = createRoundsRuntime({
      // Neither harness is installed, so every drafter fails to resolve a seat.
      resolveClaudePort: async () => null,
      resolveCodexExecutor: async () => null as CodexExecutor | null,
      boardsRuntimeFor: () => ({
        service: boards.service,
        createRennetBoard: boards.createRennetBoard,
      }),
      readPrompt,
    });
    await expect(
      noSeats.runRound({
        session: { ...session, id: "no-seat-session" } as SessionModel,
        repoRoot: root,
        previousGeneration: mintGeneration("gen:ps-prior", "ps-prior"),
        asksDispatched: [],
        runWorkers: async () => ({
          commitRange: { from: "c0", to: "c1" },
          patchsetId: "ps-none",
        }),
        onProgress: (event) => events.push(event),
        ...collationFor(),
      }),
    ).rejects.toThrow("drafted no lens boards");

    // No real-generation record is filed for pre-minted empty boards or a report-only result.
    expect(noSeats.ledger("no-seat-session")).toEqual([]);
    // The round terminates as failed, never `composed` over a regeneration that is not there.
    const terminal = events.at(-1);
    expect(terminal?.type).toBe("failed");
    expect(events.some((e) => e.type === "composed")).toBe(false);
  });

  it("one drafter fails: its lane SETTLES as failed while the rest compose", async () => {
    const events: RoundEvent[] = [];
    // `design` emits an unparseable board; the others draft cleanly.
    await runtimeWith((lens) =>
      lens === "design"
        ? ({ elements: [{ id: "x", kind: "not-a-kind", data: {} }] } as unknown as DraftBoard)
        : sectioned("fine"),
    ).runRound({
      session: { ...session, id: "one-failed-session" } as SessionModel,
      repoRoot: root,
      previousGeneration: mintGeneration("gen:ps-prior", "ps-prior"),
      asksDispatched: [],
      runWorkers: async () => ({ commitRange: { from: "c0", to: "c1" }, patchsetId: "ps-partial" }),
      onProgress: (event) => events.push(event),
      ...collationFor(),
    });

    const settled = [...events].reverse().find((e) => e.type === "lens");
    if (settled?.type !== "lens") throw new Error("no lens lanes were emitted");
    const design = settled.lanes.find((lane) => lane.id === "design");
    // A lane left queued/running after the round is over reads as "still working".
    expect(design?.status).toBe("failed");
    // …and a failed lane STRUCTURALLY carries its reason (finding 8) — no empty detail.
    expect(design?.status === "failed" ? design.reason : "").not.toBe("");
    // Boards did land, so the round still composed — the failure is one lane's, not the round's.
    expect(events.at(-1)?.type).toBe("composed");
  });

  it("a grounded Design dismissal settles that lane as absent while the other lenses compose", async () => {
    const events: RoundEvent[] = [];
    const outcome = await runtimeWith((lens) =>
      lens === "design"
        ? {
            absence: "no-material",
            candidates: NO_MATERIAL_DESIGN_ARTIFACTS.candidates.map((candidate) => ({
              id: candidate.id,
              relevance: candidate.relevance.kind,
              reason: "This specification describes a different feature than the reviewed change.",
            })),
          }
        : sectioned("fine"),
    ).runRound({
      session: { ...session, id: "design-absent-session" } as SessionModel,
      repoRoot: root,
      previousGeneration: mintGeneration("gen:ps-prior", "ps-prior"),
      asksDispatched: [],
      runWorkers: async () => ({ commitRange: { from: "c0", to: "c1" }, patchsetId: "ps-no-spec" }),
      onProgress: (event) => events.push(event),
      designArtifacts: NO_MATERIAL_DESIGN_ARTIFACTS,
      ...collationFor(),
    });

    const settled = [...events].reverse().find((event) => event.type === "lens");
    if (settled?.type !== "lens") throw new Error("no lens lanes were emitted");
    const design = settled.lanes.find((lane) => lane.id === "design");
    expect(design).toEqual({
      id: "design",
      label: "Design",
      status: "absent",
      reason: "No Design specification applies to this change.",
    });
    const absentAt = events.findIndex(
      (event) =>
        event.type === "lens" &&
        event.lanes.some((lane) => lane.id === "design" && lane.status === "absent"),
    );
    const sequenceDoneAt = events.findIndex(
      (event) =>
        event.type === "lens" &&
        event.lanes.some((lane) => lane.id === "sequence" && lane.status === "done"),
    );
    expect(absentAt).toBeGreaterThanOrEqual(0);
    expect(absentAt).toBeLessThan(sequenceDoneAt);
    expect(outcome.boardGeneration.lensBoards).not.toHaveProperty("design");
    expect(Object.keys(outcome.boardGeneration.lensBoards)).toHaveLength(4);
    expect(outcome.boardGeneration.absentLenses).toEqual({ design: "no-material" });
    expect(events.at(-1)?.type).toBe("composed");
  });

  // ── The lineage the round ACTUALLY has (review finding 2) ──────────────────
  //
  // Above, `previous` is handed in by the test. In production it was handed in by NOBODY:
  // the trigger minted a synthetic predecessor and supplied no prior boards, so every
  // section stamped `new` and no lane could EVER read "carrying forward" — as dishonest as
  // a lane that lies that it did. This drives TWO real rounds through the real trigger over
  // the real durable stores, so the second round's comparison set is the first round's
  // actual boards.
  it("a second round carries forward against the FIRST round's real boards", async () => {
    const genStore = new GenerationStore(mkdtempSync(join(tmpdir(), "c15-gen-")));
    const metaStore = new BoardMetaStore(mkdtempSync(join(tmpdir(), "c15-meta-")));
    const lineageSession = { ...session, id: "lineage-session" } as SessionModel;

    // Every lens drafts "generation one" until `moved` names it — then that lens alone moves.
    let moved = "";
    const runtime = createRoundsRuntime({
      resolveClaudePort: async () =>
        fakeClaudePort((lens) => sectioned(lens === moved ? "generation two" : "generation one")),
      resolveCodexExecutor: async () => null as CodexExecutor | null,
      boardsRuntimeFor: () => ({
        service: boards.service,
        createRennetBoard: boards.createRennetBoard,
      }),
      readPrompt,
      persistBoardMeta: (_repo, meta) => metaStore.save(meta),
      persistGeneration: (gen) => genStore.save(gen),
      loadGeneration: (id) => genStore.load(id),
    });

    // A review that walks ps-1 → ps-2 → ps-3, one activation per round.
    const made = [patchsetAt("ps-1"), patchsetAt("ps-2"), patchsetAt("ps-3")];
    let activeIndex = 0;
    const events: RoundEvent[] = [];
    const outcomes: RoundOutcome[] = [];
    const round = (priorPatchsetId: string) =>
      runBoardRegeneration(
        {
          recapture: async () => {
            activeIndex += 1;
          },
          reviewNow: () =>
            ({
              id: "rev-lineage",
              repositoryRoot: root,
              activePatchsetId: made[activeIndex]?.id,
              patchsets: made.slice(0, activeIndex + 1),
              dispositions: [],
              status: "current",
              successorAccount: { asks: [], beyondAsks: [] },
            }) as unknown as Review,
          knowledgeFor: () => ({ set: KNOWLEDGE, snapshot: null }),
          priorGeneration: (id) =>
            readPriorGeneration(
              {
                loadGeneration: (genId) => genStore.load(genId),
                listBoardMeta: (sessionId, generation) =>
                  metaStore.listForGeneration(sessionId, generation),
                boardElements: async (boardId) => [
                  ...(await boards.service.getState(boardId)).values(),
                ],
              },
              lineageSession.id,
              id,
            ),
          runRound: async (input) => {
            const outcome = await runtime.runRound(input);
            outcomes.push(outcome);
            return outcome;
          },
          emit: (event) => events.push(event),
        },
        {
          session: lineageSession,
          repoRoot: root,
          priorPatchsetId,
          asksDispatched: [],
          worked: {
            commitRange: { from: "c0", to: "c0" },
            diff: "diff --git a/src/a.ts b/src/a.ts",
            changedPaths: ["src/a.ts"],
          },
        },
      );

    // Round one: no generation has ever been minted for this session, so it is honestly a
    // FIRST generation — no predecessor is invented for the ledger to drill into.
    await round("ps-1");
    expect(outcomes[0]?.record.frozenPredecessor).toBeUndefined();
    expect(outcomes[0]?.frozenPrevious).toBeUndefined();
    expect(outcomes[0]?.boardGeneration.id).toBe("gen:ps-2");

    // Round two: only `design` re-drafts differently.
    moved = "design";
    events.length = 0;
    await round("ps-2");

    // The predecessor is the generation round one really minted — not a synthesized id.
    expect(outcomes[1]?.record.frozenPredecessor).toBe("gen:ps-2");
    expect(outcomes[1]?.frozenPrevious?.status).toBe("frozen");

    const settled = [...events].reverse().find((e) => e.type === "lens");
    if (settled?.type !== "lens") throw new Error("no lens lanes were emitted");
    // THE HONESTY THIS PROVES: carry-forward genuinely OCCURS in the production shape. The
    // untouched lenses compare against round one's real boards and carry; design reworked.
    expect(verdictOf(settled.lanes, "design")).toBe("reworked");
    for (const lens of ["sequence", "decisions", "flagged", "noise"]) {
      expect(verdictOf(settled.lanes, lens)).toBe("carrying-forward");
    }
  });

  it("revisiting a content-addressed patchset mints a fresh live generation and chapter", async () => {
    const genStore = new GenerationStore(mkdtempSync(join(tmpdir(), "c15-revisit-gen-")));
    const metaStore = new BoardMetaStore(mkdtempSync(join(tmpdir(), "c15-revisit-meta-")));
    const revisitSession = {
      ...session,
      id: "revisit-session",
      reviewId: "rev-revisit",
    } as SessionModel;
    const visits = [patchsetAt("ps-0"), patchsetAt("ps-1"), patchsetAt("ps-0")];
    const firstAsk: ComposableAsk = {
      id: "ask-round-1",
      path: "src/a.ts",
      type: "request-change",
      instruction: "Apply the first correction.",
      context: "",
    };
    const secondAsk: ComposableAsk = {
      id: "ask-round-2",
      path: "src/a.ts",
      type: "request-change",
      instruction: "Restore the original implementation deliberately.",
      context: "",
    };
    const asks = [firstAsk, secondAsk] as const;
    const reportFor = (round: number): DraftBoard => {
      const ask = asks[round - 1];
      if (ask === undefined) throw new Error(`no ask fixture for round ${round}`);
      const parsed = parseDraft({
        elements: [
          {
            id: `outcome-${round}`,
            kind: "round_outcome",
            data: {
              author,
              status: "addressed",
              ask: { ref: ask.id, text: ask.instruction },
              note: `Verified round ${round}.`,
            },
          },
        ],
      });
      if (!parsed.ok) throw new Error(`report fixture invalid: ${JSON.stringify(parsed.issues)}`);
      return parsed.value;
    };

    let activeVisit = 0;
    let draftingRound = 0;
    const runtime = createRoundsRuntime({
      resolveClaudePort: async () =>
        fakeClaudePort((lens) =>
          lens === "report" ? reportFor(draftingRound) : sectioned(`${lens} visit ${activeVisit}`),
        ),
      resolveCodexExecutor: async () => null as CodexExecutor | null,
      boardsRuntimeFor: () => ({
        service: boards.service,
        createRennetBoard: boards.createRennetBoard,
      }),
      readPrompt,
      persistBoardMeta: (_repo, meta) => metaStore.save(meta),
      loadDraftedBoards: (_repo, sessionId, generation) =>
        metaStore.listForGeneration(sessionId, generation),
      persistGeneration: (generation) => genStore.save(generation),
      loadGeneration: (id) => genStore.load(id),
    });
    const outcomes: RoundOutcome[] = [];
    const regenerate = async (input: {
      readonly priorPatchsetId: string;
      readonly asksDispatched: readonly string[];
      readonly dispatchId?: string;
      readonly round?: {
        readonly number: number;
        readonly previousGeneration: string;
        readonly dispatchedAsks: readonly ComposableAsk[];
        readonly findingDispositions: Record<string, never>;
      };
      readonly changed: boolean;
    }): Promise<RoundOutcome> => {
      const before = outcomes.length;
      const ok = await runBoardRegeneration(
        {
          recapture: async () => {
            activeVisit += 1;
          },
          reviewNow: () =>
            ({
              id: "rev-revisit",
              repositoryRoot: root,
              activePatchsetId: visits[activeVisit]?.id,
              patchsets: visits.slice(0, activeVisit + 1),
              dispositions: [],
              status: "current",
              successorAccount: { asks: [], beyondAsks: [] },
            }) as unknown as Review,
          knowledgeFor: () => ({ set: KNOWLEDGE, snapshot: null }),
          priorGeneration: (id) =>
            readPriorGeneration(
              {
                loadGeneration: (generationId) => genStore.load(generationId),
                listBoardMeta: (sessionId, generation) =>
                  metaStore.listForGeneration(sessionId, generation),
                boardElements: async (boardId) => [
                  ...(await boards.service.getState(boardId)).values(),
                ],
              },
              revisitSession.id,
              id,
            ),
          runRound: async (roundInput) => {
            const outcome = await runtime.runRound(roundInput);
            outcomes.push(outcome);
            return outcome;
          },
          emit: () => undefined,
        },
        {
          session: revisitSession,
          repoRoot: root,
          priorPatchsetId: input.priorPatchsetId,
          asksDispatched: [...input.asksDispatched],
          ...(input.dispatchId === undefined ? {} : { dispatchId: input.dispatchId }),
          ...(input.round === undefined
            ? {}
            : {
                round: {
                  ...input.round,
                  previousGeneration: currentGenerationId(
                    runtime.ledger(revisitSession.id),
                    input.priorPatchsetId,
                  ),
                },
              }),
          worked: {
            commitRange: { from: "same-head", to: "same-head" },
            diff: input.changed ? "diff --git a/src/a.ts b/src/a.ts" : "",
            changedPaths: input.changed ? ["src/a.ts"] : [],
          },
        },
      );
      expect(ok).toBe(true);
      const outcome = outcomes[before];
      if (outcome === undefined) throw new Error("regeneration produced no outcome");
      return outcome;
    };
    const readDraft = async (boardId: string): Promise<DraftBoard> => {
      const parsed = parseDraft({
        elements: [...(await boards.service.getState(boardId)).values()],
      });
      if (!parsed.ok) throw new Error(`persisted board invalid: ${JSON.stringify(parsed.issues)}`);
      return parsed.value;
    };

    // Initial P0 is a live first visit, not a round and therefore has no report/chapter.
    const initial = await regenerate({
      priorPatchsetId: "ps-0",
      asksDispatched: [],
      changed: false,
    });
    expect(initial.boardGeneration.id).toBe("gen:ps-0");

    draftingRound = 1;
    const firstRound = await regenerate({
      priorPatchsetId: "ps-0",
      asksDispatched: [firstAsk.id],
      dispatchId: "dispatch-round-1",
      round: {
        number: 1,
        previousGeneration: initial.boardGeneration.id,
        dispatchedAsks: [firstAsk],
        findingDispositions: {},
      },
      changed: true,
    });
    const frozenFirstVisit = genStore.load(initial.boardGeneration.id);
    const frozenFirstSequenceId = frozenFirstVisit?.lensBoards.sequence;
    if (frozenFirstSequenceId === undefined)
      throw new Error("initial Sequence board was not frozen");
    const frozenFirstSequence = [
      ...(await boards.service.getState(frozenFirstSequenceId)).values(),
    ];

    draftingRound = 2;
    const secondRound = await regenerate({
      priorPatchsetId: "ps-1",
      asksDispatched: [secondAsk.id],
      dispatchId: "dispatch-round-2",
      round: {
        number: 2,
        previousGeneration: firstRound.boardGeneration.id,
        dispatchedAsks: [secondAsk],
        findingDispositions: {},
      },
      changed: true,
    });

    // P0 content returned, but this is a new visit: the old P0 generation stays frozen
    // byte-for-byte while the current P0 generation is distinct and live.
    expect(secondRound.boardGeneration.patchsetId).toBe("ps-0");
    expect(secondRound.boardGeneration.id).not.toBe(initial.boardGeneration.id);
    expect(secondRound.boardGeneration.status).toBe("live");
    expect(genStore.load(initial.boardGeneration.id)).toEqual(frozenFirstVisit);
    expect([...(await boards.service.getState(frozenFirstSequenceId)).values()]).toEqual(
      frozenFirstSequence,
    );
    expect(genStore.load(firstRound.boardGeneration.id)?.status).toBe("frozen");

    // The revisit drafted THIS round's report, then carried Round 1's host chapter and
    // appended Round 2 after it. Reusing P0's settled evidence fails both assertions.
    expect(secondRound.record.reportBoard).not.toBe(firstRound.record.reportBoard);
    const reportElements = (await readDraft(secondRound.record.reportBoard)).elements;
    expect(reportElements.find((element) => element.kind === "round_outcome")?.data.ask.ref).toBe(
      "ask-round-2",
    );
    const sequenceId = secondRound.boardGeneration.lensBoards.sequence;
    if (sequenceId === undefined) throw new Error("revisited Sequence board was not drafted");
    const sequenceElements = (await readDraft(sequenceId)).elements;
    expect(
      sequenceElements.flatMap((element) =>
        element.kind === "section" && element.data.title.startsWith("Round ")
          ? [element.data.title]
          : [],
      ),
    ).toEqual(["Round 1 · Addressed", "Round 2 · Addressed"]);
  });

  it("a FIRST generation carries nothing forward (no prior to carry from)", async () => {
    const events: RoundEvent[] = [];
    await runtimeWith(() => sectioned("only generation")).runRound({
      session: { ...session, id: "first-gen-session" } as SessionModel,
      repoRoot: root,
      previousGeneration: mintGeneration("gen:ps-prior", "ps-prior"),
      asksDispatched: [],
      runWorkers: async () => ({ commitRange: { from: "c0", to: "c1" }, patchsetId: "ps-first" }),
      // no `previous` ⇒ every section stamps `new`
      onProgress: (event) => events.push(event),
      ...collationFor(),
    });

    const settled = [...events].reverse().find((e) => e.type === "lens");
    if (settled?.type !== "lens") throw new Error("no lens lanes were emitted");
    for (const lane of settled.lanes) expect(verdictOf(settled.lanes, lane.id)).toBe("reworked");
  });
});
