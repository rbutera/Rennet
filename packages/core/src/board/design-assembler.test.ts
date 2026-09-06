import type { DraftBoard } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import type { OpenSpecChangeSource } from "../delta/openspec-change";
import { assembleDesignBoard } from "./design-assembler";
import {
  bmadSpecSourceToDesignSources,
  grillSpecSourceToDesignSources,
  kiroSpecSourceToDesignSources,
  openSpecChangeSourceToDesignSources,
  superpowersSpecSourceToDesignSources,
} from "./design-obligations";
import type { LintContext } from "./lint";

// The host-side counterpart of a real change on disk: a proposal with a `## Why`, a
// stated decision with a rationale, a two-group task list, and one added requirement
// with a scenario. This is the shape the Design seat would otherwise be asked to render.
const CHANGE: OpenSpecChangeSource = {
  name: "persist-sessions",
  proposalMd: [
    "## Why",
    "Sessions vanish on restart, so reviewers lose the thread they were mid-review on.",
    "",
    "## What Changes",
    "- Persist every open session to disk",
  ].join("\n"),
  designMd: [
    "## Decisions",
    "",
    "### Decision: Store sessions as JSONL",
    "**Append each session as one JSON line.** Chosen for crash-safe appends over rewriting one file.",
  ].join("\n"),
  tasksMd: [
    "## 1. Persistence",
    "- [x] Write the failing restart test",
    "- [ ] Implement the JSONL store",
    "",
    "## 2. Restore",
    "- [ ] Reload sessions on boot",
  ].join("\n"),
  specDeltas: [
    {
      capability: "session",
      md: [
        "## ADDED Requirements",
        "",
        "### Requirement: Persist sessions across restarts",
        "The system SHALL persist every open session so a restart restores them.",
        "",
        "#### Scenario: Restart recovery",
        "- **WHEN** the app restarts with three open sessions",
        "- **THEN** all three are restored from disk",
      ].join("\n"),
    },
  ],
};

// No regions, no files: the fixtures are citation-free, so only the prose/finish
// teeth are live — exactly the tiers the assembled board must clear.
const LINT: Omit<LintContext, "lens"> = { regions: [], files: new Map() };
const AUTHOR = { kind: "lens-agent", id: "design-seat" } as const;

const assemble = (change: OpenSpecChangeSource) =>
  assembleDesignBoard(openSpecChangeSourceToDesignSources(change), LINT, AUTHOR);

describe("assembleDesignBoard", () => {
  it("renders an OpenSpec change to a settled board with the change's own artifacts", () => {
    const board = assemble(CHANGE);
    expect(board).toBeDefined();
    if (board === undefined) throw new Error("unreachable");

    // The document carries the change name and the `## Why` prose verbatim.
    expect(board.document?.title).toBe("persist-sessions");
    expect(board.document?.introMarkdown).toContain("Sessions vanish on restart");
    expect(board.document?.stats).toEqual([
      { label: "Format", value: "OpenSpec" },
      { label: "Capabilities", value: "1" },
      { label: "Requirements", value: "1" },
      { label: "Tasks", value: "1/3" },
    ]);

    const requirement = board.elements.find((el) => el.kind === "requirement");
    const reqData = requirement?.data as { shall?: string; scenarios?: readonly string[] };
    expect(reqData.shall).toBe(
      "The system SHALL persist every open session so a restart restores them.",
    );
    // The scenario is TOP-LEVEL prose the requirement references (never a section child).
    const scenarioIds = reqData.scenarios ?? [];
    expect(scenarioIds).toHaveLength(1);
    const scenario = board.elements.find((el) => el.id === scenarioIds[0]);
    expect(scenario?.kind).toBe("prose");
    expect((scenario?.data as { markdown?: string } | undefined)?.markdown).toContain(
      "Restart recovery",
    );

    const decision = board.elements.find((el) => el.kind === "decision");
    const decData = decision?.data as { statement?: string; inferred?: boolean };
    expect(decData.statement).toBe("Store sessions as JSONL");
    expect(decData.inferred).toBe(false);

    // The checklist ships each source line verbatim — a task line is ALREADY `- [x] …`, so
    // it must not be re-wrapped into `- [x] - [x] …`. The Tasks stat ("1/3") could not see
    // this; only reading the rendered prose does.
    const taskProse = board.elements.find(
      (el) =>
        el.kind === "prose" &&
        ((el.data as { markdown?: string }).markdown ?? "").includes(
          "Write the failing restart test",
        ),
    );
    const taskMarkdown = (taskProse?.data as { markdown?: string } | undefined)?.markdown ?? "";
    expect(taskMarkdown).toContain("- [x] Write the failing restart test");
    expect(taskMarkdown).not.toContain("- [x] - [x]");
  });

  it("declines the fast path when a spec-delta renames a requirement, leaving it to the seat", () => {
    // OpenSpec RENAMED sections are FROM/TO list pairs the parser yields no obligation for.
    // Rendering here would drop the rename and undercount the Requirements stat, so the whole
    // change routes to the seat, which reads the rename pair directly.
    const withRename: OpenSpecChangeSource = {
      ...CHANGE,
      specDeltas: [
        ...(CHANGE.specDeltas ?? []),
        {
          capability: "session",
          md: [
            "## RENAMED Requirements",
            "",
            "- FROM: `### Requirement: Persist sessions`",
            "- TO: `### Requirement: Persist open sessions`",
          ].join("\n"),
        },
      ],
    };
    expect(assemble(withRename)).toBeUndefined();
  });

  it("returns undefined when there is nothing to render", () => {
    expect(assembleDesignBoard([], LINT, AUTHOR)).toBeUndefined();
    // A bare change name with no artifacts yields no obligations, so no board.
    expect(assemble({ name: "empty" })).toBeUndefined();
  });

  // #877 — the change from the live drive in miniature: a `## Decisions` paragraph whose
  // subject IS the pipeline, which is what an OpenSpec change in this repository normally
  // is. Before the register, `add_decision` refused it on `process-vocabulary` and the
  // board — free, already built — was thrown away for an 882.9 s model seat.
  //
  // The assertion is on the rendered TEXT, not on "it did not throw": the fix would also
  // be satisfied by an assembler that dropped the offending decision, and that would be a
  // board that quietly omits a decision the author stated.
  it("renders a decision whose subject is the pipeline, because it is QUOTING the author", () => {
    const aboutTheMachinery: OpenSpecChangeSource = {
      ...CHANGE,
      designMd: [
        "## Decisions",
        "",
        "### Decision: The Design lens drafts from the spec",
        "**The Design lens drafts from the spec.** Chosen because the seat reads the artifact.",
      ].join("\n"),
    };
    const board = assemble(aboutTheMachinery);
    expect(board).toBeDefined();
    const statements = (board?.elements ?? [])
      .filter((element) => element.kind === "decision")
      .map((element) => (element.data as { statement?: string }).statement);
    expect(statements).toEqual(["The Design lens drafts from the spec"]);
  });

  // The other half, and the one that keeps `transcribed` from meaning "lint off": the
  // register drops the VOICE screens and nothing else. A citation the reader cannot
  // resolve is still a broken board, whoever wrote the sentence, so it still throws — and
  // it throws naming `citation-well-formed`, not some generic mapping error.
  it("still refuses quoted prose that carries a citation a reader cannot resolve", () => {
    const badCitation: OpenSpecChangeSource = {
      ...CHANGE,
      proposalMd: ["## Why", "The restart path is wrong; see app.tsx:551."].join("\n"),
    };
    expect(() => assemble(badCitation)).toThrow(/citation-well-formed/);
  });

  // POSITIVE CONTROL: the assembled board goes through the SAME lint every seat board
  // does. A `## Why` carrying a fenced code block is `no-code-bytes` in the document
  // intro, so a real check must redden — and it must redden for THAT rule, not a
  // generic throw. If the assembler ever stopped feeding the board through lint, this
  // greens falsely, which is the whole point of asserting the rule id.
  it("refuses a board whose prose trips lint, naming the offending rule", () => {
    const withFence: OpenSpecChangeSource = {
      ...CHANGE,
      proposalMd: ["## Why", "Here is the offending block:", "```", "rm -rf /", "```"].join("\n"),
    };
    expect(() => assemble(withFence)).toThrow(/no-code-bytes/);
  });
});

// The four other formats the obligation parser reads. Each fixture is the smallest
// document set that yields every obligation kind the format produces, so the assertion
// is on what LANDED on the board — the source's own text under the source's own file —
// and not on "it did not throw".
const sectionsOf = (board: DraftBoard): string[] =>
  board.elements
    .filter((el) => el.kind === "section")
    .map((el) => (el.data as { title?: string }).title ?? "");
const proseOf = (board: DraftBoard): string[] =>
  board.elements
    .filter((el) => el.kind === "prose")
    .map((el) => (el.data as { markdown?: string }).markdown ?? "");

const TECH_STACK_SHARD = [
  "# Tech Stack",
  "",
  "## Tech Stack",
  "",
  "| Category | Technology | Rationale |",
  "| --- | --- | --- |",
  "| Language | TypeScript 5.6 | One language across the stack |",
].join("\n");

describe("assembleDesignBoard on the other formats", () => {
  it("renders a Kiro feature: EARS requirements, a bug fix's sections, and numbered tasks", () => {
    const board = assembleDesignBoard(
      kiroSpecSourceToDesignSources({
        feature: "session-restore",
        requirementsMd: [
          "# Requirements Document",
          "",
          "## Introduction",
          "Reviewers lose their place when the app restarts.",
          "",
          "### Requirement 1",
          "",
          "**User Story:** As a reviewer, I want sessions to survive restarts.",
          "",
          "#### Acceptance Criteria",
          "",
          "1. WHEN the application restarts THEN the system SHALL restore the session",
        ].join("\n"),
        tasksMd: [
          "# Implementation Plan",
          "",
          "- [x] 1. Build the session store",
          "- [ ] 1.1 Add persistence",
          "  - _Requirements: 1.1_",
        ].join("\n"),
        bugfixMd: [
          "# Session restart bugfix",
          "",
          "## Current Behavior",
          "A restart drops the active session.",
          "",
          "## Expected Behavior",
          "A restart restores the active session.",
        ].join("\n"),
      }),
      LINT,
      AUTHOR,
    );
    expect(board).toBeDefined();
    if (board === undefined) throw new Error("unreachable");

    expect(board.document?.title).toBe("session-restore");
    // The `## Introduction` prose is the document's own opening, verbatim.
    expect(board.document?.introMarkdown).toBe("Reviewers lose their place when the app restarts.");
    expect(board.document?.stats).toEqual([
      { label: "Format", value: "Kiro" },
      { label: "Capabilities", value: "1" },
      { label: "Requirements", value: "1" },
      { label: "Tasks", value: "1/2" },
    ]);
    expect(board.document?.sources?.map((source) => source.path)).toEqual([
      ".kiro/specs/session-restore/requirements.md",
      ".kiro/specs/session-restore/tasks.md",
      ".kiro/specs/session-restore/bugfix.md",
    ]);
    expect(sectionsOf(board)).toEqual([
      "Requirements",
      "Tasks",
      "1. Build the session store",
      "Bug Fix",
      "Current Behavior",
      "Expected Behavior",
    ]);

    const requirement = board.elements.find((el) => el.kind === "requirement");
    const reqData = requirement?.data as { shall?: string; scenarios?: readonly string[] };
    expect(reqData.shall).toBe(
      "**User Story:** As a reviewer, I want sessions to survive restarts.",
    );
    // The acceptance criterion is the requirement's scenario, split into its EARS halves.
    const scenario = board.elements.find((el) => el.id === reqData.scenarios?.[0]);
    expect(scenario?.data).toMatchObject({
      scenario_clauses: {
        condition: "the application restarts",
        response: "the system SHALL restore the session",
      },
    });
    expect(proseOf(board)).toContain("A restart drops the active session.");

    // The host-derived projections (#898): the task carries its refs, its group its
    // state, and the source section its layout — stamped after settle, never authored.
    const taskProse = board.elements.find(
      (el) => (el.data as { markdown?: string }).markdown === "- [ ] 1.1 Add persistence",
    );
    expect(taskProse?.data).toMatchObject({ requirement_refs: ["1.1"] });
    const [tasksSection, groupSection] = board.elements.filter(
      (el) =>
        el.kind === "section" &&
        /Tasks|Build the session store/.test(String((el.data as { title?: string }).title)),
    );
    expect(tasksSection?.data).toMatchObject({
      task_progress: { kind: "source", format: "kiro", role: "tasks", layout: "grouped" },
    });
    expect(groupSection?.data).toMatchObject({
      task_progress: { kind: "group", state: "incomplete" },
    });
  });

  it("renders a BMAD specification: PRD registry, story acceptance, tasks, and a tech-stack choice", () => {
    const board = assembleDesignBoard(
      bmadSpecSourceToDesignSources({
        name: "1.1",
        prdMd: [
          "# PRD",
          "",
          "## Requirements",
          "",
          "### Functional",
          "",
          "1. FR1: The application restores the last session.",
          "",
          "## Technical Assumptions",
          "- **Repository Structure:** Monorepo",
        ].join("\n"),
        prdPath: "docs/prd.md",
        // A sharded architecture: the reader concatenates the shards into `architectureMd`
        // for the parser, and names each shard so a board can cite the file with the line.
        architectureMd: TECH_STACK_SHARD,
        architectureShards: [{ path: "docs/architecture/tech-stack.md", md: TECH_STACK_SHARD }],
        epics: [],
        stories: [
          {
            path: "docs/stories/1.1.restore-session.md",
            md: [
              "# Story 1.1",
              "",
              "## Status",
              "",
              "Draft",
              "",
              "## Story",
              "",
              "**As a** reviewer, **I want** my session restored, **so that** I can resume work.",
              "",
              "## Acceptance Criteria",
              "",
              "1. The last open review is restored.",
              "",
              "## Tasks / Subtasks",
              "",
              "- [x] Task 1 (AC: 1)",
              "- [ ] Task 2 (AC: 1)",
            ].join("\n"),
          },
        ],
      }),
      LINT,
      AUTHOR,
    );
    expect(board).toBeDefined();
    if (board === undefined) throw new Error("unreachable");

    expect(board.document?.title).toBe("1.1");
    expect(board.document?.introMarkdown).toBe("BMAD specification 1.1.");
    expect(board.document?.stats?.[0]).toEqual({ label: "Format", value: "BMAD" });
    // The PRD cites the path the reader resolved; a sharded architecture is skipped
    // rather than cited at a concatenation that has no line numbers of its own.
    expect(board.document?.sources?.map((source) => source.path)).toEqual([
      "docs/prd.md",
      "docs/architecture/tech-stack.md",
      "docs/stories/1.1.restore-session.md",
    ]);
    // A story's `Task N` lines are groups (their subtasks are the members), so each is
    // its own nested section.
    expect(sectionsOf(board)).toEqual([
      "PRD",
      "tech-stack",
      "1.1.restore-session",
      "Task 1 (AC: 1)",
      "Task 2 (AC: 1)",
    ]);
    const requirements = board.elements.filter((el) => el.kind === "requirement");
    expect(requirements.map((el) => (el.data as { shall?: string }).shall)).toEqual([
      // The parser lifts the `FR1:` label off the registry row and carries it as `name`.
      "The application restores the last session.",
      "**As a** reviewer, **I want** my session restored, **so that** I can resume work.",
    ]);
    // The tech-stack row states its rationale, so it lands as a decision. The Technical
    // Assumption states none, and the assembler never invents a `why`, so it does not.
    const decisions = board.elements.filter((el) => el.kind === "decision");
    expect(decisions.map((el) => el.data)).toEqual([
      expect.objectContaining({
        statement: "Language · TypeScript 5.6",
        why: "One language across the stack",
        source: { path: "docs/architecture/tech-stack.md", line: 7 },
        source_cells: ["Language", "TypeScript 5.6", "One language across the stack"],
      }),
    ]);
    // The story's status and each task's acceptance criteria ride on their owners.
    expect(requirements[1]?.data).toMatchObject({ status: "Draft" });
    const storyTask = board.elements.find(
      (el) => (el.data as { markdown?: string }).markdown === "- [x] Task 1 (AC: 1)",
    );
    expect(storyTask?.data).toMatchObject({ acceptance_criteria: ["1"] });
  });

  it("renders a Superpowers feature: the spec's decisions, the plan's task groups, the ledger's rows", () => {
    const board = assembleDesignBoard(
      superpowersSpecSourceToDesignSources({
        name: "session",
        specs: [
          {
            path: "docs/superpowers/specs/session.md",
            md: [
              "# Session design",
              "",
              "## Decisions",
              "",
              "### Keep session state local",
              "It preserves atomic writes and offline recovery.",
            ].join("\n"),
          },
        ],
        plans: [
          {
            path: "docs/superpowers/plans/2026-08-29-session.md",
            md: [
              "# Session Implementation Plan",
              "",
              "**Spec:** docs/superpowers/specs/session.md",
              "",
              "### Task 1: Store sessions",
              "",
              "**Files:**",
              "- Create: packages/core/src/session-store.ts",
              "- Test: packages/core/src/session-store.test.ts",
              "",
              "- [x] **Step 1: Write the failing test**",
              "- [ ] **Step 2: Implement storage**",
              "",
              "### Task 2: Restore sessions",
              "",
              "- [ ] **Step 1: Add restart coverage**",
            ].join("\n"),
          },
        ],
        progress: [
          {
            path: ".superpowers/sdd/session/progress.md",
            md: [
              "# SDD ledger — plan: docs/superpowers/plans/2026-08-29-session.md",
              "Task 1: complete (all steps green)",
            ].join("\n"),
          },
        ],
      }),
      LINT,
      AUTHOR,
    );
    expect(board).toBeDefined();
    if (board === undefined) throw new Error("unreachable");

    expect(board.document?.title).toBe("session");
    expect(board.document?.stats).toEqual([
      { label: "Format", value: "Superpowers" },
      { label: "Capabilities", value: "0" },
      { label: "Requirements", value: "0" },
      // A plan's progress is per GROUP, and the ledger marks Task 1 complete.
      { label: "Tasks", value: "1/2" },
    ]);
    expect(sectionsOf(board)).toEqual([
      "Spec",
      "Plan",
      "Task 1: Store sessions",
      "Task 2: Restore sessions",
      "Progress",
    ]);
    const decision = board.elements.find((el) => el.kind === "decision");
    expect(decision?.data).toMatchObject({
      statement: "Keep session state local",
      why: "It preserves atomic writes and offline recovery.",
      inferred: false,
    });
    expect(proseOf(board)).toContain("Task 1: complete (all steps green)");

    // The plan's groups carry the ledger's verdict and the first task's manifest.
    const groups = board.elements.filter(
      (el) =>
        el.kind === "section" && /^Task \d/.test(String((el.data as { title?: string }).title)),
    );
    expect(groups.map((el) => (el.data as { task_progress?: unknown }).task_progress)).toEqual([
      { kind: "group", state: "complete" },
      { kind: "group", state: "incomplete" },
    ]);
    expect(groups[0]?.data).toMatchObject({
      task_manifest: {
        files: [
          { operation: "create", value: "packages/core/src/session-store.ts" },
          { operation: "test", value: "packages/core/src/session-store.test.ts" },
        ],
        interfaces: [],
        verifications: [],
      },
    });
  });

  it("renders grill-with-docs: an ADR's decision and a glossary's terms, titled by the ADR's stem", () => {
    const board = assembleDesignBoard(
      grillSpecSourceToDesignSources({
        adrs: [
          {
            path: "docs/adr/0003-keep-an-event-store.md",
            md: "# Keep an event store\n\nIt preserves review history.\n",
          },
        ],
        contextDocs: [
          {
            path: "CONTEXT.md",
            md: [
              "# Ordering",
              "",
              "## Language",
              "",
              "- **Invoice**: A request for payment sent after delivery.",
              "  _Avoid_: Bill, payment request",
            ].join("\n"),
          },
        ],
      }),
      LINT,
      AUTHOR,
    );
    expect(board).toBeDefined();
    if (board === undefined) throw new Error("unreachable");

    expect(board.document?.title).toBe("0003-keep-an-event-store");
    expect(board.document?.stats?.[0]).toEqual({ label: "Format", value: "grill-with-docs" });
    expect(sectionsOf(board)).toEqual(["0003-keep-an-event-store", "Context"]);
    const decision = board.elements.find((el) => el.kind === "decision");
    expect(decision?.data).toMatchObject({
      statement: "Keep an event store",
      why: "It preserves review history.",
    });
    // A glossary entry is its source lines through the `_Avoid_` line, on one line.
    const entry = board.elements.find((el) =>
      String((el.data as { markdown?: string }).markdown).startsWith("- **Invoice**:"),
    );
    expect(entry?.data).toMatchObject({
      glossary_term: {
        term: "Invoice",
        definition: "A request for payment sent after delivery.",
        avoid: ["Bill", "payment request"],
      },
    });
  });

  it("tells two sources of one role apart by their file stems", () => {
    const board = assembleDesignBoard(
      superpowersSpecSourceToDesignSources({
        name: "session",
        plans: [
          {
            path: "docs/superpowers/plans/2026-08-29-store.md",
            md: ["### Task 1: Store", "- [ ] **Step 1: Execute**"].join("\n"),
          },
          {
            path: "docs/superpowers/plans/2026-08-30-restore.md",
            md: ["### Task 1: Restore", "- [ ] **Step 1: Execute**"].join("\n"),
          },
        ],
      }),
      LINT,
      AUTHOR,
    );
    expect(board).toBeDefined();
    if (board === undefined) throw new Error("unreachable");
    expect(sectionsOf(board).filter((title) => title.startsWith("Plan"))).toEqual([
      "Plan: 2026-08-29-store",
      "Plan: 2026-08-30-restore",
    ]);
  });

  it("declines a set that mixes formats: one specification, never a merge of several", () => {
    const mixed = [
      ...openSpecChangeSourceToDesignSources(CHANGE),
      ...kiroSpecSourceToDesignSources({
        feature: "other",
        tasksMd: "- [ ] 1. Do the thing",
      }),
    ];
    expect(assembleDesignBoard(mixed, LINT, AUTHOR)).toBeUndefined();
  });
});
