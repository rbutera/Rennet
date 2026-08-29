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
  it("renders header stats and sends the exact artifact source to review.openInEditor", async () => {
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
      sections: [],
      elements: [],
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
    expect(view.getByText("partial by 2 hunks · 3 tests")).toBeTruthy();
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
