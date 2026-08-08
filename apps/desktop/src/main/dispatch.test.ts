import { randomUUID } from "node:crypto";
import {
  type PatchsetCapturePort,
  type ReviewEvent,
  ReviewService,
  type ReviewStorePort,
} from "@rennet/core";
import type { PermissionMode } from "@rennet/protocol";
import type { Canvas, CanvasAngle, Patchset, Review } from "@rennet/types";
import { CANVAS_ANGLES } from "@rennet/types";
import { describe, expect, it, vi } from "vitest";
import { createDispatch, type DispatchDeps } from "./dispatch";
import { createHarnessConsentAuthority } from "./harness-consent-authority";

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
  settings: { permissionMode(): PermissionMode; setPermissionMode(mode: PermissionMode): void };
  consent: {
    grant(reviewId: string): string;
    consume(reviewId: string, authorization: string): boolean;
  };
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
  // An in-memory permission-mode store defaulting to the safe `manual`.
  let mode: PermissionMode = "manual";
  const settings = {
    permissionMode: () => mode,
    setPermissionMode: (next: PermissionMode) => {
      mode = next;
    },
  };
  // The REAL main-owned consent authority (bead workspace-fyvxb): main mints a
  // single-use, review-bound token and consumes it before the harness runs.
  const consent = createHarnessConsentAuthority();
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
    settings,
    consent,
  };
  return {
    dispatch: createDispatch(deps),
    service,
    allowedRoots,
    buildCanvases,
    settings,
    consent,
  };
}

/**
 * Mint a single-use harness-run authorization the way the renderer does — via the
 * `harness.requestConsent` command MAIN owns. Returns the opaque token to relay on
 * `review.canvases`.
 */
async function requestConsent(
  dispatch: ReturnType<typeof createDispatch>,
  reviewId: string,
): Promise<string> {
  const out = (await dispatch("harness.requestConsent", {
    commandId: randomUUID(),
    reviewId,
  })) as { authorization: string };
  return out.authorization;
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

    // The default mode is `manual`, which asks: the renderer requests approval
    // (#58/#103, bead workspace-fyvxb) and relays the single-use token MAIN minted.
    const authorization = await requestConsent(dispatch, review.id);
    const result = (await dispatch("review.canvases", {
      commandId: randomUUID(),
      reviewId: review.id,
      repoPath: REPO,
      authorization,
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

describe("createDispatch — permission-mode settings (issue #103)", () => {
  it("reads the persisted workspace permission mode", async () => {
    const { dispatch } = harness();
    const out = (await dispatch("settings.permissionMode", {})) as { mode: PermissionMode };
    expect(out.mode).toBe("manual"); // the safe default the store starts at
  });

  it("writes the workspace permission mode and reads it back", async () => {
    const { dispatch, settings } = harness();
    const written = (await dispatch("settings.setPermissionMode", { mode: "auto" })) as {
      mode: PermissionMode;
    };
    expect(written.mode).toBe("auto");
    // The store actually changed (not just the echoed output).
    expect(settings.permissionMode()).toBe("auto");
    const read = (await dispatch("settings.permissionMode", {})) as { mode: PermissionMode };
    expect(read.mode).toBe("auto");
  });

  it("rejects an unrecognised mode at the command boundary", async () => {
    const { dispatch, settings } = harness();
    await expect(dispatch("settings.setPermissionMode", { mode: "yolo" })).rejects.toThrow();
    // A rejected write must not mutate the store.
    expect(settings.permissionMode()).toBe("manual");
  });
});

describe("createDispatch — review.canvases harness-run consent gate (#58/#103)", () => {
  // The vital circuit: the harness run (model spend) is gated at the MAIN
  // boundary, resolving the effective mode from the persisted WORKSPACE store
  // (the j98dt authority) AND, under a mode that asks, requiring a single-use,
  // review-bound authorization MAIN itself minted (the fyvxb hardening). These
  // tests pin the gate: they go RED if the mode guard is removed, if the single-
  // use check is removed (a replay/forged boolean would then run the harness),
  // AND if the gate over-blocks (auto/bypass would then be refused).

  it("refuses the harness run under manual mode with NO authorization (buildCanvases never called)", async () => {
    const { dispatch, buildCanvases, settings } = harness();
    settings.setPermissionMode("manual"); // explicit; also the safe default
    const review = await capturedReview(dispatch);

    await expect(
      dispatch("review.canvases", {
        commandId: randomUUID(),
        reviewId: review.id,
        repoPath: REPO,
      }),
    ).rejects.toThrow(/authoriz/i);
    // The model turn must not have run: the gate lives BEFORE buildCanvases.
    expect(buildCanvases).not.toHaveBeenCalled();
  });

  it("refuses a FORGED authorization under manual mode (a token MAIN never minted)", async () => {
    const { dispatch, buildCanvases } = harness();
    const review = await capturedReview(dispatch);

    await expect(
      dispatch("review.canvases", {
        commandId: randomUUID(),
        reviewId: review.id,
        repoPath: REPO,
        // A caller-fabricated token — the exact attack the fyvxb hardening closes
        // (the old `consent: true` boolean was forgeable this way).
        authorization: "forged-not-minted-by-main",
      }),
    ).rejects.toThrow(/authoriz/i);
    expect(buildCanvases).not.toHaveBeenCalled();
  });

  it("(1) legit single-use flow: approve review X → build X invokes the harness exactly once", async () => {
    const { dispatch, buildCanvases } = harness();
    const review = await capturedReview(dispatch);

    const authorization = await requestConsent(dispatch, review.id);
    const result = (await dispatch("review.canvases", {
      commandId: randomUUID(),
      reviewId: review.id,
      repoPath: REPO,
      authorization,
    })) as { canvases: Record<CanvasAngle, Canvas> };

    expect(buildCanvases).toHaveBeenCalledTimes(1);
    expect(Object.keys(result.canvases).sort()).toEqual([...CANVAS_ANGLES].sort());
  });

  it("(2) REPLAY rejected: reusing the same authorization for a second build is refused, harness NOT re-invoked", async () => {
    const { dispatch, buildCanvases } = harness();
    const review = await capturedReview(dispatch);

    const authorization = await requestConsent(dispatch, review.id);
    // First build consumes the token → runs once.
    await dispatch("review.canvases", {
      commandId: randomUUID(),
      reviewId: review.id,
      repoPath: REPO,
      authorization,
    });
    expect(buildCanvases).toHaveBeenCalledTimes(1);

    // Replaying the SAME (now-consumed) token must be refused, and the harness
    // must NOT run again. This is the property a plain boolean could never have.
    await expect(
      dispatch("review.canvases", {
        commandId: randomUUID(),
        reviewId: review.id,
        repoPath: REPO,
        authorization,
      }),
    ).rejects.toThrow(/authoriz/i);
    expect(buildCanvases).toHaveBeenCalledTimes(1);
  });

  it("REPLAY across a different review is refused too (the token is review-BOUND)", async () => {
    const { dispatch, buildCanvases } = harness();
    const review = await capturedReview(dispatch);

    const authorization = await requestConsent(dispatch, review.id);
    // A token minted for THIS review cannot authorize a build claiming a different
    // review id — the consume side keys on the review the token was bound to.
    await expect(
      dispatch("review.canvases", {
        commandId: randomUUID(),
        reviewId: "some-other-review",
        repoPath: REPO,
        authorization,
      }),
    ).rejects.toThrow(); // rejected (unknown review and/or unbound token)
    expect(buildCanvases).not.toHaveBeenCalled();
  });

  it("(4) runs the harness under auto mode without any authorization (the mode allows)", async () => {
    const { dispatch, buildCanvases, settings } = harness();
    settings.setPermissionMode("auto");
    const review = await capturedReview(dispatch);

    await dispatch("review.canvases", {
      commandId: randomUUID(),
      reviewId: review.id,
      repoPath: REPO,
    });
    expect(buildCanvases).toHaveBeenCalledTimes(1);
  });

  it("(4) runs the harness under bypass mode without any authorization", async () => {
    const { dispatch, buildCanvases, settings } = harness();
    settings.setPermissionMode("bypass");
    const review = await capturedReview(dispatch);

    await dispatch("review.canvases", {
      commandId: randomUUID(),
      reviewId: review.id,
      repoPath: REPO,
    });
    expect(buildCanvases).toHaveBeenCalledTimes(1);
  });

  it("does NOT consume a token under auto mode (no spend of an unrelated grant)", async () => {
    // A token minted while a prior manual approval happened must not be silently
    // burned by an auto-mode run — the consume path is reached ONLY when the mode
    // asks. So the token survives auto and still works if the mode flips back.
    const { dispatch, buildCanvases, settings } = harness();
    const review = await capturedReview(dispatch);
    const authorization = await requestConsent(dispatch, review.id);

    settings.setPermissionMode("auto");
    await dispatch("review.canvases", {
      commandId: randomUUID(),
      reviewId: review.id,
      repoPath: REPO,
    });
    expect(buildCanvases).toHaveBeenCalledTimes(1);

    // Flip back to manual: the earlier token is still unspent and authorizes once.
    settings.setPermissionMode("manual");
    await dispatch("review.canvases", {
      commandId: randomUUID(),
      reviewId: review.id,
      repoPath: REPO,
      authorization,
    });
    expect(buildCanvases).toHaveBeenCalledTimes(2);
  });

  it("(3) resolves the effective mode from the WORKSPACE store, not a renderer-supplied value", async () => {
    // Enforcement authority is the persisted workspace mode. Even though the
    // input carries no mode field, flipping the store to `manual` (ask) blocks a
    // run that `auto` would have allowed — proving the main reads the store, so a
    // crafted IPC cannot smuggle a laxer mode. (j98dt authority, preserved.)
    const { dispatch, buildCanvases, settings } = harness();
    settings.setPermissionMode("manual");
    const review = await capturedReview(dispatch);

    await expect(
      dispatch("review.canvases", {
        commandId: randomUUID(),
        reviewId: review.id,
        repoPath: REPO,
      }),
    ).rejects.toThrow(/authoriz/i);
    expect(buildCanvases).not.toHaveBeenCalled();
  });
});
