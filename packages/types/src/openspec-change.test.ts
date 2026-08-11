import { describe, expect, it } from "vitest";
import type { OpenSpecChange, OpenSpecReviewAnchor } from "./index";

// Positive control for the OpenSpecChange model: a complete fixture typed as
// `OpenSpecChange` exercises every interface and the full nesting, so a wrong shape
// (a mistyped discriminant, a missing field, a dropped level) fails `typecheck`
// (the whole `src/**/*.ts` is tsc-checked). The runtime assertions pin the roll-up
// arithmetic and the discriminant vocabulary so a regression fails `test` too. It
// also documents, byte-for-byte, exactly what the parser (#14) must produce.

const anchor = (
  id: string,
  artifact: OpenSpecReviewAnchor["artifact"],
  path: string,
): OpenSpecReviewAnchor => ({
  id,
  artifact,
  path,
});

const change: OpenSpecChange = {
  name: "wire-live-end-to-end-review",
  meta: { schema: "spec-driven", created: "2026-08-10" },
  proposal: {
    anchor: anchor("proposal:", "proposal", ""),
    why: {
      heading: "Why",
      level: 2,
      body: "The pieces are built but do not run together.",
      anchor: anchor("proposal:why", "proposal", "why"),
    },
    whatChanges: {
      heading: "What Changes",
      level: 2,
      body: "Add the production backend.",
      anchor: anchor("proposal:whatChanges", "proposal", "whatChanges"),
    },
    capabilities: [
      {
        kind: "new",
        name: "live-end-to-end-review",
        description: "a production CanvasOpsBackend served to a live orchestrator",
        anchor: anchor("proposal:capabilities/0", "proposal", "capabilities/0"),
      },
    ],
    impact: {
      heading: "Impact",
      level: 2,
      body: "No new package, no dependency-arrow change.",
      anchor: anchor("proposal:impact", "proposal", "impact"),
    },
  },
  design: {
    anchor: anchor("design:", "design", ""),
    sections: [
      {
        heading: "The integration gap",
        level: 2,
        body: "CanvasOpsBackend is fake-only today.",
        anchor: anchor("design:sections/0", "design", "sections/0"),
      },
    ],
  },
  tasks: {
    anchor: anchor("tasks:", "tasks", ""),
    total: 2,
    completed: 1,
    groups: [
      {
        ordinal: "1",
        title: "Core: the pure review backend factory",
        anchor: anchor("tasks:groups/0", "tasks", "groups/0"),
        items: [
          {
            ordinal: "1.1",
            text: "reviewBackendCore(state)",
            checked: true,
            anchor: anchor("tasks:groups/0/items/0", "tasks", "groups/0/items/0"),
          },
          {
            ordinal: "1.2",
            text: "tests over a fixture review",
            checked: false,
            anchor: anchor("tasks:groups/0/items/1", "tasks", "groups/0/items/1"),
          },
        ],
      },
    ],
  },
  specDeltas: [
    {
      capability: "live-end-to-end-review",
      intro: "The wire-up that turns fixtures into a live product.",
      requirementCount: 1,
      anchor: anchor("spec:live-end-to-end-review", "spec", "live-end-to-end-review"),
      operations: [
        {
          operation: "added",
          anchor: anchor(
            "spec:live-end-to-end-review/operations/0",
            "spec",
            "live-end-to-end-review/operations/0",
          ),
          requirements: [
            {
              name: "A production CanvasOpsBackend composes the whole surface",
              text: "The composition SHALL implement every accessor over live state.",
              anchor: anchor(
                "spec:live-end-to-end-review/operations/0/requirements/0",
                "spec",
                "live-end-to-end-review/operations/0/requirements/0",
              ),
              scenarios: [
                {
                  name: "every accessor is backed by live state",
                  anchor: anchor(
                    "spec:live-end-to-end-review/operations/0/requirements/0/scenarios/0",
                    "spec",
                    "live-end-to-end-review/operations/0/requirements/0/scenarios/0",
                  ),
                  steps: [
                    { keyword: "WHEN", text: "the backend is built for a live review" },
                    { keyword: "THEN", text: "no accessor returns fake data" },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  ],
};

describe("OpenSpecChange model", () => {
  it("carries the four proposal sections and the structured capability deltas", () => {
    expect(change.proposal.why.heading).toBe("Why");
    expect(change.proposal.capabilities[0]?.kind).toBe("new");
    expect(change.proposal.impact.level).toBe(2);
  });

  it("rolls up the task checklist state", () => {
    const items = change.tasks.groups.flatMap((group) => group.items);
    expect(items).toHaveLength(change.tasks.total);
    expect(items.filter((item) => item.checked)).toHaveLength(change.tasks.completed);
  });

  it("nests spec deltas capability → operation → requirement → scenario", () => {
    const delta = change.specDeltas[0];
    expect(delta?.capability).toBe("live-end-to-end-review");
    expect(delta?.operations[0]?.operation).toBe("added");
    expect(delta?.operations[0]?.requirements[0]?.scenarios[0]?.steps[0]?.keyword).toBe("WHEN");
  });

  it("puts a structural review anchor on every node, id = artifact:path", () => {
    const a = change.specDeltas[0]?.operations[0]?.requirements[0]?.scenarios[0]?.anchor;
    expect(a?.artifact).toBe("spec");
    expect(a?.id).toBe(`${a?.artifact}:${a?.path}`);
  });
});
