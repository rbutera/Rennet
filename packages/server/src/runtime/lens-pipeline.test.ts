import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DESIGN_ARTIFACT_LIMITS, type DesignArtifactSet, WhiteboardClient } from "@rennet/adapters";
import {
  type DeltaPacket,
  type HarnessPort,
  type LintContext,
  type LintHunk,
  type LintTarget,
  selectPacketKnowledge,
} from "@rennet/core";
import {
  type DraftBoard,
  findingRefKey,
  type KnowledgeStatement,
  type LensKind,
} from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import { createBoardsRuntime } from "../boards/boards-runtime";
import {
  type BoardArrivalEvent,
  type BoardMeta,
  boardOutputSchema,
  composeReviewDraft,
  type DesignCoverageMapper,
  draftToOps,
  projectDesignTaskProgress,
  reconcileFlaggedBoards,
  renderDrafterPrompt,
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

describe("renderDrafterPrompt — what the packet's knowledge field actually shows a drafter", () => {
  const statement = (id: string, claim: string): KnowledgeStatement => ({
    id,
    subject: "src/a.ts",
    aspect: "purpose",
    claim,
    evidence: [{ path: "src/a.ts", blobOid: "blob-a" }],
    confidence: "high",
    status: "hypothesis",
    provenance: { generator: "g@1", model: null, apiKeySource: null },
    learnedAgainst: { baseOid: "oid", snapshotFingerprint: "fp" },
  });

  it("inlines the OFFERED subset, leaves the capped-out statement out, and shows the truncation", () => {
    // Two statements, a cap of one: the drafter must see one claim, must NOT see the
    // other, and must be able to tell that a second one exists. Asserting only the
    // first would pass over an implementation that silently dropped the disclosure.
    const knowledge = selectPacketKnowledge({
      set: {
        schemaVersion: 1,
        repoKey: "repo",
        baseOid: "oid",
        snapshotFingerprint: "fp",
        generator: "g@1",
        statements: [statement("k1", "OFFERED-CLAIM"), statement("k2", "DROPPED-CLAIM")],
      },
      snapshot: null,
      changedPaths: ["src/a.ts"],
      cap: 1,
    });
    const packet = { ...PACKET, knowledge } as unknown as DeltaPacket;
    const prompt = renderDrafterPrompt("PROMPT_FILE:prompts/design.md", packet);

    expect(prompt).toContain("OFFERED-CLAIM");
    expect(prompt).not.toContain("DROPPED-CLAIM");
    // The honesty flags travel with it: the mode it got, and how much it did not get.
    expect(prompt).toContain('"truncated":1');
    expect(prompt).toContain('"inStore":2');
    expect(prompt).toContain('"mode":"unprojected"');
    expect(prompt).toContain("context.ask");
  });

  it("inlines the exact discovered Design artifact set instead of making the drafter rediscover it", () => {
    const prompt = renderDrafterPrompt(
      "PROMPT_FILE:prompts/design.md",
      PACKET,
      undefined,
      DESIGN_ARTIFACTS,
    );

    expect(prompt).toContain('"id":"candidate-1"');
    expect(prompt).toContain('"name":"token-refresh"');
    expect(prompt).toContain('"path":"openspec/changes/token-refresh/specs/auth/spec.md"');
    expect(prompt).toContain("The system SHALL refresh the token before classifying an error.");
  });

  it("inlines the exact durable ask identity and finding reference for a returned round", () => {
    const prompt = renderDrafterPrompt(
      "PROMPT_FILE:prompts/report.md",
      PACKET,
      undefined,
      undefined,
      boardOutputSchema(),
      {
        number: 3,
        previousGeneration: "gen:ps-0",
        previousFlaggedBoardId: "board:flagged:ps-0",
        dispatchedAsks: [
          {
            id: 'finding:["gen:ps-0","board:flagged:ps-0","finding-auth"]',
            path: "src/auth.ts",
            type: "request-change",
            instruction: "Keep the refresh inside the retry boundary.",
            context: "",
            finding: {
              generation: "gen:ps-0",
              boardId: "board:flagged:ps-0",
              findingId: "finding-auth",
            },
          },
        ],
        findingDispositions: {},
        worker: {
          outcome: "completed",
          diff: "WORKER_ONLY_DIFF",
          changedPaths: ["src/auth.ts"],
          commitRange: { from: "same-head", to: "same-head" },
        },
      },
    );

    expect(prompt).toContain('"number":3');
    expect(prompt).toContain(
      '"id":"finding:[\\"gen:ps-0\\",\\"board:flagged:ps-0\\",\\"finding-auth\\"]"',
    );
    expect(prompt).toContain(
      '"finding":{"generation":"gen:ps-0","boardId":"board:flagged:ps-0","findingId":"finding-auth"}',
    );
    expect(prompt).toContain('"diff":"WORKER_ONLY_DIFF"');
    expect(prompt).toContain('"changedPaths":["src/auth.ts"]');
    expect(prompt).toContain('"commitRange":{"from":"same-head","to":"same-head"}');
    expect(prompt).not.toContain('"id":"d0"');
  });
});

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
    const encoded = JSON.stringify(schema);
    expect(encoded).toContain('"document"');
    expect(encoded).toContain('"introMarkdown"');
    expect(encoded).toContain('"structured"');
    // Memoized — the same object every call.
    expect(boardOutputSchema()).toBe(schema);
  });
});

describe("reconcileFlaggedBoards — the Flagged dual seat merge (J1/J2)", () => {
  const labels = { a: "Claude", b: "Codex" };

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

  it("treats a deterministically empty Design artifact set as a successful absent lane", async () => {
    const captures: { model?: string; prompt?: string }[] = [];
    const applied: Applied[] = [];
    const arrivals: BoardArrivalEvent[] = [];
    const timeline: string[] = [];

    const result = await runLensPipeline({
      claudePort: fakeClaudePort(captures, (prompt) => {
        const lens = lensFromPrompt(prompt);
        if (lens !== "post-process") timeline.push(`draft:${lens}`);
        return cleanBody(lens);
      }),
      codexExecutor: null,
      repoRoot: "/pr-worktree",
      deltaPacket: PACKET,
      hunks: [],
      lintContextFor,
      designArtifacts: null,
      readPrompt,
      whiteboard: fakeWhiteboard(applied),
      boardIdFor: (lens) => `board:${lens}`,
      onBoardArrival: (event) => arrivals.push(event),
      onLensAbsence: (lens) => {
        timeline.push(`absent:${lens}`);
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
    expect(timeline.indexOf("absent:design")).toBeLessThan(timeline.indexOf("draft:sequence"));
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

  it("keeps Design title, source navigation, stats, and verbatim scenarios across post-process", async () => {
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

  it("keeps source-backed typed roots in source order when the editor reverses them", async () => {
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

  it("drops typed elements invented by the Design editor while keeping connective prose", async () => {
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

    const design = result.boards.find(({ lens }) => lens === "design");
    expect(design?.board?.elements.some(({ id }) => id === "editor-forged-decision")).toBe(false);
    expect(
      design?.board?.elements.find(({ id }) => id === "drafter-structure")?.data,
    ).toMatchObject({
      title: "Implementation context",
      children: [],
    });
    expect(
      design?.board?.elements.find(({ id }) => id === "editor-connective-prose")?.data,
    ).toMatchObject({
      markdown: "The implementation follows the source-defined refresh sequence.",
    });
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
    const report = mkBoard([
      {
        id: "outcome-2",
        kind: "round_outcome",
        data: {
          author: { kind: "lens-agent", id: "report-seat" },
          status: "addressed",
          ask: { ref: "ask-2", text: "Second ask" },
          note: "The retry boundary now owns the refresh.",
        },
      } as DraftBoard["elements"][number],
    ]);

    const result = await runLensPipeline({
      claudePort: fakeClaudePort([], (prompt) => {
        const lens = lensFromPrompt(prompt);
        if (lens === "post-process") {
          const context = /rennet:layer context>>>\n(\{.*)/s.exec(prompt);
          return context ? (JSON.parse(context[1] as string).board as unknown) : { elements: [] };
        }
        if (lens === "report") return report;
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
          diff: "WORKER_ONLY_DIFF",
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

  it("uses one live disposition snapshot for Flagged composition and persistence", async () => {
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
    expect(flagged?.board?.elements.some((element) => element.id === "new-finding")).toBe(true);
    expect(flagged?.board?.elements.some((element) => element.id === "orphan-finding")).toBe(true);
    const flaggedSection = flagged?.board?.elements.find((element) => element.id === "new-section");
    expect(flaggedSection?.kind === "section" ? flaggedSection.data.children : []).toEqual([]);
    expect(flagged?.board?.document?.introMarkdown).toBe("No findings require attention.");
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
    expect(applied.map(({ boardId }) => boardId)).toEqual([
      "board:design",
      "board:sequence",
      "board:decisions",
      "board:noise",
    ]);
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
