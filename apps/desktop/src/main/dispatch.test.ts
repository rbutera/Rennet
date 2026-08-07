import { randomUUID } from "node:crypto";
import {
  type PatchsetCapturePort,
  type ReviewEvent,
  ReviewService,
  type ReviewStorePort,
} from "@rennet/core";
import type { Canvas, CanvasAngle, Patchset, Review } from "@rennet/types";
import { CANVAS_ANGLES } from "@rennet/types";
import { describe, expect, it, vi } from "vitest";
import { createDispatch, type DispatchDeps } from "./dispatch";

const REPO = "/repo";

function patchset(): Patchset {
  return {
    id: "patch-1",
    createdAt: "2026-08-07T00:00:00.000Z",
    repository: {
      id: "repo",
      root: REPO,
      commonDir: `${REPO}/.git`,
      baseRef: "main",
      baseOid: "base0000",
      headOid: "head0000",
    },
    files: [
      {
        path: "src/a.ts",
        status: "modified",
        additions: 1,
        deletions: 0,
        binary: false,
        patch: "X",
      },
    ],
    rawDiff: "X",
    byteLength: 1,
    truncated: false,
  };
}

class InMemoryStore implements ReviewStorePort {
  #latest: Review | null = null;
  readonly #byId = new Map<string, Review>();
  readonly #receipts = new Map<string, Review>();
  latestReview(repositoryRoot?: string): Review | null {
    if (repositoryRoot === undefined) return this.#latest;
    return this.#latest && this.#latest.repositoryRoot === repositoryRoot ? this.#latest : null;
  }
  reviewById(reviewId: string): Review | null {
    return this.#byId.get(reviewId) ?? null;
  }
  receipt(commandId: string, digest: string): Review | null {
    return this.#receipts.get(`${commandId}:${digest}`) ?? null;
  }
  commit(commandId: string, digest: string, _events: ReviewEvent[], result: Review): Review {
    this.#latest = result;
    this.#byId.set(result.id, result);
    this.#receipts.set(`${commandId}:${digest}`, result);
    return result;
  }
}

function canvasSet(): Record<CanvasAngle, Canvas> {
  const one = (angle: CanvasAngle): Canvas => ({
    canvasId: `cid-${angle}`,
    reviewId: "review-1",
    patchsetId: "patch-1",
    angle,
    layers: {
      substrate: { chunks: [] },
      analysis: { elements: [], cohorts: [], readingOrder: [] },
      disposition: { dispositions: [] },
      annotation: { annotations: [], proposals: [] },
    },
    overlay: [],
  });
  return Object.fromEntries(CANVAS_ANGLES.map((angle) => [angle, one(angle)])) as Record<
    CanvasAngle,
    Canvas
  >;
}

function harness(): {
  dispatch: ReturnType<typeof createDispatch>;
  service: ReviewService;
  allowedRoots: Set<string>;
  buildCanvases: ReturnType<typeof vi.fn>;
} {
  const capture: PatchsetCapturePort = { capture: () => Promise.resolve(patchset()) };
  const service = new ReviewService(capture, new InMemoryStore());
  const allowedRoots = new Set<string>();
  let dirty = false;
  const buildCanvases = vi.fn(() =>
    Promise.resolve({
      canvases: canvasSet(),
      elementDiffs: { e1: { path: "src/a.ts", diff: "@@ -1,1 +1,2 @@\n+x" } },
    }),
  );
  const deps: DispatchDeps = {
    service,
    allowedRoots,
    chooseRepository: () => Promise.resolve(REPO),
    startWatching: () => undefined,
    isRepositoryDirty: () => dirty,
    setRepositoryDirty: (value) => {
      dirty = value;
    },
    buildCanvases,
  };
  return { dispatch: createDispatch(deps), service, allowedRoots, buildCanvases };
}

async function capturedReview(dispatch: ReturnType<typeof createDispatch>): Promise<Review> {
  await dispatch("repository.choose", {});
  const result = (await dispatch("review.capture", {
    commandId: randomUUID(),
    repoPath: REPO,
  })) as { review: Review };
  return result.review;
}

describe("createDispatch — canvas.* routing (issue #54)", () => {
  it("routes canvas.disposition onto the review and returns the updated review", async () => {
    const { dispatch } = harness();
    const review = await capturedReview(dispatch);

    const result = (await dispatch("canvas.disposition", {
      commandId: randomUUID(),
      reviewId: review.id,
      patchsetId: review.activePatchsetId,
      path: "src/a.ts",
      disposition: "approve",
      body: "looks right",
    })) as { review: Review };

    expect(result).not.toBeUndefined();
    expect(result.review.dispositions).toHaveLength(1);
    expect(result.review.dispositions[0]?.anchor.path).toBe("src/a.ts");
    expect(result.review.dispositions[0]?.type).toBe("approve");
  });

  it("acknowledges the L3 ops rather than returning undefined", async () => {
    const { dispatch } = harness();
    const review = await capturedReview(dispatch);

    const pin = await dispatch("canvas.pinAnnotation", {
      commandId: randomUUID(),
      canvasId: "cid-sequence",
      annotationId: "ann-1",
    });
    const clear = await dispatch("canvas.clearAnnotation", {
      commandId: randomUUID(),
      canvasId: "cid-sequence",
      annotationId: "ann-1",
    });
    const cohort = await dispatch("canvas.setCohortExpansion", {
      commandId: randomUUID(),
      canvasId: "cid-decisions",
      cohortKey: "cohort:c1",
      expanded: true,
    });
    const select = await dispatch("canvas.select", {
      commandId: randomUUID(),
      canvasId: "cid-sequence",
      elementKey: "e1",
    });

    expect(pin).toEqual({ ok: true });
    expect(clear).toEqual({ ok: true });
    expect(cohort).toEqual({ ok: true });
    expect(select).toEqual({ ok: true });

    const adjudicate = (await dispatch("canvas.adjudicateProposal", {
      commandId: randomUUID(),
      reviewId: review.id,
      canvasId: "cid-decisions",
      proposalId: "prop-1",
      outcome: "dismissed",
    })) as { review: Review };
    expect(adjudicate.review.id).toBe(review.id);
  });

  it("routes review.canvases to the injected builder", async () => {
    const { dispatch, buildCanvases } = harness();
    const review = await capturedReview(dispatch);

    const result = (await dispatch("review.canvases", {
      commandId: randomUUID(),
      reviewId: review.id,
      repoPath: REPO,
    })) as {
      canvases: Record<CanvasAngle, Canvas>;
      elementDiffs: Record<string, { path: string; diff: string }>;
    };

    expect(buildCanvases).toHaveBeenCalledTimes(1);
    expect(Object.keys(result.canvases).sort()).toEqual([...CANVAS_ANGLES].sort());
    // The per-element real diff map (#60) is delivered with the canvas set.
    expect(result.elementDiffs.e1?.diff).toContain("+x");
  });

  it("still serves the preserved MVP commands (app.bootstrap, review.setDisposition)", async () => {
    const { dispatch } = harness();
    const review = await capturedReview(dispatch);

    const boot = (await dispatch("app.bootstrap", {})) as { review: Review | null };
    expect(boot.review?.id).toBe(review.id);

    const set = (await dispatch("review.setDisposition", {
      commandId: randomUUID(),
      reviewId: review.id,
      patchsetId: review.activePatchsetId,
      path: "src/a.ts",
      disposition: "comment",
      body: "",
    })) as { review: Review };
    expect(set.review.dispositions).toHaveLength(1);
  });

  it("denies review.canvases for a repository that was never granted", async () => {
    const { dispatch } = harness();
    const review = await capturedReview(dispatch);
    await expect(
      dispatch("review.canvases", {
        commandId: randomUUID(),
        reviewId: review.id,
        repoPath: "/not-granted",
      }),
    ).rejects.toThrow(/access was not granted/);
  });
});
