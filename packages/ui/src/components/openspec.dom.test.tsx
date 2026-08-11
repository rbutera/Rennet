// @vitest-environment happy-dom
//
// The Spec angle (Rai, wireframes #9): this mounts the real `OpenSpecView` over a
// parsed change and drives it. It asserts the STRUCTURED rendering (requirement →
// scenario tree with WHEN/THEN steps, task checklist state, capability new/modified
// split, a table and a code block rendered structurally — never a markdown dump),
// and that the review affordances reuse the shared seams: a per-requirement
// DispositionCluster fires `onDispose` with the right anchor + verb, and the
// AskControl fires `onAsk`. Assertions are behavioural, not presence-only.
import { openSpecRequirementCoverageKey } from "@rennet/protocol";
import type { OpenSpecChange } from "@rennet/types";
import { describe, expect, it, vi } from "vitest";
import {
  buildOpenSpecView,
  type OpenSpecCoverageIndex,
  type OpenSpecReviewAnchor,
} from "../canvas/openspec";
import { mount } from "../test/dom";
import { OpenSpecView } from "./openspec";

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
          ],
        },
        {
          operation: "modified",
          requirements: [
            {
              name: "The validator admits the new doc type",
              statement: "The validator SHALL admit review.hypothesis.",
              source: { artifact: "spec", capability: "review-hypothesis-pass", line: 12 },
              scenarios: [],
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

  it("keeps operation attribution per requirement (issue #4): added + modified groups", () => {
    const view = buildOpenSpecView(CHANGE);
    const { container } = mount(<OpenSpecView view={view} onDispose={vi.fn()} />);
    // Two operation groups render, each as its own subsection.
    const groups = container.querySelectorAll(".ospec-op-group");
    expect(groups).toHaveLength(2);
    expect(groups[0]?.getAttribute("data-operation")).toBe("added");
    expect(groups[1]?.getAttribute("data-operation")).toBe("modified");
    // Each requirement carries its OWN operation, so a mixed delta is legible.
    const requirements = container.querySelectorAll(".ospec-requirement");
    expect(requirements[0]?.getAttribute("data-operation")).toBe("added");
    expect(requirements[1]?.getAttribute("data-operation")).toBe("modified");
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
    const requirementAnchor = view.specDeltas[0]?.groups[0]?.requirements[0]?.anchor;
    expect(requirementAnchor).toBeDefined();
    const button = getByRole("button", {
      name: `Request change on element ${requirementAnchor?.label}`,
    });
    await user.click(button);

    expect(onDispose).toHaveBeenCalledTimes(1);
    expect(onDispose.mock.calls[0]?.[0].key).toBe(requirementAnchor?.key);
    // The write goes to the REAL spec.md file + span, not the structural key (issue #1).
    expect(onDispose.mock.calls[0]?.[0].target?.path).toContain(
      "specs/review-hypothesis-pass/spec.md",
    );
    expect(onDispose.mock.calls[0]?.[1]).toBe("request-change");
  });

  it("renders review clusters on scenarios, task items, and Why blocks (issue #3)", async () => {
    const view = buildOpenSpecView(CHANGE);
    const onDispose = vi.fn<(anchor: OpenSpecReviewAnchor, type: string) => void>();
    const { getByRole, user } = mount(<OpenSpecView view={view} onDispose={onDispose} />);

    // A scenario now carries its own cluster (was React-key-only before).
    await user.click(
      getByRole("button", { name: "Comment on element The hypothesis is produced from intent" }),
    );
    expect(onDispose.mock.calls[0]?.[0].kind).toBe("scenario");

    // A task item carries a cluster, anchored to its tasks.md line.
    await user.click(getByRole("button", { name: "Question on element 1.1 Add ReviewIntent" }));
    expect(onDispose.mock.calls[1]?.[0].kind).toBe("task-item");
    expect(onDispose.mock.calls[1]?.[0].target?.path).toContain("tasks.md");

    // A Why block carries a cluster, anchored to proposal.md.
    await user.click(getByRole("button", { name: "Comment on element why · block 1" }));
    expect(onDispose.mock.calls[2]?.[0].kind).toBe("why-block");
    expect(onDispose.mock.calls[2]?.[0].target?.path).toContain("proposal.md");
  });

  it("fires onDispose with the whole-change rollup anchor from the header cluster", async () => {
    const view = buildOpenSpecView(CHANGE);
    const onDispose = vi.fn<(anchor: OpenSpecReviewAnchor, type: string) => void>();
    const { getByRole, user } = mount(<OpenSpecView view={view} onDispose={onDispose} />);
    await user.click(getByRole("button", { name: `Approve on roll-up ${view.name}` }));
    expect(onDispose.mock.calls[0]?.[0].kind).toBe("change");
    expect(onDispose.mock.calls[0]?.[1]).toBe("approve");
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

  it("renders no coverage chip when the mapping was not computed (no fabricated number)", () => {
    const view = buildOpenSpecView(CHANGE);
    const { container } = mount(<OpenSpecView view={view} onDispose={vi.fn()} />);
    expect(container.querySelector(".ospec-covchip")).toBeNull();
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

describe("OpenSpecView — coverage chips (issue #9 / R53)", () => {
  // The runner's GROUNDED output for THIS change: the added requirement is covered by
  // one implementing hunk and two tests — `hunks` and `tests` are INDEPENDENT grounded
  // counts (one impl hunk + two distinct test files), so 1-hunk·2-tests is a real
  // producible state, not a contradiction. The modified requirement is a computed
  // zero. Keyed by (capability, name) — the SAME key a real mapping producer emits.
  const cap = "review-hypothesis-pass";
  const coverage: OpenSpecCoverageIndex = new Map([
    [
      openSpecRequirementCoverageKey(
        cap,
        "A hypothesis is committed before the runners read the diff",
      ),
      { hunks: ["rennet:hunk/claim-1"], tests: 2 },
    ],
    [
      openSpecRequirementCoverageKey(cap, "The validator admits the new doc type"),
      { hunks: [], tests: 0 },
    ],
  ]);

  it("renders 'covered by N hunks · M tests' (honest singular/plural) and 'unimplemented · 0 hunks'", () => {
    const view = buildOpenSpecView(CHANGE, coverage);
    const { getByText, container } = mount(<OpenSpecView view={view} onDispose={vi.fn()} />);

    // Covered: one hunk (singular), two tests (plural).
    getByText("covered by 1 hunk · 2 tests");
    // The honest computed zero reads as the amber unimplemented chip.
    const zero = getByText("unimplemented · 0 hunks");
    expect(zero.closest(".ospec-covchip-zero")).not.toBeNull();
    expect(zero.getAttribute("data-coverage")).toBe("unimplemented");
    // The zero chip is a plain label, never an actionable button.
    expect(zero.closest("button")).toBeNull();
    // Exactly two chips render (one per requirement that had a mapping entry).
    expect(container.querySelectorAll(".ospec-covchip")).toHaveLength(2);
  });

  it("jumps to the FIRST claiming hunk when a covered chip is clicked", async () => {
    const view = buildOpenSpecView(CHANGE, coverage);
    const onJumpToHunk = vi.fn<(anchor: string) => void>();
    const { getByRole, user } = mount(
      <OpenSpecView view={view} onDispose={vi.fn()} onJumpToHunk={onJumpToHunk} />,
    );
    await user.click(
      getByRole("button", { name: "covered by 1 hunk · 2 tests — jump to the claiming hunk" }),
    );
    expect(onJumpToHunk).toHaveBeenCalledTimes(1);
    expect(onJumpToHunk).toHaveBeenCalledWith("rennet:hunk/claim-1");
  });

  it("renders a covered chip as a STATIC label when no jump is wired (still honest)", () => {
    const view = buildOpenSpecView(CHANGE, coverage);
    const { getByText } = mount(<OpenSpecView view={view} onDispose={vi.fn()} />);
    const covered = getByText("covered by 1 hunk · 2 tests");
    expect(covered.closest("button")).toBeNull();
    expect(covered.closest(".ospec-covchip")?.getAttribute("data-coverage")).toBe("covered");
  });
});
