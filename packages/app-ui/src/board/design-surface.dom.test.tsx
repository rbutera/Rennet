// @vitest-environment happy-dom
import type { HostElement, LensBoard } from "@rennet/protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BridgeProvider } from "../data";
import { useRennetStore } from "../store";
import { mount, waitFor } from "../test/dom";
import { MemoryBridge, refusesSpanRead } from "../test/memory-bridge";
import { LensBoardView } from "./board-view";
import { DesignCapabilityGrid } from "./design-structure";
import { BoardElement, BoardElementsProvider } from "./kinds";
import { Section } from "./section";

const author = { kind: "lens-agent", id: "lens:design" } as const;

beforeEach(() => useRennetStore.setState({ viewedDelta: { viewedDeltaSections: {} } }));

/** Open every folded top-level section. A folded `Collapse` mounts NO children (perf audit
 *  §5 H2), so a Design board's bodies are absent from the document until their section is
 *  open — assert on section content only after this. */
async function openSections(view: ReturnType<typeof mount>): Promise<void> {
  await waitFor(() =>
    expect(view.container.querySelector('[data-kind="board-section"]')).not.toBeNull(),
  );
  for (const section of view.container.querySelectorAll<HTMLElement>(
    '[data-kind="board-section"][data-open="false"]',
  )) {
    const toggle = section.querySelector<HTMLButtonElement>("h2 button[aria-expanded]");
    if (toggle) await view.user.click(toggle);
  }
}

/** Record `scrollIntoView` by element id. The jump targets mount only when their fold
 *  opens, so a spy pinned to a node captured up front would miss the real call. */
function recordScrolls(): {
  readonly calls: { id: string; options: unknown }[];
  restore: () => void;
} {
  const calls: { id: string; options: unknown }[] = [];
  const spy = vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(function (
    this: Element,
    options?: unknown,
  ) {
    calls.push({ id: this.id, options });
  } as () => void);
  return { calls, restore: () => spy.mockRestore() };
}

describe("Design board document metadata", () => {
  it("renders header stats, targets the topology source root, and reveals it before scrolling", async () => {
    const board: LensBoard = {
      lens: "design",
      generation: "gen-design",
      boardId: "board-design",
      document: {
        title: "Credential refresh",
        introMarkdown: "The proposal adds observable refresh outcomes.",
        measure: "structured",
        stats: [
          { label: "Format", value: "OpenSpec" },
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
          id: "nested-source-repeat",
          kind: "section",
          data: {
            author,
            title: "Nested design detail",
            children: [],
            sources: [
              {
                path: "openspec/changes/refresh/design.md",
                label: "nested design.md",
                line: 14,
              },
            ],
          },
        },
        {
          id: "design-source",
          kind: "section",
          data: {
            author,
            title: "Design",
            children: ["nested-source-repeat"],
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
    expect(view.container.querySelector('[data-kind="design-format"]')?.textContent).toContain(
      "OpenSpec",
    );
    expect(view.getByText("11/13")).toBeTruthy();
    const artifactJump = view.getByRole("link", { name: "Jump to design.md" });
    expect(artifactJump.getAttribute("href")).toBe("#design-source");
    const designSource = view.container.querySelector<HTMLElement>("#design-source");
    if (designSource === null) throw new Error("Design source section did not render");
    const sourceScroll = vi.fn();
    Object.defineProperty(designSource, "scrollIntoView", { value: sourceScroll });
    const frameCallbacks: FrameRequestCallback[] = [];
    const animationFrame = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((callback) => {
        frameCallbacks.push(callback);
        return frameCallbacks.length;
      });
    history.replaceState(null, "", "#/s/review-design?lens=design");
    const historyLength = history.length;
    expect(designSource.getAttribute("data-open")).toBe("false");
    await view.user.click(artifactJump);
    expect(location.hash).toBe("#/s/review-design?lens=design");
    expect(history.length).toBe(historyLength);
    expect(designSource.getAttribute("data-open")).toBe("true");
    expect(sourceScroll).not.toHaveBeenCalled();
    expect(frameCallbacks).toHaveLength(1);
    frameCallbacks[0]?.(0);
    expect(sourceScroll).toHaveBeenCalledWith({ behavior: "smooth", block: "start" });
    animationFrame.mockRestore();
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
          children: ["req-attempt", "req-outcome"],
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
        data: {
          author,
          markdown: "WHEN refresh begins THEN an attempt is recorded.",
          scenario_clauses: {
            condition: "refresh begins",
            response: "an attempt is recorded.",
          },
        },
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
          task_progress: {
            kind: "source",
            format: "openspec",
            role: "tasks",
            layout: "grouped",
          },
        },
      },
      {
        id: "record-type",
        kind: "section",
        data: {
          author,
          title: "1 · Secret-free record type",
          children: ["task-record", "task-export"],
          task_progress: { kind: "group", state: "static" },
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
          task_progress: { kind: "group", state: "static" },
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
    await openSections(view);

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
    if (added === undefined || added === null) throw new Error("Added capability did not render");
    expect(added?.getAttribute("href")).toBe("#refresh-observability");
    expect(added?.className).toContain("border-l-green/70");
    expect(added?.textContent).toContain("2 requirements · 3 scenarios");
    expect(capabilityGrid?.querySelector('[data-capability="github-auth"]')?.textContent).toContain(
      "1 requirement · 0 scenarios",
    );
    expect(view.container.querySelectorAll('[data-element-id="scenario-attempt"]')).toHaveLength(1);
    expect(view.container.querySelector('[data-scenario-clause="condition"]')?.textContent).toBe(
      "refresh begins",
    );
    expect(view.container.querySelector('[data-scenario-clause="response"]')?.textContent).toBe(
      "an attempt is recorded.",
    );
    expect(view.getAllByText("refresh begins")).toHaveLength(1);
    expect(view.getAllByText("an attempt is recorded.")).toHaveLength(1);
    expect(
      view.container.querySelector('[data-element-id="scenario-outcome"]')?.textContent,
    ).toContain("WHEN refresh succeeds THEN persisted is recorded.");

    const capabilityTarget = view.container.querySelector<HTMLElement>("#refresh-observability");
    if (capabilityTarget === null) throw new Error("Capability section did not render");
    const capabilityScroll = vi.fn();
    Object.defineProperty(capabilityTarget, "scrollIntoView", { value: capabilityScroll });
    history.replaceState(null, "", "#/s/review-structure?lens=design");
    const historyLength = history.length;
    await view.user.click(added);
    expect(location.hash).toBe("#/s/review-structure?lens=design");
    expect(history.length).toBe(historyLength);
    expect(capabilityScroll).toHaveBeenCalledWith({ behavior: "smooth", block: "start" });

    const progress = view.container.querySelector('[data-kind="task-progress"]');
    expect(view.container.querySelectorAll('[data-kind="task-progress"]')).toHaveLength(1);
    const bars = progress?.querySelectorAll('[role="progressbar"]');
    expect(bars).toHaveLength(2);
    expect(bars?.[0]?.getAttribute("aria-valuenow")).toBe("2");
    expect(bars?.[0]?.getAttribute("aria-valuemax")).toBe("2");
    expect(bars?.[0]?.querySelector("span")?.className).toContain("bg-green");
    expect(bars?.[1]?.getAttribute("aria-valuenow")).toBe("1");
    expect(progress?.textContent).toContain("3/4");
  });

  it("shows nested host-derived ledger groups once without rewriting plan checkboxes", async () => {
    const planSource = { path: "docs/superpowers/plans/2026-08-29-search.md" };
    const elements: HostElement[] = [
      {
        id: "implementation-plan",
        kind: "section",
        data: {
          author,
          title: "Search Implementation Plan",
          children: ["plan-source-repeat"],
          sources: [planSource],
          task_progress: {
            kind: "source",
            format: "superpowers",
            role: "plan",
            layout: "grouped",
          },
        },
      },
      {
        id: "plan-source-repeat",
        kind: "section",
        data: {
          author,
          title: "Implementation details",
          children: ["task-one", "task-two"],
          sources: [planSource],
        },
      },
      {
        id: "task-one",
        kind: "section",
        data: {
          author,
          title: "Task 1: Index records",
          children: ["step-one"],
          task_progress: { kind: "group", state: "complete" },
        },
      },
      {
        id: "step-one",
        kind: "prose",
        data: { author, markdown: "- [ ] Write the failing test" },
      },
      {
        id: "task-two",
        kind: "section",
        data: {
          author,
          title: "Task 2: Query records",
          children: ["step-two"],
          task_progress: { kind: "group", state: "incomplete" },
        },
      },
      {
        id: "step-two",
        kind: "prose",
        data: { author, markdown: "- [ ] Write the query test" },
      },
    ];
    const board: LensBoard = {
      lens: "design",
      generation: "gen-superpowers",
      boardId: "board-superpowers",
      document: {
        title: "Search",
        introMarkdown: "Add indexed search.",
        measure: "structured",
      },
      sections: [{ ref: "implementation-plan", gist: "Implement search.", counts: {} }],
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
        <LensBoardView reviewId="review-superpowers" generation={board.generation} lens="design" />
      </BridgeProvider>,
    );

    await openSections(view);
    expect(await view.findByText("Tasks · 1/2")).toBeTruthy();
    expect(view.container.querySelectorAll('[data-kind="task-progress"]')).toHaveLength(1);
    expect(
      view.container.querySelectorAll('[data-kind="task-progress"] [role="progressbar"]'),
    ).toHaveLength(2);
    expect(
      view.getByRole("progressbar", { name: "Task 1: Index records: 1 of 1 tasks complete" }),
    ).toBeTruthy();
    expect(
      view.getByRole("progressbar", { name: "Task 2: Query records: 0 of 1 tasks complete" }),
    ).toBeTruthy();
    expect(view.getByText("[ ] Write the failing test")).toBeTruthy();
    expect(view.getByText("[ ] Write the query test")).toBeTruthy();
  });

  it("does not turn a source-linked Design checklist into task progress", async () => {
    const board: LensBoard = {
      lens: "design",
      generation: "gen-design-checklist",
      boardId: "board-design-checklist",
      document: {
        title: "Search design",
        introMarkdown: "The design records follow-up questions.",
        measure: "structured",
      },
      sections: [{ ref: "design-notes", gist: "Design notes.", counts: {} }],
      elements: [
        {
          id: "design-notes",
          kind: "section",
          data: {
            author,
            title: "Design",
            children: ["design-checklist"],
            sources: [{ path: "docs/superpowers/specs/2026-08-29-search-design.md" }],
          },
        },
        {
          id: "design-checklist",
          kind: "prose",
          data: { author, markdown: "- [ ] Revisit the storage alternative after launch." },
        },
      ],
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
        <LensBoardView
          reviewId="review-design-checklist"
          generation={board.generation}
          lens="design"
        />
      </BridgeProvider>,
    );

    await view.user.click(await view.findByRole("button", { name: "Design" }));
    expect(await view.findByText("[ ] Revisit the storage alternative after launch.")).toBeTruthy();
    expect(view.container.querySelector('[data-kind="task-progress"]')).toBeNull();
  });
});

describe("Design section metadata", () => {
  it("renders each format's structured metadata once and preserves source order", () => {
    const elements: HostElement[] = [
      {
        id: "kiro-task",
        kind: "prose",
        data: {
          author,
          markdown: "- [ ] Persist the reviewed tree.",
          requirement_refs: ["REQ-3.2", "REQ-1.1", "REQ-3.2"],
        },
      },
      {
        id: "bmad-story",
        kind: "requirement",
        data: {
          author,
          name: "Review the immutable tree",
          shall: "The reviewer SHALL see the captured specification.",
          status: "InProgress",
        },
      },
      {
        id: "bmad-task",
        kind: "prose",
        data: {
          author,
          markdown: "- [ ] Render the story metadata.",
          acceptance_criteria: ["AC-4", "AC-2", "AC-4"],
        },
      },
      {
        id: "superpowers-task",
        kind: "section",
        data: {
          author,
          title: "Task 2: Render metadata",
          children: ["superpowers-step"],
          task_manifest: {
            files: [
              { operation: "Modify", value: "packages/app-ui/src/board/design-meta.tsx" },
              { operation: "Test", value: "packages/app-ui/src/board/design-surface.dom.test.tsx" },
            ],
            interfaces: [
              { direction: "Produces", value: "DesignSectionMetadata" },
              { direction: "Consumes", value: "task_manifest" },
            ],
            verifications: [
              { run: "pnpm nx test rennet-app-ui", expected: "metadata tests pass" },
              { run: "pnpm check", expected: "the full gate passes" },
            ],
          },
        },
      },
      {
        id: "superpowers-step",
        kind: "prose",
        data: { author, markdown: "- [ ] Render the manifest once." },
      },
      {
        id: "glossary",
        kind: "section",
        data: {
          author,
          title: "Glossary",
          children: ["glossary-review"],
        },
      },
      {
        id: "glossary-review",
        kind: "prose",
        data: {
          author,
          markdown:
            "**Review**: The immutable patchset and its attached judgment. _Avoid_: audit, approval, audit",
          glossary_term: {
            term: "Review",
            definition: "The immutable patchset and its attached judgment.",
            avoid: ["audit", "approval", "audit"],
          },
        },
      },
    ];
    const roots = elements.filter(
      ({ id }) => id !== "superpowers-step" && id !== "glossary-review",
    );
    const view = mount(
      <BridgeProvider bridge={new MemoryBridge()}>
        <BoardElementsProvider elements={elements} reviewId="review-format-metadata">
          {roots.map((element) => (
            <BoardElement key={element.id} element={element} />
          ))}
        </BoardElementsProvider>
      </BridgeProvider>,
    );

    expect(view.container.querySelectorAll('[data-kind="requirement-refs"]')).toHaveLength(1);
    expect(
      view.container.querySelector('[data-element-id="kiro-task"] [data-kind="requirement-refs"]'),
    ).toBeTruthy();
    expect(
      [...view.container.querySelectorAll("[data-requirement-ref]")].map(
        (node) => node.textContent,
      ),
    ).toEqual(["REQ-3.2", "REQ-1.1", "REQ-3.2"]);

    const status = view.container.querySelector('[data-kind="story-status"]');
    expect(
      view.container.querySelector('[data-element-id="bmad-story"] [data-kind="story-status"]'),
    ).toBe(status);
    expect(status?.getAttribute("data-status")).toBe("InProgress");
    expect(view.getAllByText("InProgress")).toHaveLength(1);

    expect(view.container.querySelectorAll('[data-kind="acceptance-criteria"]')).toHaveLength(1);
    expect(
      view.container.querySelector(
        '[data-element-id="bmad-task"] [data-kind="acceptance-criteria"]',
      ),
    ).toBeTruthy();
    expect(
      [...view.container.querySelectorAll("[data-acceptance-criterion]")].map(
        (node) => node.textContent,
      ),
    ).toEqual(["AC-4", "AC-2", "AC-4"]);

    const manifest = view.container.querySelector('[data-kind="task-manifest"]');
    expect(view.container.querySelectorAll('[data-kind="task-manifest"]')).toHaveLength(1);
    expect(
      view.container.querySelector(
        '[data-element-id="superpowers-task"] > [data-kind="task-manifest"]',
      ),
    ).toBe(manifest);
    expect(
      [...(manifest?.querySelectorAll("[data-manifest-part]") ?? [])].map((node) =>
        node.getAttribute("data-manifest-part"),
      ),
    ).toEqual(["files", "interfaces", "verifications"]);
    expect(
      [
        ...(manifest?.querySelectorAll('[data-manifest-part="files"] [data-manifest-entry]') ?? []),
      ].map((node) => node.textContent),
    ).toEqual([
      "Modifypackages/app-ui/src/board/design-meta.tsx",
      "Testpackages/app-ui/src/board/design-surface.dom.test.tsx",
    ]);
    expect(
      [
        ...(manifest?.querySelectorAll('[data-manifest-part="interfaces"] [data-manifest-entry]') ??
          []),
      ].map((node) => node.textContent),
    ).toEqual(["ProducesDesignSectionMetadata", "Consumestask_manifest"]);
    expect(
      [...(manifest?.querySelectorAll('[data-manifest-part="verifications"] code') ?? [])].map(
        (node) => node.textContent,
      ),
    ).toEqual(["pnpm nx test rennet-app-ui", "pnpm check"]);
    expect(view.getAllByText("metadata tests pass")).toHaveLength(1);
    expect(view.getAllByText("the full gate passes")).toHaveLength(1);

    const glossary = view.container.querySelector('[data-kind="glossary-term"]');
    expect(view.container.querySelectorAll('[data-kind="glossary-term"]')).toHaveLength(1);
    expect(
      view.container.querySelector(
        '[data-element-id="glossary-review"] > [data-kind="glossary-term"]',
      ),
    ).toBe(glossary);
    expect(
      view.container.querySelector('[data-element-id="glossary"] > [data-kind="glossary-term"]'),
    ).toBeNull();
    expect(view.getAllByText("Review")).toHaveLength(1);
    expect(view.getAllByText("The immutable patchset and its attached judgment.")).toHaveLength(1);
    const renderedText = glossary?.textContent ?? "";
    expect(renderedText.split("Review")).toHaveLength(2);
    expect(renderedText.split("The immutable patchset and its attached judgment.")).toHaveLength(2);
    expect(
      [...(glossary?.querySelectorAll("[data-glossary-avoid]") ?? [])].map(
        (node) => node.textContent,
      ),
    ).toEqual(["audit", "approval", "audit"]);
  });

  it("drops malformed format projections instead of presenting partial metadata", () => {
    const elements: HostElement[] = [
      {
        id: "malformed-task",
        kind: "prose",
        data: {
          author,
          markdown: "- [ ] Keep malformed host data out of the surface.",
          requirement_refs: ["REQ-1", 2],
          acceptance_criteria: "AC-1",
          glossary_term: {
            term: "Review",
            definition: "A grounded judgment.",
            avoid: "approval",
          },
        },
      },
      {
        id: "malformed-story",
        kind: "requirement",
        data: {
          author,
          shall: "The board SHALL ignore malformed story metadata.",
          status: { value: "Done" },
        },
      },
      {
        id: "malformed-group",
        kind: "section",
        data: {
          author,
          title: "Malformed metadata",
          children: [],
          task_manifest: {
            files: [{ operation: "Modify", value: "packages/app-ui" }],
            interfaces: [{ direction: "Produces" }],
            verifications: [],
          },
        },
      },
    ];
    const view = mount(
      <BridgeProvider bridge={new MemoryBridge()}>
        <BoardElementsProvider elements={elements} reviewId="review-malformed-metadata">
          {elements.map((element) => (
            <BoardElement key={element.id} element={element} />
          ))}
        </BoardElementsProvider>
      </BridgeProvider>,
    );

    expect(view.container.querySelector('[data-kind="requirement-refs"]')).toBeNull();
    expect(view.container.querySelector('[data-kind="acceptance-criteria"]')).toBeNull();
    expect(view.container.querySelector('[data-kind="story-status"]')).toBeNull();
    expect(view.container.querySelector('[data-kind="task-manifest"]')).toBeNull();
    expect(view.container.querySelector('[data-kind="glossary-term"]')).toBeNull();
    expect(view.getByText("[ ] Keep malformed host data out of the surface.")).toBeTruthy();
  });

  it("groups BMAD capabilities in topology order and reveals a folded nested target", async () => {
    const prdSource = { path: "planning/prd.md", candidate: "bmad-product" };
    const elements: HostElement[] = [
      {
        id: "nfr1",
        kind: "requirement",
        data: {
          author,
          capability: "non-functional",
          shall: "Session restoration completes within 500 ms.",
          scenarios: [],
        },
      },
      {
        id: "non-functional",
        kind: "section",
        data: {
          author,
          title: "Non Functional Requirements",
          children: ["nfr1"],
        },
      },
      {
        id: "fr1",
        kind: "requirement",
        data: {
          author,
          capability: "functional",
          shall: "The application restores the last session.",
          scenarios: [],
        },
      },
      {
        id: "functional",
        kind: "section",
        data: {
          author,
          title: "Functional Requirements",
          children: ["fr1"],
        },
      },
      {
        id: "prd",
        kind: "section",
        data: {
          author,
          title: "Product requirements",
          children: ["functional", "non-functional"],
          sources: [prdSource],
        },
      },
    ];
    const board: LensBoard = {
      lens: "design",
      generation: "gen-bmad-capabilities",
      boardId: "board-bmad-capabilities",
      document: {
        title: "Product",
        introMarkdown: "The product restores sessions within its performance budget.",
        measure: "structured",
        stats: [
          { label: "Format", value: "BMAD" },
          { label: "Requirements", value: "2" },
        ],
        sources: [prdSource],
      },
      sections: [{ ref: "prd", gist: "Product requirements.", counts: { requirements: 2 } }],
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
        <LensBoardView reviewId="review-bmad" generation={board.generation} lens="design" />
      </BridgeProvider>,
    );

    expect(await view.findByText("Capabilities")).toBeTruthy();
    const cards = [
      ...view.container.querySelectorAll<HTMLAnchorElement>(
        '[data-kind="capability-grid"] [data-capability]',
      ),
    ];
    expect(cards.map((card) => card.getAttribute("data-capability"))).toEqual([
      "functional",
      "non-functional",
    ]);
    expect(cards.map((card) => card.getAttribute("href"))).toEqual([
      "#functional",
      "#non-functional",
    ]);
    expect(
      cards.every(
        (card) =>
          card.getAttribute("data-spec-delta") === null &&
          card.getAttribute("data-spec-deltas") === null &&
          card.querySelector('[data-kind="spec-delta"]') === null,
      ),
    ).toBe(true);

    const root = view.container.querySelector<HTMLElement>("#prd");
    if (root === null) throw new Error("BMAD capability topology did not render");
    // The nested capability is inside a FOLDED section, so it is not in the document at
    // all — the jump has to open the top-level fold and resolve its target afterwards.
    expect(view.container.querySelector("#non-functional")).toBeNull();
    const scrolls = recordScrolls();
    const frameCallbacks: FrameRequestCallback[] = [];
    const animationFrame = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((callback) => {
        frameCallbacks.push(callback);
        return frameCallbacks.length;
      });

    expect(root.getAttribute("data-open")).toBe("false");
    await view.user.click(cards[1] as HTMLAnchorElement);
    expect(root.getAttribute("data-open")).toBe("true");
    expect(view.container.querySelector("#non-functional")).not.toBeNull();
    expect(scrolls.calls).toEqual([]);
    expect(frameCallbacks).toHaveLength(1);
    frameCallbacks[0]?.(0);
    expect(scrolls.calls).toEqual([
      { id: "non-functional", options: { behavior: "smooth", block: "start" } },
    ]);
    scrolls.restore();
    animationFrame.mockRestore();
  });

  it("targets a BMAD story capability at its named source root", async () => {
    const storySource = { path: "docs/stories/1.1.restore-sessions.md", candidate: "bmad-story" };
    const elements: HostElement[] = [
      {
        id: "story-requirement",
        kind: "requirement",
        data: {
          author,
          capability: "story:1.1",
          shall: "The application SHALL restore the last session.",
          scenarios: [],
        },
      },
      {
        id: "story-requirements",
        kind: "section",
        data: {
          author,
          title: "Requirements",
          children: ["story-requirement"],
        },
      },
      {
        id: "story-details",
        kind: "section",
        data: {
          author,
          title: "Story",
          children: ["story-requirements"],
        },
      },
      {
        id: "story-source",
        kind: "section",
        data: {
          author,
          title: "Story 1.1: Restore sessions",
          children: ["story-details"],
          sources: [storySource],
        },
      },
    ];
    const board: LensBoard = {
      lens: "design",
      generation: "gen-bmad-story-capability",
      boardId: "board-bmad-story-capability",
      document: {
        title: "Restore sessions",
        introMarkdown: "Restore the reviewer's last session.",
        measure: "structured",
        stats: [{ label: "Format", value: "BMAD" }],
        sources: [storySource],
      },
      sections: [{ ref: "story-source", gist: "Restore sessions.", counts: { requirements: 1 } }],
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
        <LensBoardView reviewId="review-bmad-story" generation={board.generation} lens="design" />
      </BridgeProvider>,
    );

    const card = await view.findByRole("link", { name: "Jump to story:1.1" });
    expect(card.getAttribute("href")).toBe("#story-source");
    const root = view.container.querySelector<HTMLElement>("#story-source");
    if (root === null) throw new Error("BMAD story topology did not render");
    // Folded, so the nested requirements section is not rendered yet; the jump still
    // lands on the NAMED source root, not on the nested section it contains.
    expect(view.container.querySelector("#story-requirements")).toBeNull();
    const scrolls = recordScrolls();
    const frameCallbacks: FrameRequestCallback[] = [];
    const animationFrame = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((callback) => {
        frameCallbacks.push(callback);
        return frameCallbacks.length;
      });

    expect(root.getAttribute("data-open")).toBe("false");
    await view.user.click(card);
    expect(root.getAttribute("data-open")).toBe("true");
    expect(frameCallbacks).toHaveLength(1);
    frameCallbacks[0]?.(0);
    expect(scrolls.calls).toEqual([
      { id: "story-source", options: { behavior: "smooth", block: "start" } },
    ]);
    scrolls.restore();
    animationFrame.mockRestore();
  });

  it("targets a single OpenSpec requirement at its capability root", () => {
    const elements: HostElement[] = [
      {
        id: "session-capability",
        kind: "section",
        data: {
          author,
          title: "Session",
          children: ["added-operation"],
          spec_delta: "added",
        },
      },
      {
        id: "added-operation",
        kind: "section",
        data: {
          author,
          title: "ADDED Requirements",
          children: ["session-requirement"],
          spec_delta: "added",
        },
      },
      {
        id: "session-requirement",
        kind: "requirement",
        data: {
          author,
          capability: "session",
          shall: "The daemon SHALL preserve the session.",
          scenarios: [],
          spec_delta: "added",
        },
      },
    ];
    const board: LensBoard = {
      lens: "design",
      generation: "gen-single-capability",
      boardId: "board-single-capability",
      document: {
        title: "Session",
        introMarkdown: "Preserve the session.",
        measure: "structured",
        sources: [],
      },
      sections: [{ ref: "session-capability", gist: "Preserve sessions.", counts: {} }],
      elements,
      skippedHunks: [],
    };
    const view = mount(
      <BridgeProvider bridge={new MemoryBridge()}>
        <BoardElementsProvider
          elements={elements}
          reviewId="review-single-capability"
          boardId={board.boardId}
        >
          <DesignCapabilityGrid board={board} />
        </BoardElementsProvider>
      </BridgeProvider>,
    );

    const card = view.container.querySelector<HTMLAnchorElement>(
      '[data-kind="capability-grid"] [data-capability="session"]',
    );
    expect(card?.getAttribute("href")).toBe("#session-capability");
  });

  it("renders one mixed-delta capability card with ordered operation badges", () => {
    const capability: HostElement = {
      id: "session-capability",
      kind: "section",
      data: {
        author,
        title: "Session",
        children: ["modified-operation", "added-operation"],
      },
    };
    const elements: HostElement[] = [
      capability,
      {
        id: "modified-operation",
        kind: "section",
        data: {
          author,
          title: "MODIFIED Requirements",
          children: ["modified-requirement"],
          spec_delta: "modified",
        },
      },
      {
        id: "modified-requirement",
        kind: "requirement",
        data: {
          author,
          capability: "session",
          shall: "The daemon SHALL retain the refreshed session.",
          scenarios: [],
          spec_delta: "modified",
        },
      },
      {
        id: "added-operation",
        kind: "section",
        data: {
          author,
          title: "ADDED Requirements",
          children: ["added-requirement"],
          spec_delta: "added",
        },
      },
      {
        id: "added-requirement",
        kind: "requirement",
        data: {
          author,
          capability: "session",
          shall: "The daemon SHALL report session recovery.",
          scenarios: [],
          spec_delta: "added",
        },
      },
    ];
    const board: LensBoard = {
      lens: "design",
      generation: "gen-mixed-delta",
      boardId: "board-mixed-delta",
      document: {
        title: "Session",
        introMarkdown: "The session capability changes in two ways.",
        measure: "structured",
        stats: [],
        sources: [],
      },
      sections: [{ ref: capability.id, gist: "Session changes.", counts: {} }],
      elements,
      skippedHunks: [],
    };
    const view = mount(
      <BridgeProvider bridge={new MemoryBridge()}>
        <BoardElementsProvider
          elements={elements}
          reviewId="review-mixed-delta"
          boardId={board.boardId}
        >
          <DesignCapabilityGrid board={board} />
          <BoardElement element={capability} />
        </BoardElementsProvider>
      </BridgeProvider>,
    );

    const cards = view.container.querySelectorAll(
      '[data-kind="capability-grid"] [data-capability="session"]',
    );
    expect(
      view.container.querySelectorAll('[data-kind="capability-grid"] [data-capability]'),
    ).toHaveLength(1);
    expect(cards).toHaveLength(1);
    const card = cards.item(0);
    expect(card.getAttribute("data-spec-delta")).toBeNull();
    expect(card.getAttribute("data-spec-deltas")).toBe("modified added");
    expect(card.className).toContain("border-l-green/70");
    expect(
      [...card.querySelectorAll('[data-kind="spec-delta"]')].map((badge) =>
        badge.getAttribute("data-spec-delta"),
      ),
    ).toEqual(["modified", "added"]);

    for (const delta of ["modified", "added"] as const) {
      const operation = view.container.querySelector(`#${delta}-operation`);
      expect(operation?.getAttribute("data-spec-delta")).toBe(delta);
      expect(
        operation?.querySelector(`[data-kind="spec-delta"][data-spec-delta="${delta}"]`),
      ).toBeTruthy();
      expect(
        view.container
          .querySelector(`[data-element-id="${delta}-requirement"]`)
          ?.getAttribute("data-spec-delta"),
      ).toBe(delta);
    }
  });

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
        scenario_clauses: {
          condition: "refresh begins",
          response: "the daemon records the attempt.",
        },
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
    expect(view.getByText("Trigger")).toBeTruthy();
    expect(view.getByText("Outcome")).toBeTruthy();
    expect(view.getAllByText("refresh begins")).toHaveLength(1);
    expect(view.getAllByText("the daemon records the attempt.")).toHaveLength(1);
    expect(view.container.querySelectorAll('[data-element-id="scenario-proposal"]')).toHaveLength(
      1,
    );
  });

  it("renders exact scenario prose once when host clauses are unavailable", () => {
    const markdown = "WHEN refresh is declined THEN its code is recorded.";
    const scenario: HostElement = {
      id: "scenario-fallback",
      kind: "prose",
      data: { author, markdown },
    };
    const requirement: HostElement = {
      id: "req-fallback",
      kind: "requirement",
      data: {
        author,
        shall: "The daemon SHALL record declined refreshes.",
        scenarios: [scenario.id],
      },
    };
    const view = mount(
      <BridgeProvider bridge={new MemoryBridge()}>
        <BoardElementsProvider elements={[requirement, scenario]} reviewId="review-fallback">
          <BoardElement element={requirement} />
        </BoardElementsProvider>
      </BridgeProvider>,
    );

    expect(view.getAllByText(markdown)).toHaveLength(1);
    expect(view.container.querySelectorAll('[data-element-id="scenario-fallback"]')).toHaveLength(
      1,
    );
    expect(view.container.querySelector('[data-kind="scenario-clauses"]')).toBeNull();
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
