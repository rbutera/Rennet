import type { OpenSpecChange } from "@rennet/types";
import { describe, expect, it } from "vitest";
import { anchorPathKey } from "./logic";
import {
  authorOpenSpecDisposition,
  buildOpenSpecView,
  classifyCoverage,
  type OpenSpecCoverageIndex,
  requirementAnchor,
} from "./openspec";

/** Narrow an optional to present, or fail the test loudly (no non-null assertions). */
function present<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error("expected a present value");
  return value;
}

// A shape-faithful change: proposal (why + capabilities), design, tasks, and one
// spec delta with TWO operation groups (added + modified) so operation attribution
// (issue #4) is exercised. Every reviewable node carries a `source` (artifact +
// 1-based line) so the durable-target anchoring (issue #1) is exercised too.
const CHANGE: OpenSpecChange = {
  name: "add-review-intelligence-core",
  proposal: {
    why: [
      {
        kind: "paragraph",
        text: "Rennet must supersede /review-pr.",
        source: { artifact: "proposal", line: 3 },
      },
    ],
    whatChanges: [{ lead: "A hypothesis pass", text: "runs before the lenses." }],
    newCapabilities: [
      {
        name: "review-hypothesis-pass",
        summary: "the pre-read runner",
        source: { artifact: "proposal", line: 20 },
      },
      {
        name: "dual-model-lens-review",
        summary: "two seats per lens",
        source: { artifact: "proposal", line: 21 },
      },
    ],
    modifiedCapabilities: [
      {
        name: "rsp-validator",
        summary: "gains a doc type",
        source: { artifact: "proposal", line: 26 },
      },
    ],
    impact: [{ area: "packages/types", detail: "additive only" }],
  },
  design: {
    sections: [
      {
        id: "context",
        level: 2,
        heading: "Context",
        blocks: [{ kind: "paragraph", text: "Live." }],
        source: { artifact: "design", line: 3 },
      },
      {
        id: "budget-model",
        level: 3,
        heading: "Budget model",
        blocks: [],
        source: { artifact: "design", line: 12 },
      },
    ],
  },
  tasks: {
    groups: [
      {
        id: "1-shared-types",
        title: "1. Shared types",
        items: [
          { text: "1.1 Add ReviewIntent", status: "done", source: { artifact: "tasks", line: 6 } },
          {
            text: "1.2 Add HypothesisRisk",
            status: "todo",
            source: { artifact: "tasks", line: 7 },
          },
        ],
        total: 2,
        done: 1,
        source: { artifact: "tasks", line: 5 },
      },
    ],
    total: 2,
    done: 1,
  },
  specDeltas: [
    {
      capability: "review-hypothesis-pass",
      source: { artifact: "spec", capability: "review-hypothesis-pass", line: 1 },
      groups: [
        {
          operation: "added",
          requirements: [
            {
              name: "A hypothesis is committed before the runners read the diff",
              statement: "The system SHALL run a hypothesis pre-read pass.",
              source: { artifact: "spec", capability: "review-hypothesis-pass", line: 3 },
              scenarios: [
                {
                  name: "The hypothesis is produced from intent",
                  source: { artifact: "spec", capability: "review-hypothesis-pass", line: 6 },
                  steps: [
                    { keyword: "when", text: "the pass runs" },
                    { keyword: "then", text: "it emits a document" },
                  ],
                },
              ],
            },
            {
              name: "The pass degrades honestly when context is absent",
              statement: "The pass SHALL never fabricate an input.",
              source: { artifact: "spec", capability: "review-hypothesis-pass", line: 11 },
              scenarios: [],
            },
          ],
        },
        {
          operation: "modified",
          requirements: [
            {
              name: "The validator gains the hypothesis doc type",
              statement: "The validator SHALL admit review.hypothesis.",
              source: { artifact: "spec", capability: "review-hypothesis-pass", line: 16 },
              scenarios: [],
            },
          ],
        },
      ],
    },
  ],
};

const CHANGE_KEY = "openspec/changes/add-review-intelligence-core";

describe("buildOpenSpecView — summary", () => {
  it("rolls up honest whole-change counts (across all operation groups)", () => {
    const view = buildOpenSpecView(CHANGE);
    expect(view.summary).toEqual({
      requirements: 3,
      scenarios: 1,
      specCapabilities: 1,
      capabilities: 3,
      tasksTotal: 2,
      tasksDone: 1,
      designSections: 2,
    });
  });
});

describe("buildOpenSpecView — operation groups (issue #4)", () => {
  it("preserves the operation groups rather than flattening them", () => {
    const view = buildOpenSpecView(CHANGE);
    const delta = present(view.specDeltas[0]);
    expect(delta.groups.map((g) => g.operation)).toEqual(["added", "modified"]);
    expect(delta.groups[0]?.requirements).toHaveLength(2);
    expect(delta.groups[1]?.requirements).toHaveLength(1);
    expect(delta.groups[1]?.requirements[0]?.requirement.name).toContain("validator gains");
  });
});

describe("buildOpenSpecView — anchoring", () => {
  it("gives the whole change a stable rollup anchor + a path-grained headline target", () => {
    const view = buildOpenSpecView(CHANGE);
    expect(view.changeAnchor.kind).toBe("change");
    expect(view.changeAnchor.key).toBe("openspec:add-review-intelligence-core");
    // The change ≈ its proposal doc, path-grained (no span).
    expect(view.changeAnchor.target).toEqual({ path: `${CHANGE_KEY}/proposal.md` });
  });

  it("splits new from modified capabilities, anchoring each to its proposal.md line", () => {
    const view = buildOpenSpecView(CHANGE);
    const caps = present(view.proposal).capabilities;
    expect(caps.map((c) => `${c.nature}:${c.note.name}`)).toEqual([
      "new:review-hypothesis-pass",
      "new:dual-model-lens-review",
      "modified:rsp-validator",
    ]);
    expect(caps[0]?.anchor.target).toEqual({
      path: `${CHANGE_KEY}/proposal.md`,
      span: { startLine: 20 },
      side: "additions",
    });
  });

  it("anchors each requirement to its spec.md file + line, distinct per requirement", () => {
    const view = buildOpenSpecView(CHANGE);
    const req = present(view.specDeltas[0]?.groups[0]?.requirements[0]);
    expect(req.anchor.kind).toBe("requirement");
    expect(req.anchor.target).toEqual({
      path: `${CHANGE_KEY}/specs/review-hypothesis-pass/spec.md`,
      span: { startLine: 3 },
      side: "additions",
    });
    // The scenario under it anchors to the SAME file at its own distinct line.
    expect(req.scenarioAnchors[0]?.target).toEqual({
      path: `${CHANGE_KEY}/specs/review-hypothesis-pass/spec.md`,
      span: { startLine: 6 },
      side: "additions",
    });
  });

  it("gives two requirements in one spec.md DISTINCT anchor identities (no collision)", () => {
    const view = buildOpenSpecView(CHANGE);
    const reqs = present(view.specDeltas[0]?.groups[0]?.requirements);
    const a = authorOpenSpecDisposition(present(reqs[0]).anchor, "comment").writes[0];
    const b = authorOpenSpecDisposition(present(reqs[1]).anchor, "comment").writes[0];
    // Same file path, but DIFFERENT span-grained identity — they coexist.
    expect(present(a).path).toBe(present(b).path);
    expect(anchorPathKey(present(a))).not.toBe(anchorPathKey(present(b)));
  });

  it("anchors task items to tasks.md, each at its own line", () => {
    const view = buildOpenSpecView(CHANGE);
    const group = present(view.taskGroups[0]);
    expect(group.itemAnchors).toHaveLength(2);
    expect(group.itemAnchors[0]?.target).toEqual({
      path: `${CHANGE_KEY}/tasks.md`,
      span: { startLine: 6 },
      side: "additions",
    });
    expect(group.itemAnchors[1]?.target?.span).toEqual({ startLine: 7 });
  });

  it("anchors each Why block to proposal.md", () => {
    const view = buildOpenSpecView(CHANGE);
    const whyAnchors = present(view.proposal).whyAnchors;
    expect(whyAnchors[0]?.target).toEqual({
      path: `${CHANGE_KEY}/proposal.md`,
      span: { startLine: 3 },
      side: "additions",
    });
  });

  it("derives the same key whether built into the view or requested directly", () => {
    const delta = present(CHANGE.specDeltas[0]);
    const requirement = present(present(delta.groups[0]).requirements[0]);
    const direct = requirementAnchor(CHANGE, delta, requirement);
    const view = buildOpenSpecView(CHANGE);
    expect(view.specDeltas[0]?.groups[0]?.requirements[0]?.anchor.key).toBe(direct.key);
  });
});

describe("authorOpenSpecDisposition — durable, span-grained (issue #1)", () => {
  it("writes against the REAL artifact file path + span (not the structural key)", () => {
    const view = buildOpenSpecView(CHANGE);
    const anchor = present(view.specDeltas[0]?.groups[0]?.requirements[0]?.anchor);
    const result = authorOpenSpecDisposition(anchor, "request-change", "needs a guard");
    expect(result.writes).toEqual([
      {
        path: `${CHANGE_KEY}/specs/review-hypothesis-pass/spec.md`,
        type: "request-change",
        body: "needs a guard",
        span: { startLine: 3 },
        side: "additions",
      },
    ]);
    // The trace source is the span-grained identity, stable per node.
    expect(result.trace.source).toBe(
      `${CHANGE_KEY}/specs/review-hypothesis-pass/spec.md#L3-L3@additions`,
    );
  });

  it("degrades to a path-grained structural key when the node has NO source", () => {
    // A source-less anchor (a hand-built fixture) has no durable target.
    const change: OpenSpecChange = { name: "x", specDeltas: [] };
    const view = buildOpenSpecView(change);
    const result = authorOpenSpecDisposition(view.changeAnchor, "comment");
    // No proposal/design/spec ⇒ no headline target ⇒ falls back to the structural key.
    expect(result.writes[0]?.path).toBe("openspec:x");
    expect(result.writes[0]?.span).toBeUndefined();
  });

  it("carries an empty body for a bare verb press", () => {
    const view = buildOpenSpecView(CHANGE);
    const result = authorOpenSpecDisposition(view.changeAnchor, "approve");
    expect(result.writes[0]?.body).toBe("");
    expect(result.writes[0]?.type).toBe("approve");
  });
});

describe("classifyCoverage (issue #9 / R53)", () => {
  it("returns no chip when coverage was NOT computed (never a fake unimplemented)", () => {
    expect(classifyCoverage(undefined)).toBeUndefined();
  });

  it("returns the honest unimplemented chip for a computed ZERO", () => {
    expect(classifyCoverage({ hunks: [], tests: 0 })).toEqual({ kind: "unimplemented" });
  });

  it("returns the covered chip carrying the claiming hunks + test count", () => {
    expect(classifyCoverage({ hunks: ["hunk:a", "hunk:b"], tests: 4 })).toEqual({
      kind: "covered",
      hunks: ["hunk:a", "hunk:b"],
      tests: 4,
    });
  });
});

describe("buildOpenSpecView — coverage attachment (issue #9 / R53)", () => {
  it("attaches ONLY the coverage the runner produced, by requirement anchor key", () => {
    const bare = buildOpenSpecView(CHANGE);
    // The runner covered the first requirement (2 hunks · 3 tests) and scored the
    // second at zero; it emitted nothing for the modified-group requirement.
    const firstKey = present(bare.specDeltas[0]?.groups[0]?.requirements[0]).anchor.key;
    const secondKey = present(bare.specDeltas[0]?.groups[0]?.requirements[1]).anchor.key;
    const coverage: OpenSpecCoverageIndex = new Map([
      [firstKey, { hunks: ["hunk:h1", "hunk:h2"], tests: 3 }],
      [secondKey, { hunks: [], tests: 0 }],
    ]);

    const view = buildOpenSpecView(CHANGE, coverage);
    const reqs = present(view.specDeltas[0]?.groups[0]?.requirements);
    expect(reqs[0]?.coverage).toEqual({ hunks: ["hunk:h1", "hunk:h2"], tests: 3 });
    // A computed zero is PRESENT-with-empty-hunks, distinct from uncomputed.
    expect(reqs[1]?.coverage).toEqual({ hunks: [], tests: 0 });
    // The modified-group requirement had no entry ⇒ coverage stays absent (no chip).
    expect(view.specDeltas[0]?.groups[1]?.requirements[0]?.coverage).toBeUndefined();
  });

  it("leaves every requirement's coverage absent when no index is passed (today's honest default)", () => {
    const view = buildOpenSpecView(CHANGE);
    for (const delta of view.specDeltas) {
      for (const group of delta.groups) {
        for (const req of group.requirements) expect(req.coverage).toBeUndefined();
      }
    }
  });
});

describe("buildOpenSpecView — tolerance", () => {
  it("handles a change with only spec deltas (no proposal/design/tasks)", () => {
    const view = buildOpenSpecView({
      name: "minimal",
      specDeltas: [{ capability: "x", groups: [{ operation: "added", requirements: [] }] }],
    });
    expect(view.proposal).toBeUndefined();
    expect(view.designSections).toEqual([]);
    expect(view.taskGroups).toEqual([]);
    expect(view.summary.requirements).toBe(0);
    expect(view.specDeltas).toHaveLength(1);
  });
});
