import { describe, expect, it } from "vitest";
import { type OpenSpecChangeSource, parseOpenSpecChange } from "./openspec-change";

/** Narrow an optional to present, or fail the test loudly (no non-null assertions). */
function present<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error("expected a present value");
  return value;
}

// The worked example is a REAL Rennet OpenSpec change: `add-review-intelligence-
// core`. These fixtures are verbatim excerpts of its artifacts, so the parser is
// exercised against the exact markdown shape the app will read off disk — not a
// synthetic stand-in.

const PROPOSAL_MD = `## Why

Rennet exists to REPLACE and SUPERSEDE the \`/review-pr\` skill Florence runs.

1. **Hypothesis-first pre-read pass (#178).** Before the lens runners read hunks, produce a committed hypothesis.
2. **Dual-model per-lens + disagreement-as-signal (#41).** Run two independent minds per lens.

## What Changes

- **A hypothesis pre-read pass (\`review.hypothesis\`), a new pipeline stage that runs before the lens runners.** A node-free core runner mirroring the existing runner shape produces one atomic document.
- **Dual-model execution per lens plus a deterministic reconcile.** The pipeline's seat resolver is widened to resolve TWO seats.

## Capabilities

### New Capabilities

- \`review-hypothesis-pass\`: The pre-read hypothesis runner (Domain/Scope/Design/Risks), its injection into every lens runner as disconfirmation criteria.
- \`dual-model-lens-review\`: Two-seat resolution per dual-model lens, independent runs fed the same disconfirmers.
- \`per-finding-verification\`: The non-obvious classifier, the reproduce-or-refute contract over the real code.

### Modified Capabilities

- \`rsp-validator\`: Gains the \`review.hypothesis\` doc type dispatched from the existing generic gate.

## Impact

- **\`packages/types\`** — additive only: \`ReviewIntent\`, \`ReviewHypothesisBody\`. No existing field changes.
- **\`packages/protocol\`** — \`review.hypothesis\` added to \`RSP_DOC_TYPES\`. Generic gate untouched.
`;

const DESIGN_MD = `# Design — Review Intelligence Core

## Context

Rennet's engine is genuinely live. The three lens runners each take an offered manifest.

Three facts make this change small rather than large:

1. **The disagreement data model already exists.** \`FindingElement.agreement\` already renders.
2. **The council already names the pieces.** Cross-harness routing already runs a Codex seat.

\`\`\`
   INTENT  +  REPO CONTEXT
        │
        ▼
    runHypothesisPass
\`\`\`

## Cost/latency envelope

Everything runs on the user's own subscription.

| Stage | Turns | Notes |
|---|---|---|
| ① Hypothesis pass | 1 (H) | once per review |
| ② Dual-model, per dual lens | ×2 the lens's turns | Flagged-only default |
| ③ Verification | ceil(K/batch) | K = non-obvious findings |

### Budget model

A per-review budget names sub-ceilings but all draw from ONE counter.
`;

const TASKS_MD = `# Tasks — Review Intelligence Core

This change is DESIGN ONLY.

## 0. Rai decisions (gate the build)

- [ ] 0.1 Confirm the hypothesis-first UX
- [x] 0.2 Confirm always-on vs opt-in

## 1. Shared types (types)

- [ ] 1.1 Add \`ReviewIntent\` (prTitle/prBody/spec)
- [ ] 1.2 Add \`ReviewHypothesisBody\` + \`HypothesisRisk\`
- [ ] 1.3 Add \`RiskCrossCheck\`
`;

const SPEC_DELTA_MD = `## ADDED Requirements

### Requirement: A hypothesis is committed before the lens runners read the diff
The system SHALL run a hypothesis pre-read pass that produces a committed \`review.hypothesis\` document BEFORE any lens runner reads the hunks.

#### Scenario: The hypothesis is produced from intent and repo context
- **WHEN** the pass runs over a change with a PR title/body and available repo context
- **THEN** it emits an admitted \`review.hypothesis\` document carrying a domain, an in/out scope, a design expectation, and between five and ten risks

#### Scenario: The pass forms a prior, not a diff summary
- **WHEN** the pass is invoked
- **THEN** it is fed the intent, the changed-file list, and the decomposition chunk titles
- **AND** it is NOT fed the full hunk line text

### Requirement: The pass degrades honestly when intent or repo context is absent
The pass SHALL run on whatever inputs are present and SHALL never fabricate an input.

#### Scenario: Missing repo context does not block the hypothesis
- **WHEN** the ProjectSnapshot backend returns a typed refusal for the review's base
- **THEN** the pass still produces a hypothesis from intent and structure and marks the repo context as absent
`;

const SOURCE: OpenSpecChangeSource = {
  name: "add-review-intelligence-core",
  proposalMd: PROPOSAL_MD,
  designMd: DESIGN_MD,
  tasksMd: TASKS_MD,
  specDeltas: [{ capability: "review-hypothesis-pass", md: SPEC_DELTA_MD }],
};

describe("parseOpenSpecChange — proposal", () => {
  it("names the change and structures every proposal section", () => {
    const change = parseOpenSpecChange(SOURCE);
    expect(change.name).toBe("add-review-intelligence-core");
    expect(change.proposal).toBeDefined();
  });

  it("parses the Why section as ordered blocks with a numbered list", () => {
    const { why } = present(parseOpenSpecChange(SOURCE).proposal);
    expect(why[0]).toMatchObject({
      kind: "paragraph",
      text: expect.stringContaining("REPLACE and SUPERSEDE"),
    });
    // Every reviewable block carries its source origin (artifact + 1-based line).
    expect(why[0]?.source).toMatchObject({ artifact: "proposal" });
    const list = why.find((block) => block.kind === "list");
    expect(list).toBeDefined();
    if (list?.kind === "list") {
      expect(list.ordered).toBe(true);
      expect(list.items[0]?.lead).toContain("Hypothesis-first pre-read pass");
    }
  });

  it("pulls the bold lead out of each What Changes item", () => {
    const { whatChanges } = present(parseOpenSpecChange(SOURCE).proposal);
    expect(whatChanges).toHaveLength(2);
    expect(whatChanges[0]?.lead).toContain("A hypothesis pre-read pass");
    expect(whatChanges[0]?.text).toContain("node-free core runner");
  });

  it("separates new from modified capabilities and names each", () => {
    const { newCapabilities, modifiedCapabilities } = present(parseOpenSpecChange(SOURCE).proposal);
    expect(newCapabilities.map((c) => c.name)).toEqual([
      "review-hypothesis-pass",
      "dual-model-lens-review",
      "per-finding-verification",
    ]);
    expect(newCapabilities[0]?.summary).toContain("pre-read hypothesis runner");
    expect(modifiedCapabilities).toHaveLength(1);
    expect(modifiedCapabilities[0]?.name).toBe("rsp-validator");
  });

  it("reads each Impact row as an area + detail", () => {
    const { impact } = present(parseOpenSpecChange(SOURCE).proposal);
    expect(impact.map((row) => row.area)).toEqual(["packages/types", "packages/protocol"]);
    expect(impact[0]?.detail).toContain("additive only");
  });
});

describe("parseOpenSpecChange — design", () => {
  it("builds an ordered section tree at level 2 and 3, dropping the H1 title", () => {
    const design = present(parseOpenSpecChange(SOURCE).design);
    const headings = design.sections.map((s) => s.heading);
    expect(headings).toEqual(["Context", "Cost/latency envelope", "Budget model"]);
    expect(design.sections[0]?.level).toBe(2);
    expect(design.sections[2]?.level).toBe(3);
    expect(design.sections[2]?.id).toBe("budget-model");
  });

  it("captures a fenced code block verbatim", () => {
    const design = present(parseOpenSpecChange(SOURCE).design);
    const context = design.sections[0];
    const code = context?.blocks.find((block) => block.kind === "code");
    expect(code).toBeDefined();
    if (code?.kind === "code") expect(code.code).toContain("runHypothesisPass");
  });

  it("parses a markdown table into headers and rows", () => {
    const design = present(parseOpenSpecChange(SOURCE).design);
    const cost = design.sections.find((s) => s.heading === "Cost/latency envelope");
    const table = cost?.blocks.find((block) => block.kind === "table");
    expect(table).toBeDefined();
    if (table?.kind === "table") {
      expect(table.headers).toEqual(["Stage", "Turns", "Notes"]);
      expect(table.rows).toHaveLength(3);
      expect(table.rows[0]?.[0]).toContain("Hypothesis pass");
    }
  });

  it("does NOT duplicate a nested ### child into its ## parent's body (regression #2)", () => {
    const design = present(parseOpenSpecChange(SOURCE).design);
    // `## Cost/latency envelope` owns `### Budget model` as a child. The parent's
    // body must STOP at the child — no literal `### Budget model` paragraph, and
    // none of the child's prose ("draw from ONE counter") bleeds up.
    const cost = present(design.sections.find((s) => s.heading === "Cost/latency envelope"));
    const parentText = cost.blocks
      .flatMap((b) => (b.kind === "paragraph" ? [b.text] : []))
      .join(" ");
    expect(parentText).not.toContain("Budget model");
    expect(parentText).not.toContain("draw from ONE counter");
    // The child section carries its own prose, exactly once.
    const budget = present(design.sections.find((s) => s.heading === "Budget model"));
    const childText = budget.blocks
      .flatMap((b) => (b.kind === "paragraph" ? [b.text] : []))
      .join(" ");
    expect(childText).toContain("draw from ONE counter");
    // No section renders the raw `### Budget model` heading text as body prose.
    const anyLiteralHeading = design.sections.some((section) =>
      section.blocks.some((b) => b.kind === "paragraph" && b.text.startsWith("### ")),
    );
    expect(anyLiteralHeading).toBe(false);
  });

  it("stamps each design section with its source (artifact + 1-based line)", () => {
    const design = present(parseOpenSpecChange(SOURCE).design);
    const context = present(design.sections[0]);
    expect(context.source).toMatchObject({ artifact: "design" });
    expect(context.source?.line).toBeGreaterThan(0);
  });
});

describe("parseOpenSpecChange — tasks", () => {
  it("groups the checklist and rolls up an honest progress count", () => {
    const tasks = present(parseOpenSpecChange(SOURCE).tasks);
    expect(tasks.groups.map((g) => g.title)).toEqual([
      "0. Rai decisions (gate the build)",
      "1. Shared types (types)",
    ]);
    expect(tasks.total).toBe(5);
    expect(tasks.done).toBe(1);
  });

  it("reads per-item checkbox state", () => {
    const tasks = present(parseOpenSpecChange(SOURCE).tasks);
    const rai = tasks.groups[0];
    expect(rai?.total).toBe(2);
    expect(rai?.done).toBe(1);
    expect(rai?.items[0]?.status).toBe("todo");
    expect(rai?.items[1]?.status).toBe("done");
    expect(rai?.items[1]?.text).toContain("always-on vs opt-in");
  });
});

describe("parseOpenSpecChange — spec deltas", () => {
  it("groups requirements under their delta operation", () => {
    const { specDeltas } = parseOpenSpecChange(SOURCE);
    expect(specDeltas).toHaveLength(1);
    const delta = specDeltas[0];
    expect(delta?.capability).toBe("review-hypothesis-pass");
    expect(delta?.groups).toHaveLength(1);
    expect(delta?.groups[0]?.operation).toBe("added");
    expect(delta?.groups[0]?.requirements).toHaveLength(2);
  });

  it("carries each requirement's SHALL statement and its scenarios", () => {
    const req = parseOpenSpecChange(SOURCE).specDeltas[0]?.groups[0]?.requirements[0];
    expect(req?.name).toBe("A hypothesis is committed before the lens runners read the diff");
    expect(req?.statement).toContain("SHALL run a hypothesis pre-read pass");
    expect(req?.scenarios).toHaveLength(2);
    expect(req?.scenarios[0]?.name).toBe("The hypothesis is produced from intent and repo context");
  });

  it("parses WHEN/THEN/AND scenario steps with their keywords", () => {
    const scenario =
      parseOpenSpecChange(SOURCE).specDeltas[0]?.groups[0]?.requirements[0]?.scenarios[1];
    expect(scenario?.name).toBe("The pass forms a prior, not a diff summary");
    expect(scenario?.steps.map((s) => s.keyword)).toEqual(["when", "then", "and"]);
    expect(scenario?.steps[2]?.text).toContain("NOT fed the full hunk line text");
  });

  it("keeps the second requirement and its scenario distinct from the first", () => {
    const reqs = parseOpenSpecChange(SOURCE).specDeltas[0]?.groups[0]?.requirements;
    expect(reqs?.[1]?.name).toBe(
      "The pass degrades honestly when intent or repo context is absent",
    );
    expect(reqs?.[1]?.scenarios).toHaveLength(1);
    expect(reqs?.[1]?.scenarios[0]?.name).toBe(
      "Missing repo context does not block the hypothesis",
    );
  });
});

describe("parseOpenSpecChange — tolerance", () => {
  it("parses a change with only a proposal, leaving other artifacts absent", () => {
    const change = parseOpenSpecChange({ name: "minimal", proposalMd: "## Why\n\nBecause.\n" });
    expect(change.proposal).toBeDefined();
    expect(change.design).toBeUndefined();
    expect(change.tasks).toBeUndefined();
    expect(change.specDeltas).toEqual([]);
  });

  it("never throws on an empty source", () => {
    const change = parseOpenSpecChange({ name: "empty" });
    expect(change.specDeltas).toEqual([]);
    expect(change.proposal).toBeUndefined();
  });
});
