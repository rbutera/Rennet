// @vitest-environment happy-dom
//
// The Spec angle (Rai, wireframes #9): this mounts the real `OpenSpecView` over a
// parsed change and drives it. It asserts the STRUCTURED rendering (requirement →
// scenario tree with WHEN/THEN steps, task checklist state, capability new/modified
// split, a table and a code block rendered structurally — never a markdown dump),
// and that the review affordances reuse the shared seams: a per-requirement
// DispositionCluster fires `onDispose` with the right anchor + verb, and the
// AskControl fires `onAsk`. Assertions are behavioural, not presence-only.
import type { OpenSpecChange } from "@rennet/types";
import { describe, expect, it, vi } from "vitest";
import { buildOpenSpecView, type OpenSpecReviewAnchor } from "../canvas/openspec";
import { mount } from "../test/dom";
import { OpenSpecView } from "./openspec";

const CHANGE: OpenSpecChange = {
  name: "add-review-intelligence-core",
  proposal: {
    why: [{ kind: "paragraph", text: "Rennet must supersede /review-pr." }],
    whatChanges: [{ lead: "A hypothesis pass", text: "runs before the lenses." }],
    newCapabilities: [{ name: "review-hypothesis-pass", summary: "the pre-read runner" }],
    modifiedCapabilities: [{ name: "rsp-validator", summary: "gains a doc type" }],
    impact: [{ area: "packages/types", detail: "additive only" }],
  },
  design: {
    sections: [
      {
        id: "cost",
        level: 2,
        heading: "Cost envelope",
        blocks: [
          { kind: "paragraph", text: "Runs on the user's subscription." },
          { kind: "code", language: "", code: "runHypothesisPass()" },
          {
            kind: "table",
            headers: ["Stage", "Turns"],
            rows: [["Hypothesis", "1"]],
          },
        ],
      },
    ],
  },
  tasks: {
    groups: [
      {
        id: "1-types",
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
          ],
        },
      ],
    },
  ],
};

describe("OpenSpecView — structured rendering", () => {
  it("renders the whole-change summary and requirement/scenario tree", () => {
    const view = buildOpenSpecView(CHANGE);
    const { getByText, container } = mount(<OpenSpecView view={view} onDispose={vi.fn()} />);

    // The requirement name and its SHALL statement render.
    getByText("A hypothesis is committed before the runners read the diff");
    getByText("The system SHALL run a hypothesis pre-read pass.");

    // The scenario's Gherkin steps render with their keywords, structurally.
    const steps = container.querySelectorAll(".ospec-step");
    expect(steps).toHaveLength(2);
    expect(steps[0]?.getAttribute("data-keyword")).toBe("when");
    expect(steps[0]?.textContent).toContain("the pass runs");
    expect(steps[1]?.getAttribute("data-keyword")).toBe("then");
  });

  it("renders the added-operation badge on the spec delta", () => {
    const view = buildOpenSpecView(CHANGE);
    const { container } = mount(<OpenSpecView view={view} onDispose={vi.fn()} />);
    const op = container.querySelector(".ospec-op");
    expect(op?.getAttribute("data-operation")).toBe("added");
    expect(op?.textContent).toBe("Added");
  });

  it("renders task checklist state and a progress roll-up", () => {
    const view = buildOpenSpecView(CHANGE);
    const { container, getByText } = mount(<OpenSpecView view={view} onDispose={vi.fn()} />);
    getByText("1 of 2 done");
    const items = container.querySelectorAll(".ospec-task-item");
    expect(items[0]?.getAttribute("data-status")).toBe("done");
    expect(items[1]?.getAttribute("data-status")).toBe("todo");
  });

  it("splits new from modified capabilities", () => {
    const view = buildOpenSpecView(CHANGE);
    const { container } = mount(<OpenSpecView view={view} onDispose={vi.fn()} />);
    const caps = container.querySelectorAll(".ospec-capability");
    expect(caps[0]?.getAttribute("data-nature")).toBe("new");
    expect(caps[1]?.getAttribute("data-nature")).toBe("modified");
  });

  it("renders a design table and code block structurally (not as markdown text)", () => {
    const view = buildOpenSpecView(CHANGE);
    const { container } = mount(<OpenSpecView view={view} onDispose={vi.fn()} />);
    const table = container.querySelector(".ospec-table");
    expect(table?.querySelectorAll("th")).toHaveLength(2);
    expect(table?.querySelectorAll("tbody tr")).toHaveLength(1);
    expect(container.querySelector(".ospec-code")?.textContent).toContain("runHypothesisPass");
  });
});

describe("OpenSpecView — review affordances reuse the seams", () => {
  it("fires onDispose with the requirement anchor and verb from its DispositionCluster", async () => {
    const view = buildOpenSpecView(CHANGE);
    const onDispose = vi.fn<(anchor: OpenSpecReviewAnchor, type: string) => void>();
    const { getByRole, user } = mount(<OpenSpecView view={view} onDispose={onDispose} />);

    // The requirement's compact cluster: "Request change on element <requirement>".
    const requirementAnchor = view.specDeltas[0]?.requirements[0]?.anchor;
    expect(requirementAnchor).toBeDefined();
    const button = getByRole("button", {
      name: `Request change on element ${requirementAnchor?.label}`,
    });
    await user.click(button);

    expect(onDispose).toHaveBeenCalledTimes(1);
    expect(onDispose.mock.calls[0]?.[0].key).toBe(requirementAnchor?.key);
    expect(onDispose.mock.calls[0]?.[1]).toBe("request-change");
  });

  it("fires onDispose with the whole-change rollup anchor from the header cluster", async () => {
    const view = buildOpenSpecView(CHANGE);
    const onDispose = vi.fn<(anchor: OpenSpecReviewAnchor, type: string) => void>();
    const { getByRole, user } = mount(<OpenSpecView view={view} onDispose={onDispose} />);
    await user.click(getByRole("button", { name: `Approve on roll-up ${view.name}` }));
    expect(onDispose.mock.calls[0][0].kind).toBe("change");
    expect(onDispose.mock.calls[0][1]).toBe("approve");
  });

  it("renders the ask control and fires onAsk (orchestrator default)", async () => {
    const view = buildOpenSpecView(CHANGE);
    const onAsk = vi.fn();
    const { getByRole, user } = mount(
      <OpenSpecView
        view={view}
        onDispose={vi.fn()}
        ask={{
          mode: "orchestrator",
          question: "why key per repo root?",
          onQuestionChange: vi.fn(),
          onModeChange: vi.fn(),
          onAsk,
        }}
      />,
    );
    await user.click(getByRole("button", { name: "Ask" }));
    expect(onAsk).toHaveBeenCalledTimes(1);
  });

  it("renders side-by-side answers with no synthesis when both models were asked", () => {
    const view = buildOpenSpecView(CHANGE);
    const { getByText } = mount(
      <OpenSpecView
        view={view}
        onDispose={vi.fn()}
        ask={{
          mode: "both",
          question: "is this safe?",
          result: {
            mode: "both",
            primary: { model: "orchestrator", answer: "yes, the budget is fail-closed" },
            secondOpinion: { model: "codex", answer: "agreed, with a caveat on retries" },
          },
          onQuestionChange: vi.fn(),
          onModeChange: vi.fn(),
          onAsk: vi.fn(),
        }}
      />,
    );
    getByText("yes, the budget is fail-closed");
    getByText("agreed, with a caveat on retries");
    getByText("no synthesis block · two answers, side by side · you decide");
  });
});
