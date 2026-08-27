// @vitest-environment happy-dom
import type { LensBoard } from "@rennet/protocol";
import { beforeEach, describe, expect, it } from "vitest";
import { BridgeProvider } from "../../data";
import { useRennetStore } from "../../store";
import { mount, waitFor } from "../../test/dom";
import {
  decisionsBoard,
  designBoard,
  flaggedBoard,
  noiseBoard,
  sequenceBoard,
} from "../../test/fixtures/boards";
import { MemoryBridge } from "../../test/memory-bridge";
import { BoardElement, BoardElementsProvider } from "./index";

// Cluster 3's registry, exercised over the cluster-1 fixture boards — their union is
// arranged to cover every board kind. Each renderer stamps a `data-kind` marker (its
// distinctive DOM), so rendering the whole set proves the map is total in practice, not
// just at the type level. Citations hydrate through the span-read seam; an empty
// MemoryBridge stands in for unbound dispatch, so a code_ref reads the honest error.

const ALL_BOARDS: readonly LensBoard[] = [
  designBoard,
  decisionsBoard,
  sequenceBoard,
  flaggedBoard,
  noiseBoard,
];

const BOARD_KINDS = [
  "prose",
  "callout",
  "annotation",
  "code_ref",
  "finding",
  "decision",
  "requirement",
  "order_step",
  "message",
  "noise_verdict",
  "section",
] as const;

beforeEach(() => useRennetStore.getState().reviewActions.resetReview());

/** Render every element of a board through the registry (deduped — a citation reused
 *  across two sections appears twice in the flat pool). */
function renderBoard(board: LensBoard) {
  const unique = [...new Map(board.elements.map((el) => [el.id, el])).values()];
  return mount(
    <BridgeProvider bridge={new MemoryBridge({})}>
      <BoardElementsProvider elements={board.elements}>
        {unique.map((el) => (
          <BoardElement key={el.id} element={el} />
        ))}
      </BoardElementsProvider>
    </BridgeProvider>,
  );
}

describe("board kind renderers over the fixture set", () => {
  it("renders every registered board kind's distinctive DOM across the fixtures", () => {
    const present = new Set<string>();
    for (const board of ALL_BOARDS) {
      const { container, unmount } = renderBoard(board);
      for (const node of container.querySelectorAll("[data-kind]")) {
        const kind = node.getAttribute("data-kind");
        if (kind) present.add(kind);
      }
      unmount();
    }
    for (const kind of BOARD_KINDS) expect(present.has(kind)).toBe(true);
  });

  it("surfaces the honest error line for a code_ref unreadable from the captured patchset", async () => {
    // A decision's evidence renders through CodeTabs, which hydrates its active citation
    // on mount; with no dispatch handler the seam returns error, rendered as one line.
    const { getAllByText } = renderBoard(designBoard);
    await waitFor(() =>
      expect(getAllByText(/is not readable from the captured patchset/).length).toBeGreaterThan(0),
    );
  });

  it("a finding folds to a severity chip and its Fix stages a request-change ask on the real slice", async () => {
    const { getAllByText, user } = renderBoard(flaggedBoard);
    // f1 cites cr-f1 → github-auth.ts:244; its `**Fix:**` mints the actionable callout.
    const [firstRequest] = getAllByText("Request This Change");
    expect(firstRequest).toBeDefined();
    if (firstRequest) await user.click(firstRequest);
    const asks = Object.values(useRennetStore.getState().review.stagedAsks);
    expect(asks.some((a) => a.type === "request-change")).toBe(true);
  });

  it("renders a requirement's coverage verdict and a message's role + quote", () => {
    const design = renderBoard(designBoard);
    expect(
      design.container.querySelector("[data-kind=requirement][data-coverage=met]"),
    ).toBeTruthy();
    design.unmount();

    const flagged = renderBoard(flaggedBoard);
    const message = flagged.container.querySelector("[data-kind=message][data-role=discuss]");
    expect(message).toBeTruthy();
    expect(message?.querySelector("blockquote")?.textContent).toContain(
      "connection and token are untouched",
    );
  });

  it("dims a noise verdict and stages a comment ask when the reviewer disagrees", async () => {
    const { container, getAllByText, user } = renderBoard(noiseBoard);
    expect(container.querySelector("[data-kind=noise_verdict][data-verdict=noise]")).toBeTruthy();
    const [firstNotNoise] = getAllByText("Not noise");
    expect(firstNotNoise).toBeDefined();
    if (firstNotNoise) await user.click(firstNotNoise);
    const asks = Object.values(useRennetStore.getState().review.stagedAsks);
    expect(asks.some((a) => a.type === "comment")).toBe(true);
  });
});
