// @vitest-environment happy-dom
import type { HostElement, LensBoard } from "@rennet/protocol";
import { beforeEach, describe, expect, it } from "vitest";
import { BridgeProvider } from "../data";
import { useRennetStore } from "../store";
import { mount, waitFor } from "../test/dom";
import { MemoryBridge, refusesSpanRead } from "../test/memory-bridge";
import { LensBoardView } from "./board-view";
import { BoardElement, BoardElementsProvider } from "./kinds";
import { Section } from "./section";

const author = { kind: "lens-agent", id: "lens:design" } as const;

beforeEach(() => useRennetStore.setState({ viewedDelta: { viewedDeltaSections: {} } }));

describe("Design board document metadata", () => {
  it("renders header stats, jumps from the artifact chip, and opens the exact section source", async () => {
    const board: LensBoard = {
      lens: "design",
      generation: "gen-design",
      boardId: "board-design",
      document: {
        title: "Credential refresh",
        introMarkdown: "The proposal adds observable refresh outcomes.",
        measure: "structured",
        stats: [
          { label: "Capabilities", value: "2 added · 1 modified" },
          { label: "Tasks", value: "11/13" },
        ],
        sources: [
          {
            path: "openspec/changes/refresh/design.md",
            label: "design.md",
            line: 14,
          },
        ],
      },
      sections: [{ ref: "design-source", gist: "Refresh design.", counts: {} }],
      elements: [
        {
          id: "design-source",
          kind: "section",
          data: {
            author,
            title: "Design",
            children: [],
            sources: [
              {
                path: "openspec/changes/refresh/design.md",
                label: "design.md",
                line: 14,
              },
            ],
          },
        },
      ],
      skippedHunks: [],
    };
    const opened: Array<{ reviewId: string; path: string; line?: number }> = [];
    const bridge = new MemoryBridge({
      "board.read": ({ generation, lens }) => ({
        board: generation === board.generation && lens === "design" ? board : null,
      }),
      "review.openInEditor": (input) => {
        opened.push(input);
        return { ok: true };
      },
    });
    const view = mount(
      <BridgeProvider bridge={bridge}>
        <LensBoardView reviewId="review-design" generation={board.generation} lens="design" />
      </BridgeProvider>,
    );

    expect(await view.findByText("2 added · 1 modified")).toBeTruthy();
    expect(view.getByText("11/13")).toBeTruthy();
    expect(view.getByRole("link", { name: "Jump to design.md" }).getAttribute("href")).toBe(
      "#design-source",
    );
    await view.user.click(view.getByRole("button", { name: "Open design.md in editor" }));
    await waitFor(() =>
      expect(opened).toEqual([
        {
          reviewId: "review-design",
          path: "openspec/changes/refresh/design.md",
          line: 14,
        },
      ]),
    );
  });

  it("composes the proposal spine, capability jumps, and grouped task progress", async () => {
    const elements: HostElement[] = [
      {
        id: "proposal",
        kind: "section",
        data: {
          author,
          title: "Proposal",
          children: ["proposal-summary", "what-changes", "impact"],
          sources: [{ path: "openspec/changes/refresh/proposal.md" }],
        },
      },
      {
        id: "proposal-summary",
        kind: "prose",
        data: { author, markdown: "Refresh failures currently collapse into one prompt." },
      },
      {
        id: "what-changes",
        kind: "section",
        data: {
          author,
          title: "What Changes",
          children: ["refresh-log", "retry-owner"],
        },
      },
      {
        id: "refresh-log",
        kind: "prose",
        data: { author, markdown: "Record every refresh attempt and outcome." },
      },
      {
        id: "retry-owner",
        kind: "prose",
        data: { author, markdown: "Move safe retry to the shared transport." },
      },
      {
        id: "impact",
        kind: "section",
        data: { author, title: "Impact", children: ["impact-body"] },
      },
      {
        id: "impact-body",
        kind: "prose",
        data: { author, markdown: "Adapters only. No new package or dependency." },
      },
      {
        id: "refresh-observability",
        kind: "section",
        data: {
          author,
          title: "Refresh observability",
          children: ["req-attempt", "req-outcome", "scenario-attempt", "scenario-outcome"],
          spec_delta: "added",
        },
      },
      {
        id: "req-attempt",
        kind: "requirement",
        data: {
          author,
          name: "Attempt is visible",
          capability: "refresh-observability",
          shall: "The daemon SHALL record each refresh attempt.",
          scenarios: ["scenario-attempt"],
          spec_delta: "added",
        },
      },
      {
        id: "req-outcome",
        kind: "requirement",
        data: {
          author,
          name: "Outcome is visible",
          capability: "refresh-observability",
          shall: "The daemon SHALL record each refresh outcome.",
          scenarios: ["scenario-outcome", "scenario-decline"],
          spec_delta: "added",
        },
      },
      {
        id: "scenario-attempt",
        kind: "prose",
        data: { author, markdown: "WHEN refresh begins THEN an attempt is recorded." },
      },
      {
        id: "scenario-outcome",
        kind: "prose",
        data: { author, markdown: "WHEN refresh succeeds THEN persisted is recorded." },
      },
      {
        id: "scenario-decline",
        kind: "prose",
        data: { author, markdown: "WHEN refresh is declined THEN its code is recorded." },
      },
      {
        id: "github-auth",
        kind: "section",
        data: {
          author,
          title: "GitHub auth",
          children: ["req-retry"],
          spec_delta: "modified",
        },
      },
      {
        id: "req-retry",
        kind: "requirement",
        data: {
          author,
          name: "Retry has one owner",
          capability: "github-auth",
          shall: "The refresh path SHALL call the exchange once.",
          scenarios: [],
          spec_delta: "modified",
        },
      },
      {
        id: "tasks",
        kind: "section",
        data: {
          author,
          title: "Tasks",
          children: ["record-type", "field-proof"],
          sources: [{ path: "openspec/changes/refresh/tasks.md" }],
        },
      },
      {
        id: "record-type",
        kind: "section",
        data: {
          author,
          title: "1 · Secret-free record type",
          children: ["task-record", "task-export"],
        },
      },
      {
        id: "task-record",
        kind: "prose",
        data: { author, markdown: "- [x] Define RefreshLogRecord." },
      },
      {
        id: "task-export",
        kind: "prose",
        data: { author, markdown: "- [x] Export the record type." },
      },
      {
        id: "field-proof",
        kind: "section",
        data: {
          author,
          title: "2 · Field proof",
          children: ["task-run", "task-capture"],
        },
      },
      {
        id: "task-run",
        kind: "prose",
        data: { author, markdown: "- [ ] Force a real refresh." },
      },
      {
        id: "task-capture",
        kind: "prose",
        data: { author, markdown: "- [x] Capture the decline code." },
      },
    ];
    const board: LensBoard = {
      lens: "design",
      generation: "gen-structure",
      boardId: "board-structure",
      document: {
        title: "Credential refresh",
        introMarkdown: "The proposal makes refresh outcomes observable.",
        measure: "structured",
      },
      sections: [
        { ref: "proposal", gist: "Why this change exists.", counts: {} },
        {
          ref: "refresh-observability",
          gist: "Refresh attempts and outcomes become visible.",
          counts: { requirements: 2 },
        },
        {
          ref: "github-auth",
          gist: "Retry ownership moves out of refresh.",
          counts: { requirements: 1 },
        },
        { ref: "tasks", gist: "Three of four tasks are done.", counts: {} },
      ],
      elements,
      skippedHunks: [],
    };
    const view = mount(
      <BridgeProvider
        bridge={
          new MemoryBridge({
            "board.read": ({ generation, lens }) => ({
              board: generation === board.generation && lens === "design" ? board : null,
            }),
          })
        }
      >
        <LensBoardView reviewId="review-structure" generation={board.generation} lens="design" />
      </BridgeProvider>,
    );

    expect(await view.findByText("Capabilities")).toBeTruthy();

    const spine = view.container.querySelector('[data-kind="design-proposal-spine"]');
    expect(spine?.querySelectorAll('[data-kind="design-change-row"]')).toHaveLength(2);
    expect(view.getByText("refresh-log")).toBeTruthy();
    expect(view.getByText("retry-owner")).toBeTruthy();
    expect(spine?.querySelector('[data-kind="design-impact"]')?.textContent).toContain(
      "Adapters only. No new package or dependency.",
    );

    const capabilityGrid = view.container.querySelector('[data-kind="capability-grid"]');
    const added = capabilityGrid?.querySelector<HTMLAnchorElement>(
      '[data-capability="refresh-observability"]',
    );
    expect(added?.getAttribute("href")).toBe("#refresh-observability");
    expect(added?.className).toContain("border-l-green-line");
    expect(added?.textContent).toContain("2 requirements · 3 scenarios");
    expect(capabilityGrid?.querySelector('[data-capability="github-auth"]')?.textContent).toContain(
      "1 requirement · 0 scenarios",
    );

    const progress = view.container.querySelector('[data-kind="task-progress"]');
    const bars = progress?.querySelectorAll('[role="progressbar"]');
    expect(bars).toHaveLength(2);
    expect(bars?.[0]?.getAttribute("aria-valuenow")).toBe("2");
    expect(bars?.[0]?.getAttribute("aria-valuemax")).toBe("2");
    expect(bars?.[0]?.querySelector("span")?.className).toContain("bg-green");
    expect(bars?.[1]?.getAttribute("aria-valuenow")).toBe("1");
    expect(progress?.textContent).toContain("3/4");
  });
});

describe("Design section metadata", () => {
  it("keeps source-spec delta treatment independent from the round delta dot", async () => {
    const section: HostElement = {
      id: "refresh-observability",
      kind: "section",
      data: {
        author,
        title: "Refresh observability",
        children: [],
        sources: [
          {
            path: "openspec/changes/refresh/specs/refresh-observability/spec.md",
            label: "spec.md",
            line: 4,
          },
        ],
        spec_delta: "added",
        delta: "reworked",
      },
    };
    const view = mount(
      <BridgeProvider bridge={new MemoryBridge()}>
        <BoardElementsProvider elements={[section]} reviewId="review-round" boardId="board-round">
          <Section
            entry={{
              ref: section.id,
              gist: "The refresh now records every outcome.",
              counts: { requirements: 2 },
              delta: "reworked",
            }}
          />
        </BoardElementsProvider>
      </BridgeProvider>,
    );
    const root = view.container.querySelector("[data-kind=board-section]");
    expect(root?.getAttribute("data-delta")).toBe("reworked");
    expect(root?.getAttribute("data-spec-delta")).toBe("added");
    expect(root?.querySelector("[data-testid=delta-dot]")).toBeTruthy();
    expect(root?.querySelector('[data-kind="spec-delta"][data-spec-delta="added"]')).toBeTruthy();
    expect(root?.querySelector('[data-kind="source-chip"][data-source-line="4"]')).toBeTruthy();

    await view.user.click(view.getByText("Refresh observability"));
    expect(root?.querySelector("[data-testid=delta-dot]")).toBeNull();
    expect(root?.querySelector('[data-kind="spec-delta"][data-spec-delta="added"]')).toBeTruthy();
  });
});

describe("Design requirements", () => {
  it("renders a proposal requirement without inventing a coverage chip", () => {
    const scenario: HostElement = {
      id: "scenario-proposal",
      kind: "prose",
      data: {
        author,
        markdown: "WHEN refresh begins THEN the daemon records the attempt.",
      },
    };
    const requirement: HostElement = {
      id: "req-proposal",
      kind: "requirement",
      data: {
        author,
        name: "Every refresh is recorded",
        shall: "The daemon SHALL record every refresh outcome.",
        scenarios: [scenario.id],
        source: { path: "openspec/changes/refresh/specs/runtime/spec.md", line: 8 },
        spec_delta: "added",
      },
    };
    const view = mount(
      <BridgeProvider bridge={new MemoryBridge()}>
        <BoardElementsProvider elements={[requirement, scenario]} reviewId="review-proposal">
          <BoardElement element={requirement} />
        </BoardElementsProvider>
      </BridgeProvider>,
    );

    expect(view.getByText("Every refresh is recorded")).toBeTruthy();
    expect(view.container.querySelector("[data-kind=requirement] p")?.textContent).toContain(
      "The daemon SHALL record every refresh outcome.",
    );
    expect(view.container.querySelector("[data-kind=coverage-chip]")).toBeNull();
    expect(view.container.querySelector('[data-scenario-ref="scenario-proposal"]')).toBeTruthy();
  });

  it("renders a completed zero-hunk mapping as honestly unimplemented", () => {
    const requirement: HostElement = {
      id: "req-unimplemented",
      kind: "requirement",
      data: {
        author,
        shall: "The daemon SHALL persist the refreshed token.",
        coverage: "gap",
        trace: [],
        tests: 0,
      },
    };
    const view = mount(
      <BridgeProvider bridge={new MemoryBridge()}>
        <BoardElementsProvider elements={[requirement]} reviewId="review-gap">
          <BoardElement element={requirement} />
        </BoardElementsProvider>
      </BridgeProvider>,
    );

    expect(view.getByText("unimplemented · 0 hunks")).toBeTruthy();
  });

  it("renders name, capability, scenario elements, source, related files, and grounded counts", () => {
    const scenarios: HostElement[] = [
      {
        id: "scenario-attempt",
        kind: "prose",
        data: { author, markdown: "WHEN refresh begins THEN `attempt` is recorded first." },
      },
      {
        id: "scenario-persisted",
        kind: "prose",
        data: { author, markdown: "WHEN rotation succeeds THEN `persisted` follows." },
      },
    ];
    const traces: HostElement[] = [
      {
        id: "trace-runtime",
        kind: "code_ref",
        data: {
          author,
          patchset_id: "patchset-design",
          path: "packages/adapters/src/github-auth.ts",
          side: "head",
          start_line: 407,
          end_line: 415,
        },
      },
      {
        id: "trace-test",
        kind: "code_ref",
        data: {
          author,
          patchset_id: "patchset-design",
          path: "packages/adapters/src/github-auth.test.ts",
          side: "head",
          start_line: 288,
          end_line: 306,
        },
      },
    ];
    const requirement: HostElement = {
      id: "req-rich",
      kind: "requirement",
      data: {
        author,
        name: "Every refresh is recorded",
        capability: "refresh-observability",
        shall: "The daemon SHALL record every refresh attempt and outcome.",
        scenarios: scenarios.map((scenario) => scenario.id),
        related_files: [
          "packages/adapters/src/github-auth.ts",
          "packages/adapters/src/github-auth.test.ts",
        ],
        source: {
          path: "openspec/changes/refresh/specs/refresh-observability/spec.md",
          label: "spec.md",
          line: 12,
        },
        spec_delta: "modified",
        coverage: "partial",
        trace: traces.map((trace) => trace.id),
        tests: 3,
      },
    };
    const elements = [requirement, ...scenarios, ...traces];
    const view = mount(
      <BridgeProvider bridge={new MemoryBridge({ "patchset.readSpan": refusesSpanRead })}>
        <BoardElementsProvider elements={elements} reviewId="review-rich">
          <BoardElement element={requirement} />
        </BoardElementsProvider>
      </BridgeProvider>,
    );

    expect(view.getByText("Every refresh is recorded")).toBeTruthy();
    expect(view.getByText("refresh-observability")).toBeTruthy();
    expect(view.getByText("covered by 2 hunks · 3 tests · partial")).toBeTruthy();
    expect(view.container.querySelector('[data-spec-delta="modified"]')).toBeTruthy();
    expect(view.container.querySelectorAll("[data-kind=related-file-chip]")).toHaveLength(2);
    expect(
      view.container.querySelector('[data-kind="source-chip"][data-source-line="12"]'),
    ).toBeTruthy();
    const scenarioItems = view.container.querySelectorAll("[data-kind=requirement-scenarios] li");
    expect(scenarioItems).toHaveLength(2);
    expect(scenarioItems[0]?.getAttribute("data-scenario-ref")).toBe("scenario-attempt");
    expect(scenarioItems[0]?.querySelector('[data-element-id="scenario-attempt"]')).toBeTruthy();
    expect(scenarioItems[1]?.getAttribute("data-scenario-ref")).toBe("scenario-persisted");
    expect(scenarioItems[1]?.querySelector('[data-element-id="scenario-persisted"]')).toBeTruthy();
  });
});
