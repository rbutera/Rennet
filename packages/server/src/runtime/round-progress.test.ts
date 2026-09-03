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
  Generation,
  LensLane,
  PatchFile,
  Patchset,
  Review,
  RoundEvent,
  RoundOperation,
  SessionModel,
} from "@rennet/protocol";
import {
  currentGenerationId,
  parseDraft,
  RoundOperationSchema,
  roundOperationProgressSnapshot,
  sha256Hex,
} from "@rennet/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type BoardsRuntime, createBoardsRuntime } from "../boards/boards-runtime";
import { seatThreadTitle } from "../t3/threads";
import {
  assembleRoundCollation,
  readPriorGeneration,
  runBoardRegeneration,
} from "./round-collation";
import { buildRoundEvidenceManifest } from "./round-evidence-manifest";
import { RoundProgressHub, roundEventsForDurableOperation } from "./round-progress";
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
const WORKER_DIFF = [
  "diff --git a/src/a.ts b/src/a.ts",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  PATCH,
].join("\n");

function failedOperationWithReportHandoff(): RoundOperation {
  const prompt = "Apply the requested change.";
  const report = {
    lens: "report" as const,
    generation: "generation-1",
    boardId: "report-board-1",
    document: {
      title: "Round report",
      introMarkdown: "The requested change landed.",
      measure: "reading" as const,
    },
    sections: [],
    elements: [],
    skippedHunks: [],
  };
  const reportAttempt = {
    executionId: "report-execution-1",
    reportBoardId: report.boardId,
    generation: report.generation,
    boardIds: {
      design: "design-board-1",
      sequence: "sequence-board-1",
      decisions: "decisions-board-1",
      flagged: "flagged-board-1",
      noise: "noise-board-1",
      report: report.boardId,
    },
    handoff: {
      operationId: "operation-1",
      operationRevision: 8,
      reportBoardId: report.boardId,
      generation: report.generation,
      report,
    },
    startedAt: 8,
  };
  const workspace = {
    kind: "detached-worktree" as const,
    worktreePath: "/worktree",
    sourceTreeOid: "tree-1",
    sourceParentHead: "head-1",
    sourceHead: "head-1",
    startedAt: 2,
    preparedAt: 3,
  };
  const worker = {
    executionId: "worker-1",
    startedAt: 3,
    completedAt: 4,
    outcome: "completed" as const,
    diff: WORKER_DIFF,
    changedPaths: ["src/a.ts"],
  };
  const commits = {
    executionId: "commits-1",
    baseHead: "head-1",
    startedAt: 5,
    from: "head-1",
    to: "head-2",
    count: 1,
    committedAt: 6,
  };
  return RoundOperationSchema.parse({
    operationId: "operation-1",
    sessionId: "session-1",
    reviewId: "review-1",
    dispatchId: "dispatch-1",
    sourcePatchsetId: "patchset-1",
    askOccurrences: [{ id: "ask-1", revision: 1 }],
    roundNumber: 1,
    sourceTarget: { kind: "branch", branch: "feat/round" },
    repoRoot: "/repo",
    workOrderPrompt: prompt,
    workOrderDigest: sha256Hex(prompt),
    gatePlan: { kind: "absent" },
    revision: 10,
    rerunRequested: true,
    createdAt: 1,
    updatedAt: 10,
    state: {
      phase: "failed",
      failure: {
        at: "report-drafting",
        reason: "core lens regeneration failed",
        failedAt: 10,
        workspace,
        worker,
        gate: { outcome: "skipped", reason: "not-configured", settledAt: 5 },
        commits,
        landing: {
          effect: "source-landing",
          executionId: "landing-1",
          baselineCommit: commits.from,
          workerHead: commits.to,
          startedAt: 6,
          outcome: "applied",
          landedAt: 7,
        },
        recording: {
          effect: "round-recording",
          executionId: "recording-1",
          startedAt: 7,
          recordedAt: 8,
        },
        report: reportAttempt,
      },
    },
  });
}

function draftingOperationWithReportHandoff(
  operation: RoundOperation,
  revision: number,
): RoundOperation {
  if (
    operation.state.phase !== "failed" ||
    (operation.state.failure.at !== "report-drafting" &&
      operation.state.failure.at !== "report-verifying")
  ) {
    throw new Error("expected a failed report fixture");
  }
  const failure = operation.state.failure;
  const handoff = failure.report.handoff;
  if (handoff === undefined) throw new Error("expected a durable report handoff");
  return RoundOperationSchema.parse({
    ...operation,
    revision,
    state: {
      phase: "report-drafting",
      workspace: failure.workspace,
      worker: failure.worker,
      gate: failure.gate,
      commits: failure.commits,
      landing: failure.landing,
      recording: failure.recording,
      report: failure.report,
    },
  });
}

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

/** A schema-valid board with one served root and lens-specific semantic material. Two
 *  boards built with the same body have an identical root subtree; a changed body reworks it. */
function sectioned(lens: string, body: string): DraftBoard {
  const material =
    lens === "sequence"
      ? [
          {
            id: "material",
            kind: "order_step",
            data: { author, title: "Read the changed assignment", span: "detail", children: [] },
          },
          { id: "detail", kind: "prose", data: { author, markdown: body } },
        ]
      : lens === "decisions"
        ? [
            {
              id: "material",
              kind: "decision",
              data: {
                author,
                statement: body,
                evidence: ["detail"],
                alternatives: ["alternative"],
                why: "The changed assignment is deliberate.",
              },
            },
            { id: "detail", kind: "prose", data: { author, markdown: body } },
            {
              id: "alternative",
              kind: "prose",
              data: { author, markdown: "Keep the prior assignment." },
            },
          ]
        : lens === "flagged"
          ? [
              {
                id: "material",
                kind: "finding",
                data: {
                  author,
                  severity: "medium",
                  concern: body,
                  code: [],
                  concurrence: [],
                  status: "open",
                },
              },
            ]
          : [{ id: "material", kind: "prose", data: { author, markdown: body } }];
  const parsed = parseDraft({
    elements: [
      {
        id: "s1",
        kind: "section",
        data: { author, title: `${lens} fixture`, children: ["material"] },
      },
      ...material,
    ],
  });
  if (!parsed.ok) throw new Error(`fixture not schema-valid: ${JSON.stringify(parsed.issues)}`);
  return parsed.value;
}

/**
 * A claude port that answers each DRAFTING turn with `outputFor(lens)`. The pipeline funnels
 * every drafted board through a post-process turn (`prompts/post-process.md`) on the same
 * seat; that turn must hand back the board in its own prompt. Reading that per-session
 * input keeps concurrent lens turns isolated instead of sharing one "last draft" slot.
 */
/** Which lens a rendered prompt belongs to; `post-process` echoes its layer context back. */
function boardAnswer(prompt: string, outputFor: (lens: string) => unknown): unknown {
  const lens = /PROMPT_FILE:prompts\/([a-z-]+)\.md/.exec(prompt)?.[1] ?? "unknown";
  if (lens === "post-process") {
    const context = /rennet:layer context>>>\n(\{.*)/s.exec(prompt);
    return context ? (JSON.parse(context[1] as string).board as unknown) : { elements: [] };
  }
  return outputFor(lens);
}

function fakeClaudePort(outputFor: (lens: string) => unknown): HarnessPort {
  const answer = (prompt: string): unknown => boardAnswer(prompt, outputFor);
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

  it("reconstructs a failed report handoff from the durable operation after a cold daemon start", () => {
    const operation = failedOperationWithReportHandoff();
    const queued = draftingOperationWithReportHandoff(operation, 9);
    const events = roundEventsForDurableOperation({
      operation,
      liveEvents: [
        { type: "operation", snapshot: roundOperationProgressSnapshot(queued), seq: 99 },
      ],
      reportHandoffIsReadable: () => true,
    });

    expect(events.map((event) => event.type)).toEqual(["operation", "operation", "report"]);
    expect(events[0]).toMatchObject({
      type: "operation",
      snapshot: { operationId: operation.operationId, revision: 8 },
    });
    expect(events[1]).toMatchObject({
      type: "operation",
      snapshot: {
        operationId: operation.operationId,
        revision: 10,
        state: { phase: "failed" },
      },
    });
    expect(events[2]).toMatchObject({
      type: "report",
      operationId: operation.operationId,
      operationRevision: 8,
      reportBoardId: "report-board-1",
      report: { boardId: "report-board-1", generation: "generation-1" },
    });
  });

  it("orders a same-revision recovered handoff directly after its durable operation", () => {
    const failed = failedOperationWithReportHandoff();
    const recovered = draftingOperationWithReportHandoff(failed, 9);
    if (recovered.state.phase !== "report-drafting") {
      throw new Error("expected recovered report drafting");
    }
    const handoff = recovered.state.report.handoff;
    if (handoff === undefined) throw new Error("expected recovered report handoff");
    const sameRevisionRecovery = RoundOperationSchema.parse({
      ...recovered,
      state: {
        ...recovered.state,
        report: {
          ...recovered.state.report,
          handoff: { ...handoff, operationRevision: recovered.revision },
        },
      },
    });

    const events = roundEventsForDurableOperation({
      operation: sameRevisionRecovery,
      liveEvents: [],
      reportHandoffIsReadable: () => true,
    });

    expect(events).toMatchObject([
      {
        type: "operation",
        snapshot: { operationId: recovered.operationId, revision: recovered.revision },
      },
      {
        type: "report",
        operationId: recovered.operationId,
        operationRevision: recovered.revision,
        reportBoardId: "report-board-1",
      },
    ]);
  });

  it("withholds a cold report whose persisted metadata no longer matches", () => {
    const operation = failedOperationWithReportHandoff();
    expect(
      roundEventsForDurableOperation({
        operation,
        liveEvents: [],
        reportHandoffIsReadable: () => false,
      }),
    ).toMatchObject([{ type: "operation", snapshot: { revision: operation.revision } }]);
  });

  it("withholds matching live report and lens progress when persisted metadata no longer matches", () => {
    const operation = failedOperationWithReportHandoff();
    if (operation.state.phase !== "failed" || operation.state.failure.at !== "report-drafting") {
      throw new Error("expected a failed report-drafting operation");
    }
    const handoff = operation.state.failure.report.handoff;
    if (handoff === undefined) throw new Error("expected a durable report handoff");
    const diagnostic = {
      type: "report-diagnostic",
      operationId: operation.operationId,
      operationRevision: handoff.operationRevision,
      milestone: { stage: "schema-parsed", elapsedMs: 17 },
      seq: 13,
    } satisfies RoundEvent;

    const events = roundEventsForDurableOperation({
      operation,
      liveEvents: [
        {
          type: "report",
          operationId: operation.operationId,
          operationRevision: handoff.operationRevision,
          reportBoardId: handoff.reportBoardId,
          report: handoff.report,
          seq: 11,
        },
        {
          type: "lens",
          operationId: operation.operationId,
          operationRevision: handoff.operationRevision,
          lanes: [{ id: "sequence", label: "Sequence", status: "running" }],
          seq: 12,
        },
        diagnostic,
      ],
      reportHandoffIsReadable: () => false,
    });

    expect(events).toEqual([
      { type: "operation", snapshot: roundOperationProgressSnapshot(operation) },
      diagnostic,
    ]);
  });

  it("does not replay scoped progress from another operation", () => {
    const operation = failedOperationWithReportHandoff();
    const events = roundEventsForDurableOperation({
      operation,
      liveEvents: [
        {
          type: "report",
          operationId: "other-operation",
          operationRevision: 8,
          reportBoardId: "other-report",
          report: {
            lens: "report",
            generation: "other-generation",
            boardId: "other-report",
            document: { title: "Other", introMarkdown: "Other", measure: "reading" },
            sections: [],
            elements: [],
            skippedHunks: [],
          },
        },
      ],
      reportHandoffIsReadable: () => true,
    });

    expect(JSON.stringify(events)).not.toContain("other-operation");
    expect(JSON.stringify(events)).not.toContain("other-report");
  });

  it("retains only the current operation's report diagnostics for console catch-up", () => {
    const operation = failedOperationWithReportHandoff();
    const milestone = {
      stage: "provider-settled" as const,
      outcome: "completed" as const,
      elapsedMs: 23,
    };
    const events = roundEventsForDurableOperation({
      operation,
      liveEvents: [
        {
          type: "report-diagnostic",
          operationId: operation.operationId,
          operationRevision: 8,
          milestone,
          seq: 4,
        },
        {
          type: "report-diagnostic",
          operationId: "other-operation",
          operationRevision: 8,
          milestone,
          seq: 5,
        },
      ],
      reportHandoffIsReadable: () => true,
    });

    expect(events.filter((event) => event.type === "report-diagnostic")).toEqual([
      {
        type: "report-diagnostic",
        operationId: operation.operationId,
        operationRevision: 8,
        milestone,
        seq: 4,
      },
    ]);
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
    const outcome = await runtimeWith((lens) => sectioned(lens, "same")).runRound({
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

  it("starts all independent lanes at kickoff when no report gates the run", async () => {
    // THE BUG: the lanes' first drafter was promoted ONLY by the round report's arrival.
    // The INITIAL drafting path has no round and drafts no report, so nothing promoted it
    // — Design read "queued" for its whole run while it was the one lens working, and the
    // surface only caught up when Design's own draft landed and it jumped to "drafted".
    //
    // No successor account and no round ⇒ no report (`draftsRoundReport`), which is what
    // makes this the initial-drafting shape rather than a copy of the round test above.
    const events: RoundEvent[] = [];
    await runtimeWith((lens) => sectioned(lens, "same")).runRound({
      session: { ...session, id: "initial-draft-session" } as SessionModel,
      repoRoot: root,
      asksDispatched: [],
      runWorkers: async () => ({ commitRange: { from: "c0", to: "c1" }, patchsetId: "ps-landed" }),
      onProgress: (event) => events.push(event),
      ...assembleRoundCollation({ patchset: patchset(), dossier: [] }),
    });

    // No report announced — the premise, asserted rather than assumed.
    expect(events.some((e) => e.type === "report")).toBe(false);

    // The FIRST lens frame is the kickoff one, and every independent lane is running.
    // Asserting the first frame (not "some frame ever") is load-bearing: later drafted
    // frames cannot prove the scheduler represented concurrent work while it was live.
    const first = events.find((e) => e.type === "lens");
    if (first?.type !== "lens") throw new Error("no lens lanes were emitted");
    expect(first.lanes.map((lane) => [lane.id, lane.status])).toEqual([
      ["design", "running"],
      ["sequence", "running"],
      ["decisions", "running"],
      ["flagged", "running"],
      ["noise", "running"],
    ]);
    // ...and it arrives before any board has landed: nothing is drafted yet in that frame.
    expect(first.lanes.some((lane) => lane.status === "drafted")).toBe(false);
  });

  it("fails before any lens starts when the required report is invalid", async () => {
    const events: RoundEvent[] = [];
    await expect(
      runtimeWith((lens) =>
        lens === "report"
          ? ({ elements: [{ id: "x", kind: "not-a-kind", data: {} }] } as unknown as DraftBoard)
          : sectioned(lens, "fine"),
      ).runRound({
        session: { ...session, id: "report-failed-session" } as SessionModel,
        repoRoot: root,
        previousGeneration: mintGeneration("gen:ps-prior", "ps-prior"),
        asksDispatched: ["t-1"],
        round: {
          number: 1,
          previousGeneration: "gen:ps-prior",
          dispatchedAsks: [
            {
              id: "t-1",
              path: "src/a.ts",
              type: "request-change",
              instruction: "Replace the second line.",
              context: "",
            },
          ],
          findingDispositions: {},
          worker: {
            outcome: "completed",
            diff: WORKER_DIFF,
            changedPaths: ["src/a.ts"],
            commitRange: { from: "c0", to: "c1" },
          },
        },
        runWorkers: async () => ({
          commitRange: { from: "c0", to: "c1" },
          patchsetId: "ps-noreport",
        }),
        onProgress: (event) => events.push(event),
        ...collationFor(),
      }),
    ).rejects.toThrow("classification output was invalid");

    expect(events.some((e) => e.type === "report")).toBe(false);
    expect(events.some((e) => e.type === "lens")).toBe(false);
    expect(events.at(-1)).toMatchObject({
      type: "failed",
      reason: expect.stringContaining("classification output was invalid"),
    });
  });

  it("emits a TERMINAL failed event when the regeneration throws — never silence", async () => {
    const events: RoundEvent[] = [];
    await expect(
      runtimeWith((lens) => sectioned(lens, "same")).runRound({
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
    const baseline = await runtimeWith((lens) => sectioned(lens, "generation one")).runRound({
      session: { ...session, id: "carry-baseline-session" } as SessionModel,
      repoRoot: root,
      previousGeneration: mintGeneration("gen:ps-baseline-prior", "ps-baseline-prior"),
      asksDispatched: [],
      runWorkers: async () => ({
        commitRange: { from: "c0", to: "c1" },
        patchsetId: "ps-baseline",
      }),
      ...collationFor(),
    });
    const previous = new Map<LintTarget, DraftBoard>();
    for (const outcome of [...baseline.pipeline.boards, baseline.pipeline.report]) {
      if (outcome?.board !== undefined) previous.set(outcome.lens, outcome.board);
    }
    expect([...previous.keys()].sort()).toEqual(
      (["design", "sequence", "decisions", "flagged", "noise", "report"] as LintTarget[]).sort(),
    );

    await runtimeWith((lens) =>
      // Only `design` moved this generation; the rest are byte-identical carries.
      sectioned(lens, lens === "design" ? "generation two" : "generation one"),
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

  // ── A round whose required report seat cannot resolve (review finding 4) ──
  //
  // A failed regeneration used to continue into all five lens turns and end on `composed`
  // over boards nobody wrote. The required report now fails before lens fanout.
  it("no seat resolves: terminal failed, and no report is recorded that was never written", async () => {
    const events: RoundEvent[] = [];
    const persisted: Generation[] = [];
    const noSeats = createRoundsRuntime({
      // Neither harness is installed, so the required report cannot resolve a seat.
      resolveClaudePort: async () => null,
      resolveCodexExecutor: async () => null as CodexExecutor | null,
      boardsRuntimeFor: () => ({
        service: boards.service,
        createRennetBoard: boards.createRennetBoard,
      }),
      readPrompt,
      persistGeneration: (generation) => {
        persisted.push(generation);
      },
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
    ).rejects.toThrow("round-report resolved to claude-code, which is unavailable");

    // No real-generation record is filed for pre-minted empty boards or a report-only result.
    // The reserved ids remain as the durable identity of this failed attempt; reservation is
    // not evidence that a report or lens board was written.
    expect(noSeats.ledger("no-seat-session")).toEqual([]);
    const failedGeneration = persisted.at(-1);
    expect(Object.keys(failedGeneration?.draftingBoardIds ?? {})).toHaveLength(5);
    expect(failedGeneration?.draftingReportBoardId).toEqual(expect.any(String));
    expect(failedGeneration?.lensBoards).toEqual({});
    expect(failedGeneration?.failedLenses).toBeUndefined();
    expect(events.some((event) => event.type === "lens")).toBe(false);
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
        : sectioned(lens, "fine"),
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
        : sectioned(lens, "fine"),
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
    expect(sequenceDoneAt).toBeGreaterThanOrEqual(0);
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
        fakeClaudePort((lens) =>
          sectioned(lens, lens === moved ? "generation two" : "generation one"),
        ),
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
          snapshotFor: () => ({ snapshot: null }),
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
            diff: WORKER_DIFF,
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
    const reportFor = (round: number): unknown => {
      const ask = asks[round - 1];
      if (ask === undefined) throw new Error(`no ask fixture for round ${round}`);
      return {
        outcomes: [
          {
            askId: ask.id,
            status: "addressed",
            note: `Verified round ${round}.`,
            evidenceIds: buildRoundEvidenceManifest(WORKER_DIFF).map((unit) => unit.id),
          },
        ],
        beyond: [],
      };
    };

    let activeVisit = 0;
    let draftingRound = 0;
    const runtime = createRoundsRuntime({
      resolveClaudePort: async () =>
        fakeClaudePort((lens) =>
          lens === "report"
            ? reportFor(draftingRound)
            : sectioned(lens, `${lens} visit ${activeVisit}`),
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
          snapshotFor: () => ({ snapshot: null }),
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
            diff: input.changed ? WORKER_DIFF : "",
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
    await runtimeWith((lens) => sectioned(lens, "only generation")).runRound({
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

// ─────────────────────────────────────────────────────────────────────────────
// T3 is a board seat's ONLY backend (review finding 1). The daemon used to turn a sidecar
// that would not start into `null` and hand the board jobs back to the ephemeral
// Claude/Codex legs — which drafts the boards, but without the thread, the transcript, the
// live line or the same-thread repair, and says nothing about losing any of them. The lane
// now fails with the sidecar's own reason, which the bench already speaks.
// ─────────────────────────────────────────────────────────────────────────────
describe("a board seat has one backend (review finding 1)", () => {
  let root: string;
  let boards: BoardsRuntime;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "t3-only-backend-"));
    boards = createBoardsRuntime(root);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  /** The ephemeral Claude leg, counting every session a board seat would have opened. */
  function countingClaudePort(opened: string[]): HarnessPort {
    const inner = fakeClaudePort((lens) => sectioned(lens, "same"));
    return {
      ...inner,
      createSession: (spec: Parameters<HarnessPort["createSession"]>[0]) => {
        opened.push("createSession");
        return inner.createSession(spec);
      },
    } as unknown as HarnessPort;
  }

  const runWith = async (
    opened: string[],
    resolveT3Seats?: Parameters<typeof createRoundsRuntime>[0]["resolveT3Seats"],
    claimBranch?: string,
  ): Promise<{ events: RoundEvent[]; error: unknown }> => {
    const events: RoundEvent[] = [];
    let error: unknown;
    const run = createRoundsRuntime({
      resolveClaudePort: async () => countingClaudePort(opened),
      resolveCodexExecutor: async () => null as CodexExecutor | null,
      boardsRuntimeFor: () => ({
        service: boards.service,
        createRennetBoard: boards.createRennetBoard,
      }),
      readPrompt,
      ...(resolveT3Seats === undefined ? {} : { resolveT3Seats }),
    }).runRound({
      session: {
        ...session,
        id: "t3-backend-session",
        ...(claimBranch === undefined ? {} : { claim: { branch: claimBranch } }),
      } as SessionModel,
      repoRoot: root,
      asksDispatched: [],
      runWorkers: async () => ({ commitRange: { from: "c0", to: "c1" }, patchsetId: "ps-landed" }),
      onProgress: (event) => events.push(event),
      ...assembleRoundCollation({ patchset: patchset(), dossier: [] }),
    });
    await run.catch((thrown: unknown) => {
      error = thrown;
    });
    return { events, error };
  };

  const settledLanes = (events: readonly RoundEvent[]): readonly LensLane[] => {
    const last = [...events].reverse().find((event) => event.type === "lens");
    if (last?.type !== "lens") throw new Error("no lens lanes were emitted");
    return last.lanes;
  };

  it("fails every lane with the sidecar's reason and opens no ephemeral board session", async () => {
    const opened: string[] = [];
    const { events, error } = await runWith(opened, () =>
      Promise.reject(new Error("the vendored T3 Code server bundle is not built")),
    );

    // The load-bearing half: the ephemeral leg was RESOLVED (the port is real and the
    // council still routes to it), and no board seat ever asked it for a session.
    expect(opened).toEqual([]);
    // A generation with no boards at all is a failed round, and it says why.
    expect(String(error)).toContain("T3 sidecar unavailable");
    const lanes = settledLanes(events);
    expect(lanes.map((lane) => lane.id)).toEqual([
      "design",
      "sequence",
      "decisions",
      "flagged",
      "noise",
    ]);
    for (const lane of lanes) {
      expect(lane.status).toBe("failed");
      expect(lane.status === "failed" ? lane.reason : "").toContain(
        "T3 sidecar unavailable: the vendored T3 Code server bundle is not built",
      );
    }
  });

  it("positive control: the same run with no sidecar composed at all still drafts", async () => {
    // No `resolveT3Seats` dep is the direct-call shape every pipeline test uses — nobody
    // composed a sidecar, so nothing was lost and the ephemeral legs still run. If the
    // assertions above passed for some other reason (a broken fixture, a run that drafts
    // nothing at all), this run would open no session and settle no lane either.
    const opened: string[] = [];
    const { events, error } = await runWith(opened);
    expect(error).toBeUndefined();
    expect(opened.length).toBeGreaterThan(0);
    for (const lane of settledLanes(events)) expect(lane.status).not.toBe("failed");
  });

  // Review finding 6. A seat thread is titled by the branch it is READING, and the sidecar's
  // own thread list is how a reviewer finds one. The delta packet's repository projection
  // carries `baseRef` alone — the ref the change is MEASURED AGAINST — so every thread of
  // every review used to read "origin/main — Design".
  it("names the claimed branch to the seat runtime, not the ref the change is measured against", async () => {
    const branches: (string | undefined)[] = [];
    // The premise, asserted rather than assumed: the claim and the base ref DIFFER on this
    // fixture, so a reader cannot pass by picking either one.
    expect(patchset().repository.baseRef).toBe("origin/main");

    await runWith(
      [],
      async (input) => {
        branches.push(input.branch);
        return { unavailable: "no sidecar in this test" };
      },
      "feat/lens-threads",
    );

    expect(branches).toEqual(["feat/lens-threads"]);
    expect(seatThreadTitle(branches[0] ?? "", "design")).toBe("feat/lens-threads — Design");
  });

  // Review finding 7. The daemon holds one subscription per running seat to feed its lane's
  // live line. It used to be dropped only in the GENERATION's `finally`, so the first lens
  // to finish kept a socket and a one-second idle tick alive for as long as the slowest one
  // ran — publishing into a lane that no longer shows a line.
  it("drops a seat's subscription when ITS lane settles, not when the generation does", async () => {
    const stopped: string[] = [];
    const watched: string[] = [];
    // Frames as the reviewer sees them, each paired with what was already closed at the
    // moment it was published. ORDER is the assertion: "was stopped eventually" would be
    // satisfied by the old generation-wide teardown too.
    const frames: { lanes: readonly LensLane[]; closed: readonly string[] }[] = [];

    // Seats that settle at DIFFERENT times, so a lane really does finish while the others
    // are still running. Same-time settlement could not tell per-lane teardown from the
    // generation-wide one this replaces.
    const SETTLE_DELAY_MS: Readonly<Record<string, number>> = {
      design: 0,
      sequence: 40,
      decisions: 80,
      "flagged-claude": 120,
      noise: 160,
    };
    const promptFor = new Map<string, string>();
    const seatOf = (threadId: string): string => threadId.replace(/^thread-/, "");
    const t3Client = {
      startTurn: async ({ threadId, text }: { threadId: string; text: string }) => {
        promptFor.set(threadId, text);
        return "turn-1";
      },
      waitForTurnSettled: async (threadId: string) => {
        const delay = SETTLE_DELAY_MS[seatOf(threadId)] ?? 0;
        await new Promise((resolve) => setTimeout(resolve, delay));
        return {
          state: "completed",
          structuredOutput: boardAnswer(promptFor.get(threadId) ?? "", (lens) =>
            sectioned(lens, "same"),
          ),
          thread: {},
        };
      },
    };

    const events = await (async () => {
      const collected: RoundEvent[] = [];
      const run = createRoundsRuntime({
        resolveClaudePort: async () => countingClaudePort([]),
        resolveCodexExecutor: async () => null as CodexExecutor | null,
        boardsRuntimeFor: () => ({
          service: boards.service,
          createRennetBoard: boards.createRennetBoard,
        }),
        readPrompt,
        resolveT3Seats: async () => ({
          environmentId: "env-1",
          seam: {
            client: async () => t3Client,
            threadFor: async ({ seat }: { seat: string }) => ({
              threadId: `thread-${seat}`,
              projectId: "p1",
            }),
          },
          watch: (threadId: string) => {
            watched.push(threadId);
            return {
              stop: () => {
                if (!stopped.includes(threadId)) stopped.push(threadId);
              },
            };
          },
        }),
      } as unknown as Parameters<typeof createRoundsRuntime>[0]).runRound({
        session: { ...session, id: "seat-watch-session" } as SessionModel,
        repoRoot: root,
        asksDispatched: [],
        runWorkers: async () => ({
          commitRange: { from: "c0", to: "c1" },
          patchsetId: "ps-landed",
        }),
        onProgress: (event) => {
          collected.push(event);
          if (event.type === "lens") frames.push({ lanes: event.lanes, closed: [...stopped] });
        },
        ...assembleRoundCollation({ patchset: patchset(), dossier: [] }),
      });
      await run.catch(() => undefined);
      return collected;
    })();

    expect(events.some((event) => event.type === "lens")).toBe(true);
    // Every seat opened a watch — otherwise "they were all closed" is vacuous.
    expect(watched.sort()).toContain("thread-design");

    // The load-bearing frame: the FIRST one that shows Design settled must already show
    // Design's watch closed, AND at least one other lane still running — which is what
    // separates per-lane teardown from the generation-wide `finally` it replaces.
    const designSettled = frames.find((candidate) =>
      candidate.lanes.some(
        (lane) => lane.id === "design" && lane.status !== "queued" && lane.status !== "running",
      ),
    );
    expect(designSettled, "Design never settled in any published frame").toBeDefined();
    expect(
      designSettled?.lanes.some((lane) => lane.id !== "design" && lane.status === "running"),
      "no other lane was still running when Design settled — the stagger did not hold",
    ).toBe(true);
    expect(designSettled?.closed, "Design was still watched when its lane settled").toContain(
      "thread-design",
    );

    // And every seat's subscription is closed by the end, flagged's second provider too.
    expect(stopped).toEqual(expect.arrayContaining(watched));
  });

  it("falls back to the base ref when the session claimed no branch", async () => {
    // A no-target session claims nothing, so there is no branch to name; the base ref is
    // honest rather than an invented title. Without this the fallback could be anything.
    const branches: (string | undefined)[] = [];
    await runWith([], async (input) => {
      branches.push(input.branch);
      return { unavailable: "no sidecar in this test" };
    });
    expect(branches).toEqual(["origin/main"]);
  });
});
