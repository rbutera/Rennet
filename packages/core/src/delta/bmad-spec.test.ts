import { describe, expect, it } from "vitest";
import { type BmadSpecSource, parseBmadSpec } from "./bmad-spec";

/** Narrow an optional to present, or fail the test loudly (no non-null assertions). */
function present<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error("expected a present value");
  return value;
}

// The fixtures below are shaped exactly like real BMAD v4 documents — a PRD with a
// requirement registry, technical assumptions, and an inline epic/story; an
// architecture doc with a Tech Stack table; a standalone story with a status,
// acceptance criteria, and a Tasks / Subtasks checklist; and an epic enumerating
// stories — so the parser is exercised against the markdown shapes it will read off
// disk, not a synthetic stand-in.

const PRD_MD = `# Foo Product Requirements Document (PRD)

## Goals and Background Context

Foo replaces the manual review flow with a structured board.

## Requirements

### Functional

- FR1: The system SHALL parse BMAD documents into a structured model.
- FR2: The system SHALL preserve every node's source line.

### Non Functional

- NFR1: Parsing SHALL be deterministic and node-free.

## Technical Assumptions

- **Repository Structure:** Monorepo
- **Service Architecture:** Modular monolith
- **Testing Requirements:** Unit and integration tests

## Epic 1 Foundation

### Story 1.1 Parse the PRD

As a reviewer, I want the PRD parsed, so that I can read its requirements.

#### Acceptance Criteria

1. The functional requirements are listed in source order.
2. The technical assumptions are shown.
`;

const ARCHITECTURE_MD = `# Foo Architecture Document

## High Level Architecture

The system is a modular monolith on a single runtime.

## Tech Stack

| Category | Technology | Version | Rationale |
| --- | --- | --- | --- |
| Language | TypeScript | 5.x | Type safety across the monorepo |
| Runtime | Node.js | 20 | LTS support and native ESM |
`;

const STORY_MD = `# Story 1.2: Wire the reader

## Status

Approved

## Story

As a reviewer, I want the story reader wired, so that touched stories render on the board.

## Acceptance Criteria

1. The reader honors core-config.yaml overrides.
2. The reader reads each document at the reviewed tree.

## Tasks / Subtasks

- [x] Task 1: Discover config (AC: 1)
  - [x] Subtask 1.1: Read core-config.yaml
  - [ ] Subtask 1.2: Resolve the paths it names
- [ ] Task 2: Read documents (AC: 2)
  - [ ] Subtask 2.1: git show at the reviewed tree
`;

const EPIC_MD = `# Epic 2: Reader wiring

Goal: wire the BMAD reader into the design pipeline.

## Story 2.1 Config discovery

As a reviewer, I want config discovery, so that overrides win over conventions.

### Acceptance Criteria

1. The core-config.yaml paths are read.

## Story 2.2 Tree reads

As a reviewer, I want tree reads, so that the captured bytes render.

### Acceptance Criteria

1. Each document is read at the reviewed tree.
`;

const SOURCE: BmadSpecSource = {
  name: "1.2",
  prdMd: PRD_MD,
  architectureMd: ARCHITECTURE_MD,
  epics: [{ path: ".bmad/epics/epic-2.md", md: EPIC_MD }],
  stories: [{ path: ".bmad/stories/1.2.story.md", md: STORY_MD }],
};

describe("parseBmadSpec — PRD", () => {
  it("names the spec and structures the PRD", () => {
    const spec = parseBmadSpec(SOURCE);
    expect(spec.name).toBe("1.2");
    expect(spec.prd).toBeDefined();
  });

  it("reads the functional and non-functional requirement registry with source lines", () => {
    const prd = present(parseBmadSpec(SOURCE).prd);
    expect(prd.requirements.map((r) => r.id)).toEqual(["FR1", "FR2", "NFR1"]);
    expect(prd.requirements.map((r) => r.kind)).toEqual([
      "functional",
      "functional",
      "non-functional",
    ]);
    expect(prd.requirements[0]?.text).toContain("parse BMAD documents");
    // Every reviewable node carries its source origin (artifact + 1-based line).
    expect(prd.requirements[0]?.source).toMatchObject({ artifact: "prd" });
    expect(present(prd.requirements[0]?.source).line).toBeGreaterThan(0);
  });

  it("reads the technical-assumption choices, ignoring unlisted labels", () => {
    const prd = present(parseBmadSpec(SOURCE).prd);
    expect(prd.technicalAssumptions.map((a) => a.label)).toEqual([
      "Repository Structure",
      "Service Architecture",
      "Testing Requirements",
    ]);
    expect(prd.technicalAssumptions[0]?.value).toBe("Monorepo");
  });

  it("reads an inline story with its acceptance criteria", () => {
    const prd = present(parseBmadSpec(SOURCE).prd);
    expect(prd.stories).toHaveLength(1);
    const story = present(prd.stories[0]);
    expect(story.id).toBe("1.1");
    expect(story.statement).toContain("As a reviewer");
    expect(story.acceptanceCriteria.map((c) => c.id)).toEqual(["1", "2"]);
    expect(story.acceptanceCriteria[0]?.text).toContain("source order");
  });

  it("carries the full PRD section tree alongside the structured fields", () => {
    const prd = present(parseBmadSpec(SOURCE).prd);
    const headings = prd.sections.map((s) => s.heading);
    expect(headings).toContain("Requirements");
    expect(headings).toContain("Technical Assumptions");
    expect(prd.sections.find((s) => s.heading === "Goals and Background Context")?.level).toBe(2);
  });
});

describe("parseBmadSpec — architecture", () => {
  it("parses the Tech Stack table into rows with a pulled-out rationale", () => {
    const architecture = present(parseBmadSpec(SOURCE).architecture);
    const techStack = present(architecture.techStack);
    expect(techStack.headers).toEqual(["Category", "Technology", "Version", "Rationale"]);
    expect(techStack.rows).toHaveLength(2);
    expect(techStack.rows[0]?.cells).toEqual([
      "Language",
      "TypeScript",
      "5.x",
      "Type safety across the monorepo",
    ]);
    expect(techStack.rows[0]?.rationale).toBe("Type safety across the monorepo");
    expect(techStack.rows[0]?.source).toMatchObject({ artifact: "architecture" });
  });

  it("carries the architecture section tree", () => {
    const architecture = present(parseBmadSpec(SOURCE).architecture);
    expect(architecture.sections.map((s) => s.heading)).toContain("High Level Architecture");
  });
});

describe("parseBmadSpec — story document", () => {
  it("reads the primary story's id, statement, status, and acceptance criteria", () => {
    const doc = present(parseBmadSpec(SOURCE).stories[0]);
    expect(doc.path).toBe(".bmad/stories/1.2.story.md");
    const story = present(doc.story);
    expect(story.id).toBe("1.2");
    expect(story.title).toBe("Story 1.2: Wire the reader");
    expect(story.status).toBe("Approved");
    expect(story.statement).toContain("story reader wired");
    expect(story.acceptanceCriteria.map((c) => c.id)).toEqual(["1", "2"]);
    // The story node's source names its owning document path.
    expect(story.source).toMatchObject({
      artifact: "story",
      document: ".bmad/stories/1.2.story.md",
    });
  });

  it("groups tasks and subtasks with an honest done/total roll-up and AC refs", () => {
    const doc = present(parseBmadSpec(SOURCE).stories[0]);
    expect(doc.tasks).toHaveLength(2);
    const first = present(doc.tasks[0]);
    expect(first.title).toContain("Task 1: Discover config");
    expect(first.status).toBe("done");
    expect(first.acceptanceCriteriaRefs).toEqual(["1"]);
    expect(first.total).toBe(2);
    expect(first.done).toBe(1);
    expect(first.items.map((i) => i.status)).toEqual(["done", "todo"]);
    const second = present(doc.tasks[1]);
    expect(second.status).toBe("todo");
    expect(second.acceptanceCriteriaRefs).toEqual(["2"]);
    expect(second.total).toBe(1);
    expect(second.done).toBe(0);
  });
});

describe("parseBmadSpec — epic document", () => {
  it("enumerates the epic's stories, each with acceptance criteria", () => {
    const epic = present(parseBmadSpec(SOURCE).epics[0]);
    expect(epic.path).toBe(".bmad/epics/epic-2.md");
    expect(epic.stories.map((s) => s.id)).toEqual(["2.1", "2.2"]);
    expect(epic.stories[0]?.statement).toContain("config discovery");
    expect(epic.stories[0]?.acceptanceCriteria[0]?.text).toContain("core-config.yaml");
    expect(epic.stories[0]?.source).toMatchObject({
      artifact: "epic",
      document: ".bmad/epics/epic-2.md",
    });
  });
});

describe("parseBmadSpec — raw + tolerance", () => {
  it("carries the raw document text verbatim", () => {
    const spec = parseBmadSpec(SOURCE);
    expect(spec.raw?.prdMd).toBe(PRD_MD);
    expect(spec.raw?.architectureMd).toBe(ARCHITECTURE_MD);
    expect(spec.raw?.epics).toEqual([{ path: ".bmad/epics/epic-2.md", md: EPIC_MD }]);
  });

  it("parses a spec with only a PRD, leaving other documents absent", () => {
    const spec = parseBmadSpec({
      name: "minimal",
      prdMd: "## Requirements\n\n- FR1: SHALL work.\n",
    });
    expect(spec.prd).toBeDefined();
    expect(spec.architecture).toBeUndefined();
    expect(spec.epics).toEqual([]);
    expect(spec.stories).toEqual([]);
  });

  it("never throws on an empty source", () => {
    const spec = parseBmadSpec({ name: "empty" });
    expect(spec.epics).toEqual([]);
    expect(spec.stories).toEqual([]);
    expect(spec.prd).toBeUndefined();
  });

  // POSITIVE CONTROL (run once with the parser broken): temporarily make
  // `parseTasks` mark every checkbox `done`, or drop the AC-ref regex, and this
  // block reddens — the done/total roll-up and the AC refs are load-bearing, not
  // tautological. See the PR description for the confirmed red→green.
  it("keeps an unchecked subtask counted as not-done (control anchor)", () => {
    const doc = present(parseBmadSpec(SOURCE).stories[0]);
    const first = present(doc.tasks[0]);
    // If the parser ignored the checkbox mark, done would equal total here.
    expect(first.done).not.toBe(first.total);
  });
});
