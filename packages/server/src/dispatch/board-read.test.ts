import type { LensBoard, Review } from "@rennet/protocol";
import { parseCommandOutput } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import { boardHandlers } from "./board";
import { createDispatchRuntime, type DispatchDeps } from "./runtime";

// The `board.read` handler (C05 cluster 8, bound in C18). Positive controls: a pair the
// host drafted a board for serves that board, a pair it did not is honest MISSING (`null`,
// never a fabricated board), and an unknown review is a genuine error like every review read.

const REVIEW_ID = "review-1";
const REVIEW = {
  id: REVIEW_ID,
  repositoryRoot: "/home/dev/acme",
  activePatchsetId: "ps-1",
  patchsets: [{ id: "ps-1", repository: { headRef: "feat/seam" } }],
  dispositions: [],
  status: "current",
} as unknown as Review;

/** The one board this fake host drafted: design, generation gen-1. */
const DESIGN: LensBoard = {
  lens: "design",
  generation: "gen-1",
  boardId: "b-1",
  sections: [{ ref: "s", gist: "one section", counts: { prose: 1 } }],
  elements: [
    {
      id: "p",
      kind: "prose",
      data: { author: { kind: "lens-agent", id: "t" }, markdown: "hello" },
    },
  ],
  skippedHunks: [],
};

function harness(deps: Partial<DispatchDeps> = {}) {
  const rt = createDispatchRuntime({
    service: { reviewById: (id: string) => (id === REVIEW_ID ? REVIEW : undefined) },
    ...deps,
  } as unknown as DispatchDeps);
  return boardHandlers(rt);
}

const lensBoardForReview: DispatchDeps["lensBoardForReview"] = (_reviewId, generation, lens) =>
  Promise.resolve(generation === DESIGN.generation && lens === DESIGN.lens ? DESIGN : undefined);

describe("board.read — the lens-board read", () => {
  it("serves the persisted board for a (review, generation, lens) the host drafted", async () => {
    const out = await harness({ lensBoardForReview })["board.read"]({
      reviewId: REVIEW_ID,
      generation: "gen-1",
      lens: "design",
    });
    expect(() => parseCommandOutput("board.read", out)).not.toThrow();
    expect((out as { board: LensBoard }).board).toEqual(DESIGN);
  });

  it("answers honest-MISSING for a lens with no board that generation", async () => {
    // Absent-not-disabled: `null`, never an invented or borrowed board.
    const out = await harness({ lensBoardForReview })["board.read"]({
      reviewId: REVIEW_ID,
      generation: "gen-1",
      lens: "noise",
    });
    expect(out).toEqual({ board: null });
  });

  it("answers honest-MISSING when no board substrate is wired at all", async () => {
    const out = await harness()["board.read"]({
      reviewId: REVIEW_ID,
      generation: "gen-1",
      lens: "design",
    });
    expect(out).toEqual({ board: null });
  });

  it("an unknown review is a genuine error, like every review read", async () => {
    await expect(
      harness({ lensBoardForReview })["board.read"]({
        reviewId: "nope",
        generation: "gen-1",
        lens: "design",
      }),
    ).rejects.toThrow();
  });
});
