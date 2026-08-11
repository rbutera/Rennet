// @vitest-environment happy-dom
//
// The OpenSpec change view (#15): mounts the real `OpenSpecView` over a derived
// `OpenSpecView` model and drives it — the header progress renders, a capability
// badge and a requirement/scenario render, an existing disposition shows at its
// node, clicking a node's review verb fires the host with a `DispositionWrite`
// keyed to that node's STRUCTURAL anchor, and the reused Ask control mounts.
// Assertions are behavioural (rendered text, the fired write), not presence-only.
import type { Disposition, OpenSpecChange, OpenSpecReviewAnchor } from "@rennet/types";
import { describe, expect, it, vi } from "vitest";
import type { DispositionWrite } from "../canvas/logic";
import { buildOpenSpecView } from "../canvas/openspec";
import { fireEvent, mount } from "../test/dom";
import { OpenSpecView } from "./openspec";

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
    why: { heading: "Why", level: 2, body: "Because.", anchor: anchor("proposal:why") },
    whatChanges: {
      heading: "What Changes",
      level: 2,
      body: "Add a thing.",
      anchor: anchor("proposal:whatChanges"),
    },
    capabilities: [
      {
        kind: "new",
        name: "cap-a",
        description: "the new capability",
        anchor: anchor("proposal:capabilities/0"),
      },
    ],
    impact: { heading: "Impact", level: 2, body: "None.", anchor: anchor("proposal:impact") },
  },
  tasks: {
    anchor: anchor("tasks:", "Tasks"),
    total: 2,
    completed: 1,
    groups: [
      {
        ordinal: "1",
        title: "Group",
        anchor: anchor("tasks:groups/0"),
        items: [
          {
            ordinal: "1.1",
            text: "done item",
            checked: true,
            anchor: anchor("tasks:groups/0/items/0"),
          },
          {
            ordinal: "1.2",
            text: "todo item",
            checked: false,
            anchor: anchor("tasks:groups/0/items/1"),
          },
        ],
      },
    ],
  },
  specDeltas: [
    {
      capability: "cap-a",
      requirementCount: 1,
      anchor: anchor("spec:cap-a"),
      operations: [
        {
          operation: "added",
          anchor: anchor("spec:cap-a/operations/0"),
          requirements: [
            {
              name: "It works",
              text: "It SHALL work.",
              anchor: anchor("spec:cap-a/operations/0/requirements/0"),
              scenarios: [
                {
                  name: "the happy path",
                  steps: [
                    { keyword: "WHEN", text: "x happens" },
                    { keyword: "THEN", text: "y follows" },
                  ],
                  anchor: anchor("spec:cap-a/operations/0/requirements/0/scenarios/0"),
                },
              ],
            },
          ],
        },
      ],
    },
  ],
};

function verb(
  container: HTMLElement,
  anchorId: string,
  type: Disposition["type"],
): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>(
    `[data-anchor="${anchorId}"] .disposition-cluster-btn[data-type="${type}"]`,
  );
  if (!button) throw new Error(`no ${type} verb on node ${anchorId}`);
  return button;
}

describe("OpenSpecView — the reviewable change document", () => {
  it("renders the header, task progress, capability, requirement, scenario and steps", () => {
    const view = buildOpenSpecView(CHANGE);
    const { container, getByText } = mount(
      <OpenSpecView view={view} onAuthorDisposition={vi.fn()} />,
    );
    expect(container.querySelector(".openspec-name")?.textContent).toBe("sample-change");
    expect(getByText("1/2 tasks")).toBeTruthy();
    // Capability badge + name.
    expect(container.querySelector(".openspec-cap-kind-new")?.textContent).toBe("new");
    expect(container.querySelector(".openspec-cap-name")?.textContent).toBe("cap-a");
    // Spec delta down to scenario steps.
    expect(getByText("It works")).toBeTruthy();
    expect(getByText("the happy path")).toBeTruthy();
    expect(getByText("x happens")).toBeTruthy();
    // Task checkbox state is reflected.
    expect(container.querySelector('.openspec-task[data-checked="true"]')).not.toBeNull();
  });

  it("fires a DispositionWrite keyed to the node's structural anchor when a verb is clicked", () => {
    const view = buildOpenSpecView(CHANGE);
    const writes: DispositionWrite[] = [];
    const { container } = mount(
      <OpenSpecView view={view} onAuthorDisposition={(write) => writes.push(write)} />,
    );
    fireEvent.click(verb(container, "spec:cap-a/operations/0/requirements/0", "request-change"));
    fireEvent.click(verb(container, "proposal:capabilities/0", "approve"));
    expect(writes).toEqual([
      { path: "spec:cap-a/operations/0/requirements/0", type: "request-change", body: "" },
      { path: "proposal:capabilities/0", type: "approve", body: "" },
    ]);
  });

  it("shows dispositions already authored against a node", () => {
    const view = buildOpenSpecView(CHANGE, [
      {
        anchor: { path: "spec:cap-a/operations/0/requirements/0/scenarios/0", contentDigest: "d" },
        type: "comment",
        body: "this scenario is underspecified",
      },
    ]);
    const { container } = mount(<OpenSpecView view={view} onAuthorDisposition={vi.fn()} />);
    const node = container.querySelector(
      '[data-anchor="spec:cap-a/operations/0/requirements/0/scenarios/0"] .openspec-disposition[data-type="comment"]',
    );
    expect(node?.textContent).toContain("this scenario is underspecified");
    // The header count reflects the keyed disposition.
    expect(
      container.querySelector('.openspec-meta-chip[data-key="dispositions"]')?.textContent,
    ).toContain("1");
  });

  it("mounts the reused Ask control when an ask thread is provided", () => {
    const view = buildOpenSpecView(CHANGE);
    const { container } = mount(
      <OpenSpecView
        view={view}
        onAuthorDisposition={vi.fn()}
        ask={{
          mode: "orchestrator",
          question: "",
          onQuestionChange: vi.fn(),
          onModeChange: vi.fn(),
          onAsk: vi.fn(),
        }}
      />,
    );
    expect(container.querySelector(".openspec-ask .ask-control")).not.toBeNull();
  });
});
