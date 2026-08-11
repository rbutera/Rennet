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
  ProcessedRepoSummary,
  Project,
  ProjectKind,
  ProjectProcessEvent,
} from "@rennet/protocol";
import type { Canvas, CanvasAngle, FlaggedReview, Patchset, Review } from "@rennet/types";
import { CANVAS_ANGLES } from "@rennet/types";
import { describe, expect, it, vi } from "vitest";
import { createDispatch, type DispatchDeps } from "./dispatch";
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
  opts: Pick<DispatchDeps, "symbolLookup" | "openInEditor" | "openSpecChange"> = {},
): {
  dispatch: ReturnType<typeof createDispatch>;
  service: ReviewService;
  allowedRoots: Set<string>;
  buildCanvases: ReturnType<typeof vi.fn>;
  publishPort: ForgePublishPort & { posts: ForgeReviewPost[] };
  publishConsent: PublishConsentAuthority;
  reviewAsk: {
    askOrchestrator: ReturnType<typeof vi.fn>;
    askCodex: ReturnType<typeof vi.fn>;
  };
  flaggedReviewSpy: ReturnType<typeof vi.fn>;
} {
  const capture: PatchsetCapturePort = { capture: () => Promise.resolve(patchset()) };
  const service = new ReviewService(capture, new InMemoryStore());
  const allowedRoots = new Set<string>();
  let dirty = false;
  const buildCanvases = vi.fn(() =>
    Promise.resolve({
      canvases: canvasSet(),
      elementDiffs: { e1: { path: "src/a.ts", paths: ["src/a.ts"], diff: "@@ -1,1 +1,2 @@\n+x" } },
      engine: { aiReview: true, claudeAvailable: true, codexAvailable: true },
    }),
  );
  const publishConsent = createPublishConsentAuthority();
  // review.ask ports (issue #139) as recording spies, so a test can assert the
  // orchestrator is asked exactly once and Codex only in "both" mode — the whole
  // point of the issue is that negative guarantee on the REAL command path.
  const reviewAsk = {
    askOrchestrator: vi.fn<(input: { review: Review; question: string }) => Promise<AskAnswer>>(
      async () => ({ model: "Orchestrator · Claude", answer: "orchestrator's answer" }),
    ),
    askCodex: vi.fn<(input: { review: Review; question: string }) => Promise<AskAnswer>>(
      async () => ({
        model: "codex",
        answer: "codex's answer",
      }),
    ),
  };
  const flaggedReviewSpy = vi.fn<(review: Review, deepReview: boolean) => Promise<FlaggedReview>>(
    async () => ({
      status: "ok",
      findings: [],
    }),
  );
  const deps: DispatchDeps = {
    service,
    allowedRoots,
    chooseRepository: () => Promise.resolve(REPO),
    openPullRequest: (commandId, _ref, _repoPath, retrospective) =>
      service.createReviewFromPatchset(commandId, prPatchset(), { retrospective }),
    startWatching: () => undefined,
    isRepositoryDirty: () => dirty,
    setRepositoryDirty: (value) => {
      dirty = value;
    },
    buildCanvases,
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
    processProject: () => Promise.resolve({ repos: [] }),
    discoverProject: ({ path, kind }) =>
      Promise.resolve({ path, kind, repos: [], primaryBranch: "main" }),
    detectHarnesses: () => Promise.resolve([]),
    // Project detail (issue #37): a trivial substrate stub; the dedicated smart-list
    // tests exercise the derivation. The shared harness only needs the shape.
    projectDetail: () =>
      Promise.resolve({ viewer: { login: "rai" }, locals: [], prs: [], truncated: false }),
    cleanupWorktree: () => Promise.resolve({ ok: true }),
    // Recording spy so a test can assert what `deepReview` the dispatch passed the
    // runner — the whole point of the default-dual mandate is that guarantee at the
    // real command boundary. The stub answers with an honestly-empty ran-clean set.
    flaggedReview: flaggedReviewSpy,
    noiseReview: () => Promise.resolve({ status: "ok", groups: [] }),
    reviewAsk,
    symbolLookup: opts.symbolLookup,
    openInEditor: opts.openInEditor,
    openSpecChange: opts.openSpecChange,
  };
  return {
    dispatch: createDispatch(deps),
    service,
    allowedRoots,
    buildCanvases,
    publishPort,
    publishConsent,
    reviewAsk,
    flaggedReviewSpy,
  };
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

    // Running the harness just runs — no consent token, no permission mode.
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

  it("defaults to DUAL-model review when deepReview is OMITTED (Rai's mandate: not opt-in)", async () => {
    const { dispatch, flaggedReviewSpy } = harness();
    const review = await capturedReview(dispatch);
    // The renderer sends only the reviewId — no deepReview flag at all.
    await dispatch("flagged.review", { reviewId: review.id });
    expect(flaggedReviewSpy).toHaveBeenCalledTimes(1);
    // The dispatch defaulted the omitted flag to TRUE — both provider seats run.
    expect(flaggedReviewSpy.mock.calls[0]?.[1]).toBe(true);
  });

  it("passes an explicit deepReview:false straight through as the manual opt-DOWN to quick", async () => {
    const { dispatch, flaggedReviewSpy } = harness();
    const review = await capturedReview(dispatch);
    await dispatch("flagged.review", { reviewId: review.id, deepReview: false });
    expect(flaggedReviewSpy.mock.calls[0]?.[1]).toBe(false);
  });
});

describe("createDispatch — openspec.change routing (the live Spec source, wireframes #9)", () => {
  it("resolves the addressed review and returns the reader's parsed change", async () => {
    const change = { name: "my-change", specDeltas: [] };
    const { dispatch } = harness(undefined, { openSpecChange: () => Promise.resolve(change) });
    const review = await capturedReview(dispatch);
    expect(await dispatch("openspec.change", { reviewId: review.id })).toEqual(change);
  });

  it("returns null when no reader is wired (the honest empty Spec angle, never a fixture)", async () => {
    const { dispatch } = harness();
    const review = await capturedReview(dispatch);
    expect(await dispatch("openspec.change", { reviewId: review.id })).toBeNull();
  });

  it("refuses openspec.change for a stale or unknown review id", async () => {
    const { dispatch } = harness();
    await capturedReview(dispatch);
    await expect(dispatch("openspec.change", { reviewId: randomUUID() })).rejects.toThrow(
      /Review not found/,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// publish.review — the FIRST real GitHub egress (issue #21).
//
// Posting a review to GitHub is an EXTERNAL act, so unlike running a model (which
// just runs) a real send stays explicitly confirmed. The egress is gated behind:
// (1) an egress-side "what you see is what leaves" round-trip (payload/target
// fail-closed), (2) an explicit-target requirement, and (3) a single-use,
// (review+target+payload)-bound consent token ALWAYS consumed before ANY real post.
// The dry-run posts nothing and needs no token. Every test names the gate it
// exercises and is red-provable by neutralising exactly that gate.
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

  it("(a) refuses a REAL post with no consent token (posting stays explicitly confirmed)", async () => {
    const port = fakePublishPort();
    const { dispatch } = harness(port);
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
    const { dispatch } = harness(port);
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
    const { dispatch } = harness(port);
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

  it("(e) happy path: a matching single-use token authorizes exactly one post", async () => {
    const port = fakePublishPort();
    const { dispatch } = harness(port);
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

  it("(e2) the real post's request is byte-identical to the dry-run's", async () => {
    const port = fakePublishPort();
    const { dispatch } = harness(port);
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

    // Posting stays explicitly confirmed: the real send consumes the single-use token.
    const token = await requestPublishConsent(dispatch, review.id, SANDBOX_TARGET, payload);
    const real = (await dispatch("publish.review", {
      commandId: randomUUID(),
      reviewId: review.id,
      target: SANDBOX_TARGET,
      comments,
      payload,
      authorization: token,
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
    const { dispatch } = harness(port);
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

  it("opens a merged PR RETROSPECTIVELY (read-only): the review is flagged", async () => {
    const { dispatch } = harness();
    await dispatch("repository.choose", {});

    const result = (await dispatch("review.openPr", {
      commandId: randomUUID(),
      ref: "rbutera/rennet#42",
      repoPath: REPO,
      retrospective: true,
    })) as { review: Review };

    // The read-only intent is carried on the review, from the same second source.
    expect(result.review.retrospective).toBe(true);
    expect(result.review.patchsets[0]?.source).toBe("github-local");
  });

  it("a normal (omitted) open leaves the review postable — retrospective undefined", async () => {
    const { dispatch } = harness();
    await dispatch("repository.choose", {});

    const result = (await dispatch("review.openPr", {
      commandId: randomUUID(),
      ref: "rbutera/rennet#42",
      repoPath: REPO,
    })) as { review: Review };

    expect(result.review.retrospective).toBeUndefined();
  });

  it("a RETROSPECTIVE review STRUCTURALLY refuses publish — nothing egresses, even on dry-run", async () => {
    const port = fakePublishPort();
    const { dispatch } = harness(port);
    await dispatch("repository.choose", {});
    const opened = (await dispatch("review.openPr", {
      commandId: randomUUID(),
      ref: "rbutera/rennet#42",
      repoPath: REPO,
      retrospective: true,
    })) as { review: Review };
    const comments = publishComments();

    // The refusal precedes the whole egress machinery: even a well-formed dry-run
    // (which posts nothing anyway) and a real send are both refused, in one message.
    for (const dryRun of [true, false]) {
      await expect(
        dispatch("publish.review", {
          commandId: randomUUID(),
          reviewId: opened.review.id,
          target: SANDBOX_TARGET,
          comments,
          payload: canonicalReviewPayload(comments),
          dryRun,
        }),
      ).rejects.toThrow(/retrospective review/i);
    }
    expect(port.posts).toHaveLength(0); // nothing ever left the machine
  });
});

/* ── The front door: projects + discovery routing (issue #29) ───────────────── */

function frontDoorHarness(seed: {
  projects?: Project[];
  discovery?: DiscoveryResult;
  detected?: DetectedHarness[];
  processEvents?: ProjectProcessEvent[];
  processedRepos?: ProcessedRepoSummary[];
}): {
  dispatch: ReturnType<typeof createDispatch>;
  allowedRoots: Set<string>;
  addCalls: { discovery: DiscoveryResult; includedRepos: string[]; primaryBranch: string }[];
  discoverCalls: { path: string; kind: ProjectKind }[];
  processCalls: { projectId: string }[];
} {
  const capture: PatchsetCapturePort = { capture: () => Promise.resolve(patchset()) };
  const service = new ReviewService(capture, new InMemoryStore());
  const allowedRoots = new Set<string>();
  const stored = [...(seed.projects ?? [])];
  const addCalls: { discovery: DiscoveryResult; includedRepos: string[]; primaryBranch: string }[] =
    [];
  const discoverCalls: { path: string; kind: ProjectKind }[] = [];
  const processCalls: { projectId: string }[] = [];
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
    processProject: (input, emit) => {
      processCalls.push(input);
      for (const event of seed.processEvents ?? []) emit(event);
      return Promise.resolve({ repos: seed.processedRepos ?? [] });
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
  return { dispatch: createDispatch(deps), allowedRoots, addCalls, discoverCalls, processCalls };
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

  it("project.process streams the host's narration, then emits a terminal done, and returns the summary", async () => {
    const summary: ProcessedRepoSummary = {
      repo: "atlas",
      path: "/orbital/atlas",
      ok: true,
      files: 12,
      symbols: 8,
      references: 20,
    };
    const { dispatch, processCalls } = frontDoorHarness({
      processEvents: [
        { kind: "repo-start", repo: "atlas", index: 1, total: 1 },
        {
          kind: "stage",
          repo: "atlas",
          stage: "tree",
          note: "Reading the file tree",
          detail: "12 files",
        },
        { kind: "repo-done", repo: "atlas", summary },
      ],
      processedRepos: [summary],
    });

    const streamed: ProjectProcessEvent[] = [];
    const out = (await dispatch(
      "project.process",
      { commandId: randomUUID(), projectId: "p1" },
      { emitProgress: (event) => streamed.push(event) },
    )) as { repos: ProcessedRepoSummary[] };

    expect(processCalls).toEqual([{ projectId: "p1" }]);
    // The host's three narration events reached the sink, and dispatch appended the
    // terminal `done` carrying the same summaries it resolves with.
    expect(streamed.map((event) => event.kind)).toEqual([
      "repo-start",
      "stage",
      "repo-done",
      "done",
    ]);
    const done = streamed.at(-1);
    expect(done).toMatchObject({ kind: "done", repos: [summary] });
    expect(out.repos).toEqual([summary]);
  });

  it("project.process without a progress sink still resolves with the summary (no push channel)", async () => {
    const summary: ProcessedRepoSummary = {
      repo: "atlas",
      path: "/orbital/atlas",
      ok: true,
      files: 3,
      symbols: 1,
    };
    const { dispatch } = frontDoorHarness({ processedRepos: [summary] });
    // No `ctx` at all — the request/response path, exactly like a bridge with no onProgress.
    const out = (await dispatch("project.process", {
      commandId: randomUUID(),
      projectId: "p1",
    })) as { repos: ProcessedRepoSummary[] };
    expect(out.repos).toEqual([summary]);
  });
});

describe("createDispatch — review.ask routing (issue #139)", () => {
  // Open a real review. Asking a model just runs — no permission gate, no token —
  // so these tests pin ROUTING directly.
  async function openReview(): Promise<{
    dispatch: ReturnType<typeof createDispatch>;
    reviewAsk: { askOrchestrator: ReturnType<typeof vi.fn>; askCodex: ReturnType<typeof vi.fn> };
    service: ReviewService;
    review: Review;
  }> {
    const h = harness();
    const review = await capturedReview(h.dispatch);
    return {
      dispatch: h.dispatch,
      reviewAsk: h.reviewAsk,
      service: h.service,
      review,
    };
  }

  it("orchestrator mode asks the orchestrator ONCE and Codex ZERO times", async () => {
    const { dispatch, reviewAsk, review } = await openReview();
    const out = (await dispatch("review.ask", {
      commandId: randomUUID(),
      reviewId: review.id,
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
    const { dispatch, reviewAsk, review } = await openReview();
    const out = (await dispatch("review.ask", {
      commandId: randomUUID(),
      reviewId: review.id,
      question: "no mode given",
    })) as { mode: string; secondOpinion?: unknown };
    expect(out.mode).toBe("orchestrator");
    expect(reviewAsk.askCodex).not.toHaveBeenCalled();
    expect(out.secondOpinion).toBeUndefined();
  });

  it("both mode asks the orchestrator ONCE and Codex ONCE — two labelled answers, no third", async () => {
    const { dispatch, reviewAsk, review } = await openReview();
    const out = (await dispatch("review.ask", {
      commandId: randomUUID(),
      reviewId: review.id,
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

  it("hands BOTH legs one resolved snapshot — a mid-ask patchset swap cannot cross them (P1-2)", async () => {
    const { dispatch, reviewAsk, service, review } = await openReview();
    // Resolution goes through `service.bootstrap()`; resolve-once means EXACTLY one
    // call feeds both legs. Per-leg resolution (the bug) would call it twice.
    const bootstrapSpy = vi.spyOn(service, "bootstrap");
    const seen: string[] = [];
    reviewAsk.askOrchestrator.mockImplementation(async ({ review: r }: { review: Review }) => {
      seen.push(`o:${r.activePatchsetId}`);
      return { model: "Orchestrator · Claude", answer: "a" };
    });
    reviewAsk.askCodex.mockImplementation(async ({ review: r }: { review: Review }) => {
      seen.push(`c:${r.activePatchsetId}`);
      return { model: "codex", answer: "b" };
    });
    await dispatch("review.ask", {
      commandId: randomUUID(),
      reviewId: review.id,
      mode: "both",
      question: "q",
    });
    expect(bootstrapSpy).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([`o:${review.activePatchsetId}`, `c:${review.activePatchsetId}`]);
  });

  it("threads the RESOLVED review to both ports (a question is ABOUT the open review)", async () => {
    const { dispatch, reviewAsk, review } = await openReview();
    await dispatch("review.ask", {
      commandId: randomUUID(),
      reviewId: review.id,
      mode: "both",
      question: "q",
    });
    expect(reviewAsk.askOrchestrator).toHaveBeenCalledWith({ review, question: "q" });
    expect(reviewAsk.askCodex).toHaveBeenCalledWith({ review, question: "q" });
  });
});

describe("createDispatch — review.symbolLookup (the symbol inspector, wireframes #8)", () => {
  it("resolves the review ONCE and threads it to the symbolLookup port", async () => {
    const symbolLookup = vi.fn(async ({ name }: { review: Review; name: string }) => ({
      name,
      definition: {
        status: "ok" as const,
        sites: [{ path: "src/x.ts", line: 3, kind: "function", scope: null }],
      },
      references: { status: "ok" as const, sites: [{ path: "src/y.ts", line: 9, scope: null }] },
    }));
    const h = harness(undefined, { symbolLookup });
    const review = await capturedReview(h.dispatch);

    const out = (await h.dispatch("review.symbolLookup", {
      reviewId: review.id,
      name: "makeThing",
    })) as { name: string; definition: { status: string }; references: { status: string } };

    expect(symbolLookup).toHaveBeenCalledTimes(1);
    expect(symbolLookup).toHaveBeenCalledWith({ review, name: "makeThing" });
    expect(out.name).toBe("makeThing");
    expect(out.definition.status).toBe("ok");
    expect(out.references.status).toBe("ok");
  });

  it("refuses a stale/unknown reviewId", async () => {
    const symbolLookup = vi.fn();
    const h = harness(undefined, { symbolLookup });
    await capturedReview(h.dispatch);
    await expect(
      h.dispatch("review.symbolLookup", { reviewId: "not-the-open-review", name: "x" }),
    ).rejects.toThrow(/Review not found/);
    expect(symbolLookup).not.toHaveBeenCalled();
  });

  it("with NO symbolic backend wired, answers unavailable for both sections (never throws)", async () => {
    const h = harness(); // no symbolLookup dep
    const review = await capturedReview(h.dispatch);
    const out = (await h.dispatch("review.symbolLookup", {
      reviewId: review.id,
      name: "x",
    })) as { definition: { status: string }; references: { status: string } };
    expect(out.definition.status).toBe("unavailable");
    expect(out.references.status).toBe("unavailable");
  });
});

describe("createDispatch — review.openInEditor (wireframes #8)", () => {
  it("resolves the review and threads it to the openInEditor port", async () => {
    const openInEditor = vi.fn(async () => ({ ok: true }));
    const h = harness(undefined, { openInEditor });
    const review = await capturedReview(h.dispatch);
    const out = (await h.dispatch("review.openInEditor", {
      reviewId: review.id,
      path: "src/x.ts",
      line: 12,
    })) as { ok: boolean };
    expect(openInEditor).toHaveBeenCalledWith({ review, path: "src/x.ts", line: 12 });
    expect(out.ok).toBe(true);
  });

  it("with NO editor port wired, answers ok:false (never throws)", async () => {
    const h = harness();
    const review = await capturedReview(h.dispatch);
    const out = (await h.dispatch("review.openInEditor", {
      reviewId: review.id,
      path: "src/x.ts",
    })) as { ok: boolean };
    expect(out.ok).toBe(false);
  });
});
