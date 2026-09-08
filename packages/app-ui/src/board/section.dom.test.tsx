// @vitest-environment happy-dom
import type { HostElement, LensBoard, LensSection } from "@rennet/protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useRennetStore } from "../store";
import { mount, waitFor, within } from "../test/dom";
import { flaggedGen2Board } from "../test/fixtures/boards";
import { BoardElementsProvider } from "./kinds/element-context";
import { Section, sectionCountText } from "./section";
import { deltaKey } from "./viewed-delta";

// Cluster 4 fold grammar over the gen2 flagged fixture — real delta variety:
// `g2-open` is `reworked`, `g2-beyond` is `new`, `g2-gen1` carries no delta.

const board: LensBoard = flaggedGen2Board;
const entryFor = (ref: string): LensSection => {
  const entry = board.sections.find((s) => s.ref === ref);
  if (!entry) throw new Error(`no fixture section ${ref}`);
  return entry;
};

function renderSection(ref: string) {
  return mount(
    <BoardElementsProvider elements={board.elements} boardId={board.boardId}>
      <Section entry={entryFor(ref)} />
    </BoardElementsProvider>,
  );
}

beforeEach(() => {
  useRennetStore.setState({ viewedDelta: { viewedDeltaSections: {} } });
  useRennetStore.getState().reviewActions.resetReview();
});

describe("Section fold grammar", () => {
  it("a non-delta section starts folded without inventing content and unfolds on toggle", async () => {
    const { container, getByText, user } = renderSection("g2-gen1");
    const root = container.querySelector("[data-kind=board-section]");
    expect(root?.getAttribute("data-open")).toBe("false");
    expect(container.textContent).not.toContain("The first read, before the round");
    expect(container.querySelector("[data-kind=section-counts]")).toBeNull();
    expect(root?.id).toBe("g2-gen1");
    expect(root?.querySelector("h2 > button")).toBeTruthy();

    await user.click(getByText("Generation 1 · Round 1 · Frozen"));
    expect(root?.getAttribute("data-open")).toBe("true");
    // Unfolded: no delta mark was invented.
    expect(container.querySelector("[data-testid=delta-dot]")).toBeNull();
  });

  it("names Noise members as regions rather than extra groups", () => {
    expect(sectionCountText({ groups: 24 })).toBe("24 regions");
    expect(sectionCountText({ noise_verdict: 1 })).toBe("1 region");
  });

  it("normalizes legacy raw kinds to ordered domain-object counts", () => {
    expect(
      sectionCountText({
        prose: 4,
        finding: 2,
        requirements: 1,
        order_step: 3,
        review_comment: 1,
        message: 9,
      }),
    ).toBe("2 findings · 1 requirement · 3 steps · 1 comment");
  });

  it("a delta section folds like every other, keeping the gold dot that clears via the store", async () => {
    const { container, getByText, queryByTestId, user } = renderSection("g2-open");
    const root = container.querySelector("[data-kind=board-section]");
    // A delta section used to open itself. Every foldable now arrives folded (Rai,
    // 2026-09-04) and the DOT carries "this is new" on its own.
    expect(root?.getAttribute("data-open")).toBe("false");
    expect(root?.getAttribute("data-delta")).toBe("reworked");
    // The transient gold dot with its screen-reader label.
    expect(queryByTestId("delta-dot")).toBeTruthy();
    expect(getByText("Still Open").closest('[role="button"]')?.getAttribute("aria-label")).toBe(
      "Still Open, reworked this round",
    );

    await user.click(getByText("Still Open")); // interact = toggle heading
    // Store-driven clear, not local: the board-scoped key lands in the viewed set (finding
    // 3 — keyed by boardId::ref, not the bare ref) and the dot is gone.
    expect(
      useRennetStore.getState().viewedDelta.viewedDeltaSections[deltaKey(board.boardId, "g2-open")],
    ).toBe(true);
    expect(queryByTestId("delta-dot")).toBeNull();
  });

  it("opens a title quote thread without toggling the section", async () => {
    const id = useRennetStore
      .getState()
      .reviewActions.addQuoteComment("Still Open", "Discuss this title.", "comment", {
        target: "g2-open",
        generation: "",
      });
    const { container, user } = renderSection("g2-open");
    const root = container.querySelector("[data-kind=board-section]");
    const highlight = container.querySelector<HTMLElement>("[data-quote-highlight]");

    // The claim is that clicking a highlighted title opens its THREAD and does not move the
    // fold. Assert against the section's state before the click rather than a literal, so
    // the test keeps asking that question whatever the fold default becomes.
    const before = root?.getAttribute("data-open");
    expect(before).toBe("false");
    if (highlight) await user.click(highlight);
    expect(root?.getAttribute("data-open")).toBe(before);
    expect(container.querySelector(`[data-thread-id="${id}"]`)).toBeTruthy();
  });
});

const author = { kind: "lens-agent", id: "decisions" } as const;
const previewEntry: LensSection = { ref: "root", gist: "Repeated heading", counts: {} };

function previewTree(children: string[], content: HostElement[]) {
  const elements: HostElement[] = [
    { id: "root", kind: "section", data: { author, title: "Storage", children } },
    ...content,
  ];
  return (
    <BoardElementsProvider elements={elements} boardId="preview-board">
      <Section entry={previewEntry} />
    </BoardElementsProvider>
  );
}

describe("Section without a fold", () => {
  it("stands open with no toggle and no preview, and still names its title and counts", () => {
    const elements: HostElement[] = [
      { id: "root", kind: "section", data: { author, title: "Findings", children: ["intro"] } },
      { id: "intro", kind: "prose", data: { author, markdown: "The one row." } },
    ];
    const view = mount(
      <BoardElementsProvider elements={elements} boardId="flat-board">
        <Section entry={previewEntry} foldable={false} />
      </BoardElementsProvider>,
    );
    const section = view.container.querySelector("[data-kind=board-section]");
    expect(section?.getAttribute("data-open")).toBe("true");
    expect(section?.querySelector("button[aria-expanded]")).toBeNull();
    expect(view.queryByRole("list", { name: "Findings contents" })).toBeNull();
    expect(view.getByRole("heading", { level: 2 }).textContent).toContain("Findings");
    expect(view.getByText("The one row.")).toBeTruthy();
  });
});

describe("Section content previews", () => {
  it("lists nested headings and titled children in document order, then opens and focuses the chosen child", async () => {
    const scroll = vi
      .spyOn(HTMLElement.prototype, "scrollIntoView")
      .mockImplementation(() => undefined);
    const view = mount(
      previewTree(
        ["intro", "nested", "choice"],
        [
          { id: "intro", kind: "prose", data: { author, markdown: "Introductory detail." } },
          {
            id: "nested",
            kind: "section",
            data: { author, title: "Representation", children: ["req"] },
          },
          {
            id: "req",
            kind: "requirement",
            data: { author, name: "Image bytes", shall: "Images retain their bytes." },
          },
          {
            id: "choice",
            kind: "decision",
            data: {
              author,
              title: "Store the logo",
              statement: "The project stores logo bytes in its own directory.",
              why: "The directory owns the project data.",
              evidence: [],
              alternatives: [],
            },
          },
        ],
      ),
    );
    const contents = view.getByRole("list", { name: "Storage contents" });
    expect(
      within(contents)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["Representation", "Image bytes", "Store the logo"]);
    expect(view.queryByText("Introductory detail.")).toBeNull();
    const link = within(contents).getByRole("button", { name: "Store the logo" });
    link.focus();
    await view.user.keyboard("{Enter}");
    const statement = view.getByText("The project stores logo bytes in its own directory.");
    const decision = statement.closest('[data-kind="decision"]');
    await waitFor(() => expect(document.activeElement).toBe(decision));
    expect(scroll.mock.contexts).toContain(decision);
    expect(view.getByRole("heading", { name: "Store the logo" })).toBeTruthy();
    scroll.mockRestore();
  });

  it("locates a Sequence step from its folded title", async () => {
    const scroll = vi
      .spyOn(HTMLElement.prototype, "scrollIntoView")
      .mockImplementation(() => undefined);
    const view = mount(
      previewTree(
        ["step"],
        [
          {
            id: "step",
            kind: "order_step",
            data: {
              author,
              title: "Follow the cached rows",
              span: "code-1",
              children: ["explanation"],
            },
          },
          {
            id: "code-1",
            kind: "code_ref",
            data: {
              author,
              patchset_id: "ps-1",
              path: "view.ts",
              side: "head",
              start_line: 1,
              end_line: 2,
            },
          },
          {
            id: "explanation",
            kind: "prose",
            data: { author, markdown: "The previous result remains visible." },
          },
        ],
      ),
    );
    await view.user.click(view.getByRole("button", { name: "Follow the cached rows" }));
    const step = view
      .getByText("The previous result remains visible.")
      .closest('[data-kind="order_step"]');
    await waitFor(() => expect(document.activeElement).toBe(step));
    expect(scroll.mock.contexts).toContain(step);
    scroll.mockRestore();
  });

  it("falls back to the first substantive paragraph and retains inline code without repeating the heading", () => {
    const view = mount(
      previewTree(
        ["duplicate", "body"],
        [
          { id: "duplicate", kind: "prose", data: { author, markdown: "**Storage**" } },
          {
            id: "body",
            kind: "prose",
            data: {
              author,
              markdown:
                "# Storage\n\nThe `projectLogoSchema` stores the image.\n\nA second paragraph stays out of the preview.",
            },
          },
        ],
      ),
    );
    expect(view.queryByRole("list", { name: "Storage contents" })).toBeNull();
    const paragraph = view.container.querySelector('[data-kind="section-paragraph-preview"]');
    expect(paragraph?.textContent).toBe("The projectLogoSchema stores the image.");
    expect(paragraph?.querySelector("code")?.textContent).toBe("projectLogoSchema");
    // The two-line clamp and its ellipsis are `line-clamp-2` — a CSS fact happy-dom cannot
    // lay out, so no assertion here can see them. The launched-app journey is where a
    // long paragraph is looked at; what THIS test can pin is that the preview is the
    // first paragraph alone, uncut, with nothing appended to it.
    expect(paragraph?.className).toContain("line-clamp-2");
    expect(view.queryByText(/A second paragraph/)).toBeNull();
  });

  it("omits an empty preview and updates from children arriving on the same board", () => {
    const view = mount(previewTree([], []));
    expect(view.queryByRole("list")).toBeNull();
    expect(view.container.querySelector('[data-kind="section-paragraph-preview"]')).toBeNull();
    expect(view.queryByText("Repeated heading")).toBeNull();
    view.rerender(
      previewTree(
        ["body"],
        [{ id: "body", kind: "prose", data: { author, markdown: "The first content arrives." } }],
      ),
    );
    expect(view.getByText("The first content arrives.")).toBeTruthy();
    view.rerender(
      previewTree(
        ["body", "nested"],
        [
          { id: "body", kind: "prose", data: { author, markdown: "The first content arrives." } },
          { id: "nested", kind: "section", data: { author, title: "Ownership", children: [] } },
        ],
      ),
    );
    expect(view.getByRole("button", { name: "Ownership" })).toBeTruthy();
    expect(view.queryByText("The first content arrives.")).toBeNull();
  });

  it("keeps a long legacy decision statement out of navigation while preserving all of it in the body", async () => {
    const statement =
      "The logo bytes live in the project directory so that all sessions share the same persisted image without reading the mutable repository on every request.";
    const view = mount(
      previewTree(
        ["choice"],
        [
          {
            id: "choice",
            kind: "decision",
            data: {
              author,
              statement,
              why: "A project owns its visual identity.",
              alternatives: [
                "Read the repository for each request.",
                "Store a separate image per session.",
              ],
              evidence: [],
            },
          },
        ],
      ),
    );
    const contents = view.getByRole("list", { name: "Storage contents" });
    const label = within(contents).getByRole("button").textContent;
    expect(label?.length).toBeLessThan(89);
    expect(label).not.toBe(statement);
    await view.user.click(view.getByRole("button", { name: "Toggle Storage" }));
    expect(view.getByRole("heading", { level: 3 }).textContent).toBe(label);
    expect(view.getByText(statement)).toBeTruthy();
    expect(view.getByRole("heading", { name: "Rationale" })).toBeTruthy();
    const alternatives = view.container.querySelector('[data-kind="decision-alternatives"]');
    expect(alternatives?.querySelectorAll("li")).toHaveLength(2);
  });
});

describe("the folded section index", () => {
  it("lists each requirement by name with its spec delta, and opens the section on it", async () => {
    const author = { kind: "lens-agent", id: "lens:design" } as const;
    const elements: HostElement[] = [
      {
        id: "cap",
        kind: "section",
        data: { author, title: "session-bound-workspace", children: ["req-bind", "req-sibling"] },
      },
      {
        id: "req-bind",
        kind: "requirement",
        data: {
          author,
          name: "A session binds to exactly one workspace at creation",
          shall: "A session SHALL bind to exactly one workspace root.",
          spec_delta: "modified",
        },
      },
      {
        id: "req-sibling",
        kind: "requirement",
        data: {
          author,
          name: "A sibling branch is collected",
          shall: "A sibling SHALL be deleted with its worktree when reachable.",
          spec_delta: "added",
        },
      },
    ];
    const entry: LensSection = { ref: "cap", gist: "", counts: { requirements: 2 } };
    const { container, user } = mount(
      <BoardElementsProvider elements={elements} boardId="b-design">
        <Section entry={entry} lens="design" />
      </BoardElementsProvider>,
    );
    const index = container.querySelector('[data-kind="section-index"]');
    const rows = [...(index?.querySelectorAll("li") ?? [])];
    expect(rows.map((row) => row.querySelector("button")?.textContent)).toEqual([
      "A session binds to exactly one workspace at creationmodified",
      "A sibling branch is collectedadded",
    ]);
    expect(rows[0]?.querySelector('[data-spec-delta="modified"]')).toBeTruthy();
    expect(rows[1]?.querySelector('[data-spec-delta="added"]')).toBeTruthy();

    const second = rows[1]?.querySelector("button");
    if (!second) throw new Error("no index row");
    await user.click(second);
    expect(container.querySelector("[data-kind=board-section]")?.getAttribute("data-open")).toBe(
      "true",
    );
    await waitFor(() =>
      expect(container.querySelector('[data-element-id="req-sibling"]')).toBeTruthy(),
    );
  });
});
