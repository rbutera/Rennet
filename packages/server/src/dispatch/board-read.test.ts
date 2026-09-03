import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GenerationStore } from "@rennet/adapters";
import type { LensBoard, Review } from "@rennet/protocol";
import { parseCommandOutput } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import { boardHandlers } from "./board";
import { createDispatchRuntime, type DispatchDeps } from "./runtime";

// The `board.read` handler (C05 cluster 8, bound in C18). Positive controls: a pair the
// host drafted a board for serves that board, a durable terminal failure stays distinguishable
// from honest MISSING (`null`, never a fabricated board), and an unknown review is a genuine
// error like every review read.

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
  document: {
    title: "Design",
    introMarkdown: "One section grounds the review's shape.",
    measure: "structured",
  },
  sections: [{ ref: "s", gist: "one section", counts: { prose: 1 } }],
  elements: [
    {
      id: "p",
      kind: "prose",
      data: { author: { kind: "lens-agent", id: "t" }, markdown: "hello" },
    },
  ],
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
const lensAbsenceForReview: DispatchDeps["lensAbsenceForReview"] = (_reviewId, generation, lens) =>
  Promise.resolve(generation === DESIGN.generation && lens === "noise" ? "no-material" : undefined);

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

  it("distinguishes a durably absent lens from a board that has not arrived", async () => {
    const out = await harness({ lensBoardForReview, lensAbsenceForReview })["board.read"]({
      reviewId: REVIEW_ID,
      generation: "gen-1",
      lens: "noise",
    });
    expect(out).toEqual({ board: null, absence: "no-material" });
  });

  it("projects a durably loaded lens failure AND its typed account through the board.read wire", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rennet-board-read-failure-"));
    const failure = "The Flagged council did not return a valid board.";
    const legacyFailure = "noise lens: the initial drafting turn did not emit a board.";
    try {
      new GenerationStore(dir).save({
        id: "gen-failed",
        patchsetId: "ps-1",
        lensBoards: {},
        failedLenses: { flagged: failure },
        failedLensAccounts: { flagged: { attempt: 2, classification: "retryable" } },
        status: "live",
      });
      // A generation written BEFORE the account field existed: the string alone, and the
      // store must still load it (append-only). Its wire answer carries no account —
      // "unknown classification", never a fabricated one.
      new GenerationStore(dir).save({
        id: "gen-legacy",
        patchsetId: "ps-1",
        lensBoards: {},
        failedLenses: { noise: legacyFailure },
        status: "live",
      });
      // A FRESH store instance is the restart: nothing in memory, everything re-read.
      const restored = new GenerationStore(dir);
      const lensFailureForReview: DispatchDeps["lensFailureForReview"] = (
        _reviewId,
        generation,
        lens,
      ) => {
        const stored = restored.load(generation);
        const message = stored?.failedLenses?.[lens];
        if (message === undefined) return Promise.resolve(undefined);
        const account = stored?.failedLensAccounts?.[lens];
        return Promise.resolve({ message, ...(account === undefined ? {} : { account }) });
      };
      const handler = harness({ lensFailureForReview })["board.read"];

      const failed = parseCommandOutput(
        "board.read",
        await handler({ reviewId: REVIEW_ID, generation: "gen-failed", lens: "flagged" }),
      );
      expect(failed).toEqual({
        board: null,
        failure,
        failureAccount: { attempt: 2, classification: "retryable" },
      });

      const legacy = parseCommandOutput(
        "board.read",
        await handler({ reviewId: REVIEW_ID, generation: "gen-legacy", lens: "noise" }),
      );
      expect(legacy).toEqual({ board: null, failure: legacyFailure });

      const missing = parseCommandOutput(
        "board.read",
        await handler({ reviewId: REVIEW_ID, generation: "gen-failed", lens: "design" }),
      );
      expect(missing).toEqual({ board: null });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
