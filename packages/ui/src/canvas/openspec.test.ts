import type { Disposition, OpenSpecChange, OpenSpecReviewAnchor } from "@rennet/types";
import { describe, expect, it } from "vitest";
import {
  authorOpenSpecDisposition,
  buildOpenSpecView,
  dispositionsForAnchor,
  openSpecAnchors,
} from "./openspec";

const anchor = (path: string, label?: string): OpenSpecReviewAnchor => {
  const [artifact] = path.split(":") as [OpenSpecReviewAnchor["artifact"]];
  return {
    id: path,
    artifact,
    path: path.slice(path.indexOf(":") + 1),
    ...(label ? { label } : {}),
  };
};

const CHANGE: OpenSpecChange = {
  name: "sample-change",
  meta: { schema: "spec-driven", created: "2026-08-11" },
  proposal: {
    anchor: anchor("proposal:", "Proposal"),
    why: { heading: "Why", level: 2, body: "Because.", anchor: anchor("proposal:why", "Why") },
    whatChanges: {
      heading: "What Changes",
      level: 2,
      body: "Add a thing.",
      anchor: anchor("proposal:whatChanges", "What Changes"),
    },
    capabilities: [
      {
        kind: "new",
        name: "cap-a",
        description: "the new capability",
        anchor: anchor("proposal:capabilities/0", "cap-a"),
      },
    ],
    impact: {
      heading: "Impact",
      level: 2,
      body: "None.",
      anchor: anchor("proposal:impact", "Impact"),
    },
  },
  design: {
    anchor: anchor("design:", "Design"),
    sections: [
      {
        heading: "Overview",
        level: 2,
        body: "The shape.",
        anchor: anchor("design:sections/0", "Overview"),
        subsections: [
          {
            heading: "Detail",
            level: 3,
            body: "A nested detail.",
            anchor: anchor("design:sections/0/subsections/0", "Detail"),
          },
        ],
      },
    ],
  },
  tasks: {
    anchor: anchor("tasks:", "Tasks"),
    total: 2,
    completed: 1,
    groups: [
      {
        ordinal: "1",
        title: "Group",
        anchor: anchor("tasks:groups/0", "1. Group"),
        items: [
          {
            ordinal: "1.1",
            text: "done",
            checked: true,
            anchor: anchor("tasks:groups/0/items/0", "1.1"),
          },
          {
            ordinal: "1.2",
            text: "todo",
            checked: false,
            anchor: anchor("tasks:groups/0/items/1", "1.2"),
          },
        ],
      },
    ],
  },
  specDeltas: [
    {
      capability: "cap-a",
      requirementCount: 1,
      anchor: anchor("spec:cap-a", "cap-a"),
      operations: [
        {
          operation: "added",
          anchor: anchor("spec:cap-a/operations/0", "added"),
          requirements: [
            {
              name: "It works",
              text: "It SHALL work.",
              anchor: anchor("spec:cap-a/operations/0/requirements/0", "It works"),
              scenarios: [
                {
                  name: "the happy path",
                  steps: [
                    { keyword: "WHEN", text: "x" },
                    { keyword: "THEN", text: "y" },
                  ],
                  anchor: anchor(
                    "spec:cap-a/operations/0/requirements/0/scenarios/0",
                    "the happy path",
                  ),
                },
              ],
            },
          ],
        },
      ],
    },
  ],
};

describe("openSpecAnchors", () => {
  it("collects every reviewable anchor in document order", () => {
    const ids = openSpecAnchors(CHANGE).map((a) => a.id);
    expect(ids).toEqual([
      "proposal:",
      "proposal:why",
      "proposal:whatChanges",
      "proposal:capabilities/0",
      "proposal:impact",
      "design:",
      "design:sections/0",
      "design:sections/0/subsections/0",
      "tasks:",
      "tasks:groups/0",
      "tasks:groups/0/items/0",
      "tasks:groups/0/items/1",
      "spec:cap-a",
      "spec:cap-a/operations/0",
      "spec:cap-a/operations/0/requirements/0",
      "spec:cap-a/operations/0/requirements/0/scenarios/0",
    ]);
  });

  it("descends into nested design subsections", () => {
    const ids = openSpecAnchors(CHANGE).map((a) => a.id);
    expect(ids).toContain("design:sections/0/subsections/0");
  });
});

describe("buildOpenSpecView", () => {
  const disp = (path: string, type: Disposition["type"], body = ""): Disposition => ({
    anchor: { path, contentDigest: "d" },
    type,
    body,
  });

  it("keys dispositions to nodes by anchor id and ignores foreign ones", () => {
    const view = buildOpenSpecView(CHANGE, [
      disp("spec:cap-a/operations/0/requirements/0", "request-change", "this is wrong"),
      disp("proposal:why", "comment", "nice"),
      disp("spec:does-not-exist", "approve"), // foreign — must be ignored
    ]);
    expect(view.dispositionCount).toBe(2);
    const reqAnchor = view.anchors.find((a) => a.id === "spec:cap-a/operations/0/requirements/0");
    expect(reqAnchor).toBeDefined();
    if (reqAnchor) {
      const got = dispositionsForAnchor(view, reqAnchor);
      expect(got).toHaveLength(1);
      expect(got[0]?.type).toBe("request-change");
    }
    expect(view.dispositionsByAnchor.has("spec:does-not-exist")).toBe(false);
  });

  it("rolls up task progress", () => {
    const view = buildOpenSpecView(CHANGE);
    expect(view.taskProgress).toEqual({ total: 2, completed: 1, ratio: 0.5 });
  });

  it("guards a zero-task ratio", () => {
    const empty: OpenSpecChange = {
      ...CHANGE,
      tasks: { ...CHANGE.tasks, groups: [], total: 0, completed: 0 },
    };
    expect(buildOpenSpecView(empty).taskProgress.ratio).toBe(0);
  });
});

describe("authorOpenSpecDisposition", () => {
  it("produces a DispositionWrite keyed to the node's structural anchor id", () => {
    const target = anchor("spec:cap-a/operations/0/requirements/0/scenarios/0", "the happy path");
    expect(authorOpenSpecDisposition(target, "approve")).toEqual({
      path: "spec:cap-a/operations/0/requirements/0/scenarios/0",
      type: "approve",
      body: "",
    });
    expect(authorOpenSpecDisposition(target, "comment", "looks good").body).toBe("looks good");
  });
});
