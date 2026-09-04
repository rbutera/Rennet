import { describe, expect, it } from "vitest";
import { parseSuperpowersSpec, type SuperpowersSpecSource } from "./superpowers-spec";

/** Narrow an optional to present, or fail the test loudly (no non-null assertions). */
function present<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error("expected a present value");
  return value;
}

// The fixtures are the exact markdown shape `design-obligations.ts` already parses
// for the Superpowers format (plan header `**Architecture:**`/`**Tech Stack:**`,
// `### Task N:` groups with a Create/Modify/Test + Consumes/Produces + Run/Expected
// manifest, and a `# SDD ledger — plan:` progress ledger). Parsing them here proves
// the rich model and the lint obligations read the same source the same way.

const PLAN_PATH = "docs/superpowers/plans/2026-08-29-session.md";
const SPEC_PATH = "docs/superpowers/specs/session.md";
const PROGRESS_PATH = ".superpowers/sdd/session/progress.md";

const PLAN_MD = [
  "# Plan — Persist and restore sessions",
  "",
  "**Goal:** Restore sessions after restart.",
  "**Architecture:** Keep event state in the existing store.",
  "**Tech Stack:** TypeScript 5.6 and SQLite",
  "**Spec:** docs/superpowers/specs/session.md",
  "",
  "## Global Constraints",
  "",
  "- No new runtime dependency",
  "- Under 200ms restore",
  "",
  "### Task 1: Persist sessions",
  "",
  "- Create: packages/core/src/session/store.ts",
  "- Modify: packages/core/src/session/index.ts",
  "- Test: packages/core/src/session/store.test.ts",
  "- Consumes: SessionEvent",
  "- Produces: PersistedSession",
  "Run: pnpm nx test core",
  "Expected: store round-trips a session",
  "",
  "- [x] Step 1 Write the failing test",
  "- [ ] Step 2 Implement persistence",
  "",
  "### Task 2: Restore sessions",
  "",
  "- [ ] Prove restart recovery",
].join("\n");

const SPEC_MD = [
  "# Design — Session persistence",
  "",
  "## Context",
  "",
  "Sessions are lost on restart today. Keep the store as the source of truth.",
  "",
  "## Approach",
  "",
  "Write each event through, and replay on boot.",
].join("\n");

const PROGRESS_MD = [
  `# SDD ledger — plan: ${PLAN_PATH}`,
  "Task 1: complete (commits abc1234..def5678, review clean)",
  "Task 2: fix round 2/5 (lint failed)",
  "Task 3: minor (deferred): rename a local",
  "Ruling: keep the store synchronous",
  "Something else entirely",
].join("\n");

function sourceOf(overrides: Partial<SuperpowersSpecSource> = {}): SuperpowersSpecSource {
  return {
    name: "session",
    specs: [{ path: SPEC_PATH, md: SPEC_MD }],
    plans: [{ path: PLAN_PATH, md: PLAN_MD }],
    progress: [{ path: PROGRESS_PATH, md: PROGRESS_MD }],
    ...overrides,
  };
}

describe("parseSuperpowersSpec — plan", () => {
  it("parses the plan header choices, goal, spec pointer, and global constraints", () => {
    const plan = present(parseSuperpowersSpec(sourceOf()).plans[0]);
    expect(plan.goal).toBe("Restore sessions after restart.");
    expect(plan.specPath).toBe("docs/superpowers/specs/session.md");
    expect(plan.decisions).toEqual([
      {
        label: "Architecture",
        value: "Keep event state in the existing store.",
        source: { artifact: "plan", path: PLAN_PATH, line: 4 },
      },
      {
        label: "Tech Stack",
        value: "TypeScript 5.6 and SQLite",
        source: { artifact: "plan", path: PLAN_PATH, line: 5 },
      },
    ]);
    expect(plan.globalConstraints).toEqual(["No new runtime dependency", "Under 200ms restore"]);
  });

  it("parses task groups with their file/interface/verification manifest and steps", () => {
    const plan = present(parseSuperpowersSpec(sourceOf()).plans[0]);
    expect(plan.taskGroups.map((group) => ({ id: group.id, title: group.title }))).toEqual([
      { id: "1", title: "Task 1: Persist sessions" },
      { id: "2", title: "Task 2: Restore sessions" },
    ]);

    const first = present(plan.taskGroups[0]);
    expect(present(first.manifest)).toEqual({
      files: [
        { operation: "create", value: "packages/core/src/session/store.ts" },
        { operation: "modify", value: "packages/core/src/session/index.ts" },
        { operation: "test", value: "packages/core/src/session/store.test.ts" },
      ],
      interfaces: [
        { direction: "consumes", value: "SessionEvent" },
        { direction: "produces", value: "PersistedSession" },
      ],
      verifications: [{ run: "pnpm nx test core", expected: "store round-trips a session" }],
    });
    expect(first.steps.map((step) => ({ id: step.id, done: step.done }))).toEqual([
      { id: "1", done: true },
      { id: "2", done: false },
    ]);
    // The step's source carries the real plan file + 1-based line.
    expect(present(first.steps[0]).source).toEqual({ artifact: "plan", path: PLAN_PATH, line: 23 });
  });

  it("states per-group completion and rolls up at group granularity", () => {
    const plan = present(parseSuperpowersSpec(sourceOf()).plans[0]);
    expect(plan.taskGroups.map((group) => group.state)).toEqual(["incomplete", "incomplete"]);
    // Group total, plan total are group counts; done counts complete groups (here 0).
    expect({ total: plan.total, done: plan.done }).toEqual({ total: 2, done: 0 });
  });

  it("marks a group complete when every step is checked, and static when it has none", () => {
    const md = [
      "### Task 1: All done",
      "- [x] Step 1 first",
      "- [x] Step 2 second",
      "### Task 2: No checklist",
      "- Create: only-a-manifest.ts",
    ].join("\n");
    const plan = present(
      parseSuperpowersSpec({ name: "x", plans: [{ path: PLAN_PATH, md }] }).plans[0],
    );
    expect(plan.taskGroups.map((group) => group.state)).toEqual(["complete", "static"]);
    expect({ total: plan.total, done: plan.done }).toEqual({ total: 2, done: 1 });
  });
});

describe("parseSuperpowersSpec — progress ledger", () => {
  it("binds to its plan and classifies every ledger line kind", () => {
    const ledger = present(parseSuperpowersSpec(sourceOf()).progressLedgers[0]);
    expect(ledger.planPath).toBe(PLAN_PATH);
    expect(ledger.entries.map((entry) => entry.kind)).toEqual([
      "task-complete",
      "task-fix-round",
      "task-minor",
      "ruling",
      "other",
    ]);
    const complete = present(ledger.entries[0]);
    expect(complete).toMatchObject({ kind: "task-complete", line: 2 });
    if (complete.kind === "task-complete") expect(complete.taskId).toBe("1");
    expect(present(ledger.entries[1])).toMatchObject({ kind: "task-fix-round" });
  });

  it("drops a progress artifact whose first line is not a plan binding (not a ledger)", () => {
    const spec = parseSuperpowersSpec(
      sourceOf({ progress: [{ path: PROGRESS_PATH, md: "Task 1: complete (no binding above)" }] }),
    );
    expect(spec.progressLedgers).toEqual([]);
  });
});

describe("parseSuperpowersSpec — design spec", () => {
  it("splits the design spec into level-2/3 sections with flattened prose", () => {
    const spec = present(parseSuperpowersSpec(sourceOf()).specs[0]);
    expect(spec.sections.map((section) => ({ id: section.id, heading: section.heading }))).toEqual([
      { id: "context", heading: "Context" },
      { id: "approach", heading: "Approach" },
    ]);
    expect(present(spec.sections[0]).body).toBe(
      "Sessions are lost on restart today. Keep the store as the source of truth.",
    );
    expect(present(spec.sections[0]).source).toEqual({
      artifact: "spec",
      path: SPEC_PATH,
      line: 3,
    });
  });
});

describe("parseSuperpowersSpec — tolerance and raw", () => {
  it("never throws on a sparse feature and returns empty arrays for absent artifacts", () => {
    const onlyPlan = parseSuperpowersSpec({ name: "x", plans: [{ path: PLAN_PATH, md: PLAN_MD }] });
    expect(onlyPlan.specs).toEqual([]);
    expect(onlyPlan.progressLedgers).toEqual([]);
    expect(onlyPlan.plans).toHaveLength(1);

    const empty = parseSuperpowersSpec({ name: "x" });
    expect({
      specs: empty.specs,
      plans: empty.plans,
      progressLedgers: empty.progressLedgers,
    }).toEqual({ specs: [], plans: [], progressLedgers: [] });
  });

  it("carries the raw artifact text verbatim", () => {
    const raw = present(parseSuperpowersSpec(sourceOf()).raw);
    expect(raw.plans).toEqual([{ path: PLAN_PATH, md: PLAN_MD }]);
    expect(raw.specs).toEqual([{ path: SPEC_PATH, md: SPEC_MD }]);
    expect(raw.progress).toEqual([{ path: PROGRESS_PATH, md: PROGRESS_MD }]);
  });
});

describe("parseSuperpowersSpec — positive control", () => {
  it("would fail if verification pairing broke: an Expected without a preceding Run is dropped", () => {
    // A Run/Expected pair yields one verification; an orphan Expected yields none.
    const paired = "### Task 1: X\nRun: a\nExpected: b";
    const orphan = "### Task 1: X\nExpected: b";
    const pairedManifest = present(
      present(
        parseSuperpowersSpec({ name: "x", plans: [{ path: PLAN_PATH, md: paired }] }).plans[0],
      ).taskGroups[0],
    ).manifest;
    const orphanGroup = present(
      parseSuperpowersSpec({ name: "x", plans: [{ path: PLAN_PATH, md: orphan }] }).plans[0],
    ).taskGroups[0];
    expect(present(pairedManifest).verifications).toEqual([{ run: "a", expected: "b" }]);
    // The orphan Expected produces no manifest at all (no files/interfaces/verifications).
    expect(present(orphanGroup).manifest).toBeUndefined();
  });
});
