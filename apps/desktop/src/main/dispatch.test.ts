import { randomUUID } from "node:crypto";
import { buildGitHubReviewRequest } from "@rennet/adapters";
import {
  type AskAnswer,
  canonicalReviewPayload,
  type ForgePublishPort,
  type ForgeReviewPost,
  type PatchsetCapturePort,
  type ReviewCommentInput,
  type ReviewEvent,
  ReviewService,
  type ReviewStorePort,
} from "@rennet/core";
import type {
  DetectedHarness,
  DiscoveryResult,
  PermissionMode,
  Project,
  ProjectKind,
} from "@rennet/protocol";
import type { Canvas, CanvasAngle, Patchset, Review } from "@rennet/types";
import { CANVAS_ANGLES } from "@rennet/types";
import { describe, expect, it, vi } from "vitest";
import { createDispatch, type DispatchDeps } from "./dispatch";
import { createHarnessConsentAuthority } from "./harness-consent-authority";
import {
  createPublishConsentAuthority,
  type PublishConsentAuthority,
} from "./publish-consent-authority";

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

/** A GitHub-PR patchset (the second source) — diffed from a local clone. */
function prPatchset(): Patchset {
  return {
    ...patchset(),
    id: "pr-patch-1",
    source: "github-local",
    repository: { ...patchset().repository, id: "clone", root: "/clone" },
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

/** A fake egress port that records posts, so a test can assert exactly one review. */
function fakePublishPort(
  overrides: Partial<ForgePublishPort> = {},
): ForgePublishPort & { posts: ForgeReviewPost[] } {
  const posts: ForgeReviewPost[] = [];
  return {
    posts,
    capabilities: {
      supportsThreadResolution: true,
      supportsBatchedReview: true,
      supportsMultiLineAnchors: true,
      supportsFileLevelThreads: true,
    },
    // The REAL pure request builder, so the dry-run shape assertion is meaningful.
    buildReviewRequest: (post) => buildGitHubReviewRequest(post),
    findExistingReview: () => Promise.resolve(null),
    publishReview: (post) => {
      posts.push(post);
      return Promise.resolve({ reviewRef: "PRR_test", url: "https://x/1", reused: false });
    },
    ...overrides,
  };
}

function harness(
  publishPort: ForgePublishPort & { posts: ForgeReviewPost[] } = fakePublishPort(),
): {
  dispatch: ReturnType<typeof createDispatch>;
  service: ReviewService;
  allowedRoots: Set<string>;
  buildCanvases: ReturnType<typeof vi.fn>;
  settings: { permissionMode(): PermissionMode; setPermissionMode(mode: PermissionMode): void };
  consent: {
    grant(reviewId: string): string;
    consume(reviewId: string, authorization: string): boolean;
  };
  publishPort: ForgePublishPort & { posts: ForgeReviewPost[] };
  publishConsent: PublishConsentAuthority;
  reviewAsk: {
    askOrchestrator: ReturnType<typeof vi.fn>;
    askCodex: ReturnType<typeof vi.fn>;
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
      engine: { aiReview: true, claudeAvailable: true, codexAvailable: true },
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
  const publishConsent = createPublishConsentAuthority();
  // review.ask ports (issue #139) as recording spies, so a test can assert the
  // orchestrator is asked exactly once and Codex only in "both" mode — the whole
  // point of the issue is that negative guarantee on the REAL command path.
  const reviewAsk = {
    askOrchestrator: vi.fn<(input: { reviewId: string; question: string }) => Promise<AskAnswer>>(
      async () => ({ model: "Orchestrator · Claude", answer: "orchestrator's answer" }),
    ),
    askCodex: vi.fn<(input: { reviewId: string; question: string }) => Promise<AskAnswer>>(
      async () => ({ model: "codex", answer: "codex's answer" }),
    ),
  };
  const deps: DispatchDeps = {
    service,
    allowedRoots,
    chooseRepository: () => Promise.resolve(REPO),
    openPullRequest: (commandId) => service.createReviewFromPatchset(commandId, prPatchset()),
    startWatching: () => undefined,
    isRepositoryDirty: () => dirty,
    setRepositoryDirty: (value) => {
      dirty = value;
    },
    buildCanvases,
    settings,
    consent,
    publishPort,
    publishConsent,
    // Front-door deps (issue #29): a trivial in-memory projects capability plus
    // stub discovery/detection. The dedicated front-door tests exercise these
    // handlers directly; the shared harness only needs them to satisfy the shape.
    projects: {
      list: () => [],
      add: (input) => {
        const project = {
          id: "project-1",
          name: "orbital",
          path: input.discovery.path,
          kind: input.discovery.kind,
          repoCount: input.includedRepos.length,
          branchCount: 0,
          primaryBranch: input.primaryBranch,
          openPath: input.discovery.repos[0]?.path ?? input.discovery.path,
          addedAt: "2026-08-09T00:00:00.000Z",
        };
        return { project, projects: [project] };
      },
    },
    discoverProject: ({ path, kind }) =>
      Promise.resolve({ path, kind, repos: [], primaryBranch: "main" }),
    detectHarnesses: () => Promise.resolve([]),
    // Project detail (issue #37): a trivial substrate stub; the dedicated smart-list
    // tests exercise the derivation. The shared harness only needs the shape.
    projectDetail: () =>
      Promise.resolve({ viewer: { login: "rai" }, locals: [], prs: [], truncated: false }),
    cleanupWorktree: () => Promise.resolve({ ok: true }),
    flaggedReview: () => Promise.resolve({ status: "ok", findings: [] }),
    noiseReview: () => Promise.resolve({ status: "ok", groups: [] }),
    reviewAsk,
  };
  return {
    dispatch: createDispatch(deps),
    service,
    allowedRoots,
    buildCanvases,
    settings,
    consent,
    publishPort,
    publishConsent,
    reviewAsk,
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

describe("createDispatch — flagged.review routing (the live finding runner, issue #32)", () => {
  it("resolves the addressed review and returns the runner's FlaggedReview", async () => {
    const { dispatch } = harness();
    const review = await capturedReview(dispatch);
    const result = await dispatch("flagged.review", { reviewId: review.id });
    // The shared harness's runner stub answers with an honestly-empty ran-clean set.
    expect(result).toEqual({ status: "ok", findings: [] });
  });

  it("refuses flagged.review for a stale or unknown review id (the runner spends a model turn)", async () => {
    const { dispatch } = harness();
    await capturedReview(dispatch);
    await expect(dispatch("flagged.review", { reviewId: randomUUID() })).rejects.toThrow(
      /Review not found/,
    );
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

// ─────────────────────────────────────────────────────────────────────────────
// publish.review — the FIRST real GitHub egress (issue #21).
//
// The egress is gated behind: (1) an egress-side "what you see is what leaves"
// round-trip (payload/target fail-closed), (2) an explicit-target requirement,
// (3) the effective mode resolved from the WORKSPACE store, and (4) a single-use,
// (review+target+payload)-bound consent token consumed before ANY real post. The
// dry-run posts nothing and needs no token. Every test names the gate it exercises
// and is red-provable by neutralising exactly that gate.
// ─────────────────────────────────────────────────────────────────────────────

const SANDBOX_TARGET = {
  repo: { forge: "github", owner: "rbutera", name: "rennet-egress-sandbox" },
  number: 1,
  forgeRef: "PR_kwSANDBOX1",
  headOid: "deadbeefcafe0001",
};

function publishComments(): ReviewCommentInput[] {
  return [
    { path: "src/a.ts", line: 2, side: "RIGHT", type: "request-change", body: "rename this" },
    // A no-line disposition — folds into the review body, ledgered (never dropped).
    { path: "README.md", side: "RIGHT", type: "comment", body: "a file-level note" },
  ];
}

async function requestPublishConsent(
  dispatch: ReturnType<typeof createDispatch>,
  reviewId: string,
  target: typeof SANDBOX_TARGET,
  payload: string,
): Promise<string> {
  const out = (await dispatch("publish.requestConsent", {
    commandId: randomUUID(),
    reviewId,
    target,
    payload,
  })) as { authorization: string };
  return out.authorization;
}

interface PublishResult {
  dryRun: boolean;
  request: { endpoint: string; method: string; body: unknown };
  marker: string;
  ledger: { kind: string; path: string; detail: string }[];
  outcome: { reviewRef: string; url: string | null; reused: boolean } | null;
}

describe("createDispatch — publish.review egress (issue #21)", () => {
  it("(d) dry-run: builds the exact GitHub request, posts NOTHING, leaks no token", async () => {
    const port = fakePublishPort();
    const { dispatch } = harness(port);
    const review = await capturedReview(dispatch);
    const comments = publishComments();
    const payload = canonicalReviewPayload(comments);

    // dryRun omitted ⇒ defaults to TRUE (wrong-side-safe): nothing leaves.
    const out = (await dispatch("publish.review", {
      commandId: randomUUID(),
      reviewId: review.id,
      target: SANDBOX_TARGET,
      comments,
      payload,
    })) as PublishResult;

    expect(out.dryRun).toBe(true);
    expect(out.outcome).toBeNull();
    expect(port.posts).toHaveLength(0); // NOTHING posted
    const body = out.request.body as {
      query: string;
      variables: { input: Record<string, unknown> };
    };
    expect(body.query).toContain("addPullRequestReview");
    expect(body.query).not.toContain("comments:"); // never the deprecated field
    // publishComments carries a request-change ⇒ the derived verdict is REQUEST_CHANGES.
    expect(body.variables.input.event).toBe("REQUEST_CHANGES");
    expect(body.variables.input.commitOID).toBe(SANDBOX_TARGET.headOid); // head pinned
    expect(body.variables.input.pullRequestId).toBe(SANDBOX_TARGET.forgeRef);
    const threads = body.variables.input.threads as { line: number }[];
    expect(threads).toHaveLength(1); // line-anchored; the no-line note folded into body
    expect(threads[0]?.line).toBe(2);
    // The no-line disposition is visible on the ledger, never silently dropped.
    expect(out.ledger).toEqual([
      expect.objectContaining({ kind: "file-level-fold", path: "README.md" }),
    ]);
    // The descriptor carries NO secret — the bearer is a send-time header.
    expect(JSON.stringify(out.request)).not.toMatch(/authorization|bearer|token/i);
  });

  it("(d2) an explicit verdict override wins over the derived one", async () => {
    const { dispatch } = harness();
    const review = await capturedReview(dispatch);
    const comments = publishComments(); // a request-change ⇒ derived REQUEST_CHANGES
    const payload = canonicalReviewPayload(comments);

    const out = (await dispatch("publish.review", {
      commandId: randomUUID(),
      reviewId: review.id,
      target: SANDBOX_TARGET,
      comments,
      payload,
      verdict: "APPROVE", // overrides the derived REQUEST_CHANGES
      dryRun: true,
    })) as PublishResult;

    const body = out.request.body as { variables: { input: { event: string } } };
    expect(body.variables.input.event).toBe("APPROVE");
  });

  it("(b) refuses a payload that disagrees with the content — byte-exact, even near-matches", async () => {
    const { dispatch } = harness();
    const review = await capturedReview(dispatch);
    const comments = publishComments();
    const canonical = canonicalReviewPayload(comments);

    // A wholly-different payload, a trailing byte, and a truncation each fail CLOSED.
    for (const payload of [canonicalReviewPayload([]), `${canonical} `, canonical.slice(0, -1)]) {
      await expect(
        dispatch("publish.review", {
          commandId: randomUUID(),
          reviewId: review.id,
          target: SANDBOX_TARGET,
          comments,
          payload,
          dryRun: true,
        }),
      ).rejects.toThrow(/does not match/i);
    }
  });

  it("(a) refuses a REAL post with no consent under manual mode", async () => {
    const port = fakePublishPort();
    const { dispatch, settings } = harness(port);
    settings.setPermissionMode("manual"); // ASK
    const review = await capturedReview(dispatch);
    const comments = publishComments();
    const payload = canonicalReviewPayload(comments);

    await expect(
      dispatch("publish.review", {
        commandId: randomUUID(),
        reviewId: review.id,
        target: SANDBOX_TARGET,
        comments,
        payload,
        dryRun: false, // REAL egress
      }),
    ).rejects.toThrow(/not authorized/i);
    expect(port.posts).toHaveLength(0); // nothing left the machine
  });

  it("(c) refuses a REAL post whose consent token was minted for a different payload", async () => {
    const port = fakePublishPort();
    const { dispatch, settings } = harness(port);
    settings.setPermissionMode("manual");
    const review = await capturedReview(dispatch);
    const comments = publishComments();
    const payload = canonicalReviewPayload(comments);

    // A token bound to a DIFFERENT payload (a single-comment review).
    const otherComments: ReviewCommentInput[] = [
      { path: "src/a.ts", line: 2, side: "RIGHT", type: "comment", body: "x" },
    ];
    const wrongToken = await requestPublishConsent(
      dispatch,
      review.id,
      SANDBOX_TARGET,
      canonicalReviewPayload(otherComments),
    );

    await expect(
      dispatch("publish.review", {
        commandId: randomUUID(),
        reviewId: review.id,
        target: SANDBOX_TARGET,
        comments,
        payload,
        authorization: wrongToken,
        dryRun: false,
      }),
    ).rejects.toThrow(/not authorized/i);
    expect(port.posts).toHaveLength(0);
  });

  it("(f) refuses a REAL post whose consent token was minted for a different PR node id", async () => {
    // The adapter POSTS by forgeRef (the node id) while findExistingReview READS by
    // coordinates — independent renderer fields. A token bound to the coordinates but a
    // DIFFERENT forgeRef must NOT authorise, or a post could land on a different PR than
    // the one approved. Red-proof: dropping forgeRef from forgeTargetKey makes the two
    // keys equal and this post would be authorised.
    const port = fakePublishPort();
    const { dispatch, settings } = harness(port);
    settings.setPermissionMode("manual");
    const review = await capturedReview(dispatch);
    const comments = publishComments();
    const payload = canonicalReviewPayload(comments);

    // Token bound to SANDBOX_TARGET (its forgeRef). Same coordinates + head + payload,
    // but a different node id at egress.
    const token = await requestPublishConsent(dispatch, review.id, SANDBOX_TARGET, payload);
    const differentNode = { ...SANDBOX_TARGET, forgeRef: "PR_kwFORGEDNODE" };

    await expect(
      dispatch("publish.review", {
        commandId: randomUUID(),
        reviewId: review.id,
        target: differentNode,
        comments,
        payload,
        authorization: token,
        dryRun: false,
      }),
    ).rejects.toThrow(/not authorized/i);
    expect(port.posts).toHaveLength(0);
  });

  it("(e) happy path under manual: a matching single-use token authorizes exactly one post", async () => {
    const port = fakePublishPort();
    const { dispatch, settings } = harness(port);
    settings.setPermissionMode("manual");
    const review = await capturedReview(dispatch);
    const comments = publishComments();
    const payload = canonicalReviewPayload(comments);
    const token = await requestPublishConsent(dispatch, review.id, SANDBOX_TARGET, payload);

    const out = (await dispatch("publish.review", {
      commandId: randomUUID(),
      reviewId: review.id,
      target: SANDBOX_TARGET,
      comments,
      payload,
      authorization: token,
      dryRun: false,
    })) as PublishResult;

    expect(out.dryRun).toBe(false);
    expect(out.outcome).not.toBeNull();
    expect(port.posts).toHaveLength(1); // exactly one review posted
    // The wire event is COMMENT (asserted on the constructed request in the dry-run
    // test); a post carries no event field to check here.
    expect(port.posts[0]?.body).toContain(out.marker); // the idempotency marker is embedded

    // The token is single-use: a replay of the same token is refused.
    await expect(
      dispatch("publish.review", {
        commandId: randomUUID(),
        reviewId: review.id,
        target: SANDBOX_TARGET,
        comments,
        payload,
        authorization: token,
        dryRun: false,
      }),
    ).rejects.toThrow(/not authorized/i);
    expect(port.posts).toHaveLength(1); // still exactly one
  });

  it("(e2) auto mode posts without a token; the request is byte-identical to the dry-run", async () => {
    const port = fakePublishPort();
    const { dispatch, settings } = harness(port);
    const review = await capturedReview(dispatch);
    const comments = publishComments();
    const payload = canonicalReviewPayload(comments);

    const dry = (await dispatch("publish.review", {
      commandId: randomUUID(),
      reviewId: review.id,
      target: SANDBOX_TARGET,
      comments,
      payload,
      dryRun: true,
    })) as PublishResult;

    settings.setPermissionMode("auto"); // no prompt, no token needed
    const real = (await dispatch("publish.review", {
      commandId: randomUUID(),
      reviewId: review.id,
      target: SANDBOX_TARGET,
      comments,
      payload,
      dryRun: false,
    })) as PublishResult;

    expect(real.outcome).not.toBeNull();
    expect(port.posts).toHaveLength(1);
    // What the dry-run previewed equals what left the machine (R33), byte-for-byte.
    expect(JSON.stringify(real.request)).toBe(JSON.stringify(dry.request));
    expect(buildGitHubReviewRequest(port.posts[0] as ForgeReviewPost)).toEqual(real.request);
  });

  it("refuses an empty review (nothing to post is not a valid egress)", async () => {
    const port = fakePublishPort();
    const { dispatch, settings } = harness(port);
    settings.setPermissionMode("auto");
    const review = await capturedReview(dispatch);
    const empty: ReviewCommentInput[] = [];

    await expect(
      dispatch("publish.review", {
        commandId: randomUUID(),
        reviewId: review.id,
        target: SANDBOX_TARGET,
        comments: empty,
        payload: canonicalReviewPayload(empty),
        dryRun: false,
      }),
    ).rejects.toThrow(/no content/i);
    expect(port.posts).toHaveLength(0);
  });
});

describe("createDispatch — review.openPr (the GitHub PR front door)", () => {
  it("opens a PR into a review and grants access to its root", async () => {
    const { dispatch, allowedRoots } = harness();
    // The renderer picks the local clone first, which grants access to it.
    await dispatch("repository.choose", {});

    const result = (await dispatch("review.openPr", {
      commandId: randomUUID(),
      ref: "rbutera/rennet#42",
      repoPath: REPO,
    })) as { review: Review };

    // The review lands from the second source, in the identical shape + surface.
    expect(result.review.patchsets[0]?.source).toBe("github-local");
    expect(allowedRoots.has(result.review.repositoryRoot)).toBe(true);
  });

  it("refuses to open a PR against a repository access was not granted for", async () => {
    const { dispatch } = harness();
    await expect(
      dispatch("review.openPr", {
        commandId: randomUUID(),
        ref: "rbutera/rennet#42",
        repoPath: "/not-granted",
      }),
    ).rejects.toThrow(/access was not granted/i);
  });
});

/* ── The front door: projects + discovery routing (issue #29) ───────────────── */

function frontDoorHarness(seed: {
  projects?: Project[];
  discovery?: DiscoveryResult;
  detected?: DetectedHarness[];
}): {
  dispatch: ReturnType<typeof createDispatch>;
  allowedRoots: Set<string>;
  addCalls: { discovery: DiscoveryResult; includedRepos: string[]; primaryBranch: string }[];
  discoverCalls: { path: string; kind: ProjectKind }[];
} {
  const capture: PatchsetCapturePort = { capture: () => Promise.resolve(patchset()) };
  const service = new ReviewService(capture, new InMemoryStore());
  const allowedRoots = new Set<string>();
  const stored = [...(seed.projects ?? [])];
  const addCalls: { discovery: DiscoveryResult; includedRepos: string[]; primaryBranch: string }[] =
    [];
  const discoverCalls: { path: string; kind: ProjectKind }[] = [];
  const discovery: DiscoveryResult = seed.discovery ?? {
    path: "/orbital",
    kind: "workspace",
    primaryBranch: "main",
    repos: [{ name: "atlas", path: "/orbital/atlas", branches: 3 }],
  };
  const deps: DispatchDeps = {
    service,
    allowedRoots,
    chooseRepository: () => Promise.resolve(REPO),
    openPullRequest: (commandId) => service.createReviewFromPatchset(commandId, patchset()),
    startWatching: () => undefined,
    isRepositoryDirty: () => false,
    setRepositoryDirty: () => undefined,
    buildCanvases: () =>
      Promise.resolve({
        canvases: canvasSet(),
        elementDiffs: {},
        engine: { aiReview: false, claudeAvailable: false, codexAvailable: false },
      }),
    settings: { permissionMode: () => "manual", setPermissionMode: () => undefined },
    consent: createHarnessConsentAuthority(),
    publishPort: fakePublishPort(),
    publishConsent: createPublishConsentAuthority(),
    projects: {
      list: () => stored,
      add: (input) => {
        addCalls.push({ ...input, includedRepos: [...input.includedRepos] });
        const project: Project = {
          id: "added-1",
          name: "orbital",
          path: input.discovery.path,
          kind: input.discovery.kind,
          repoCount: input.includedRepos.length,
          branchCount: 3,
          primaryBranch: input.primaryBranch,
          openPath: input.discovery.repos[0]?.path ?? input.discovery.path,
          addedAt: "2026-08-09T00:00:00.000Z",
        };
        stored.push(project);
        return { project, projects: [...stored] };
      },
    },
    discoverProject: (input) => {
      discoverCalls.push(input);
      return Promise.resolve({ ...discovery, path: input.path, kind: input.kind });
    },
    detectHarnesses: () => Promise.resolve(seed.detected ?? []),
    projectDetail: () =>
      Promise.resolve({ viewer: { login: "rai" }, locals: [], prs: [], truncated: false }),
    cleanupWorktree: () => Promise.resolve({ ok: true }),
    flaggedReview: () => Promise.resolve({ status: "ok", findings: [] }),
    noiseReview: () => Promise.resolve({ status: "ok", groups: [] }),
    reviewAsk: {
      askOrchestrator: () =>
        Promise.resolve({ model: "Orchestrator · Claude", answer: "orchestrator" }),
      askCodex: () => Promise.resolve({ model: "codex", answer: "codex" }),
    },
  };
  return { dispatch: createDispatch(deps), allowedRoots, addCalls, discoverCalls };
}

function persistedProject(overrides: Partial<Project> = {}): Project {
  return {
    id: "p1",
    name: "orbital",
    path: "/orbital",
    kind: "workspace",
    repoCount: 2,
    branchCount: 5,
    primaryBranch: "main",
    openPath: "/orbital/atlas",
    addedAt: "2026-08-09T00:00:00.000Z",
    ...overrides,
  };
}

describe("createDispatch — front door (issue #29)", () => {
  it("projects.list returns the stored projects and GRANTS each open target", async () => {
    const project = persistedProject();
    const { dispatch, allowedRoots } = frontDoorHarness({ projects: [project] });
    // The open target is not pre-granted: listing is what makes a persisted row openable.
    expect(allowedRoots.has(project.openPath)).toBe(false);

    const out = (await dispatch("projects.list", {})) as { projects: Project[] };
    expect(out.projects).toEqual([project]);
    expect(allowedRoots.has(project.openPath)).toBe(true);
  });

  it("project.discover refuses a path that was never chosen (the read-only gate)", async () => {
    const { dispatch } = frontDoorHarness({});
    await expect(
      dispatch("project.discover", {
        commandId: randomUUID(),
        path: "/never/chosen",
        kind: "repo",
      }),
    ).rejects.toThrow(/Repository access was not granted/);
  });

  it("project.discover returns discovery for a chosen (granted) path", async () => {
    const { dispatch, discoverCalls } = frontDoorHarness({});
    // repository.choose grants REPO into allowedRoots.
    await dispatch("repository.choose", {});
    const out = (await dispatch("project.discover", {
      commandId: randomUUID(),
      path: REPO,
      kind: "repo",
    })) as { discovery: DiscoveryResult };
    expect(out.discovery.path).toBe(REPO);
    expect(discoverCalls).toEqual([{ path: REPO, kind: "repo" }]);
  });

  it("projects.add derives + persists from the confirmed discovery and grants the open target", async () => {
    const { dispatch, allowedRoots, addCalls } = frontDoorHarness({});
    const discovery: DiscoveryResult = {
      path: "/orbital",
      kind: "workspace",
      primaryBranch: "main",
      repos: [
        { name: "atlas", path: "/orbital/atlas", branches: 3 },
        { name: "docs", path: "/orbital/docs", branches: 2 },
      ],
    };
    const out = (await dispatch("projects.add", {
      commandId: randomUUID(),
      discovery,
      includedRepos: ["atlas"],
      primaryBranch: "trunk",
    })) as { project: Project; projects: Project[] };

    expect(addCalls).toEqual([{ discovery, includedRepos: ["atlas"], primaryBranch: "trunk" }]);
    expect(out.project.openPath).toBe("/orbital/atlas");
    expect(out.projects).toHaveLength(1);
    // The freshly added project is immediately openable.
    expect(allowedRoots.has("/orbital/atlas")).toBe(true);
  });

  it("harness.detect returns the detected harnesses for the ambient line", async () => {
    const { dispatch } = frontDoorHarness({
      detected: [
        { id: "claude", version: "2.1.0" },
        { id: "gh", version: "2.55.0" },
      ],
    });
    const out = (await dispatch("harness.detect", {})) as { detected: DetectedHarness[] };
    expect(out.detected.map((harness) => harness.id)).toEqual(["claude", "gh"]);
  });
});

describe("createDispatch — review.ask routing (issue #139)", () => {
  it("orchestrator mode asks the orchestrator ONCE and Codex ZERO times", async () => {
    const { dispatch, reviewAsk } = harness();
    const out = (await dispatch("review.ask", {
      commandId: randomUUID(),
      reviewId: "review-1",
      mode: "orchestrator",
      question: "is the retry-after in seconds or ms?",
    })) as { mode: string; primary: { model: string }; secondOpinion?: unknown };
    expect(reviewAsk.askOrchestrator).toHaveBeenCalledTimes(1);
    expect(reviewAsk.askCodex).not.toHaveBeenCalled();
    expect(out.mode).toBe("orchestrator");
    expect(out.primary.model).toBe("Orchestrator · Claude");
    expect(out.secondOpinion).toBeUndefined();
  });

  it("an OMITTED mode defaults to orchestrator — never fires a second model", async () => {
    const { dispatch, reviewAsk } = harness();
    const out = (await dispatch("review.ask", {
      commandId: randomUUID(),
      reviewId: "review-1",
      question: "no mode given",
    })) as { mode: string; secondOpinion?: unknown };
    expect(out.mode).toBe("orchestrator");
    expect(reviewAsk.askCodex).not.toHaveBeenCalled();
    expect(out.secondOpinion).toBeUndefined();
  });

  it("both mode asks the orchestrator ONCE and Codex ONCE — two labelled answers, no third", async () => {
    const { dispatch, reviewAsk } = harness();
    const out = (await dispatch("review.ask", {
      commandId: randomUUID(),
      reviewId: "review-1",
      mode: "both",
      question: "does the client agree?",
    })) as {
      mode: string;
      primary: { model: string };
      secondOpinion?: { model: string };
    };
    expect(reviewAsk.askOrchestrator).toHaveBeenCalledTimes(1);
    expect(reviewAsk.askCodex).toHaveBeenCalledTimes(1);
    expect(out.mode).toBe("both");
    expect(out.primary.model).toBe("Orchestrator · Claude");
    expect(out.secondOpinion?.model).toBe("codex");
    // No merged answer can exist — the result has exactly these three keys.
    expect(Object.keys(out).sort()).toEqual(["mode", "primary", "secondOpinion"]);
  });

  it("threads the reviewId to the ports (a question is ABOUT a review)", async () => {
    const { dispatch, reviewAsk } = harness();
    await dispatch("review.ask", {
      commandId: randomUUID(),
      reviewId: "review-42",
      mode: "both",
      question: "q",
    });
    expect(reviewAsk.askOrchestrator).toHaveBeenCalledWith({
      reviewId: "review-42",
      question: "q",
    });
    expect(reviewAsk.askCodex).toHaveBeenCalledWith({ reviewId: "review-42", question: "q" });
  });
});
