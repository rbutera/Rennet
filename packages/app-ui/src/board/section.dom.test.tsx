// @vitest-environment happy-dom
import type { LensBoard, LensSection } from "@rennet/protocol";
import { beforeEach, describe, expect, it } from "vitest";
import { useRennetStore } from "../store";
import { mount } from "../test/dom";
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

beforeEach(() => useRennetStore.setState({ viewedDelta: { viewedDeltaSections: {} } }));

describe("Section fold grammar", () => {
  it("a non-delta section starts folded with a full-width gist and unfolds on toggle", async () => {
    const { container, getByText, user } = renderSection("g2-gen1");
    const root = container.querySelector("[data-kind=board-section]");
    expect(root?.getAttribute("data-open")).toBe("false");
    // Folded fold-line: the full gist is visible; structural prose is not exposed as a count.
    expect(getByText(/The first read, before the round/)).toBeTruthy();
    expect(container.querySelector("[data-kind=section-counts]")).toBeNull();
    expect(root?.id).toBe("g2-gen1");
    expect(root?.querySelector("h2 > button")).toBeTruthy();

    await user.click(getByText("Generation 1 · Round 1 · Frozen"));
    expect(root?.getAttribute("data-open")).toBe("true");
    // Unfolded: no delta mark was invented.
    expect(container.querySelector("[data-testid=delta-dot]")).toBeNull();
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

  it("a delta section opens expanded with the gold dot, and interacting clears it via the store", async () => {
    const { container, getByText, queryByTestId, user } = renderSection("g2-open");
    const root = container.querySelector("[data-kind=board-section]");
    expect(root?.getAttribute("data-open")).toBe("true"); // delta ⇒ expanded
    expect(root?.getAttribute("data-delta")).toBe("reworked");
    // The transient gold dot with its screen-reader label.
    expect(queryByTestId("delta-dot")).toBeTruthy();
    expect(getByText("Still Open").closest("button")?.getAttribute("aria-label")).toBe(
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
});
