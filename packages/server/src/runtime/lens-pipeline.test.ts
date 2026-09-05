import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createMetricsCollector,
  sanitizeSchemaForCodex,
  type T3SeatSeam,
  WhiteboardClient,
} from "@rennet/adapters";
import {
  type BoardVoiceWriter,
  type DeltaPacket,
  HOST_COMPOSER_AUTHOR_ID,
  inlineContextViolation,
  type LintContext,
  type LintTarget,
} from "@rennet/core";
import {
  INVESTIGATE_PARTIAL_FILE,
  LENS_PROMPT_FILES,
  PROMPT_PARTIAL_MARKER,
} from "@rennet/prompts";
import {
  AUTHORED_BOARD_SCHEMA,
  type BoardTarget,
  boardToolsByName,
  type CouncilHarnessId,
  type DraftBoard,
  findingRefKey,
  type GenerationPhaseTiming,
  type LensKind,
  lensAdmitsAbsence,
  ROUND_EVIDENCE_MANIFEST_MAX_BYTES,
  ROUND_REPORT_MAX_BEYOND_ENTRIES,
  type RoundReportDiagnosticMilestone,
} from "@rennet/protocol";
import { afterAll, describe, expect, it } from "vitest";
import type { GenerationBoards } from "../board/board-mcp-server";
import { seatBoardServer } from "../board/seat-address";
import {
  applySeatTurn,
  closeFixtureBoardServer,
  fixtureGenerationBoards,
  idOf,
  okCall,
  replayBoard,
  seatVoiceOn,
} from "../board/seat-fixture";
import { createBoardsRuntime } from "../boards/boards-runtime";
import type { SessionContextFile } from "../context-files";
import { SEAT_BOARD_TARGET, SEAT_BOARD_VOICE, type SeatKind } from "../t3/threads";

afterAll(closeFixtureBoardServer);

import {
  admitBoardReferences,
  aggregateFailureAccount,
  type BoardArrivalEvent,
  type BoardMeta,
  boardOutputSchema,
  composeReviewDraft,
  createNodePromptReader,
  draftToOps,
  LENS_RETRY_BUDGET,
  type LensPipelineDeps,
  lensRetryBudget,
  REPAIR_TARGET_KINDS,
  ROUND_CONTEXT_FILE,
  ROUND_EVIDENCE_FILE,
  reconcileFlaggedVoices,
  renderDrafterPrompt,
  renderRepairPrompt,
  renderRoundReportClassifierPrompt,
  roundContextFile,
  roundEvidenceFile,
  runLensPipeline,
  stampSingleSeatConcurrence,
  stampVoiceConcurrence,
} from "./lens-pipeline";
import { buildRoundEvidenceManifest } from "./round-evidence-manifest";

// ── Round-report classifier fixtures (#727) ────────────────────────────────────

/** The manifest ids the host mints for a fixture diff. Classification fixtures cite
 *  these exactly as a live classifier does — the ids are content-derived, so a fixture
 *  cannot hard-code one and drift from the diff beside it. */
const manifestIds = (diff: string): string[] =>
  buildRoundEvidenceManifest(diff).map((unit) => unit.id);

/** One changed line in `src/auth.ts` — one manifest entry. */
const ONE_LINE_DIFF = [
  "diff --git a/src/auth.ts b/src/auth.ts",
  "--- a/src/auth.ts",
  "+++ b/src/auth.ts",
  "@@ -1 +1 @@",
  "-old line",
  "+new line",
].join("\n");
const [ONE_LINE_EVIDENCE] = manifestIds(ONE_LINE_DIFF);

/** One beyond-ask entry past the declared cardinality limit. Every entry cites the one
 *  manifest id (the schema requires at least one), which would ALSO trip the partition —
 *  the cap is checked first, on purpose, so a cap failure is never reported as something
 *  else and never becomes a second classifier turn. */
const OVER_CAP_BEYOND_CLASSIFICATION = {
  outcomes: [
    {
      askId: "ask-one",
      status: "untouched",
      note: "The turn changed something, but not this ask.",
    },
  ],
  beyond: Array.from({ length: ROUND_REPORT_MAX_BEYOND_ENTRIES + 1 }, (_unused, index) => ({
    ref: `beyond:${index}`,
    text: "An unrequested change.",
    note: "The turn changed something no ask asked for.",
    evidenceIds: [ONE_LINE_EVIDENCE as string],
  })),
} as const;

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
const mkSection = (
  id: string,
  title: string,
  children: string[],
  author = flaggedAuthor,
): DraftBoard["elements"][number] => ({
  id,
  kind: "section",
  data: { author, title, children },
});
const mkBoard = (elements: DraftBoard["elements"]): DraftBoard =>
  ({ elements }) as unknown as DraftBoard;
/**
 * Find an element by something the SEAT wrote, never by a fixture id.
 *
 * Ids are host-minted since `lens-board-tools` 3.2, so a fixture's own id names nothing on
 * the board that comes back. Every assertion that used to address an element by id now
 * addresses it by the field the seat actually authored, which is also the thing the
 * assertion was really about.
 */
const elementWhere = (
  board: DraftBoard | undefined,
  kind: string,
  field: string,
  value: unknown,
): DraftBoard["elements"][number] | undefined =>
  board?.elements.find(
    (element) =>
      element.kind === kind && (element.data as Record<string, unknown>)[field] === value,
  );

const concurrenceOf = (board: DraftBoard, id: string): { model: string; agree: number }[] =>
  (
    board.elements.find((e) => e.id === id)?.data as {
      concurrence?: { model: string; agree: number }[];
    }
  )?.concurrence ?? [];
/** The wire's agreement-kind stamp — undefined on a board that carries none. */
const accordOn = (board: DraftBoard, id: string): string | undefined =>
  (board.elements.find((e) => e.id === id)?.data as { accord?: string } | undefined)?.accord;

// ── Fixtures ──────────────────────────────────────────────────────────────────

/** A minimal DeltaPacket — the pipeline inlines it into every prompt; content is opaque here. */
const PACKET = {
  patchset: { id: "ps-1", createdAt: "", truncated: false, files: [] },
  hunks: { hunks: [], byId: new Map() },
} as unknown as DeltaPacket;

/**
 * The per-lens lint context: no files keep the shared fixtures citation-free.
 *
 * ONE changed region, on a path no fixture cites. It is load-bearing rather than
 * decoration: the Noise board is the complement of the other four (D16), so a context with
 * NO changed regions makes every complement trivially empty and settles every fixture's
 * Noise lane `no-noise` before its seat is ever dispatched. A fixture that cannot hold a
 * remainder cannot see the Noise lane run at all.
 */
const UNCITED_REGION = { path: "src/uncited.ts", side: "head" as const, start: 1, end: 4 };

const lintContextFor = (lens: LintTarget): LintContext => ({
  lens,
  regions: [UNCITED_REGION],
  files: new Map(),
  // The capture the host stamps on every citation before persistence. Load-bearing since
  // the seats write with tools: the Noise members the HOST places are `code_ref`s like any
  // other, and a board whose citations carry no patchset id is refused at the write
  // boundary as citing a reference it cannot prove.
  patchsetId: PACKET.patchset.id,
});

const meaningfulSequenceBody = (): DraftBoard => ({
  elements: [
    {
      id: "sequence-root",
      kind: "section",
      data: {
        author: { kind: "lens-agent", id: "sequence-seat" },
        title: "Reading order",
        children: ["sequence-step"],
      },
    },
    {
      id: "sequence-step",
      kind: "order_step",
      data: {
        author: { kind: "lens-agent", id: "sequence-seat" },
        title: "Read the entry point",
        span: "sequence-span",
        children: [],
      },
    },
    {
      id: "sequence-span",
      kind: "prose",
      data: {
        author: { kind: "lens-agent", id: "sequence-seat" },
        markdown: "The entry point starts the read.",
      },
    },
  ],
});

const meaningfulDecisionBody = (): DraftBoard => ({
  elements: [
    {
      id: "decisions-root",
      kind: "section",
      data: {
        author: { kind: "lens-agent", id: "decisions-seat" },
        title: "Implementation decisions",
        children: ["decision"],
      },
    },
    {
      id: "decision-evidence",
      kind: "prose",
      data: {
        author: { kind: "lens-agent", id: "decisions-seat" },
        markdown: "The write path commits one complete batch.",
      },
    },
    {
      id: "decision-alternative",
      kind: "prose",
      data: {
        author: { kind: "lens-agent", id: "decisions-seat" },
        markdown: "Write each event independently.",
      },
    },
    {
      id: "decision",
      kind: "decision",
      data: {
        author: { kind: "lens-agent", id: "decisions-seat" },
        statement: "Commit the event batch atomically.",
        evidence: ["decision-evidence"],
        alternatives: ["decision-alternative"],
        why: "Readers never observe a partial batch.",
      },
    },
  ],
});

const withoutRootSections = (board: DraftBoard): DraftBoard => ({
  ...board,
  elements: board.elements.filter((element) => element.kind !== "section"),
});

// DELETED: `hideRootSectionFromProjection`. It built a board whose root section sat under a
// PROSE element, so the served projection could not reach the root — a shape the tool
// surface refuses at the call (`a parent is a section or a step`), and so one no seat can
// write. Its one caller was the "hidden decision root" row of the malformed-lens table,
// which went with it.

const meaningfulFlaggedBody = (): DraftBoard => ({
  elements: [
    {
      id: "flagged-root",
      kind: "section",
      data: {
        author: flaggedAuthor,
        title: "Findings",
        children: ["flagged-finding"],
      },
    },
    {
      id: "flagged-finding",
      kind: "finding",
      data: {
        author: flaggedAuthor,
        severity: "medium",
        concern: "A partial write leaves the event batch inconsistent.",
        code: [],
        concurrence: [],
        status: "open",
      },
    },
  ],
});

const proseOnlyBody = (lens: string, markdown = "This change reads cleanly."): DraftBoard => ({
  elements: [
    {
      id: `${lens}-p1`,
      kind: "prose",
      data: {
        author: { kind: "lens-agent", id: `${lens}-seat` },
        markdown,
      },
    },
  ],
});

/** A semantically populated board for load-bearing lanes, ordinary prose elsewhere. */
const cleanBody = (lens: string): DraftBoard => {
  if (lens === "sequence") return meaningfulSequenceBody();
  if (lens === "decisions") return meaningfulDecisionBody();
  if (lens === "flagged") return meaningfulFlaggedBody();
  return proseOnlyBody(lens);
};

const DESIGN_SOURCE = "openspec/changes/token-refresh/specs/auth/spec.md";
const DESIGN_HUNKS = [
  {
    id: "spec-hunk",
    path: DESIGN_SOURCE,
    header: "@@ -1 +1 @@",
    body: [
      "-The system SHALL keep the current token.",
      "+The system SHALL refresh the token before classifying an error.",
    ],
    spans: { old: { start: 1, lines: 1 }, new: { start: 1, lines: 1 } },
    lossy: false,
  },
  {
    id: "impl-hunk",
    path: "src/auth.ts",
    header: "@@ -10,2 +10,4 @@",
    body: ["+await refreshToken();", "+return retryRequest();"],
    spans: { old: { start: 10, lines: 2 }, new: { start: 10, lines: 4 } },
    lossy: false,
  },
  {
    id: "test-hunk",
    path: "src/auth.test.ts",
    header: "@@ -20,0 +20,3 @@",
    body: ["+it('refreshes before retrying', async () => {});"],
    spans: { old: { start: 20, lines: 0 }, new: { start: 20, lines: 3 } },
    lossy: false,
  },
] as const;

const DESIGN_PACKET = {
  ...PACKET,
  hunks: { hunks: DESIGN_HUNKS, byId: new Map(DESIGN_HUNKS.map((hunk) => [hunk.id, hunk])) },
} as unknown as DeltaPacket;

const designBody = (): DraftBoard =>
  ({
    document: {
      title: "token-refresh",
      introMarkdown: "Why the refresh order changes.",
      measure: "structured",
      sources: [{ path: DESIGN_SOURCE, candidate: "candidate-1", label: "auth spec", line: 1 }],
      stats: [
        { label: "Format", value: "OpenSpec" },
        { label: "Requirements", value: "1" },
        { label: "Capabilities", value: "1 new / 0 modified" },
      ],
    },
    elements: [
      {
        id: "auth-section",
        kind: "section",
        data: {
          author: { kind: "lens-agent", id: "design-seat" },
          title: "Auth",
          children: ["auth-added-requirements"],
          sources: [{ path: DESIGN_SOURCE, candidate: "candidate-1", line: 1 }],
          spec_delta: "added",
        },
      },
      {
        id: "auth-added-requirements",
        kind: "section",
        data: {
          author: { kind: "lens-agent", id: "design-seat" },
          title: "ADDED Requirements",
          children: ["requirement-refresh"],
          spec_delta: "added",
        },
      },
      {
        id: "scenario-expired",
        kind: "prose",
        data: {
          author: { kind: "lens-agent", id: "design-seat" },
          markdown:
            "Scenario: Expired token\n\nWHEN a request uses an expired token\nTHEN the client refreshes it before retrying.",
          scenario_clauses: {
            condition: "a request uses an expired token",
            response: "the client refreshes it before retrying.",
          },
        },
      },
      {
        id: "requirement-refresh",
        kind: "requirement",
        data: {
          author: { kind: "lens-agent", id: "design-seat" },
          name: "Refresh before retry",
          capability: "auth",
          shall: "The system SHALL refresh the token before classifying an error.",
          scenarios: ["scenario-expired"],
          related_files: ["src/auth.ts", "src/auth.test.ts"],
          source: { path: DESIGN_SOURCE, candidate: "candidate-1", line: 3 },
          spec_delta: "added",
          trace: ["auth-trace-ref"],
        },
      },
      {
        id: "auth-trace-ref",
        kind: "code_ref",
        data: {
          author: { kind: "lens-agent", id: "design-seat" },
          patchset_id: "ps-1",
          path: "src/auth.ts",
          side: "head",
          start_line: 10,
          end_line: 13,
        },
      },
    ],
  }) as unknown as DraftBoard;

/** The shared partial's stand-in body: what the production splice must put in the prompt. */
const PARTIAL_BODY = "PARTIAL_BODY:investigate-before-you-draft";

/**
 * readPrompt returns a per-file marker so the fake body can recover which lens/seat it is.
 * Lens files carry the real partial marker line, so the production expansion path
 * (`expandPromptPartials` in `runLensPipeline`) is exercised, not bypassed (#739 review).
 */
const readPrompt = (file: string): string =>
  file === INVESTIGATE_PARTIAL_FILE
    ? PARTIAL_BODY
    : Object.values(LENS_PROMPT_FILES).includes(file)
      ? `PROMPT_FILE:${file}\n${PROMPT_PARTIAL_MARKER}`
      : `PROMPT_FILE:${file}`;

/**
 * Recover the lens from the marker the fake prompt carries (design.md → design, report.md
 * → report), falling back to the SEAT LABEL of the session the turn opened on.
 *
 * The fallback is not a convenience: a repair turn carries pointers and frozen ids and
 * nothing else (session-bound-workspace 3.2), so there is no prompt file in it to read.
 * `board.lens-draft.design` → `design`; the Flagged lane's two provider seats
 * (`flagged-claude`, `flagged-codex`) both answer for `flagged`.
 */
function lensFromPrompt(prompt: string, label?: string): string {
  const match = /PROMPT_FILE:prompts\/([a-z-]+)\.md/.exec(prompt);
  if (match?.[1] !== undefined) return match[1];
  const seat = label?.split(".").at(-1);
  if (seat === undefined) return "unknown";
  return seat.startsWith("flagged") ? "flagged" : seat;
}

/** One turn a seat ran on its thread, as the fake sidecar saw it. */
interface SeatCapture {
  /** The seat the thread belongs to — `design`, `flagged-codex`, `round-report`. */
  readonly seat: string;
  /** The thread this turn ran on. A repair must be a further turn on the SAME one. */
  readonly threadId: string;
  /** Whichever provider the council routed this seat to, in T3's own vocabulary. */
  readonly provider: "claudeAgent" | "codex";
  readonly model: string;
  readonly effort: string;
  /**
   * The turn's structured-output contract. `undefined` on every LENS seat since 3.2 — a
   * seat that writes its board through tools carries none, and the assertion that none
   * travels reads this field.
   */
  readonly outputSchema: unknown;
  readonly prompt: string;
}

// ── Driving a seat's board through the REAL tool surface ─────────────────────

/**
 * A fake T3 sidecar seam: one persistent thread per seat, every attempt a turn on it.
 *
 * Since session-bound-workspace 5.7 this is the ONLY backend a board seat has, so it is
 * what every pipeline test drives. It is also where a REPAIR lives: a repair turn carries
 * the last `finish` verdict and nothing else, which only means anything to a session that
 * already holds the base prompt AND to a board that survived the turn — so only a thread
 * over a live lane can answer one.
 *
 * The seat is the attribution, exactly as it is in production: the seam is handed
 * `{ seat, provider, model, effort }` and never sees the label the collector logs.
 */
function fakeT3Seam(
  captures: SeatCapture[],
  script: (prompt: string, seat: string) => unknown,
  boards: GenerationBoards | undefined,
): T3SeatSeam {
  const opened = new Map<string, Omit<SeatCapture, "prompt" | "outputSchema">>();
  const pending = new Map<string, unknown>();
  const client = {
    startTurn: async ({
      threadId,
      text,
      outputSchema,
    }: {
      threadId: string;
      text: string;
      outputSchema?: unknown;
    }) => {
      const thread = opened.get(threadId);
      if (thread === undefined) throw new Error(`fake sidecar: no thread ${threadId}`);
      captures.push({ ...thread, prompt: text, outputSchema });
      const seat = thread.seat as SeatKind;
      const voice = seatVoiceOn(boards, seat);
      // Awaited here, where the sidecar's own dispatch blocks: a fixture that gates a seat
      // on a barrier gates the TURN, not the settlement read.
      const written = await script(text, thread.seat);
      if (voice === undefined) {
        // No lane ⇒ the round-report seat, whose legacy leg still returns a document.
        pending.set(threadId, written);
      } else {
        await applySeatTurn(written, seat, voice);
        pending.delete(threadId);
      }
      return { previousTurnId: null, requestedAt: new Date().toISOString() };
    },
    waitForTurnSettled: async (threadId: string) => ({
      turnId: `${threadId}:turn`,
      state: "completed" as const,
      structuredOutput: pending.get(threadId),
      thread: { messages: [], session: null },
    }),
    interruptTurn: async () => undefined,
  };
  return {
    client: async () => client,
    threadFor: async ({
      seat,
      provider,
      model,
      effort,
    }: {
      seat: string;
      provider: "claudeAgent" | "codex";
      model: string;
      effort: string;
    }) => {
      const threadId = `thread-${seat}`;
      opened.set(threadId, { threadId, seat, provider, model, effort });
      // The seat's address onto its lane's board, exactly as `resolveT3SeatRuntime` mints
      // it. Registering it is what lets the lane answer per-seat questions about this seat
      // — its board tool-call count among them (task 4.3) — so a double that skipped it
      // left that figure absent for a reason production does not have.
      const boardServer = seatBoardServer(boards, seat);
      return {
        threadId,
        projectId: "p1",
        ...(boardServer === undefined ? {} : { boardServer }),
      };
    },
  } as unknown as T3SeatSeam;
}

/**
 * The board-seat half of a pipeline's deps: the fake sidecar every board job runs on, the
 * council's installed-harness answer, and THIS GENERATION'S BOARD LANES.
 *
 * The lanes are the real ones — `startBoardMcpServer`'s own `BoardWriter` per target,
 * reached through `generationBoards` exactly as `create-server.ts` reaches them. A seat
 * writes into that writer through the real tool surface, so a fixture that a boundary rule
 * refuses is refused here too. Only the transport is skipped: `board-mcp-server.test.ts`
 * owns the HTTP half.
 */
function boardSeats(
  captures: SeatCapture[],
  script: (prompt: string, seat: string) => unknown,
  installed: readonly CouncilHarnessId[] = ["claude-code"],
): Pick<LensPipelineDeps, "t3" | "council" | "boards"> {
  const boards = fixtureGenerationBoards();
  return {
    t3: fakeT3Seam(captures, script, boards),
    council: { availability: { installed } },
    boards,
  };
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

/**
 * The reveal assertion (#725 D4). `revealAfterEachRelease[n]` is what the reveal had
 * published once the (n+1)-th lane in `releaseOrder` finished writing its board. A
 * progressive reveal shows exactly the lanes released so far; a global all-lanes barrier
 * shows nothing until the last one, which is the shape this throws on by name.
 *
 * Kept as a function rather than inline expectations so the control below can feed it a
 * barriered stream and prove it rejects one — an assertion that cannot tell the two shapes
 * apart would pass over a restored barrier.
 */
function assertProgressiveReveal(
  revealAfterEachRelease: readonly (readonly LensKind[])[],
  releaseOrder: readonly LensKind[],
): void {
  for (const [index, revealed] of revealAfterEachRelease.entries()) {
    if (revealed.length === 0 && index < releaseOrder.length - 1) {
      throw new Error(
        `the reveal revealed nothing until lane ${index + 2} of ${releaseOrder.length} settled — a global barrier is holding settled boards`,
      );
    }
    const expected = releaseOrder.slice(0, index + 1);
    if (revealed.join(",") !== expected.join(",")) {
      throw new Error(
        `after releasing ${expected.join(", ")} the reveal held ${revealed.join(", ") || "nothing"}`,
      );
    }
  }
}

/**
 * The timing assertion (#725 7.4): the `report` phase record must cover the report turn
 * and NOTHING else. A record whose span swallows the lens lanes that ran after it is the
 * exact defect the durable per-phase timings exist to make impossible — one label
 * absorbing another phase's time.
 *
 * The property asserted is exactly "no lens time sits under the report label": the report
 * span and every lens span must not OVERLAP, which for phases that run in this order is
 * `reportEnd <= lensStart`. Two earlier readings of this both got it wrong and in opposite
 * directions — comparing the lens's END to the report's end missed a report that ends
 * PARTWAY through a lane (the lane finishes later, so the check passed while real lens
 * time sat under the report label), and a strict `<` on the boundary would fail an honest
 * zero-duration lens starting the instant the report ended. Touching is not overlapping.
 *
 * A function, not inline expectations, so the controls below can feed it a mislabeled
 * stream and prove it rejects one.
 */
function assertReportLabelExcludesLensTime(timings: readonly GenerationPhaseTiming[]): void {
  // EVERY report record, not the first: a regression that adds a second, wider `report`
  // span beside an honest one is the same lie, and a `find` would read past it.
  for (const report of timings.filter(({ phase }) => phase === "report")) {
    const reportEnds = report.startedAtMs + report.durationMs;
    // …and EVERY lens phase, not the first: one absorbed lane is the defect regardless of
    // how many honest ones sit beside it.
    for (const timing of timings) {
      if (!timing.phase.startsWith("lens-")) continue;
      if (reportEnds > timing.startedAtMs) {
        throw new Error(
          `the report label absorbed ${timing.phase}${timing.lens === undefined ? "" : ` (${timing.lens})`}: the report record runs to ${reportEnds}, past that lens phase's start at ${timing.startedAtMs}`,
        );
      }
    }
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

function decisionStringCollisionBody(): DraftBoard {
  const author = { kind: "lens-agent" as const, id: "decisions-seat" };
  return {
    elements: [
      {
        id: "code",
        kind: "code_ref",
        data: {
          author,
          patchset_id: "ps-1",
          path: "src/a.ts",
          side: "head",
          start_line: 1,
          end_line: 2,
        },
      },
      {
        id: "alternative",
        kind: "prose",
        data: { author, markdown: "decision" },
      },
      {
        id: "decision",
        kind: "decision",
        data: {
          author,
          statement: "Keep the decision explicit.",
          evidence: ["code"],
          alternatives: ["alternative"],
          why: "The schema references determine persistence order.",
        },
      },
    ],
  } as unknown as DraftBoard;
}

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

  it("ignores ordinary strings when ordering schema-declared references", () => {
    expect(draftToOps(decisionStringCollisionBody()).map(({ element }) => element.id)).toEqual([
      "code",
      "alternative",
      "decision",
    ]);
  });
});

describe("admitBoardReferences — the write-boundary ref admission (#548 D1)", () => {
  /**
   * The production `bad-ref` shape, as the smoke run observed it: a Sequence step whose
   * `span` names an element id the board does not contain. The step is real material the
   * seat produced — the whole point of D1 is that it must NOT be dropped to get the rest
   * of the board accepted.
   */
  const sequenceFixture = (span: string, codeRefId = "sequence-code"): DraftBoard =>
    mkBoard([
      {
        id: "sequence-step",
        kind: "order_step",
        data: {
          author: { kind: "lens-agent", id: "sequence-seat" },
          title: "Read the entry point",
          span,
          children: [],
        },
      } as unknown as DraftBoard["elements"][number],
      mkCodeRef(codeRefId, "src/auth.ts", 11, 12),
      mkSection("sequence-root", "Reading order", ["sequence-step"], {
        kind: "lens-agent",
        id: "sequence-seat",
      }),
    ]);

  it("repairs a reference whose unique intended target is provable, and records it", () => {
    const admitted = admitBoardReferences(sequenceFixture("sequence_code"), "ps-1");
    expect(admitted.unrepairable).toEqual([]);
    expect(admitted.repairs).toEqual([
      { elementId: "sequence-step", field: "span", from: "sequence_code", to: "sequence-code" },
    ]);
    // The REWRITTEN board is what gets written — assert the exact field, not merely that
    // some repair was reported.
    const step = admitted.board.elements.find(({ id }) => id === "sequence-step");
    expect((step?.data as { span?: string } | undefined)?.span).toBe("sequence-code");
    // The rest of the board is untouched; nothing was dropped to make it acceptable.
    expect(admitted.board.elements.map(({ id }) => id)).toEqual(
      sequenceFixture("sequence_code").elements.map(({ id }) => id),
    );
  });

  it("refuses a reference with no candidate rather than dropping the element", () => {
    const board = sequenceFixture("missing-sequence-code");
    const admitted = admitBoardReferences(board, "ps-1");
    expect(admitted.repairs).toEqual([]);
    expect(admitted.unrepairable).toEqual([
      { elementId: "sequence-step", field: "span", targetId: "missing-sequence-code" },
    ]);
    // Refusal leaves the board ALONE — the citing element is still there for the retry.
    expect(admitted.board).toBe(board);
  });

  it("refuses an AMBIGUOUS reference: two candidates are not proof of either", () => {
    const board = mkBoard([
      ...sequenceFixture("sequence_code").elements,
      mkCodeRef("sequenceCode", "src/other.ts", 3, 4),
    ]);
    const admitted = admitBoardReferences(board, "ps-1");
    expect(admitted.repairs).toEqual([]);
    expect(admitted.unrepairable.map(({ targetId }) => targetId)).toEqual(["sequence_code"]);
  });

  it("refuses a code_ref candidate that cites a DIFFERENT patchset", () => {
    // Same identity, but the only candidate points outside the captured patchset this
    // generation is reading — so it is not a provable target for this board.
    const admitted = admitBoardReferences(sequenceFixture("sequence_code"), "ps-other");
    expect(admitted.repairs).toEqual([]);
    expect(admitted.unrepairable.map(({ targetId }) => targetId)).toEqual(["sequence_code"]);
  });

  it("repairs an element reference inside a MANY field without disturbing its siblings", () => {
    const board = mkBoard([
      mkFinding("f1", "cites both", ["c1", "C_2"]),
      mkCodeRef("c1", "src/a.ts", 1, 2),
      mkCodeRef("c-2", "src/b.ts", 3, 4),
    ]);
    const admitted = admitBoardReferences(board, "ps-1");
    expect(admitted.unrepairable).toEqual([]);
    const finding = admitted.board.elements.find(({ id }) => id === "f1");
    // Order preserved, only the dangling entry rewritten.
    expect((finding?.data as { code?: string[] } | undefined)?.code).toEqual(["c1", "c-2"]);
  });

  it("leaves an admissible board byte-identical (no repair, no copy)", () => {
    const board = sequenceFixture("sequence-code");
    const admitted = admitBoardReferences(board, "ps-1");
    expect(admitted.repairs).toEqual([]);
    expect(admitted.unrepairable).toEqual([]);
    expect(admitted.board).toBe(board);
  });

  it("the REAL board service accepts the repaired write and rejects the bypassed one", async () => {
    const root = await mkdtemp(join(tmpdir(), "lens-ref-admission-"));
    try {
      const runtime = createBoardsRuntime(root);
      const client = new WhiteboardClient(runtime.service);
      const fixture = sequenceFixture("sequence_code");

      // POSITIVE CONTROL — bypass the admission pass and write the fixture as the seat
      // authored it. The board service is authoritative and still rejects: `bad-ref`.
      const bypassed = await client.apply(
        await runtime.createRennetBoard(),
        draftToOps(fixture) as never,
        "lens:sequence",
      );
      expect(bypassed.response).toMatchObject({ ok: false, code: "bad-ref" });

      // The same fixture through the admission pass is admitted, with the step intact.
      const repairedBoardId = await runtime.createRennetBoard();
      const admitted = admitBoardReferences(fixture, "ps-1");
      const accepted = await client.apply(
        repairedBoardId,
        draftToOps(admitted.board) as never,
        "lens:sequence",
      );
      expect(accepted.response).toMatchObject({ ok: true });
      const state = await runtime.service.getState(repairedBoardId);
      expect(state.has("sequence-step")).toBe(true);
      expect(state.has("sequence-code")).toBe(true);

      // And the UNREPAIRABLE fixture is refused BEFORE the write — the refusal is not
      // gratuitous: writing it raw is rejected by the service exactly as the bypass was.
      const unrepairable = sequenceFixture("missing-sequence-code");
      expect(admitBoardReferences(unrepairable, "ps-1").unrepairable).toHaveLength(1);
      const rejected = await client.apply(
        await runtime.createRennetBoard(),
        draftToOps(unrepairable) as never,
        "lens:sequence",
      );
      expect(rejected.response).toMatchObject({ ok: false, code: "bad-ref" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses to repair a reference onto its OWN element (a self-citation is not a target)", () => {
    // The production shape: a section whose `children` names a variant of the SECTION's
    // own id. Folding, the only candidate is the citer itself — and a repair to it writes
    // an element that cites itself, which the board service rejects. The pass would then
    // have manufactured the very `bad-ref` it exists to prevent.
    const board = mkBoard([
      mkSection("sequence-root", "Reading order", ["Sequence_Root"]),
      mkCodeRef("sequence-code", "src/auth.ts", 11, 12),
    ]);
    const admitted = admitBoardReferences(board, "ps-1");
    expect(admitted.repairs).toEqual([]);
    expect(admitted.unrepairable).toEqual([
      { elementId: "sequence-root", field: "children", targetId: "Sequence_Root" },
    ]);
    expect(admitted.board).toBe(board);
  });

  it("refuses an EXACT id whose code_ref cites another patchset (the id is not a licence)", () => {
    // The bypass this closes: the repair path already refuses a foreign-patchset candidate,
    // so a drafter that spelled the id right got what a drafter that mistyped it could not.
    const foreign = {
      ...mkCodeRef("sequence-code", "src/auth.ts", 11, 12),
      data: {
        author: { kind: "lens-agent", id: "sequence-seat" },
        patchset_id: "ps-other",
        path: "src/auth.ts",
        side: "head",
        start_line: 11,
        end_line: 12,
      },
    } as DraftBoard["elements"][number];
    const board = mkBoard([
      {
        id: "sequence-step",
        kind: "order_step",
        data: {
          author: { kind: "lens-agent", id: "sequence-seat" },
          title: "Read the entry point",
          span: "sequence-code",
          children: [],
        },
      } as unknown as DraftBoard["elements"][number],
      foreign,
    ]);
    const admitted = admitBoardReferences(board, "ps-1");
    expect(admitted.repairs).toEqual([]);
    expect(admitted.unrepairable).toEqual([
      { elementId: "sequence-step", field: "span", targetId: "sequence-code" },
    ]);
    // Control, same board and same spelling: when the code_ref is THIS patchset's, the
    // exact reference is admitted untouched — the refusal is about the patchset, not the id.
    expect(admitBoardReferences(board, "ps-other").unrepairable).toEqual([]);
  });

  it("keeps a carried round chapter's own generation anchor (host history is about it)", () => {
    // A prior round's addressed chapter is host-authored and cites the patchset that round
    // reviewed. It rides into every later board verbatim, so judging it against the current
    // patchset would cost every round after the first its Sequence board.
    const hostAuthor = { kind: "orchestrator" as const, id: "rennet:round-composition" };
    const carried = "rennet:host:round-addressed:1:0:code-ref";
    const board = mkBoard([
      {
        id: carried,
        kind: "code_ref",
        data: {
          author: hostAuthor,
          patchset_id: "ps-0",
          path: "src/auth.ts",
          side: "head",
          start_line: 11,
          end_line: 12,
        },
      } as unknown as DraftBoard["elements"][number],
      {
        id: "rennet:host:round-addressed:1:0:annotation",
        kind: "annotation",
        data: { author: hostAuthor, code_ref: carried, body: "Addressed in round 1." },
      } as unknown as DraftBoard["elements"][number],
    ]);
    const admitted = admitBoardReferences(board, "ps-1");
    expect(admitted.unrepairable).toEqual([]);
    expect(admitted.repairs).toEqual([]);
    // Control: the same foreign-patchset code_ref authored by a LENS SEAT is refused —
    // the exemption is the orchestrator's carried history, not "any old patchset id".
    const drafted = mkBoard([
      {
        ...board.elements[0],
        data: { ...(board.elements[0]?.data as object), author: flaggedAuthor },
      } as DraftBoard["elements"][number],
      board.elements[1] as DraftBoard["elements"][number],
    ]);
    expect(admitBoardReferences(drafted, "ps-1").unrepairable).toHaveLength(1);

    // …and the author KIND alone does not buy the exemption. A seat can type
    // `{kind: "orchestrator"}` into its own output; only the host composer's own id, or an
    // element the host minted into its round-history namespace, is host-composed history.
    const forgedAuthor = mkBoard([
      {
        ...board.elements[0],
        id: "seat-invented-code-ref",
        data: {
          ...(board.elements[0]?.data as object),
          author: { kind: "orchestrator", id: "sequence-seat" },
        },
      } as DraftBoard["elements"][number],
      {
        id: "seat-invented-annotation",
        kind: "annotation",
        data: {
          author: { kind: "orchestrator", id: "sequence-seat" },
          code_ref: "seat-invented-code-ref",
          body: "Cites another patchset.",
        },
      } as unknown as DraftBoard["elements"][number],
    ]);
    expect(admitBoardReferences(forgedAuthor, "ps-1").unrepairable).toHaveLength(1);

    // The other half of the namespace clause: an element the HOST minted keeps the
    // exemption even under an author id this predicate does not enumerate.
    const hostNamespaced = mkBoard([
      {
        ...board.elements[0],
        data: {
          ...(board.elements[0]?.data as object),
          author: { kind: "orchestrator", id: "rennet:some-later-host-writer" },
        },
      } as DraftBoard["elements"][number],
      board.elements[1] as DraftBoard["elements"][number],
    ]);
    expect(admitBoardReferences(hostNamespaced, "ps-1").unrepairable).toEqual([]);
  });

  it("never folds two ids apart by a LETTER, ASCII or not", () => {
    // The fold used to strip every non-`[a-z0-9]` character, which deleted the letters
    // themselves: `authé` and `authø` both became `auth`, so a board holding both offered
    // a "unique" candidate for a reference meaning either.
    // The discriminating shape is a FALSE UNIQUE: one dangling `authé`, one candidate
    // `authø`, and a fold that deletes both accented letters makes the second the sole
    // "provable" target of the first. They differ in a letter; neither is proof of the
    // other, so this settles as unrepairable and the lane retries.
    const falseUnique = mkBoard([
      mkFinding("f1", "cites an id this board does not hold", ["authé"]),
      mkCodeRef("authø", "src/authø.ts", 3, 4),
    ]);
    expect(admitBoardReferences(falseUnique, "ps-1").repairs).toEqual([]);
    expect(admitBoardReferences(falseUnique, "ps-1").unrepairable).toEqual([
      { elementId: "f1", field: "code", targetId: "authé" },
    ]);

    // Two accented ids that differ in a letter also stay two elements when BOTH are on the
    // board and one is cited exactly — the citation resolves to the id it names.
    const both = mkBoard([
      mkFinding("f1", "cites the accented anchor", ["authé"]),
      mkCodeRef("authé", "src/authé.ts", 1, 2),
      mkCodeRef("authø", "src/authø.ts", 3, 4),
    ]);
    expect(admitBoardReferences(both, "ps-1")).toMatchObject({ repairs: [], unrepairable: [] });

    // The other direction of the control: case and the separator set still fold, including
    // on a non-ASCII id, so the fix narrowed the fold without disabling it.
    const foldable = mkBoard([
      mkFinding("f1", "cites the same anchor, typed differently", ["Auth_É.ref"]),
      mkCodeRef("auth-éref", "src/authé.ts", 1, 2),
    ]);
    expect(admitBoardReferences(foldable, "ps-1").repairs).toEqual([
      { elementId: "f1", field: "code", from: "Auth_É.ref", to: "auth-éref" },
    ]);
  });

  it("refuses a sole folded candidate of the WRONG KIND for the field", () => {
    // `order_step.span` is declared to hold a code_ref. A prose element that folds to the
    // step's dangling span is a different element, not the code the step spans.
    const board = mkBoard([
      {
        id: "sequence-step",
        kind: "order_step",
        data: {
          author: { kind: "lens-agent", id: "sequence-seat" },
          title: "Read the entry point",
          span: "sequence_span",
          children: [],
        },
      } as unknown as DraftBoard["elements"][number],
      {
        id: "sequence-span",
        kind: "prose",
        data: { author: { kind: "lens-agent", id: "sequence-seat" }, markdown: "The entry point." },
      } as unknown as DraftBoard["elements"][number],
    ]);
    const admitted = admitBoardReferences(board, "ps-1");
    expect(admitted.repairs).toEqual([]);
    expect(admitted.unrepairable).toEqual([
      { elementId: "sequence-step", field: "span", targetId: "sequence_span" },
    ]);

    // Control: the same shape with the candidate as the declared kind repairs — the
    // refusal above is about the kind and not about the fold failing.
    const withCodeRef = mkBoard([
      board.elements[0] as DraftBoard["elements"][number],
      mkCodeRef("sequence-span", "src/auth.ts", 11, 12),
    ]);
    expect(admitBoardReferences(withCodeRef, "ps-1").repairs).toEqual([
      { elementId: "sequence-step", field: "span", from: "sequence_span", to: "sequence-span" },
    ]);

    // A field the schema declares WITHOUT a target kind (`section.children`) still repairs
    // onto any kind: nothing about its target's kind is provable, so nothing is enforced.
    const children = mkBoard([
      mkSection("sequence-root", "Reading order", ["sequence_span"]),
      {
        id: "sequence-span",
        kind: "prose",
        data: { author: { kind: "lens-agent", id: "sequence-seat" }, markdown: "The entry point." },
      } as unknown as DraftBoard["elements"][number],
    ]);
    expect(admitBoardReferences(children, "ps-1").repairs).toHaveLength(1);
  });

  it("declares a target kind for every reference field the board schema says holds one", () => {
    // The drift guard on the explicit map: the schema's own attribute descriptions name
    // `code_ref` for exactly the fields that hold one, so a new such field (or a renamed
    // one) fails here rather than silently repairing across kinds.
    const declared = Object.entries(AUTHORED_BOARD_SCHEMA).flatMap(([kind, definition]) =>
      Object.entries(definition.attributes).flatMap(([field, attribute]) =>
        attribute.type === "element" && attribute.description.includes("code_ref")
          ? [`${kind}.${field}`]
          : [],
      ),
    );
    expect(declared.length).toBeGreaterThan(0);
    expect(Object.keys(REPAIR_TARGET_KINDS).sort()).toEqual(declared.sort());
    for (const field of declared) expect(REPAIR_TARGET_KINDS[field]).toBe("code_ref");
  });

  it("deduplicates a `many` field whose entries repair onto the same element", () => {
    // Two spellings of one id are one citation. Left as written, the finding lists the
    // same code twice and the reader is shown a duplicate anchor.
    const board = mkBoard([
      mkFinding("f1", "cites one anchor, spelled twice", ["auth-code", "Auth_Code"]),
      mkCodeRef("auth-code", "src/auth.ts", 1, 2),
    ]);
    const admitted = admitBoardReferences(board, "ps-1");
    expect(admitted.unrepairable).toEqual([]);
    const finding = admitted.board.elements.find(({ id }) => id === "f1");
    expect((finding?.data as { code?: string[] } | undefined)?.code).toEqual(["auth-code"]);
  });
});

describe("boardOutputSchema — the legacy round-report leg's contract, and nothing else's", () => {
  it("derives a JSON schema from the frozen DraftBoardSchema (never hand-authored)", () => {
    const schema = boardOutputSchema() as Record<string, unknown>;
    expect(schema).toBeTypeOf("object");
    const encoded = JSON.stringify(schema);
    expect(encoded).toContain('"document"');
    expect(encoded).toContain('"introMarkdown"');
    expect(encoded).toContain('"structured"');
    // Memoized — the same object every call.
    expect(boardOutputSchema()).toBe(schema);
  });
});

describe("Codex board output-schema compatibility", () => {
  it("projects the real board schema into the supported provider subset", () => {
    const schema = sanitizeSchemaForCodex(boardOutputSchema()) as Record<string, unknown>;
    expect(schema.type).toBe("object");
    expect(schema.anyOf).toBeUndefined();

    const unsupported: string[] = [];
    const walk = (node: unknown, path: string): void => {
      if (Array.isArray(node)) {
        node.forEach((value, index) => {
          walk(value, `${path}[${index}]`);
        });
        return;
      }
      if (node === null || typeof node !== "object") return;
      const record = node as Record<string, unknown>;
      if (record.oneOf !== undefined) unsupported.push(`${path}.oneOf`);
      for (const [key, value] of Object.entries(record)) walk(value, `${path}.${key}`);
    };
    walk(schema, "$");
    expect(unsupported).toEqual([]);
  });
});

describe("aggregateFailureAccount — one lens account from many seats (#549)", () => {
  const terminal = (attempt: number) => ({ attempt, classification: "terminal" as const });
  const retryable = (attempt: number) => ({ attempt, classification: "retryable" as const });

  it("is RETRYABLE when any seat is: the lens needs only one seat to draw a board", () => {
    expect(
      aggregateFailureAccount([
        { failure: "seat A", failureAccount: terminal(3) },
        { failure: "seat B", failureAccount: retryable(1) },
      ]),
    ).toEqual(retryable(1));
  });

  it("is TERMINAL only when every seat is, and reports the deepest spent attempt", () => {
    expect(
      aggregateFailureAccount([
        { failure: "seat A", failureAccount: terminal(1) },
        { failure: "seat B", failureAccount: terminal(3) },
      ]),
    ).toEqual(terminal(3));
  });

  it("names no account when no seat named one — unknown stays unknown", () => {
    expect(
      aggregateFailureAccount([{ failure: "no runnable seat" }, { failure: "no runnable seat" }]),
    ).toBeUndefined();
  });
});

describe("reconcileFlaggedVoices — two voices, one Flagged board (J1/J2, D9)", () => {
  const CLAUDE_VOICE = SEAT_BOARD_VOICE["flagged-claude"].author.id;
  const CODEX_VOICE = SEAT_BOARD_VOICE["flagged-codex"].author.id;
  const voices = {
    a: { authorId: CLAUDE_VOICE, label: "Claude" },
    b: { authorId: CODEX_VOICE, label: "Codex" },
  };
  /** Stamp a fixture element with the voice that wrote it — what the writer does per call. */
  const by = (
    authorId: string,
    element: DraftBoard["elements"][number],
  ): DraftBoard["elements"][number] =>
    ({
      ...element,
      data: { ...(element.data as object), author: { kind: "lens-agent", id: authorId } },
    }) as DraftBoard["elements"][number];

  it("repoints a collapse the voices reached at DIFFERENT spans in the same window", () => {
    // The live shape (#548): two seats agree about one concern but cite spans a couple of
    // lines apart. The reconciler matches within a line window, so they still collapse —
    // and an anchor-equality repointing would miss exactly this, leaving the settled board
    // unwritable. The fixture carries the difference on purpose.
    const board = mkBoard([
      by(CLAUDE_VOICE, mkFinding("a-f1", "Short.", ["a-c1"])),
      by(CLAUDE_VOICE, mkCodeRef("a-c1", "src/client.ts", 11, 12)),
      by(CLAUDE_VOICE, mkSection("a-sec", "Findings", ["a-f1"])),
      by(
        CODEX_VOICE,
        mkFinding("b-f1", "A materially longer statement of the very same concern.", ["b-c1"]),
      ),
      by(CODEX_VOICE, mkCodeRef("b-c1", "src/client.ts", 13, 14)),
      by(CODEX_VOICE, mkSection("b-sec", "Findings", ["b-f1"])),
    ]);

    const settled = reconcileFlaggedVoices(board, voices);
    expect(settled.elements.filter(({ kind }) => kind === "finding")).toHaveLength(1);
    const section = settled.elements.find(({ id }) => id === "a-sec");
    expect((section?.data as { children?: string[] } | undefined)?.children).toEqual(["b-f1"]);
    expect(admitBoardReferences(settled, "ps-1").unrepairable).toEqual([]);
  });

  it("repoints a COLLAPSED finding's citers at its kept partner, so the board is writable", async () => {
    // Both voices raise the same finding at the same location; the Codex voice's wording is
    // longer, so the reconciler keeps it and drops the Claude voice's. The Claude voice's
    // section still cites the dropped id — the exact `bad-ref` the board service rejects a
    // whole write for.
    const board = mkBoard([
      by(CLAUDE_VOICE, mkFinding("a-f1", "Short.", ["a-c1"])),
      by(CLAUDE_VOICE, mkCodeRef("a-c1", "src/auth.ts", 11, 12)),
      by(CLAUDE_VOICE, mkSection("findings", "Findings", ["a-f1"])),
      by(
        CODEX_VOICE,
        mkFinding("b-f1", "A materially longer statement of the very same concern.", ["b-c1"]),
      ),
      by(CODEX_VOICE, mkCodeRef("b-c1", "src/auth.ts", 11, 12)),
    ]);

    const settled = reconcileFlaggedVoices(board, voices);
    const findings = settled.elements.filter(({ kind }) => kind === "finding");
    expect(findings).toHaveLength(1);
    const keptId = findings[0]?.id ?? "";
    expect(keptId).toBe("b-f1");
    // The Claude voice's section now cites the SURVIVOR, not the id that collapsed into it.
    const section = settled.elements.find(({ id }) => id === "findings");
    expect((section?.data as { children?: string[] } | undefined)?.children).toEqual([keptId]);
    expect(admitBoardReferences(settled, "ps-1").unrepairable).toEqual([]);

    const root = await mkdtemp(join(tmpdir(), "lens-flagged-merge-"));
    try {
      const runtime = createBoardsRuntime(root);
      const client = new WhiteboardClient(runtime.service);
      const accepted = await client.apply(
        await runtime.createRennetBoard(),
        draftToOps(settled) as never,
        "lens:flagged",
      );
      expect(accepted.response).toMatchObject({ ok: true });

      // POSITIVE CONTROL — put the collapsed id back in the section's children (the shape
      // reconciliation produced before it repointed) and the real service rejects the write.
      const unrepointed = mkBoard(
        settled.elements.map((element) =>
          element.id === "findings"
            ? ({
                ...element,
                data: { ...(element.data as object), children: ["a-f1"] },
              } as DraftBoard["elements"][number])
            : element,
        ),
      );
      const rejected = await client.apply(
        await runtime.createRennetBoard(),
        draftToOps(unrepointed) as never,
        "lens:flagged",
      );
      expect(rejected.response).toMatchObject({ ok: false, code: "bad-ref" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rebuilds the document opening from the final reconciled severity picture", () => {
    const board = {
      ...mkBoard([
        by(CLAUDE_VOICE, mkFinding("a-f1", "high concern", ["a-c1"], "high")),
        by(CLAUDE_VOICE, mkCodeRef("a-c1", "src/high.ts", 1, 2)),
        by(CODEX_VOICE, mkFinding("b-f1", "medium concern", ["b-c1"], "medium")),
        by(CODEX_VOICE, mkCodeRef("b-c1", "src/medium.ts", 3, 4)),
      ]),
      document: {
        title: "Flagged · primary",
        introMarkdown: "1 high finding requires attention.",
        measure: "reading" as const,
      },
    };

    expect(reconcileFlaggedVoices(board, voices).document).toEqual({
      title: "Flagged · primary",
      introMarkdown: "2 findings require attention: 1 high, 1 medium.",
      measure: "reading",
    });
  });

  it("keeps the board's own title with a clean reconciled opening when nothing survived", () => {
    const board = {
      ...mkBoard([]),
      document: {
        title: "Flagged · secondary",
        introMarkdown: "The secondary seat found one open concern.",
        measure: "reading" as const,
      },
    };

    expect(reconcileFlaggedVoices(board, voices).document).toEqual({
      title: "Flagged · secondary",
      introMarkdown: "No findings require attention.",
      measure: "reading",
    });
  });

  it("collapses a matched pair to the clearer finding with BOTH models concurring", () => {
    const board = mkBoard([
      by(CLAUDE_VOICE, mkFinding("a-f1", "short", ["a-c1"])),
      by(CLAUDE_VOICE, mkCodeRef("a-c1", "src/auth.ts", 11, 12)),
      by(
        CODEX_VOICE,
        mkFinding("b-f1", "a materially clearer, longer summary of the same concern", ["b-c1"]),
      ),
      by(CODEX_VOICE, mkCodeRef("b-c1", "src/auth.ts", 11, 12)),
    ]);
    const settled = reconcileFlaggedVoices(board, voices);
    const findings = settled.elements.filter((element) => element.kind === "finding");
    expect(findings).toHaveLength(1);
    // The clearer (longer) summary — the Codex voice's — is kept, with both models at 1/1.
    expect(concurrenceOf(settled, findings[0]?.id ?? "")).toEqual([
      { model: "Claude", agree: 1, total: 1 },
      { model: "Codex", agree: 1, total: 1 },
    ]);
    expect(accordOn(settled, findings[0]?.id ?? "")).toBe("concur");
  });

  // THE AMBIGUITY THE TALLIES CANNOT RESOLVE: two voices that both raised the finding at
  // materially different severities produce `disagree` with NEITHER answer being
  // `NO_CONCERN_ANSWER`, so `foldConcurrence` emits `[{a,1,1},{b,1,1}]` — the BYTE-IDENTICAL
  // tally set a real concurrence produces. A client reading the arithmetic renders a
  // disagreement as agreement, which is exactly what the board pill used to do. The
  // `accord` stamp is the only thing that separates the two, so this test asserts both
  // halves: the tallies really are identical, and the accord really does differ.
  it("stamps a severity conflict `conflict`, though its tallies match a concurrence exactly", () => {
    const board = mkBoard([
      by(CLAUDE_VOICE, mkFinding("a-f1", "this drops writes under load", ["a-c1"], "high")),
      by(CLAUDE_VOICE, mkCodeRef("a-c1", "src/auth.ts", 11, 12)),
      by(CODEX_VOICE, mkFinding("b-f1", "minor: tidy this up sometime", ["b-c1"], "low")),
      by(CODEX_VOICE, mkCodeRef("b-c1", "src/auth.ts", 11, 12)),
    ]);
    const settled = reconcileFlaggedVoices(board, voices);
    const findings = settled.elements.filter((element) => element.kind === "finding");
    expect(findings).toHaveLength(1);
    const id = findings[0]?.id ?? "";
    expect(concurrenceOf(settled, id)).toEqual([
      { model: "Claude", agree: 1, total: 1 },
      { model: "Codex", agree: 1, total: 1 },
    ]);
    expect(accordOn(settled, id)).toBe("conflict");
  });

  it("keeps two solo findings, each with the raising model agreeing and the other at zero", () => {
    const board = mkBoard([
      by(CLAUDE_VOICE, mkFinding("a-f1", "only Claude saw this", ["a-c1"])),
      by(CLAUDE_VOICE, mkCodeRef("a-c1", "src/auth.ts", 11, 12)),
      by(CODEX_VOICE, mkFinding("b-f1", "only Codex saw this", ["b-c1"])),
      by(CODEX_VOICE, mkCodeRef("b-c1", "src/other.ts", 3, 4)),
    ]);
    const settled = reconcileFlaggedVoices(board, voices);
    expect(settled.elements.filter((element) => element.kind === "finding")).toHaveLength(2);
    expect(concurrenceOf(settled, "a-f1")).toEqual([
      { model: "Claude", agree: 1, total: 1 },
      { model: "Codex", agree: 0, total: 1 },
    ]);
    expect(concurrenceOf(settled, "b-f1")).toEqual([
      { model: "Claude", agree: 0, total: 1 },
      { model: "Codex", agree: 1, total: 1 },
    ]);
    // A solo is a SPLIT, not a conflict — one voice answered "no concern".
    expect(accordOn(settled, "a-f1")).toBe("split");
    expect(accordOn(settled, "b-f1")).toBe("split");
  });

  it("leaves a finding neither voice wrote alone — the host's carried round history", () => {
    // A round carries the previous generation's addressed findings onto this board under
    // the HOST's author. They are not either seat's work and were never in the fold, so a
    // reconciliation that dropped them (or stamped them with a model's concurrence) would
    // be crediting a model that never saw them.
    const board = mkBoard([
      by(CLAUDE_VOICE, mkFinding("a-f1", "only Claude saw this", ["a-c1"])),
      by(CLAUDE_VOICE, mkCodeRef("a-c1", "src/auth.ts", 11, 12)),
      by(CODEX_VOICE, mkFinding("b-f1", "only Codex saw this", ["b-c1"])),
      by(CODEX_VOICE, mkCodeRef("b-c1", "src/other.ts", 3, 4)),
      by(HOST_COMPOSER_AUTHOR_ID, mkFinding("h-f1", "carried from round 1", [])),
    ]);
    const settled = reconcileFlaggedVoices(board, voices);
    const carried = settled.elements.find(({ id }) => id === "h-f1");
    expect(carried, "the host's carried finding was dropped by reconciliation").toBeDefined();
    expect(concurrenceOf(settled, "h-f1")).toEqual([]);
    expect(accordOn(settled, "h-f1")).toBeUndefined();
  });
});

describe("stampVoiceConcurrence — no fold ran, so each finding names its own voice", () => {
  const CLAUDE_VOICE = SEAT_BOARD_VOICE["flagged-claude"].author.id;
  const CODEX_VOICE = SEAT_BOARD_VOICE["flagged-codex"].author.id;
  const labelFor = (authorId: string): string =>
    authorId === CODEX_VOICE ? "Codex" : authorId === CLAUDE_VOICE ? "Claude" : "unknown";
  const by = (
    authorId: string,
    element: DraftBoard["elements"][number],
  ): DraftBoard["elements"][number] =>
    ({
      ...element,
      data: { ...(element.data as object), author: { kind: "lens-agent", id: authorId } },
    }) as DraftBoard["elements"][number];

  it("credits each voice for its OWN findings when the lane's other seat never settled", () => {
    // The shape this exists for: two seats ran, one died with findings already on the
    // board. Stamping one label over the whole board would report the dead seat's findings
    // under the survivor's model — a second opinion that never happened, on the very
    // findings the failed model produced.
    const board = mkBoard([
      by(CLAUDE_VOICE, mkFinding("a-f1", "the seat that settled", [])),
      by(CODEX_VOICE, mkFinding("b-f1", "the seat that died mid-turn", [])),
    ]);
    const stamped = stampVoiceConcurrence(board, labelFor);
    expect(concurrenceOf(stamped, "a-f1")).toEqual([{ model: "Claude", agree: 1, total: 1 }]);
    expect(concurrenceOf(stamped, "b-f1")).toEqual([{ model: "Codex", agree: 1, total: 1 }]);
    // No accord in either case: one voice has no agreement to report.
    expect(accordOn(stamped, "a-f1")).toBeUndefined();
    expect(accordOn(stamped, "b-f1")).toBeUndefined();
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
    // …and NO accord: one seat has no agreement to report, so there is nothing to stamp.
    // `concur` here would claim a second opinion that never ran.
    expect(accordOn(stamped, "f1")).toBeUndefined();
    expect(stamped.document).toBeUndefined();
  });

  it("rebuilds a surviving seat's document from its final severity picture", () => {
    const board = {
      ...mkBoard([
        mkFinding("f1", "high concern", ["c1"], "high"),
        mkCodeRef("c1", "src/high.ts", 11, 12),
        mkFinding("f2", "low concern", ["c2"], "low"),
        mkCodeRef("c2", "src/low.ts", 21, 22),
      ]),
      document: {
        title: "Flagged · surviving seat",
        introMarkdown: "1 high finding requires attention.",
        measure: "structured" as const,
      },
    };

    expect(stampSingleSeatConcurrence(board, "Codex").document).toEqual({
      title: "Flagged · surviving seat",
      introMarkdown: "2 findings require attention: 1 high, 1 low.",
      measure: "reading",
    });
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

    const written: SessionContextFile[] = [];
    let prompt = "";
    const result = await composeReviewDraft({
      boards: current,
      previous,
      voicePromptText: "VOICE RULES",
      writeContext: (files) => {
        written.push(...files);
        return ".rennet/context/s1";
      },
      authorTurn: (p) => {
        prompt = p;
        return "AUTHORED: the change reads cleanly.";
      },
      lintCtx: { files: new Map() },
    });

    expect(result.prose).toContain("the change reads cleanly");
    // session-context-files 3.3: the prompt NAMES the voice rules and the boards; it
    // carries neither. The boards used to ride as one JSON context layer.
    expect(prompt).toContain("`.rennet/context/s1/review-draft-voice.md`");
    expect(prompt).toContain("`.rennet/context/s1/boards/`");
    expect(prompt).toContain("`design.json`");
    expect(prompt).not.toContain("VOICE RULES");
    expect(prompt).not.toContain("A fresh observation.");
    expect(prompt).not.toContain("rennet:layer context");
    expect(inlineContextViolation(prompt)).toBeUndefined();
    expect(Buffer.byteLength(prompt, "utf8")).toBeLessThan(2_048);
    // The files hold what the prompt no longer does.
    expect(written.map((file) => file.name)).toEqual([
      "review-draft-voice.md",
      "boards/design.json",
    ]);
    expect(written[0]?.body).toBe("VOICE RULES");
    expect(JSON.parse(written[1]?.body ?? "{}")).toEqual(current.get("design"));
    // The byte-identical element carried; the new one did not.
    expect([...(result.carried.get("design") ?? [])]).toEqual(["keep"]);
    // Clean prose (no machinery, no citations) ⇒ no register violations.
    expect(result.violations).toEqual([]);
  });

  it("flags machinery vocabulary in the review register (visible, never blocking)", async () => {
    const result = await composeReviewDraft({
      boards: new Map(),
      voicePromptText: "VOICE",
      writeContext: () => ".rennet/context/s1",
      authorTurn: () => "This lens board was drafted by an agent seat.",
      lintCtx: { files: new Map() },
    });
    expect(result.violations.length).toBeGreaterThan(0);
  });

  it("says so when no context directory was written (the direct-call shape), naming no path", async () => {
    let prompt = "";
    await composeReviewDraft({
      boards: new Map([["design", mkBoard([prose("p", "Some prose.")])] as const]),
      voicePromptText: "VOICE",
      writeContext: () => undefined,
      authorTurn: (p) => {
        prompt = p;
        return "prose";
      },
      lintCtx: { files: new Map() },
    });
    expect(prompt).toContain("No context directory was written");
    expect(prompt).not.toContain("boards/");
  });
});

describe("runLensPipeline — the real drafting path (fake harness, no live model)", () => {
  it("threads each seat's board tool-call count to the collector, from its REAL lane", async () => {
    // `lens-board-tools` D11, task 4.3, driven end to end: the lane the pipeline opened
    // counts the seat's calls, `resolveBoardSeatDetails` reads that lane, the adapter
    // records the difference across the turn. `t3-seat-turn.test.ts` proves the adapter's
    // arithmetic against an injected reader; this proves the reader is the real lane's.
    //
    // THE CONTROL FOR 4.3: drop the reader in `resolveBoardSeatDetails` and this reddens
    // with `board.lens-draft.design carried no tool-call count: expected undefined to be
    // defined`, run 2026-09-05.
    const collector = createMetricsCollector();
    const captures: SeatCapture[] = [];
    const bodyFor = (prompt: string, label?: string): unknown =>
      cleanBody(lensFromPrompt(prompt, label));
    await runLensPipeline({
      ...boardSeats(captures, bodyFor),
      repoRoot: "/pr-worktree",
      deltaPacket: PACKET,
      lintContextFor,
      readPrompt,
      collector,
      whiteboard: fakeWhiteboard([]),
      boardIdFor: (lens) => `board:${lens}`,
    });

    const seatMetrics = collector.metrics.filter(({ label }) => label.startsWith("board.lens-"));
    expect(seatMetrics.length, "every lens seat recorded a turn").toBeGreaterThan(0);
    for (const metric of seatMetrics) {
      expect(metric.toolCalls, `${metric.label} carried no tool-call count`).toBeDefined();
    }
    // …and at least one is a real count off a board that was actually written, not a zero
    // standing in for "not measured". The whole point of the figure is that it moves.
    expect(seatMetrics.some((metric) => (metric.toolCalls ?? 0) > 0)).toBe(true);
    // The round-report seat has no lane, so it carries no count rather than a fabricated
    // zero — the distinction the reader's `undefined` exists to keep.
    const report = collector.metrics.find(({ label }) => label.startsWith("board.round-report"));
    expect(report?.toolCalls).toBeUndefined();
  });

  it("drafts all five lenses, writes each board via whiteboard, and announces each lane as it settles", async () => {
    const captures: SeatCapture[] = [];
    const applied: Applied[] = [];
    const arrivals: BoardArrivalEvent[] = [];

    const bodyFor = (prompt: string, label?: string): unknown =>
      cleanBody(lensFromPrompt(prompt, label));

    const result = await runLensPipeline({
      ...boardSeats(captures, bodyFor),
      repoRoot: "/pr-worktree",
      deltaPacket: PACKET,
      lintContextFor,
      readPrompt,
      whiteboard: fakeWhiteboard(applied),
      boardIdFor: (lens) => `board:${lens}`,
      onBoardArrival: (event) => {
        arrivals.push(event);
      },
    });

    // Five lens boards, each written once, each announced on freeze.
    const lenses: LensKind[] = ["design", "sequence", "decisions", "flagged", "noise"];
    expect(result.boards.map((b) => b.lens)).toEqual(lenses);
    for (const outcome of result.boards) {
      expect(outcome.failure).toBeUndefined();
      expect(outcome.board?.elements.length).toBeGreaterThan(0);
    }
    expect(applied.map((a) => a.boardId).sort()).toEqual(lenses.map((l) => `board:${l}`).sort());
    // Every op is a create — the host writes the drafter's board on its behalf.
    for (const a of applied) {
      for (const op of a.ops as { op: string }[]) expect(op.op).toBe("create");
    }
    // #725 D4 — arrivals are published in SETTLEMENT order, not in a fixed lens order: the
    // five lanes are independent and each announces the moment its own board is written.
    // The set is what this test owns; the ORDERING property has its own test below
    // ("reveals each lens board as its own lane settles"), which releases the lanes in a
    // known order and asserts the reveal follows it.
    expect([...arrivals.map((a) => a.lens)].sort()).toEqual([...lenses].sort());
    expect(captures.map(({ prompt }) => lensFromPrompt(prompt ?? "")).sort()).toEqual(
      [...lenses].sort(),
    );
    expect(captures.some(({ prompt }) => lensFromPrompt(prompt ?? "") === "post-process")).toBe(
      false,
    );
  });

  it("falls the Design lane back to the seat when the assembler throws, never crashing the round", async () => {
    // The round-crash regression: a throwing assembler used to reject the Design lane, which
    // `Promise.allSettled` then rethrows, killing the whole generation and its four settled
    // siblings. A `## Why` with an indented list or a machinery-word change name throws on
    // VALID input, so the fast path must degrade to the seat, not take the round down.
    const captures: SeatCapture[] = [];
    const applied: Applied[] = [];
    const bodyFor = (prompt: string, label?: string): unknown =>
      cleanBody(lensFromPrompt(prompt, label));

    const result = await runLensPipeline({
      ...boardSeats(captures, bodyFor),
      repoRoot: "/pr-worktree",
      deltaPacket: PACKET,
      lintContextFor,
      readPrompt,
      whiteboard: fakeWhiteboard(applied),
      boardIdFor: (lens) => `board:${lens}`,
      assembleDesignBoard: () => {
        throw new Error("design-assembler: board did not settle — no-code-bytes @ document");
      },
    });

    // All five lanes still settle, Design included, and none fails.
    const lenses: LensKind[] = ["design", "sequence", "decisions", "flagged", "noise"];
    expect(result.boards.map((b) => b.lens)).toEqual(lenses);
    for (const outcome of result.boards) expect(outcome.failure).toBeUndefined();
    // The Design SEAT ran — the throw fell through to the model exactly like `undefined` does.
    expect(captures.some(({ prompt }) => lensFromPrompt(prompt ?? "") === "design")).toBe(true);
  });

  it("skips the Design seat entirely when the assembler settles a board (the fast path)", async () => {
    // The other half of the wiring: a valid assembled board must REPLACE the model turn, or
    // the fast path saves nothing. If the catch above ever swallowed a good board too, the
    // seat would run here — this fails if it does.
    const captures: SeatCapture[] = [];
    const applied: Applied[] = [];
    const bodyFor = (prompt: string, label?: string): unknown =>
      cleanBody(lensFromPrompt(prompt, label));

    const result = await runLensPipeline({
      ...boardSeats(captures, bodyFor),
      repoRoot: "/pr-worktree",
      deltaPacket: PACKET,
      lintContextFor,
      readPrompt,
      whiteboard: fakeWhiteboard(applied),
      boardIdFor: (lens) => `board:${lens}`,
      assembleDesignBoard: () => designBody(),
    });

    const design = result.boards.find((b) => b.lens === "design");
    expect(design?.failure).toBeUndefined();
    expect(design?.board?.document?.title).toBe("token-refresh");
    // No Design turn was ever sent to the fake harness.
    expect(captures.some(({ prompt }) => lensFromPrompt(prompt ?? "") === "design")).toBe(false);
  });

  it("refuses a dangling Sequence or Decisions reference where it is made, and the board still lands", async () => {
    // WAS: "repairs dangling Sequence and Decisions references before the real board
    // service write". That test drove a seat that RETURNED a board naming an element it did
    // not hold and watched the repair ladder re-ask it. A dangling reference cannot be
    // returned any more — a reference argument must name an element the board already
    // holds, so the call that would create one is refused where it is made (D4) and there
    // is nothing left for a repair boundary to re-anchor.
    //
    // What survives, and is the whole subject now: the refusal names what the board DOES
    // hold, the seat fixes it inside the same turn at no cost to its attempts, and the
    // board the real service accepts is the fixed one. The bypass control at the end is
    // unchanged and still load-bearing — written past the tool boundary the same shape is
    // rejected by the board service as a `bad-ref`.
    const root = await mkdtemp(join(tmpdir(), "lens-reference-refusal-"));
    try {
      const runtime = createBoardsRuntime(root);
      const client = new WhiteboardClient(runtime.service);
      const seatTurns: SeatCapture[] = [];
      const arrivals: BoardArrivalEvent[] = [];
      const refusals: string[] = [];

      const boardIds = new Map<LintTarget, string>();
      for (const lens of ["design", "sequence", "decisions", "flagged", "noise"] as const) {
        boardIds.set(lens, await runtime.createRennetBoard());
      }

      const sequenceTurn = (voice: BoardVoiceWriter): void => {
        const rootId = idOf(voice.call("add_section", { title: "Reading order" }));
        const spanId = idOf(
          voice.call("add_prose", {
            markdown: "The entry point starts the read.",
            parent_id: rootId,
          }),
        );
        // THE DANGLING CALL: an id the board does not hold. Refused, inside this turn.
        const refused = voice.call("add_step", {
          title: "Read the entry point",
          span_ref_id: "missing-sequence-span",
          parent_id: rootId,
        });
        if (refused.ok) throw new Error("a dangling span reference was accepted");
        refusals.push(refused.refusal);
        okCall(
          voice.call("add_step", {
            title: "Read the entry point",
            span_ref_id: spanId,
            parent_id: rootId,
          }),
        );
        okCall(voice.call("finish"));
      };

      const decisionsTurn = (voice: BoardVoiceWriter): void => {
        const rootId = idOf(voice.call("add_section", { title: "Implementation decisions" }));
        const citationId = idOf(
          voice.call("cite", {
            path: "src/auth.ts",
            side: "head",
            start_line: 11,
            end_line: 12,
          }),
        );
        const refused = voice.call("add_decision", {
          statement: "Keep writes atomic.",
          evidence_ref_ids: ["missing-decision-code"],
          alternatives: ["Write each event independently."],
          why: "Readers never observe a partial batch.",
          parent_id: rootId,
        });
        if (refused.ok) throw new Error("a dangling evidence reference was accepted");
        refusals.push(refused.refusal);
        okCall(
          voice.call("add_decision", {
            statement: "Keep writes atomic.",
            evidence_ref_ids: [citationId],
            alternatives: ["Write each event independently."],
            why: "Readers never observe a partial batch.",
            parent_id: rootId,
          }),
        );
        okCall(voice.call("finish"));
      };

      const result = await runLensPipeline({
        ...boardSeats(seatTurns, (prompt, label) => {
          const lens = lensFromPrompt(prompt, label);
          if (lens === "sequence") return sequenceTurn;
          if (lens === "decisions") return decisionsTurn;
          return cleanBody(lens);
        }),
        repoRoot: "/pr-worktree",
        deltaPacket: PACKET,
        lintContextFor: (lens) => ({
          lens,
          regions: [{ path: "src/auth.ts", side: "head", start: 1, end: 200 }],
          files: new Map([["src/auth.ts", 200]]),
          patchsetId: "ps-1",
        }),
        readPrompt,
        whiteboard: client,
        boardIdFor: (lens) => boardIds.get(lens) ?? "",
        onBoardArrival: (event) => {
          arrivals.push(event);
        },
      });

      // Both refusals happened, and each named what the board DID hold rather than only
      // what it did not — which is what makes the correction possible inside the turn.
      expect(refusals).toHaveLength(2);
      for (const refusal of refusals) expect(refusal).toContain("It holds:");

      for (const lens of ["sequence", "decisions"] as const) {
        const outcome = result.boards.find((board) => board.lens === lens);
        expect(outcome?.failure, lens).toBeUndefined();
        expect(arrivals.map(({ lens: arrived }) => arrived)).toContain(lens);
        // ONE turn per lane: a refusal costs no attempt (D6), so a lane that reached for a
        // bad id and then the right one spent nothing on it.
        expect(
          seatTurns.filter(({ seat }) => seat === lens),
          `${lens} turns`,
        ).toHaveLength(1);
      }

      // Written past the tool boundary, the same shape is still rejected by the board
      // service — the control that says the service-side check has not gone soft.
      const bypassed = await client.apply(
        await runtime.createRennetBoard(),
        draftToOps({
          elements: [
            {
              id: "sequence-step",
              kind: "order_step",
              data: {
                author: { kind: "lens-agent", id: "lens:sequence" },
                title: "Read the entry point",
                span: "missing-sequence-span",
                children: [],
              },
            },
          ],
        } as unknown as DraftBoard) as never,
        "lens:sequence",
      );
      expect(bypassed.response).toMatchObject({ ok: false, code: "bad-ref" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("writes a repair-requiring board ONLY because the production write path admitted it", async () => {
    // The direct `admitBoardReferences` unit tests above prove the pass; they do not prove
    // the pipeline calls it, so deleting the production call site left them green. This
    // drives the real production path — `runLensPipeline` → `persistBoard` → the REAL
    // board service — over a reference the ladder cannot see.
    //
    // The shape is MODELLED on a round carry-forward — a prior round's addressed chapter
    // riding verbatim into this round's Sequence board after lint — but the fixture builds
    // the `previous` board by hand, with the mis-cased citation written in. It does not run
    // `composeFindingRound`, so it proves nothing about whether that composer can produce
    // this shape; what it proves is that when a board reaches the write boundary carrying
    // one, the production path admits it instead of losing the board.
    const root = await mkdtemp(join(tmpdir(), "lens-admission-production-"));
    try {
      const runtime = createBoardsRuntime(root);
      const client = new WhiteboardClient(runtime.service);
      const hostAuthor = { kind: "orchestrator" as const, id: "rennet:round-composition" };
      const carriedRef = "rennet:host:round-addressed:1:0:code-ref";
      const citedAs = "rennet:host:round-addressed:1:0:code_ref";
      const annotationId = "rennet:host:round-addressed:1:0:annotation";
      const previousSequence = mkBoard([
        {
          id: carriedRef,
          kind: "code_ref",
          data: {
            author: hostAuthor,
            patchset_id: "ps-1",
            path: "src/auth.ts",
            side: "head",
            start_line: 11,
            end_line: 12,
          },
        } as unknown as DraftBoard["elements"][number],
        {
          id: annotationId,
          kind: "annotation",
          data: { author: hostAuthor, code_ref: citedAs, body: "Addressed in round 1." },
        } as unknown as DraftBoard["elements"][number],
      ]);

      const boardIds = new Map<LintTarget, string>();
      for (const lens of ["design", "sequence", "decisions", "flagged", "noise"] as const) {
        boardIds.set(lens, await runtime.createRennetBoard());
      }
      const metas: BoardMeta[] = [];
      const result = await runLensPipeline({
        ...boardSeats([], (prompt, label) => {
          const lens = lensFromPrompt(prompt, label);
          if (lens === "post-process") {
            const context = /rennet:layer context>>>\n(\{.*)/s.exec(prompt);
            return context ? (JSON.parse(context[1] as string).board as unknown) : { elements: [] };
          }
          return cleanBody(lens);
        }),
        repoRoot: "/pr-worktree",
        deltaPacket: PACKET,
        currentGeneration: "gen:ps-1",
        // A same-generation round: it composes, and it drafts no report to verify.
        round: {
          number: 2,
          previousGeneration: "gen:ps-1",
          dispatchedAsks: [],
          findingDispositions: {},
        },
        previous: new Map<LintTarget, DraftBoard>([["sequence", previousSequence]]),
        lintContextFor,
        readPrompt,
        whiteboard: client,
        boardIdFor: (lens) => boardIds.get(lens) ?? "",
        persistBoardMeta: (meta) => {
          metas.push(meta);
        },
      });

      const sequence = result.boards.find(({ lens }) => lens === "sequence");
      expect(sequence?.failure).toBeUndefined();
      // The repair landed in the SERVICE's state, not merely in the returned board.
      const state = await runtime.service.getState(boardIds.get("sequence") ?? "");
      expect(state.has(carriedRef)).toBe(true);
      expect((state.get(annotationId)?.data as { code_ref?: string } | undefined)?.code_ref).toBe(
        carriedRef,
      );
      // And it is ACCOUNTED FOR durably: a repair is recorded on the board's meta, never a
      // silent rewrite of what the producer wrote.
      const meta = metas.find(({ lens }) => lens === "sequence");
      expect(meta?.refRepairs).toEqual([
        { elementId: annotationId, field: "code_ref", from: citedAs, to: carriedRef },
      ]);

      // The control that makes the write load-bearing: put the reference back the way the
      // composition produced it and hand the SAME board to the same service. It is refused
      // wholesale, so the accepted write above happened only because production admitted it.
      const written = sequence?.board;
      if (written === undefined) throw new Error("Sequence settled without a board");
      const bypassed = written.elements.map((element) =>
        element.id === annotationId
          ? ({
              ...element,
              data: { ...(element.data as object), code_ref: citedAs },
            } as DraftBoard["elements"][number])
          : element,
      );
      const rejected = await client.apply(
        await runtime.createRennetBoard(),
        draftToOps(mkBoard(bypassed)) as never,
        "lens:sequence",
      );
      expect(rejected.response).toMatchObject({ ok: false, code: "bad-ref" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("settles the Design lane absent when the seat reports no spec for this branch", async () => {
    // D6: the seat finds the spec itself, so `{ absence: "no-spec" }` IS the absence —
    // no host bundle grounds it. The lane settles absent, never failed, and writes no board.
    const applied: Applied[] = [];
    const arrivals: BoardArrivalEvent[] = [];
    const result = await runLensPipeline({
      ...boardSeats([], (prompt, label) => {
        const lens = lensFromPrompt(prompt, label);
        return lens === "design" ? { absence: "no-spec" } : cleanBody(lens);
      }),
      repoRoot: "/pr-worktree",
      deltaPacket: PACKET,
      lintContextFor,
      readPrompt,
      whiteboard: fakeWhiteboard(applied),
      boardIdFor: (lens) => `board:${lens}`,
      onBoardArrival: (event) => {
        arrivals.push(event);
      },
    });

    const design = result.boards.find((outcome) => outcome.lens === "design");
    expect(design).toMatchObject({ lens: "design", absence: "no-spec" });
    expect(design?.failure).toBeUndefined();
    expect(design?.board).toBeUndefined();
    expect(applied.map(({ boardId }) => boardId)).not.toContain("board:design");
    expect(arrivals.map(({ lens }) => lens)).not.toContain("design");
    expect(result.boards.filter(({ board }) => board !== undefined)).toHaveLength(4);
  });

  it("settles the Design lane absent when the no-spec return arrives on a repair turn", async () => {
    let designTurns = 0;
    const result = await runLensPipeline({
      ...boardSeats([], (prompt, label) => {
        const lens = lensFromPrompt(prompt, label);
        if (lens !== "design") return cleanBody(lens);
        designTurns += 1;
        // Turn 1 does not parse as a board, so the lint ladder re-asks; turn 2 names it.
        return designTurns === 1 ? { nonsense: true } : { absence: "no-spec" };
      }),
      repoRoot: "/pr-worktree",
      deltaPacket: PACKET,
      lintContextFor,
      readPrompt,
      whiteboard: fakeWhiteboard([]),
      boardIdFor: (lens) => `board:${lens}`,
    });

    expect(result.boards.find(({ lens }) => lens === "design")).toMatchObject({
      lens: "design",
      absence: "no-spec",
    });
    expect(designTurns).toBe(2);
  });

  // Noise is NOT among these rows any more, and its removal is the point rather than an
  // omission: the host settles a Noise lane's absence from the derivation before any seat
  // runs (D16e), so the Noise seat has no settle-absent verb to call — there is nothing
  // left for it to declare that the host did not already know. "Every region was cited"
  // has its own test, and it dispatches no seat at all.
  it.each([
    ["decisions", "no-decisions"],
    ["flagged", "no-findings"],
  ] as const)(
    "settles the %s lane absent when its seat DECLARES the absence its lens admits",
    async (emptyLens, absence) => {
      let emptyLensTurns = 0;
      const applied: Applied[] = [];
      const arrivals: BoardArrivalEvent[] = [];
      const result = await runLensPipeline({
        ...boardSeats([], (prompt, label) => {
          const lens = lensFromPrompt(prompt, label);
          if (lens === emptyLens) {
            emptyLensTurns += 1;
            // An absence is now an ACT, not an inference from an empty return: the seat
            // calls the one settle-absent verb its lens has, whose reason is fixed by the
            // lens and carries no field to name it with.
            return { absence };
          }
          return cleanBody(lens);
        }),
        repoRoot: "/pr-worktree",
        deltaPacket: PACKET,
        lintContextFor,
        readPrompt,
        whiteboard: fakeWhiteboard(applied),
        boardIdFor: (lens) => `board:${lens}`,
        onBoardArrival: (event) => {
          arrivals.push(event);
        },
      });

      expect(emptyLensTurns).toBe(1);
      expect(result.boards.find(({ lens }) => lens === emptyLens)).toMatchObject({ absence });
      // The settled absence must be one the protocol admits FOR THIS LENS (#549) —
      // the pipeline reads the canonical table rather than restating it.
      expect(lensAdmitsAbsence(emptyLens, absence)).toBe(true);
      expect(applied.map(({ boardId }) => boardId)).not.toContain(`board:${emptyLens}`);
      expect(arrivals.map(({ lens }) => lens)).not.toContain(emptyLens);
    },
  );

  it("refuses an absence for the Sequence lane, which admits none (#549)", async () => {
    // Two halves, and the first is the structural one: the Sequence seat has no verb for
    // declaring an absence, so there is nothing to refuse at runtime. The second is what
    // happens to a Sequence seat that writes nothing anyway — its `finish` does not settle
    // and the lane fails, which is what a review with no order board deserves.
    expect([...boardToolsByName("sequence").keys()]).not.toContain("settle_absent");
    const applied: Applied[] = [];
    const result = await runLensPipeline({
      ...boardSeats([], (prompt, label) => {
        const lens = lensFromPrompt(prompt, label);
        if (lens === "sequence") return { elements: [] };
        return cleanBody(lens);
      }),
      repoRoot: "/pr-worktree",
      deltaPacket: PACKET,
      lintContextFor,
      readPrompt,
      whiteboard: fakeWhiteboard(applied),
      boardIdFor: (lens) => `board:${lens}`,
    });

    const sequence = result.boards.find(({ lens }) => lens === "sequence");
    // A review with no order board has nothing to read: an empty Sequence is a
    // failure, never the clean settlement the other lanes are allowed.
    expect(sequence?.absence).toBeUndefined();
    expect(sequence?.failure).toBeDefined();
    expect(applied.map(({ boardId }) => boardId)).not.toContain("board:sequence");
  });

  it("RE-ASKS the seat when the drafting turn wrote nothing, and settles the board it then writes", async () => {
    // The production no-board shape, restated for a seat that ACTS: the turn ended having
    // called neither `finish` nor a settle-absent verb. That, and only that, spends an
    // attempt (D6) — so the seat is re-asked and its second turn settles the lane as a
    // board, not a failure.
    const noiseTurns: string[] = [];
    const result = await runLensPipeline({
      ...boardSeats([], (prompt, label) => {
        const lens = lensFromPrompt(prompt, label);
        if (lens !== "noise") return cleanBody(lens);
        noiseTurns.push(prompt);
        // A turn that made no calls at all: it ended, and the board is where it was.
        return noiseTurns.length === 1 ? undefined : cleanBody("noise");
      }),
      repoRoot: "/pr-worktree",
      deltaPacket: PACKET,
      lintContextFor,
      readPrompt,
      whiteboard: fakeWhiteboard([]),
      boardIdFor: (lens) => `board:${lens}`,
    });

    const noise = result.boards.find(({ lens }) => lens === "noise");
    expect(noise?.failure).toBeUndefined();
    expect(noise?.absence).toBeUndefined();
    expect(noise?.board?.elements.length).toBeGreaterThan(0);
    // The lane really was re-asked, and the re-ask is the LADDER's: "not the same string"
    // was satisfied by any second prompt at all, including one that re-asks for nothing.
    expect(noiseTurns).toHaveLength(2);
    const reask = noiseTurns[1] ?? "";
    // The follow-up carries the last verdict and NOTHING else (D6): not the base prompt,
    // not the board, not a draft — the seat's thread holds the first and the lane's board
    // holds the other two.
    expect(reask.startsWith("<<<rennet:layer task>>>")).toBe(true);
    expect(reask).not.toContain(noiseTurns[0] ?? "NEVER");
    expect(reask).not.toContain("PROMPT_FILE:");
    // `finish` was never called, so there is no verdict to carry and the turn says so
    // rather than inventing pointers about a board nobody claimed was done.
    expect(reask).toContain("Your last turn ended without calling `finish`");
    expect(reask).toContain("Everything you wrote is still on the board");
    expect(reask).not.toContain("Previous draft");
    expect(reask).not.toContain("elementsToFix");
    // Bounded by the fact rather than by a cap: a repair turn that carries no verdict is
    // one sentence, and 500 bytes is generous room for it.
    expect(Buffer.byteLength(reask, "utf8")).toBeLessThan(500);
  });

  it("settles TERMINAL only after the re-asks are spent, naming what `finish` last said", async () => {
    const noiseTurns: string[] = [];
    const result = await runLensPipeline({
      ...boardSeats([], (prompt, label) => {
        const lens = lensFromPrompt(prompt, label);
        if (lens !== "noise") return cleanBody(lens);
        noiseTurns.push(prompt);
        return undefined;
      }),
      repoRoot: "/pr-worktree",
      deltaPacket: PACKET,
      lintContextFor,
      readPrompt,
      whiteboard: fakeWhiteboard([]),
      boardIdFor: (lens) => `board:${lens}`,
    });

    const noise = result.boards.find(({ lens }) => lens === "noise");
    expect(noise?.absence).toBeUndefined();
    // The sentence names the lens, the attempts spent and what the last verdict said —
    // the three facts `lens-board-drafting` requires of an exhausted lane.
    expect(noise?.failure).toContain("noise lens: the seat did not finish its board");
    expect(noise?.failure).toContain("attempts spent");
    expect(noise?.failure).toContain("`finish` was never called");
    // Terminal, and only because the retries were actually spent — the attempt count is
    // the ladder's, never the initial turn's `0`.
    expect(noise?.failureAccount?.classification).toBe("terminal");
    expect(noise?.failureAccount?.attempt).toBeGreaterThan(0);
    // Turns and attempts are the SAME number now, and the change is the accounting rather
    // than the arithmetic: every turn here ended without settling, and that is exactly what
    // spends an attempt (D6). Under the ladder the first turn was the draft and the
    // attempts were the repairs after it, so the count was one higher than the budget.
    expect(noiseTurns.length).toBe(noise?.failureAccount?.attempt ?? 0);
  });

  it("carries an aggregated account when BOTH flagged seats fail (#549)", async () => {
    // Both seats emit nothing, on every turn, so both spend their ladders — the lens is
    // terminal, and it says so with an account rather than a bare sentence.
    const noBoard = (prompt: string, label?: string): unknown =>
      lensFromPrompt(prompt, label) === "flagged"
        ? undefined
        : cleanBody(lensFromPrompt(prompt, label));
    const result = await runLensPipeline({
      ...boardSeats([], noBoard, ["claude-code", "codex"]),
      repoRoot: "/pr-worktree",
      deltaPacket: PACKET,
      lintContextFor,
      readPrompt,
      whiteboard: fakeWhiteboard([]),
      boardIdFor: (lens) => `board:${lens}`,
    });

    const flagged = result.boards.find(({ lens }) => lens === "flagged");
    expect(flagged?.failure).toContain("both flagged seats failed");
    // Both seats named the SAME lane's failure; the account survives the aggregation
    // instead of being rebuilt as a string with the classification thrown away.
    expect(flagged?.failureAccount?.classification).toBe("terminal");
    expect(flagged?.failureAccount?.attempt).toBeGreaterThan(0);
  });

  it("never settles an absence from an empty board — only from a seat that declared one", async () => {
    // The inference is gone (`lens-board-drafting`: a seat settles a board by finishing it
    // and an absence by declaring one, each as an explicit call). A seat that writes
    // nothing and claims nothing has its `finish` refused by `board-has-material`, spends
    // its attempts and settles a failure — on EVERY lens, including the two whose lens
    // admits an absence. Reading silence as a clean absence is exactly the settlement this
    // change removes.
    const result = await runLensPipeline({
      ...boardSeats([], () => ({ elements: [] })),
      repoRoot: "/pr-worktree",
      deltaPacket: PACKET,
      lintContextFor,
      readPrompt,
      whiteboard: fakeWhiteboard([]),
      boardIdFor: (lens) => `board:${lens}`,
    });

    const settled = new Map(result.boards.map((outcome) => [outcome.lens, outcome]));
    for (const lens of ["decisions", "flagged", "sequence", "design"] as const) {
      expect(
        settled.get(lens)?.absence,
        `${lens} read an empty board as an absence`,
      ).toBeUndefined();
      expect(
        settled.get(lens)?.failure,
        `${lens} settled an empty board as a success`,
      ).toBeDefined();
    }
    // Noise is no longer among the lenses an empty draw can settle (D16). Its membership
    // is the complement of the other four, and ALL of them failed here — so what they
    // would have cited is unknown, the complement cannot be taken, and the lane settles a
    // typed failure naming them rather than a board over the leftovers. This is the trap
    // D16d exists to close: a complement over a partial set of siblings would file
    // un-reviewed regions as skippable.
    expect(settled.get("noise")?.absence).toBeUndefined();
    expect(settled.get("noise")?.failure).toContain("design");
    expect(settled.get("noise")?.failure).toContain("sequence");
    // TERMINAL, and it is the SIBLINGS' classification rather than an assumption about this
    // lane: every core lane here spent its own ladder, so there is no per-lens retry left
    // for the complement to become knowable through. `retryable` would be a claim about a
    // future that cannot happen — and the restart path reads a retryable account as reason
    // to re-draft all five lanes.
    expect(settled.get("noise")?.failureAccount?.classification).toBe("terminal");
    // Every absence this pipeline settles is one the protocol table admits for that lens.
    for (const outcome of result.boards) {
      if (outcome.absence === undefined || outcome.lens === "report") continue;
      expect(
        lensAdmitsAbsence(outcome.lens, outcome.absence),
        `${outcome.lens} settled an inadmissible ${outcome.absence}`,
      ).toBe(true);
    }
  });

  it("a re-ask on which the seat DECLARES the absence settles it, not a failure", async () => {
    // A first turn that wrote nothing claimed nothing either way; it spends the attempt and
    // the seat is re-asked. The declaration on the follow-up is what settles the lane, and
    // it settles it absent rather than failed.
    const decisionsTurns: string[] = [];
    const result = await runLensPipeline({
      ...boardSeats([], (prompt, label) => {
        const lens = lensFromPrompt(prompt, label);
        if (lens !== "decisions") return cleanBody(lens);
        decisionsTurns.push(prompt);
        return decisionsTurns.length === 1 ? undefined : { absence: "no-decisions" };
      }),
      repoRoot: "/pr-worktree",
      deltaPacket: PACKET,
      lintContextFor,
      readPrompt,
      whiteboard: fakeWhiteboard([]),
      boardIdFor: (lens) => `board:${lens}`,
    });

    const decisions = result.boards.find(({ lens }) => lens === "decisions");
    expect(decisions?.failure).toBeUndefined();
    expect(decisions?.absence).toBe("no-decisions");
    expect(lensAdmitsAbsence("decisions", "no-decisions")).toBe(true);
    expect(decisionsTurns).toHaveLength(2);
  });

  it("places the complement on the Noise board: a cited region is absent, an uncited one is a member (3.8)", async () => {
    // Task 3.8's two named controls, which existed nowhere: `deriveNoiseMembers` and
    // `placeMembers` were each unit-tested and NOTHING joined them. That is the same
    // reconstruction trap this file names one call site over — a helper proven in isolation
    // does not prove the pipeline calls it — and it is why replacing the `placeMembers`
    // call with a no-op left the whole server suite green: `hasLensMaterial` had no row for
    // Noise and fell through to an element count the seat's own grouping prose satisfies,
    // and `derived-member-grouped` is vacuous with no members to parent. A Noise lane
    // holding the account of the regions, and none of the regions, settled as a success.
    //
    // TWO changed regions, one of them cited by a sibling. That is the shape the assertion
    // needs: a one-region fixture cannot tell "the complement was placed" from "everything
    // was placed", and a fixture where nothing is cited cannot tell either from "nothing
    // was subtracted".
    const CITED = { path: "src/cited.ts", side: "head" as const, start: 1, end: 4 };
    const seatTurns: SeatCapture[] = [];
    const result = await runLensPipeline({
      ...boardSeats(seatTurns, (prompt, label) => {
        const lens = lensFromPrompt(prompt, label);
        if (lens !== "sequence") return cleanBody(lens);
        // Sequence cites `src/cited.ts` and says nothing about `src/uncited.ts`.
        const body = meaningfulSequenceBody();
        return {
          elements: [
            ...body.elements.map((element) =>
              element.id === "sequence-root"
                ? {
                    ...element,
                    data: { ...element.data, children: ["sequence-step", "cited-ref"] },
                  }
                : element,
            ),
            {
              id: "cited-ref",
              kind: "code_ref",
              data: {
                author: { kind: "lens-agent", id: "sequence-seat" },
                patchset_id: "ps-1",
                path: CITED.path,
                side: CITED.side,
                start_line: CITED.start,
                end_line: CITED.end,
              },
            },
          ],
        } as unknown as DraftBoard;
      }),
      repoRoot: "/pr-worktree",
      deltaPacket: PACKET,
      lintContextFor: (lens) => ({
        ...lintContextFor(lens),
        regions: [CITED, UNCITED_REGION],
        files: new Map([
          [CITED.path, 100],
          [UNCITED_REGION.path, 100],
        ]),
      }),
      readPrompt,
      whiteboard: fakeWhiteboard([]),
      boardIdFor: (lens) => `board:${lens}`,
    });

    const sequence = result.boards.find(({ lens }) => lens === "sequence");
    expect(
      sequence?.failure,
      "the citing lane must settle, or nothing was subtracted",
    ).toBeUndefined();
    const noise = result.boards.find(({ lens }) => lens === "noise");
    expect(noise?.failure).toBeUndefined();
    expect(noise?.absence, "the complement is not empty, so this lane runs a seat").toBeUndefined();

    // The members ARE on the board the pipeline wrote, and each one's citation is followed
    // to the `code_ref` beside it rather than counted: a count says the host placed
    // something, and what 3.8 claims is WHICH regions it placed.
    const board = noise?.board;
    const members = board?.elements.filter((element) => element.kind === "noise_verdict") ?? [];
    const pathOf = (member: DraftBoard["elements"][number]): string | undefined => {
      const hunk = (member.data as { hunk?: unknown }).hunk;
      const cited = board?.elements.find((element) => element.id === hunk);
      return (cited?.data as { path?: unknown } | undefined)?.path as string | undefined;
    };
    expect(members.map(pathOf)).toEqual([UNCITED_REGION.path]);
    // …and the region a sibling cited is on no member of this board. Asserted as its own
    // line, because "one member, and it is the uncited one" and "the cited one is absent"
    // fail differently: a derivation that placed both would fail the first, and one that
    // placed neither would fail it too while passing this.
    expect(members.map(pathOf)).not.toContain(CITED.path);

    // Host-stamped, not seat-authored (D16f). Both are constants once membership is a
    // position, so neither is on any tool input and the seat could not have written them.
    for (const member of members) {
      expect(member.data).toMatchObject({ verdict: "noise", judge: "deterministic" });
    }
    // The seat ran and grouped them, so this is the placement reaching a SETTLED board
    // rather than a writer read before anyone touched it.
    expect(seatTurns.map(({ seat }) => seat)).toContain("noise");
  });

  it("settles no-noise with NO seat dispatched when the four lanes cite every region (3.11, D16e)", async () => {
    // Task 3.11's own required control, which did not exist. Every other fixture in this
    // file runs against `UNCITED_REGION` — a region no board cites — precisely so the Noise
    // lane HAS a remainder and its seat runs; that fixture choice is what left the
    // empty-complement arm bare, so this test supplies the opposite shape rather than
    // changing the shared one.
    //
    // D16e: when the four lanes between them cite every changed region, the host knows the
    // remainder is empty BEFORE any turn, so the lane settles `no-noise` with no seat at
    // all — the cheapest turn in the change, and the whole point of deriving membership
    // instead of asking a model for it. A Noise seat dispatched here would be a paid turn
    // to be told there is nothing to group.
    const seatTurns: SeatCapture[] = [];
    const result = await runLensPipeline({
      ...boardSeats(seatTurns, (prompt, label) => {
        const lens = lensFromPrompt(prompt, label);
        if (lens !== "sequence") return cleanBody(lens);
        // The one board that cites the fixture's only changed region, which makes the
        // complement empty by subtraction.
        const body = meaningfulSequenceBody();
        return {
          elements: [
            ...body.elements.map((element) =>
              element.id === "sequence-root"
                ? {
                    ...element,
                    data: { ...element.data, children: ["sequence-step", "uncited-ref"] },
                  }
                : element,
            ),
            {
              id: "uncited-ref",
              kind: "code_ref",
              data: {
                author: { kind: "lens-agent", id: "sequence-seat" },
                patchset_id: "ps-1",
                path: UNCITED_REGION.path,
                side: UNCITED_REGION.side,
                start_line: UNCITED_REGION.start,
                end_line: UNCITED_REGION.end,
              },
            },
          ],
        } as unknown as DraftBoard;
      }),
      repoRoot: "/pr-worktree",
      deltaPacket: PACKET,
      // The file inventory the citation resolves against. Without it the `code_ref` is
      // unresolvable, admissibility strips it, and the board cites nothing after all —
      // which would make this test pass or fail for a reason that is not the one written
      // above it.
      lintContextFor: (lens) => ({
        ...lintContextFor(lens),
        files: new Map([[UNCITED_REGION.path, 100]]),
      }),
      readPrompt,
      whiteboard: fakeWhiteboard([]),
      boardIdFor: (lens) => `board:${lens}`,
    });

    const sequence = result.boards.find(({ lens }) => lens === "sequence");
    expect(sequence?.failure, "the citing lane settled a board").toBeUndefined();
    expect(sequence?.boardId).toBeDefined();
    const noise = result.boards.find(({ lens }) => lens === "noise");
    expect(noise?.absence).toBe("no-noise");
    expect(noise?.failure).toBeUndefined();
    expect(noise?.boardId, "no board was written for a lane that ran no seat").toBeUndefined();
    // The load-bearing half: NO seat. A membership assertion alone passes over a pipeline
    // that dispatches the seat and then discards its board.
    const providerCalls = seatTurns.map(({ prompt }) => lensFromPrompt(prompt ?? ""));
    expect(providerCalls, "at least the other four lanes ran").not.toHaveLength(0);
    expect(providerCalls).not.toContain("noise");
    expect(
      seatTurns.filter(({ seat }) => seat === "noise"),
      "no thread was opened for the Noise seat either",
    ).toHaveLength(0);
  });

  it("classifies a lane that never settles across its ladder as TERMINAL", async () => {
    const result = await runLensPipeline({
      ...boardSeats([], (prompt, label) => {
        const lens = lensFromPrompt(prompt, label);
        // A turn that makes no calls at all, on every attempt including the retries.
        return lens === "noise" ? undefined : cleanBody(lens);
      }),
      repoRoot: "/pr-worktree",
      deltaPacket: PACKET,
      lintContextFor,
      readPrompt,
      whiteboard: fakeWhiteboard([]),
      boardIdFor: (lens) => `board:${lens}`,
    });

    const noise = result.boards.find(({ lens }) => lens === "noise");
    expect(noise?.failure).toContain("did not finish its board");
    expect(noise?.failureAccount?.classification).toBe("terminal");
    // The ladder is spent, so the account names a later attempt than the initial turn.
    expect(noise?.failureAccount?.attempt).toBeGreaterThan(0);
  });

  // The "hidden decision root" row is DELETED with this change rather than repaired: it
  // parented a section under a PROSE element, which the tool surface refuses at the call
  // (`a parent is a section or a step`). A board with that shape can no longer be written,
  // so a test asserting how the pipeline handles one is asserting about a state that does
  // not occur. The remaining rows keep their subject and gain the fact the tool path makes
  // visible — how much a shape costs, and which tier caught it.
  //
  // The two shapes cost different things, and that IS the two-tier split (D5). A board with
  // NO material of the lens's kind is refused by `finish` (`board-has-material`), so the
  // turn ends unsettled and spends the lane's one attempt: two turns. A board with material
  // that no served root REACHES is settled by `finish` — Decisions and Flagged have no
  // reachability rule — and fails afterwards, in the pipeline, on one turn.
  it.each([
    ["decisions", "prose-only", 2, () => proseOnlyBody("decisions", "No choices found.")],
    ["decisions", "orphan decision", 1, () => withoutRootSections(meaningfulDecisionBody())],
    ["flagged", "prose-only", 2, () => proseOnlyBody("flagged", "No defect found.")],
    [
      "flagged",
      "orphan finding",
      1,
      () => mkBoard([mkFinding("detached-finding", "A detached finding is not served.", [])]),
    ],
  ] as const)(
    "records a non-empty %s %s result as a precise failure, on one base prompt",
    async (malformedLens, _shape, expectedTurns, malformedBody) => {
      let malformedLensTurns = 0;
      const captures: SeatCapture[] = [];
      const applied: Applied[] = [];
      const arrivals: BoardArrivalEvent[] = [];
      const result = await runLensPipeline({
        ...boardSeats(captures, (prompt, label) => {
          const lens = lensFromPrompt(prompt, label);
          if (lens === "post-process") {
            const context = /rennet:layer context>>>\n(\{.*)/s.exec(prompt);
            return context ? (JSON.parse(context[1] as string).board as unknown) : { elements: [] };
          }
          if (lens === malformedLens) {
            malformedLensTurns += 1;
            return malformedBody();
          }
          return cleanBody(lens);
        }),
        repoRoot: "/pr-worktree",
        deltaPacket: PACKET,
        lintContextFor,
        readPrompt,
        whiteboard: fakeWhiteboard(applied),
        boardIdFor: (lens) => `board:${lens}`,
        onBoardArrival: (event) => {
          arrivals.push(event);
        },
      });

      const outcome = result.boards.find(({ lens }) => lens === malformedLens);
      // TWO turns, not one, and the second is the repair the budget pays for: the seat's
      // `finish` was refused, so its turn ended unsettled and spent the lane's one attempt.
      // What is asserted about NOT restarting the drafter is the count below — the base
      // prompt travels once, on the thread's first turn, and the repair carries the verdict
      // alone.
      expect(malformedLensTurns).toBe(expectedTurns);
      expect(
        captures.filter(({ prompt }) => prompt?.includes(`prompts/${malformedLens}.md`)),
      ).toHaveLength(1);
      expect(outcome?.absence).toBeUndefined();
      expect(outcome?.failure).toContain(
        expectedTurns === 1
          ? malformedLens === "decisions"
            ? "no reachable `decision` in the emitted board"
            : "no reachable `finding` in the emitted board"
          : "did not finish its board",
      );
      expect(applied.map(({ boardId }) => boardId)).not.toContain(`board:${malformedLens}`);
      expect(arrivals.map(({ lens }) => lens)).not.toContain(malformedLens);
    },
  );

  it.each([
    ["prose-only", () => proseOnlyBody("sequence", "Read the change in dependency order.")],
    ["orphan order_step", () => withoutRootSections(meaningfulSequenceBody())],
  ] as const)(
    "records a %s Sequence result as a precise failure, on one base prompt",
    async (_shape, sequenceBody) => {
      let sequenceTurns = 0;
      const captures: SeatCapture[] = [];
      const result = await runLensPipeline({
        ...boardSeats(captures, (prompt, label) => {
          const lens = lensFromPrompt(prompt, label);
          if (lens === "sequence") {
            sequenceTurns += 1;
            return sequenceBody();
          }
          if (lens === "post-process") {
            const context = /rennet:layer context>>>\n(\{.*)/s.exec(prompt);
            return context ? (JSON.parse(context[1] as string).board as unknown) : { elements: [] };
          }
          return cleanBody(lens);
        }),
        repoRoot: "/pr-worktree",
        deltaPacket: PACKET,
        lintContextFor,
        readPrompt,
        whiteboard: fakeWhiteboard([]),
        boardIdFor: (lens) => `board:${lens}`,
      });

      // Two turns, one base prompt: the second is the repair the lane's budget pays for.
      // BOTH Sequence shapes cost two, and for the same reason — Sequence is the one lens
      // whose reachability rule moved into the finish tier (D5), so a step no root reaches
      // is refused by `finish` exactly as an empty board is, rather than being settled and
      // failed afterwards.
      expect(sequenceTurns).toBe(2);
      expect(captures.filter(({ prompt }) => prompt?.includes("prompts/sequence.md"))).toHaveLength(
        1,
      );
      expect(result.boards.find(({ lens }) => lens === "sequence")?.failure).toContain(
        "did not finish its board",
      );
    },
  );

  it.each([
    ["sequence", "order_step", "Reading order", meaningfulSequenceBody],
    ["decisions", "decision", "Implementation decisions", meaningfulDecisionBody],
    ["flagged", "finding", "Findings", meaningfulFlaggedBody],
  ] as const)(
    "keeps a %s board whose served root reaches a real %s element",
    async (lensUnderTest, kind, rootTitle, body) => {
      const applied: Applied[] = [];
      const result = await runLensPipeline({
        ...boardSeats([], (prompt, label) => {
          const lens = lensFromPrompt(prompt, label);
          if (lens === "post-process") {
            const context = /rennet:layer context>>>\n(\{.*)/s.exec(prompt);
            return context ? (JSON.parse(context[1] as string).board as unknown) : { elements: [] };
          }
          return lens === lensUnderTest ? body() : cleanBody(lens);
        }),
        repoRoot: "/pr-worktree",
        deltaPacket: PACKET,
        lintContextFor,
        readPrompt,
        whiteboard: fakeWhiteboard(applied),
        boardIdFor: (lens) => `board:${lens}`,
      });

      const outcome = result.boards.find(({ lens }) => lens === lensUnderTest);
      const material = outcome?.board?.elements.find((element) => element.kind === kind);
      // The root is found by its TITLE, not by a fixture id: the host mints every id now,
      // so an assertion keyed on the fixture's own id would be asserting about a board
      // nobody wrote. The parenting is the property under test either way.
      const root = outcome?.board?.elements.find(
        (element) =>
          element.kind === "section" && (element.data as { title?: unknown }).title === rootTitle,
      );
      expect(outcome?.absence).toBeUndefined();
      expect(material).toBeDefined();
      expect(root, `no \`${rootTitle}\` section on the ${lensUnderTest} board`).toBeDefined();
      expect(root?.kind === "section" ? root.data.children : []).toContain(material?.id);
      expect(applied.map(({ boardId }) => boardId)).toContain(`board:${lensUnderTest}`);
    },
  );

  it.each(["design", "sequence"] as const)(
    "records an empty required %s lane as a precise failure, on one base prompt",
    async (requiredLens) => {
      let requiredTurns = 0;
      const arrivals: BoardArrivalEvent[] = [];
      const result = await runLensPipeline({
        ...boardSeats([], (prompt, label) => {
          const lens = lensFromPrompt(prompt, label);
          if (lens === requiredLens) {
            requiredTurns += 1;
            return { elements: [] };
          }
          if (lens === "post-process" && prompt.includes('"elements":[]')) {
            return { elements: [] };
          }
          return cleanBody(lens);
        }),
        repoRoot: "/pr-worktree",
        deltaPacket: PACKET,
        lintContextFor,
        readPrompt,
        whiteboard: fakeWhiteboard([]),
        boardIdFor: (lens) => `board:${lens}`,
        onBoardArrival: (event) => {
          arrivals.push(event);
        },
      });

      // Two turns, one base prompt: `finish` refused the empty board, the turn ended
      // unsettled and spent the lane's one attempt, and the repair carried the verdict.
      expect(requiredTurns).toBe(2);
      expect(result.boards.find(({ lens }) => lens === requiredLens)?.failure).toContain(
        "did not finish its board",
      );
      expect(arrivals.map(({ lens }) => lens)).not.toContain(requiredLens);
    },
  );

  // DELETED with this change: "keeps a valid Design board when the envelope also carries
  // an absence claim" and "refuses a PARTIAL board wearing an absence key". Both were about
  // the shape of Design's structured-output ENVELOPE — a single object that had to carry
  // either a board or `{ absence: "no-spec" }`, held disjoint at the host because the wire
  // could not hold a union (#810). No envelope travels now: the Design seat carries no
  // output schema, writes its board through tools, and declares its absence by calling
  // `settle_absent`. A board and an absence claim cannot arrive in the same value because
  // there is no value. The property the second test protected — that half a board is not an
  // absence — is now structural: `settle_absent` settles the voice absent and any later
  // authoring call reopens it, so a seat that wrote elements has not declared an absence.

  it("keeps a requirement's trace and the code_ref it cites on the written board", async () => {
    // The host used to strip `trace`, `related_files`, `coverage` and `tests` because a
    // coverage-mapping turn owned them. That turn and its gate are gone (D5), so `trace`
    // is what it says in the schema — the code_refs the requirement cites — and citation
    // lint judges them like any other. Stripping them here lost real citations silently.
    const applied: Applied[] = [];
    const result = await runLensPipeline({
      ...boardSeats([], (prompt, label) => {
        const lens = lensFromPrompt(prompt, label);
        return lens === "design" ? designBody() : cleanBody(lens);
      }),
      repoRoot: "/pr-worktree",
      deltaPacket: DESIGN_PACKET,
      lintContextFor: (lens) => ({
        lens,
        regions: [
          { path: DESIGN_SOURCE, side: "head", start: 1, end: 20 },
          { path: "src/auth.ts", side: "head", start: 1, end: 40 },
        ],
        files: new Map([
          [DESIGN_SOURCE, 20],
          ["src/auth.ts", 40],
        ]),
        patchsetId: PACKET.patchset.id,
      }),
      readPrompt,
      whiteboard: fakeWhiteboard(applied),
      boardIdFor: (lens) => `board:${lens}`,
    });

    const board = result.boards.find(({ lens }) => lens === "design")?.board;
    const requirement = elementWhere(board, "requirement", "name", "Refresh before retry")?.data as
      | { trace?: string[]; related_files?: unknown }
      | undefined;
    expect(requirement?.related_files).toEqual(["src/auth.ts", "src/auth.test.ts"]);
    // The trace names ONE code_ref, and that code_ref is on the board pointing at the file
    // the fixture cited. Asserted through the reference rather than by id, because the id
    // is the host's — and following the reference is the stronger claim anyway: it says the
    // citation resolves on the board that shipped, not merely that a string survived.
    expect(requirement?.trace).toHaveLength(1);
    const traced = board?.elements.find(({ id }) => id === requirement?.trace?.[0]);
    expect(traced?.kind).toBe("code_ref");
    expect((traced?.data as { path?: unknown } | undefined)?.path).toBe("src/auth.ts");
  });

  it("keeps Design title, source navigation, stats, and verbatim scenarios without a rewrite turn", async () => {
    const bodyFor = (prompt: string, label?: string): unknown => {
      const lens = lensFromPrompt(prompt, label);
      if (lens === "design") {
        const drafted = designBody();
        return {
          ...drafted,
          elements: [
            ...drafted.elements.map((element) =>
              element.id === "auth-section"
                ? {
                    ...element,
                    data: {
                      ...element.data,
                      children: ["auth-added-requirements", "task-group"],
                    },
                  }
                : element,
            ),
            {
              id: "task-group",
              kind: "section",
              data: {
                author: { kind: "lens-agent", id: "design-seat" },
                title: "Delivery",
                children: ["task-copy"],
              },
            },
            {
              id: "task-copy",
              kind: "prose",
              data: {
                author: { kind: "lens-agent", id: "design-seat" },
                markdown: "- [ ] Prove restart recovery",
              },
            },
          ],
          document: {
            title: "token-refresh",
            introMarkdown: "Why the refresh order changes.",
            measure: "structured",
            sources: [
              {
                path: DESIGN_SOURCE,
                candidate: "candidate-1",
                label: "auth spec",
                line: 1,
              },
            ],
            stats: [
              { label: "Format", value: "OpenSpec" },
              { label: "Requirements", value: "1" },
              { label: "Capabilities", value: "1 new / 0 modified" },
            ],
          },
        };
      }
      if (lens === "post-process") {
        const context = /rennet:layer context>>>\n(\{.*)/s.exec(prompt);
        const board = context ? (JSON.parse(context[1] as string).board as DraftBoard) : undefined;
        if (board?.document?.title !== "token-refresh") return board ?? { elements: [] };
        return {
          ...board,
          document: {
            ...board.document,
            title: "Billing",
            sources: [{ path: "invented.md", label: "invented" }],
            stats: [{ label: "Tasks", value: "3/3" }],
          },
          elements: board.elements
            .filter((element) => element.id !== "task-copy")
            .map((element) =>
              element.id === "scenario-expired"
                ? { ...element, data: { ...element.data, markdown: "A summarized scenario." } }
                : element.id === "requirement-refresh"
                  ? {
                      ...element,
                      data: {
                        ...element.data,
                        shall: "The editor invented this requirement.",
                        source: { path: "invented.md" },
                        related_files: ["src/invented.ts"],
                      },
                    }
                  : element.id === "task-group"
                    ? { ...element, data: { ...element.data, children: [] } }
                    : element.id === "auth-section"
                      ? {
                          ...element,
                          data: {
                            ...element.data,
                            children: ["requirement-refresh", "scenario-expired"],
                            sources: [{ path: "invented.md" }],
                            spec_delta: "removed",
                          },
                        }
                      : element,
            ),
        };
      }
      return cleanBody(lens);
    };

    const result = await runLensPipeline({
      ...boardSeats([], bodyFor),
      repoRoot: "/pr-worktree",
      deltaPacket: DESIGN_PACKET,
      lintContextFor: (lens) => ({
        lens,
        regions: [
          { path: DESIGN_SOURCE, side: "head", start: 1, end: 20 },
          { path: "src/auth.ts", side: "head", start: 1, end: 100 },
          { path: "src/auth.test.ts", side: "head", start: 1, end: 100 },
        ],
        files: new Map([
          [DESIGN_SOURCE, 20],
          ["src/auth.ts", 100],
          ["src/auth.test.ts", 100],
        ]),
        patchsetId: PACKET.patchset.id,
      }),
      readPrompt,
      whiteboard: fakeWhiteboard([]),
      boardIdFor: (lens) => `board:${lens}`,
    });

    const board = result.boards.find(({ lens }) => lens === "design")?.board;
    expect(board?.document?.title).toBe("token-refresh");
    // A LIST of source refs carries its paths alone (D3): parallel arrays are aligned by
    // index and every extra part is one more way to misalign them, so `sources` flattens to
    // `source_paths` and the label, candidate and line of a list entry are not on the tool
    // input at all. This is what the seat can now say about a document's sources, and the
    // change from the four-part entry is deliberate rather than a loss to repair.
    expect(board?.document?.sources).toEqual([{ path: DESIGN_SOURCE }]);
    // `stats` keeps both of its parts, because a label with no value is not a stat.
    expect(board?.document?.stats).toEqual([
      { label: "Format", value: "OpenSpec" },
      { label: "Requirements", value: "1" },
      { label: "Capabilities", value: "1 new / 0 modified" },
    ]);
    expect(elementWhere(board, "section", "title", "Auth")?.data).toMatchObject({
      sources: [{ path: DESIGN_SOURCE }],
      spec_delta: "added",
    });
    expect(elementWhere(board, "section", "title", "ADDED Requirements")?.data).toMatchObject({
      title: "ADDED Requirements",
      spec_delta: "added",
    });
    const requirement = elementWhere(board, "requirement", "name", "Refresh before retry")?.data;
    // The SINGLE-valued `source` keeps its whole triple: candidate and line are load-bearing
    // where there is no index to align them against.
    expect(requirement).toMatchObject({
      shall: "The system SHALL refresh the token before classifying an error.",
      source: { path: DESIGN_SOURCE, candidate: "candidate-1", line: 3 },
    });
    // `related_files` and `trace` are the seat's own citations now — nothing strips them.
    expect(requirement).toHaveProperty("related_files", ["src/auth.ts", "src/auth.test.ts"]);
    // The scenario's prose rides through verbatim: the host used to parse WHEN/THEN out of
    // a bundle's artifact text and stamp it, and nothing stamps or strips it now.
    //
    // `scenario_clauses` does NOT ride with it any more, and the change is named here
    // rather than left to be discovered. `prose` authors exactly one field in
    // `AUTHORED_BOARD_SCHEMA` — `markdown` — so the tool surface derived from that table
    // has no input to carry the clause pair on, and a seat cannot write one. The document
    // path let it through because it parsed a whole returned board rather than a per-kind
    // input. What the reader loses is the two-column Trigger/Outcome rendering; the
    // scenario itself still renders, as the prose the seat wrote, because
    // `RequirementElement` falls back to it when the clauses are absent. Restoring the
    // refinement means a flattening row in the tool surface (`scenario_condition` /
    // `scenario_response`), which is that surface's own change and not this one.
    const scenario = board?.elements.find(
      (element) =>
        element.kind === "prose" &&
        String((element.data as { markdown?: unknown }).markdown ?? "").startsWith(
          "Scenario: Expired token",
        ),
    );
    expect(scenario?.data).toMatchObject({
      markdown:
        "Scenario: Expired token\n\nWHEN a request uses an expired token\nTHEN the client refreshes it before retrying.",
    });
    expect(scenario?.data).not.toHaveProperty("scenario_clauses");
    const delivery = elementWhere(board, "section", "title", "Delivery");
    const copy = board?.elements.find(
      (element) =>
        element.kind === "prose" &&
        (element.data as { markdown?: unknown }).markdown === "- [ ] Prove restart recovery",
    );
    expect(copy).toBeDefined();
    expect((delivery?.data as { children?: unknown } | undefined)?.children).toEqual([copy?.id]);
  });

  it("keeps source-backed typed roots in drafter order without a rewrite turn", async () => {
    const bodyFor = (prompt: string, label?: string): unknown => {
      const lens = lensFromPrompt(prompt, label);
      if (lens === "design") {
        const drafted = designBody();
        return {
          ...drafted,
          elements: [
            ...drafted.elements,
            {
              id: "delivery-section",
              kind: "section",
              data: {
                author: { kind: "lens-agent", id: "design-seat" },
                title: "Delivery",
                children: ["delivery-copy"],
                sources: [{ path: DESIGN_SOURCE, candidate: "candidate-1", line: 10 }],
              },
            },
            {
              id: "delivery-copy",
              kind: "prose",
              data: {
                author: { kind: "lens-agent", id: "design-seat" },
                markdown: "The implementation follows the source-defined delivery sequence.",
              },
            },
          ],
        };
      }
      if (lens !== "post-process") return cleanBody(lens);

      const context = /rennet:layer context>>>\n(\{.*)/s.exec(prompt);
      const board = context ? (JSON.parse(context[1] as string).board as DraftBoard) : undefined;
      if (board?.document?.title !== "token-refresh") return board ?? { elements: [] };
      const byId = new Map(board.elements.map((element) => [element.id, element]));
      const delivery = byId.get("delivery-section");
      const authentication = byId.get("auth-section");
      if (delivery === undefined || authentication === undefined) return board;
      return {
        ...board,
        elements: [
          {
            ...delivery,
            data: { ...delivery.data, children: ["scenario-expired"] },
          },
          {
            ...authentication,
            data: { ...authentication.data, children: ["delivery-copy"] },
          },
          ...board.elements.filter(({ id }) => id !== "auth-section" && id !== "delivery-section"),
        ],
      };
    };

    const result = await runLensPipeline({
      ...boardSeats([], bodyFor),
      repoRoot: "/pr-worktree",
      deltaPacket: DESIGN_PACKET,
      lintContextFor: (lens) => ({
        lens,
        regions: [
          { path: DESIGN_SOURCE, side: "head", start: 1, end: 20 },
          { path: "src/auth.ts", side: "head", start: 1, end: 100 },
          { path: "src/auth.test.ts", side: "head", start: 1, end: 100 },
        ],
        files: new Map([
          [DESIGN_SOURCE, 20],
          ["src/auth.ts", 100],
          ["src/auth.test.ts", 100],
        ]),
        patchsetId: PACKET.patchset.id,
      }),
      readPrompt,
      whiteboard: fakeWhiteboard([]),
      boardIdFor: (lens) => `board:${lens}`,
    });

    const board = result.boards.find(({ lens }) => lens === "design")?.board;
    // Drafter order, read off the board by TITLE: the seat wrote Auth before Delivery and
    // the board holds them in that order.
    expect(
      board?.elements
        .filter(
          (element) =>
            element.kind === "section" &&
            ["Auth", "Delivery"].includes(
              String((element.data as { title?: unknown }).title ?? ""),
            ),
        )
        .map((element) => (element.data as { title?: unknown }).title),
    ).toEqual(["Auth", "Delivery"]);
    const authRequirements = elementWhere(board, "section", "title", "ADDED Requirements");
    expect(elementWhere(board, "section", "title", "Auth")?.data).toMatchObject({
      children: [authRequirements?.id],
      spec_delta: "added",
    });
    const deliveryCopy = board?.elements.find(
      (element) =>
        element.kind === "prose" &&
        (element.data as { markdown?: unknown }).markdown ===
          "The implementation follows the source-defined delivery sequence.",
    );
    expect(elementWhere(board, "section", "title", "Delivery")?.data).toMatchObject({
      children: [deliveryCopy?.id],
    });
  });

  it("never runs the poisoned Design rewrite turn", async () => {
    const captures: SeatCapture[] = [];
    const bodyFor = (prompt: string, label?: string): unknown => {
      const lens = lensFromPrompt(prompt, label);
      if (lens === "design") {
        const board = designBody();
        return {
          ...board,
          elements: [
            ...board.elements,
            {
              id: "drafter-structure",
              kind: "section",
              data: {
                author: { kind: "lens-agent", id: "design-seat" },
                title: "Implementation context",
                children: [],
              },
            },
          ],
        };
      }
      if (lens !== "post-process") return cleanBody(lens);

      const context = /rennet:layer context>>>\n(\{.*)/s.exec(prompt);
      const board = context ? (JSON.parse(context[1] as string).board as DraftBoard) : undefined;
      if (board?.document?.title !== "token-refresh") return board ?? { elements: [] };
      return {
        ...board,
        elements: [
          ...board.elements.filter(({ id }) => id !== "drafter-structure"),
          {
            id: "editor-forged-decision",
            kind: "decision",
            data: {
              author: { kind: "lens-agent", id: "board-post-process" },
              statement: "Ship the editor's invented behavior.",
              evidence: [],
              alternatives: [],
              why: "The prose editor asserted it.",
            },
          },
          {
            id: "editor-connective-prose",
            kind: "prose",
            data: {
              author: { kind: "lens-agent", id: "board-post-process" },
              markdown: "The implementation follows the source-defined refresh sequence.",
            },
          },
        ],
      };
    };

    const result = await runLensPipeline({
      ...boardSeats(captures, bodyFor),
      repoRoot: "/pr-worktree",
      deltaPacket: DESIGN_PACKET,
      lintContextFor: (lens) => ({
        lens,
        regions: [
          { path: DESIGN_SOURCE, side: "head", start: 1, end: 20 },
          { path: "src/auth.ts", side: "head", start: 1, end: 100 },
          { path: "src/auth.test.ts", side: "head", start: 1, end: 100 },
        ],
        files: new Map([
          [DESIGN_SOURCE, 20],
          ["src/auth.ts", 100],
          ["src/auth.test.ts", 100],
        ]),
        patchsetId: PACKET.patchset.id,
      }),
      readPrompt,
      whiteboard: fakeWhiteboard([]),
      boardIdFor: (lens) => `board:${lens}`,
    });

    const design = result.boards.find(({ lens }) => lens === "design");
    // Nothing the post-process arm of the fixture would have written is on the board, and
    // the seat's own section is, unchanged.
    expect(design?.board?.elements.some(({ kind }) => kind === "decision")).toBe(false);
    expect(
      elementWhere(design?.board, "section", "title", "Implementation context")?.data,
    ).toMatchObject({ title: "Implementation context", children: [] });
    expect(
      design?.board?.elements.some(
        (element) =>
          (element.data as { markdown?: unknown }).markdown ===
          "The implementation follows the source-defined refresh sequence.",
      ),
    ).toBe(false);
    expect(captures.some(({ prompt }) => lensFromPrompt(prompt ?? "") === "post-process")).toBe(
      false,
    );
    expect(design?.immutability).toEqual([]);
  });

  it("seeds each drafter turn with the lens prompt and the reviewed range, and NOT the packet or the host schema (#737)", async () => {
    const captures: SeatCapture[] = [];
    await runLensPipeline({
      ...boardSeats(captures, (p, label) => cleanBody(lensFromPrompt(p, label))),
      repoRoot: "/pr-worktree",
      deltaPacket: PACKET,
      lintContextFor,
      readPrompt,
      whiteboard: fakeWhiteboard([]),
      boardIdFor: (lens) => `board:${lens}`,
    });
    const designTurn = captures.find((c) => c.prompt?.includes("design.md"))?.prompt ?? "";
    expect(designTurn).toContain("PROMPT_FILE:prompts/design.md"); // the lens prompt
    // The DeltaPacket does NOT ride any more (session-context-files): the seat's cwd is
    // the reviewed checkout and it runs the diff itself. `ps-1` is the packet's patchset
    // id — it was the marker the inlined payload was recognised by, and its absence is
    // what says the payload is gone.
    expect(designTurn).not.toContain("ps-1");
    expect(inlineContextViolation(designTurn)).toBeUndefined();
    // The board schema travels ONCE, as the SDK `outputFormat` (#737); never as prompt text.
    expect(designTurn).not.toContain("hostSchema");
    // The shared partial is spliced by the PRODUCTION read path: its body is in the turn and
    // the marker is not. Delete the `expandPromptPartials` call in `runLensPipeline` and this
    // reddens (the marker would ride raw and the body would be absent).
    expect(designTurn).toContain(PARTIAL_BODY);
    expect(designTurn).not.toContain(PROMPT_PARTIAL_MARKER);
  });

  it("council-routes each seat to the right model (claude-only scenario)", async () => {
    const captures: SeatCapture[] = [];
    const applied: Applied[] = [];

    await runLensPipeline({
      ...boardSeats(captures, (p, label) => cleanBody(lensFromPrompt(p, label))),
      repoRoot: "/pr-worktree",
      deltaPacket: PACKET,
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
    expect(modelFor("prompts/flagged.md")).toBe("opus-4.8"); // Opus, not Sonnet (Rai, 2026-09-03)
  });

  it("leaves the cross-seat marks OFF the board while one voice is still writing (3.4)", async () => {
    // Task 3.4's stated control, which existed in no form: the positive half — both voices
    // settled, both models tallied — is proven by the dual-seat test below, and the
    // NEGATIVE half was not. Replacing `stampVoiceConcurrence(lane.board(), labelFor)` with
    // a bare `lane.board()` left the whole server suite green, because nothing anywhere
    // read a Flagged board that had NOT been through a fold.
    //
    // The shape: the Claude voice writes a finding and settles; the Codex voice writes one
    // and its turn ENDS without finishing, on every attempt, so it never settles and no
    // fold may run. What the board must then say is what actually happened — each finding
    // credited to the voice that wrote it, and NO `accord`, because there was no agreement
    // to report. A board that came back carrying `concur` here would be claiming a second
    // opinion from a seat that never gave one.
    const seatTurns: SeatCapture[] = [];
    const flaggedCtx: LintContext = {
      lens: "flagged",
      regions: [
        { path: "src/auth.ts", side: "head", start: 10, end: 14 },
        { path: "src/util.ts", side: "head", start: 1, end: 3 },
      ],
      files: new Map([
        ["src/auth.ts", 200],
        ["src/util.ts", 50],
      ]),
      patchsetId: PACKET.patchset.id,
    };
    const CLAUDE_CONCERN = "The refresh token is classified as an error before its code is read.";
    const CODEX_CONCERN = "A different concern, in a different file, from the seat that died.";

    const result = await runLensPipeline({
      ...boardSeats(
        seatTurns,
        (prompt, label) => {
          const lens = lensFromPrompt(prompt, label);
          if (lens !== "flagged") return cleanBody(lens);
          if (label === "flagged-codex") {
            // Writes, then STOPS. No `finish`, no settle-absent: the turn ends unsettled,
            // which is the one event that spends an attempt — and this voice never settles.
            return (voice: BoardVoiceWriter): void => {
              const cited = idOf(
                voice.call("cite", {
                  path: "src/util.ts",
                  side: "head",
                  start_line: 1,
                  end_line: 3,
                }),
              );
              okCall(
                voice.call("add_finding", {
                  severity: "medium",
                  concern: CODEX_CONCERN,
                  code_ref_ids: [cited],
                }),
              );
            };
          }
          return (voice: BoardVoiceWriter): void => {
            const root = idOf(voice.call("add_section", { title: "Findings" }));
            const cited = idOf(
              voice.call("cite", {
                path: "src/auth.ts",
                side: "head",
                start_line: 11,
                end_line: 12,
              }),
            );
            okCall(
              voice.call("add_finding", {
                severity: "high",
                concern: CLAUDE_CONCERN,
                code_ref_ids: [cited],
                parent_id: root,
              }),
            );
            okCall(voice.call("finish"));
          };
        },
        ["claude-code", "codex"],
      ),
      repoRoot: "/pr-worktree",
      deltaPacket: PACKET,
      lintContextFor: (lens) => (lens === "flagged" ? flaggedCtx : lintContextFor(lens)),
      readPrompt,
      whiteboard: fakeWhiteboard([]),
      boardIdFor: (lens) => `board:${lens}`,
    });

    const flagged = result.boards.find(({ lens }) => lens === "flagged");
    // The lane still settles: one seat finished, and one seat that never did is a degrade,
    // not a lane failure.
    expect(flagged?.failure).toBeUndefined();
    const board = flagged?.board as DraftBoard | undefined;
    const findingBy = (concern: string): string =>
      board?.elements.find(
        (element) =>
          element.kind === "finding" && (element.data as { concern?: unknown }).concern === concern,
      )?.id ?? "";
    const claudeFinding = findingBy(CLAUDE_CONCERN);
    const codexFinding = findingBy(CODEX_CONCERN);

    // BOTH findings are on the one board — the unsettled voice's work is kept, not
    // discarded, which is the same partial-board rule the repair path relies on.
    expect(claudeFinding, "the settled voice's finding is missing").not.toBe("");
    expect(codexFinding, "the unsettled voice's finding was discarded").not.toBe("");

    // NO fold ran, so each finding names ONLY the voice that wrote it…
    expect(concurrenceOf(board as DraftBoard, claudeFinding)).toEqual([
      { model: "Claude", agree: 1, total: 1 },
    ]);
    expect(concurrenceOf(board as DraftBoard, codexFinding)).toEqual([
      { model: "Codex", agree: 1, total: 1 },
    ]);
    // …and neither carries an `accord`, in either direction. `concur` would claim a second
    // opinion that never ran and `split` would name a disagreement with nobody, so the
    // honest mark is no mark at all.
    expect(accordOn(board as DraftBoard, claudeFinding)).toBeUndefined();
    expect(accordOn(board as DraftBoard, codexFinding)).toBeUndefined();

    // The credit is per VOICE, not one label over the board: the seat that died wrote a
    // finding, and reporting it under the survivor's model would credit a model that never
    // saw it. A single-label stamp passes every assertion above except this one.
    expect(
      concurrenceOf(board as DraftBoard, codexFinding).map(({ model }) => model),
    ).not.toContain("Claude");
  });

  it("runs the Flagged lens as a dual seat under both harnesses — cross-model concurrence", async () => {
    // Both seats are SIDECAR THREADS after session-bound-workspace 5.7 — one on
    // `provider: "claudeAgent"`, one on `"codex"`, through T3's model selection. The lane
    // still holds two seats; what it no longer holds is two harness ports.
    const seatTurns: SeatCapture[] = [];
    const applied: Applied[] = [];

    // A clean flagged board both seats return: a grounded finding citing c1 (covers
    // h1), h2 consciously skipped — passes the flagged lens lint.
    const flaggedBody = (): unknown =>
      mkBoard([
        mkFinding("f1", "The refresh token is classified as an error before its code is read.", [
          "c1",
        ]),
        mkCodeRef("c1", "src/auth.ts", 11, 12),
        mkSection("findings", "Findings", ["f1"]),
      ]);
    const bodyFor = (prompt: string, label?: string): unknown => {
      const lens = lensFromPrompt(prompt, label);
      if (lens === "flagged") return flaggedBody();
      if (lens === "post-process") {
        const ctx = /rennet:layer context>>>\n(\{.*)/s.exec(prompt);
        return ctx ? (JSON.parse(ctx[1] as string).board as unknown) : { elements: [] };
      }
      return cleanBody(lens);
    };
    const flaggedCtx: LintContext = {
      lens: "flagged",
      regions: [
        { path: "src/auth.ts", side: "head", start: 10, end: 14 },
        { path: "src/util.ts", side: "head", start: 1, end: 3 },
      ],
      files: new Map([
        ["src/auth.ts", 200],
        ["src/util.ts", 50],
      ]),
      patchsetId: PACKET.patchset.id,
    };

    const result = await runLensPipeline({
      ...boardSeats(seatTurns, bodyFor, ["claude-code", "codex"]),
      repoRoot: "/pr-worktree",
      deltaPacket: PACKET,
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
    // Each seat was forced to its own provider's flagged pick, on its own thread: the
    // Claude seat's thread is bound `provider: "claudeAgent"`, the Codex seat's `"codex"`,
    // which is how one lane holds two providers on one sidecar.
    expect(
      seatTurns.some(
        (c) =>
          c.seat === "flagged-claude" && c.provider === "claudeAgent" && c.model === "opus-4.8",
      ),
    ).toBe(true);
    expect(
      seatTurns.some(
        (c) => c.seat === "flagged-codex" && c.provider === "codex" && c.model === "gpt-5.6-sol",
      ),
    ).toBe(true);
    const providerCalls = seatTurns.map(({ prompt }) => lensFromPrompt(prompt ?? ""));
    expect(providerCalls).toHaveLength(6);
    expect(
      Object.fromEntries(
        ["design", "sequence", "decisions", "flagged", "noise"].map((lens) => [
          lens,
          providerCalls.filter((calledLens) => calledLens === lens).length,
        ]),
      ),
    ).toEqual({ design: 1, sequence: 1, decisions: 1, flagged: 2, noise: 1 });
    expect(providerCalls).not.toContain("post-process");
  });

  it("runs the round-report FIRST on a round and threads it into the lens drafters (D3/R58)", async () => {
    const captures: SeatCapture[] = [];
    const applied: Applied[] = [];
    const arrivals: BoardArrivalEvent[] = [];

    // A round: the packet carries a successor account ⇒ the report drafts first.
    const roundPacket = {
      patchset: { id: "ps-1", createdAt: "", truncated: false, files: [] },
      successorAccount: { asks: [] },
    } as unknown as DeltaPacket;

    await runLensPipeline({
      ...boardSeats(captures, (p, label) => cleanBody(lensFromPrompt(p, label))),
      repoRoot: "/pr-worktree",
      deltaPacket: roundPacket,
      lintContextFor,
      readPrompt,
      whiteboard: fakeWhiteboard(applied),
      boardIdFor: (lens) => `board:${lens}`,
      onBoardArrival: (event) => {
        arrivals.push(event);
      },
    });

    // The report board is written and announced BEFORE any lens board.
    expect(applied[0]?.boardId).toBe("board:report");
    expect(arrivals[0]?.lens).toBe("report");
    // The report seat routed to the round-report pick (claude-only ⇒ sonnet-5).
    expect(captures.find((c) => c.prompt?.includes("report.md"))?.model).toBe("sonnet-5");
    // The report reaches the lens drafters as `round.json`, never as prompt text
    // (session-context-files). This direct-call shape injects no writer, so nothing is
    // written and no lens prompt carries the report — asserted here only as the absence it
    // is; the positive threading (round.json holds the frozen report board, and every lens
    // turn runs after that write) is the ordering test further down this file.
    const lensPrompts = captures.filter((c) => c.prompt?.includes("design.md"));
    expect(lensPrompts.length).toBeGreaterThan(0);
    expect(lensPrompts.every((c) => !c.prompt?.includes("roundReport"))).toBe(true);
  });

  it("drafts a landed round report from one compact classification turn and host-owned structure", async () => {
    const captures: SeatCapture[] = [];
    const applied: Applied[] = [];
    const arrivals: BoardArrivalEvent[] = [];
    const diagnostics: RoundReportDiagnosticMilestone[] = [];
    // The first entry is the pipeline's own report-PHASE start (#725 7.4): it reads the
    // clock once before the report seat takes its baseline (100), so the six milestone
    // reads that follow are unchanged and the assertion below still pins them exactly.
    // The scripted clock the report gate reads. Two entries are consumed by the
    // `report-classification` phase record (#731 9.4), which brackets the turn on the SAME
    // injected clock — one read before `runTurn`, one after it settles. They sit where the
    // gate reads them so the DIAGNOSTIC elapsed sequence below is unchanged by the
    // measurement: a phase record that shifted the diagnostics would be observing the run
    // by altering it.
    const diagnosticTimes = [90, 100, 110, 110, 105, 120, 120, 115, 130, 125];
    const reportTimings: GenerationPhaseTiming[] = [];
    const contextFiles = new Map<string, SessionContextFile>();
    let reportTurns = 0;
    // Three hunks, so the round has three manifest entries and the classification can
    // partition them across an addressed ask, a partial ask, and one beyond entry.
    const workerDiff = [
      "diff --git a/src/auth.ts b/src/auth.ts",
      "--- a/src/auth.ts",
      "+++ b/src/auth.ts",
      "@@ -1 +1 @@",
      "-old first line",
      "+new first line",
      "@@ -10 +10 @@",
      "-old second line",
      "+new second line",
      "@@ -20 +20 @@",
      "-old neighbor line",
      "+new neighbor line",
    ].join("\n");
    const [firstEvidence, secondEvidence, neighborEvidence] = manifestIds(workerDiff);
    const round = {
      number: 2,
      previousGeneration: "gen:ps-0",
      dispatchedAsks: [
        {
          id: "ask-first",
          path: "src/auth.ts",
          type: "request-change" as const,
          instruction: "Replace the first line.",
          span: { startLine: 1, endLine: 1 },
          side: "additions" as const,
          context: "SECRET_STALE_PRIOR_DIFF_CONTEXT",
        },
        {
          id: "ask-second",
          path: "src/auth.ts",
          type: "request-change" as const,
          instruction: "Replace the second line.",
          context: "",
        },
      ],
      findingDispositions: {},
      worker: {
        outcome: "completed" as const,
        diff: workerDiff,
        changedPaths: ["src/auth.ts"],
        commitRange: { from: "before", to: "after" },
      },
    };

    const result = await runLensPipeline({
      ...boardSeats(captures, (prompt, label) => {
        const lens = lensFromPrompt(prompt, label);
        if (lens === "report") {
          reportTurns += 1;
          return {
            outcomes: [
              {
                askId: "ask-second",
                status: "partial",
                note: "The second line moved, but its follow-up remains.",
                evidenceIds: [secondEvidence],
              },
              {
                askId: "ask-first",
                status: "addressed",
                note: "The first line now carries the requested value.",
                evidenceIds: [firstEvidence],
              },
            ],
            beyond: [
              {
                ref: "beyond:first-line-cleanup",
                text: "Tighten the neighboring first-line wording.",
                note: "A neighboring line the asks never mentioned also changed.",
                evidenceIds: [neighborEvidence],
              },
            ],
          };
        }
        if (lens === "post-process") {
          const context = /rennet:layer context>>>\n(\{.*)/s.exec(prompt);
          return context ? (JSON.parse(context[1] as string).board as unknown) : { elements: [] };
        }
        return cleanBody(lens);
      }),
      repoRoot: "/pr-worktree",
      deltaPacket: {
        ...PACKET,
        packetOnly: { privatePacketSentinel: "MUST_NOT_REACH_REPORT" },
      } as unknown as DeltaPacket,
      currentGeneration: "gen:ps-1:dispatch:round-2",
      round,
      lintContextFor,
      readPrompt,
      whiteboard: fakeWhiteboard(applied),
      boardIdFor: (lens) => `board:${lens}`,
      writeContext: (files) => {
        for (const file of files) contextFiles.set(file.name, file);
        return ".rennet/context/s1";
      },
      onBoardArrival: (event) => {
        arrivals.push(event);
      },
      onReportDiagnostic: (milestone) => diagnostics.push(milestone),
      onPhaseTiming: (timing) => {
        reportTimings.push(timing);
      },
      now: () => diagnosticTimes.shift() ?? 125,
    });

    const reportCaptures = captures.filter(({ prompt }) => prompt?.includes("prompts/report.md"));
    expect(reportTurns).toBe(1);
    expect(reportCaptures).toHaveLength(1);
    expect(reportCaptures[0]?.model).toBe("sonnet-5");
    const outputSchema = reportCaptures[0]?.outputSchema;
    const reportSchema = JSON.stringify(outputSchema);
    expect(reportSchema).toContain('"askId"');
    expect(reportSchema).toContain('"evidenceIds"');
    expect(reportSchema).toContain('"beyond"');
    // No output shape can carry a line number: the host derives every anchor.
    expect(reportSchema).not.toContain('"startLine"');
    expect(reportSchema).not.toContain('"elements"');
    expect(reportSchema).not.toContain('"document"');
    expect(reportSchema).not.toContain('"round_outcome"');
    const schemaNodes: Record<string, unknown>[] = [];
    const collectSchemaNodes = (value: unknown): void => {
      if (value === null || typeof value !== "object") return;
      const node = value as Record<string, unknown>;
      schemaNodes.push(node);
      for (const child of Object.values(node)) {
        if (Array.isArray(child)) {
          for (const item of child) collectSchemaNodes(item);
        } else {
          collectSchemaNodes(child);
        }
      }
    };
    collectSchemaNodes(outputSchema);
    const branchFor = (status: string): Record<string, unknown> | undefined =>
      schemaNodes.find((node) => {
        const properties = node.properties as Record<string, unknown> | undefined;
        const statusSchema = properties?.status as Record<string, unknown> | undefined;
        return statusSchema?.const === status;
      });
    const addressedSchema = branchFor("addressed");
    const untouchedSchema = branchFor("untouched");
    expect(addressedSchema).toBeDefined();
    expect(untouchedSchema).toBeDefined();
    expect(addressedSchema?.required).toContain("evidenceIds");
    expect(untouchedSchema?.required).not.toContain("evidenceIds");
    expect(untouchedSchema?.properties).not.toHaveProperty("evidenceIds");
    expect(untouchedSchema?.additionalProperties).toBe(false);
    const reportPrompt = reportCaptures[0]?.prompt ?? "";
    // The evidence is a FILE the prompt names (session-bound-workspace 3.4). What the
    // classifier judges on is asserted on the written body; what the PROMPT carries is
    // asserted to be the path and nothing else, below.
    expect(reportPrompt).toContain(`\`.rennet/context/s1/${ROUND_EVIDENCE_FILE}\``);
    expect(inlineContextViolation(reportPrompt)).toBeUndefined();
    expect(JSON.parse(contextFiles.get(ROUND_EVIDENCE_FILE)?.body ?? "{}")).toEqual({
      patchsetId: "ps-1",
      dispatchedAsks: [
        {
          id: "ask-first",
          path: "src/auth.ts",
          instruction: "Replace the first line.",
          span: { startLine: 1, endLine: 1 },
          side: "additions",
        },
        { id: "ask-second", path: "src/auth.ts", instruction: "Replace the second line." },
      ],
      // The verbatim diff no longer crosses this boundary; the measured manifest does.
      worker: {
        outcome: "completed",
        changedPaths: ["src/auth.ts"],
        commitRange: { from: "before", to: "after" },
      },
      evidence: buildRoundEvidenceManifest(workerDiff),
    });
    expect(reportPrompt).not.toContain("hostSchema");
    expect(reportPrompt).not.toContain("deltaPacket");
    expect(reportPrompt).not.toContain("MUST_NOT_REACH_REPORT");
    expect(reportPrompt).not.toContain("SECRET_STALE_PRIOR_DIFF_CONTEXT");
    // Nor does the FILE carry the stale prior-diff context an ask happens to hold.
    expect(contextFiles.get(ROUND_EVIDENCE_FILE)?.body).not.toContain(
      "SECRET_STALE_PRIOR_DIFF_CONTEXT",
    );
    expect(diagnostics.map(({ stage }) => stage)).toEqual([
      "turn-started",
      "provider-settled",
      "turn-settled",
      "schema-parsed",
      "evidence-verified",
      "persisted",
    ]);
    expect(
      diagnostics.every(({ elapsedMs }) => Number.isInteger(elapsedMs) && elapsedMs >= 0),
    ).toBe(true);
    expect(diagnostics.map(({ elapsedMs }) => elapsedMs)).toEqual([10, 10, 20, 20, 30, 30]);

    // The report gate records TWO spans (#731 9.4): the whole gate, and the classification
    // turn inside it. Only the turn names an executor, because only the turn had one — the
    // gate also builds the evidence manifest, resolves the seat and verifies the result,
    // none of which a harness ran.
    const gate = reportTimings.find(({ phase }) => phase === "report");
    const classification = reportTimings.find(({ phase }) => phase === "report-classification");
    expect(gate?.harness).toBeUndefined();
    expect(classification?.harness).toBe("claude-code");
    expect(classification?.model).toBeDefined();
    // The turn is measured on the same wall clock as the rest, and sits INSIDE the gate.
    expect(classification?.startedAtMs).toBe(110);
    expect(classification?.durationMs).toBe(10);
    expect(gate?.startedAtMs).toBe(90);
    expect((gate?.startedAtMs ?? 0) + (gate?.durationMs ?? 0)).toBeGreaterThanOrEqual(
      (classification?.startedAtMs ?? 0) + (classification?.durationMs ?? 0),
    );
    expect(JSON.stringify(diagnostics)).not.toContain("SECRET_");
    expect(
      captures.filter(
        ({ prompt }) =>
          prompt?.includes("prompts/post-process.md") && prompt.includes('"kind":"round_outcome"'),
      ),
    ).toHaveLength(0);

    expect(applied[0]?.boardId).toBe("board:report");
    expect(arrivals[0]?.lens).toBe("report");
    const report = result.report?.board;
    expect(report?.document).toEqual({
      title: "Round report",
      introMarkdown: "Verified against the coding turn: 1 addressed, 1 partial, 1 beyond.",
      measure: "reading",
    });
    const outcomes = report?.elements.filter((element) => element.kind === "round_outcome") ?? [];
    expect(
      outcomes.map((element) => [element.data.status, element.data.ask.ref, element.data.ask.text]),
    ).toEqual([
      ["addressed", "ask-first", "Replace the first line."],
      ["partial", "ask-second", "Replace the second line."],
      ["beyond", "beyond:first-line-cleanup", "Tighten the neighboring first-line wording."],
    ]);
    // Every manifest id lands in exactly one outcome (#726), durably on the board.
    expect(outcomes.flatMap((element) => element.data.evidence_ids ?? []).sort()).toEqual(
      [firstEvidence, secondEvidence, neighborEvidence].sort(),
    );
    const addressed = outcomes[0];
    const addressedCodeRef =
      addressed?.kind === "round_outcome"
        ? report?.elements.find((element) => element.id === addressed.data.code_ref)
        : undefined;
    expect(addressedCodeRef).toMatchObject({
      kind: "code_ref",
      data: {
        patchset_id: "ps-1",
        path: "src/auth.ts",
        side: "head",
        start_line: 1,
        end_line: 1,
      },
    });
    const section = report?.elements.find((element) => element.kind === "section");
    expect(section?.kind === "section" ? section.data.children : []).toEqual(
      outcomes.map((element) => element.id),
    );
    // The frozen report reaches the lens drafters as `round.json` — NAMED, never carried.
    const designTurns = captures.filter(({ prompt }) => prompt?.includes("prompts/design.md"));
    expect(designTurns.length).toBeGreaterThan(0);
    for (const { prompt } of designTurns) {
      expect(prompt).toContain(`\`.rennet/context/s1/${ROUND_CONTEXT_FILE}\``);
      expect(prompt).not.toContain('"roundReport"');
    }
    const roundBody = JSON.parse(contextFiles.get(ROUND_CONTEXT_FILE)?.body ?? "{}") as {
      report?: { elements: unknown[] };
    };
    expect(roundBody.report?.elements.length).toBeGreaterThan(0);
  });

  it("awaits classified report handoff before starting any lens and aborts on rejection", async () => {
    const classification = {
      outcomes: [{ askId: "ask-one", status: "untouched", note: "No evidence for this ask." }],
      beyond: [
        {
          ref: "beyond:line",
          text: "An unrequested line change.",
          note: "The turn changed a line no ask asked for.",
          evidenceIds: [ONE_LINE_EVIDENCE],
        },
      ],
    };
    const round = {
      number: 1,
      previousGeneration: "gen:ps-0",
      dispatchedAsks: [
        {
          id: "ask-one",
          path: "src/auth.ts",
          type: "request-change" as const,
          instruction: "Replace the line.",
          context: "",
        },
      ],
      findingDispositions: {},
      worker: {
        outcome: "completed" as const,
        diff: ONE_LINE_DIFF,
        changedPaths: ["src/auth.ts"],
        commitRange: { from: "before", to: "after" },
      },
    };
    const start = (
      reportArrival: () => void | Promise<void>,
    ): {
      readonly run: Promise<Awaited<ReturnType<typeof runLensPipeline>>>;
      readonly lensTurns: () => number;
      readonly lensStarts: () => number;
    } => {
      let lensTurns = 0;
      let lensStarts = 0;
      return {
        run: runLensPipeline({
          ...boardSeats([], (prompt, label) => {
            if (lensFromPrompt(prompt, label) === "report") return classification;
            lensTurns += 1;
            return cleanBody(lensFromPrompt(prompt, label));
          }),
          repoRoot: "/pr-worktree",
          deltaPacket: PACKET,
          currentGeneration: "gen:ps-1:dispatch:handoff",
          round,
          lintContextFor,
          readPrompt,
          whiteboard: fakeWhiteboard([]),
          boardIdFor: (lens) => `board:${lens}`,
          onBoardArrival: (event) => (event.lens === "report" ? reportArrival() : undefined),
          onLensDraftingStart: () => {
            lensStarts += 1;
          },
        }),
        lensTurns: () => lensTurns,
        lensStarts: () => lensStarts,
      };
    };

    let releaseHandoff: () => void = () => undefined;
    const handoffGate = new Promise<void>((resolve) => {
      releaseHandoff = resolve;
    });
    let announceHandoff: () => void = () => undefined;
    const handoffStarted = new Promise<void>((resolve) => {
      announceHandoff = resolve;
    });
    const deferred = start(() => {
      announceHandoff();
      return handoffGate;
    });
    await handoffStarted;
    expect(deferred.lensStarts()).toBe(0);
    expect(deferred.lensTurns()).toBe(0);
    releaseHandoff();
    await deferred.run;
    expect(deferred.lensStarts()).toBe(1);
    expect(deferred.lensTurns()).toBeGreaterThan(0);

    const rejected = start(() => {
      throw new Error("report handoff rejected");
    });
    await expect(rejected.run).rejects.toThrow("report handoff rejected");
    expect(rejected.lensStarts()).toBe(0);
    expect(rejected.lensTurns()).toBe(0);
  });

  it("fails an over-budget evidence manifest with zero provider calls and no truncation", async () => {
    const applied: Applied[] = [];
    const captures: SeatCapture[] = [];
    // One hunk whose body alone exceeds the manifest budget: the round is honestly too
    // big to classify, which is a typed local failure, never a shortened manifest.
    const hugeDiff = [
      "diff --git a/src/huge.ts b/src/huge.ts",
      "--- a/src/huge.ts",
      "+++ b/src/huge.ts",
      "@@ -1 +1 @@",
      "-old",
      `+${"x".repeat(ROUND_EVIDENCE_MANIFEST_MAX_BYTES)}`,
    ].join("\n");

    const result = await runLensPipeline({
      ...boardSeats(captures, (prompt, label) => cleanBody(lensFromPrompt(prompt, label))),
      repoRoot: "/pr-worktree",
      deltaPacket: PACKET,
      currentGeneration: "gen:ps-1:dispatch:oversized",
      round: {
        number: 1,
        previousGeneration: "gen:ps-0",
        dispatchedAsks: [
          {
            id: "ask-one",
            path: "src/huge.ts",
            type: "request-change",
            instruction: "Rewrite the line.",
            context: "",
          },
        ],
        findingDispositions: {},
        worker: {
          outcome: "completed",
          diff: hugeDiff,
          changedPaths: ["src/huge.ts"],
          commitRange: { from: "before", to: "after" },
        },
      },
      lintContextFor,
      readPrompt,
      whiteboard: fakeWhiteboard(applied),
      boardIdFor: (lens) => `board:${lens}`,
    }).catch((error: unknown) => error as Error);

    const failure = result instanceof Error ? result.message : result.report?.failure;
    expect(failure).toContain(`over the ${ROUND_EVIDENCE_MANIFEST_MAX_BYTES}-byte limit`);
    expect(failure).toContain("classification was not attempted");
    // Zero provider calls: not one session was opened for any seat.
    expect(captures).toHaveLength(0);
    expect(applied).toHaveLength(0);
  });

  it("accepts the guarded one-line widget turn after one classification turn", async () => {
    const widgetDiff = [
      "diff --git a/src/widget.ts b/src/widget.ts",
      "--- a/src/widget.ts",
      "+++ b/src/widget.ts",
      "@@ -1 +1 @@",
      "-export const widget = 2;",
      "+export const widget = 3;",
    ].join("\n");
    let reportTurns = 0;
    const applied: Applied[] = [];
    const result = await runLensPipeline({
      ...boardSeats([], (prompt, label) => {
        const lens = lensFromPrompt(prompt, label);
        if (lens === "report") {
          reportTurns += 1;
          return {
            outcomes: [
              {
                askId: "ask-one",
                status: "addressed",
                note: "The exact changed line now carries the requested value.",
                evidenceIds: manifestIds(widgetDiff),
              },
            ],
            beyond: [],
          };
        }
        if (lens === "post-process") {
          const context = /rennet:layer context>>>\n(\{.*)/s.exec(prompt);
          return context ? (JSON.parse(context[1] as string).board as unknown) : { elements: [] };
        }
        return cleanBody(lens);
      }),
      repoRoot: "/pr-worktree",
      deltaPacket: PACKET,
      currentGeneration: "gen:ps-1:dispatch:one-line-positive",
      round: {
        number: 1,
        previousGeneration: "gen:ps-0",
        dispatchedAsks: [
          {
            id: "ask-one",
            path: "src/widget.ts",
            type: "request-change",
            instruction:
              "Replace entire src/widget.ts with export const widget = 3; newline, no other file.",
            context: "",
          },
        ],
        findingDispositions: {},
        worker: {
          outcome: "completed",
          diff: widgetDiff,
          changedPaths: ["src/widget.ts"],
          commitRange: { from: "before", to: "after" },
        },
      },
      lintContextFor,
      readPrompt,
      whiteboard: fakeWhiteboard(applied),
      boardIdFor: (lens) => `board:${lens}`,
    });

    expect(reportTurns).toBe(1);
    expect(result.report?.failure).toBeUndefined();
    expect(
      result.report?.board?.elements.find((element) => element.kind === "round_outcome"),
    ).toMatchObject({
      data: {
        status: "addressed",
        ask: {
          ref: "ask-one",
          text: "Replace entire src/widget.ts with export const widget = 3; newline, no other file.",
        },
      },
    });
    expect(applied[0]?.boardId).toBe("board:report");
  });

  it("removes metadata before replacing a semantically invalid reusable report", async () => {
    const order: string[] = [];
    let reportTurns = 0;
    const round = {
      number: 1,
      previousGeneration: "gen:ps-0",
      dispatchedAsks: [
        {
          id: "ask-one",
          path: "src/auth.ts",
          type: "request-change" as const,
          instruction: "Replace the line.",
          context: "",
        },
      ],
      findingDispositions: {},
      worker: {
        outcome: "completed" as const,
        diff: ONE_LINE_DIFF,
        changedPaths: ["src/auth.ts"],
        commitRange: { from: "before", to: "after" },
      },
    };
    const reusable: DraftBoard = {
      elements: [
        {
          id: "report-root",
          kind: "section",
          data: {
            author: { kind: "lens-agent", id: "round-report" },
            title: "Round outcomes",
            children: ["report-outcome"],
          },
        },
        {
          id: "report-code",
          kind: "code_ref",
          data: {
            author: { kind: "lens-agent", id: "round-report" },
            patchset_id: "ps-1",
            path: "src/auth.ts",
            side: "head",
            start_line: 99,
            end_line: 99,
          },
        },
        {
          id: "report-outcome",
          kind: "round_outcome",
          data: {
            author: { kind: "lens-agent", id: "round-report" },
            status: "addressed",
            ask: { ref: "ask-one", text: "Replace the line." },
            note: "The requested line changed.",
            code_ref: "report-code",
          },
        },
      ],
    };

    const result = await runLensPipeline({
      ...boardSeats([], (prompt, label) => {
        const lens = lensFromPrompt(prompt, label);
        if (lens === "report") {
          reportTurns += 1;
          return {
            outcomes: [
              {
                askId: "ask-one",
                status: "addressed",
                note: "The exact changed line now carries the requested value.",
                evidenceIds: [ONE_LINE_EVIDENCE],
              },
            ],
            beyond: [],
          };
        }
        if (lens === "post-process") {
          const context = /rennet:layer context>>>\n(\{.*)/s.exec(prompt);
          return context ? (JSON.parse(context[1] as string).board as unknown) : { elements: [] };
        }
        return cleanBody(lens);
      }),
      repoRoot: "/pr-worktree",
      deltaPacket: PACKET,
      currentGeneration: "gen:ps-1:dispatch:recovered",
      round,
      lintContextFor,
      readPrompt,
      whiteboard: {
        apply: async (boardId, ops, actor) => {
          if (boardId === "board:report") order.push(`apply:${actor}`);
          return { response: { ok: true }, ops } as never;
        },
      },
      boardIdFor: (lens) => `board:${lens}`,
      reusableRoundReport: {
        boardId: "board:report",
        board: reusable,
        omissions: [],
        blemishes: [],
        immutability: [],
      },
      removeBoardMeta: (boardId) => {
        order.push(`remove:${boardId}`);
      },
    });

    expect(reportTurns).toBe(1);
    expect(order.slice(0, 3)).toEqual([
      "remove:board:report",
      "apply:host:round-report-recovery",
      "apply:seat:report",
    ]);
    expect(result.report?.failure).toBeUndefined();
    expect(result.report?.boardId).toBe("board:report");
  });

  it.each([
    ["missing durable ask", { outcomes: [], beyond: [] }, "omitted dispatched asks: ask-one"],
    [
      "invented evidence id",
      {
        outcomes: [
          {
            askId: "ask-one",
            status: "addressed",
            note: "The exact changed line carries the request.",
            evidenceIds: ["ev-not-in-this-round"],
          },
        ],
        beyond: [],
      },
      "cites unknown evidence id ev-not-in-this-round",
    ],
    [
      "unplaced evidence",
      {
        outcomes: [
          {
            askId: "ask-one",
            status: "untouched",
            note: "The turn changed something, but not this ask.",
          },
        ],
        beyond: [],
      },
      "leaves evidence unplaced",
    ],
    [
      "evidence claimed twice",
      {
        outcomes: [
          {
            askId: "ask-one",
            status: "addressed",
            note: "The changed line carries the request.",
            evidenceIds: [ONE_LINE_EVIDENCE],
          },
        ],
        beyond: [
          {
            ref: "beyond:same-line",
            text: "The same line, claimed again.",
            note: "Double-counting the one change the turn made.",
            evidenceIds: [ONE_LINE_EVIDENCE],
          },
        ],
      },
      "in more than one bucket",
    ],
    [
      "addressed ask without required evidence",
      {
        outcomes: [
          {
            askId: "ask-one",
            status: "addressed",
            note: "The ask changed, but this claim cites nothing.",
          },
        ],
        beyond: [],
      },
      "classification output was invalid",
    ],
    [
      "untouched ask with forbidden evidence",
      {
        outcomes: [
          {
            askId: "ask-one",
            status: "untouched",
            note: "The exact diff does not establish the request.",
            evidenceIds: [ONE_LINE_EVIDENCE],
          },
        ],
        beyond: [],
      },
      "classification output was invalid",
    ],
    [
      "over-cap beyond bucket",
      OVER_CAP_BEYOND_CLASSIFICATION,
      `reports ${ROUND_REPORT_MAX_BEYOND_ENTRIES + 1} beyond-ask entries, over the ${ROUND_REPORT_MAX_BEYOND_ENTRIES}-entry limit`,
    ],
  ] as const)(
    "fails one %s classification before report persistence or lens fanout",
    async (_case, classification, failure) => {
      let reportTurns = 0;
      let lensTurns = 0;
      let lensDraftingStarts = 0;
      const applied: Applied[] = [];
      const run = runLensPipeline({
        ...boardSeats([], (prompt, label) => {
          const lens = lensFromPrompt(prompt, label);
          if (lens === "report") {
            reportTurns += 1;
            return classification;
          }
          if (lens === "post-process") {
            const context = /rennet:layer context>>>\n(\{.*)/s.exec(prompt);
            return context ? (JSON.parse(context[1] as string).board as unknown) : { elements: [] };
          }
          lensTurns += 1;
          return cleanBody(lens);
        }),
        repoRoot: "/pr-worktree",
        deltaPacket: PACKET,
        currentGeneration: "gen:ps-1:dispatch:one-line",
        round: {
          number: 1,
          previousGeneration: "gen:ps-0",
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
            diff: ONE_LINE_DIFF,
            changedPaths: ["src/auth.ts"],
            commitRange: { from: "before", to: "after" },
          },
        },
        lintContextFor,
        readPrompt,
        whiteboard: fakeWhiteboard(applied),
        boardIdFor: (lens) => `board:${lens}`,
        onLensDraftingStart: () => {
          lensDraftingStarts += 1;
        },
      });

      await expect(run).rejects.toThrow(failure);
      expect(reportTurns).toBe(1);
      expect(lensDraftingStarts).toBe(0);
      expect(lensTurns).toBe(0);
      expect(applied.map(({ boardId }) => boardId)).not.toContain("board:report");
    },
  );

  it("starts every core lens turn after the report, reveals each lane as it settles, and runs Noise on their settlements", async () => {
    // D16c — the four CORE lanes still fan out together and nothing waits on any of them.
    // Noise is not among them: its membership is their complement, which is not knowable
    // until they have settled, so it starts on their settlements and is the tail. That is
    // a sequencing fact, not a barrier — nothing waits on Noise.
    const lenses: LensKind[] = ["design", "sequence", "decisions", "flagged"];
    const started: LensKind[] = [];
    const applied: Applied[] = [];
    const arrivals: LensKind[] = [];
    const providerCalls: string[] = [];
    let reportArrived = false;
    let pipelineSettled = false;
    let announceFirstLensStart = (): void => undefined;
    const firstLensStarted = new Promise<void>((resolve) => {
      announceFirstLensStart = resolve;
    });
    const releases = new Map<LensKind, () => void>();
    const lensBarriers = new Map<LensKind, Promise<void>>(
      lenses.map((lens) => [
        lens,
        new Promise<void>((resolve) => {
          releases.set(lens, resolve);
        }),
      ]),
    );
    const persisted = new Map<LensKind, Promise<void>>();
    const markPersisted = new Map<LensKind, () => void>();
    for (const lens of lenses) {
      persisted.set(
        lens,
        new Promise<void>((resolve) => {
          markPersisted.set(lens, resolve);
        }),
      );
    }

    const codexSeat = async (prompt: string, seat: string): Promise<unknown> => {
      const lens = lensFromPrompt(prompt, seat);
      providerCalls.push(lens);
      // Noise runs unbarriered: it cannot start until the four have settled, so a barrier
      // on it would only measure the sequencing this test already asserts by ordering.
      if (lens !== "report" && lenses.includes(lens as LensKind)) {
        const lensKind = lens as LensKind;
        if (!started.includes(lensKind)) {
          started.push(lensKind);
          announceFirstLensStart();
        }
        await lensBarriers.get(lensKind);
      }
      return cleanBody(lens);
    };

    const whiteboard = {
      apply: async (boardId: string, ops: readonly unknown[], actor: string) => {
        applied.push({ boardId, ops, actor });
        const lens = lenses.find((candidate) => boardId === `board:${candidate}`);
        if (lens !== undefined) markPersisted.get(lens)?.();
        return { response: { ok: true }, ops } as never;
      },
    };

    const pipeline = runLensPipeline({
      ...boardSeats([], codexSeat, ["codex"]),
      repoRoot: "/pr-worktree",
      deltaPacket: {
        ...PACKET,
        successorAccount: { asks: [], beyondAsks: [] },
      },
      lintContextFor,
      readPrompt,
      whiteboard,
      boardIdFor: (lens) => `board:${lens}`,
      onBoardArrival: ({ lens }) => {
        if (lens === "report") reportArrived = true;
        else arrivals.push(lens);
      },
    });
    void pipeline.then(
      () => {
        pipelineSettled = true;
      },
      () => {
        pipelineSettled = true;
      },
    );

    await firstLensStarted;
    await Promise.resolve();
    let regressionFailure: unknown;
    try {
      expect(reportArrived).toBe(true);
      expect([...started]).toEqual(lenses);
      // Positive control: the release barrier is load-bearing, not a decorative fixture.
      expect(pipelineSettled).toBe(false);
    } catch (error) {
      regressionFailure = error;
    }

    // Release one lane at a time, newest lens first, recording what the reveal had
    // published by the time each lane's board was written. #725 D4: a lane's settlement is
    // visible the moment it lands, so the reveal must track the release order and must NOT
    // wait for the four lanes still blocked below.
    const revealAfterEachRelease: LensKind[][] = [];
    if (regressionFailure === undefined) {
      try {
        for (const lens of [...lenses].reverse()) {
          releases.get(lens)?.();
          const lensPersisted = persisted.get(lens);
          if (lensPersisted === undefined) throw new Error(`missing ${lens} persistence control`);
          await Promise.race([
            lensPersisted,
            new Promise<never>((_resolve, reject) => {
              setImmediate(() => reject(new Error(`${lens} did not persist after release`)));
            }),
          ]);
          // Let the lane's own settlement publication run before sampling the reveal.
          await new Promise<void>((resolve) => setImmediate(resolve));
          // Core lanes only. Noise arrives on the last core settlement (D16c), so
          // including it would compare the tail against a core release order it is not in.
          revealAfterEachRelease.push(arrivals.filter((arrived) => arrived !== "noise"));
        }
      } catch (error) {
        regressionFailure = error;
      }
    }
    for (const release of releases.values()) release();

    let result: Awaited<ReturnType<typeof runLensPipeline>> | undefined;
    try {
      result = await pipeline;
    } catch (error) {
      regressionFailure ??= error;
    }
    if (regressionFailure !== undefined) throw regressionFailure;
    if (result === undefined) throw new Error("lens pipeline settled without a result");

    // The returned array keeps LENS_KINDS order, Noise included, whatever order they ran in.
    expect(result.boards.map(({ lens }) => lens)).toEqual([...lenses, "noise"]);
    expect(
      applied.map(({ boardId }) => boardId).filter((boardId) => boardId !== "board:report"),
    ).toEqual([...[...lenses].reverse(), "noise"].map((lens) => `board:${lens}`));
    // The reveal followed the RELEASE order, not the lens order — each lane published on
    // its own settlement.
    // The progressive assertion first: it is the one that NAMES a restored barrier, and a
    // plain order comparison would fail on the same run with a less useful message.
    assertProgressiveReveal(revealAfterEachRelease, [...lenses].reverse());
    // Noise arrives LAST, after every core lane — the tail, in order.
    expect(arrivals).toEqual([...[...lenses].reverse(), "noise"]);
    // …and it was DISPATCHED last too, which is the sequencing rather than a race that
    // happened to resolve in this order: its prompt could not be sent before the four
    // settled, so it is the final entry and nothing follows it.
    expect(providerCalls).toEqual(["report", ...lenses, "noise"]);
    expect(providerCalls.at(-1)).toBe("noise");
    expect(pipelineSettled).toBe(true);
  });

  it("records a distinct durable timing for every phase", async () => {
    const applied: Applied[] = [];
    const timings: GenerationPhaseTiming[] = [];

    const result = await runLensPipeline({
      ...boardSeats([], (prompt, label) => cleanBody(lensFromPrompt(prompt, label))),
      repoRoot: "/pr-worktree",
      deltaPacket: PACKET,
      lintContextFor,
      readPrompt,
      whiteboard: fakeWhiteboard(applied),
      boardIdFor: (lens) => `board:${lens}`,
      onPhaseTiming: (timing) => {
        timings.push(timing);
      },
    });
    expect(result.boards).toHaveLength(5);

    // Every lane has its own draft and post-process record; the generation-wide phases have
    // one each. No report here (this generation drafts none), which is why `report` is absent
    // rather than present-and-zero.
    const phases = timings.map(
      ({ phase, lens }) => `${phase}${lens === undefined ? "" : `:${lens}`}`,
    );
    for (const lens of ["design", "sequence", "decisions", "flagged", "noise"]) {
      expect(phases).toContain(`lens-draft:${lens}`);
      expect(phases).toContain(`lens-post-process:${lens}`);
    }
    expect(phases).toContain("reveal");
    expect(phases).not.toContain("report");
    // Every record is a durable, non-negative integer span anchored to a wall clock.
    for (const timing of timings) {
      expect(Number.isInteger(timing.startedAtMs) && timing.startedAtMs > 0).toBe(true);
      expect(Number.isInteger(timing.durationMs) && timing.durationMs >= 0).toBe(true);
    }
    // Every lane names the harness and model that actually ran it. Only one harness is
    // installed here, so Flagged degrades to a single seat and names THAT one — the
    // genuinely dual case is the test below, which needs two harnesses to exist at all.
    const noiseDraft = timings.find((t) => t.phase === "lens-draft" && t.lens === "noise");
    expect(noiseDraft?.harness).toBe("claude-code");
    expect(noiseDraft?.model).toBeDefined();
    const flaggedDrafts = timings.filter((t) => t.phase === "lens-draft" && t.lens === "flagged");
    expect(flaggedDrafts).toHaveLength(1);
    expect(flaggedDrafts[0]?.harness).toBe("claude-code");
  });

  it("emits ONE lens-draft record per Flagged seat, each naming what ran it (#726 D8)", async () => {
    // A genuinely dual lane: BOTH harnesses are installed, so `runFlaggedDual` runs two
    // seats rather than degrading. That is load-bearing — an earlier version of this
    // assertion ran with only one harness, so exactly one seat ever ran, and "the dual
    // seat names no harness" passed because there was no dual seat.
    const timings: GenerationPhaseTiming[] = [];
    const result = await runLensPipeline({
      ...boardSeats([], (prompt, seat) => cleanBody(lensFromPrompt(prompt, seat)), [
        "claude-code",
        "codex",
      ]),
      repoRoot: "/pr-worktree",
      deltaPacket: PACKET,
      lintContextFor,
      readPrompt,
      whiteboard: fakeWhiteboard([]),
      boardIdFor: (lens) => `board:${lens}`,
      onPhaseTiming: (timing) => {
        timings.push(timing);
      },
    });
    expect(result.boards.find(({ lens }) => lens === "flagged")?.boardId).toBe("board:flagged");

    // TWO Flagged draft records, one per seat, and between them BOTH harnesses — which is
    // what makes "this run was dual-model" derivable from the stages instead of assumed
    // from settings. Every record names its model too.
    const flaggedDrafts = timings.filter((t) => t.phase === "lens-draft" && t.lens === "flagged");
    expect(flaggedDrafts).toHaveLength(2);
    expect(new Set(flaggedDrafts.map(({ harness }) => harness))).toEqual(
      new Set(["claude-code", "codex"]),
    );
    for (const record of flaggedDrafts) expect(record.model).toBeDefined();

    // A single-seat lane still emits exactly one, so the count itself distinguishes the two
    // — a dual lane and a degraded one are not the same shape.
    expect(timings.filter((t) => t.phase === "lens-draft" && t.lens === "noise")).toHaveLength(1);

    // The LANE's aggregate span stays derivable: min start to max end across its seats.
    const laneFrom = Math.min(...flaggedDrafts.map(({ startedAtMs }) => startedAtMs));
    const laneTo = Math.max(...flaggedDrafts.map((t) => t.startedAtMs + t.durationMs));
    expect(laneTo).toBeGreaterThanOrEqual(laneFrom);
  });

  it("ends the `reveal` window at the last lane that REVEALED, not the last that settled", async () => {
    // Ordering is CONTROLLED, not hoped for: each lens seat waits on its own gate, so the
    // lane that reveals nothing settles strictly last. Without that, a run where the
    // failing lane happened to finish early would pass under both the honest code and the
    // defect, and this test would prove nothing.
    //
    // Noise is not gated here: it starts on the four settlements (D16c), so gating it
    // would deadlock rather than order anything.
    const lenses: LensKind[] = ["design", "sequence", "decisions", "flagged"];
    const timings: GenerationPhaseTiming[] = [];
    let ticks = 1_000;
    const releases = new Map<LensKind, () => void>();
    const gates = new Map<LensKind, Promise<void>>(
      lenses.map((lens) => [
        lens,
        new Promise<void>((resolve) => {
          releases.set(lens, resolve);
        }),
      ]),
    );
    const announceArrival = new Map<LensKind, () => void>();
    const arrived = new Map<LensKind, Promise<void>>(
      lenses.map((lens) => [
        lens,
        new Promise<void>((resolve) => {
          announceArrival.set(lens, resolve);
        }),
      ]),
    );
    const revealing = lenses.filter((lens) => lens !== "design");

    const pipeline = runLensPipeline({
      ...boardSeats(
        [],
        async (prompt, seat) => {
          const lens = lensFromPrompt(prompt, seat) as LensKind;
          await gates.get(lens);
          ticks += 1;
          // Design never emits a parseable board, so it settles as a FAILURE — a settlement
          // that reveals nothing, which is exactly the case the window must exclude.
          return lens === "design" ? { not: "a board" } : cleanBody(lens);
        },
        ["codex"],
      ),
      repoRoot: "/pr-worktree",
      deltaPacket: PACKET,
      lintContextFor,
      readPrompt,
      whiteboard: fakeWhiteboard([]),
      boardIdFor: (lens) => `board:${lens}`,
      onBoardArrival: (event) => {
        ticks += 5;
        announceArrival.get(event.lens as LensKind)?.();
      },
      onPhaseTiming: (timing) => {
        timings.push(timing);
      },
      now: () => ticks,
    });

    for (const lens of revealing) releases.get(lens)?.();
    await Promise.all(revealing.map((lens) => arrived.get(lens)));
    // The clock at the moment the LAST reveal landed. Design is still parked on its gate,
    // so nothing else can have moved it.
    const lastRevealTick = ticks;

    releases.get("design")?.();
    const result = await pipeline;
    expect(result.boards.find(({ lens }) => lens === "design")?.failure).toBeDefined();

    // The failing lane's settlement moved the clock well past the last reveal, so the two
    // candidate window ends are distinguishable — this is the control built into the test.
    expect(ticks).toBeGreaterThan(lastRevealTick);
    const reveal = timings.find(({ phase }) => phase === "reveal");
    expect(reveal).toBeDefined();
    expect((reveal?.startedAtMs ?? 0) + (reveal?.durationMs ?? 0)).toBe(lastRevealTick);
  });

  it("records the `reveal` timing even when a lane throws, and says coverage never ran", async () => {
    // A scripted clock and a persistence sink that throws for one lane. The throwing lane
    // settles LAST and reveals nothing, so two claims are under test at once:
    //   • its settlement must not extend the `reveal` window — otherwise the record
    //     measures the fan-out and wears the reveal's name;
    //   • the record must exist at all, because it used to be written after an
    //     `outcomes.map` that rethrows a rejected lane, and so was lost exactly when a run
    //     failed.
    const timings: GenerationPhaseTiming[] = [];
    let ticks = 1_000;
    let revealed = 0;

    await expect(
      runLensPipeline({
        ...boardSeats([], (prompt, label) => {
          ticks += 10;
          return cleanBody(lensFromPrompt(prompt, label));
        }),
        repoRoot: "/pr-worktree",
        deltaPacket: PACKET,
        lintContextFor,
        readPrompt,
        whiteboard: fakeWhiteboard([]),
        boardIdFor: (lens) => `board:${lens}`,
        persistBoardMeta: (meta) => {
          // Noise dies on its durable write — an infrastructure failure, which is what
          // `allSettled` collects as a REJECTED lane.
          if (meta.lens === "noise") throw new Error("the noise lane's metadata store died");
        },
        onBoardArrival: () => {
          revealed += 1;
          // Every real reveal costs 100 ticks; the failing lane's settlement costs 1000, so
          // a window that closed on it instead would be unmistakable.
          ticks += 100;
        },
        onPhaseTiming: (timing) => {
          timings.push(timing);
        },
        now: () => ticks,
      }),
    ).rejects.toThrow("the noise lane's metadata store died");

    // Four lanes revealed; Noise died before its arrival.
    expect(revealed).toBe(4);
    // The record EXISTS. It used to be written after an `outcomes.map` that rethrows a
    // rejected lane, so a run that died lost the timing for the window it most needed
    // explaining. (Where the window ENDS is the test above, which controls the ordering.)
    expect(timings.some(({ phase }) => phase === "reveal")).toBe(true);
  });

  it("keeps the report phase's timing to the report, never absorbing the lens lanes", async () => {
    const applied: Applied[] = [];
    const timings: GenerationPhaseTiming[] = [];
    // A scripted clock: the report seat costs 1 tick, each lens lane costs 100. A `report`
    // record that had absorbed the lens fan-out would be enormous next to that.
    let ticks = 1_000;
    const advance = (by: number): void => {
      ticks += by;
    };

    await runLensPipeline({
      ...boardSeats([], (prompt, label) => {
        const lens = lensFromPrompt(prompt, label);
        advance(lens === "report" ? 1 : 100);
        return lens === "report" ? cleanBody("report") : cleanBody(lens);
      }),
      repoRoot: "/pr-worktree",
      deltaPacket: { ...PACKET, successorAccount: { asks: [], beyondAsks: [] } },
      lintContextFor,
      readPrompt,
      whiteboard: fakeWhiteboard(applied),
      boardIdFor: (lens) => `board:${lens}`,
      onPhaseTiming: (timing) => {
        timings.push(timing);
      },
      now: () => ticks,
    });

    // Not vacuous: the assertion returns early when no report phase was recorded, so the
    // record it judges has to exist and the lens records have to be there to judge against.
    expect(timings.some(({ phase }) => phase === "report")).toBe(true);
    expect(timings.filter(({ phase }) => phase === "lens-draft")).toHaveLength(5);
    assertReportLabelExcludesLensTime(timings);
  });

  it("positive control: lens time routed under the report label fails the timing assertion", () => {
    const honest: GenerationPhaseTiming[] = [
      { phase: "report", startedAtMs: 1_000, durationMs: 1 },
      { phase: "lens-draft", lens: "sequence", startedAtMs: 1_001, durationMs: 100 },
      { phase: "lens-draft", lens: "noise", startedAtMs: 1_001, durationMs: 100 },
    ];
    expect(() => assertReportLabelExcludesLensTime(honest)).not.toThrow();
    // The defect this replaces: one label spanning the report AND the lens fan-out, which
    // is what a durable timing that started before the report and ended after the lanes
    // looks like. The assertion above must reject it.
    const mislabeled: GenerationPhaseTiming[] = [
      { phase: "report", startedAtMs: 1_000, durationMs: 201 },
      { phase: "lens-draft", lens: "sequence", startedAtMs: 1_001, durationMs: 100 },
      { phase: "lens-draft", lens: "noise", startedAtMs: 1_101, durationMs: 100 },
    ];
    expect(() => assertReportLabelExcludesLensTime(mislabeled)).toThrow(/absorbed/);

    // PARTIAL overlap — the case the earlier reading of this assertion could not see. The
    // report ends partway through a lane that finishes later, so comparing the lane's END
    // to the report's end passed it while real lens time sat under the report label.
    const partial: GenerationPhaseTiming[] = [
      { phase: "report", startedAtMs: 1_000, durationMs: 50 },
      { phase: "lens-draft", lens: "sequence", startedAtMs: 1_001, durationMs: 100 },
    ];
    expect(() => assertReportLabelExcludesLensTime(partial)).toThrow(/absorbed/);

    // …and the boundary the same fix must NOT reject: a zero-duration lens phase starting
    // the instant the report ended. Touching is not overlapping, and no lens time sits
    // under the report label here.
    const touching: GenerationPhaseTiming[] = [
      { phase: "report", startedAtMs: 1_000, durationMs: 1 },
      { phase: "lens-repair", lens: "noise", startedAtMs: 1_001, durationMs: 0 },
    ];
    expect(() => assertReportLabelExcludesLensTime(touching)).not.toThrow();
  });

  it("budgets every whole-board attempt from the table, and never starves a repeat", async () => {
    // The table's contract, over EVERY lane rather than the one the behavioural half below
    // happens to drive: a repeat attempt is never RICHER than the first (that bound is what
    // stops restart recovery refreshing a full ladder each time) and never ZERO (a zero
    // repeat terminates a lane on one malformed output, so wave 3's restart recovery —
    // which exists to re-draft a retryable lens — could never produce a board for it).
    for (const [lens, [first, repeat]] of Object.entries(LENS_RETRY_BUDGET)) {
      expect(`${lens}:${repeat <= first}`).toBe(`${lens}:true`);
      expect(`${lens}:${repeat > 0}`).toBe(`${lens}:true`);
    }
    expect(lensRetryBudget("sequence", 0)).toBe(LENS_RETRY_BUDGET.sequence[0]);
    // Every repeat draws the same repeat entry — attempt 5 is no richer than attempt 1.
    expect(lensRetryBudget("sequence", 1)).toBe(LENS_RETRY_BUDGET.sequence[1]);
    expect(lensRetryBudget("sequence", 5)).toBe(LENS_RETRY_BUDGET.sequence[1]);

    const runWithAttempt = async (boardAttempt: number) => {
      const sequenceTurns: string[] = [];
      const applied: Applied[] = [];
      const result = await runLensPipeline({
        ...boardSeats([], (prompt, label) => {
          const lens = lensFromPrompt(prompt, label);
          if (lens !== "sequence") return cleanBody(lens);
          sequenceTurns.push(prompt);
          // The first return never parses, so the ladder is what decides whether this lane
          // gets a second chance. A budget of 0 means it does not.
          return sequenceTurns.length === 1 ? { not: "a board" } : cleanBody("sequence");
        }),
        repoRoot: "/pr-worktree",
        deltaPacket: PACKET,
        boardAttempt,
        lintContextFor,
        readPrompt,
        whiteboard: fakeWhiteboard(applied),
        boardIdFor: (lens) => `board:${lens}`,
      });
      const sequence = result.boards.find(({ lens }) => lens === "sequence");
      return { turns: sequenceTurns.length, sequence };
    };

    const first = await runWithAttempt(0);
    expect(first.turns).toBe(2);
    expect(first.sequence?.failure).toBeUndefined();
    expect(first.sequence?.boardId).toBe("board:sequence");

    // The repeat attempt still gets its repair turn, so ONE malformed output does not end
    // the lane. This is the whole point of a reduced-but-non-zero repeat: the restart
    // redraft recovers exactly the lens it was started for.
    const repeat = await runWithAttempt(1);
    expect(repeat.turns).toBe(2);
    expect(repeat.sequence?.failure).toBeUndefined();
    expect(repeat.sequence?.boardId).toBe("board:sequence");
  });

  it("names the attempts spent and what `finish` last said when a lane never settles", async () => {
    // "across 0 attempts" read as a contradiction — it claimed a ladder was spent and that
    // none was. The sentence still says what was used, and now says the other two facts
    // `lens-board-drafting` requires of an exhausted lane: which lens, and what the last
    // whole-board verdict was.
    const result = await runLensPipeline({
      ...boardSeats([], (prompt, label) => {
        const lens = lensFromPrompt(prompt, label);
        return lens === "sequence" ? undefined : cleanBody(lens);
      }),
      repoRoot: "/pr-worktree",
      deltaPacket: PACKET,
      lintContextFor,
      readPrompt,
      whiteboard: fakeWhiteboard([]),
      boardIdFor: (lens) => `board:${lens}`,
    });
    const sequence = result.boards.find(({ lens }) => lens === "sequence");
    expect(sequence?.failure).toContain("sequence lens: the seat did not finish its board");
    // The budget it was allotted, spent: one drafting turn and one repair, both ending
    // unsettled, which is exactly `LENS_RETRY_BUDGET.sequence[0]` repair turns plus the
    // draft — and both of them count, because both ended without a settlement.
    expect(sequence?.failure).toContain(`${LENS_RETRY_BUDGET.sequence[0] + 1} attempts spent`);
    expect(sequence?.failure).toContain("`finish` was never called");
    expect(sequence?.failureAccount?.classification).toBe("terminal");
  });

  it("positive control: a global all-lanes barrier before reveal fails the reveal assertion", () => {
    const releaseOrder: LensKind[] = ["noise", "flagged", "decisions", "sequence", "design"];
    // What the progressive reveal produces: one more lane visible after each release.
    const progressive = releaseOrder.map((_lens, index) => releaseOrder.slice(0, index + 1));
    expect(() => assertProgressiveReveal(progressive, releaseOrder)).not.toThrow();
    // What a REINTRODUCED global barrier produces: nothing visible until the last lane
    // settles, then all five at once. The assertion the test above relies on must reject
    // it — otherwise that test would pass over a restored barrier and prove nothing.
    const barriered = releaseOrder.map((_lens, index) =>
      index === releaseOrder.length - 1 ? [...releaseOrder] : [],
    );
    expect(() => assertProgressiveReveal(barriered, releaseOrder)).toThrow(
      /revealed nothing until/,
    );
  });

  it("waits for sibling lenses and continues absence notifications before rethrowing one callback", async () => {
    const modelLenses: LensKind[] = ["sequence", "decisions", "flagged", "noise"];
    const started: LensKind[] = [];
    const absences: LensKind[] = [];
    const applied: Applied[] = [];
    let pipelineSettled = false;
    let releaseLensTurns = (): void => undefined;
    let announceFirstLensStart = (): void => undefined;
    const lensRelease = new Promise<void>((resolve) => {
      releaseLensTurns = resolve;
    });
    const firstLensStarted = new Promise<void>((resolve) => {
      announceFirstLensStart = resolve;
    });

    const codexSeat = async (prompt: string, seat: string): Promise<unknown> => {
      const lens = lensFromPrompt(prompt, seat);
      if (lens === "post-process") {
        const context = /rennet:layer context>>>\n(\{.*)/s.exec(prompt);
        return context ? (JSON.parse(context[1] as string).board as unknown) : { elements: [] };
      }
      if (modelLenses.includes(lens as LensKind)) {
        const lensKind = lens as LensKind;
        if (!started.includes(lensKind)) {
          started.push(lensKind);
          announceFirstLensStart();
        }
        await lensRelease;
      }
      return lens === "design"
        ? { absence: "no-spec" }
        : lens === "decisions"
          ? { absence: "no-decisions" }
          : cleanBody(lens);
    };

    const pipeline = runLensPipeline({
      ...boardSeats([], codexSeat, ["codex"]),
      repoRoot: "/pr-worktree",
      deltaPacket: PACKET,
      lintContextFor,
      readPrompt,
      whiteboard: fakeWhiteboard(applied),
      boardIdFor: (lens) => `board:${lens}`,
      onLensAbsence: async (lens) => {
        absences.push(lens);
        if (lens === "design") throw new Error("absence store failed");
      },
    });
    void pipeline.then(
      () => {
        pipelineSettled = true;
      },
      () => {
        pipelineSettled = true;
      },
    );

    await firstLensStarted;
    await Promise.resolve();
    let preReleaseFailure: unknown;
    try {
      // The CORE lanes start together; Noise starts on their settlements (D16c), so it is
      // not among the turns that are open at this point.
      expect(started).toEqual(modelLenses.filter((lens) => lens !== "noise"));
      expect(pipelineSettled).toBe(false);
    } catch (error) {
      preReleaseFailure = error;
    } finally {
      releaseLensTurns();
    }
    await expect(pipeline).rejects.toThrow("absence store failed");
    if (preReleaseFailure !== undefined) throw preReleaseFailure;

    expect(absences).toEqual(["design", "decisions"]);
    // Noise is absent from this list, and that is D16c: the pipeline rethrows the failed
    // absence callback once the four core lanes are in, so the tail lane never ran.
    expect(applied.map(({ boardId }) => boardId).sort()).toEqual(
      ["board:sequence", "board:flagged"].sort(),
    );
    expect(pipelineSettled).toBe(true);
  });

  // #813 — the Design seat exhausted both attempts 33 s into the generation and the bench
  // went on saying "quiet for 320 s" until the reveal, because a failure was only visible
  // in `boards`, which the caller reads after the SLOWEST lane finishes. The proof that
  // matters is the TIMING, so the four sibling lanes are held on a gate the assertion runs
  // in front of: if the publication moved back behind the pipeline's own settlement, this
  // deadlocks on `designSettled` rather than failing an equality.
  //
  // POSITIVE CONTROL RUN, 2026-09-04: the `onLensFailure` publish deleted from
  // `lens-pipeline.ts` → this test failed by timing out on `await designSettled` (5s), the
  // gate never released. Restored, green.
  it("publishes a lens failure the moment its attempts are exhausted, not after the last sibling", async () => {
    const applied: Applied[] = [];
    const failures: { lens: LensKind; failure: string }[] = [];
    let releaseSiblings = (): void => undefined;
    let announceDesignFailed = (): void => undefined;
    const siblingGate = new Promise<void>((resolve) => {
      releaseSiblings = resolve;
    });
    const designSettled = new Promise<void>((resolve) => {
      announceDesignFailed = resolve;
    });

    const seat = async (prompt: string, label: string): Promise<unknown> => {
      const lens = lensFromPrompt(prompt, label);
      if (lens === "post-process") {
        const context = /rennet:layer context>>>\n(\{.*)/s.exec(prompt);
        return context ? (JSON.parse(context[1] as string).board as unknown) : { elements: [] };
      }
      // The drive's own failure: the seat turn ends having written nothing and settled
      // nothing, on every attempt, so the lane exhausts its ladder and settles failed.
      if (lens === "design") return undefined;
      await siblingGate;
      return cleanBody(lens);
    };

    const pipeline = runLensPipeline({
      ...boardSeats([], seat, ["codex"]),
      repoRoot: "/repo",
      deltaPacket: PACKET,
      lintContextFor,
      readPrompt,
      whiteboard: fakeWhiteboard(applied),
      boardIdFor: (lens) => `board:${lens}`,
      onLensFailure: (lens, failure) => {
        failures.push({ lens, failure });
        announceDesignFailed();
      },
    });

    // Published while every other lane is still blocked — the whole point.
    await designSettled;
    expect(failures.map((entry) => entry.lens)).toEqual(["design"]);
    expect(failures[0]?.failure).toMatch(/did not finish its board/);

    releaseSiblings();
    const result = await pipeline;
    // One settlement, not two: the reason the caller records at the end is the SAME string
    // the lane already showed, so the bench never contradicts the durable record.
    expect(result.boards.find((board) => board.lens === "design")?.failure).toBe(
      failures[0]?.failure,
    );
    // TWO failures, and the second is the first's consequence (D16d): Design stated nothing
    // about what it cites, so the Noise complement cannot be taken and that lane says so by
    // name rather than presenting Design's un-cited regions as skippable.
    expect(failures.map((entry) => entry.lens)).toEqual(["design", "noise"]);
    expect(failures[1]?.failure).toContain("design");
  });

  it("fails an empty round report after its first draft without starting lens work", async () => {
    let reportTurns = 0;
    let lensTurns = 0;
    let lensDraftingStarts = 0;
    const applied: Applied[] = [];
    const arrivals: BoardArrivalEvent[] = [];

    const run = runLensPipeline({
      ...boardSeats([], (prompt, label) => {
        const lens = lensFromPrompt(prompt, label);
        if (lens === "report") {
          reportTurns += 1;
          return { elements: [] };
        }
        if (lens === "post-process" && prompt.includes('"elements":[]')) {
          return { elements: [] };
        }
        lensTurns += 1;
        return cleanBody(lens);
      }),
      repoRoot: "/pr-worktree",
      deltaPacket: {
        ...PACKET,
        successorAccount: { asks: [], beyondAsks: [] },
      },
      lintContextFor,
      readPrompt,
      whiteboard: fakeWhiteboard(applied),
      boardIdFor: (lens) => `board:${lens}`,
      onBoardArrival: (event) => {
        arrivals.push(event);
      },
      onLensDraftingStart: () => {
        lensDraftingStarts += 1;
      },
    });

    await expect(run).rejects.toThrow("produced zero elements in the emitted board");
    expect(reportTurns).toBe(1);
    expect(lensDraftingStarts).toBe(0);
    expect(lensTurns).toBe(0);
    expect(applied.map(({ boardId }) => boardId)).not.toContain("board:report");
    expect(arrivals.map(({ lens }) => lens)).not.toContain("report");
  });

  it("composes verified round outcomes into Sequence before the board is persisted", async () => {
    const applied: Applied[] = [];
    const hostAuthor = { kind: "orchestrator" as const, id: "rennet:round-composition" };
    const previousSequence = mkBoard([
      {
        id: "rennet:host:round-addressed:1:section",
        kind: "section",
        data: {
          author: hostAuthor,
          title: "Round 1 · Addressed",
          children: ["rennet:host:round-addressed:1:0:prose"],
        },
      } as DraftBoard["elements"][number],
      {
        id: "rennet:host:round-addressed:1:0:prose",
        kind: "prose",
        data: { author: hostAuthor, markdown: "**First ask**\n\nFixed." },
      } as DraftBoard["elements"][number],
    ]);
    const retryDiff = [
      "diff --git a/src/auth.ts b/src/auth.ts",
      "--- a/src/auth.ts",
      "+++ b/src/auth.ts",
      "@@ -1 +1 @@",
      "-outsideRetry();",
      "+insideRetry();",
    ].join("\n");
    const result = await runLensPipeline({
      ...boardSeats([], (prompt, label) => {
        const lens = lensFromPrompt(prompt, label);
        if (lens === "post-process") {
          const context = /rennet:layer context>>>\n(\{.*)/s.exec(prompt);
          return context ? (JSON.parse(context[1] as string).board as unknown) : { elements: [] };
        }
        if (lens === "report") {
          return {
            outcomes: [
              {
                askId: "ask-2",
                status: "addressed",
                note: "The retry boundary now owns the refresh.",
                evidenceIds: manifestIds(retryDiff),
              },
            ],
            beyond: [],
          };
        }
        return cleanBody(lens);
      }),
      repoRoot: "/pr-worktree",
      // Legacy reviews can have durable AskLog asks without a reconstructed
      // successorAccount. The explicit generation lineage still makes this a round.
      deltaPacket: PACKET,
      round: {
        number: 2,
        previousGeneration: "gen:ps-0",
        dispatchedAsks: [
          {
            id: "ask-2",
            path: "src/auth.ts",
            type: "request-change",
            instruction: "Keep the refresh inside the retry boundary.",
            context: "",
          },
        ],
        findingDispositions: {},
        worker: {
          outcome: "completed",
          diff: retryDiff,
          changedPaths: ["src/auth.ts"],
          commitRange: { from: "same-head", to: "same-head" },
        },
      },
      lintContextFor,
      previous: new Map([["sequence", previousSequence]]),
      readPrompt,
      whiteboard: fakeWhiteboard(applied),
      boardIdFor: (lens) => `board:${lens}`,
    });

    const sequence = result.boards.find((outcome) => outcome.lens === "sequence")?.board;
    const chapters = sequence?.elements.flatMap((element) =>
      element.kind === "section" && element.id.startsWith("rennet:host:round-addressed:")
        ? [element.data.title]
        : [],
    );
    expect(chapters).toEqual(["Round 1 · Addressed", "Round 2 · Addressed"]);
    const persistedSequence = applied.find(({ boardId }) => boardId === "board:sequence");
    expect(JSON.stringify(persistedSequence?.ops)).toContain("Round 2 · Addressed");
  });

  it("leaves a carried Round 1 chapter's citation naming ROUND 1's patchset, not this round's", async () => {
    // The stamp that writes `patchset_id` onto every `code_ref` must run BEFORE round
    // composition, and this is what says so. Composition carries the previous generation's
    // "Round N · Addressed" chapter onto this board verbatim, and its anchors cite the
    // EARLIER generation's capture by design — which is why `admitBoardReferences` exempts
    // the host composer by name (`isHostComposedHistory`). A stamp running afterwards maps
    // over those anchors too and relabels round 1's citation as round 2's.
    //
    // Three things break at once and no other test sees any of them: the board is durably
    // wrong on disk; the client relabels the citation, because it falls back to the board's
    // patchset only for an element that carries none; and two guards go vacuous — that
    // exemption, and lint's cross-patchset `citation-resolves` arm — because there is
    // nothing left for either to find.
    const applied: Applied[] = [];
    const hostAuthor = { kind: "orchestrator" as const, id: "rennet:round-composition" };
    const CARRIED_REF = "rennet:host:round-addressed:1:0:code-ref";
    const PRIOR_PATCHSET = "ps-0";
    const previousSequence = mkBoard([
      {
        id: "rennet:host:round-addressed:1:section",
        kind: "section",
        data: {
          author: hostAuthor,
          title: "Round 1 · Addressed",
          children: ["rennet:host:round-addressed:1:0:prose"],
        },
      } as DraftBoard["elements"][number],
      {
        id: "rennet:host:round-addressed:1:0:prose",
        kind: "prose",
        data: { author: hostAuthor, markdown: "**First ask**\n\nFixed." },
      } as DraftBoard["elements"][number],
      // The anchor round 1 wrote, against round 1's capture.
      {
        id: CARRIED_REF,
        kind: "code_ref",
        data: {
          author: hostAuthor,
          patchset_id: PRIOR_PATCHSET,
          path: "src/auth.ts",
          side: "head",
          start_line: 11,
          end_line: 12,
        },
      } as DraftBoard["elements"][number],
    ]);
    const retryDiff = [
      "diff --git a/src/auth.ts b/src/auth.ts",
      "--- a/src/auth.ts",
      "+++ b/src/auth.ts",
      "@@ -1 +1 @@",
      "-outsideRetry();",
      "+insideRetry();",
    ].join("\n");

    const result = await runLensPipeline({
      ...boardSeats([], (prompt, label) => {
        const lens = lensFromPrompt(prompt, label);
        if (lens === "report") {
          return {
            outcomes: [
              {
                askId: "ask-2",
                status: "addressed",
                note: "The retry boundary now owns the refresh.",
                evidenceIds: manifestIds(retryDiff),
              },
            ],
            beyond: [],
          };
        }
        return cleanBody(lens);
      }),
      repoRoot: "/pr-worktree",
      deltaPacket: PACKET,
      round: {
        number: 2,
        previousGeneration: "gen:ps-0",
        dispatchedAsks: [
          {
            id: "ask-2",
            path: "src/auth.ts",
            type: "request-change",
            instruction: "Keep the refresh inside the retry boundary.",
            context: "",
          },
        ],
        findingDispositions: {},
        worker: {
          outcome: "completed",
          diff: retryDiff,
          changedPaths: ["src/auth.ts"],
          commitRange: { from: "same-head", to: "same-head" },
        },
      },
      lintContextFor,
      previous: new Map([["sequence", previousSequence]]),
      readPrompt,
      whiteboard: fakeWhiteboard(applied),
      boardIdFor: (lens) => `board:${lens}`,
    });

    const sequence = result.boards.find((outcome) => outcome.lens === "sequence");
    expect(sequence?.failure).toBeUndefined();
    const carried = sequence?.board?.elements.find(({ id }) => id === CARRIED_REF);
    expect(carried, "the carried Round 1 citation is not on the board at all").toBeDefined();
    expect((carried?.data as { patchset_id?: unknown } | undefined)?.patchset_id).toBe(
      PRIOR_PATCHSET,
    );
    // …and it reaches DISK that way. The returned outcome and the ops the whiteboard
    // received are two different objects, and only the second is what a restart re-reads.
    const persisted = applied.find(({ boardId }) => boardId === "board:sequence");
    expect(JSON.stringify(persisted?.ops)).toContain(`"${PRIOR_PATCHSET}"`);

    // The seat's OWN citations on the same board do carry this round's capture, so this is
    // not a stamp that stopped running — it is one that runs before the carry.
    const seatRefs = (sequence?.board?.elements ?? []).filter(
      (element) => element.kind === "code_ref" && element.id !== CARRIED_REF,
    );
    for (const ref of seatRefs) {
      expect((ref.data as { patchset_id?: unknown }).patchset_id).toBe(PACKET.patchset.id);
    }
  });

  it("persists Flagged resolution migration before returning typed absence", async () => {
    const applied: Applied[] = [];
    const persistedResolutionBatches: {
      readonly currentGeneration: string;
      readonly currentBoardId: string;
      readonly resolutions: readonly unknown[];
      readonly findingDispositions: unknown;
    }[] = [];
    const finding = {
      generation: "gen:ps-0",
      boardId: "board:flagged:ps-0",
      findingId: "old-finding",
    };
    const liveFindingDispositions = {
      [findingRefKey(finding)]: { finding, disposition: "dismissed" as const },
    };
    const section = (id: string, child: string): DraftBoard["elements"][number] => ({
      id,
      kind: "section",
      data: { author: flaggedAuthor, title: "Findings", children: [child] },
    });
    const previousFlagged = mkBoard([
      section("old-section", "old-finding"),
      mkFinding("old-finding", "The retry can lose its terminal record.", ["old-code"]),
      mkCodeRef("old-code", "src/auth.ts", 11, 12),
    ]);
    const currentFlagged: DraftBoard = {
      document: {
        title: "Retry accounting",
        introMarkdown: "One finding requires attention.",
        measure: "reading",
      },
      elements: [
        section("new-section", "new-finding"),
        mkFinding("new-finding", "The retry can lose its terminal record.", ["new-code"]),
        mkCodeRef("new-code", "src/auth.ts", 11, 12),
        mkFinding("orphan-finding", "A flat-pool orphan must not inflate the opening.", [
          "orphan-code",
        ]),
        mkCodeRef("orphan-code", "src/auth.ts", 80, 81),
      ],
    };

    const result = await runLensPipeline({
      ...boardSeats([], (prompt, label) => {
        const lens = lensFromPrompt(prompt, label);
        if (lens === "flagged") return currentFlagged;
        if (lens === "report") return cleanBody("report");
        if (lens === "post-process") {
          const context = /rennet:layer context>>>\n(\{.*)/s.exec(prompt);
          return context ? (JSON.parse(context[1] as string).board as unknown) : { elements: [] };
        }
        return cleanBody(lens);
      }),
      repoRoot: "/pr-worktree",
      deltaPacket: {
        ...PACKET,
        successorAccount: { asks: [], beyondAsks: [] },
      },
      round: {
        number: 1,
        previousGeneration: "gen:ps-0",
        previousFlaggedBoardId: finding.boardId,
        dispatchedAsks: [],
        findingDispositions: {},
      },
      lintContextFor: (lens) => ({
        ...lintContextFor(lens),
        regions: [{ path: "src/auth.ts", side: "head", start: 1, end: 200 }],
        files: new Map([["src/auth.ts", 200]]),
      }),
      previous: new Map<LintTarget, DraftBoard>([["flagged", previousFlagged]]),
      readPrompt,
      whiteboard: fakeWhiteboard(applied),
      boardIdFor: (lens) => `board:${lens}`,
      readFindingDispositions: () => liveFindingDispositions,
      persistFindingResolutions: (
        currentGeneration,
        currentBoardId,
        resolutions,
        findingDispositions,
      ) => {
        expect(applied.some(({ boardId }) => boardId === "board:flagged")).toBe(false);
        persistedResolutionBatches.push({
          currentGeneration,
          currentBoardId,
          resolutions,
          findingDispositions,
        });
      },
    });

    // The resolution's `currentFindingId` is a HOST-MINTED id now, so it is asserted as a
    // shape rather than a literal: what this test is about is that the migration ran, under
    // which match, before the write — not what the host called the finding.
    const expectedResolution = {
      kind: "reattached" as const,
      finding,
      match: "unique-semantic" as const,
    };
    const flagged = result.boards.find((outcome) => outcome.lens === "flagged");
    expect(flagged?.findingResolutions).toHaveLength(1);
    expect(flagged?.findingResolutions?.[0]).toMatchObject(expectedResolution);
    expect(result.findingResolutions?.[0]).toMatchObject(expectedResolution);
    expect(flagged).toMatchObject({ absence: "no-findings" });
    expect(flagged?.board).toBeUndefined();
    expect(applied.some(({ boardId }) => boardId === "board:flagged")).toBe(false);
    expect(persistedResolutionBatches).toEqual([
      {
        currentGeneration: "gen:ps-1",
        currentBoardId: "board:flagged",
        resolutions: flagged?.findingResolutions,
        findingDispositions: liveFindingDispositions,
      },
    ]);
    expect(persistedResolutionBatches[0]?.findingDispositions).toBe(liveFindingDispositions);
  });

  it("migrates a prior Flagged disposition when the new drafter DECLARES no findings", async () => {
    const finding = {
      generation: "gen:ps-0",
      boardId: "board:flagged:ps-0",
      findingId: "old-finding",
    };
    const dispositions = {
      [findingRefKey(finding)]: { finding, disposition: "dismissed" as const },
    };
    const previous = mkBoard([
      mkSection("old-section", "Findings", ["old-finding"]),
      mkFinding("old-finding", "The retry can lose its terminal record.", ["old-code"]),
      mkCodeRef("old-code", "src/auth.ts", 11, 12),
    ]);
    const persisted: Array<readonly unknown[]> = [];
    let flaggedTurns = 0;

    const result = await runLensPipeline({
      ...boardSeats([], (prompt, label) => {
        const lens = lensFromPrompt(prompt, label);
        if (lens === "flagged") {
          flaggedTurns += 1;
          return { absence: "no-findings" };
        }
        return cleanBody(lens);
      }),
      repoRoot: "/pr-worktree",
      deltaPacket: {
        ...PACKET,
        successorAccount: { asks: [], beyondAsks: [] },
      },
      round: {
        number: 1,
        previousGeneration: "gen:ps-0",
        previousFlaggedBoardId: finding.boardId,
        dispatchedAsks: [],
        findingDispositions: {},
      },
      lintContextFor: (lens) => ({
        ...lintContextFor(lens),
        regions: [{ path: "src/auth.ts", side: "head", start: 1, end: 200 }],
        files: new Map([["src/auth.ts", 200]]),
      }),
      previous: new Map<LintTarget, DraftBoard>([["flagged", previous]]),
      readPrompt,
      whiteboard: fakeWhiteboard([]),
      boardIdFor: (lens) => `board:${lens}`,
      readFindingDispositions: () => dispositions,
      persistFindingResolutions: (_generation, _boardId, resolutions) => {
        persisted.push([...resolutions]);
      },
    });

    const expectedResolution = {
      kind: "detached" as const,
      finding,
      reason: "current-finding-not-uniquely-matched" as const,
    };
    expect(flaggedTurns).toBe(1);
    const flagged = result.boards.find(({ lens }) => lens === "flagged");
    expect(flagged).toMatchObject({ absence: "no-findings" });
    expect(flagged?.findingResolutions).toEqual([expectedResolution]);
    expect(persisted).toEqual([[expectedResolution]]);
  });

  it("fails only Flagged before its write when the live disposition read throws", async () => {
    const applied: Applied[] = [];
    let persistenceCalls = 0;

    const result = await runLensPipeline({
      ...boardSeats([], (prompt, label) => cleanBody(lensFromPrompt(prompt, label))),
      repoRoot: "/pr-worktree",
      deltaPacket: PACKET,
      round: {
        number: 1,
        // Same generation: isolate the Flagged failure boundary without drafting a report.
        previousGeneration: "gen:ps-1",
        dispatchedAsks: [],
        findingDispositions: {},
      },
      lintContextFor,
      readPrompt,
      whiteboard: fakeWhiteboard(applied),
      boardIdFor: (lens) => `board:${lens}`,
      readFindingDispositions: () => {
        throw new Error("ask log read unavailable");
      },
      persistFindingResolutions: () => {
        persistenceCalls += 1;
      },
    });

    const flagged = result.boards.find((outcome) => outcome.lens === "flagged");
    expect(flagged?.failure).toContain("ask log read unavailable");
    expect(flagged?.board).toBeUndefined();
    // Noise writes NO board here, and that is D16d rather than a second defect: Flagged
    // failed, so what it would have cited is unknown and the complement cannot be taken.
    expect(applied.map(({ boardId }) => boardId).sort()).toEqual(
      ["board:design", "board:sequence", "board:decisions"].sort(),
    );
    const noise = result.boards.find((outcome) => outcome.lens === "noise");
    expect(noise?.failure).toContain("flagged");
    expect(noise?.board).toBeUndefined();
    expect(
      result.boards
        .filter((outcome) => outcome.lens !== "flagged" && outcome.lens !== "noise")
        .every((outcome) => outcome.board !== undefined && outcome.failure === undefined),
    ).toBe(true);
    expect(persistenceCalls).toBe(0);
  });

  it("fails Flagged before its write when resolution persistence rejects", async () => {
    const applied: Applied[] = [];
    const finding = {
      generation: "gen:ps-0",
      boardId: "board:flagged:ps-0",
      findingId: "finding",
    };
    const flaggedBoard = mkBoard([
      {
        id: "findings",
        kind: "section",
        data: { author: flaggedAuthor, title: "Findings", children: ["finding"] },
      },
      mkFinding("finding", "The retry can lose its terminal record.", ["code"]),
      mkCodeRef("code", "src/auth.ts", 11, 12),
    ]);

    const result = await runLensPipeline({
      ...boardSeats([], (prompt, label) => {
        const lens = lensFromPrompt(prompt, label);
        if (lens === "flagged") return flaggedBoard;
        if (lens === "report") return cleanBody("report");
        if (lens === "post-process") {
          const context = /rennet:layer context>>>\n(\{.*)/s.exec(prompt);
          return context ? (JSON.parse(context[1] as string).board as unknown) : { elements: [] };
        }
        return cleanBody(lens);
      }),
      repoRoot: "/pr-worktree",
      deltaPacket: {
        ...PACKET,
        successorAccount: { asks: [], beyondAsks: [] },
      },
      round: {
        number: 1,
        previousGeneration: finding.generation,
        previousFlaggedBoardId: finding.boardId,
        dispatchedAsks: [],
        findingDispositions: {
          [findingRefKey(finding)]: { finding, disposition: "dismissed" },
        },
      },
      lintContextFor: (lens) => ({
        ...lintContextFor(lens),
        regions: [{ path: "src/auth.ts", side: "head", start: 1, end: 200 }],
        files: new Map([["src/auth.ts", 200]]),
      }),
      previous: new Map<LintTarget, DraftBoard>([["flagged", flaggedBoard]]),
      readPrompt,
      whiteboard: fakeWhiteboard(applied),
      boardIdFor: (lens) => `board:${lens}`,
      persistFindingResolutions: () => {
        throw new Error("ask log unavailable");
      },
    });

    // `stable-id` is no longer reachable through the tool path and the change is not a
    // regression to repair: the previous round's finding kept its id because the seat minted
    // it, and the host mints ids now, so a round's finding is re-anchored by its content
    // instead. The subject here is the FAILURE boundary — Flagged fails before its write and
    // still carries its resolution — so the resolution is asserted as a reattachment of the
    // right finding rather than by which matcher recognised it.
    const flagged = result.boards.find((outcome) => outcome.lens === "flagged");
    expect(flagged?.failure).toContain("ask log unavailable");
    expect(flagged?.board).toBeUndefined();
    expect(flagged?.findingResolutions).toHaveLength(1);
    expect(flagged?.findingResolutions?.[0]).toMatchObject({ kind: "reattached", finding });
    expect(result.findingResolutions).toEqual(flagged?.findingResolutions);
    expect(applied.some(({ boardId }) => boardId === "board:flagged")).toBe(false);
  });

  it("does NOT run the round-report on a first generation (no successor account)", async () => {
    const applied: Applied[] = [];
    const result = await runLensPipeline({
      ...boardSeats([], (p, label) => cleanBody(lensFromPrompt(p, label))),
      repoRoot: "/pr-worktree",
      deltaPacket: PACKET,
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
      ...boardSeats([], (p, label) => cleanBody(lensFromPrompt(p, label))),
      repoRoot: "/pr-worktree",
      deltaPacket: PACKET,
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

  // PR #802 wrote the reviewed pull request's own paper into the session's context
  // directory; the Design seat is the one that needs it, because the PR body is the
  // strongest clue to which spec this branch implements.
  it("names `pr.md` in the DESIGN seat's prompt only, and writes it where that path points", async () => {
    const turns: SeatCapture[] = [];
    const written: SessionContextFile[] = [];
    const prPaper: SessionContextFile = {
      name: "pr.md",
      body: "# Implement the session-bound workspace\n\nCloses #1.\n",
      holds: "The reviewed pull request's own title and description, as the capture froze them.",
      readWhen: "when you need what the author SAID this change is for — it names the spec.",
    };
    await runLensPipeline({
      ...boardSeats(turns, (prompt, seat) => cleanBody(lensFromPrompt(prompt, seat))),
      prPaper,
      repoRoot: "/pr-worktree",
      deltaPacket: PACKET,
      lintContextFor,
      readPrompt,
      whiteboard: fakeWhiteboard([]),
      boardIdFor: (lens) => `board:${lens}`,
      writeContext: (files) => {
        written.push(...files);
        return ".rennet/context/s1";
      },
    });
    // Written through the ONE sink, so the file lands in the root the seats run in and the
    // directory's `README.md` indexes it — the path the Design prompt names resolves.
    expect(written.map(({ name }) => name)).toContain("pr.md");
    expect(written.find(({ name }) => name === "pr.md")?.body).toContain("Closes #1.");
    const promptFor = (seat: string): string =>
      turns.find((turn) => turn.seat === seat)?.prompt ?? "";
    expect(promptFor("design")).toContain("`.rennet/context/s1/pr.md`");
    expect(promptFor("design")).toContain(prPaper.readWhen);
    // …and the body never rides the prompt: the seat opens the file.
    expect(promptFor("design")).not.toContain("Closes #1.");
    for (const seat of ["sequence", "decisions", "flagged-claude", "noise"]) {
      expect(promptFor(seat), seat).not.toContain("pr.md");
    }
  });

  it("names no `pr.md` on a branch review, which has no pull request to read", async () => {
    // The control for the test above: same pipeline, same Design seat, no `prPaper` —
    // and the line disappears. A prompt naming a file the capture never wrote would send
    // the seat looking for evidence that does not exist.
    const turns: SeatCapture[] = [];
    const written: SessionContextFile[] = [];
    await runLensPipeline({
      ...boardSeats(turns, (prompt, seat) => cleanBody(lensFromPrompt(prompt, seat))),
      repoRoot: "/pr-worktree",
      deltaPacket: PACKET,
      lintContextFor,
      readPrompt,
      whiteboard: fakeWhiteboard([]),
      boardIdFor: (lens) => `board:${lens}`,
      writeContext: (files) => {
        written.push(...files);
        return ".rennet/context/s1";
      },
    });
    expect(written.map(({ name }) => name)).not.toContain("pr.md");
    for (const turn of turns) expect(turn.prompt, turn.seat).not.toContain("pr.md");
  });

  it("settles every board as a typed failure naming the missing sidecar, drafting nothing", async () => {
    // session-bound-workspace 5.7: a board seat's only backend is the sidecar. With no
    // seam composed there is nowhere for a lens to run, and the pipeline says exactly that
    // — it does not quietly open a session, because it no longer holds a port to open one
    // with. Control: give the same deps a seam (`boardSeats`) and every lane drafts, which
    // is what the suite above already does on every other test in this file.
    const applied: Applied[] = [];
    const result = await runLensPipeline({
      council: { availability: { installed: ["claude-code", "codex"] } },
      repoRoot: "/pr-worktree",
      deltaPacket: PACKET,
      lintContextFor,
      readPrompt,
      whiteboard: fakeWhiteboard(applied),
      boardIdFor: (lens) => `board:${lens}`,
    });
    expect(applied).toEqual([]);
    // The four CORE lanes name the cause. Noise names its own (D16d): every sibling failed,
    // so what they cite is unknown and it refuses to take a complement over their silence —
    // repeating their reason would claim it got as far as a seat, which it did not.
    const core = result.boards.filter((outcome) => outcome.lens !== "noise");
    expect(core, "every core lane accounted for").toHaveLength(4);
    const noiseLane = result.boards.find((outcome) => outcome.lens === "noise");
    for (const outcome of core) {
      expect(outcome.board).toBeUndefined();
      expect(outcome.failure).toContain("T3 sidecar");
    }
    expect(noiseLane?.board).toBeUndefined();
    expect(noiseLane?.failure).toContain("the remainder cannot be taken");
  });

  it("refuses a board seat whose harness the host has not got, before opening a thread", async () => {
    // The ephemeral legs used to catch this on the way past ("resolved to codex, which is
    // unavailable"). With them gone the council's own installed list is the only thing that
    // can, and the refusal has to land BEFORE the seam — a thread opened on an absent
    // provider spends a turn discovering what the host already said.
    const turns: SeatCapture[] = [];
    const applied: Applied[] = [];
    const result = await runLensPipeline({
      ...boardSeats(turns, () => cleanBody("sequence"), []),
      repoRoot: "/pr-worktree",
      deltaPacket: PACKET,
      lintContextFor,
      readPrompt,
      whiteboard: fakeWhiteboard(applied),
      boardIdFor: (lens) => `board:${lens}`,
    });
    // No turn was dispatched at all — not one thread, not one prompt.
    expect(turns).toEqual([]);
    expect(applied).toEqual([]);
    // The four CORE lanes name the cause. Noise names its own (D16d): every sibling failed,
    // so what they cite is unknown and it refuses to take a complement over their silence —
    // repeating their reason would claim it got as far as a seat, which it did not.
    const core = result.boards.filter((outcome) => outcome.lens !== "noise");
    expect(core, "every core lane accounted for").toHaveLength(4);
    const noiseLane = result.boards.find((outcome) => outcome.lens === "noise");
    for (const outcome of core) {
      expect(outcome.board, outcome.lens).toBeUndefined();
      // The Flagged lane checks the same list one level up, per seat, and names both
      // absences; every other core lane gets the seat resolution's own words.
      expect(outcome.failure, outcome.lens).toContain(
        outcome.lens === "flagged"
          ? "no claude harness; no codex harness"
          : "which is not installed",
      );
    }
    expect(noiseLane?.board).toBeUndefined();
    expect(noiseLane?.failure).toContain("the remainder cannot be taken");
  });

  it("names the daemon's OWN reason when the sidecar was composed and would not start", async () => {
    const applied: Applied[] = [];
    const result = await runLensPipeline({
      // BOTH installed, so the Flagged lane's two seats fail for the same reason — the
      // sidecar — and nothing else can account for either.
      council: { availability: { installed: ["claude-code", "codex"] } },
      t3Unavailable: "the vendored bundle is not staged",
      repoRoot: "/pr-worktree",
      deltaPacket: PACKET,
      lintContextFor,
      readPrompt,
      whiteboard: fakeWhiteboard(applied),
      boardIdFor: (lens) => `board:${lens}`,
    });
    // The four CORE lanes name the cause. Noise names its own (D16d): every sibling failed,
    // so what they cite is unknown and it refuses to take a complement over their silence —
    // repeating their reason would claim it got as far as a seat, which it did not.
    const core = result.boards.filter((outcome) => outcome.lens !== "noise");
    expect(core, "every core lane accounted for").toHaveLength(4);
    const noiseLane = result.boards.find((outcome) => outcome.lens === "noise");
    expect(noiseLane?.failure).toContain("the remainder cannot be taken");
    for (const outcome of core) {
      expect(outcome.failure).toContain("the vendored bundle is not staged");
      // Once, not twice. One cause taking both Flagged seats out and printed twice reads
      // as two different problems the reviewer has to go and find.
      expect(
        outcome.failure?.match(/the vendored bundle is not staged/g),
        outcome.lens,
      ).toHaveLength(1);
    }
  });
});

// ── Persistence honesty (findings 2/3/6) ─────────────────────────────────────

describe("runLensPipeline — persistence honesty (findings 2/3/6)", () => {
  const flaggedCtx: LintContext = {
    lens: "flagged",
    regions: [
      { path: "src/auth.ts", side: "head", start: 10, end: 14 },
      { path: "src/util.ts", side: "head", start: 1, end: 3 },
    ],
    files: new Map([
      ["src/auth.ts", 200],
      ["src/util.ts", 50],
    ]),
    patchsetId: PACKET.patchset.id,
  };
  // A flagged board whose finding is authored BEFORE the code_ref it cites (the
  // bad-ref hazard).
  const flaggedBody = (): DraftBoard =>
    mkBoard([
      mkFinding("f1", "The refresh token is classified as an error before its code is read.", [
        "c1",
      ]),
      mkCodeRef("c1", "src/auth.ts", 11, 12),
      mkSection("findings", "Findings", ["f1"]),
    ]);
  const bodyForFlagged = (prompt: string, label?: string): unknown => {
    const lens = lensFromPrompt(prompt, label);
    if (lens === "flagged") return flaggedBody();
    if (lens === "post-process") {
      const ctx = /rennet:layer context>>>\n(\{.*)/s.exec(prompt);
      if (!ctx) return { elements: [] };
      const draft = JSON.parse(ctx[1] as string).board as DraftBoard;
      // Adversarial editor: it removes authored documents and invents one on a
      // legacy draft. The runtime must restore/remove the envelope around this pass.
      return draft.document === undefined
        ? {
            ...draft,
            document: {
              title: "Invented by the editor",
              introMarkdown: "This did not come from the drafting seat.",
              measure: "structured",
            },
          }
        : { ...draft, document: undefined };
    }
    if (lens === "sequence") {
      return {
        ...cleanBody(lens),
        document: {
          title: "Follow the accepted write",
          introMarkdown: "The walk starts at persistence and ends at the reader.",
          // Deliberately wrong for Sequence: persistence owns the target measure.
          measure: "structured",
        },
      };
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

      const collisionId = await runtime.createRennetBoard();
      const collision = await client.apply(
        collisionId,
        draftToOps(decisionStringCollisionBody()) as never,
        "lens:decisions",
      );
      expect(collision.response.ok).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("writes through a REAL board service and persists the document durably (findings 2/3)", async () => {
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
        ...boardSeats([], bodyForFlagged),
        repoRoot: "/pr-worktree",
        deltaPacket: PACKET,
        lintContextFor: (l) => (l === "flagged" ? flaggedCtx : lintContextFor(l)),
        readPrompt,
        whiteboard: client,
        boardIdFor: (l) => boardIds.get(l) ?? "",
        onBoardArrival: (event) => {
          arrivals.push(event);
        },
        persistBoardMeta: (m) => {
          meta.push(m);
        },
      });

      // The finding-before-code_ref board was ACCEPTED (draftToOps reordering worked
      // through the real service) — not a silent failure.
      const flagged = result.boards.find((b) => b.lens === "flagged");
      expect(flagged?.failure).toBeUndefined();

      // Reconstruct the flagged board from the ACTUAL event log — both elements landed, and
      // the finding's citation resolves against the code_ref beside it. Read by KIND and by
      // reference rather than by fixture id, because every id on this board is the host's.
      const flaggedId = boardIds.get("flagged") ?? "";
      const state = await runtime.service.getState(flaggedId);
      const landed = [...state.values()] as { id: string; kind: string; data: unknown }[];
      const finding = landed.find(({ kind }) => kind === "finding");
      const citation = landed.find(({ kind }) => kind === "code_ref");
      expect(finding, "no finding landed in the board service's state").toBeDefined();
      expect(citation, "no code_ref landed in the board service's state").toBeDefined();
      expect((finding?.data as { code?: unknown[] } | undefined)?.code).toEqual([citation?.id]);

      // The document survived persistence via the durable metadata seam — the event
      // log carries only elements, so this is the finding-3 durability proof.
      const flaggedMeta = meta.find((m) => m.lens === "flagged");
      expect(flaggedMeta?.document).toEqual({
        title: "Flagged",
        introMarkdown: "",
        measure: "reading",
      });
      expect(meta.find((m) => m.lens === "sequence")?.document).toEqual({
        title: "Follow the accepted write",
        introMarkdown: "The walk starts at persistence and ends at the reader.",
        measure: "reading",
      });
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
      ...boardSeats([], (p, label) => cleanBody(lensFromPrompt(p, label))),
      repoRoot: "/pr-worktree",
      deltaPacket: PACKET,
      lintContextFor,
      readPrompt,
      whiteboard: rejecting,
      boardIdFor: (l) => `board:${l}`,
      onBoardArrival: (event) => {
        arrivals.push(event);
      },
    });
    for (const o of result.boards) expect(o.failure).toBeDefined();
    // A rejected write is never announced as arrived.
    expect(arrivals).toEqual([]);
  });

  it("surfaces a never-parseable drafter as a lens failure, never an empty board (finding 6)", async () => {
    const applied: Applied[] = [];
    const result = await runLensPipeline({
      ...boardSeats([], () => ({ not: "a board" })), // never parses
      repoRoot: "/pr-worktree",
      deltaPacket: PACKET,
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
    const applied: Applied[] = [];
    const result = await runLensPipeline({
      ...boardSeats([], () => {
        throw new Error("live claude crashed");
      }),
      repoRoot: "/pr-worktree",
      deltaPacket: PACKET,
      lintContextFor,
      readPrompt,
      whiteboard: fakeWhiteboard(applied),
      boardIdFor: (l) => `board:${l}`,
    });
    for (const o of result.boards) expect(o.failure).toBeDefined();
    expect(applied).toEqual([]);
  });

  it("keeps the harness's own words in the failure, under a spent-ladder terminal account", async () => {
    const boards = fixtureGenerationBoards();
    const failing = fakeT3Seam([], () => undefined, boards);
    const result = await runLensPipeline({
      council: { availability: { installed: ["claude-code"] } },
      boards,
      t3: {
        ...failing,
        client: async () => ({
          ...(await failing.client()),
          waitForTurnSettled: async (threadId: string) => ({
            turnId: `${threadId}:turn`,
            state: "error" as const,
            errorMessage: "structured output exceeded the seat capability",
            thread: { messages: [], session: null },
          }),
        }),
      },
      repoRoot: "/pr-worktree",
      deltaPacket: PACKET,
      lintContextFor,
      readPrompt,
      whiteboard: fakeWhiteboard([]),
      boardIdFor: (l) => `board:${l}`,
    });
    // The four CORE lanes name the cause. Noise names its own (D16d): every sibling failed,
    // so what they cite is unknown and it refuses to take a complement over their silence —
    // repeating their reason would claim it got as far as a seat, which it did not.
    const core = result.boards.filter((outcome) => outcome.lens !== "noise");
    expect(core, "every core lane accounted for").toHaveLength(4);
    const noiseLane = result.boards.find((outcome) => outcome.lens === "noise");
    expect(noiseLane?.failure).toContain("the remainder cannot be taken");
    for (const outcome of core) {
      // The harness's message survives into the lens failure verbatim…
      expect(outcome.failure).toContain("structured output exceeded the seat capability");
      // …and the TYPED account beside it is the ladder's verdict, which the old name
      // claimed and the old body never read: every re-ask was spent on a seat that never
      // emitted, so it is terminal with a real attempt count, not `attempt: 0`.
      expect(outcome.failureAccount?.classification).toBe("terminal");
      expect(outcome.failureAccount?.attempt).toBeGreaterThan(0);
    }
  });
});

describe("createNodePromptReader (perf audit §4 M)", () => {
  it("reads each prompt file from disk exactly once, however many lenses ask for it", () => {
    // A round asks for every lens prompt for every lens, and the prompt files ship with the
    // daemon — they cannot change while it runs. Counted by MUTATING the file after the
    // first read: a reader that re-read disk would return the new bytes.
    const dir = mkdtempSync(join(tmpdir(), "rennet-prompts-"));
    try {
      writeFileSync(join(dir, "one.md"), "first");
      writeFileSync(join(dir, "two.md"), "second");
      const read = createNodePromptReader(dir);

      expect(read("one.md")).toBe("first");
      expect(read("two.md")).toBe("second");

      writeFileSync(join(dir, "one.md"), "REWRITTEN");
      expect(read("one.md")).toBe("first"); // memoized, not re-read
      // …and the memo is per PATH, not one slot: the other file is still its own text.
      expect(read("two.md")).toBe("second");

      // The other direction of the control: a reader that has not read `one.md` yet does
      // see the rewritten bytes, so the assertion above is about the memo and not about
      // some quirk of the fixture.
      expect(createNodePromptReader(dir)("one.md")).toBe("REWRITTEN");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("renderDrafterPrompt — nothing of the change travels; the context is a path (3.1)", () => {
  const HUNK_BODY = "+const SECRET_BODY_LINE = 42;";
  const RANGE_PACKET = {
    patchset: {
      id: "ps-r",
      createdAt: "",
      truncated: false,
      repository: {
        baseRef: "main",
        baseOid: "b".repeat(40),
        headOid: "h".repeat(40),
      },
      files: [],
    },
    hunks: {
      hunks: [
        {
          id: "hunk-1",
          path: "src/a.ts",
          header: "@@ -1,1 +1,1 @@",
          body: [HUNK_BODY],
          spans: { old: { start: 1, lines: 1 }, new: { start: 1, lines: 1 } },
          lossy: false,
        },
      ],
      byId: new Map(),
    },
  } as unknown as DeltaPacket;

  /**
   * The packet with EVERY derived section populated — including `noisePreclass`, whose
   * records carry a `hunkId` (review finding on 3.1: a fixture without it cannot see the
   * id leak through the projection). Any of these reaching the prompt reddens below.
   */
  const FULL_PACKET = {
    ...RANGE_PACKET,
    blastRadius: [{ kind: "fan-in", path: "src/a.ts", detail: "BLAST_SENTINEL" }],
    noisePreclass: [{ hunkId: "hunk-1", path: "src/a.ts", reason: "PRECLASS_SENTINEL" }],
    counterpartHints: [{ path: "src/a.ts", counterpart: "src/a.test.ts", note: "HINT_SENTINEL" }],
    dossier: [{ title: "DOSSIER_SENTINEL" }],
    openspec: { changes: [{ name: "OPENSPEC_SENTINEL", artifactPaths: [] }] },
  } as unknown as DeltaPacket;
  const CONTEXT = { dir: ".rennet/context/s1", files: [] };

  it("carries nothing of the packet: no hunk body, id, header, span, blast radius, preclass, hint, dossier or openspec touch", () => {
    const prompt = renderDrafterPrompt("lens instructions", FULL_PACKET, CONTEXT);
    // Positive control: every sentinel IS in the packet — anything of it creeping back
    // into a layer turns the assertions below red.
    const packetJson = JSON.stringify(FULL_PACKET);
    for (const sentinel of [
      SECRET(HUNK_BODY),
      "hunk-1",
      "@@ -1,1 +1,1 @@",
      "BLAST_SENTINEL",
      "PRECLASS_SENTINEL",
      "HINT_SENTINEL",
      "DOSSIER_SENTINEL",
      "OPENSPEC_SENTINEL",
      '"files":[]',
    ]) {
      expect(packetJson, sentinel).toContain(sentinel);
      expect(prompt, sentinel).not.toContain(sentinel);
    }
    expect(inlineContextViolation(prompt)).toBeUndefined();
    // What still rides: the reviewed range, its diff command, and the path reference.
    expect(prompt).toContain(`git diff ${"b".repeat(40)}...${"h".repeat(40)}`);
    expect(prompt).toContain("<<<rennet:layer context>>>");
    expect(prompt).toContain("`.rennet/context/s1/`");
    expect(prompt).toContain("`README.md`");
    // The task layer no longer contradicts the partial's "read it yourself".
    expect(prompt).not.toContain("INVENTORY");
  });

  it("the context layer is a path reference under two kilobytes whatever the change's size", () => {
    const big = {
      ...FULL_PACKET,
      patchset: {
        ...FULL_PACKET.patchset,
        files: Array.from({ length: 74 }, (_, i) => ({
          path: `src/file-${i}.ts`,
          status: "modified",
          additions: 40,
          deletions: 4,
          binary: false,
        })),
      },
    } as unknown as DeltaPacket;
    const roundFile = roundContextFile({
      number: 2,
      previousGeneration: "g1",
      dispatchedAsks: [],
      findingDispositions: {},
    });
    const withRound = { dir: ".rennet/context/s1", files: [roundFile] };
    const small = renderDrafterPrompt("lens instructions", FULL_PACKET, withRound);
    const large = renderDrafterPrompt("lens instructions", big, withRound);
    // Byte-identical: the change's size does not reach the prompt at all.
    expect(large).toBe(small);
    const layer = small.slice(small.indexOf("<<<rennet:layer context>>>"));
    expect(Buffer.byteLength(layer, "utf8")).toBeLessThan(2_048);
    expect(layer).toContain(`\`.rennet/context/s1/${ROUND_CONTEXT_FILE}\``);
    expect(layer).toContain(roundFile.holds);
  });

  it("names no directory in the direct-call shape (no writer), and says so by omission", () => {
    const prompt = renderDrafterPrompt("lens instructions", FULL_PACKET);
    expect(prompt).not.toContain("<<<rennet:layer context>>>");
    expect(prompt).not.toContain(".rennet/context");
  });

  it("names the three-dot merge-base range on a range capture, never two-dot", () => {
    const prompt = renderDrafterPrompt("lens instructions", RANGE_PACKET);
    // Three-dot: an advanced base with two dots invents base-only deletions.
    expect(prompt).toContain(`git diff ${"b".repeat(40)}...${"h".repeat(40)}`);
    expect(prompt).not.toContain(`git diff ${"b".repeat(40)}..${"h".repeat(40)} `);
    expect(prompt).toContain("reviewing the commits since");
    // The prompt never claims the checkout IS the reviewed state; pinned reads instead.
    expect(prompt).not.toContain("IS the reviewed checkout");
    expect(prompt).toContain(`git show ${"h".repeat(40)}:<path>`);
  });

  it("names the pinned reviewed tree on a working-tree capture — never base..head", () => {
    const tree = "c".repeat(40);
    const packet = {
      ...RANGE_PACKET,
      patchset: {
        ...RANGE_PACKET.patchset,
        repository: { ...RANGE_PACKET.patchset.repository, reviewedTreeOid: tree },
      },
    } as unknown as DeltaPacket;
    const prompt = renderDrafterPrompt("lens instructions", packet);
    // The pinned tree is the reviewed delta; base..head would show only the
    // committed subset and silently omit uncommitted work.
    expect(prompt).toContain(`git diff ${"b".repeat(40)} ${tree}`);
    expect(prompt).not.toContain(`git diff ${"b".repeat(40)}..${"h".repeat(40)}`);
    expect(prompt).toContain("uncommitted work included");
    expect(prompt).toContain(`git show ${tree}:<path>`);
  });

  it("round.json holds the asks, the worker's identity and the frozen report — the prompt only names it", () => {
    const report = { document: { title: "REPORT_TITLE_SENTINEL" }, elements: [] } as never;
    const file = roundContextFile(
      {
        number: 2,
        previousGeneration: "g1",
        dispatchedAsks: [{ id: "ask-1", path: "src/a.ts", instruction: "ASK_SENTINEL" }] as never,
        findingDispositions: {},
      },
      report,
    );
    expect(file.name).toBe(ROUND_CONTEXT_FILE);
    const body = JSON.parse(file.body) as Record<string, unknown>;
    expect(body.number).toBe(2);
    expect(body.dispatchedAsks).toEqual([
      { id: "ask-1", path: "src/a.ts", instruction: "ASK_SENTINEL" },
    ]);
    expect(body.report).toEqual(report);
    // Compact: no pretty-print surcharge in a file a model reads either.
    expect(file.body).not.toContain("\n");
    const prompt = renderDrafterPrompt("lens instructions", RANGE_PACKET, {
      dir: ".rennet/context/s1",
      files: [file],
    });
    expect(prompt).toContain(`\`.rennet/context/s1/${ROUND_CONTEXT_FILE}\``);
    expect(prompt).not.toContain("ASK_SENTINEL");
    expect(prompt).not.toContain("REPORT_TITLE_SENTINEL");
    expect(prompt).not.toContain('"number":2');
  });

  it("keeps the worker's verbatim turn diff out of every drafter prompt", () => {
    // The classified round-report path carries a measured evidence manifest (#727);
    // no drafter prompt embeds the raw diff any more (#737).
    const WORKER_DIFF = "+const WORKER_DIFF_SENTINEL = 7;";
    const round = {
      number: 2,
      dispatchedAsks: [],
      worker: {
        outcome: "completed",
        diff: WORKER_DIFF,
        changedPaths: ["src/a.ts"],
        commitRange: { from: "c0", to: "c1" },
      },
    } as never;
    const file = roundContextFile(round);
    // The file carries the worker's identity, never its diff — the seat reads the turn's
    // change from the checkout at the commit range.
    expect(file.body).not.toContain(SECRET(WORKER_DIFF));
    expect(file.body).toContain('"changedPaths":["src/a.ts"]');
    expect(file.body).toContain('"commitRange":{"from":"c0","to":"c1"}');
    const context = { dir: ".rennet/context/s1", files: [file] };
    const lens = renderDrafterPrompt("lens instructions", RANGE_PACKET, context);
    const report = renderDrafterPrompt("report instructions", RANGE_PACKET, context, {
      omitTaskLayer: true,
    });
    for (const prompt of [lens, report]) {
      expect(prompt).not.toContain(SECRET(WORKER_DIFF));
      expect(prompt).not.toContain("changedPaths");
      expect(prompt).not.toContain("commitRange");
    }
  });

  it("omits the task layer for the legacy report seat", () => {
    const prompt = renderDrafterPrompt("report instructions", RANGE_PACKET, CONTEXT, {
      omitTaskLayer: true,
    });
    expect(prompt).not.toContain("rennet:layer task");
    expect(prompt).toContain("rennet:layer context");
  });
});

describe("round-report classifier — the evidence is a file the prompt names (3.4)", () => {
  const DIFF = [
    "diff --git a/src/a.ts b/src/a.ts",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1 +1 @@",
    "-old",
    "+EVIDENCE_BODY_SENTINEL",
    "",
  ].join("\n");
  const round = {
    number: 3,
    previousGeneration: "g2",
    dispatchedAsks: [{ id: "ask-9", path: "src/a.ts", instruction: "ASK_TEXT_SENTINEL" }],
    findingDispositions: {},
    worker: {
      outcome: "completed",
      diff: DIFF,
      changedPaths: ["src/a.ts"],
      commitRange: { from: "c0", to: "c1" },
    },
  } as never;
  const manifest = buildRoundEvidenceManifest(DIFF);
  const evidenceJson = JSON.stringify(manifest);

  it("evidence.json is one object with exactly patchsetId, dispatchedAsks, worker and the measured manifest bytes", () => {
    const file = roundEvidenceFile("ps-9", round, evidenceJson);
    expect(file.name).toBe(ROUND_EVIDENCE_FILE);
    const body = JSON.parse(file.body) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(["patchsetId", "dispatchedAsks", "worker", "evidence"]);
    expect(body.patchsetId).toBe("ps-9");
    expect(body.dispatchedAsks).toEqual([
      { id: "ask-9", path: "src/a.ts", instruction: "ASK_TEXT_SENTINEL" },
    ]);
    expect(body.worker).toEqual({
      outcome: "completed",
      changedPaths: ["src/a.ts"],
      commitRange: { from: "c0", to: "c1" },
    });
    // Spliced verbatim: the measured bytes are the file's bytes.
    expect(file.body.endsWith(`,"evidence":${evidenceJson}}`)).toBe(true);
    expect(file.body).toContain("EVIDENCE_BODY_SENTINEL");
    expect(file.body).toMatch(/"id":"ev-[0-9a-f]{16}"/);
  });

  it("the prompt names evidence.json and carries none of it", () => {
    const file = roundEvidenceFile("ps-9", round, evidenceJson);
    const prompt = renderRoundReportClassifierPrompt("report instructions", {
      dir: ".rennet/context/s1",
      files: [file],
    });
    expect(prompt).toContain(`\`.rennet/context/s1/${ROUND_EVIDENCE_FILE}\``);
    expect(prompt).toContain(file.holds);
    for (const sentinel of ["EVIDENCE_BODY_SENTINEL", "ASK_TEXT_SENTINEL", '"evidence":', "ev-"]) {
      expect(prompt, sentinel).not.toContain(sentinel);
    }
    expect(inlineContextViolation(prompt)).toBeUndefined();
    const layer = prompt.slice(prompt.indexOf("<<<rennet:layer context>>>"));
    expect(Buffer.byteLength(layer, "utf8")).toBeLessThan(2_048);
    // Direct-call shape: no directory, so only the instructions.
    expect(renderRoundReportClassifierPrompt("report instructions", undefined)).toBe(
      "<<<rennet:layer payload>>>\nreport instructions",
    );
  });
});

describe("runLensPipeline writes the session context through the ONE writer, before the seats read it", () => {
  const widgetDiff = [
    "diff --git a/src/widget.ts b/src/widget.ts",
    "--- a/src/widget.ts",
    "+++ b/src/widget.ts",
    "@@ -1 +1 @@",
    "-export const widget = 2;",
    "+export const widget = 3;",
  ].join("\n");

  it("evidence.json lands before the classifier turn, round.json (with the report) before the first lens turn, boards/ and the voice before compose", async () => {
    /** Every write, in order, with the names it carried; and every seat prompt, in order. */
    const writes: string[][] = [];
    const written = new Map<string, SessionContextFile>();
    const prompts: { lens: string; prompt: string; writesSoFar: number }[] = [];
    const writeContext = (files: readonly SessionContextFile[]): string => {
      writes.push(files.map((file) => file.name));
      for (const file of files) written.set(file.name, file);
      return ".rennet/context/s1";
    };
    let composePrompt = "";
    const result = await runLensPipeline({
      ...boardSeats([], (prompt, label) => {
        const lens = lensFromPrompt(prompt, label);
        prompts.push({ lens, prompt, writesSoFar: writes.length });
        if (lens === "report") {
          return {
            outcomes: [
              {
                askId: "ask-one",
                status: "addressed",
                note: "The exact changed line now carries the requested value.",
                evidenceIds: manifestIds(widgetDiff),
              },
            ],
            beyond: [],
          };
        }
        return cleanBody(lens);
      }),
      repoRoot: "/pr-worktree",
      writeContext,
      deltaPacket: PACKET,
      currentGeneration: "gen:ps-1:dispatch:context",
      round: {
        number: 1,
        previousGeneration: "gen:ps-0",
        dispatchedAsks: [
          {
            id: "ask-one",
            path: "src/widget.ts",
            type: "request-change",
            instruction: "Bump the widget.",
            context: "",
          },
        ],
        findingDispositions: {},
        worker: {
          outcome: "completed",
          diff: widgetDiff,
          changedPaths: ["src/widget.ts"],
          commitRange: { from: "before", to: "after" },
        },
      },
      lintContextFor,
      readPrompt,
      whiteboard: fakeWhiteboard([]),
      boardIdFor: (lens) => `board:${lens}`,
      composeTurn: (prompt) => {
        composePrompt = prompt;
        return "The change reads cleanly.";
      },
      reviewDraftLintCtx: { files: new Map() },
    });
    expect(result.report?.board).toBeDefined();

    // 1. The classifier's turn came AFTER the write that carried evidence.json.
    const report = prompts.find((entry) => entry.lens === "report");
    expect(report).toBeDefined();
    expect(writes[0]).toEqual([ROUND_EVIDENCE_FILE]);
    expect(report?.writesSoFar).toBeGreaterThanOrEqual(1);
    expect(report?.prompt).toContain(`\`.rennet/context/s1/${ROUND_EVIDENCE_FILE}\``);
    expect(report?.prompt).not.toContain("export const widget = 3;");
    expect(inlineContextViolation(report?.prompt ?? "")).toBeUndefined();

    // 2. Every lens seat's first turn came AFTER the write that carried round.json, whose
    //    body holds the frozen report board — and the index still lists evidence.json.
    expect(writes[1]).toEqual([ROUND_EVIDENCE_FILE, ROUND_CONTEXT_FILE]);
    const lensTurns = prompts.filter((entry) => entry.lens !== "report");
    expect(lensTurns.map((entry) => entry.lens).sort()).toEqual(
      ["decisions", "design", "flagged", "noise", "sequence"].sort(),
    );
    for (const turn of lensTurns) {
      expect(turn.writesSoFar, turn.lens).toBeGreaterThanOrEqual(2);
      expect(turn.prompt, turn.lens).toContain("`.rennet/context/s1/`");
      expect(turn.prompt, turn.lens).toContain(`\`.rennet/context/s1/${ROUND_CONTEXT_FILE}\``);
      expect(turn.prompt, turn.lens).not.toContain("Bump the widget.");
      expect(inlineContextViolation(turn.prompt), turn.lens).toBeUndefined();
    }
    const roundBody = JSON.parse(written.get(ROUND_CONTEXT_FILE)?.body ?? "{}") as {
      report?: { elements: unknown[] };
      dispatchedAsks: { id: string }[];
    };
    expect(roundBody.dispatchedAsks.map((ask) => ask.id)).toEqual(["ask-one"]);
    expect(roundBody.report?.elements.length).toBeGreaterThan(0);

    // 3. Compose: the boards, the voice rules and the index — named, never carried.
    const last = writes.at(-1) ?? [];
    expect(last).toContain("review-draft-voice.md");
    expect(last).toContain("boards/design.json");
    // The round report is its own board, drafted before the lenses; the composition
    // connects the LENS boards, so `boards/` holds one file per lens and no report.
    expect(last).not.toContain("boards/report.json");
    expect(last).toContain(ROUND_EVIDENCE_FILE);
    expect(last).toContain(ROUND_CONTEXT_FILE);
    expect(composePrompt).toContain("`.rennet/context/s1/review-draft-voice.md`");
    expect(composePrompt).toContain("`.rennet/context/s1/boards/`");
    expect(composePrompt).not.toContain("PROMPT_FILE:prompts/review-draft-voice.md");
    expect(inlineContextViolation(composePrompt)).toBeUndefined();
  });
});

/** Indirection so the control string never appears verbatim in this file's own text. */
function SECRET(s: string): string {
  return s;
}

describe("the report gate times a turn that DIED (#731 O4)", () => {
  // The `finally` on the classification turn exists so a turn that did not produce a board
  // still reports how long it took to fail and still names the harness that failed it. That
  // is a control-flow claim, so it gets executed rather than reasoned about: a seat whose
  // session cannot start, and the timing read back.
  //
  // What this CANNOT show, stated rather than implied: the seat wrapper converts an adapter
  // throw into a `failed` turn result, so the observable shape of a dying turn here is
  // `status: "failed"` and not a rejected promise. The `finally` covers both — it runs after
  // the `catch` and after a non-emitting return — and only the second is reachable through
  // the real harness path, which is the one this test drives.
  const round = {
    number: 1,
    previousGeneration: "gen:ps-0",
    dispatchedAsks: [
      {
        id: "ask-one",
        path: "src/auth.ts",
        type: "request-change" as const,
        instruction: "Replace the line.",
        context: "",
      },
    ],
    findingDispositions: {},
    worker: {
      outcome: "completed" as const,
      diff: ONE_LINE_DIFF,
      changedPaths: ["src/auth.ts"],
      commitRange: { from: "before", to: "after" },
    },
  };

  it("still emits report-classification, with its harness, when the turn dies without emitting", async () => {
    const timings: GenerationPhaseTiming[] = [];
    let failure: unknown;
    // The classification seat is `report`, and the fake sidecar dies on THAT seat's thread
    // and no other. The failure message asserted below is what proves it: a different
    // seat's turn dying reports a different sentence.
    await runLensPipeline({
      ...boardSeats([], (_prompt, seat) => {
        // The classification seat is `round-report`; every other seat answers normally.
        if (seat === "round-report") {
          throw new Error("the classification session could not start");
        }
        return cleanBody("design");
      }),
      repoRoot: "/pr-worktree",
      deltaPacket: PACKET,
      currentGeneration: "gen:ps-1:dispatch:o4",
      round,
      lintContextFor,
      readPrompt,
      whiteboard: fakeWhiteboard([]),
      boardIdFor: (lens) => `board:${lens}`,
      onPhaseTiming: (timing) => {
        timings.push(timing);
      },
      now: () => Date.now(),
    }).catch((error: unknown) => {
      failure = error;
    });

    // The TURN really died, and died for the reason this test arranged — not the manifest
    // measure, not the seat resolution, not the schema check, each of which returns BEFORE
    // the timed block and would leave the assertion below passing vacuously.
    expect(String(failure)).toContain("classification turn did not emit");
    expect(String(failure)).toContain("the classification session could not start");

    const classification = timings.find(({ phase }) => phase === "report-classification");
    expect(classification).toBeDefined();
    // The whole point: a failure that named no executor would leave the slowest, most
    // interesting turns unattributed in the archive.
    expect(classification?.harness).toBe("claude-code");
    expect(classification?.model).toBeDefined();
    expect(classification?.durationMs).toBeGreaterThanOrEqual(0);
    // Attribution is one fact, not two — the benchmark schema refuses a half of it.
    expect((classification?.harness === undefined) === (classification?.model === undefined)).toBe(
      true,
    );
  });
});

// ── The repair prompt is a PATCH (#737) ──────────────────────────────────────

describe("renderRepairPrompt is pointer-only on every leg (3.2)", () => {
  const FROZEN_BODY = "FROZEN_SENTINEL: the accepted finding's concern";
  const OPEN_BODY = "OPEN_SENTINEL: the prose that failed lint";
  const draft = {
    elements: [
      { id: "f1", kind: "finding", data: { concern: FROZEN_BODY } },
      { id: "p1", kind: "prose", data: { markdown: OPEN_BODY } },
    ],
  } as never;
  const pointers = [
    {
      path: ["elements", 1, "data", "markdown"],
      message: "no code bytes",
      ruleId: "no-code-bytes",
    },
  ];

  it("carries the pointers (each naming its element) and the frozen ids — no draft, no base", () => {
    const prompt = renderRepairPrompt(draft, pointers, ["f1"]);
    expect(prompt.startsWith("<<<rennet:layer task>>>")).toBe(true);
    // The pointer indexes the WHOLE previous draft, which the seat no longer sees, so
    // the element it is about is named beside it (#743 review).
    expect(prompt).toContain(
      'no-code-bytes at ["elements",1,"data","markdown"] (element `p1`): no code bytes',
    );
    expect(prompt).toContain("- `f1`");
    // Positive control for the absence claims: both bodies ARE in the draft.
    expect(JSON.stringify(draft)).toContain(OPEN_BODY);
    expect(JSON.stringify(draft)).toContain(FROZEN_BODY);
    expect(prompt).not.toContain(OPEN_BODY);
    expect(prompt).not.toContain(FROZEN_BODY);
    expect(prompt).not.toContain("Previous draft");
    expect(prompt).not.toContain("elementsToFix");
    expect(inlineContextViolation(prompt)).toBeUndefined();
  });

  it("a parse pointer names no element (its path indexes the rejected return, not this draft)", () => {
    const prompt = renderRepairPrompt(
      draft,
      [{ path: ["elements", 0, "kind"], message: "invalid kind" }],
      ["f1"],
    );
    expect(prompt).toContain('schema at ["elements",0,"kind"]: invalid kind');
    expect(prompt).not.toContain("(element `f1`)");
  });

  it("asks for the whole board when nothing is frozen, still without the draft", () => {
    const prompt = renderRepairPrompt(draft, pointers, []);
    expect(prompt).toContain("and return the whole board:");
    expect(prompt).not.toContain(OPEN_BODY);
    expect(prompt).not.toContain(FROZEN_BODY);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D5 — a citation past the change is refused WHERE IT IS MADE, with the nearest changed
// range, and no element is created. Driven through the REAL pipeline so the context a lane
// actually lints with is the one under test.
//
// WAS: "a citation past the change is an unresolvable-citation pointer", which watched the
// pointer travel on a repair turn and the seat leave the citation behind as an honest
// omission. Neither happens now: the call is refused inside the turn that made it, so
// there is no pointer to send, no repair turn to send it on, and nothing to omit — the
// element the omission accounted for was never created.
// ─────────────────────────────────────────────────────────────────────────────

describe("runLensPipeline — a citation past the change is refused where it is made", () => {
  it("refuses the call with the nearest changed range, costs no attempt, and lands the board", async () => {
    const seatTurns: SeatCapture[] = [];
    const refusals: string[] = [];
    // The seat reaches past the change — src/auth.ts:30-31 when the change is 10..14 —
    // and then cites inside it. Both on one turn, which is the point.
    const citingPast =
      (lens: string) =>
      (voice: BoardVoiceWriter, target: BoardTarget): void => {
        const refused = voice.call("cite", {
          path: "src/auth.ts",
          side: "head",
          start_line: 30,
          end_line: 31,
        });
        if (refused.ok) throw new Error(`${lens}: a citation past the change was accepted`);
        refusals.push(refused.refusal);
        // The board it goes on to write is an ordinary one for its lens.
        replayBoard(voice, target, cleanBody(lens));
        okCall(voice.call("finish"));
      };

    const result = await runLensPipeline({
      ...boardSeats(seatTurns, (prompt, label) => {
        const lens = lensFromPrompt(prompt, label);
        return lens === "flagged" || lens === "design" ? citingPast(lens) : cleanBody(lens);
      }),
      repoRoot: "/pr-worktree",
      deltaPacket: PACKET,
      lintContextFor: (lens) => ({
        lens,
        regions: [{ path: "src/auth.ts", side: "head", start: 10, end: 14 }],
        files: new Map([["src/auth.ts", 200]]),
        patchsetId: "ps-1",
      }),
      readPrompt,
      whiteboard: fakeWhiteboard([]),
      boardIdFor: (lens) => `board:${lens}`,
    });

    // One refusal per seat that tried it — Design, and BOTH of Flagged's voices would try
    // it if two harnesses were installed; this council installs one, so two refusals.
    expect(refusals.length).toBeGreaterThanOrEqual(2);
    for (const refusal of refusals) {
      expect(refusal).toContain("unresolvable-citation");
      // The range it asked for, and the nearest one it could have had. The second half is
      // what makes the refusal answerable rather than merely correct.
      expect(refusal).toContain("src/auth.ts:30-31");
      expect(refusal).toContain("src/auth.ts:10-14");
    }

    for (const lens of ["flagged", "design"] as const) {
      const outcome = result.boards.find((board) => board.lens === lens);
      expect(outcome?.failure, lens).toBeUndefined();
      // Nothing was omitted, because nothing was created: the honest-omission account
      // existed to explain an element the ladder dropped, and the ladder is gone.
      expect(outcome?.omissions, lens).toEqual([]);
      // …and the board holds no citation outside the change.
      for (const element of outcome?.board?.elements ?? []) {
        if (element.kind !== "code_ref") continue;
        const data = element.data as { start_line?: number };
        expect(data.start_line ?? 0, `${lens} kept a citation past the change`).toBeLessThan(30);
      }
      // A refusal costs no attempt (D6), so the lane ran exactly one turn per seat.
      const seats = new Set(
        seatTurns
          .filter(({ seat }) => SEAT_BOARD_TARGET[seat as SeatKind] === lens)
          .map(({ seat }) => seat),
      );
      for (const seat of seats) {
        expect(
          seatTurns.filter((turn) => turn.seat === seat),
          seat,
        ).toHaveLength(1);
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A repair is the NEXT TURN on the seat's own thread (session-bound-workspace 5.7), and
// what it carries is the last `finish` verdict and nothing else (`lens-board-tools` D6).
// Every board seat has a thread and a board that survives the turn, so a repair never has
// to re-send what the conversation and the board already hold.
// ─────────────────────────────────────────────────────────────────────────────

describe("a repair is a second turn on the SAME seat thread, carrying the verdict only", () => {
  /** A seat whose first turn ends unsettled, and whose second finishes the board. */
  const stalling = (lens: string) => {
    let turns = 0;
    return (voice: BoardVoiceWriter, target: BoardTarget): void => {
      turns += 1;
      if (turns === 1) {
        // Wrote one element and stopped: the turn ENDS unsettled, which is the one event
        // that spends an attempt. The element stays on the board.
        okCall(voice.call("add_prose", { markdown: "Half of what this lens found." }));
        return;
      }
      replayBoard(voice, target, cleanBody(lens));
      okCall(voice.call("finish"));
    };
  };

  const run = async (over: Partial<LensPipelineDeps> = {}) => {
    const turns: SeatCapture[] = [];
    const stallers = new Map<string, (voice: BoardVoiceWriter, target: BoardTarget) => void>();
    const result = await runLensPipeline({
      ...boardSeats(
        turns,
        (prompt, label) => {
          const lens = lensFromPrompt(prompt, label);
          if (lens !== "design" && lens !== "flagged") return cleanBody(lens);
          // One stalling script per SEAT, so Flagged's two voices each stall once rather
          // than sharing a counter and one of them settling on its first turn.
          const seat = label ?? lens;
          const script = stallers.get(seat) ?? stalling(lens);
          stallers.set(seat, script);
          return script;
        },
        ["claude-code", "codex"],
      ),
      repoRoot: "/pr-worktree",
      deltaPacket: PACKET,
      lintContextFor: (lens: LintTarget): LintContext => ({
        lens,
        regions: [{ path: "src/auth.ts", side: "head", start: 10, end: 14 }],
        files: new Map([["src/auth.ts", 200]]),
        patchsetId: "ps-1",
      }),
      readPrompt,
      whiteboard: fakeWhiteboard([]),
      boardIdFor: (lens) => `board:${lens}`,
      ...over,
    } as Parameters<typeof runLensPipeline>[0]);
    return { result, turns };
  };

  it("repairs on the drafting turn's own thread, carrying no board and no base prompt", async () => {
    const { result, turns } = await run();
    // Every seat that stalled: Design plus BOTH Flagged seats, which are two sidecar
    // threads on two providers — the lane kept its pair.
    const repairing = [...new Set(turns.map(({ seat }) => seat))].filter(
      (seat) => turns.filter((turn) => turn.seat === seat).length > 1,
    );
    expect(repairing.sort()).toEqual(["design", "flagged-claude", "flagged-codex"]);
    for (const seat of repairing) {
      const seatTurns = turns.filter((turn) => turn.seat === seat);
      const draft = seatTurns[0];
      const repair = seatTurns[1];
      expect(draft, seat).toBeDefined();
      expect(repair, seat).toBeDefined();
      // THE SAME THREAD. A repair on a fresh one would reach a conversation that has
      // never seen the board it is told to continue.
      expect(repair?.threadId, seat).toBe(draft?.threadId);
      // No output schema on either turn — a board seat carries none at all (3.2).
      expect(draft?.outputSchema, seat).toBeUndefined();
      expect(repair?.outputSchema, seat).toBeUndefined();
      // The verdict and nothing else: no base prompt, no board, no draft. This turn ended
      // without ever calling `finish`, so the verdict is that fact.
      const bytes = Buffer.byteLength(repair?.prompt ?? "", "utf8");
      expect(bytes, `${seat} repair prompt bytes`).toBeLessThan(500);
      expect(repair?.prompt, seat).toContain("Your last turn ended without calling `finish`");
      expect(repair?.prompt, seat).not.toContain("PROMPT_FILE:");
      expect(repair?.prompt, seat).not.toContain('"kind":');
      // Not compared against the draft's size: this fixture's prompt files are one-line
      // stubs, so the draft turn here is smaller than any real one. The measured saving
      // (7,107 → 469 bytes) is on the production prompt; the bound above is the claim.
    }
    // And the element the stalled turn wrote is still there — the partial board is KEPT.
    const design = result.boards.find((board) => board.lens === "design");
    expect(
      design?.board?.elements.some(
        (element) =>
          (element.data as { markdown?: unknown }).markdown === "Half of what this lens found.",
      ),
      "the stalled turn's element was discarded",
    ).toBe(true);
  });

  it("CONTROL: no repair turn at all when the first turn finishes the board", async () => {
    // Proves the test above is about the unsettled turn and not about a fixture that always
    // takes a second turn: every seat settles on its first, and every seat runs once.
    const turns: SeatCapture[] = [];
    const result = await runLensPipeline({
      ...boardSeats(turns, (prompt, label) => cleanBody(lensFromPrompt(prompt, label)), [
        "claude-code",
        "codex",
      ]),
      repoRoot: "/pr-worktree",
      deltaPacket: PACKET,
      lintContextFor: (lens: LintTarget): LintContext => ({
        lens,
        regions: [{ path: "src/auth.ts", side: "head", start: 10, end: 14 }],
        files: new Map([["src/auth.ts", 200]]),
        patchsetId: "ps-1",
      }),
      readPrompt,
      whiteboard: fakeWhiteboard([]),
      boardIdFor: (lens) => `board:${lens}`,
    });
    for (const seat of new Set(turns.map(({ seat: id }) => id))) {
      expect(
        turns.filter((turn) => turn.seat === seat),
        seat,
      ).toHaveLength(1);
    }
    for (const lens of ["design", "flagged"] as const) {
      const outcome = result.boards.find((board) => board.lens === lens);
      expect(outcome?.failure, lens).toBeUndefined();
      expect(outcome?.board, lens).toBeDefined();
    }
  });
});
