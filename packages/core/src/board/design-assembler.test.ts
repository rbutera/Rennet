import { describe, expect, it } from "vitest";
import type { OpenSpecChangeSource } from "../delta/openspec-change";
import { assembleDesignBoard } from "./design-assembler";
import { openSpecChangeSourceToDesignSources } from "./design-obligations";
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
