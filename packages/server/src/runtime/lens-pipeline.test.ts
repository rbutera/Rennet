import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DESIGN_ARTIFACT_LIMITS,
  type DesignArtifactSet,
  sanitizeSchemaForCodex,
  WhiteboardClient,
} from "@rennet/adapters";
import type { DeltaPacket, HarnessPort, LintContext, LintHunk, LintTarget } from "@rennet/core";
import {
  AUTHORED_BOARD_SCHEMA,
  type DraftBoard,
  findingRefKey,
  type LensKind,
  lensAdmitsAbsence,
  ROUND_EVIDENCE_MANIFEST_MAX_BYTES,
  ROUND_REPORT_MAX_BEYOND_ENTRIES,
  ROUND_REPORT_OUTPUT_MAX_BYTES,
  type RoundReportDiagnosticMilestone,
} from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import { createBoardsRuntime } from "../boards/boards-runtime";
import {
  admitBoardReferences,
  aggregateFailureAccount,
  type BoardArrivalEvent,
  type BoardMeta,
  boardOutputSchema,
  composeReviewDraft,
  createNodePromptReader,
  type DesignCoverageMapper,
  designDraftOutputSchema,
  draftToOps,
  projectDesignTaskProgress,
  REPAIR_TARGET_KINDS,
  reconcileFlaggedBoards,
  renderDrafterPrompt,
  runLensPipeline,
  stampSingleSeatConcurrence,
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
const mkBoard = (elements: DraftBoard["elements"], skippedHunks: unknown[] = []): DraftBoard =>
  ({ elements, skippedHunks }) as unknown as DraftBoard;
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

const DESIGN_ARTIFACTS: DesignArtifactSet = {
  changedPaths: ["src/auth.ts", "src/auth.test.ts"],
  omittedChangedPathCount: 0,
  candidates: [
    {
      id: "candidate-1",
      format: "openspec",
      name: "token-refresh",
      nameSourceBytes: 13,
      nameTruncated: false,
      relevance: {
        kind: "references-changed-path",
        paths: ["src/auth.ts", "src/auth.test.ts"],
        omittedPathCount: 0,
      },
      artifacts: [
        {
          path: "openspec/changes/token-refresh/specs/auth/spec.md",
          role: "spec-delta",
          content:
            "## ADDED Requirements\n\n### Requirement: Refresh before retry\nThe system SHALL refresh the token before classifying an error.\n\n#### Scenario: Expired token\nWHEN a request uses an expired token\nTHEN the client refreshes it before retrying.",
          sourceBytes: 237,
          truncated: false,
        },
      ],
      omittedArtifactCount: 0,
    },
  ],
  omittedCandidateCount: 0,
  limits: DESIGN_ARTIFACT_LIMITS,
};

/** The per-lens lint context: empty hunks/files keep the shared fixtures citation-free. */
const lintContextFor = (lens: LintTarget): LintContext => ({
  lens,
  hunks: [],
  files: new Map(),
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
  skippedHunks: [],
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
  skippedHunks: [],
});

const withoutRootSections = (board: DraftBoard): DraftBoard => ({
  ...board,
  elements: board.elements.filter((element) => element.kind !== "section"),
});

const hideRootSectionFromProjection = (board: DraftBoard): DraftBoard => {
  const root = board.elements.find((element) => element.kind === "section");
  if (root === undefined) return board;
  return {
    ...board,
    elements: [
      {
        id: "projection-parent",
        kind: "prose",
        data: {
          author: { kind: "lens-agent", id: "projection-seat" },
          markdown: "This loose field hides the apparent root from the served projection.",
          children: [root.id],
        },
      },
      ...board.elements,
    ],
  };
};

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
  skippedHunks: [],
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
  skippedHunks: [],
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

const DESIGN_LINT_HUNKS: LintHunk[] = [
  { id: "spec-hunk", path: DESIGN_SOURCE, newStart: 1, newLines: 1, oldStart: 1, oldLines: 1 },
  { id: "impl-hunk", path: "src/auth.ts", newStart: 10, newLines: 4, oldStart: 10, oldLines: 2 },
  {
    id: "test-hunk",
    path: "src/auth.test.ts",
    newStart: 20,
    newLines: 3,
    oldStart: 20,
    oldLines: 0,
  },
];

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
            condition: "The drafter invented this trigger.",
            response: "The drafter invented this outcome.",
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
          coverage: "invented-by-drafter",
          trace: ["fabricated-coverage-ref"],
          tests: "ninety-nine",
        },
      },
      {
        id: "fabricated-coverage-ref",
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
    skippedHunks: [],
  }) as unknown as DraftBoard;

const SUPERPOWERS_PLAN = "docs/superpowers/plans/2026-08-29-search.md";
const SUPERPOWERS_LEDGER = ".superpowers/sdd/2026-08-29-search/progress.md";
const SUPERPOWERS_PLAN_TEXT = [
  "# Search Implementation Plan",
  "",
  "### Task 1: Index records",
  "**Files:**",
  "- Modify: `src/search.ts:12-30`",
  "- Test: `src/search.test.ts`",
  "**Interfaces:**",
  "- Consumes: `Clock.now(): number`",
  "- Produces: `SearchIndex.write(record): void`",
  "- [ ] **Step 1: Write the failing test**",
  "Run: `pnpm test search`",
  'Expected: FAIL with "write is not defined"',
  "",
  "### Task 2: Query records",
  "- [ ] **Step 1: Write the query test**",
].join("\n");
const SUPERPOWERS_LEDGER_TEXT = [
  `# SDD ledger — plan: ${SUPERPOWERS_PLAN}`,
  "Task 1: complete (commits abc1234..def5678, review clean)",
  "Task 2: fix round 1/5 (1 addressed, 1 open — retry; commits def5678..fed4321)",
  "Task 2: minor (deferred): tighten the copy",
  "Ruling: keep the old route — callers depend on it — removal would break links",
].join("\n");

function superpowersArtifacts(
  progressText = SUPERPOWERS_LEDGER_TEXT,
  planText = SUPERPOWERS_PLAN_TEXT,
): DesignArtifactSet {
  const artifact = (path: string, role: "plan" | "progress", content: string) => ({
    path,
    role,
    content,
    sourceBytes: Buffer.byteLength(content),
    truncated: false,
  });
  const otherPlan = "docs/superpowers/plans/2026-08-29-other.md";
  const otherLedger = ".superpowers/sdd/2026-08-29-other/progress.md";
  const candidate = (
    id: string,
    name: string,
    artifacts: DesignArtifactSet["candidates"][number]["artifacts"],
  ): DesignArtifactSet["candidates"][number] => ({
    id,
    format: "superpowers",
    name,
    nameSourceBytes: Buffer.byteLength(name),
    nameTruncated: false,
    relevance: { kind: "repository-candidate" },
    artifacts,
    omittedArtifactCount: 0,
  });
  return {
    changedPaths: [],
    omittedChangedPathCount: 0,
    candidates: [
      candidate("candidate-search", "Search", [
        artifact(SUPERPOWERS_PLAN, "plan", planText),
        artifact(SUPERPOWERS_LEDGER, "progress", progressText),
      ]),
      candidate("candidate-other", "Other", [
        artifact(otherPlan, "plan", SUPERPOWERS_PLAN_TEXT.replaceAll("Search", "Other")),
        artifact(
          otherLedger,
          "progress",
          `# SDD ledger — plan: ${otherPlan}\nTask 2: complete (commits 1111111..2222222, review clean)`,
        ),
      ]),
    ],
    omittedCandidateCount: 0,
    limits: DESIGN_ARTIFACT_LIMITS,
  };
}

function singleDesignArtifactSet(
  format: DesignArtifactSet["candidates"][number]["format"],
  role: DesignArtifactSet["candidates"][number]["artifacts"][number]["role"],
  path: string,
  content: string,
): DesignArtifactSet {
  return {
    changedPaths: [],
    omittedChangedPathCount: 0,
    candidates: [
      {
        id: "candidate-fixture",
        format,
        name: "Fixture",
        nameSourceBytes: 7,
        nameTruncated: false,
        relevance: { kind: "repository-candidate" },
        artifacts: [
          {
            path,
            role,
            content,
            sourceBytes: Buffer.byteLength(content),
            truncated: false,
          },
        ],
        omittedArtifactCount: 0,
      },
    ],
    omittedCandidateCount: 0,
    limits: DESIGN_ARTIFACT_LIMITS,
  };
}

function superpowersBoard(firstStep = "- [ ] **Step 1: Write the failing test**"): DraftBoard {
  return {
    document: {
      title: "Search",
      introMarkdown: "Implement indexed search.",
      measure: "structured",
      sources: [
        { path: SUPERPOWERS_PLAN, candidate: "candidate-search" },
        { path: SUPERPOWERS_LEDGER, candidate: "candidate-search" },
      ],
      stats: [{ label: "Tasks", value: "2/2" }],
    },
    elements: [
      {
        id: "search-plan",
        kind: "section",
        data: {
          author: { kind: "lens-agent", id: "design-seat" },
          title: "Search Implementation Plan",
          children: ["search-task-1", "search-task-2"],
          sources: [{ path: SUPERPOWERS_PLAN, candidate: "candidate-search" }],
          task_progress: { kind: "source", format: "invented", role: "tasks" },
        },
      },
      {
        id: "search-task-1",
        kind: "section",
        data: {
          author: { kind: "lens-agent", id: "design-seat" },
          title: "Task 1: Index records",
          children: ["search-step-1"],
          task_progress: { kind: "group", state: "incomplete" },
          task_manifest: {
            files: [{ operation: "create", value: "forged.ts" }],
            interfaces: [],
            verifications: [],
          },
        },
      },
      {
        id: "search-step-1",
        kind: "prose",
        data: {
          author: { kind: "lens-agent", id: "design-seat" },
          markdown: firstStep,
          task_manifest: {
            files: [{ operation: "create", value: "also-forged.ts" }],
            interfaces: [],
            verifications: [],
          },
        },
      },
      {
        id: "search-task-2",
        kind: "section",
        data: {
          author: { kind: "lens-agent", id: "design-seat" },
          title: "Task 2: Query records",
          children: ["search-step-2"],
          task_progress: { kind: "group", state: "complete" },
        },
      },
      {
        id: "search-step-2",
        kind: "prose",
        data: {
          author: { kind: "lens-agent", id: "design-seat" },
          markdown: "- [ ] **Step 1: Write the query test**",
        },
      },
      {
        id: "search-progress",
        kind: "section",
        data: {
          author: { kind: "lens-agent", id: "design-seat" },
          title: "Execution progress",
          children: ["search-progress-copy"],
          sources: [{ path: SUPERPOWERS_LEDGER, candidate: "candidate-search" }],
          task_progress: { kind: "group", state: "complete" },
        },
      },
      {
        id: "search-progress-copy",
        kind: "prose",
        data: {
          author: { kind: "lens-agent", id: "design-seat" },
          markdown: SUPERPOWERS_LEDGER_TEXT,
        },
      },
      {
        id: "other-task-2",
        kind: "section",
        data: {
          author: { kind: "lens-agent", id: "design-seat" },
          title: "Task 2: Same number, other plan",
          children: [],
          sources: [
            {
              path: "docs/superpowers/plans/2026-08-29-other.md",
              candidate: "candidate-other",
            },
          ],
          task_progress: { kind: "group", state: "complete" },
        },
      },
    ],
    skippedHunks: [],
  } as unknown as DraftBoard;
}

interface HarnessCapture {
  model?: string;
  prompt?: string;
  outputSchema?: unknown;
  outputByteCap?: number;
}

/** A fake Claude port: captures the resolved session and answers a lens-appropriate board. */
function fakeClaudePort(
  captures: HarnessCapture[],
  bodyFor: (prompt: string) => unknown,
): HarnessPort {
  return {
    createSession: async (options: {
      model?: string;
      outputSchema?: unknown;
      outputByteCap?: number;
    }) => {
      const capture: HarnessCapture = {
        model: options.model,
        outputSchema: options.outputSchema,
        ...(options.outputByteCap === undefined ? {} : { outputByteCap: options.outputByteCap }),
      };
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

describe("projectDesignTaskProgress", () => {
  it("projects task progress only onto the top-level source topology root", () => {
    const before = superpowersBoard();
    before.elements = [
      ...before.elements.map((element) =>
        element.id === "search-plan"
          ? ({
              ...element,
              data: { ...element.data, children: ["search-plan-repeat"] },
            } as DraftBoard["elements"][number])
          : element,
      ),
      {
        id: "search-plan-repeat",
        kind: "section",
        data: {
          author: { kind: "lens-agent", id: "design-seat" },
          title: "Plan tasks",
          children: ["search-task-1", "search-task-2"],
          sources: [{ path: SUPERPOWERS_PLAN, candidate: "candidate-search" }],
        },
      } as DraftBoard["elements"][number],
    ];

    const projected = projectDesignTaskProgress(before, superpowersArtifacts());
    const sourceProgressIds = projected.elements.flatMap((element) => {
      const progress = (element.data as { task_progress?: { kind?: unknown } }).task_progress;
      return progress?.kind === "source" ? [element.id] : [];
    });

    expect(sourceProgressIds).toEqual(["search-plan"]);
    expect(projected.elements.find(({ id }) => id === "search-task-1")?.data).toMatchObject({
      task_progress: { kind: "group", state: "complete" },
      task_manifest: {
        files: [
          { operation: "modify", value: "`src/search.ts:12-30`" },
          { operation: "test", value: "`src/search.test.ts`" },
        ],
        interfaces: [
          { direction: "consumes", value: "`Clock.now(): number`" },
          { direction: "produces", value: "`SearchIndex.write(record): void`" },
        ],
        verifications: [
          {
            run: "`pnpm test search`",
            expected: 'FAIL with "write is not defined"',
          },
        ],
      },
    });
    expect(projected.elements.find(({ id }) => id === "search-task-2")?.data).toMatchObject({
      task_progress: { kind: "group", state: "incomplete" },
    });
  });

  it("counts a partially checked Superpowers task group as zero of one", () => {
    const checked = "- [x] **Step 1: Write the failing test**";
    const unchecked = "- [ ] **Step 2: Implement the index**";
    const planText = [
      "# Search Implementation Plan",
      "",
      "### Task 1: Index records",
      checked,
      unchecked,
    ].join("\n");
    const board = superpowersBoard(checked);
    board.elements = [
      ...board.elements
        .filter((element) => !["search-task-2", "search-step-2"].includes(element.id))
        .map((element) =>
          element.id === "search-task-1"
            ? ({
                ...element,
                data: { ...element.data, children: ["search-step-1", "search-step-1b"] },
              } as DraftBoard["elements"][number])
            : element,
        ),
      {
        id: "search-step-1b",
        kind: "prose",
        data: {
          author: { kind: "lens-agent", id: "design-seat" },
          markdown: unchecked,
        },
      } as DraftBoard["elements"][number],
    ];
    const wrongBinding = SUPERPOWERS_LEDGER_TEXT.replace(
      SUPERPOWERS_PLAN,
      `${SUPERPOWERS_PLAN}.other`,
    );

    const projected = projectDesignTaskProgress(
      board,
      superpowersArtifacts(wrongBinding, planText),
    );

    expect(projected.document?.stats).toEqual([{ label: "Tasks", value: "0/1" }]);
    expect(projected.elements.find(({ id }) => id === "search-task-1")?.data).toMatchObject({
      task_progress: { kind: "group", state: "incomplete" },
    });
  });

  it("overlays only the selected plan's exactly bound ledger and strips model claims", () => {
    const before = superpowersBoard();
    const progressCopy = before.elements.find(({ id }) => id === "search-progress-copy")?.data;

    const projected = projectDesignTaskProgress(before, superpowersArtifacts());

    expect(projected.document?.stats).toEqual([{ label: "Tasks", value: "1/2" }]);
    expect(projected.elements.find(({ id }) => id === "search-plan")?.data).toMatchObject({
      task_progress: {
        kind: "source",
        format: "superpowers",
        role: "plan",
        layout: "grouped",
      },
    });
    expect(projected.elements.find(({ id }) => id === "search-task-1")?.data).toMatchObject({
      task_progress: { kind: "group", state: "complete" },
    });
    expect(projected.elements.find(({ id }) => id === "search-task-2")?.data).toMatchObject({
      task_progress: { kind: "group", state: "incomplete" },
    });
    expect(projected.elements.find(({ id }) => id === "other-task-2")?.data).not.toHaveProperty(
      "task_progress",
    );
    expect(projected.elements.find(({ id }) => id === "search-progress")?.data).not.toHaveProperty(
      "task_progress",
    );
    const projectedStep = projected.elements.find(({ id }) => id === "search-step-1")?.data;
    expect(projectedStep).toMatchObject({
      markdown: "- [ ] **Step 1: Write the failing test**",
    });
    expect(projectedStep).not.toHaveProperty("task_manifest");
    expect(projected.elements.find(({ id }) => id === "search-progress-copy")?.data).toEqual(
      progressCopy,
    );
  });

  it("ignores another plan's ledger and keeps static plan marks authoritative", () => {
    const wrongBinding = SUPERPOWERS_LEDGER_TEXT.replace(
      SUPERPOWERS_PLAN,
      "docs/superpowers/plans/2026-08-29-other.md",
    );
    const completedStep = "- [x] **Step 1: Write the failing test**";
    const board = superpowersBoard(completedStep);

    const projected = projectDesignTaskProgress(
      board,
      superpowersArtifacts(
        wrongBinding,
        SUPERPOWERS_PLAN_TEXT.replace("- [ ] **Step 1: Write the failing test**", completedStep),
      ),
    );

    expect(projected.document?.stats).toEqual([{ label: "Tasks", value: "1/2" }]);
    expect(projected.elements.find(({ id }) => id === "search-task-1")?.data).toMatchObject({
      task_progress: { kind: "group", state: "complete" },
    });
    expect(projected.elements.find(({ id }) => id === "search-task-2")?.data).toMatchObject({
      task_progress: { kind: "group", state: "incomplete" },
    });
  });

  it("maps identical task text by source topology and keeps each manifest on its group", () => {
    const path = "docs/superpowers/plans/identical.md";
    const step = "- [ ] **Step 1: Run tests**";
    const plan = [
      "# Identical Implementation Plan",
      "",
      "### Task 1: First",
      "**Files:**",
      "- Modify: `src/first.ts`",
      step,
      "",
      "### Task 2: Second",
      "**Files:**",
      "- Modify: `src/second.ts`",
      step,
    ].join("\n");
    const author = { kind: "lens-agent" as const, id: "design-seat" };
    const projected = projectDesignTaskProgress(
      {
        document: {
          title: "Identical",
          introMarkdown: "",
          measure: "structured",
          sources: [{ path, candidate: "candidate-fixture" }],
        },
        elements: [
          {
            id: "identical-root",
            kind: "section",
            data: {
              author,
              title: "Identical Implementation Plan",
              children: ["group-1", "group-2"],
              sources: [{ path, candidate: "candidate-fixture" }],
            },
          },
          {
            id: "group-2",
            kind: "section",
            data: { author, title: "Task 2: Second", children: ["step-2"] },
          },
          { id: "step-2", kind: "prose", data: { author, markdown: step } },
          {
            id: "group-1",
            kind: "section",
            data: { author, title: "Task 1: First", children: ["step-1"] },
          },
          { id: "step-1", kind: "prose", data: { author, markdown: step } },
        ],
      } as unknown as DraftBoard,
      singleDesignArtifactSet("superpowers", "plan", path, plan),
    );

    expect(projected.elements.find(({ id }) => id === "group-1")?.data).toMatchObject({
      task_manifest: { files: [{ operation: "modify", value: "`src/first.ts`" }] },
    });
    expect(projected.elements.find(({ id }) => id === "group-2")?.data).toMatchObject({
      task_manifest: { files: [{ operation: "modify", value: "`src/second.ts`" }] },
    });
  });

  it("keeps a one-group Superpowers manifest on an ungrouped source root", () => {
    const path = "docs/superpowers/plans/one-group.md";
    const step = "- [ ] **Step 1: Run tests**";
    const plan = ["### Task 1: Only", "**Files:**", "- Test: `src/only.test.ts`", step].join("\n");
    const author = { kind: "lens-agent" as const, id: "design-seat" };
    const projected = projectDesignTaskProgress(
      {
        document: {
          title: "One group",
          introMarkdown: "",
          measure: "structured",
          sources: [{ path, candidate: "candidate-fixture" }],
        },
        elements: [
          {
            id: "one-group-root",
            kind: "section",
            data: {
              author,
              title: "Task 1: Only",
              children: ["one-group-step"],
              sources: [{ path, candidate: "candidate-fixture" }],
              task_manifest: { files: [{ operation: "create", value: "forged.ts" }] },
            },
          },
          { id: "one-group-step", kind: "prose", data: { author, markdown: step } },
        ],
      } as unknown as DraftBoard,
      singleDesignArtifactSet("superpowers", "plan", path, plan),
    );

    expect(projected.elements.find(({ id }) => id === "one-group-root")?.data).toMatchObject({
      task_progress: {
        kind: "source",
        format: "superpowers",
        role: "plan",
        layout: "ungrouped",
      },
      task_manifest: {
        files: [{ operation: "test", value: "`src/only.test.ts`" }],
        interfaces: [],
        verifications: [],
      },
    });
  });

  it("replaces model-authored format anatomy with exact selected-source metadata", () => {
    const document = (path: string): DraftBoard["document"] => ({
      title: "Fixture",
      introMarkdown: "",
      measure: "structured",
      sources: [{ path, candidate: "candidate-fixture" }],
    });
    const author = { kind: "lens-agent" as const, id: "design-seat" };

    const kiroPath = ".kiro/specs/account/tasks.md";
    const kiroText = [
      "# Implementation Plan",
      "",
      "- [ ] 1. Create storage",
      "  - _Requirements: 2.1, 1.2_",
      "- [ ] 2. Finish wiring",
    ].join("\n");
    const kiro = projectDesignTaskProgress(
      {
        document: document(kiroPath),
        elements: [
          {
            id: "kiro-root",
            kind: "section",
            data: {
              author,
              title: "Implementation Plan",
              children: ["kiro-group"],
              sources: [{ path: kiroPath, candidate: "candidate-fixture" }],
            },
          },
          {
            id: "kiro-group",
            kind: "section",
            data: {
              author,
              title: "Tasks",
              children: ["kiro-task-1", "kiro-task-2"],
            },
          },
          {
            id: "kiro-task-1",
            kind: "prose",
            data: { author, markdown: "- [ ] 1. Create storage", requirement_refs: ["forged"] },
          },
          {
            id: "kiro-task-2",
            kind: "prose",
            data: { author, markdown: "- [ ] 2. Finish wiring", requirement_refs: ["forged"] },
          },
        ],
      } as unknown as DraftBoard,
      singleDesignArtifactSet("kiro", "tasks", kiroPath, kiroText),
    );
    expect(kiro.elements.find(({ id }) => id === "kiro-task-1")?.data).toMatchObject({
      requirement_refs: ["2.1", "1.2"],
    });
    expect(kiro.elements.find(({ id }) => id === "kiro-task-2")?.data).not.toHaveProperty(
      "requirement_refs",
    );

    const bmadPath = "docs/stories/1.1.session.story.md";
    const bmadStory = "**As a** reviewer, **I want** sessions restored, **so that** I can resume.";
    const bmadTask = "- [ ] Restore the session (AC: 3, 1)";
    const bmadText = [
      "# Story 1.1",
      "",
      "## Status",
      "Approved",
      "",
      "## Story",
      bmadStory,
      "",
      "## Tasks / Subtasks",
      bmadTask,
    ].join("\n");
    const bmad = projectDesignTaskProgress(
      {
        document: document(bmadPath),
        elements: [
          {
            id: "bmad-root",
            kind: "section",
            data: {
              author,
              title: "Story 1.1",
              children: ["bmad-story", "bmad-group"],
              sources: [{ path: bmadPath, candidate: "candidate-fixture" }],
            },
          },
          {
            id: "bmad-story",
            kind: "requirement",
            data: {
              author,
              shall: bmadStory,
              source: { path: bmadPath, candidate: "candidate-fixture" },
              status: "forged",
            },
          },
          {
            id: "bmad-group",
            kind: "section",
            data: { author, title: "Tasks / Subtasks", children: ["bmad-task"] },
          },
          {
            id: "bmad-task",
            kind: "prose",
            data: { author, markdown: bmadTask, acceptance_criteria: ["forged"] },
          },
        ],
      } as unknown as DraftBoard,
      singleDesignArtifactSet("bmad", "story", bmadPath, bmadText),
    );
    expect(bmad.elements.find(({ id }) => id === "bmad-story")?.data).toMatchObject({
      status: "Approved",
    });
    expect(bmad.elements.find(({ id }) => id === "bmad-task")?.data).toMatchObject({
      acceptance_criteria: ["3", "1"],
    });

    const contextPath = "CONTEXT.md";
    const term = "**Order**: A customer's request for goods. _Avoid_: Purchase, transaction";
    const contextText = [
      "# Ordering",
      "",
      "## Language",
      "",
      "**Order**:",
      "A customer's request for goods.",
      "_Avoid_: Purchase, transaction",
    ].join("\n");
    const grill = projectDesignTaskProgress(
      {
        document: document(contextPath),
        elements: [
          {
            id: "context-root",
            kind: "section",
            data: {
              author,
              title: "Language",
              children: ["order-term"],
              sources: [{ path: contextPath, candidate: "candidate-fixture" }],
            },
          },
          {
            id: "order-term",
            kind: "prose",
            data: {
              author,
              markdown: term,
              glossary_term: { term: "Forged", definition: "Wrong", avoid: [] },
            },
          },
        ],
      } as unknown as DraftBoard,
      singleDesignArtifactSet("grill-with-docs", "context", contextPath, contextText),
    );
    expect(grill.elements.find(({ id }) => id === "order-term")?.data).toMatchObject({
      glossary_term: {
        term: "Order",
        definition: "A customer's request for goods.",
        avoid: ["Purchase", "transaction"],
      },
    });

    const choicesPath = "docs/superpowers/plans/source-cells.md";
    const choicesText = [
      "**Architecture:** Keep review state in the local store.",
      "**Tech Stack:** TypeScript 5.6 and SQLite",
    ].join("\n");
    const choices = projectDesignTaskProgress(
      {
        document: document(choicesPath),
        elements: [
          {
            id: "choices-root",
            kind: "section",
            data: {
              author,
              title: "Plan choices",
              children: ["architecture-choice", "stack-choice"],
              sources: [{ path: choicesPath, candidate: "candidate-fixture" }],
            },
          },
          {
            id: "architecture-choice",
            kind: "decision",
            data: {
              author,
              statement: "Keep review state in the local store.",
              why: "",
              alternatives: [],
              evidence: [],
              inferred: false,
              source: { path: choicesPath, candidate: "candidate-fixture", line: 1 },
              source_cells: ["forged", "order"],
            },
          },
          {
            id: "stack-choice",
            kind: "decision",
            data: {
              author,
              statement: "TypeScript 5.6 and SQLite",
              why: "",
              alternatives: [],
              evidence: [],
              inferred: false,
              source: { path: choicesPath, candidate: "candidate-fixture", line: 2 },
              source_cells: ["SQLite", "TypeScript"],
            },
          },
        ],
      } as unknown as DraftBoard,
      singleDesignArtifactSet("superpowers", "plan", choicesPath, choicesText),
    );
    expect(choices.elements.find(({ id }) => id === "architecture-choice")?.data).toMatchObject({
      source_cells: ["Architecture", "Keep review state in the local store."],
    });
    expect(choices.elements.find(({ id }) => id === "stack-choice")?.data).toMatchObject({
      source_cells: ["Tech Stack", "TypeScript 5.6 and SQLite"],
    });
  });
});

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

describe("boardOutputSchema", () => {
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
  it("projects both real board schemas into the supported provider subset", () => {
    for (const source of [boardOutputSchema(), designDraftOutputSchema()]) {
      const schema = sanitizeSchemaForCodex(source) as Record<string, unknown>;
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
    }
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

describe("reconcileFlaggedBoards — the Flagged dual seat merge (J1/J2)", () => {
  const labels = { a: "Claude", b: "Codex" };

  it("repoints a collapse the seats reached at DIFFERENT spans in the same window", async () => {
    // The live shape (#548): two seats agree about one concern but cite spans a couple of
    // lines apart. The reconciler matches within a line window, so they still collapse —
    // and an anchor-equality repointing would miss exactly this, leaving the merged board
    // unwritable. The fixture carries the difference on purpose.
    const seatA = mkBoard([
      mkFinding("f-1", "Short.", ["c1"]),
      mkCodeRef("c1", "src/client.ts", 11, 12),
      mkSection("sec-1", "Findings", ["f-1"]),
    ]);
    const seatB = mkBoard([
      mkFinding("f-1", "A materially longer statement of the very same concern.", ["c1"]),
      mkCodeRef("c1", "src/client.ts", 13, 14),
      mkSection("sec-1", "Findings", ["f-1"]),
    ]);

    const merged = reconcileFlaggedBoards(seatA, seatB, labels);
    expect(merged.elements.filter(({ kind }) => kind === "finding")).toHaveLength(1);
    const section = merged.elements.find(({ id }) => id === "sec-1");
    expect((section?.data as { children?: string[] } | undefined)?.children).toEqual(["b:f-1"]);
    expect(admitBoardReferences(merged, "ps-1").unrepairable).toEqual([]);
  });

  it("repoints a COLLAPSED finding's citers at its kept partner, so the merge is writable", async () => {
    // Both seats raise the same finding at the same location; seat B's wording is longer,
    // so the reconciler keeps B's finding and drops A's. Seat A's section still cites the
    // dropped id — the exact `bad-ref` the board service rejects a whole write for.
    const seatA = mkBoard([
      mkFinding("f1", "Short.", ["c1"]),
      mkCodeRef("c1", "src/auth.ts", 11, 12),
      mkSection("findings", "Findings", ["f1"]),
    ]);
    const seatB = mkBoard([
      mkFinding("f1", "A materially longer statement of the very same concern.", ["c1"]),
      mkCodeRef("c1", "src/auth.ts", 11, 12),
      mkSection("findings", "Findings", ["f1"]),
    ]);

    const merged = reconcileFlaggedBoards(seatA, seatB, labels);
    const findings = merged.elements.filter(({ kind }) => kind === "finding");
    expect(findings).toHaveLength(1);
    const keptId = findings[0]?.id ?? "";
    expect(keptId).toBe("b:f1");
    // Seat A's section now cites the SURVIVOR, not the id that collapsed into it.
    const section = merged.elements.find(({ id }) => id === "findings");
    expect((section?.data as { children?: string[] } | undefined)?.children).toEqual([keptId]);
    expect(admitBoardReferences(merged, "ps-1").unrepairable).toEqual([]);

    const root = await mkdtemp(join(tmpdir(), "lens-flagged-merge-"));
    try {
      const runtime = createBoardsRuntime(root);
      const client = new WhiteboardClient(runtime.service);
      const accepted = await client.apply(
        await runtime.createRennetBoard(),
        draftToOps(merged) as never,
        "lens:flagged",
      );
      expect(accepted.response).toMatchObject({ ok: true });

      // POSITIVE CONTROL — put the collapsed id back in the section's children (the shape
      // the merge produced before it repointed) and the real service rejects the write.
      const unrepointed = mkBoard(
        merged.elements.map((element) =>
          element.id === "findings"
            ? ({
                ...element,
                data: { ...(element.data as object), children: ["f1"] },
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
    const primaryDocument = {
      title: "Flagged · primary",
      introMarkdown: "1 high finding requires attention.",
      measure: "reading" as const,
    };
    const secondaryDocument = {
      title: "Flagged · secondary",
      introMarkdown: "1 medium finding requires attention.",
      measure: "reading" as const,
    };
    const primary = {
      ...mkBoard([
        mkFinding("f1", "high concern", ["c1"], "high"),
        mkCodeRef("c1", "src/high.ts", 1, 2),
      ]),
      document: primaryDocument,
    };
    const secondary = {
      ...mkBoard([
        mkFinding("f2", "medium concern", ["c2"], "medium"),
        mkCodeRef("c2", "src/medium.ts", 3, 4),
      ]),
      document: secondaryDocument,
    };

    expect(reconcileFlaggedBoards(primary, secondary, labels).document).toEqual({
      title: "Flagged · primary",
      introMarkdown: "2 findings require attention: 1 high, 1 medium.",
      measure: "reading",
    });
  });

  it("uses a legacy primary's secondary title with a clean reconciled opening", () => {
    const secondaryDocument = {
      title: "Flagged · secondary",
      introMarkdown: "The secondary seat found one open concern.",
      measure: "reading" as const,
    };

    expect(
      reconcileFlaggedBoards(mkBoard([]), { ...mkBoard([]), document: secondaryDocument }, labels)
        .document,
    ).toEqual({
      title: "Flagged · secondary",
      introMarkdown: "No findings require attention.",
      measure: "reading",
    });
  });

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
    expect(accordOn(merged, findings[0]?.id ?? "")).toBe("concur");
  });

  // THE AMBIGUITY THE TALLIES CANNOT RESOLVE: two seats that both raised the finding at
  // materially different severities produce `disagree` with NEITHER answer being
  // `NO_CONCERN_ANSWER`, so `foldConcurrence` emits `[{a,1,1},{b,1,1}]` — the BYTE-IDENTICAL
  // tally set a real concurrence produces. A client reading the arithmetic renders a
  // disagreement as agreement, which is exactly what the board pill used to do. The
  // `accord` stamp is the only thing that separates the two, so this test asserts both
  // halves: the tallies really are identical, and the accord really does differ.
  it("stamps a severity conflict `conflict`, though its tallies match a concurrence exactly", () => {
    const a = mkBoard([
      mkFinding("f1", "this drops writes under load", ["c1"], "high"),
      mkCodeRef("c1", "src/auth.ts", 11, 12),
    ]);
    const b = mkBoard([
      mkFinding("f2", "minor: tidy this up sometime", ["c2"], "low"),
      mkCodeRef("c2", "src/auth.ts", 11, 12),
    ]);
    const merged = reconcileFlaggedBoards(a, b, labels);
    const findings = merged.elements.filter((e) => e.kind === "finding");
    expect(findings).toHaveLength(1);
    const id = findings[0]?.id ?? "";
    expect(concurrenceOf(merged, id)).toEqual([
      { model: "Claude", agree: 1, total: 1 },
      { model: "Codex", agree: 1, total: 1 },
    ]);
    expect(accordOn(merged, id)).toBe("conflict");
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
    // A solo is a SPLIT, not a conflict — one seat answered "no concern".
    expect(accordOn(merged, "f1")).toBe("split");
    expect(accordOn(merged, "b:f2")).toBe("split");
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

    const bodyFor = (prompt: string): unknown => cleanBody(lensFromPrompt(prompt));

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
    expect(arrivals.map((a) => a.lens)).toEqual(lenses);
    expect(captures.map(({ prompt }) => lensFromPrompt(prompt ?? "")).sort()).toEqual(
      [...lenses].sort(),
    );
    expect(captures.some(({ prompt }) => lensFromPrompt(prompt ?? "") === "post-process")).toBe(
      false,
    );
    // Coverage: no hunks ⇒ nothing uncovered.
    expect(result.coverage).toEqual([]);
  });

  it("repairs dangling Sequence and Decisions references before the real board service write", async () => {
    const root = await mkdtemp(join(tmpdir(), "lens-reference-repair-"));
    try {
      const runtime = createBoardsRuntime(root);
      const client = new WhiteboardClient(runtime.service);
      const captures: { model?: string; prompt?: string }[] = [];
      const arrivals: BoardArrivalEvent[] = [];
      const lensAuthor = (lens: string) => ({ kind: "lens-agent" as const, id: `${lens}-seat` });
      const lensCodeRef = (lens: string, id: string): DraftBoard["elements"][number] => {
        const element = mkCodeRef(id, "src/auth.ts", 11, 12);
        return {
          ...element,
          data: { ...element.data, author: lensAuthor(lens) },
        } as DraftBoard["elements"][number];
      };
      const sequenceDraft = (span: string): DraftBoard =>
        ({
          elements: [
            {
              id: "sequence-step",
              kind: "order_step",
              data: {
                author: lensAuthor("sequence"),
                title: "Read the entry point",
                span,
                children: [],
              },
            },
            ...(span === "sequence-code" ? [lensCodeRef("sequence", "sequence-code")] : []),
            mkSection("sequence-root", "Reading order", ["sequence-step"], lensAuthor("sequence")),
          ],
          skippedHunks: [],
        }) as unknown as DraftBoard;
      const decisionsDraft = (evidence: string): DraftBoard =>
        ({
          elements: [
            {
              id: "decision",
              kind: "decision",
              data: {
                author: lensAuthor("decisions"),
                statement: "Keep writes atomic.",
                evidence: [evidence],
                alternatives: ["alternative"],
                why: "Readers never observe a partial batch.",
              },
            },
            {
              id: "alternative",
              kind: "prose",
              data: {
                author: lensAuthor("decisions"),
                markdown: "Write each event independently.",
              },
            },
            ...(evidence === "decision-code" ? [lensCodeRef("decisions", "decision-code")] : []),
            mkSection(
              "decisions-root",
              "Implementation decisions",
              ["decision"],
              lensAuthor("decisions"),
            ),
          ],
          skippedHunks: [],
        }) as unknown as DraftBoard;

      const rawId = await runtime.createRennetBoard();
      const raw = await client.apply(
        rawId,
        draftToOps(sequenceDraft("missing-sequence-code")) as never,
        "lens:sequence",
      );
      expect(raw.response).toMatchObject({ ok: false, code: "bad-ref" });

      const boardIds = new Map<LintTarget, string>();
      for (const lens of ["design", "sequence", "decisions", "flagged", "noise"] as const) {
        boardIds.set(lens, await runtime.createRennetBoard());
      }
      const bodyFor = (prompt: string): unknown => {
        const lens = lensFromPrompt(prompt);
        if (lens === "post-process") {
          const context = /rennet:layer context>>>\n(\{.*)/s.exec(prompt);
          return context ? (JSON.parse(context[1] as string).board as unknown) : { elements: [] };
        }
        const isReferenceRetry = prompt.includes("element-reference-resolves");
        if (lens === "sequence") {
          return sequenceDraft(isReferenceRetry ? "sequence-code" : "missing-sequence-code");
        }
        if (lens === "decisions") {
          return decisionsDraft(isReferenceRetry ? "decision-code" : "missing-decision-code");
        }
        return cleanBody(lens);
      };

      const result = await runLensPipeline({
        claudePort: fakeClaudePort(captures, bodyFor),
        codexExecutor: null,
        repoRoot: "/pr-worktree",
        deltaPacket: PACKET,
        hunks: [],
        lintContextFor: (lens) => ({
          lens,
          hunks: [],
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

      for (const lens of ["sequence", "decisions"] as const) {
        const outcome = result.boards.find((board) => board.lens === lens);
        expect(outcome?.failure).toBeUndefined();
        expect(arrivals.map(({ lens: arrived }) => arrived)).toContain(lens);
      }
      expect(
        captures.filter(
          ({ prompt }) =>
            prompt?.includes("PROMPT_FILE:prompts/sequence.md") &&
            prompt.includes("element-reference-resolves"),
        ),
      ).toHaveLength(1);
      expect(
        captures.filter(
          ({ prompt }) =>
            prompt?.includes("PROMPT_FILE:prompts/decisions.md") &&
            prompt.includes("element-reference-resolves"),
        ),
      ).toHaveLength(1);

      const sequenceState = await runtime.service.getState(boardIds.get("sequence") ?? "");
      const decisionsState = await runtime.service.getState(boardIds.get("decisions") ?? "");
      expect(sequenceState.has("sequence-step")).toBe(true);
      expect(sequenceState.has("sequence-code")).toBe(true);
      expect(decisionsState.has("decision")).toBe(true);
      expect(decisionsState.has("decision-code")).toBe(true);
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
    // The shape is a round carry-forward: a prior round's addressed chapter rides verbatim
    // into this round's Sequence board (`composeFindingRound`), AFTER lint, and it cites its
    // own code ref under the typography that round wrote. Nothing before the write boundary
    // looks at it, and the board service rejects the whole batch for it.
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
        claudePort: fakeClaudePort([], (prompt) => {
          const lens = lensFromPrompt(prompt);
          if (lens === "post-process") {
            const context = /rennet:layer context>>>\n(\{.*)/s.exec(prompt);
            return context ? (JSON.parse(context[1] as string).board as unknown) : { elements: [] };
          }
          return cleanBody(lens);
        }),
        codexExecutor: null,
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
        hunks: [],
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

  it("treats a deterministically empty Design artifact set as a successful absent lane", async () => {
    const captures: { model?: string; prompt?: string }[] = [];
    const applied: Applied[] = [];
    const arrivals: BoardArrivalEvent[] = [];

    const result = await runLensPipeline({
      claudePort: fakeClaudePort(captures, (prompt) => cleanBody(lensFromPrompt(prompt))),
      codexExecutor: null,
      repoRoot: "/pr-worktree",
      deltaPacket: PACKET,
      hunks: [],
      lintContextFor,
      designArtifacts: null,
      readPrompt,
      whiteboard: fakeWhiteboard(applied),
      boardIdFor: (lens) => `board:${lens}`,
      onBoardArrival: (event) => {
        arrivals.push(event);
      },
    });

    const design = result.boards.find((outcome) => outcome.lens === "design");
    expect(design).toMatchObject({ lens: "design", absence: "no-material" });
    expect(design?.failure).toBeUndefined();
    expect(design?.board).toBeUndefined();
    expect(applied.map(({ boardId }) => boardId)).not.toContain("board:design");
    expect(arrivals.map(({ lens }) => lens)).not.toContain("design");
    expect(captures.some(({ prompt }) => prompt?.includes("prompts/design.md"))).toBe(false);
    expect(result.boards.filter(({ board }) => board !== undefined)).toHaveLength(4);
  });

  it("isolates unavailable pinned Design discovery to the Design lane", async () => {
    const captures: { model?: string; prompt?: string }[] = [];
    const applied: Applied[] = [];
    const reason =
      "Design artifact discovery failed for the pinned reviewed tree: git object disappeared";

    const result = await runLensPipeline({
      claudePort: fakeClaudePort(captures, (prompt) => cleanBody(lensFromPrompt(prompt))),
      codexExecutor: null,
      repoRoot: "/pr-worktree",
      deltaPacket: PACKET,
      hunks: [],
      lintContextFor,
      designArtifactFailure: reason,
      readPrompt,
      whiteboard: fakeWhiteboard(applied),
      boardIdFor: (lens) => `board:${lens}`,
    });

    expect(result.boards.find(({ lens }) => lens === "design")).toMatchObject({
      lens: "design",
      failure: reason,
    });
    expect(result.boards.filter(({ board }) => board !== undefined)).toHaveLength(4);
    expect(applied.map(({ boardId }) => boardId)).not.toContain("board:design");
    expect(captures.some(({ prompt }) => prompt?.includes("prompts/design.md"))).toBe(false);
  });

  it("accepts a grounded no-material result when every discovered candidate is a decoy", async () => {
    const decoyArtifacts: DesignArtifactSet = {
      ...DESIGN_ARTIFACTS,
      candidates: DESIGN_ARTIFACTS.candidates.map((candidate) => ({
        ...candidate,
        relevance: { kind: "repository-candidate" as const },
      })),
    };
    const applied: Applied[] = [];
    const result = await runLensPipeline({
      claudePort: fakeClaudePort([], (prompt) => {
        const lens = lensFromPrompt(prompt);
        if (lens !== "design") return cleanBody(lens);
        return {
          absence: "no-material",
          candidates: decoyArtifacts.candidates.map((candidate) => ({
            id: candidate.id,
            relevance: candidate.relevance.kind,
            reason: "This specification describes a different feature than the reviewed change.",
          })),
        };
      }),
      codexExecutor: null,
      repoRoot: "/pr-worktree",
      deltaPacket: PACKET,
      hunks: [],
      lintContextFor,
      designArtifacts: decoyArtifacts,
      readPrompt,
      whiteboard: fakeWhiteboard(applied),
      boardIdFor: (lens) => `board:${lens}`,
    });

    expect(result.boards.find(({ lens }) => lens === "design")).toMatchObject({
      lens: "design",
      absence: "no-material",
    });
    expect(applied.map(({ boardId }) => boardId)).not.toContain("board:design");
  });

  it.each([
    ["decisions", "no-decisions"],
    ["flagged", "no-findings"],
    ["noise", "no-noise"],
  ] as const)(
    "records a zero-element %s lane as a typed absence instead of a successful arrival",
    async (emptyLens, absence) => {
      let emptyLensTurns = 0;
      const applied: Applied[] = [];
      const arrivals: BoardArrivalEvent[] = [];
      const result = await runLensPipeline({
        claudePort: fakeClaudePort([], (prompt) => {
          const lens = lensFromPrompt(prompt);
          if (lens === emptyLens) {
            emptyLensTurns += 1;
            return { elements: [], skippedHunks: [] };
          }
          if (lens === "post-process" && prompt.includes('"elements":[]')) {
            return { elements: [], skippedHunks: [] };
          }
          return cleanBody(lens);
        }),
        codexExecutor: null,
        repoRoot: "/pr-worktree",
        deltaPacket: PACKET,
        hunks: [],
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
    const applied: Applied[] = [];
    const result = await runLensPipeline({
      claudePort: fakeClaudePort([], (prompt) => {
        const lens = lensFromPrompt(prompt);
        if (lens === "sequence") return { elements: [], skippedHunks: [] };
        if (lens === "post-process" && prompt.includes('"elements":[]')) {
          return { elements: [], skippedHunks: [] };
        }
        return cleanBody(lens);
      }),
      codexExecutor: null,
      repoRoot: "/pr-worktree",
      deltaPacket: PACKET,
      hunks: [],
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

  it("RE-ASKS the seat when the drafting turn emitted no board, and settles the board it then draws (#549)", async () => {
    // The production no-board shape: the harness completes the turn with NO structured
    // output. It is retryable, and here that classification does the retrying — the seat
    // is re-asked and its second draw settles the lane as a board, not a failure.
    const noiseTurns: string[] = [];
    const result = await runLensPipeline({
      claudePort: fakeClaudePort([], (prompt) => {
        const lens = lensFromPrompt(prompt);
        if (lens !== "noise") return cleanBody(lens);
        noiseTurns.push(prompt);
        // `undefined` structured output ⇒ the harness completed WITHOUT emitting.
        return noiseTurns.length === 1 ? undefined : cleanBody("noise");
      }),
      codexExecutor: null,
      repoRoot: "/pr-worktree",
      deltaPacket: PACKET,
      hunks: [],
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
    // The base prompt is carried verbatim and the prior-failure layer is appended AFTER it,
    // so the seat re-reads its instructions and then what went wrong — in that order.
    expect(reask.startsWith(noiseTurns[0] ?? "")).toBe(true);
    expect(reask.slice((noiseTurns[0] ?? "").length)).toContain(
      "Your previous draft did not pass. Fix ONLY these issues and return the whole board:",
    );
    // The pointers are the PARSE issues the non-emission produced — `validateDraft` cannot
    // coerce a turn that emitted nothing into a board, so the ladder's first rung is the
    // schema itself rather than a lens rule about a board that does not exist.
    expect(reask).toMatch(/- schema at \[[^\]]*\]: /);
    expect(reask).toContain("Previous draft:");
  });

  it("settles TERMINAL only after the re-asks are spent, naming the non-emission (#549)", async () => {
    const noiseTurns: string[] = [];
    const result = await runLensPipeline({
      claudePort: fakeClaudePort([], (prompt) => {
        const lens = lensFromPrompt(prompt);
        if (lens !== "noise") return cleanBody(lens);
        noiseTurns.push(prompt);
        return undefined;
      }),
      codexExecutor: null,
      repoRoot: "/pr-worktree",
      deltaPacket: PACKET,
      hunks: [],
      lintContextFor,
      readPrompt,
      whiteboard: fakeWhiteboard([]),
      boardIdFor: (lens) => `board:${lens}`,
    });

    const noise = result.boards.find(({ lens }) => lens === "noise");
    expect(noise?.absence).toBeUndefined();
    // The words keep the original non-emission AND say the re-asks were spent.
    expect(noise?.failure).toContain("did not emit a board");
    expect(noise?.failure).toContain("no re-ask emitted one");
    // Terminal, and only because the retries were actually spent — the attempt count is
    // the ladder's, never the initial turn's `0`.
    expect(noise?.failureAccount?.classification).toBe("terminal");
    expect(noise?.failureAccount?.attempt).toBeGreaterThan(0);
    expect(noiseTurns.length).toBe((noise?.failureAccount?.attempt ?? 0) + 1);
  });

  it("carries an aggregated account when BOTH flagged seats fail (#549)", async () => {
    // Both seats emit nothing, on every turn, so both spend their ladders — the lens is
    // terminal, and it says so with an account rather than a bare sentence.
    const noBoard = (prompt: string): unknown =>
      lensFromPrompt(prompt) === "flagged" ? undefined : cleanBody(lensFromPrompt(prompt));
    const result = await runLensPipeline({
      claudePort: fakeClaudePort([], noBoard),
      codexExecutor: (async (req: { prompt: string }) => ({
        output: noBoard(req.prompt),
      })) as never,
      repoRoot: "/pr-worktree",
      deltaPacket: PACKET,
      hunks: [],
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

  it("settles an EMPTY draw as each lens's admissible absence, and as a failure where none is (#549)", async () => {
    // The empty-board settlement is derived from the protocol's admissibility table, not
    // restated beside it: every lens admitting exactly one absence settles that one,
    // Sequence (which admits none) fails, and Design fails because only a grounded
    // dismissal — never an empty board — proves its `no-material`.
    const result = await runLensPipeline({
      claudePort: fakeClaudePort([], () => ({ elements: [] })),
      codexExecutor: null,
      repoRoot: "/pr-worktree",
      deltaPacket: PACKET,
      hunks: [],
      lintContextFor,
      readPrompt,
      whiteboard: fakeWhiteboard([]),
      boardIdFor: (lens) => `board:${lens}`,
    });

    const settled = new Map(result.boards.map((outcome) => [outcome.lens, outcome]));
    expect(settled.get("decisions")?.absence).toBe("no-decisions");
    expect(settled.get("flagged")?.absence).toBe("no-findings");
    expect(settled.get("noise")?.absence).toBe("no-noise");
    expect(settled.get("sequence")?.absence).toBeUndefined();
    expect(settled.get("sequence")?.failure).toBeDefined();
    expect(settled.get("design")?.absence).toBeUndefined();
    expect(settled.get("design")?.failure).toBeDefined();
    // Every absence this pipeline settles is one the protocol table admits for that lens.
    for (const outcome of result.boards) {
      if (outcome.absence === undefined || outcome.lens === "report") continue;
      expect(
        lensAdmitsAbsence(outcome.lens, outcome.absence),
        `${outcome.lens} settled an inadmissible ${outcome.absence}`,
      ).toBe(true);
    }
  });

  it("a re-ask that draws an EMPTY board settles the lens absence, not a failure (#549)", async () => {
    // The seat's own empty-board claim is what authorizes a clean absence. A first turn
    // that emitted nothing made no claim either way, so the first EMITTED draw decides —
    // and a signal-only change whose Noise seat draws an empty board settles `no-noise`.
    const noiseTurns: string[] = [];
    const result = await runLensPipeline({
      claudePort: fakeClaudePort([], (prompt) => {
        const lens = lensFromPrompt(prompt);
        if (lens !== "noise") return cleanBody(lens);
        noiseTurns.push(prompt);
        return noiseTurns.length === 1 ? undefined : { elements: [] };
      }),
      codexExecutor: null,
      repoRoot: "/pr-worktree",
      deltaPacket: PACKET,
      hunks: [],
      lintContextFor,
      readPrompt,
      whiteboard: fakeWhiteboard([]),
      boardIdFor: (lens) => `board:${lens}`,
    });

    const noise = result.boards.find(({ lens }) => lens === "noise");
    expect(noise?.failure).toBeUndefined();
    expect(noise?.absence).toBe("no-noise");
    expect(lensAdmitsAbsence("noise", "no-noise")).toBe(true);
  });

  it("classifies a lane that never parsed across its ladder as TERMINAL (#549)", async () => {
    const result = await runLensPipeline({
      claudePort: fakeClaudePort([], (prompt) => {
        const lens = lensFromPrompt(prompt);
        // Structurally impossible output on every attempt, including the retries.
        return lens === "noise" ? { document: 5, elements: "not-a-list" } : cleanBody(lens);
      }),
      codexExecutor: null,
      repoRoot: "/pr-worktree",
      deltaPacket: PACKET,
      hunks: [],
      lintContextFor,
      readPrompt,
      whiteboard: fakeWhiteboard([]),
      boardIdFor: (lens) => `board:${lens}`,
    });

    const noise = result.boards.find(({ lens }) => lens === "noise");
    expect(noise?.failure).toContain("no parseable board");
    expect(noise?.failureAccount?.classification).toBe("terminal");
    // The ladder is spent, so the account names a later attempt than the initial turn.
    expect(noise?.failureAccount?.attempt).toBeGreaterThan(0);
  });

  it.each([
    ["decisions", "prose-only", () => proseOnlyBody("decisions", "No choices found.")],
    ["decisions", "orphan decision", () => withoutRootSections(meaningfulDecisionBody())],
    [
      "decisions",
      "hidden decision root",
      () => hideRootSectionFromProjection(meaningfulDecisionBody()),
    ],
    ["flagged", "prose-only", () => proseOnlyBody("flagged", "No defect found.")],
    [
      "flagged",
      "orphan finding",
      () => mkBoard([mkFinding("detached-finding", "A detached finding is not served.", [])]),
    ],
  ] as const)(
    "records a non-empty %s %s result as a precise failure without restarting the drafter",
    async (malformedLens, _shape, malformedBody) => {
      let malformedLensTurns = 0;
      const captures: { model?: string; prompt?: string }[] = [];
      const applied: Applied[] = [];
      const arrivals: BoardArrivalEvent[] = [];
      const result = await runLensPipeline({
        claudePort: fakeClaudePort(captures, (prompt) => {
          const lens = lensFromPrompt(prompt);
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
        codexExecutor: null,
        repoRoot: "/pr-worktree",
        deltaPacket: PACKET,
        hunks: [],
        lintContextFor,
        readPrompt,
        whiteboard: fakeWhiteboard(applied),
        boardIdFor: (lens) => `board:${lens}`,
        onBoardArrival: (event) => {
          arrivals.push(event);
        },
      });

      const outcome = result.boards.find(({ lens }) => lens === malformedLens);
      expect(malformedLensTurns).toBe(1);
      expect(
        captures.filter(({ prompt }) => prompt?.includes(`prompts/${malformedLens}.md`)),
      ).toHaveLength(1);
      expect(outcome?.absence).toBeUndefined();
      expect(outcome?.failure).toContain(
        malformedLens === "decisions"
          ? "no reachable `decision` in the emitted board"
          : "no reachable `finding` in the emitted board",
      );
      expect(applied.map(({ boardId }) => boardId)).not.toContain(`board:${malformedLens}`);
      expect(arrivals.map(({ lens }) => lens)).not.toContain(malformedLens);
    },
  );

  it.each([
    ["prose-only", () => proseOnlyBody("sequence", "Read the change in dependency order.")],
    ["orphan order_step", () => withoutRootSections(meaningfulSequenceBody())],
  ] as const)(
    "records a %s Sequence result as a precise failure without restarting the drafter",
    async (_shape, sequenceBody) => {
      let sequenceTurns = 0;
      const captures: { model?: string; prompt?: string }[] = [];
      const result = await runLensPipeline({
        claudePort: fakeClaudePort(captures, (prompt) => {
          const lens = lensFromPrompt(prompt);
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
        codexExecutor: null,
        repoRoot: "/pr-worktree",
        deltaPacket: PACKET,
        hunks: [],
        lintContextFor,
        readPrompt,
        whiteboard: fakeWhiteboard([]),
        boardIdFor: (lens) => `board:${lens}`,
      });

      expect(sequenceTurns).toBe(1);
      expect(captures.filter(({ prompt }) => prompt?.includes("prompts/sequence.md"))).toHaveLength(
        1,
      );
      expect(result.boards.find(({ lens }) => lens === "sequence")?.failure).toContain(
        "no reachable `order_step` in the emitted board",
      );
    },
  );

  it.each([
    ["sequence", "order_step", "sequence-root", meaningfulSequenceBody],
    ["decisions", "decision", "decisions-root", meaningfulDecisionBody],
    ["flagged", "finding", "flagged-root", meaningfulFlaggedBody],
  ] as const)(
    "keeps a %s board whose served root reaches a real %s element",
    async (lensUnderTest, kind, rootId, body) => {
      const applied: Applied[] = [];
      const result = await runLensPipeline({
        claudePort: fakeClaudePort([], (prompt) => {
          const lens = lensFromPrompt(prompt);
          if (lens === "post-process") {
            const context = /rennet:layer context>>>\n(\{.*)/s.exec(prompt);
            return context ? (JSON.parse(context[1] as string).board as unknown) : { elements: [] };
          }
          return lens === lensUnderTest ? body() : cleanBody(lens);
        }),
        codexExecutor: null,
        repoRoot: "/pr-worktree",
        deltaPacket: PACKET,
        hunks: [],
        lintContextFor,
        readPrompt,
        whiteboard: fakeWhiteboard(applied),
        boardIdFor: (lens) => `board:${lens}`,
      });

      const outcome = result.boards.find(({ lens }) => lens === lensUnderTest);
      const material = outcome?.board?.elements.find((element) => element.kind === kind);
      const root = outcome?.board?.elements.find((element) => element.id === rootId);
      expect(outcome?.absence).toBeUndefined();
      expect(material).toBeDefined();
      expect(root?.kind === "section" ? root.data.children : []).toContain(material?.id);
      expect(applied.map(({ boardId }) => boardId)).toContain(`board:${lensUnderTest}`);
    },
  );

  it.each(["design", "sequence"] as const)(
    "records an empty required %s lane as a precise failure without restarting the drafter",
    async (requiredLens) => {
      let requiredTurns = 0;
      const arrivals: BoardArrivalEvent[] = [];
      const result = await runLensPipeline({
        claudePort: fakeClaudePort([], (prompt) => {
          const lens = lensFromPrompt(prompt);
          if (lens === requiredLens) {
            requiredTurns += 1;
            return { elements: [], skippedHunks: [] };
          }
          if (lens === "post-process" && prompt.includes('"elements":[]')) {
            return { elements: [], skippedHunks: [] };
          }
          return cleanBody(lens);
        }),
        codexExecutor: null,
        repoRoot: "/pr-worktree",
        deltaPacket: PACKET,
        hunks: [],
        lintContextFor,
        readPrompt,
        whiteboard: fakeWhiteboard([]),
        boardIdFor: (lens) => `board:${lens}`,
        onBoardArrival: (event) => {
          arrivals.push(event);
        },
      });

      expect(requiredTurns).toBe(1);
      expect(result.boards.find(({ lens }) => lens === requiredLens)?.failure).toContain(
        requiredLens === "sequence"
          ? "no reachable `order_step` in the emitted board"
          : "produced zero elements in the emitted board",
      );
      expect(arrivals.map(({ lens }) => lens)).not.toContain(requiredLens);
    },
  );

  it("keeps a valid Design board when the provider envelope also contains grounded absence fields", async () => {
    const applied: Applied[] = [];
    const designBoard = cleanBody("design");
    const result = await runLensPipeline({
      claudePort: fakeClaudePort([], (prompt) => {
        const lens = lensFromPrompt(prompt);
        if (lens !== "design") return cleanBody(lens);
        return {
          ...designBoard,
          absence: "no-material",
          candidates: DESIGN_ARTIFACTS.candidates.map((candidate) => ({
            id: candidate.id,
            relevance: candidate.relevance.kind,
            reason: "The candidate is unrelated to the reviewed change.",
          })),
        };
      }),
      codexExecutor: null,
      repoRoot: "/pr-worktree",
      deltaPacket: PACKET,
      hunks: [],
      lintContextFor,
      designArtifacts: DESIGN_ARTIFACTS,
      readPrompt,
      whiteboard: fakeWhiteboard(applied),
      boardIdFor: (lens) => `board:${lens}`,
    });

    const design = result.boards.find(({ lens }) => lens === "design");
    expect(design).toMatchObject({ lens: "design" });
    expect(design?.absence).toBeUndefined();
    expect(design?.board).toBeDefined();
    expect(applied.map(({ boardId }) => boardId)).toContain("board:design");
  });

  it("refuses durable no-material when Design discovery omitted a candidate", async () => {
    const incompleteArtifacts: DesignArtifactSet = {
      ...DESIGN_ARTIFACTS,
      candidates: DESIGN_ARTIFACTS.candidates.map((candidate) => ({
        ...candidate,
        relevance: { kind: "repository-candidate" as const },
      })),
      omittedCandidateCount: 1,
    };
    const result = await runLensPipeline({
      claudePort: fakeClaudePort([], (prompt) => {
        const lens = lensFromPrompt(prompt);
        if (lens !== "design") return cleanBody(lens);
        return {
          absence: "no-material",
          candidates: incompleteArtifacts.candidates.map((candidate) => ({
            id: candidate.id,
            relevance: candidate.relevance.kind,
            reason: "The visible candidate is unrelated to the reviewed change.",
          })),
        };
      }),
      codexExecutor: null,
      repoRoot: "/pr-worktree",
      deltaPacket: PACKET,
      hunks: [],
      lintContextFor,
      designArtifacts: incompleteArtifacts,
      readPrompt,
      whiteboard: fakeWhiteboard([]),
      boardIdFor: (lens) => `board:${lens}`,
    });

    const design = result.boards.find(({ lens }) => lens === "design");
    expect(design?.absence).toBeUndefined();
    expect(design?.failure).toContain("no parseable board");
  });

  it("rejects a no-material result that does not account for every candidate", async () => {
    const result = await runLensPipeline({
      claudePort: fakeClaudePort([], (prompt) => {
        const lens = lensFromPrompt(prompt);
        return lens === "design" ? { absence: "no-material", candidates: [] } : cleanBody(lens);
      }),
      codexExecutor: null,
      repoRoot: "/pr-worktree",
      deltaPacket: PACKET,
      hunks: [],
      lintContextFor,
      designArtifacts: DESIGN_ARTIFACTS,
      readPrompt,
      whiteboard: fakeWhiteboard([]),
      boardIdFor: (lens) => `board:${lens}`,
    });

    const design = result.boards.find(({ lens }) => lens === "design");
    expect(design?.absence).toBeUndefined();
    expect(design?.failure).toContain("no parseable board");
  });

  it("accepts a grounded no-material correction on the retry channel", async () => {
    let designTurns = 0;
    const result = await runLensPipeline({
      claudePort: fakeClaudePort([], (prompt) => {
        const lens = lensFromPrompt(prompt);
        if (lens !== "design") return cleanBody(lens);
        designTurns += 1;
        if (designTurns === 1) return { absence: "no-material", candidates: [] };
        return {
          absence: "no-material",
          candidates: DESIGN_ARTIFACTS.candidates.map((candidate) => ({
            id: candidate.id,
            relevance: candidate.relevance.kind,
            reason: "This specification describes a different feature than the reviewed change.",
          })),
        };
      }),
      codexExecutor: null,
      repoRoot: "/pr-worktree",
      deltaPacket: PACKET,
      hunks: [],
      lintContextFor,
      designArtifacts: DESIGN_ARTIFACTS,
      readPrompt,
      whiteboard: fakeWhiteboard([]),
      boardIdFor: (lens) => `board:${lens}`,
    });

    expect(result.boards.find(({ lens }) => lens === "design")).toMatchObject({
      lens: "design",
      absence: "no-material",
    });
    expect(designTurns).toBe(2);
  });

  it.each([
    [
      "missing",
      (board: DraftBoard): DraftBoard => ({
        ...board,
        document: {
          ...board.document,
          stats: board.document?.stats?.filter(({ label }) => label !== "Format"),
        } as NonNullable<DraftBoard["document"]>,
      }),
    ],
    [
      "mismatched",
      (board: DraftBoard): DraftBoard => ({
        ...board,
        document: {
          ...board.document,
          stats: board.document?.stats?.map((stat) =>
            stat.label === "Format" ? { ...stat, value: "Kiro" } : stat,
          ),
        } as NonNullable<DraftBoard["document"]>,
      }),
    ],
  ] as const)("retries a Design draft with a %s Format stat", async (_name, invalidate) => {
    let designTurns = 0;
    const captures: { model?: string; prompt?: string }[] = [];
    const result = await runLensPipeline({
      claudePort: fakeClaudePort(captures, (prompt) => {
        const lens = lensFromPrompt(prompt);
        if (lens === "design") {
          designTurns += 1;
          const valid = designBody();
          return designTurns === 1 ? invalidate(valid) : valid;
        }
        if (lens === "post-process") {
          const context = /rennet:layer context>>>\n(\{.*)/s.exec(prompt);
          return context ? JSON.parse(context[1] as string).board : { elements: [] };
        }
        return cleanBody(lens);
      }),
      codexExecutor: null,
      repoRoot: "/pr-worktree",
      deltaPacket: PACKET,
      hunks: [],
      lintContextFor,
      designArtifacts: DESIGN_ARTIFACTS,
      readPrompt,
      whiteboard: fakeWhiteboard([]),
      boardIdFor: (lens) => `board:${lens}`,
    });

    expect(designTurns).toBe(2);
    expect(
      result.boards.find(({ lens }) => lens === "design")?.board?.document?.stats,
    ).toContainEqual({ label: "Format", value: "OpenSpec" });
    expect(captures.some(({ prompt }) => prompt?.includes("Design header stat `format`"))).toBe(
      true,
    );
  });

  it("stamps host-owned BMAD anatomy before lint without asking the drafter to duplicate it", async () => {
    const path = "docs/stories/1.1.restore-sessions.story.md";
    const story = "**As a** reviewer, **I want** sessions restored, **so that** I can resume work.";
    const acceptance = "The last open review is restored.";
    const task = "- [ ] Task 1 (AC: 1)";
    const source = [
      "# Story 1.1: Restore sessions",
      "",
      "## Status",
      "Approved",
      "",
      "## Story",
      story,
      "",
      "## Acceptance Criteria",
      `1. ${acceptance}`,
      "",
      "## Tasks / Subtasks",
      task,
    ].join("\n");
    const artifacts = singleDesignArtifactSet("bmad", "story", path, source);
    const author = { kind: "lens-agent" as const, id: "design-seat" };
    const rawDraft = {
      document: {
        title: "Fixture",
        introMarkdown: "Restore the review session.",
        measure: "structured",
        sources: [{ path, candidate: "candidate-fixture" }],
        stats: [
          { label: "Format", value: "BMAD" },
          { label: "Requirements", value: "1" },
        ],
      },
      elements: [
        {
          id: "story-root",
          kind: "section",
          data: {
            author,
            title: "Story 1.1: Restore sessions",
            children: ["story-requirement", "story-tasks"],
            sources: [{ path, candidate: "candidate-fixture" }],
          },
        },
        {
          id: "story-requirement",
          kind: "requirement",
          data: {
            author,
            name: "Story 1.1: Restore sessions",
            capability: "story:1.1",
            shall: story,
            scenarios: ["story-acceptance-1"],
            source: { path, candidate: "candidate-fixture", line: 6 },
          },
        },
        {
          id: "story-acceptance-1",
          kind: "prose",
          data: { author, markdown: acceptance },
        },
        {
          id: "story-tasks",
          kind: "section",
          data: { author, title: "Task 1 (AC: 1)", children: ["story-task-1"] },
        },
        {
          id: "story-task-1",
          kind: "prose",
          data: { author, markdown: task },
        },
      ],
      skippedHunks: [],
    } as unknown as DraftBoard;
    let designTurns = 0;
    const result = await runLensPipeline({
      claudePort: fakeClaudePort([], (prompt) => {
        const lens = lensFromPrompt(prompt);
        if (lens === "design") {
          designTurns += 1;
          return rawDraft;
        }
        if (lens === "post-process") {
          const context = /rennet:layer context>>>\n(\{.*)/s.exec(prompt);
          return context ? JSON.parse(context[1] as string).board : { elements: [] };
        }
        return cleanBody(lens);
      }),
      codexExecutor: null,
      repoRoot: "/pr-worktree",
      deltaPacket: PACKET,
      hunks: [],
      lintContextFor: (lens) => ({
        lens,
        hunks: [],
        files: new Map([[path, source.split("\n").length]]),
      }),
      designArtifacts: artifacts,
      readPrompt,
      whiteboard: fakeWhiteboard([]),
      boardIdFor: (lens) => `board:${lens}`,
    });

    expect(designTurns).toBe(1);
    const board = result.boards.find(({ lens }) => lens === "design")?.board;
    expect(board?.elements.find(({ id }) => id === "story-requirement")?.data).toMatchObject({
      status: "Approved",
    });
    expect(board?.elements.find(({ id }) => id === "story-task-1")?.data).toMatchObject({
      acceptance_criteria: ["1"],
    });
  });

  it("replaces forged BMAD source cells before lint and persists the exact host projection", async () => {
    const path = "docs/architecture.md";
    const source = [
      "# Architecture",
      "",
      "## Tech Stack",
      "| Category | Technology | Version | Rationale |",
      "| --- | --- | --- | --- |",
      "| Language | TypeScript | 5.6 | Shared types |",
    ].join("\n");
    const artifacts = singleDesignArtifactSet("bmad", "architecture", path, source);
    const author = { kind: "lens-agent" as const, id: "design-seat" };
    const rawDraft = {
      document: {
        title: "Fixture",
        introMarkdown: "The definitive application stack.",
        measure: "structured",
        sources: [{ path, candidate: "candidate-fixture" }],
        stats: [
          { label: "Format", value: "BMAD" },
          { label: "Requirements", value: "0" },
        ],
      },
      elements: [
        {
          id: "architecture-root",
          kind: "section",
          data: {
            author,
            title: "Architecture",
            children: ["tech-stack-choice"],
            sources: [{ path, candidate: "candidate-fixture" }],
          },
        },
        {
          id: "tech-stack-choice",
          kind: "decision",
          data: {
            author,
            statement: "Language · TypeScript · 5.6",
            why: "Shared types",
            alternatives: [],
            evidence: [],
            inferred: false,
            source: { path, candidate: "candidate-fixture", line: 6 },
            source_cells: ["forged", "order"],
          },
        },
      ],
      skippedHunks: [],
    } as unknown as DraftBoard;
    let designTurns = 0;
    const result = await runLensPipeline({
      claudePort: fakeClaudePort([], (prompt) => {
        const lens = lensFromPrompt(prompt);
        if (lens === "design") {
          designTurns += 1;
          return rawDraft;
        }
        if (lens === "post-process") {
          const context = /rennet:layer context>>>\n(\{.*)/s.exec(prompt);
          return context ? JSON.parse(context[1] as string).board : { elements: [] };
        }
        return cleanBody(lens);
      }),
      codexExecutor: null,
      repoRoot: "/pr-worktree",
      deltaPacket: PACKET,
      hunks: [],
      lintContextFor: (lens) => ({
        lens,
        hunks: [],
        files: new Map([[path, source.split("\n").length]]),
      }),
      designArtifacts: artifacts,
      readPrompt,
      whiteboard: fakeWhiteboard([]),
      boardIdFor: (lens) => `board:${lens}`,
    });

    expect(designTurns).toBe(1);
    expect(
      result.boards
        .find(({ lens }) => lens === "design")
        ?.board?.elements.find(({ id }) => id === "tech-stack-choice")?.data,
    ).toMatchObject({
      source_cells: ["Language", "TypeScript", "5.6", "Shared types"],
    });
  });

  it("replaces drafter-authored Design coverage with grounded immutable hunk refs", async () => {
    const captures: { model?: string; prompt?: string }[] = [];
    const requests: Parameters<DesignCoverageMapper>[0][] = [];
    const mapDesignCoverage: DesignCoverageMapper = async (request) => {
      requests.push(request);
      return {
        status: "ok",
        edges: [
          {
            capability: "auth",
            requirement: "Refresh before retry",
            hunks: ["rennet:hunk/impl-hunk", "rennet:hunk/test-hunk"],
            tests: 1,
          },
        ],
      };
    };
    const bodyFor = (prompt: string): unknown => {
      const lens = lensFromPrompt(prompt);
      if (lens === "design") {
        const drafted = designBody();
        return {
          ...drafted,
          elements: drafted.elements.map((element) =>
            element.id === "requirement-refresh"
              ? {
                  ...element,
                  data: { ...element.data, related_files: ["src/invented.ts"] },
                }
              : element,
          ),
          skippedHunks: [
            { hunk: "impl-hunk", reason: "The drafter left implementation mapping to the host." },
          ],
        };
      }
      if (lens === "post-process") {
        const context = /rennet:layer context>>>\n(\{.*)/s.exec(prompt);
        return context ? JSON.parse(context[1] as string).board : { elements: [] };
      }
      return cleanBody(lens);
    };

    const result = await runLensPipeline({
      claudePort: fakeClaudePort(captures, bodyFor),
      codexExecutor: null,
      repoRoot: "/pr-worktree",
      deltaPacket: DESIGN_PACKET,
      hunks: DESIGN_LINT_HUNKS,
      lintContextFor: (lens) => ({
        lens,
        hunks: DESIGN_LINT_HUNKS,
        files: new Map([
          [DESIGN_SOURCE, 20],
          ["src/auth.ts", 100],
          ["src/auth.test.ts", 100],
        ]),
      }),
      designArtifacts: DESIGN_ARTIFACTS,
      mapDesignCoverage,
      readPrompt,
      whiteboard: fakeWhiteboard([]),
      boardIdFor: (lens) => `board:${lens}`,
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.requirements).toEqual([
      {
        capability: "auth",
        name: "Refresh before retry",
        statement: "The system SHALL refresh the token before classifying an error.",
        scenarios: [
          "Scenario: Expired token\n\nWHEN a request uses an expired token\nTHEN the client refreshes it before retrying.",
        ],
      },
    ]);
    expect(requests[0]?.hunks.map(({ id }) => id)).toEqual(["impl-hunk", "test-hunk"]);

    const board = result.boards.find(({ lens }) => lens === "design")?.board;
    expect(board?.elements.some(({ id }) => id === "fabricated-coverage-ref")).toBe(false);
    expect((board as { skippedHunks?: unknown[] } | undefined)?.skippedHunks).toEqual([]);
    const requirement = board?.elements.find(({ id }) => id === "requirement-refresh");
    expect(requirement?.data).toMatchObject({
      coverage: "met",
      tests: 1,
      related_files: ["src/auth.ts", "src/auth.test.ts"],
    });
    const trace = (requirement?.data as { trace?: string[] } | undefined)?.trace ?? [];
    expect(trace).toHaveLength(2);
    const refs = board?.elements.filter(({ id }) => trace.includes(id)) ?? [];
    expect(refs.map(({ data }) => (data as { path: string }).path)).toEqual([
      "src/auth.ts",
      "src/auth.test.ts",
    ]);
    expect(refs.map(({ data }) => data.author)).toEqual([
      { kind: "orchestrator", id: "coverage-mapper" },
      { kind: "orchestrator", id: "coverage-mapper" },
    ]);
  });

  it("shows no Design coverage chip when the change contains only proposal artifacts", async () => {
    let mappingCalls = 0;
    const stampHunk = {
      id: "openspec-stamp",
      path: ".openspec.yaml",
      header: "@@ -0,0 +1 @@",
      body: ["+schema: spec-driven"],
      spans: { old: { start: 0, lines: 0 }, new: { start: 1, lines: 1 } },
      lossy: false,
    } as const;
    const stampLintHunk: LintHunk = {
      id: stampHunk.id,
      path: stampHunk.path,
      newStart: 1,
      newLines: 1,
      oldStart: 0,
      oldLines: 0,
    };
    const proposalPacket = {
      ...DESIGN_PACKET,
      hunks: {
        hunks: [DESIGN_HUNKS[0], stampHunk],
        byId: new Map<string, unknown>([
          [DESIGN_HUNKS[0].id, DESIGN_HUNKS[0]],
          [stampHunk.id, stampHunk],
        ]),
      },
    } as unknown as DeltaPacket;
    const bodyFor = (prompt: string): unknown => {
      const lens = lensFromPrompt(prompt);
      if (lens === "design") return designBody();
      if (lens === "post-process") {
        const context = /rennet:layer context>>>\n(\{.*)/s.exec(prompt);
        return context ? JSON.parse(context[1] as string).board : { elements: [] };
      }
      return cleanBody(lens);
    };

    const result = await runLensPipeline({
      claudePort: fakeClaudePort([], bodyFor),
      codexExecutor: null,
      repoRoot: "/pr-worktree",
      deltaPacket: proposalPacket,
      hunks: [DESIGN_LINT_HUNKS[0] as LintHunk, stampLintHunk],
      lintContextFor: (lens) => ({
        lens,
        hunks: [DESIGN_LINT_HUNKS[0] as LintHunk, stampLintHunk],
        files: new Map([
          [DESIGN_SOURCE, 20],
          [stampHunk.path, 1],
          ["src/auth.ts", 100],
          ["src/auth.test.ts", 100],
        ]),
      }),
      designArtifacts: DESIGN_ARTIFACTS,
      mapDesignCoverage: async () => {
        mappingCalls += 1;
        return { status: "ok", edges: [] };
      },
      readPrompt,
      whiteboard: fakeWhiteboard([]),
      boardIdFor: (lens) => `board:${lens}`,
    });

    expect(mappingCalls).toBe(0);
    const board = result.boards.find(({ lens }) => lens === "design")?.board;
    const data = board?.elements.find(({ id }) => id === "requirement-refresh")?.data as
      | Record<string, unknown>
      | undefined;
    expect(data).toBeDefined();
    expect(data).not.toHaveProperty("coverage");
    expect(data).not.toHaveProperty("trace");
    expect(data).not.toHaveProperty("tests");
    expect(data).not.toHaveProperty("related_files");
    expect(board?.skippedHunks).toEqual([
      {
        hunk: stampHunk.id,
        reason: ".openspec.yaml is a generated scaffold stamp owned by the Noise lens.",
      },
    ]);
  });

  it("classifies grounded Design coverage as gap or partial from host evidence", async () => {
    const bodyFor = (prompt: string): unknown => {
      const lens = lensFromPrompt(prompt);
      if (lens === "design") return designBody();
      if (lens === "post-process") {
        const context = /rennet:layer context>>>\n(\{.*)/s.exec(prompt);
        return context ? JSON.parse(context[1] as string).board : { elements: [] };
      }
      return cleanBody(lens);
    };
    const run = async (hunks: readonly string[]) =>
      runLensPipeline({
        claudePort: fakeClaudePort([], bodyFor),
        codexExecutor: null,
        repoRoot: "/pr-worktree",
        deltaPacket: DESIGN_PACKET,
        hunks: DESIGN_LINT_HUNKS,
        lintContextFor: (lens) => ({
          lens,
          hunks: DESIGN_LINT_HUNKS,
          files: new Map([
            [DESIGN_SOURCE, 20],
            ["src/auth.ts", 100],
            ["src/auth.test.ts", 100],
          ]),
        }),
        designArtifacts: DESIGN_ARTIFACTS,
        mapDesignCoverage: async () => ({
          status: "ok",
          edges: [
            {
              capability: "auth",
              requirement: "Refresh before retry",
              hunks,
              tests: 0,
            },
          ],
        }),
        readPrompt,
        whiteboard: fakeWhiteboard([]),
        boardIdFor: (lens) => `board:${lens}`,
      });

    const gap = await run([]);
    const partial = await run(["rennet:hunk/impl-hunk"]);
    const dataFor = (result: Awaited<ReturnType<typeof runLensPipeline>>) =>
      result.boards
        .find(({ lens }) => lens === "design")
        ?.board?.elements.find(({ id }) => id === "requirement-refresh")?.data;

    expect(dataFor(gap)).toMatchObject({ coverage: "gap", trace: [], tests: 0 });
    expect(dataFor(partial)).toMatchObject({ coverage: "partial", tests: 0 });
    expect((dataFor(partial) as { trace?: unknown[] } | undefined)?.trace).toHaveLength(1);
  });

  it("omits Design coverage when the host mapper fails or throws", async () => {
    const bodyFor = (prompt: string): unknown => {
      const lens = lensFromPrompt(prompt);
      if (lens === "design") return designBody();
      if (lens === "post-process") {
        const context = /rennet:layer context>>>\n(\{.*)/s.exec(prompt);
        return context ? JSON.parse(context[1] as string).board : { elements: [] };
      }
      return cleanBody(lens);
    };
    const mappers: DesignCoverageMapper[] = [
      async () => ({ status: "failed", edges: [] }),
      async () => {
        throw new Error("coverage seat crashed");
      },
    ];

    for (const mapDesignCoverage of mappers) {
      const result = await runLensPipeline({
        claudePort: fakeClaudePort([], bodyFor),
        codexExecutor: null,
        repoRoot: "/pr-worktree",
        deltaPacket: DESIGN_PACKET,
        hunks: DESIGN_LINT_HUNKS,
        lintContextFor: (lens) => ({
          lens,
          hunks: DESIGN_LINT_HUNKS,
          files: new Map([
            [DESIGN_SOURCE, 20],
            ["src/auth.ts", 100],
            ["src/auth.test.ts", 100],
          ]),
        }),
        designArtifacts: DESIGN_ARTIFACTS,
        mapDesignCoverage,
        readPrompt,
        whiteboard: fakeWhiteboard([]),
        boardIdFor: (lens) => `board:${lens}`,
      });
      const data = result.boards
        .find(({ lens }) => lens === "design")
        ?.board?.elements.find(({ id }) => id === "requirement-refresh")?.data as
        | Record<string, unknown>
        | undefined;
      expect(data).toBeDefined();
      expect(data).not.toHaveProperty("coverage");
      expect(data).not.toHaveProperty("trace");
      expect(data).not.toHaveProperty("tests");
    }
  });

  it("keeps Design title, source navigation, stats, and verbatim scenarios without a rewrite turn", async () => {
    const bodyFor = (prompt: string): unknown => {
      const lens = lensFromPrompt(prompt);
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
      claudePort: fakeClaudePort([], bodyFor),
      codexExecutor: null,
      repoRoot: "/pr-worktree",
      deltaPacket: DESIGN_PACKET,
      hunks: DESIGN_LINT_HUNKS,
      lintContextFor: (lens) => ({
        lens,
        hunks: DESIGN_LINT_HUNKS,
        files: new Map([
          [DESIGN_SOURCE, 20],
          ["src/auth.ts", 100],
          ["src/auth.test.ts", 100],
        ]),
      }),
      designArtifacts: DESIGN_ARTIFACTS,
      readPrompt,
      whiteboard: fakeWhiteboard([]),
      boardIdFor: (lens) => `board:${lens}`,
    });

    const board = result.boards.find(({ lens }) => lens === "design")?.board;
    expect(board?.document?.title).toBe("token-refresh");
    expect(board?.document?.sources).toEqual([
      { path: DESIGN_SOURCE, candidate: "candidate-1", label: "auth spec", line: 1 },
    ]);
    expect(board?.document?.stats).toEqual([
      { label: "Format", value: "OpenSpec" },
      { label: "Requirements", value: "1" },
      { label: "Capabilities", value: "1 new / 0 modified" },
    ]);
    expect(board?.elements.find(({ id }) => id === "auth-section")?.data).toMatchObject({
      sources: [{ path: DESIGN_SOURCE, candidate: "candidate-1", line: 1 }],
      spec_delta: "added",
    });
    expect(board?.elements.find(({ id }) => id === "auth-added-requirements")?.data).toMatchObject({
      title: "ADDED Requirements",
      spec_delta: "added",
    });
    const requirement = board?.elements.find(({ id }) => id === "requirement-refresh")?.data;
    expect(requirement).toMatchObject({
      shall: "The system SHALL refresh the token before classifying an error.",
      source: { path: DESIGN_SOURCE, candidate: "candidate-1", line: 3 },
    });
    expect(requirement).not.toHaveProperty("related_files");
    expect(board?.elements.find(({ id }) => id === "scenario-expired")?.data).toMatchObject({
      markdown:
        "Scenario: Expired token\n\nWHEN a request uses an expired token\nTHEN the client refreshes it before retrying.",
      scenario_clauses: {
        condition: "a request uses an expired token",
        response: "the client refreshes it before retrying.",
      },
    });
    expect(board?.elements.find(({ id }) => id === "task-group")?.data).toMatchObject({
      children: ["task-copy"],
    });
    expect(board?.elements.find(({ id }) => id === "task-copy")?.data).toMatchObject({
      markdown: "- [ ] Prove restart recovery",
    });
  });

  it("keeps source-backed typed roots in drafter order without a rewrite turn", async () => {
    const bodyFor = (prompt: string): unknown => {
      const lens = lensFromPrompt(prompt);
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
      claudePort: fakeClaudePort([], bodyFor),
      codexExecutor: null,
      repoRoot: "/pr-worktree",
      deltaPacket: DESIGN_PACKET,
      hunks: DESIGN_LINT_HUNKS,
      lintContextFor: (lens) => ({
        lens,
        hunks: DESIGN_LINT_HUNKS,
        files: new Map([
          [DESIGN_SOURCE, 20],
          ["src/auth.ts", 100],
          ["src/auth.test.ts", 100],
        ]),
      }),
      designArtifacts: DESIGN_ARTIFACTS,
      readPrompt,
      whiteboard: fakeWhiteboard([]),
      boardIdFor: (lens) => `board:${lens}`,
    });

    const board = result.boards.find(({ lens }) => lens === "design")?.board;
    expect(
      board?.elements
        .filter(({ id }) => id === "auth-section" || id === "delivery-section")
        .map(({ id }) => id),
    ).toEqual(["auth-section", "delivery-section"]);
    expect(board?.elements.find(({ id }) => id === "auth-section")?.data).toMatchObject({
      children: ["auth-added-requirements"],
      spec_delta: "added",
    });
    expect(board?.elements.find(({ id }) => id === "delivery-section")?.data).toMatchObject({
      children: ["delivery-copy"],
    });
  });

  it("never runs the poisoned Design rewrite turn", async () => {
    const captures: HarnessCapture[] = [];
    const bodyFor = (prompt: string): unknown => {
      const lens = lensFromPrompt(prompt);
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
      claudePort: fakeClaudePort(captures, bodyFor),
      codexExecutor: null,
      repoRoot: "/pr-worktree",
      deltaPacket: DESIGN_PACKET,
      hunks: DESIGN_LINT_HUNKS,
      lintContextFor: (lens) => ({
        lens,
        hunks: DESIGN_LINT_HUNKS,
        files: new Map([
          [DESIGN_SOURCE, 20],
          ["src/auth.ts", 100],
          ["src/auth.test.ts", 100],
        ]),
      }),
      designArtifacts: DESIGN_ARTIFACTS,
      readPrompt,
      whiteboard: fakeWhiteboard([]),
      boardIdFor: (lens) => `board:${lens}`,
    });

    const design = result.boards.find(({ lens }) => lens === "design");
    expect(design?.board?.elements.some(({ id }) => id === "editor-forged-decision")).toBe(false);
    expect(
      design?.board?.elements.find(({ id }) => id === "drafter-structure")?.data,
    ).toMatchObject({
      title: "Implementation context",
      children: [],
    });
    expect(
      design?.board?.elements.find(({ id }) => id === "editor-connective-prose"),
    ).toBeUndefined();
    expect(captures.some(({ prompt }) => lensFromPrompt(prompt ?? "") === "post-process")).toBe(
      false,
    );
    expect(design?.immutability).toEqual([]);
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
          mkSection("findings", "Findings", ["f1"]),
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
    const providerCalls = [...claudeCaptures, ...codexCaptures].map(({ prompt }) =>
      lensFromPrompt(prompt ?? ""),
    );
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
      onBoardArrival: (event) => {
        arrivals.push(event);
      },
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

  it("drafts a landed round report from one compact classification turn and host-owned structure", async () => {
    const captures: HarnessCapture[] = [];
    const applied: Applied[] = [];
    const arrivals: BoardArrivalEvent[] = [];
    const diagnostics: RoundReportDiagnosticMilestone[] = [];
    const diagnosticTimes = [100, 110, 105, 120, 115, 130, 125];
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
      claudePort: fakeClaudePort(captures, (prompt) => {
        const lens = lensFromPrompt(prompt);
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
      codexExecutor: null,
      repoRoot: "/pr-worktree",
      deltaPacket: {
        ...PACKET,
        packetOnly: { privatePacketSentinel: "MUST_NOT_REACH_REPORT" },
      } as unknown as DeltaPacket,
      currentGeneration: "gen:ps-1:dispatch:round-2",
      round,
      hunks: [],
      lintContextFor,
      readPrompt,
      whiteboard: fakeWhiteboard(applied),
      boardIdFor: (lens) => `board:${lens}`,
      onBoardArrival: (event) => {
        arrivals.push(event);
      },
      onReportDiagnostic: (milestone) => diagnostics.push(milestone),
      now: () => diagnosticTimes.shift() ?? 125,
    });

    const reportCaptures = captures.filter(({ prompt }) => prompt?.includes("prompts/report.md"));
    expect(reportTurns).toBe(1);
    expect(reportCaptures).toHaveLength(1);
    expect(reportCaptures[0]?.model).toBe("sonnet-5");
    // The classifier's raw-response cap rides the session spec into the adapter (#727).
    expect(reportCaptures[0]?.outputByteCap).toBe(ROUND_REPORT_OUTPUT_MAX_BYTES);
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
    const reportContext = /rennet:layer context>>>\n(\{.*)/s.exec(reportPrompt);
    expect(reportContext).not.toBeNull();
    expect(JSON.parse(reportContext?.[1] ?? "{}")).toEqual({
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
    expect(
      captures
        .filter(({ prompt }) => prompt?.includes("prompts/design.md"))
        .every(({ prompt }) => prompt?.includes('"roundReport"')),
    ).toBe(true);
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
          claudePort: fakeClaudePort([], (prompt) => {
            if (lensFromPrompt(prompt) === "report") return classification;
            lensTurns += 1;
            return cleanBody(lensFromPrompt(prompt));
          }),
          codexExecutor: null,
          repoRoot: "/pr-worktree",
          deltaPacket: PACKET,
          currentGeneration: "gen:ps-1:dispatch:handoff",
          round,
          hunks: [],
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
    const captures: HarnessCapture[] = [];
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
      claudePort: fakeClaudePort(captures, (prompt) => cleanBody(lensFromPrompt(prompt))),
      codexExecutor: null,
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
      hunks: [],
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
      claudePort: fakeClaudePort([], (prompt) => {
        const lens = lensFromPrompt(prompt);
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
      codexExecutor: null,
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
      hunks: [],
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
      skippedHunks: [],
    };

    const result = await runLensPipeline({
      claudePort: fakeClaudePort([], (prompt) => {
        const lens = lensFromPrompt(prompt);
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
      codexExecutor: null,
      repoRoot: "/pr-worktree",
      deltaPacket: PACKET,
      currentGeneration: "gen:ps-1:dispatch:recovered",
      round,
      hunks: [],
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
        claudePort: fakeClaudePort([], (prompt) => {
          const lens = lensFromPrompt(prompt);
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
        codexExecutor: null,
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
        hunks: [],
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

  it("starts every independent lens turn after the report and before any lens is released", async () => {
    const lenses: LensKind[] = ["design", "sequence", "decisions", "flagged", "noise"];
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

    const codexExecutor = async (req: { prompt: string }) => {
      const lens = lensFromPrompt(req.prompt);
      providerCalls.push(lens);
      if (lens !== "report" && lenses.includes(lens as LensKind)) {
        const lensKind = lens as LensKind;
        if (!started.includes(lensKind)) {
          started.push(lensKind);
          announceFirstLensStart();
        }
        await lensBarriers.get(lensKind);
      }
      return { output: cleanBody(lens) };
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
      claudePort: null,
      codexExecutor: codexExecutor as never,
      repoRoot: "/pr-worktree",
      deltaPacket: {
        ...PACKET,
        successorAccount: { asks: [], beyondAsks: [] },
      },
      hunks: [],
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

    expect(result.boards.map(({ lens }) => lens)).toEqual(lenses);
    expect(
      applied.map(({ boardId }) => boardId).filter((boardId) => boardId !== "board:report"),
    ).toEqual([...lenses].reverse().map((lens) => `board:${lens}`));
    expect(arrivals).toEqual(lenses);
    expect(providerCalls).toEqual(["report", ...lenses]);
    expect(pipelineSettled).toBe(true);
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

    const codexExecutor = async (req: { prompt: string }) => {
      const lens = lensFromPrompt(req.prompt);
      if (lens === "post-process") {
        const context = /rennet:layer context>>>\n(\{.*)/s.exec(req.prompt);
        return {
          output: context ? (JSON.parse(context[1] as string).board as unknown) : { elements: [] },
        };
      }
      if (modelLenses.includes(lens as LensKind)) {
        const lensKind = lens as LensKind;
        if (!started.includes(lensKind)) {
          started.push(lensKind);
          announceFirstLensStart();
        }
        await lensRelease;
      }
      return {
        output: lens === "decisions" ? { elements: [], skippedHunks: [] } : cleanBody(lens),
      };
    };

    const pipeline = runLensPipeline({
      claudePort: null,
      codexExecutor: codexExecutor as never,
      repoRoot: "/pr-worktree",
      deltaPacket: PACKET,
      hunks: [],
      lintContextFor,
      designArtifacts: null,
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
      expect(started).toEqual(modelLenses);
      expect(pipelineSettled).toBe(false);
    } catch (error) {
      preReleaseFailure = error;
    } finally {
      releaseLensTurns();
    }
    await expect(pipeline).rejects.toThrow("absence store failed");
    if (preReleaseFailure !== undefined) throw preReleaseFailure;

    expect(absences).toEqual(["design", "decisions"]);
    expect(applied.map(({ boardId }) => boardId).sort()).toEqual(
      ["board:sequence", "board:flagged", "board:noise"].sort(),
    );
    expect(pipelineSettled).toBe(true);
  });

  it("fails an empty round report after its first draft without starting lens work", async () => {
    let reportTurns = 0;
    let lensTurns = 0;
    let lensDraftingStarts = 0;
    const applied: Applied[] = [];
    const arrivals: BoardArrivalEvent[] = [];

    const run = runLensPipeline({
      claudePort: fakeClaudePort([], (prompt) => {
        const lens = lensFromPrompt(prompt);
        if (lens === "report") {
          reportTurns += 1;
          return { elements: [], skippedHunks: [] };
        }
        if (lens === "post-process" && prompt.includes('"elements":[]')) {
          return { elements: [], skippedHunks: [] };
        }
        lensTurns += 1;
        return cleanBody(lens);
      }),
      codexExecutor: null,
      repoRoot: "/pr-worktree",
      deltaPacket: {
        ...PACKET,
        successorAccount: { asks: [], beyondAsks: [] },
      },
      hunks: [] as LintHunk[],
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
      claudePort: fakeClaudePort([], (prompt) => {
        const lens = lensFromPrompt(prompt);
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
      codexExecutor: null,
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
      hunks: [] as LintHunk[],
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
      skippedHunks: [],
    };

    const result = await runLensPipeline({
      claudePort: fakeClaudePort([], (prompt) => {
        const lens = lensFromPrompt(prompt);
        if (lens === "flagged") return currentFlagged;
        if (lens === "report") return cleanBody("report");
        if (lens === "post-process") {
          const context = /rennet:layer context>>>\n(\{.*)/s.exec(prompt);
          return context ? (JSON.parse(context[1] as string).board as unknown) : { elements: [] };
        }
        return cleanBody(lens);
      }),
      codexExecutor: null,
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
      hunks: [] as LintHunk[],
      lintContextFor: (lens) => ({
        ...lintContextFor(lens),
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

    const expectedResolution = {
      kind: "reattached" as const,
      finding,
      currentFindingId: "new-finding",
      match: "unique-semantic" as const,
    };
    const flagged = result.boards.find((outcome) => outcome.lens === "flagged");
    expect(flagged?.findingResolutions).toEqual([expectedResolution]);
    expect(result.findingResolutions).toEqual([expectedResolution]);
    expect(flagged).toMatchObject({ absence: "no-findings" });
    expect(flagged?.board).toBeUndefined();
    expect(applied.some(({ boardId }) => boardId === "board:flagged")).toBe(false);
    expect(persistedResolutionBatches).toEqual([
      {
        currentGeneration: "gen:ps-1",
        currentBoardId: "board:flagged",
        resolutions: [expectedResolution],
        findingDispositions: liveFindingDispositions,
      },
    ]);
    expect(persistedResolutionBatches[0]?.findingDispositions).toBe(liveFindingDispositions);
  });

  it("migrates a prior Flagged disposition when the new drafter returns honest empty", async () => {
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
      claudePort: fakeClaudePort([], (prompt) => {
        const lens = lensFromPrompt(prompt);
        if (lens === "flagged") {
          flaggedTurns += 1;
          return { elements: [], skippedHunks: [] };
        }
        return cleanBody(lens);
      }),
      codexExecutor: null,
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
      hunks: [],
      lintContextFor: (lens) => ({
        ...lintContextFor(lens),
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
    expect(result.boards.find(({ lens }) => lens === "flagged")).toMatchObject({
      absence: "no-findings",
      findingResolutions: [expectedResolution],
    });
    expect(persisted).toEqual([[expectedResolution]]);
  });

  it("fails only Flagged before its write when the live disposition read throws", async () => {
    const applied: Applied[] = [];
    let persistenceCalls = 0;

    const result = await runLensPipeline({
      claudePort: fakeClaudePort([], (prompt) => cleanBody(lensFromPrompt(prompt))),
      codexExecutor: null,
      repoRoot: "/pr-worktree",
      deltaPacket: PACKET,
      round: {
        number: 1,
        // Same generation: isolate the Flagged failure boundary without drafting a report.
        previousGeneration: "gen:ps-1",
        dispatchedAsks: [],
        findingDispositions: {},
      },
      hunks: [] as LintHunk[],
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
    expect(applied.map(({ boardId }) => boardId).sort()).toEqual(
      ["board:design", "board:sequence", "board:decisions", "board:noise"].sort(),
    );
    expect(
      result.boards
        .filter((outcome) => outcome.lens !== "flagged")
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
      claudePort: fakeClaudePort([], (prompt) => {
        const lens = lensFromPrompt(prompt);
        if (lens === "flagged") return flaggedBoard;
        if (lens === "report") return cleanBody("report");
        if (lens === "post-process") {
          const context = /rennet:layer context>>>\n(\{.*)/s.exec(prompt);
          return context ? (JSON.parse(context[1] as string).board as unknown) : { elements: [] };
        }
        return cleanBody(lens);
      }),
      codexExecutor: null,
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
      hunks: [] as LintHunk[],
      lintContextFor: (lens) => ({
        ...lintContextFor(lens),
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

    const expectedResolution = {
      kind: "reattached" as const,
      finding,
      currentFindingId: finding.findingId,
      match: "stable-id" as const,
    };
    const flagged = result.boards.find((outcome) => outcome.lens === "flagged");
    expect(flagged?.failure).toContain("ask log unavailable");
    expect(flagged?.board).toBeUndefined();
    expect(flagged?.findingResolutions).toEqual([expectedResolution]);
    expect(result.findingResolutions).toEqual([expectedResolution]);
    expect(applied.some(({ boardId }) => boardId === "board:flagged")).toBe(false);
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
        mkSection("findings", "Findings", ["f1"]),
      ],
      [{ hunk: "h2", reason: "The util rename is mechanical — the Noise board owns it." }],
    );
  const bodyForFlagged = (prompt: string): unknown => {
    const lens = lensFromPrompt(prompt);
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
      claudePort: fakeClaudePort([], (p) => cleanBody(lensFromPrompt(p))),
      codexExecutor: null,
      repoRoot: "/pr-worktree",
      deltaPacket: PACKET,
      hunks: [] as LintHunk[],
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

  it("keeps the harness's own words in the failure, under a spent-ladder terminal account", async () => {
    const failingPort = {
      createSession: async () => ({
        send: async () => undefined,
        close: async () => undefined,
        events: (async function* () {
          yield {
            kind: "error",
            error: { message: "structured output exceeded the seat capability" },
          };
        })(),
      }),
    } as unknown as HarnessPort;
    const result = await runLensPipeline({
      claudePort: failingPort,
      codexExecutor: null,
      repoRoot: "/pr-worktree",
      deltaPacket: PACKET,
      hunks: [] as LintHunk[],
      lintContextFor,
      readPrompt,
      whiteboard: fakeWhiteboard([]),
      boardIdFor: (l) => `board:${l}`,
    });
    for (const outcome of result.boards) {
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

describe("renderDrafterPrompt — the inventory travels, the diff content does not", () => {
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

  it("redacts hunk bodies while the hunk ids/headers/spans survive", () => {
    const prompt = renderDrafterPrompt("lens instructions", RANGE_PACKET);
    // Positive control: the body string IS in the packet — deleting the
    // redaction in renderDrafterPrompt turns this assertion red.
    expect(JSON.stringify(RANGE_PACKET.hunks.hunks)).toContain(SECRET(HUNK_BODY));
    expect(prompt).not.toContain(SECRET(HUNK_BODY));
    expect(prompt).toContain("hunk-1");
    expect(prompt).toContain("@@ -1,1 +1,1 @@");
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

  it("still inlines design artifacts and round context beside the inventory", () => {
    const prompt = renderDrafterPrompt(
      "lens instructions",
      RANGE_PACKET,
      undefined,
      DESIGN_ARTIFACTS,
      undefined,
      {
        number: 2,
        dispatchedAsks: [],
      } as never,
    );
    expect(prompt).toContain("token-refresh");
    expect(prompt).toContain('"number":2');
  });

  it("keeps the worker's verbatim turn diff out of ordinary lens prompts", () => {
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
    const lens = renderDrafterPrompt(
      "lens instructions",
      RANGE_PACKET,
      undefined,
      undefined,
      undefined,
      round,
    );
    expect(lens).not.toContain(SECRET(WORKER_DIFF));
    expect(lens).toContain('"changedPaths":["src/a.ts"]');
    const report = renderDrafterPrompt(
      "report instructions",
      RANGE_PACKET,
      undefined,
      undefined,
      undefined,
      round,
      {
        omitTaskLayer: true,
        includeWorkerDiff: true,
      },
    );
    expect(report).toContain(SECRET(WORKER_DIFF));
  });

  it("omits the task layer for the legacy report seat", () => {
    const prompt = renderDrafterPrompt(
      "report instructions",
      RANGE_PACKET,
      undefined,
      undefined,
      undefined,
      undefined,
      { omitTaskLayer: true },
    );
    expect(prompt).not.toContain("rennet:layer task");
    expect(prompt).toContain("rennet:layer context");
  });
});

/** Indirection so the control string never appears verbatim in this file's own text. */
function SECRET(s: string): string {
  return s;
}
