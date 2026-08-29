import { describe, expect, it } from "vitest";
import {
  type DesignSource,
  type DesignSourceObligation,
  deriveDesignTaskProgress,
  parseDesignSourceObligations,
  parseSuperpowersProgressLedger,
} from "./design-obligations";

function parseAll(sources: readonly DesignSource[]): DesignSourceObligation[] {
  return sources.flatMap(parseDesignSourceObligations);
}

describe("parseDesignSourceObligations", () => {
  it("derives ordinary item progress and candidate-bound Superpowers group progress", () => {
    const planPath = "docs/superpowers/plans/2026-08-29-session.md";
    const plan = {
      candidate: "session",
      format: "superpowers" as const,
      role: "plan",
      path: planPath,
      text: [
        "### Task 1: Persist sessions",
        "- [x] Write the failing test",
        "- [ ] Implement persistence",
        "### Task 2: Restore sessions",
        "- [ ] Prove restart recovery",
      ].join("\n"),
    };
    const progress = {
      candidate: "session",
      format: "superpowers" as const,
      role: "progress",
      path: ".superpowers/sdd/session/progress.md",
      text: [
        `# SDD ledger — plan: ${planPath}`,
        "Task 1: complete (commits abc1234..def5678, review clean)",
      ].join("\n"),
    };
    const ordinary = {
      candidate: "ordinary",
      format: "openspec" as const,
      role: "tasks",
      path: "openspec/changes/session/tasks.md",
      text: ["## 1. Delivery", "- [x] Persist", "- [ ] Restore"].join("\n"),
    };

    const withoutLedger = deriveDesignTaskProgress([plan]);
    expect(withoutLedger).toMatchObject({ done: 0, total: 2 });
    expect(withoutLedger.sources[0]?.groups.map(({ id, complete }) => ({ id, complete }))).toEqual([
      { id: "1", complete: false },
      { id: "2", complete: false },
    ]);

    expect(deriveDesignTaskProgress([plan, progress, ordinary])).toMatchObject({
      done: 2,
      total: 4,
      sources: [
        { done: 1, total: 2 },
        { done: 1, total: 2 },
      ],
    });
    expect(
      deriveDesignTaskProgress([plan, { ...progress, candidate: "another-session" }]),
    ).toMatchObject({ done: 0, total: 2 });
    expect(
      deriveDesignTaskProgress([
        plan,
        { ...progress, text: progress.text.replace(planPath, `${planPath}.other`) },
      ]),
    ).toMatchObject({ done: 0, total: 2 });
  });

  it("carries exact task group titles across supported task formats", () => {
    const groups = [
      parseDesignSourceObligations({
        format: "openspec",
        role: "tasks",
        path: "openspec/changes/session/tasks.md",
        text: "## 1. Delivery\n- [ ] Persist the session",
      }),
      parseDesignSourceObligations({
        format: "kiro",
        role: "tasks",
        path: ".kiro/specs/session/tasks.md",
        text: "- [ ] 1. Build persistence\n  - [ ] 1.1 Add the store",
      }),
      parseDesignSourceObligations({
        format: "bmad",
        role: "story",
        path: "planning/stories/1.1.session.md",
        text: "## Tasks / Subtasks\n- [ ] Task 1 (AC: 1)\n  - [ ] Add the store",
      }),
      parseDesignSourceObligations({
        format: "superpowers",
        role: "plan",
        path: "docs/superpowers/plans/2026-08-29-session.md",
        text: "### Task 1: Persist sessions\n- [ ] Write the failing test",
      }),
    ].map((obligations) =>
      obligations
        .filter((obligation) => obligation.kind === "task")
        .map(({ parentKey, groupTitle }) => ({ parentKey, groupTitle })),
    );

    expect(groups).toEqual([
      [
        {
          parentKey: "openspec/changes/session/tasks.md#task-group:1",
          groupTitle: "1. Delivery",
        },
      ],
      [
        {
          parentKey: ".kiro/specs/session/tasks.md#task-group:1",
          groupTitle: "1. Build persistence",
        },
        {
          parentKey: ".kiro/specs/session/tasks.md#task-group:1",
          groupTitle: "1. Build persistence",
        },
      ],
      [
        {
          parentKey: "planning/stories/1.1.session.md#task-group:1",
          groupTitle: "Task 1 (AC: 1)",
        },
        {
          parentKey: "planning/stories/1.1.session.md#task-group:1",
          groupTitle: "Task 1 (AC: 1)",
        },
      ],
      [
        {
          parentKey: "docs/superpowers/plans/2026-08-29-session.md#task-group:1",
          groupTitle: "Task 1: Persist sessions",
        },
      ],
    ]);
  });

  it("parses the OpenSpec requirement, scenario, task, and decision anchors", () => {
    const specPath = "openspec/changes/session/specs/session/spec.md";
    const tasksPath = "openspec/changes/session/tasks.md";
    const designPath = "openspec/changes/session/design.md";

    expect(
      parseAll([
        {
          role: "spec-delta",
          path: specPath,
          text: [
            "## ADDED Requirements",
            "",
            "### Requirement: Preserve the session",
            "The system SHALL preserve the session.",
            "",
            "A restart SHALL NOT discard it.",
            "",
            "#### Scenario: Reopen the application",
            "- **WHEN** the application restarts",
            "- **THEN** restore the session",
          ].join("\n"),
        },
        {
          role: "tasks",
          path: tasksPath,
          text: [
            "# Tasks",
            "",
            "## 1. Persistence",
            "- [x] 1.1 Store the session",
            "- [ ] 1.2 Restore the session",
          ].join("\n"),
        },
        {
          role: "design",
          path: designPath,
          text: [
            "# Design",
            "",
            "## Decisions",
            "",
            "### Keep session state in the existing store",
            "The store already owns atomic writes.",
          ].join("\n"),
        },
      ]),
    ).toEqual([
      {
        kind: "requirement",
        key: `${specPath}#requirement:preserve-the-session`,
        parentKey: `${specPath}#requirements:added`,
        address: "requirement:preserve-the-session",
        text: "The system SHALL preserve the session. A restart SHALL NOT discard it.",
        line: 3,
        label: "Preserve the session",
        capability: "session",
        capabilityTitle: "Session",
        groupTitle: "ADDED Requirements",
      },
      {
        kind: "scenario",
        key: `${specPath}#requirement:preserve-the-session/scenario:reopen-the-application`,
        parentKey: `${specPath}#requirement:preserve-the-session`,
        address: "requirement:preserve-the-session/scenario:reopen-the-application",
        text: "Scenario: Reopen the application - **WHEN** the application restarts - **THEN** restore the session",
        line: 8,
        clauses: {
          condition: "the application restarts",
          response: "restore the session",
        },
      },
      {
        kind: "task",
        key: `${tasksPath}#task-group:1/task:1.1`,
        parentKey: `${tasksPath}#task-group:1`,
        address: "task-group:1/task:1.1",
        text: "- [x] 1.1 Store the session",
        line: 4,
        done: true,
        groupTitle: "1. Persistence",
      },
      {
        kind: "task",
        key: `${tasksPath}#task-group:1/task:1.2`,
        parentKey: `${tasksPath}#task-group:1`,
        address: "task-group:1/task:1.2",
        text: "- [ ] 1.2 Restore the session",
        line: 5,
        done: false,
        groupTitle: "1. Persistence",
      },
      {
        kind: "decision",
        key: `${designPath}#decisions/decision:keep-session-state-in-the-existing-store`,
        parentKey: `${designPath}#decisions`,
        address: "decisions/decision:keep-session-state-in-the-existing-store",
        text: "Keep session state in the existing store",
        line: 5,
        rationale: "The store already owns atomic writes.",
        alternatives: [],
        evidence: [],
      },
    ]);
  });

  it("preserves mixed OpenSpec delta operations in source order for one capability", () => {
    const path = "openspec/changes/session/specs/session/spec.md";

    expect(
      parseDesignSourceObligations({
        format: "openspec",
        role: "spec-delta",
        path,
        text: [
          "## MODIFIED Requirements",
          "",
          "### Requirement: Retain the refreshed session",
          "The daemon SHALL retain the refreshed session.",
          "",
          "## ADDED Requirements",
          "",
          "### Requirement: Report recovery",
          "The daemon SHALL report session recovery.",
        ].join("\n"),
      })
        .filter((obligation) => obligation.kind === "requirement")
        .map(({ address, parentKey, text, line, capability, capabilityTitle, groupTitle }) => ({
          address,
          parentKey,
          text,
          line,
          capability,
          capabilityTitle,
          groupTitle,
        })),
    ).toEqual([
      {
        address: "requirement:retain-the-refreshed-session",
        parentKey: `${path}#requirements:modified`,
        text: "The daemon SHALL retain the refreshed session.",
        line: 3,
        capability: "session",
        capabilityTitle: "Session",
        groupTitle: "MODIFIED Requirements",
      },
      {
        address: "requirement:report-recovery",
        parentKey: `${path}#requirements:added`,
        text: "The daemon SHALL report session recovery.",
        line: 8,
        capability: "session",
        capabilityTitle: "Session",
        groupTitle: "ADDED Requirements",
      },
    ]);
  });

  it.each([
    ["openspec", "design", "openspec/changes/session/design.md"],
    ["kiro", "design", ".kiro/specs/session/design.md"],
    ["bmad", "architecture", "docs/architecture.md"],
  ] as const)(
    "preserves %s stated-decision why, alternatives, and evidence",
    (format, role, path) => {
      expect(
        parseDesignSourceObligations({
          format,
          role,
          path,
          text: [
            "## Decisions",
            "",
            "### Keep event state in the existing store",
            "",
            "#### Why",
            "The store already owns atomic writes.",
            "",
            "#### Alternatives not taken",
            "- Write a second store.",
            "- Keep state in memory only.",
            "",
            "#### Evidence",
            "- src/store.ts:12-14",
          ].join("\n"),
        }),
      ).toEqual([
        {
          kind: "decision",
          key: `${path}#decisions/decision:keep-event-state-in-the-existing-store`,
          parentKey: `${path}#decisions`,
          address: "decisions/decision:keep-event-state-in-the-existing-store",
          text: "Keep event state in the existing store",
          line: 3,
          rationale: "The store already owns atomic writes.",
          alternatives: ["Write a second store.", "Keep state in memory only."],
          evidence: [{ path: "src/store.ts", startLine: 12, endLine: 14 }],
        },
      ]);
    },
  );

  it("keeps OpenSpec paragraph decisions split into exact statement and rationale", () => {
    const path = "openspec/changes/session/design.md";

    expect(
      parseDesignSourceObligations({
        format: "openspec",
        role: "design",
        path,
        text: "## Decisions\n\n**Use SQLite.** It keeps writes local.",
      }),
    ).toEqual([
      {
        kind: "decision",
        key: `${path}#decisions/decision:use-sqlite`,
        parentKey: `${path}#decisions`,
        address: "decisions/decision:use-sqlite",
        text: "Use SQLite.",
        line: 3,
        rationale: "It keeps writes local.",
      },
    ]);
  });

  it("extracts only an explicit choice marker inside Kiro Architecture", () => {
    const path = ".kiro/specs/session/design.md";
    const decisions = parseDesignSourceObligations({
      format: "kiro",
      role: "design",
      path,
      text: [
        "## Architecture",
        "Ordinary architecture prose is not itself a decision.",
        "",
        "### Decision: Keep event state in the existing store",
        "",
        "#### Why",
        "The store already owns atomic writes.",
        "",
        "#### Alternatives",
        "- Write a second store.",
        "",
        "#### Evidence",
        "- src/store.ts:12-14",
      ].join("\n"),
    });

    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      kind: "decision",
      text: "Keep event state in the existing store",
      line: 4,
      rationale: "The store already owns atomic writes.",
      alternatives: ["Write a second store."],
      evidence: [{ path: "src/store.ts", startLine: 12, endLine: 14 }],
    });
  });

  it("preserves BMAD Technical Assumptions and definitive Tech Stack rows as choices", () => {
    expect(
      parseDesignSourceObligations({
        format: "bmad",
        role: "prd",
        path: "docs/prd.md",
        text: [
          "## Technical Assumptions",
          "- **Repository Structure:** Monorepo",
          "- **Service Architecture:** Modular monolith",
          "- **Testing Requirements:** Unit and integration tests",
        ].join("\n"),
      }).map(({ text }) => text),
    ).toEqual([
      "Repository Structure: Monorepo",
      "Service Architecture: Modular monolith",
      "Testing Requirements: Unit and integration tests",
    ]);

    expect(
      parseDesignSourceObligations({
        format: "bmad",
        role: "architecture",
        path: "docs/architecture.md",
        text: [
          "## Tech Stack",
          "| Category | Technology | Version | Rationale |",
          "| --- | --- | --- | --- |",
          "| Language | TypeScript | 5.6 | Shared types |",
        ].join("\n"),
      }),
    ).toEqual([
      expect.objectContaining({
        text: "Language · TypeScript · 5.6",
        rationale: "Shared types",
        sourceCells: ["Language", "TypeScript", "5.6", "Shared types"],
      }),
    ]);
  });

  it.each([
    ["kiro", "design", ".kiro/specs/session/design.md", "Architecture"],
    ["bmad", "architecture", "docs/architecture.md", "High Level Architecture"],
    ["superpowers", "design", "docs/superpowers/specs/session.md", "Architecture"],
  ] as const)("does not promote ordinary %s architecture prose", (format, role, path, section) => {
    expect(
      parseDesignSourceObligations({
        format,
        role,
        path,
        text: `## ${section}\n\nKeep event state in the existing store.`,
      }),
    ).toEqual([]);
  });

  it("keeps the Superpowers plan Architecture field as one exact stated choice", () => {
    const path = "docs/superpowers/plans/2026-08-29-session.md";
    expect(
      parseDesignSourceObligations({
        format: "superpowers",
        role: "plan",
        path,
        text: "**Architecture:** Keep event state in the existing store.",
      }),
    ).toEqual([
      expect.objectContaining({
        kind: "decision",
        text: "Keep event state in the existing store.",
        line: 1,
        sourceCells: ["Architecture", "Keep event state in the existing store."],
      }),
    ]);
  });

  it("keeps Superpowers Tech Stack as a choice without promoting Goal or Spec", () => {
    expect(
      parseDesignSourceObligations({
        format: "superpowers",
        role: "plan",
        path: "docs/superpowers/plans/2026-08-29-session.md",
        text: [
          "**Goal:** Restore sessions after restart.",
          "**Architecture:** Keep event state in the existing store.",
          "**Tech Stack:** TypeScript 5.6 and SQLite",
          "**Spec:** docs/superpowers/specs/session.md",
        ].join("\n"),
      }).filter((obligation) => obligation.kind === "decision"),
    ).toEqual([
      expect.objectContaining({
        text: "Keep event state in the existing store.",
        sourceCells: ["Architecture", "Keep event state in the existing store."],
      }),
      expect.objectContaining({
        text: "TypeScript 5.6 and SQLite",
        sourceCells: ["Tech Stack", "TypeScript 5.6 and SQLite"],
      }),
    ]);
  });

  it("does not promote a task-body Architecture example to a Superpowers plan choice", () => {
    expect(
      parseDesignSourceObligations({
        format: "superpowers",
        role: "plan",
        path: "docs/superpowers/plans/2026-08-29-session.md",
        text: [
          "### Task 1: Document metadata",
          "",
          "**Architecture:** This line is task-local example content.",
        ].join("\n"),
      }).filter((obligation) => obligation.kind === "decision"),
    ).toEqual([]);
  });

  it("parses Kiro EARS criteria beneath their numbered requirement and groups tasks", () => {
    const requirementsPath = ".kiro/specs/account/requirements.md";
    const tasksPath = ".kiro/specs/account/tasks.md";

    expect(
      parseAll([
        {
          role: "requirements",
          path: requirementsPath,
          text: [
            "# Requirements Document",
            "",
            "### Requirement 1",
            "",
            "**User Story:** As a reviewer, I want sessions to survive restarts.",
            "",
            "#### Acceptance Criteria",
            "",
            "1. WHEN the application restarts THEN the system SHALL restore the session",
            "2. IF the session is expired THEN the system SHALL show the sign-in screen",
          ].join("\n"),
        },
        {
          role: "tasks",
          path: tasksPath,
          text: [
            "# Implementation Plan",
            "",
            "- [x] 1. Build the session store",
            "- [ ] 1.1 Add persistence",
            "- [ ] 2. Build the restart path",
          ].join("\n"),
        },
      ]),
    ).toEqual([
      {
        kind: "requirement",
        key: `${requirementsPath}#requirement:1`,
        parentKey: `${requirementsPath}#requirements`,
        address: "requirement:1",
        text: "**User Story:** As a reviewer, I want sessions to survive restarts.",
        line: 3,
        label: "Requirement 1",
        capability: "account",
        capabilityTitle: "account",
      },
      {
        kind: "scenario",
        key: `${requirementsPath}#requirement:1/criterion:1.1`,
        parentKey: `${requirementsPath}#requirement:1`,
        address: "requirement:1/criterion:1.1",
        text: "WHEN the application restarts THEN the system SHALL restore the session",
        line: 9,
        clauses: {
          condition: "the application restarts",
          response: "the system SHALL restore the session",
        },
      },
      {
        kind: "scenario",
        key: `${requirementsPath}#requirement:1/criterion:1.2`,
        parentKey: `${requirementsPath}#requirement:1`,
        address: "requirement:1/criterion:1.2",
        text: "IF the session is expired THEN the system SHALL show the sign-in screen",
        line: 10,
        clauses: {
          condition: "the session is expired",
          response: "the system SHALL show the sign-in screen",
        },
      },
      {
        kind: "task",
        key: `${tasksPath}#task-group:1/task:1`,
        parentKey: `${tasksPath}#task-group:1`,
        address: "task-group:1/task:1",
        text: "- [x] 1. Build the session store",
        line: 3,
        done: true,
        groupTitle: "1. Build the session store",
      },
      {
        kind: "task",
        key: `${tasksPath}#task-group:1/task:1.1`,
        parentKey: `${tasksPath}#task-group:1`,
        address: "task-group:1/task:1.1",
        text: "- [ ] 1.1 Add persistence",
        line: 4,
        done: false,
        groupTitle: "1. Build the session store",
      },
      {
        kind: "task",
        key: `${tasksPath}#task-group:2/task:2`,
        parentKey: `${tasksPath}#task-group:2`,
        address: "task-group:2/task:2",
        text: "- [ ] 2. Build the restart path",
        line: 5,
        done: false,
        groupTitle: "2. Build the restart path",
      },
    ]);
  });

  it("splits Kiro EARS without a comma into exact condition and response clauses", () => {
    const path = ".kiro/specs/account/requirements.md";

    expect(
      parseDesignSourceObligations({
        format: "kiro",
        role: "requirements",
        path,
        text: [
          "### Requirement 2",
          "**User Story:** As a reviewer, I want deterministic recovery.",
          "#### Acceptance Criteria",
          "1. WHEN the application restarts THE SYSTEM SHALL restore the session",
        ].join("\n"),
      }).find((obligation) => obligation.kind === "scenario"),
    ).toMatchObject({
      text: "WHEN the application restarts THE SYSTEM SHALL restore the session",
      clauses: {
        condition: "the application restarts",
        response: "THE SYSTEM SHALL restore the session",
      },
    });
  });

  it("binds canonical Kiro requirement detail bullets to the immediately preceding task", () => {
    const path = ".kiro/specs/account/tasks.md";
    const tasks = parseDesignSourceObligations({
      format: "kiro",
      role: "tasks",
      path,
      text: [
        "# Implementation Plan",
        "",
        "- [ ] 1. Set up project structure and core interfaces",
        "  - Define module boundaries",
        "  - _Requirements: 1.1_",
        "- [ ] 1.1 Create core data model interfaces and types",
        "  - Encode validation rules",
        "  - _Requirements: 2.1, 3.3, 1.2_",
        "- [ ] 2. Wire persistence",
        "  - _Requirements: 2.4_",
      ].join("\n"),
    }).filter((obligation) => obligation.kind === "task");

    expect(tasks.map(({ text, requirementRefs }) => ({ text, requirementRefs }))).toEqual([
      {
        text: "- [ ] 1. Set up project structure and core interfaces",
        requirementRefs: ["1.1"],
      },
      {
        text: "- [ ] 1.1 Create core data model interfaces and types",
        requirementRefs: ["2.1", "3.3", "1.2"],
      },
      { text: "- [ ] 2. Wire persistence", requirementRefs: ["2.4"] },
    ]);
  });

  it("honours an explicit format when the role and path look like another format", () => {
    expect(
      parseDesignSourceObligations({
        format: "kiro",
        role: "spec-delta",
        path: "openspec/changes/account/requirements.md",
        text: [
          "### Requirement 7",
          "**User Story:** As a reviewer, I want an exact source card.",
          "#### Acceptance Criteria",
          "1. WHEN the source is parsed THEN the system SHALL use its declared format",
        ].join("\n"),
      }).map((obligation) => ({
        kind: obligation.kind,
        address: obligation.address,
        text: obligation.text,
        ...(obligation.kind === "scenario" && obligation.clauses !== undefined
          ? { clauses: obligation.clauses }
          : {}),
      })),
    ).toEqual([
      {
        kind: "requirement",
        address: "requirement:7",
        text: "**User Story:** As a reviewer, I want an exact source card.",
      },
      {
        kind: "scenario",
        address: "requirement:7/criterion:7.1",
        text: "WHEN the source is parsed THEN the system SHALL use its declared format",
        clauses: {
          condition: "the source is parsed",
          response: "the system SHALL use its declared format",
        },
      },
    ]);
  });

  it("parses Kiro bugfix behavior sections as exact source obligations", () => {
    const path = ".kiro/specs/session-fix/bugfix.md";

    expect(
      parseDesignSourceObligations({
        role: "bugfix",
        path,
        text: [
          "# Session restart bugfix",
          "",
          "## Current Behavior",
          "A restart drops the active session.",
          "",
          "## Expected Behavior",
          "A restart restores the active session.",
          "",
          "## Unchanged Behaviour",
          "Expired sessions still open sign-in.",
        ].join("\n"),
      }),
    ).toEqual([
      {
        kind: "source-section",
        section: "current",
        heading: "Current Behavior",
        key: `${path}#bugfix/current`,
        parentKey: `${path}#bugfix`,
        address: "bugfix/current",
        text: "A restart drops the active session.",
        line: 3,
      },
      {
        kind: "source-section",
        section: "expected",
        heading: "Expected Behavior",
        key: `${path}#bugfix/expected`,
        parentKey: `${path}#bugfix`,
        address: "bugfix/expected",
        text: "A restart restores the active session.",
        line: 6,
      },
      {
        kind: "source-section",
        section: "unchanged",
        heading: "Unchanged Behaviour",
        key: `${path}#bugfix/unchanged`,
        parentKey: `${path}#bugfix`,
        address: "bugfix/unchanged",
        text: "Expired sessions still open sign-in.",
        line: 9,
      },
    ]);
  });

  it("parses BMAD FR/NFR entries, story acceptance criteria, and task hierarchy", () => {
    const prdPath = "planning/prd.md";
    const storyPath = "planning/stories/1.1.session.md";

    expect(
      parseAll([
        {
          role: "prd",
          path: prdPath,
          text: [
            "# Product",
            "",
            "## Requirements",
            "",
            "1. FR1: The application restores the last session.",
            "2. NFR1: Session restoration completes within 500 ms.",
          ].join("\n"),
        },
        {
          role: "story",
          path: storyPath,
          text: [
            "# Story 1.1",
            "",
            "## Story",
            "",
            "**As a** reviewer, **I want** my session restored, **so that** I can resume work.",
            "",
            "## Acceptance Criteria",
            "",
            "1. The last open review is restored.",
            "2: An expired session opens sign-in.",
            "",
            "## Tasks / Subtasks",
            "",
            "- [x] Task 1 (AC: 1)",
            "  - [ ] Add storage adapter",
            "- [ ] Task 2 (AC: 2)",
          ].join("\n"),
        },
      ]),
    ).toEqual([
      {
        kind: "requirement",
        key: `${prdPath}#requirement:FR1`,
        parentKey: `${prdPath}#requirements:functional`,
        address: "requirement:FR1",
        text: "The application restores the last session.",
        line: 5,
        label: "FR1",
        capability: "functional",
        capabilityTitle: "Functional Requirements",
      },
      {
        kind: "requirement",
        key: `${prdPath}#requirement:NFR1`,
        parentKey: `${prdPath}#requirements:non-functional`,
        address: "requirement:NFR1",
        text: "Session restoration completes within 500 ms.",
        line: 6,
        label: "NFR1",
        capability: "non-functional",
        capabilityTitle: "Non Functional Requirements",
      },
      {
        kind: "requirement",
        key: `${storyPath}#story:1.1`,
        parentKey: `${storyPath}#stories/story:1.1`,
        address: "story:1.1",
        text: "**As a** reviewer, **I want** my session restored, **so that** I can resume work.",
        line: 3,
        label: "Story 1.1",
        capability: "story:1.1",
        capabilityTitle: "Story 1.1",
      },
      {
        kind: "scenario",
        key: `${storyPath}#story:1.1/acceptance:1`,
        parentKey: `${storyPath}#story:1.1`,
        address: "story:1.1/acceptance:1",
        text: "The last open review is restored.",
        line: 9,
      },
      {
        kind: "scenario",
        key: `${storyPath}#story:1.1/acceptance:2`,
        parentKey: `${storyPath}#story:1.1`,
        address: "story:1.1/acceptance:2",
        text: "An expired session opens sign-in.",
        line: 10,
      },
      {
        kind: "task",
        key: `${storyPath}#task-group:1/task:root`,
        parentKey: `${storyPath}#task-group:1`,
        address: "task-group:1/task:root",
        text: "- [x] Task 1 (AC: 1)",
        line: 14,
        done: true,
        groupTitle: "Task 1 (AC: 1)",
        acceptanceCriteria: ["1"],
      },
      {
        kind: "task",
        key: `${storyPath}#task-group:1/task:step-1`,
        parentKey: `${storyPath}#task-group:1`,
        address: "task-group:1/task:step-1",
        text: "- [ ] Add storage adapter",
        line: 15,
        done: false,
        groupTitle: "Task 1 (AC: 1)",
      },
      {
        kind: "task",
        key: `${storyPath}#task-group:2/task:root`,
        parentKey: `${storyPath}#task-group:2`,
        address: "task-group:2/task:root",
        text: "- [ ] Task 2 (AC: 2)",
        line: 16,
        done: false,
        groupTitle: "Task 2 (AC: 2)",
        acceptanceCriteria: ["2"],
      },
    ]);
  });

  it("bounds BMAD registry rows to exact Requirements groups", () => {
    const prdPath = "planning/prd.md";
    const requirements = parseDesignSourceObligations({
      format: "bmad",
      role: "prd",
      path: prdPath,
      text: [
        "# Product",
        "",
        "## Requirements",
        "",
        "### Functional",
        "1. FR1: The application restores the last session.",
        "",
        "### Non Functional",
        "1. NFR1: Session restoration completes within 500 ms.",
        "",
        "## Checklist Results Report",
        "FR1: verified above",
      ].join("\n"),
    }).filter((obligation) => obligation.kind === "requirement");

    expect(
      requirements.map(({ address, text, capability, capabilityTitle }) => ({
        address,
        text,
        capability,
        capabilityTitle,
      })),
    ).toEqual([
      {
        address: "requirement:FR1",
        text: "The application restores the last session.",
        capability: "functional",
        capabilityTitle: "Functional",
      },
      {
        address: "requirement:NFR1",
        text: "Session restoration completes within 500 ms.",
        capability: "non-functional",
        capabilityTitle: "Non Functional",
      },
    ]);

    expect(
      parseDesignSourceObligations({
        format: "bmad",
        role: "epic",
        path: "planning/epics/epic-1.md",
        text: "# Epic 1: Sessions\n\nFR1: referenced by this epic.",
      }).filter((obligation) => obligation.kind === "requirement"),
    ).toEqual([]);
  });

  it("bounds BMAD status to each story and preserves ordered task AC links", () => {
    const path = "planning/stories/session-stories.md";
    const obligations = parseDesignSourceObligations({
      format: "bmad",
      role: "story",
      path,
      text: [
        "# Story 1.1: Restore sessions",
        "",
        "## Status",
        "Draft",
        "",
        "## Story",
        "**As a** reviewer, **I want** sessions restored, **so that** I can resume work.",
        "",
        "## Tasks / Subtasks",
        "- [ ] Task 1 (AC: 3, 1)",
        "  - [ ] Persist the session (AC: 2)",
        "",
        "# Story 1.2: Handle expiry",
        "",
        "## Status",
        "Done",
        "",
        "## Story",
        "**As a** reviewer, **I want** expiry handled, **so that** sign-in stays honest.",
      ].join("\n"),
    });

    expect(
      obligations
        .filter((obligation) => obligation.kind === "requirement")
        .map(({ address, parentKey, label, capabilityTitle, status }) => ({
          address,
          parentKey,
          label,
          capabilityTitle,
          status,
        })),
    ).toEqual([
      {
        address: "story:1.1",
        parentKey: `${path}#stories/story:1.1`,
        label: "Story 1.1: Restore sessions",
        capabilityTitle: "Story 1.1: Restore sessions",
        status: "Draft",
      },
      {
        address: "story:1.2",
        parentKey: `${path}#stories/story:1.2`,
        label: "Story 1.2: Handle expiry",
        capabilityTitle: "Story 1.2: Handle expiry",
        status: "Done",
      },
    ]);
    expect(
      obligations
        .filter((obligation) => obligation.kind === "task")
        .map(({ text, acceptanceCriteria }) => ({ text, acceptanceCriteria })),
    ).toEqual([
      { text: "- [ ] Task 1 (AC: 3, 1)", acceptanceCriteria: ["3", "1"] },
      { text: "- [ ] Persist the session (AC: 2)", acceptanceCriteria: ["2"] },
    ]);
  });

  it("parses Superpowers steps without turning Task headings into obligations", () => {
    const path = "docs/superpowers/plans/2026-08-29-session.md";

    expect(
      parseDesignSourceObligations({
        role: "plan",
        path,
        text: [
          "# Session Implementation Plan",
          "",
          "### Task 1: Store sessions",
          "",
          "- [x] **Step 1: Write the failing test**",
          "- [ ] **Step 2: Implement storage**",
          "",
          "### Task 2: Restore sessions",
          "",
          "- [ ] **Step 1: Add restart coverage**",
        ].join("\n"),
      }),
    ).toEqual([
      {
        kind: "task",
        key: `${path}#task-group:1/task:step-1`,
        parentKey: `${path}#task-group:1`,
        address: "task-group:1/task:step-1",
        text: "- [x] **Step 1: Write the failing test**",
        line: 5,
        done: true,
        groupTitle: "Task 1: Store sessions",
      },
      {
        kind: "task",
        key: `${path}#task-group:1/task:step-2`,
        parentKey: `${path}#task-group:1`,
        address: "task-group:1/task:step-2",
        text: "- [ ] **Step 2: Implement storage**",
        line: 6,
        done: false,
        groupTitle: "Task 1: Store sessions",
      },
      {
        kind: "task",
        key: `${path}#task-group:2/task:step-1`,
        parentKey: `${path}#task-group:2`,
        address: "task-group:2/task:step-1",
        text: "- [ ] **Step 1: Add restart coverage**",
        line: 10,
        done: false,
        groupTitle: "Task 2: Restore sessions",
      },
    ]);
  });

  it("preserves one exact Superpowers manifest for every task group", () => {
    const path = "docs/superpowers/plans/2026-08-29-session.md";
    const tasks = parseDesignSourceObligations({
      format: "superpowers",
      role: "plan",
      path,
      text: [
        "### Task 1: Store sessions",
        "",
        "**Files:**",
        "- Modify: `src/store.ts:12-30`",
        "- Test: `src/store.test.ts`",
        "",
        "**Interfaces:**",
        "- Consumes: `Clock.now(): number`",
        "- Produces: `SessionStore.write(session): void`",
        "",
        "- [ ] **Step 1: Run the failing test**",
        "Run: `pnpm test store`",
        'Expected: FAIL with "write is not defined"',
        "",
        "- [ ] **Step 2: Run the passing test**",
        "Run: `pnpm test store`",
        "Expected: PASS",
      ].join("\n"),
    }).filter((obligation) => obligation.kind === "task");

    expect(tasks).toHaveLength(2);
    expect(tasks[0]?.manifest).toEqual({
      files: [
        { operation: "modify", value: "`src/store.ts:12-30`" },
        { operation: "test", value: "`src/store.test.ts`" },
      ],
      interfaces: [
        { direction: "consumes", value: "`Clock.now(): number`" },
        { direction: "produces", value: "`SessionStore.write(session): void`" },
      ],
      verifications: [
        { run: "`pnpm test store`", expected: 'FAIL with "write is not defined"' },
        { run: "`pnpm test store`", expected: "PASS" },
      ],
    });
    expect(tasks[1]?.manifest).toBeUndefined();
  });

  it("binds a Superpowers ledger to its exact plan and preserves every progress line", () => {
    const path = ".superpowers/sdd/2026-08-29-session/progress.md";
    const planPath = "docs/superpowers/plans/2026-08-29-session.md";
    const source = {
      format: "superpowers",
      role: "progress",
      path,
      text: [
        `# SDD ledger — plan: ${planPath}`,
        "Task 1: complete (commits abc1234..def5678, review clean)",
        "Task 2: fix round 1/5 (1 addressed, 1 open — retry; commits def5678..fed4321)",
        "Task 2: minor (deferred): tighten the copy",
        "Ruling: keep the old route — callers depend on it — removal would break links",
      ].join("\n"),
    } as const;

    expect(parseSuperpowersProgressLedger(source)).toEqual({
      planPath,
      entries: [
        { kind: "task-complete", taskId: "1", line: 2 },
        { kind: "task-fix-round", taskId: "2", line: 3 },
        { kind: "task-minor", taskId: "2", line: 4 },
        { kind: "ruling", line: 5 },
      ],
    });
    expect(parseDesignSourceObligations(source)).toEqual([
      {
        kind: "progress-entry",
        key: `${path}#progress/binding`,
        parentKey: `${path}#progress`,
        address: "progress/binding",
        text: `# SDD ledger — plan: ${planPath}`,
        line: 1,
        entry: { kind: "plan-binding", planPath },
      },
      {
        kind: "progress-entry",
        key: `${path}#progress/task:1/complete`,
        parentKey: `${path}#progress`,
        address: "progress/task:1/complete",
        text: "Task 1: complete (commits abc1234..def5678, review clean)",
        line: 2,
        entry: { kind: "task-complete", taskId: "1" },
      },
      {
        kind: "progress-entry",
        key: `${path}#progress/task:2/fix-round`,
        parentKey: `${path}#progress`,
        address: "progress/task:2/fix-round",
        text: "Task 2: fix round 1/5 (1 addressed, 1 open — retry; commits def5678..fed4321)",
        line: 3,
        entry: { kind: "task-fix-round", taskId: "2" },
      },
      {
        kind: "progress-entry",
        key: `${path}#progress/task:2/minor`,
        parentKey: `${path}#progress`,
        address: "progress/task:2/minor",
        text: "Task 2: minor (deferred): tighten the copy",
        line: 4,
        entry: { kind: "task-minor", taskId: "2" },
      },
      {
        kind: "progress-entry",
        key: `${path}#progress/ruling`,
        parentKey: `${path}#progress`,
        address: "progress/ruling",
        text: "Ruling: keep the old route — callers depend on it — removal would break links",
        line: 5,
        entry: { kind: "ruling" },
      },
    ]);
  });

  it("rejects a near-match ledger header as a plan binding", () => {
    expect(
      parseSuperpowersProgressLedger({
        format: "superpowers",
        role: "progress",
        path: ".superpowers/sdd/session/progress.md",
        text: [
          "# SDD ledger - plan: docs/superpowers/plans/session.md",
          "Task 1: complete (commits abc1234..def5678, review clean)",
        ].join("\n"),
      }),
    ).toBeUndefined();
  });

  it("parses grill glossary triples in source order and keeps ADR rationale", () => {
    const adrPath = "docs/adr/0001-event-store.md";
    const contextPath = "CONTEXT.md";

    expect(
      parseAll([
        {
          role: "adr",
          path: adrPath,
          text: "# Keep an event store\n\nIt preserves review history.\n",
        },
        {
          role: "context",
          path: contextPath,
          text: [
            "# Ordering",
            "",
            "## Language",
            "",
            "### Transactions",
            "",
            "**Order**:",
            "A customer's request for goods, from placement to dispatch.",
            "_Avoid_: Purchase, transaction",
            "",
            "- **Invoice**: A request for payment sent after delivery.",
            "  _Avoid_: Bill, payment request",
            "",
            "### Actors",
            "",
            "**Customer**:",
            "A person or organization that places orders.",
            "_Avoid_: Client, buyer, account",
          ].join("\n"),
        },
        {
          role: "context-map",
          path: "CONTEXT-MAP.md",
          text: "# Contexts\n\n## Contexts\n\n- [Ordering](CONTEXT.md)\n",
        },
      ]),
    ).toEqual([
      {
        kind: "decision",
        key: `${adrPath}#decision:keep-an-event-store`,
        parentKey: `${adrPath}#artifact`,
        address: "decision:keep-an-event-store",
        text: "Keep an event store",
        line: 1,
        rationale: "It preserves review history.",
      },
      {
        kind: "glossary-term",
        key: `${contextPath}#language/group:transactions/term:order`,
        parentKey: `${contextPath}#language/group:transactions`,
        address: "language/group:transactions/term:order",
        text: "**Order**: A customer's request for goods, from placement to dispatch. _Avoid_: Purchase, transaction",
        line: 7,
        term: "Order",
        definition: "A customer's request for goods, from placement to dispatch.",
        avoid: ["Purchase", "transaction"],
        groupTitle: "Transactions",
      },
      {
        kind: "glossary-term",
        key: `${contextPath}#language/group:transactions/term:invoice`,
        parentKey: `${contextPath}#language/group:transactions`,
        address: "language/group:transactions/term:invoice",
        text: "- **Invoice**: A request for payment sent after delivery. _Avoid_: Bill, payment request",
        line: 11,
        term: "Invoice",
        definition: "A request for payment sent after delivery.",
        avoid: ["Bill", "payment request"],
        groupTitle: "Transactions",
      },
      {
        kind: "glossary-term",
        key: `${contextPath}#language/group:actors/term:customer`,
        parentKey: `${contextPath}#language/group:actors`,
        address: "language/group:actors/term:customer",
        text: "**Customer**: A person or organization that places orders. _Avoid_: Client, buyer, account",
        line: 16,
        term: "Customer",
        definition: "A person or organization that places orders.",
        avoid: ["Client", "buyer", "account"],
        groupTitle: "Actors",
      },
    ]);
  });

  it("keeps grill ADR body rationale and ordered options without metadata or consequences", () => {
    const path = "docs/adr/0002-session-store.md";
    expect(
      parseDesignSourceObligations({
        format: "grill-with-docs",
        role: "adr",
        path,
        text: [
          "---",
          "status: accepted",
          "---",
          "",
          "# Keep session state local",
          "",
          "It preserves atomic writes and offline recovery.",
          "",
          "## Considered Options",
          "",
          "- Store state remotely.",
          "- Keep state in memory only.",
          "",
          "## Consequences",
          "",
          "The local store remains load-bearing.",
        ].join("\n"),
      }),
    ).toEqual([
      {
        kind: "decision",
        key: `${path}#decision:keep-session-state-local`,
        parentKey: `${path}#artifact`,
        address: "decision:keep-session-state-local",
        text: "Keep session state local",
        line: 5,
        rationale: "It preserves atomic writes and offline recovery.",
        alternatives: ["Store state remotely.", "Keep state in memory only."],
      },
    ]);
  });

  it("keeps repeated child labels distinct through their source parents", () => {
    const specPath = "openspec/changes/session/specs/session/spec.md";
    const planPath = "docs/superpowers/plans/2026-08-29-session.md";
    const obligations = parseAll([
      {
        role: "spec-delta",
        path: specPath,
        text: [
          "## ADDED Requirements",
          "### Requirement: Persist",
          "The system SHALL persist sessions.",
          "#### Scenario: Happy path",
          "- **THEN** the session persists",
          "### Requirement: Restore",
          "The system SHALL restore sessions.",
          "#### Scenario: Happy path",
          "- **THEN** the session restores",
        ].join("\n"),
      },
      {
        role: "plan",
        path: planPath,
        text: [
          "### Task 1: Persist",
          "- [ ] **Step 1: Execute**",
          "### Task 2: Restore",
          "- [ ] **Step 1: Execute**",
        ].join("\n"),
      },
    ]);

    const scenarios = obligations.filter((obligation) => obligation.kind === "scenario");
    const tasks = obligations.filter((obligation) => obligation.kind === "task");

    expect(scenarios.map(({ parentKey }) => parentKey)).toEqual([
      `${specPath}#requirement:persist`,
      `${specPath}#requirement:restore`,
    ]);
    expect(new Set(scenarios.map(({ key }) => key)).size).toBe(2);
    expect(tasks.map(({ parentKey }) => parentKey)).toEqual([
      `${planPath}#task-group:1`,
      `${planPath}#task-group:2`,
    ]);
    expect(new Set(tasks.map(({ key }) => key)).size).toBe(2);
  });
});
