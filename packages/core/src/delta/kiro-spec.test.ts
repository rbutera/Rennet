import { describe, expect, it } from "vitest";
import { type KiroSpecSource, parseKiroSpec } from "./kiro-spec";

/** Narrow an optional to present, or fail the test loudly (no non-null assertions). */
function present<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error("expected a present value");
  return value;
}

// A Kiro feature `session`, in the exact `.kiro/specs/<feature>/` artifact shapes the
// app reads off disk: EARS requirements, a design section tree, a numbered task
// checklist with `_Requirements:` refs, and (separately) a bugfix variant.

const REQUIREMENTS_MD = `# Requirements Document

## Introduction

The session feature keeps a reviewer's work across restarts.

### Requirement 1

**User Story:** As a reviewer, I want sessions to survive restarts, so that I never lose in-flight work.

#### Acceptance Criteria

1. WHEN the application restarts THEN the system SHALL restore the active session
2. IF the session is expired THEN the system SHALL show the sign-in screen
3. WHILE a review is open, the system SHALL persist edits within one second

### Requirement 2

**User Story:** As a reviewer, I want deterministic recovery.

#### Acceptance Criteria

1. WHEN the store is corrupt THEN the system SHALL rebuild it from the journal
`;

const DESIGN_MD = `# Design — Session

## Overview

The session store writes to a single append-only journal.

## Architecture

\`\`\`
  UI  ──▶  SessionStore  ──▶  Journal
\`\`\`

### Components and Interfaces

The store exposes \`save\` and \`restore\`.

| Method | Kind | Notes |
|---|---|---|
| save | write | debounced |
| restore | read | at startup |
`;

const TASKS_MD = `# Implementation Plan

- [x] 1. Build the session store
  - Define module boundaries
  - _Requirements: 1.1_
- [ ] 1.1 Add persistence
  - Encode validation rules
  - _Requirements: 1.3, 2.1_
- [ ] 2. Build the restart path
  - _Requirements: 1.1, 1.2_
`;

const BUGFIX_MD = `# Session restart bugfix

## Current Behavior

A restart drops the active session and the reviewer loses edits.

## Expected Behavior

A restart restores the active session with all edits intact.

## Unchanged Behaviour

Expired sessions still open the sign-in screen.
`;

const SOURCE: KiroSpecSource = {
  feature: "session",
  requirementsMd: REQUIREMENTS_MD,
  designMd: DESIGN_MD,
  tasksMd: TASKS_MD,
};

describe("parseKiroSpec — requirements", () => {
  it("names the feature and structures every requirement", () => {
    const spec = parseKiroSpec(SOURCE);
    expect(spec.feature).toBe("session");
    const requirements = present(spec.requirements);
    expect(requirements.requirements).toHaveLength(2);
  });

  it("carries each requirement's id, label, and user story", () => {
    const requirements = present(parseKiroSpec(SOURCE).requirements).requirements;
    expect(requirements[0]?.id).toBe("1");
    expect(requirements[0]?.label).toBe("Requirement 1");
    expect(requirements[0]?.userStory).toContain("sessions to survive restarts");
    expect(requirements[0]?.source).toMatchObject({ artifact: "requirements" });
    expect(requirements[0]?.source?.line).toBeGreaterThan(0);
  });

  it("keeps every numbered acceptance criterion with a requirement-scoped id", () => {
    const req = present(parseKiroSpec(SOURCE).requirements).requirements[0];
    expect(req?.acceptanceCriteria.map((c) => c.id)).toEqual(["1.1", "1.2", "1.3"]);
    expect(req?.acceptanceCriteria[0]?.text).toBe(
      "WHEN the application restarts THEN the system SHALL restore the active session",
    );
    expect(req?.acceptanceCriteria[0]?.source).toMatchObject({ artifact: "requirements" });
  });

  it("splits an EARS criterion into exact condition and response clauses", () => {
    const criteria = present(parseKiroSpec(SOURCE).requirements).requirements[0]
      ?.acceptanceCriteria;
    expect(criteria?.[0]?.ears).toEqual({
      condition: "the application restarts",
      response: "the system SHALL restore the active session",
    });
    // The comma-form WHILE criterion splits on the `SHALL` fallback.
    expect(criteria?.[2]?.ears).toEqual({
      condition: "a review is open",
      response: "the system SHALL persist edits within one second",
    });
  });

  it("keeps the second requirement's criteria distinct from the first", () => {
    const requirements = present(parseKiroSpec(SOURCE).requirements).requirements;
    expect(requirements[1]?.id).toBe("2");
    expect(requirements[1]?.acceptanceCriteria).toHaveLength(1);
    expect(requirements[1]?.acceptanceCriteria[0]?.id).toBe("2.1");
    expect(requirements[1]?.acceptanceCriteria[0]?.text).toContain("rebuild it from the journal");
  });

  it("keeps a non-EARS criterion, marking it with no clause split", () => {
    const spec = parseKiroSpec({
      feature: "misc",
      requirementsMd: [
        "### Requirement 1",
        "**User Story:** As a user, I want the thing.",
        "#### Acceptance Criteria",
        "1. The system SHALL log every access",
      ].join("\n"),
    });
    const criterion = present(spec.requirements).requirements[0]?.acceptanceCriteria[0];
    expect(criterion?.text).toBe("The system SHALL log every access");
    expect(criterion?.ears).toBeUndefined();
  });
});

describe("parseKiroSpec — design", () => {
  it("builds an ordered section tree at level 2 and 3, dropping the H1 title", () => {
    const design = present(parseKiroSpec(SOURCE).design);
    const headings = design.sections.map((s) => s.heading);
    expect(headings).toEqual(["Overview", "Architecture", "Components and Interfaces"]);
    expect(design.sections[0]?.level).toBe(2);
    expect(design.sections[2]?.level).toBe(3);
    expect(design.sections[2]?.id).toBe("components-and-interfaces");
  });

  it("captures a fenced code block verbatim under its section", () => {
    const design = present(parseKiroSpec(SOURCE).design);
    const arch = present(design.sections.find((s) => s.heading === "Architecture"));
    const code = arch.blocks.find((block) => block.kind === "code");
    expect(code).toBeDefined();
    if (code?.kind === "code") expect(code.code).toContain("SessionStore");
  });

  it("parses a markdown table into headers and rows", () => {
    const design = present(parseKiroSpec(SOURCE).design);
    const comp = present(design.sections.find((s) => s.heading === "Components and Interfaces"));
    const table = comp.blocks.find((block) => block.kind === "table");
    expect(table).toBeDefined();
    if (table?.kind === "table") {
      expect(table.headers).toEqual(["Method", "Kind", "Notes"]);
      expect(table.rows).toHaveLength(2);
      expect(table.rows[0]?.[0]).toBe("save");
    }
  });

  it("does NOT duplicate a nested ### child into its ## parent's body", () => {
    const design = present(parseKiroSpec(SOURCE).design);
    // `## Architecture` owns `### Components and Interfaces` as a child; the parent must
    // stop at the child — none of the child's prose bleeds up.
    const arch = present(design.sections.find((s) => s.heading === "Architecture"));
    const parentText = arch.blocks
      .flatMap((b) => (b.kind === "paragraph" ? [b.text] : []))
      .join(" ");
    expect(parentText).not.toContain("save and restore");
    expect(
      design.sections.every(
        (s) => !s.blocks.some((b) => b.kind === "paragraph" && b.text.startsWith("### ")),
      ),
    ).toBe(true);
  });

  it("stamps each design section with its source (artifact + 1-based line)", () => {
    const design = present(parseKiroSpec(SOURCE).design);
    const overview = present(design.sections[0]);
    expect(overview.source).toMatchObject({ artifact: "design" });
    expect(overview.source?.line).toBeGreaterThan(0);
  });
});

describe("parseKiroSpec — tasks", () => {
  it("groups the checklist by top-level number and rolls up an honest progress count", () => {
    const tasks = present(parseKiroSpec(SOURCE).tasks);
    expect(tasks.groups.map((g) => g.id)).toEqual(["task-group:1", "task-group:2"]);
    expect(tasks.groups[0]?.title).toBe("1. Build the session store");
    expect(tasks.total).toBe(3);
    expect(tasks.done).toBe(1);
  });

  it("folds a sub-numbered item into its top-level group", () => {
    const tasks = present(parseKiroSpec(SOURCE).tasks);
    const group1 = tasks.groups[0];
    expect(group1?.items.map((i) => i.number)).toEqual(["1", "1.1"]);
    expect(group1?.total).toBe(2);
    expect(group1?.done).toBe(1);
    expect(group1?.items[0]?.status).toBe("done");
    expect(group1?.items[1]?.status).toBe("todo");
  });

  it("binds each task's `_Requirements:` refs in source order", () => {
    const tasks = present(parseKiroSpec(SOURCE).tasks);
    expect(tasks.groups[0]?.items[0]?.requirementRefs).toEqual(["1.1"]);
    expect(tasks.groups[0]?.items[1]?.requirementRefs).toEqual(["1.3", "2.1"]);
    expect(tasks.groups[1]?.items[0]?.requirementRefs).toEqual(["1.1", "1.2"]);
  });

  it("stamps each task item with its source line", () => {
    const tasks = present(parseKiroSpec(SOURCE).tasks);
    expect(tasks.groups[0]?.items[0]?.source).toMatchObject({ artifact: "tasks" });
    expect(tasks.groups[0]?.items[0]?.source?.line).toBeGreaterThan(0);
  });
});

describe("parseKiroSpec — bugfix", () => {
  it("parses the current/expected/unchanged behaviour sections", () => {
    const spec = parseKiroSpec({ feature: "session-fix", bugfixMd: BUGFIX_MD });
    const bugfix = present(spec.bugfix);
    expect(bugfix.sections.map((s) => s.section)).toEqual(["current", "expected", "unchanged"]);
    expect(bugfix.sections[2]?.heading).toBe("Unchanged Behaviour");
    const current = bugfix.sections[0];
    const text = current?.blocks.flatMap((b) => (b.kind === "paragraph" ? [b.text] : [])).join(" ");
    expect(text).toContain("drops the active session");
    expect(current?.source).toMatchObject({ artifact: "bugfix" });
  });
});

describe("parseKiroSpec — positive control", () => {
  // If the requirement or task walk ever silently drops a node, these exact counts
  // move — the control the CLAUDE.md gate demands lives here, in the shape.
  it("counts every requirement, criterion, and task the fixture carries", () => {
    const spec = parseKiroSpec(SOURCE);
    const requirements = present(spec.requirements).requirements;
    expect(requirements).toHaveLength(2);
    const criteriaCount = requirements.reduce((sum, req) => sum + req.acceptanceCriteria.length, 0);
    expect(criteriaCount).toBe(4);
    const tasks = present(spec.tasks);
    const itemCount = tasks.groups.reduce((sum, group) => sum + group.items.length, 0);
    expect(itemCount).toBe(3);
    expect(tasks.total).toBe(3);
  });
});

describe("parseKiroSpec — tolerance", () => {
  it("parses a feature with only requirements, leaving other artifacts absent", () => {
    const spec = parseKiroSpec({
      feature: "minimal",
      requirementsMd: "### Requirement 1\n\n**User Story:** As a user, I want it.\n",
    });
    expect(spec.requirements).toBeDefined();
    expect(spec.design).toBeUndefined();
    expect(spec.tasks).toBeUndefined();
    expect(spec.bugfix).toBeUndefined();
  });

  it("keeps a requirement with a missing user story or empty criteria", () => {
    const spec = parseKiroSpec({
      feature: "sparse",
      requirementsMd: "### Requirement 1\n\n#### Acceptance Criteria\n",
    });
    const req = present(spec.requirements).requirements[0];
    expect(req?.id).toBe("1");
    expect(req?.userStory).toBe("");
    expect(req?.acceptanceCriteria).toEqual([]);
  });

  it("never throws on an empty source", () => {
    const spec = parseKiroSpec({ feature: "empty" });
    expect(spec.requirements).toBeUndefined();
    expect(spec.design).toBeUndefined();
    expect(spec.tasks).toBeUndefined();
    expect(spec.bugfix).toBeUndefined();
  });
});
