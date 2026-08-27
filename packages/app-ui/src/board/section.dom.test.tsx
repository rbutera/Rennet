// @vitest-environment happy-dom
import type { LensBoard, LensSection } from "@rennet/protocol";
import { beforeEach, describe, expect, it } from "vitest";
import { useRennetStore } from "../store";
import { mount } from "../test/dom";
import { flaggedGen2Board } from "../test/fixtures/boards";
import { BoardElementsProvider } from "./kinds/element-context";
import { Section } from "./section";

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
    <BoardElementsProvider elements={board.elements}>
      <Section entry={entryFor(ref)} />
    </BoardElementsProvider>,
  );
}

beforeEach(() => useRennetStore.setState({ viewedDelta: { viewedDeltaSections: {} } }));

describe("Section fold grammar", () => {
  it("a non-delta section starts folded, shows its gist + per-kind counts, and unfolds on toggle", async () => {
    const { container, getByText, user } = renderSection("g2-gen1");
    const root = container.querySelector("[data-kind=board-section]");
    expect(root?.getAttribute("data-open")).toBe("false");
    // Folded fold-line: the gist and a per-kind count chip are both visible.
    expect(getByText(/The first read, before the round/)).toBeTruthy();
    expect(getByText(/prose ×/)).toBeTruthy();

    await user.click(getByText("Generation 1 · Round 1 · Frozen"));
    expect(root?.getAttribute("data-open")).toBe("true");
    // Unfolded: the fold-line is gone (its gist chip no longer rendered).
    expect(container.querySelector("[data-testid=delta-dot]")).toBeNull();
  });

  it("a delta section opens expanded with the gold dot, and interacting clears it via the store", async () => {
    const { container, getByText, queryByTestId, user } = renderSection("g2-open");
    const root = container.querySelector("[data-kind=board-section]");
    expect(root?.getAttribute("data-open")).toBe("true"); // delta ⇒ expanded
    expect(root?.getAttribute("data-delta")).toBe("reworked");
    // The transient gold dot with its screen-reader label.
    expect(queryByTestId("delta-dot")).toBeTruthy();
    expect(getByText("reworked this round")).toBeTruthy();

    await user.click(getByText("Still Open")); // interact = toggle heading
    // Store-driven clear, not local: the id lands in the viewed set and the dot is gone.
    expect(useRennetStore.getState().viewedDelta.viewedDeltaSections["g2-open"]).toBe(true);
    expect(queryByTestId("delta-dot")).toBeNull();
  });
});
