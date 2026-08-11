import type { OpenSpecChange } from "@rennet/types";
import { describe, expect, it } from "vitest";
import { authorOpenSpecDisposition, buildOpenSpecView, requirementAnchor } from "./openspec";

// A small but shape-faithful change (proposal + design + tasks + one spec delta
// with two requirements, one carrying a scenario). Exercises anchoring, the
// new/modified capability split, the summary roll-up, and disposition authoring.
const CHANGE: OpenSpecChange = {
  name: "add-review-intelligence-core",
  proposal: {
    why: [{ kind: "paragraph", text: "Rennet must supersede /review-pr." }],
    whatChanges: [{ lead: "A hypothesis pass", text: "runs before the lenses." }],
    newCapabilities: [
      { name: "review-hypothesis-pass", summary: "the pre-read runner" },
      { name: "dual-model-lens-review", summary: "two seats per lens" },
    ],
    modifiedCapabilities: [{ name: "rsp-validator", summary: "gains a doc type" }],
    impact: [{ area: "packages/types", detail: "additive only" }],
  },
  design: {
    sections: [
      {
        id: "context",
        level: 2,
        heading: "Context",
        blocks: [{ kind: "paragraph", text: "Live." }],
      },
      { id: "budget-model", level: 3, heading: "Budget model", blocks: [] },
    ],
  },
  tasks: {
    groups: [
      {
        id: "1-shared-types",
        title: "1. Shared types",
        items: [
          { text: "1.1 Add ReviewIntent", status: "done" },
          { text: "1.2 Add HypothesisRisk", status: "todo" },
        ],
        total: 2,
        done: 1,
      },
    ],
    total: 2,
    done: 1,
  },
  specDeltas: [
    {
      capability: "review-hypothesis-pass",
      groups: [
        {
          operation: "added",
          requirements: [
            {
              name: "A hypothesis is committed before the runners read the diff",
              statement: "The system SHALL run a hypothesis pre-read pass.",
              scenarios: [
                {
                  name: "The hypothesis is produced from intent",
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
              scenarios: [],
            },
          ],
        },
      ],
    },
  ],
};

describe("buildOpenSpecView — summary", () => {
  it("rolls up honest whole-change counts", () => {
    const view = buildOpenSpecView(CHANGE);
    expect(view.summary).toEqual({
      requirements: 2,
      scenarios: 1,
      specCapabilities: 1,
      capabilities: 3,
      tasksTotal: 2,
      tasksDone: 1,
      designSections: 2,
    });
  });
});

describe("buildOpenSpecView — anchoring", () => {
  it("gives the whole change a stable rollup anchor", () => {
    const view = buildOpenSpecView(CHANGE);
    expect(view.changeAnchor.kind).toBe("change");
    expect(view.changeAnchor.key).toBe("openspec:add-review-intelligence-core");
  });

  it("splits new from modified capabilities and anchors each", () => {
    const view = buildOpenSpecView(CHANGE);
    const caps = view.proposal!.capabilities;
    expect(caps.map((c) => `${c.nature}:${c.note.name}`)).toEqual([
      "new:review-hypothesis-pass",
      "new:dual-model-lens-review",
      "modified:rsp-validator",
    ]);
    expect(caps[0]?.anchor.key).toBe(
      "openspec:add-review-intelligence-core/capability/review-hypothesis-pass",
    );
  });

  it("anchors each requirement and its scenarios under the capability path", () => {
    const view = buildOpenSpecView(CHANGE);
    const req = view.specDeltas[0]?.requirements[0];
    expect(req?.anchor.kind).toBe("requirement");
    expect(req?.anchor.key).toBe(
      "openspec:add-review-intelligence-core/spec/review-hypothesis-pass/a-hypothesis-is-committed-before-the-runners-read-the-diff",
    );
    expect(req?.scenarioAnchors).toHaveLength(1);
    expect(req?.scenarioAnchors[0]?.key).toContain(
      "/a-hypothesis-is-committed-before-the-runners-read-the-diff/the-hypothesis-is-produced-from-intent",
    );
  });

  it("keeps requirement anchors distinct within a capability", () => {
    const view = buildOpenSpecView(CHANGE);
    const [a, b] = view.specDeltas[0]?.requirements ?? [];
    expect(a?.anchor.key).not.toBe(b?.anchor.key);
    expect(a?.anchor.key).toBeDefined();
  });

  it("derives the same key whether built into the view or requested directly", () => {
    const delta = CHANGE.specDeltas[0]!;
    const requirement = delta.groups[0]!.requirements[0]!;
    const direct = requirementAnchor(CHANGE, delta, requirement);
    const view = buildOpenSpecView(CHANGE);
    expect(view.specDeltas[0]?.requirements[0]?.anchor.key).toBe(direct.key);
  });
});

describe("authorOpenSpecDisposition", () => {
  it("produces one DispositionWrite keyed by the anchor, plus a trace", () => {
    const view = buildOpenSpecView(CHANGE);
    const anchor = view.specDeltas[0]?.requirements[0]?.anchor;
    expect(anchor).toBeDefined();
    const result = authorOpenSpecDisposition(anchor!, "request-change", "this needs a guard");
    expect(result.writes).toEqual([
      { path: anchor!.key, type: "request-change", body: "this needs a guard" },
    ]);
    expect(result.trace).toEqual({
      granularity: "element",
      source: anchor!.key,
      writes: result.writes,
    });
  });

  it("carries an empty body for a bare verb press", () => {
    const view = buildOpenSpecView(CHANGE);
    const result = authorOpenSpecDisposition(view.changeAnchor, "approve");
    expect(result.writes[0]?.body).toBe("");
    expect(result.writes[0]?.type).toBe("approve");
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
