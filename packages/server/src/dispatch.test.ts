import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AskLogStore, buildGitHubReviewRequest, FileThreadStore } from "@rennet/adapters";
import {
  type AskAnswer,
  type ComposePort,
  canonicalPrSubmissionPayload,
  canonicalReviewPayload,
  composeHandoffBundle,
  decompose,
  deriveReviewEvent,
  type ForgePublishPort,
  type ForgeReviewEvent,
  type ForgeReviewPost,
  type HandoffRunPort,
  type HarnessEvent,
  type PatchsetCapturePort,
  type ReviewBodyNote,
  type ReviewCommentInput,
  type ReviewEvent,
  ReviewService,
  type ReviewStorePort,
  reviewRoleMappings,
} from "@rennet/core";
import type {
  ComposedHandoffBundle,
  FindingElement,
  FlaggedReview,
  PatchFile,
  Patchset,
  Review,
} from "@rennet/protocol";
import {
  type CoachMarks,
  type DetectedForge,
  type DetectedHarness,
  type DiscoveryResult,
  type ProcessedRepoSummary,
  type Project,
  type ProjectKind,
  type ProjectProcessEvent,
  type ProjectProgressEvent,
  type ReviewAskStreamEvent,
  type ReviewRoleMapping,
  reviewAskStreamEventSchema,
} from "@rennet/protocol";
import { describe, expect, it, vi } from "vitest";
import { createDispatch, type DispatchDeps } from "./dispatch";
import { InFlightReviews } from "./in-flight-reviews";
import { LiveTurnRegistry } from "./live-turn-registry";
import {
  createLiveOrchestratorAsk,
  createLiveReviewAskPorts,
  NO_HARNESS_ANSWER,
} from "./review-ask-live";

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

// The real PR coordinates an opened-PR review posts to (issue #21). The harness's
// `openPullRequest` stamps this as the review's `postTarget`, so a real post from
// that review targets its OWN pull request — the target-binding gate's happy case.
// Defined here (above the harness) because the harness needs it.
const SANDBOX_TARGET = {
  repo: { forge: "github", owner: "rbutera", name: "rennet-egress-sandbox" },
  number: 1,
  forgeRef: "PR_kwSANDBOX1",
  headOid: "deadbeefcafe0001",
};

class InMemoryStore implements ReviewStorePort {
  #latest: Review | null = null;
  readonly #byId = new Map<string, Review>();
  readonly #receipts = new Map<string, Review>();
  readonly events: ReviewEvent[] = [];
  latestReview(repositoryRoot?: string): Review | null {
    if (repositoryRoot === undefined) return this.#latest;
    return this.#latest && this.#latest.repositoryRoot === repositoryRoot ? this.#latest : null;
  }
  reviewById(reviewId: string): Review | null {
    return this.#byId.get(reviewId) ?? null;
  }
  patchsetById(patchsetId: string): Patchset | null {
    for (const review of this.#byId.values()) {
      const found = review.patchsets.find((patchset) => patchset.id === patchsetId);
      if (found) return found;
    }
    return null;
  }
  receipt(commandId: string, digest: string): Review | null {
    return this.#receipts.get(`${commandId}:${digest}`) ?? null;
  }
  commit(commandId: string, digest: string, events: ReviewEvent[], result: Review): Review {
    this.events.push(...events);
    this.#latest = result;
    this.#byId.set(result.id, result);
    this.#receipts.set(`${commandId}:${digest}`, result);
    return result;
  }
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
  opts: Pick<
    DispatchDeps,
    "symbolLookup" | "openInEditor" | "openSpecChange" | "openSpecCoverage" | "settings"
  > = {},
  extra: {
    capturePort?: PatchsetCapturePort;
    runHandoffTurn?: DispatchDeps["runHandoffTurn"];
    composeBundle?: DispatchDeps["composeBundle"];
    liveTurns?: DispatchDeps["liveTurns"];
    submitPullRequest?: DispatchDeps["submitPullRequest"];
    draftDeltaDigest?: DispatchDeps["draftDeltaDigest"];
    flaggedReview?: DispatchDeps["flaggedReview"];
    repositoryExists?: DispatchDeps["repositoryExists"];
    pushTokens?: DispatchDeps["pushTokens"];
    acknowledgeAttention?: DispatchDeps["acknowledgeAttention"];
    raiseAttention?: DispatchDeps["raiseAttention"];
    inFlightReviews?: DispatchDeps["inFlightReviews"];
    threadPersistence?: DispatchDeps["threadPersistence"];
    /** Swap the recording spies for REAL ports (F1's E2E runs the live orchestrator
     *  ask over a fake harness turn port through this seam). */
    reviewAsk?: DispatchDeps["reviewAsk"];
    reattachThreads?: DispatchDeps["reattachThreads"];
    projectContextMap?: DispatchDeps["projectContextMap"];
    projectContextAsk?: DispatchDeps["projectContextAsk"];
    knowledgeDisposition?: DispatchDeps["knowledgeDisposition"];
    onReviewOpened?: DispatchDeps["onReviewOpened"];
  } = {},
): {
  dispatch: ReturnType<typeof createDispatch>;
  service: ReviewService;
  store: InMemoryStore;
  allowedRoots: Set<string>;
  startWatching: ReturnType<typeof vi.fn>;
  publishPort: ForgePublishPort & { posts: ForgeReviewPost[] };
  reviewAsk: {
    askOrchestrator: ReturnType<typeof vi.fn>;
    askCodex: ReturnType<typeof vi.fn>;
  };
  threadPersistence: {
    upsertThread: ReturnType<typeof vi.fn>;
    putMessage: ReturnType<typeof vi.fn>;
  };
  flaggedReviewSpy: ReturnType<typeof vi.fn>;
  refineCommentSpy: ReturnType<typeof vi.fn>;
  draftPrBodySpy: ReturnType<typeof vi.fn>;
} {
  const capture: PatchsetCapturePort = extra.capturePort ?? {
    capture: () => Promise.resolve(patchset()),
  };
  const store = new InMemoryStore();
  const service = new ReviewService(capture, store);
  const allowedRoots = new Set<string>();
  const startWatching = vi.fn<(root: string) => void>();
  let dirty = false;
  // review.ask ports (issue #139) as recording spies, so a test can assert the
  // orchestrator is asked exactly once and Codex only in "both" mode — the whole
  // point of the issue is that negative guarantee on the REAL command path.
  const reviewAsk = {
    askOrchestrator: vi.fn<
      (input: {
        review: Review;
        question: string;
        onDelta?: (text: string) => void;
        onEvent?: (event: HarnessEvent) => void;
        selection?: { anchor: string; excerpt?: string; target?: string; generation?: string };
        turnId?: string;
        onFocus?: (anchor: string) => void;
      }) => Promise<AskAnswer>
    >(async () => ({ model: "Orchestrator · Claude", answer: "orchestrator's answer" })),
    askCodex: vi.fn<(input: { review: Review; question: string }) => Promise<AskAnswer>>(
      async () => ({
        model: "codex",
        answer: "codex's answer",
      }),
    ),
  };
  // #251 persistence spies, so a test can assert the streaming ask writes a `streaming`
  // placeholder BEFORE the turn and the durable answer AFTER (the crash-recovery seam).
  const threadPersistence = { upsertThread: vi.fn(), putMessage: vi.fn() };
  const flaggedReviewSpy = vi.fn<DispatchDeps["flaggedReview"]>(async () => ({
    review: { status: "ok", findings: [] },
    adjudication: null,
  }));
  // The comment-refinement producer (issue #19) as a recording spy, so a test can
  // assert the LIVE command path invokes it with the RESOLVED review + exact input —
  // the boundary the "all-unavailable still-green" catch (P1-7) proved untested.
  const refineCommentSpy = vi.fn<NonNullable<DispatchDeps["refineComment"]>>(async () => ({
    status: "no-change" as const,
    model: "test-model",
  }));
  // The PR-body drafting producer (issue #74, M26) as a recording spy, so a test can
  // assert the LIVE command path invokes it with the RESOLVED review + the drafting
  // material — and that a build WITHOUT the drafter answers an honest `unavailable`.
  const draftPrBodySpy = vi.fn<NonNullable<DispatchDeps["draftPrBody"]>>(async () => ({
    status: "drafted" as const,
    title: "A drafted title",
    body: "A drafted body.",
    model: "test-model",
  }));
  const deps: DispatchDeps = {
    service,
    allowedRoots,
    askLog: new AskLogStore(mkdtempSync(join(tmpdir(), "rennet-asks-"))),
    projectContextMap:
      extra.projectContextMap ?? (() => Promise.resolve({ status: "absent", reason: "stub" })),
    projectContextAsk:
      extra.projectContextAsk ??
      (() =>
        Promise.resolve({
          status: "failed",
          failureReason: "stub",
          cost: {
            turns: 0,
            model: null,
            effort: null,
            budgetGranted: true,
            overage: false,
            resolution: null,
          },
        })),
    knowledgeDisposition:
      extra.knowledgeDisposition ??
      (({ statementId }) => Promise.resolve({ status: "not-found", statementId })),
    pairing: {
      mint: () => ({ code: "PAIRCODE", expiresAt: new Date().toISOString() }),
      exchange: () => ({ deviceToken: "device-token", deviceId: "device-1" }),
      listDevices: () => [],
      revokeDevice: () => [],
    },
    chooseRepository: () => Promise.resolve(REPO),
    openPullRequest: (commandId, _ref, _repoPath, retrospective) =>
      service.createReviewFromPatchset(commandId, prPatchset(), {
        retrospective,
        // A non-retrospective PR review carries the real post-target (issue #21), just
        // as the live `openPullRequest` stamps it — so a real post from it is bound to
        // its OWN pull request.
        ...(retrospective ? {} : { postTarget: SANDBOX_TARGET }),
      }),
    startWatching,
    repositoryExists: extra.repositoryExists ?? (() => true),
    isRepositoryDirty: () => dirty,
    setRepositoryDirty: (value) => {
      dirty = value;
    },
    publishPort,
    ...(extra.pushTokens ? { pushTokens: extra.pushTokens } : {}),
    ...(extra.acknowledgeAttention ? { acknowledgeAttention: extra.acknowledgeAttention } : {}),
    ...(extra.raiseAttention ? { raiseAttention: extra.raiseAttention } : {}),
    ...(extra.inFlightReviews ? { inFlightReviews: extra.inFlightReviews } : {}),
    ...(extra.submitPullRequest ? { submitPullRequest: extra.submitPullRequest } : {}),
    ...(extra.draftDeltaDigest ? { draftDeltaDigest: extra.draftDeltaDigest } : {}),
    ...(extra.runHandoffTurn ? { runHandoffTurn: extra.runHandoffTurn } : {}),
    ...(extra.composeBundle ? { composeBundle: extra.composeBundle } : {}),
    ...(extra.liveTurns ? { liveTurns: extra.liveTurns } : {}),
    ...(extra.onReviewOpened ? { onReviewOpened: extra.onReviewOpened } : {}),
    // Front-door deps (issue #29): a trivial in-memory projects capability plus
    // stub discovery/detection. The dedicated front-door tests exercise these
    // handlers directly; the shared harness only needs them to satisfy the shape.
    projects: {
      list: () => [],
      remove: () => ({ projects: [] }),
      rename: () => ({ project: null, projects: [] }),
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
          source: input.discovery.source,
        };
        return { project, projects: [project] };
      },
    },
    processProject: () => Promise.resolve({ repos: [] }),
    discoverProject: ({ path, kind }) =>
      Promise.resolve({ path, kind, repos: [], primaryBranch: "main", source: "local" }),
    listDir: (input) =>
      Promise.resolve({
        path: input.path ?? "/home/rai",
        home: "/home/rai",
        parent: "/home",
        entries: [],
      }),
    detectHarnesses: () => Promise.resolve([]),
    detectForges: () => Promise.resolve([]),
    github: {
      status: () => Promise.resolve({ state: "not-connected" as const, copy: "not connected" }),
      connectStart: () =>
        Promise.resolve({
          userCode: "ABCD-1234",
          verificationUri: "https://github.com/login/device",
        }),
      connectPoll: () => Promise.resolve({ phase: "idle" as const }),
      connectCancel: () => Promise.resolve(),
      setToken: () =>
        Promise.resolve({ state: "connected" as const, login: "rai", scopes: ["repo"] }),
      disconnect: () => Promise.resolve(),
    },
    // Project detail (issue #37): a trivial substrate stub; the dedicated smart-list
    // tests exercise the derivation. The shared harness only needs the shape.
    projectDetail: () =>
      Promise.resolve({ viewer: { login: "rai" }, locals: [], prs: [], truncated: false }),
    cleanupWorktree: () => Promise.resolve({ ok: true }),
    prWorktree: () => Promise.resolve(null),
    // Recording spy so a test can assert what `deepReview` the dispatch passed the
    // runner — the whole point of the default-dual mandate is that guarantee at the
    // real command boundary. The stub answers with an honestly-empty ran-clean set.
    // A test may override the runner (e.g. to stamp #309 blockingStates like the live
    // runner does) via `extra.flaggedReview`.
    flaggedReview: extra.flaggedReview ?? flaggedReviewSpy,
    noiseReview: () => Promise.resolve({ status: "ok", groups: [] }),
    reviewAsk: extra.reviewAsk ?? reviewAsk,
    threadPersistence: extra.threadPersistence ?? threadPersistence,
    ...(extra.reattachThreads ? { reattachThreads: extra.reattachThreads } : {}),
    refineComment: refineCommentSpy,
    draftPrBody: draftPrBodySpy,
    symbolLookup: opts.symbolLookup,
    openInEditor: opts.openInEditor,
    openSpecChange: opts.openSpecChange,
    openSpecCoverage: opts.openSpecCoverage,
    settings: opts.settings,
  };
  return {
    dispatch: createDispatch(deps),
    service,
    store,
    allowedRoots,
    startWatching,
    publishPort,
    reviewAsk,
    threadPersistence,
    flaggedReviewSpy,
    refineCommentSpy,
    draftPrBodySpy,
  };
}

/** The shared harness with a few `extra` deps threaded (e.g. repositoryExists for #324). */
function harnessWith(extra: {
  repositoryExists?: DispatchDeps["repositoryExists"];
}): ReturnType<typeof harness> {
  return harness(fakePublishPort(), {}, extra);
}

async function capturedReview(dispatch: ReturnType<typeof createDispatch>): Promise<Review> {
  await dispatch("repository.choose", {});
  const result = (await dispatch("review.capture", {
    commandId: randomUUID(),
    repoPath: REPO,
  })) as { review: Review };
  return result.review;
}

describe("createDispatch — review.deltaDigest (#73 / M25)", () => {
  // A capture port that yields a DISTINCT successor on regenerate, so the fold stamps a
  // successor account: a.ts changes (addressed), b.ts is new (beyond-asks).
  function twoPatchsetCapture(): PatchsetCapturePort {
    let n = 0;
    const file = (path: string, patch: string, status: "modified" | "added" = "modified") => ({
      path,
      status,
      additions: 1,
      deletions: 0,
      binary: false,
      patch,
    });
    return {
      capture: () => {
        n += 1;
        return Promise.resolve(
          n === 1
            ? { ...patchset(), id: "p1", files: [file("src/a.ts", "X")] }
            : {
                ...patchset(),
                id: "p2",
                files: [file("src/a.ts", "Y"), file("src/b.ts", "Z", "added")],
              },
        );
      },
    };
  }

  async function successorReview(dispatch: ReturnType<typeof createDispatch>): Promise<Review> {
    await dispatch("repository.choose", {});
    const first = (await dispatch("review.capture", {
      commandId: randomUUID(),
      repoPath: REPO,
    })) as { review: Review };
    await dispatch("review.setDisposition", {
      commandId: randomUUID(),
      reviewId: first.review.id,
      patchsetId: first.review.activePatchsetId,
      path: "src/a.ts",
      disposition: "request-change",
      body: "fix a",
    });
    const regen = (await dispatch("review.regenerate", {
      commandId: randomUUID(),
      reviewId: first.review.id,
      repoPath: REPO,
    })) as { review: Review };
    return regen.review;
  }

  it("calls the producer with the review's successor account and returns its digest", async () => {
    const draftDeltaDigest = vi.fn<NonNullable<DispatchDeps["draftDeltaDigest"]>>(async () => ({
      status: "drafted",
      text: "Fixed a, and also touched b nobody asked about.",
      model: "haiku",
    }));
    const { dispatch } = harness(
      fakePublishPort(),
      {},
      {
        capturePort: twoPatchsetCapture(),
        draftDeltaDigest,
      },
    );
    const review = await successorReview(dispatch);
    expect(review.successorAccount).toBeDefined(); // precondition: the fold stamped an account

    const out = await dispatch("review.deltaDigest", {
      commandId: randomUUID(),
      reviewId: review.id,
    });
    expect(out).toEqual({
      status: "drafted",
      text: "Fixed a, and also touched b nobody asked about.",
      model: "haiku",
    });
    expect(draftDeltaDigest).toHaveBeenCalledOnce();
    expect(draftDeltaDigest.mock.calls[0]?.[0].account).toEqual(review.successorAccount);
  });

  it("answers unavailable when the review carries no successor account (a first capture)", async () => {
    const draftDeltaDigest = vi.fn<NonNullable<DispatchDeps["draftDeltaDigest"]>>();
    const { dispatch } = harness(fakePublishPort(), {}, { draftDeltaDigest });
    const review = await capturedReview(dispatch); // one capture, no predecessor → no account
    expect(review.successorAccount).toBeUndefined();
    const out = (await dispatch("review.deltaDigest", {
      commandId: randomUUID(),
      reviewId: review.id,
    })) as { status: string };
    expect(out.status).toBe("unavailable");
    expect(draftDeltaDigest).not.toHaveBeenCalled();
  });

  it("answers unavailable (never throws) when no producer is wired but an account exists", async () => {
    const { dispatch } = harness(fakePublishPort(), {}, { capturePort: twoPatchsetCapture() });
    const review = await successorReview(dispatch);
    expect(review.successorAccount).toBeDefined();
    const out = (await dispatch("review.deltaDigest", {
      commandId: randomUUID(),
      reviewId: review.id,
    })) as { status: string };
    expect(out.status).toBe("unavailable");
  });
});

describe("createDispatch — preserved command surface", () => {
  it("still serves the preserved MVP commands (app.bootstrap, review.setDisposition)", async () => {
    const { dispatch, startWatching } = harness();
    const review = await capturedReview(dispatch);
    startWatching.mockClear();

    const boot = (await dispatch("app.bootstrap", {})) as {
      review: Review | null;
      repositoryPresent: boolean;
    };
    expect(boot.review?.id).toBe(review.id);
    expect(boot.repositoryPresent).toBe(true);
    expect(startWatching).toHaveBeenCalledWith(review.repositoryRoot);

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
});

describe("createDispatch — flagged.review routing (the live finding runner, issue #32)", () => {
  it("resolves the addressed review and returns the runner's FlaggedReview, stamped with the active patchset", async () => {
    const { dispatch } = harness();
    const review = await capturedReview(dispatch);
    const result = await dispatch("flagged.review", { reviewId: review.id });
    // The shared harness's runner stub answers with an honestly-empty ran-clean set, and
    // dispatch stamps the ACTIVE patchset onto the ok result (#160/P0-2) so the renderer
    // can bind it to the canvases beside it and drop a regenerate-stale result.
    expect(result).toEqual({ status: "ok", findings: [], patchsetId: review.activePatchsetId });
  });

  it("stamps a failed result with the active patchset before it crosses the protocol boundary", async () => {
    const flaggedReview = vi.fn<DispatchDeps["flaggedReview"]>(async () => ({
      review: { status: "failed", reason: "both seats down" },
      adjudication: null,
    }));
    const { dispatch } = harness(undefined, {}, { flaggedReview });
    const review = await capturedReview(dispatch);
    await expect(dispatch("flagged.review", { reviewId: review.id })).resolves.toEqual({
      status: "failed",
      reason: "both seats down",
      patchsetId: review.activePatchsetId,
    });
  });

  it("refuses flagged.review for a stale or unknown review id (the runner spends a model turn)", async () => {
    const { dispatch } = harness();
    await capturedReview(dispatch);
    await expect(dispatch("flagged.review", { reviewId: randomUUID() })).rejects.toThrow(
      /Review not found/,
    );
  });

  it("preserves pre-stamped blockingStates through the flagged.review protocol boundary (R18/#309)", async () => {
    // This runner test double deliberately pre-stamps the real deterministic
    // decomposition's blockers. The assertion guards the separate Rule-80 strip
    // surface: dropping `blockingStates` from `flaggedReviewSchema` makes it red.
    const binaryPatchset: Patchset = {
      ...patchset(),
      files: [
        {
          path: "assets/logo.png",
          status: "modified",
          additions: 0,
          deletions: 0,
          binary: true,
          patch: "",
        },
      ],
      rawDiff: "Binary files a/assets/logo.png and b/assets/logo.png differ\n",
      byteLength: 1,
    };
    const flaggedReview = vi.fn<DispatchDeps["flaggedReview"]>(async () => {
      const decomposition = decompose(binaryPatchset);
      return {
        review: {
          status: "ok" as const,
          findings: [],
          blockingStates: decomposition.blockingStates,
        },
        adjudication: null,
      };
    });
    const { dispatch } = harness(
      undefined,
      {},
      {
        capturePort: { capture: () => Promise.resolve(binaryPatchset) },
        flaggedReview,
      },
    );
    const review = await capturedReview(dispatch);
    const result = (await dispatch("flagged.review", { reviewId: review.id })) as FlaggedReview;
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("expected an ok review");
    expect(result.blockingStates).toEqual([
      {
        reason: "binary",
        path: "assets/logo.png",
        detail: expect.stringContaining("binary file") as unknown as string,
      },
    ]);
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

  it("delivers verified rows while adjudication is still pending, then exposes the enrichment", async () => {
    let resolveAdjudication: ((review: FlaggedReview) => void) | undefined;
    const adjudication = new Promise<FlaggedReview>((resolve) => {
      resolveAdjudication = resolve;
    });
    const pendingFinding: FindingElement = {
      findingId: "f1",
      anchor: "rennet:hunk/h1",
      summary: "the loop overruns the array",
      severity: "high",
      agreement: {
        kind: "disagree",
        answers: [
          { model: "Claude", answer: "the loop overruns" },
          { model: "Codex", answer: "no concern raised here" },
        ],
      },
    };
    const flaggedReview = vi.fn<DispatchDeps["flaggedReview"]>(async () => ({
      review: { status: "ok", findings: [pendingFinding] },
      adjudication,
    }));
    const { dispatch } = harness(undefined, {}, { flaggedReview });
    const review = await capturedReview(dispatch);

    const immediate = (await dispatch("flagged.review", {
      reviewId: review.id,
    })) as FlaggedReview;
    expect(immediate.status).toBe("ok");
    if (immediate.status !== "ok") throw new Error("expected ok");
    expect(immediate.findings).toHaveLength(1);
    expect(immediate.lateEnrichmentScheduled).toBe(true);
    expect(immediate.findings[0]?.agreement.kind).toBe("disagree");
    expect(
      immediate.findings[0]?.agreement.kind === "disagree"
        ? immediate.findings[0].agreement.adjudication
        : undefined,
    ).toBeUndefined();
    await expect(
      dispatch("flagged.adjudication", {
        reviewId: review.id,
        patchsetId: review.activePatchsetId,
        deepReview: true,
      }),
    ).resolves.toEqual({ status: "pending" });

    resolveAdjudication?.({
      status: "ok",
      findings: [
        {
          ...pendingFinding,
          agreement: {
            kind: "disagree",
            answers: [
              { model: "Claude", answer: "the loop overruns" },
              { model: "Codex", answer: "no concern raised here" },
            ],
            adjudication: {
              verdict: "supported",
              evidence: "line 4 reads items[items.length]",
              adjudicatedBy: "opus-4.8 (claude-code)",
            },
          },
        },
      ],
    });

    await vi.waitFor(async () => {
      const enriched = await dispatch("flagged.adjudication", {
        reviewId: review.id,
        patchsetId: review.activePatchsetId,
        deepReview: true,
      });
      expect(enriched).toMatchObject({
        status: "complete",
        review: {
          findings: [{ agreement: { adjudication: { verdict: "supported" } } }],
        },
      });
    });
  });

  it("a hung adjudication never blocks the initial flagged rows", async () => {
    const never = new Promise<FlaggedReview>(() => undefined);
    const flaggedReview = vi.fn<DispatchDeps["flaggedReview"]>(async () => ({
      review: {
        status: "ok",
        findings: [
          {
            findingId: "f1",
            anchor: "rennet:hunk/h1",
            summary: "a contested concern",
            severity: "medium",
            agreement: {
              kind: "disagree",
              answers: [
                { model: "Claude", answer: "concern" },
                { model: "Codex", answer: "no concern raised here" },
              ],
            },
          },
        ],
      },
      adjudication: never,
    }));
    const { dispatch } = harness(undefined, {}, { flaggedReview });
    const review = await capturedReview(dispatch);

    await expect(dispatch("flagged.review", { reviewId: review.id })).resolves.toMatchObject({
      status: "ok",
      findings: [{ findingId: "f1" }],
    });
  });
});

describe("createDispatch — review.refine routing (the live producer, issue #19)", () => {
  it("invokes the producer with the RESOLVED review and the exact input, returning its result", async () => {
    const { dispatch, refineCommentSpy } = harness();
    const review = await capturedReview(dispatch);
    const result = await dispatch("review.refine", {
      commandId: randomUUID(),
      reviewId: review.id,
      itemId: "src/a.ts",
      type: "request-change",
      raw: "this breaks per-key clients?? add note",
      lens: "flagged",
      path: "src/a.ts",
      span: { startLine: 3 },
      side: "additions",
    });
    // The producer ran exactly once — handed the RESOLVED review (not a bare id) and
    // the caller's exact input. This is the boundary P1-7 flagged: mutating the route
    // to always answer `unavailable` left every test green because nothing asserted
    // the producer was reached with real arguments. It is asserted now.
    expect(refineCommentSpy).toHaveBeenCalledTimes(1);
    const arg = refineCommentSpy.mock.calls[0]?.[0];
    expect(arg.review.id).toBe(review.id);
    expect(arg).toMatchObject({
      type: "request-change",
      raw: "this breaks per-key clients?? add note",
      lens: "flagged",
      path: "src/a.ts",
      side: "additions",
      span: { startLine: 3 },
    });
    // …and the route returns the producer's result verbatim.
    expect(result).toEqual({ status: "no-change", model: "test-model" });
  });

  it("marks the review running for the duration of the turn, cleared after (#383 batch)", async () => {
    const inFlightReviews = new InFlightReviews();
    const { dispatch, refineCommentSpy } = harness(fakePublishPort(), {}, { inFlightReviews });
    const review = await capturedReview(dispatch);
    let runningDuringTurn: boolean | undefined;
    refineCommentSpy.mockImplementation(async (arg: { review: { id: string } }) => {
      runningDuringTurn = inFlightReviews.has(arg.review.id);
      return { status: "no-change", model: "test-model" };
    });
    // Red-proof: not running before the turn.
    expect(inFlightReviews.has(review.id)).toBe(false);
    await dispatch("review.refine", {
      commandId: randomUUID(),
      reviewId: review.id,
      itemId: "x",
      type: "comment",
      raw: "note",
    });
    expect(runningDuringTurn).toBe(true); // running WHILE the producer ran
    expect(inFlightReviews.has(review.id)).toBe(false); // cleared after it settled
  });

  it("refuses review.refine for a stale or unknown review id (the producer spends a model turn)", async () => {
    const { dispatch } = harness();
    await capturedReview(dispatch);
    await expect(
      dispatch("review.refine", {
        commandId: randomUUID(),
        reviewId: randomUUID(),
        itemId: "x",
        type: "comment",
        raw: "note",
      }),
    ).rejects.toThrow(/Review not found/);
  });
});

describe("createDispatch — review.reattach (issue #251, the honest pre-persistence floor)", () => {
  it("returns the TRUTHFUL empty result when no thread store is wired (zero persisted, zero in-flight)", async () => {
    // Not a fabricated set: with no ThreadStore/LiveTurnRegistry composed, there genuinely
    // are no persisted threads and no tracked in-flight turns. The seam persistence plugs
    // into. RED-proof: make the handler return a non-empty stub and this assertion fires.
    const { dispatch } = harness();
    const review = await capturedReview(dispatch);
    const result = await dispatch("review.reattach", {
      commandId: randomUUID(),
      reviewId: review.id,
    });
    expect(result).toEqual({ threads: [], inFlight: [] });
  });

  it("refuses review.reattach for a stale or unknown review id", async () => {
    const { dispatch } = harness();
    await capturedReview(dispatch);
    await expect(
      dispatch("review.reattach", { commandId: randomUUID(), reviewId: randomUUID() }),
    ).rejects.toThrow(/Review not found/);
  });
});

describe("createDispatch — review.load (reopen a persisted review by id, #324)", () => {
  // Two captures under the same repo → two distinct persisted reviews; the second
  // is the globally-latest. Loading the OLDER one must succeed WITHOUT the latest-pin.
  async function twoReviews(dispatch: ReturnType<typeof createDispatch>) {
    await dispatch("repository.choose", {});
    const older = (
      (await dispatch("review.capture", { commandId: randomUUID(), repoPath: REPO })) as {
        review: Review;
      }
    ).review;
    const newer = (
      (await dispatch("review.capture", { commandId: randomUUID(), repoPath: REPO })) as {
        review: Review;
      }
    ).review;
    return { older, newer };
  }

  it("loads the OLDER review by id while a newer one exists, present-root, appending no event", async () => {
    const { dispatch, store, allowedRoots, startWatching } = harnessWith({
      repositoryExists: () => true,
    });
    const { older, newer } = await twoReviews(dispatch);
    expect(older.id).not.toBe(newer.id);
    const latestBefore = (await dispatch("app.bootstrap", {})) as { review: Review | null };
    const eventsBefore = JSON.stringify(store.events);
    startWatching.mockClear();
    const result = (await dispatch("review.load", {
      commandId: randomUUID(),
      reviewId: older.id,
    })) as { review: Review; repositoryPresent: boolean };
    expect(result.review.id).toBe(older.id);
    expect(result.repositoryPresent).toBe(true);
    // A present root is watched + granted (mirrors bootstrap).
    expect(allowedRoots.has(older.repositoryRoot)).toBe(true);
    expect(startWatching).toHaveBeenCalledWith(older.repositoryRoot);
    // Pure read: the globally-latest identity and serialized events are byte-identical,
    // and a second load returns the same review.
    const latestAfter = (await dispatch("app.bootstrap", {})) as { review: Review | null };
    expect(latestAfter.review?.id).toBe(latestBefore.review?.id);
    expect(JSON.stringify(store.events)).toBe(eventsBefore);
    const again = (await dispatch("review.load", {
      commandId: randomUUID(),
      reviewId: older.id,
    })) as { review: Review };
    expect(again.review.id).toBe(older.id);
    expect(JSON.stringify(store.events)).toBe(eventsBefore);
  });

  it("after loading the older review, id-addressed commands resolve it (no latest-pin)", async () => {
    const { dispatch } = harnessWith({ repositoryExists: () => true });
    const { older } = await twoReviews(dispatch);
    await dispatch("review.load", { commandId: randomUUID(), reviewId: older.id });
    // reattach + canvases addressed to the OLDER id must resolve, not throw "Review not found".
    const reattached = await dispatch("review.reattach", {
      commandId: randomUUID(),
      reviewId: older.id,
    });
    expect(reattached).toEqual({ threads: [], inFlight: [] });
  });

  it("fails plainly for an unknown id", async () => {
    const { dispatch } = harnessWith({ repositoryExists: () => true });
    await twoReviews(dispatch);
    await expect(
      dispatch("review.load", { commandId: randomUUID(), reviewId: randomUUID() }),
    ).rejects.toThrow(/Review not found/);
  });

  it("a missing root loads the review but does NOT grant it: a follow-up repo command still refuses", async () => {
    const { dispatch, allowedRoots, startWatching } = harnessWith({
      repositoryExists: () => false,
    });
    const { older } = await twoReviews(dispatch);
    allowedRoots.clear(); // drop the capture-time grant, to prove load does not re-add it
    startWatching.mockClear();
    const result = (await dispatch("review.load", {
      commandId: randomUUID(),
      reviewId: older.id,
    })) as { review: Review; repositoryPresent: boolean };
    expect(result.review.id).toBe(older.id);
    expect(result.repositoryPresent).toBe(false);
    expect(allowedRoots.has(older.repositoryRoot)).toBe(false);
    expect(startWatching).not.toHaveBeenCalled();
  });

  it("bootstrap reports a deleted latest root without granting or watching it", async () => {
    const { dispatch, allowedRoots, startWatching } = harnessWith({
      repositoryExists: () => false,
    });
    const { newer } = await twoReviews(dispatch);
    allowedRoots.clear();
    startWatching.mockClear();

    const result = (await dispatch("app.bootstrap", {})) as {
      review: Review | null;
      repositoryPresent: boolean;
    };

    expect(result.review?.id).toBe(newer.id);
    expect(result.repositoryPresent).toBe(false);
    expect(allowedRoots.has(newer.repositoryRoot)).toBe(false);
    expect(startWatching).not.toHaveBeenCalled();
  });

  it("binds freshness and canvases to the addressed review's stored repository root", async () => {
    const { dispatch, allowedRoots } = harnessWith({
      repositoryExists: () => true,
    });
    const { older } = await twoReviews(dispatch);
    allowedRoots.add("/allowed-but-unrelated");

    await expect(
      dispatch("review.checkFreshness", {
        commandId: randomUUID(),
        reviewId: older.id,
        repoPath: "/allowed-but-unrelated",
      }),
    ).rejects.toThrow(/does not match this review/i);
    await expect(
      dispatch("review.checkFreshness", {
        commandId: randomUUID(),
        reviewId: older.id,
        repoPath: older.repositoryRoot,
      }),
    ).resolves.toEqual({ review: older });
  });
});

describe("createDispatch — review.draftPrBody routing (the live producer, issue #74)", () => {
  it("invokes the producer with the RESOLVED review and the exact drafting material, returning its result", async () => {
    const { dispatch, draftPrBodySpy } = harness();
    const review = await capturedReview(dispatch);
    const result = await dispatch("review.draftPrBody", {
      commandId: randomUUID(),
      reviewId: review.id,
      base: "main",
      head: "feat/rate-limit-fallback",
      narration: { oneLine: "one line", paragraph: "a paragraph" },
      dispositions: [{ type: "request-change", path: "keys.ts", resolution: "add a note" }],
      requirements: ["The limiter MUST bound the fail-open path"],
      decisions: ["Chose a local bucket (decision 2)"],
    });
    // The producer ran exactly once, handed the RESOLVED review (not a bare id) and
    // the caller's exact material. Removing the `deps.draftPrBody(...)` call — the
    // wiring — reddens this: nothing else asserts the producer is reached.
    expect(draftPrBodySpy).toHaveBeenCalledTimes(1);
    const arg = draftPrBodySpy.mock.calls[0]?.[0];
    expect(arg.review.id).toBe(review.id);
    expect(arg).toMatchObject({
      base: "main",
      head: "feat/rate-limit-fallback",
      narration: { oneLine: "one line", paragraph: "a paragraph" },
      dispositions: [{ type: "request-change", path: "keys.ts", resolution: "add a note" }],
      requirements: ["The limiter MUST bound the fail-open path"],
      decisions: ["Chose a local bucket (decision 2)"],
    });
    // …and the route returns the producer's result verbatim.
    expect(result).toEqual({
      status: "drafted",
      title: "A drafted title",
      body: "A drafted body.",
      model: "test-model",
    });
  });

  it("omits absent optional material rather than passing empty stand-ins", async () => {
    const { dispatch, draftPrBodySpy } = harness();
    const review = await capturedReview(dispatch);
    await dispatch("review.draftPrBody", {
      commandId: randomUUID(),
      reviewId: review.id,
      base: "main",
      head: "feat/thin",
      dispositions: [],
    });
    const arg = draftPrBodySpy.mock.calls[0]?.[0];
    // A thin submission carries no narration/requirements/decisions keys at all — the
    // producer degrades honestly on their absence, never on an empty fabricated value.
    expect(arg).not.toHaveProperty("narration");
    expect(arg).not.toHaveProperty("requirements");
    expect(arg).not.toHaveProperty("decisions");
  });

  it("refuses review.draftPrBody for a stale or unknown review id (the producer spends a model turn)", async () => {
    const { dispatch } = harness();
    await capturedReview(dispatch);
    await expect(
      dispatch("review.draftPrBody", {
        commandId: randomUUID(),
        reviewId: randomUUID(),
        base: "main",
        head: "feat/x",
        dispositions: [],
      }),
    ).rejects.toThrow(/Review not found/);
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

describe("createDispatch — openspec.coverage routing (the Spec view's coverage chips, R53)", () => {
  it("resolves the addressed review and returns the producer's coverage", async () => {
    const coverage = {
      status: "ok" as const,
      edges: [
        {
          capability: "review-hypothesis-pass",
          requirement: "A hypothesis is committed before the runners read the diff",
          hunks: ["rennet:hunk/h1"],
          tests: 2,
        },
      ],
    };
    const { dispatch } = harness(undefined, { openSpecCoverage: () => Promise.resolve(coverage) });
    const review = await capturedReview(dispatch);
    expect(await dispatch("openspec.coverage", { reviewId: review.id })).toEqual(coverage);
  });

  it("returns null when no producer is wired (the Spec view renders no chips, never a fixture)", async () => {
    const { dispatch } = harness();
    const review = await capturedReview(dispatch);
    expect(await dispatch("openspec.coverage", { reviewId: review.id })).toBeNull();
  });

  it("refuses openspec.coverage for a stale or unknown review id (it spends a model turn)", async () => {
    const { dispatch } = harness();
    await capturedReview(dispatch);
    await expect(dispatch("openspec.coverage", { reviewId: randomUUID() })).rejects.toThrow(
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

// SANDBOX_TARGET now lives above the harness (the opened-PR review's postTarget).

/**
 * Open a PR review whose `postTarget` is SANDBOX_TARGET — the target-binding gate's
 * happy case: a real post from it targets its OWN pull request. The publish egress
 * tests post from THIS, not a local capture (which now cannot post at all, #21).
 */
async function postableReview(dispatch: ReturnType<typeof createDispatch>): Promise<Review> {
  await dispatch("repository.choose", {}); // grant REPO (the openPr repoPath)
  const result = (await dispatch("review.openPr", {
    commandId: randomUUID(),
    ref: "rbutera/rennet-egress-sandbox#1",
    repoPath: REPO,
    retrospective: false,
  })) as { review: Review };
  return result.review;
}

function publishComments(): ReviewCommentInput[] {
  return [
    { path: "src/a.ts", line: 2, side: "RIGHT", type: "request-change", body: "rename this" },
    // A no-line disposition — folds into the review body, ledgered (never dropped).
    { path: "README.md", side: "RIGHT", type: "comment", body: "a file-level note" },
  ];
}

interface PublishResult {
  dryRun: boolean;
  request: { endpoint: string; method: string; body: unknown };
  marker: string;
  ledger: { kind: string; path: string; detail: string }[];
  outcome: { reviewRef: string; url: string | null; reused: boolean } | null;
}

describe("createDispatch — publish.review egress (issue #21)", () => {
  it("keeps sign/publish dispatch byte-identical across passing, failing, and unavailable CI", async () => {
    const { dispatch, flaggedReviewSpy } = harness();
    const review = await postableReview(dispatch);
    const comments = publishComments();
    const payload = canonicalReviewPayload(comments);
    const signals: NonNullable<FlaggedReview["ciSignal"]>[] = [
      {
        status: "checked",
        overall: "passing",
        failures: [],
        headOid: SANDBOX_TARGET.headOid,
        incomplete: false,
      },
      {
        status: "checked",
        overall: "failing",
        failures: [
          {
            checkId: "check-run-1",
            checkName: "core:test",
            verdict: "change-caused",
            evidence: "pipeline.ts failed",
            implicatedPaths: ["src/a.ts"],
            classifiedBy: "deterministic",
          },
        ],
        headOid: SANDBOX_TARGET.headOid,
        incomplete: false,
      },
      { status: "unavailable", reason: "network down" },
    ];
    const requests: PublishResult[] = [];
    for (const ciSignal of signals) {
      flaggedReviewSpy.mockResolvedValueOnce({
        review: { status: "ok", findings: [], ciSignal },
        adjudication: null,
      });
      await dispatch("flagged.review", { reviewId: review.id });
      requests.push(
        (await dispatch("publish.review", {
          commandId: randomUUID(),
          reviewId: review.id,
          target: SANDBOX_TARGET,
          comments,
          payload,
          dryRun: true,
        })) as PublishResult,
      );
    }
    expect(requests[1]).toEqual(requests[0]);
    expect(requests[2]).toEqual(requests[0]);
  });

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

  it("(f) refuses a REAL post whose target is a different PR node id", async () => {
    // The adapter POSTS by forgeRef (the node id) while findExistingReview READS by
    // coordinates — independent renderer fields. A post carrying the review's coordinates
    // but a DIFFERENT forgeRef must NOT land, or it would reach a different PR than the
    // one on screen. Red-proof: dropping forgeRef from forgeTargetKey makes the two keys
    // equal and this post would go through.
    const port = fakePublishPort();
    const { dispatch } = harness(port);
    const review = await postableReview(dispatch);
    const comments = publishComments();
    const payload = canonicalReviewPayload(comments);
    const differentNode = { ...SANDBOX_TARGET, forgeRef: "PR_kwFORGEDNODE" };

    await expect(
      dispatch("publish.review", {
        commandId: randomUUID(),
        reviewId: review.id,
        target: differentNode,
        comments,
        payload,
        dryRun: false,
      }),
      // Refused by the target-binding gate (issue #21): the review's stored postTarget is
      // the authority, so NOTHING posts to a different PR than the review's own.
    ).rejects.toThrow(/does not match/i);
    expect(port.posts).toHaveLength(0);
  });

  it("(e) happy path: the click posts exactly one review — no token, no confirmation step", async () => {
    const port = fakePublishPort();
    const { dispatch } = harness(port);
    const review = await postableReview(dispatch);
    const comments = publishComments();
    const payload = canonicalReviewPayload(comments);

    const out = (await dispatch("publish.review", {
      commandId: randomUUID(),
      reviewId: review.id,
      target: SANDBOX_TARGET,
      comments,
      payload,
      dryRun: false,
    })) as PublishResult;

    expect(out.dryRun).toBe(false);
    expect(out.outcome).not.toBeNull();
    expect(port.posts).toHaveLength(1); // exactly one review posted
    // The wire event is COMMENT (asserted on the constructed request in the dry-run
    // test); a post carries no event field to check here.
    expect(port.posts[0]?.body).toContain(out.marker); // the idempotency marker is embedded
  });

  it("(e2) the real post's request is byte-identical to the dry-run's", async () => {
    const port = fakePublishPort();
    const { dispatch } = harness(port);
    const review = await postableReview(dispatch);
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

  it("(g) a LOCAL capture (no postTarget) cannot post — there is no PR to post to", async () => {
    // The most-permissive-fault the reviewers caught: a local capture could post for REAL
    // to an arbitrary PR. It must not — a review with no `postTarget` owns no pull request.
    const port = fakePublishPort();
    const { dispatch } = harness(port);
    const local = await capturedReview(dispatch); // a working-tree capture — no postTarget
    const comments = publishComments();
    const payload = canonicalReviewPayload(comments);

    // A hand-crafted real post is refused structurally, because the review owns no
    // target. NOTHING leaves.
    await expect(
      dispatch("publish.review", {
        commandId: randomUUID(),
        reviewId: local.id,
        target: SANDBOX_TARGET,
        comments,
        payload,
        dryRun: false,
      }),
    ).rejects.toThrow(/no pull request/i);
    expect(port.posts).toHaveLength(0);
  });

  it("(h) a real post whose target is not the review's OWN pull request is refused", async () => {
    const port = fakePublishPort();
    const { dispatch } = harness(port);
    const review = await postableReview(dispatch); // postTarget = SANDBOX_TARGET
    const comments = publishComments();
    const payload = canonicalReviewPayload(comments);
    const otherPr = {
      repo: { forge: "github", owner: "rbutera", name: "rennet" },
      number: 999,
      forgeRef: "PR_kwOTHERPR",
      headOid: "beefbeefbeef9999",
    };

    // A hand-crafted real post to the wrong PR is refused: the review's stored postTarget
    // is the authority, not the caller's input.
    await expect(
      dispatch("publish.review", {
        commandId: randomUUID(),
        reviewId: review.id,
        target: otherPr,
        comments,
        payload,
        dryRun: false,
      }),
    ).rejects.toThrow(/does not match/i);
    expect(port.posts).toHaveLength(0);
  });

  it("(i) the POSTED verdict must equal the PREVIEWED one — a swap lands on a stale binding", async () => {
    // The one property the deleted consent token actually enforced (#435): a post whose
    // verdict differs from the preview is a UI lie. It survives WITHOUT ceremony because
    // the verdict rides in the existing compose binding — `publish.compose` hashes it in,
    // `publish.review` recomputes the hash from the verdict it is about to post, and a
    // mismatch is the SAME stale-composition refusal a stale payload gets. No token, no
    // dialog, nothing to clear.
    const port = fakePublishPort();
    const { dispatch } = harness(port);
    const review = await postableReview(dispatch);
    // A plain note ⇒ the composed verdict derives to a neutral COMMENT.
    await dispatch("ask.stage", {
      sessionId: review.id,
      ask: { id: "a1", anchor: "src/a.ts:2", type: "comment", body: "a note" },
    });
    const composed = (await dispatch("publish.compose", {
      commandId: randomUUID(),
      reviewId: review.id,
      mode: "review",
    })) as {
      comments: ReviewCommentInput[];
      payload: string;
      verdict: ForgeReviewEvent;
      compositionId: string;
    };
    expect(composed.verdict).toBe("COMMENT");

    // The swap: post an APPROVE against the COMMENT preview, without recomposing. Refused,
    // and NOTHING leaves the machine. (Red-proof: drop `verdict` from `publishCompositionId`
    // and this APPROVE posts.)
    await expect(
      dispatch("publish.review", {
        commandId: randomUUID(),
        reviewId: review.id,
        target: SANDBOX_TARGET,
        comments: composed.comments,
        payload: composed.payload,
        verdict: "APPROVE",
        compositionId: composed.compositionId,
        dryRun: false,
      }),
    ).rejects.toThrow(/stale|another review/i);
    expect(port.posts).toHaveLength(0);

    // The previewed verdict posts, exactly once — the click is the whole authorization.
    const out = (await dispatch("publish.review", {
      commandId: randomUUID(),
      reviewId: review.id,
      target: SANDBOX_TARGET,
      comments: composed.comments,
      payload: composed.payload,
      verdict: composed.verdict,
      compositionId: composed.compositionId,
      dryRun: false,
    })) as PublishResult;
    expect(out.outcome).not.toBeNull();
    expect(port.posts).toHaveLength(1);
  });

  it("(j) single-flight: a concurrent second real post of the same content is refused while the first is in flight", async () => {
    // The double-sign race: two near-simultaneous completed signs both pass the
    // adapter's query-before-post check before either mutation lands, double-posting.
    // The main-owned single-flight (keyed by the deterministic marker) refuses the
    // second while the first is still in flight.
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const posts: ForgeReviewPost[] = [];
    const port = fakePublishPort({
      publishReview: async (post) => {
        posts.push(post);
        await gate; // hold the first post in flight, marker in the in-flight set
        return { reviewRef: "PRR_1", url: null, reused: false };
      },
    });
    const { dispatch } = harness(port);
    const review = await postableReview(dispatch);
    const comments = publishComments();
    const payload = canonicalReviewPayload(comments);

    // The first post starts and hangs (its synchronous run adds the marker to the
    // in-flight set before it awaits the gate).
    const first = dispatch("publish.review", {
      commandId: randomUUID(),
      reviewId: review.id,
      target: SANDBOX_TARGET,
      comments,
      payload,
      dryRun: false,
    });

    // A second sign tries to post the SAME content concurrently.
    await expect(
      dispatch("publish.review", {
        commandId: randomUUID(),
        reviewId: review.id,
        target: SANDBOX_TARGET,
        comments,
        payload,
        dryRun: false,
      }),
    ).rejects.toThrow(/already in progress/i);

    // Release the first; it lands exactly once.
    release();
    const out1 = (await first) as PublishResult;
    expect(out1.outcome).not.toBeNull();
    expect(posts).toHaveLength(1);
  });

  it("(k) a PR review recaptured LOCALLY loses its post-target — local diffs cannot post to the PR", async () => {
    // The patchset-swap vector: open a postable PR review, then recapture LOCAL
    // working-tree changes under the SAME review id. The activated local patchset must
    // DROP the PR post-target (it is no longer the PR's own patchset), so both minting
    // consent and posting are refused — local diffs can never reach the PR under the
    // human sign, even though the review id is unchanged.
    const port = fakePublishPort();
    const { dispatch } = harness(port);
    const review = await postableReview(dispatch); // postTarget = SANDBOX_TARGET
    expect(review.postTarget).toEqual(SANDBOX_TARGET);

    // Recapture local working-tree changes under the same review id (the exploit).
    const recaptured = (await dispatch("review.capture", {
      commandId: randomUUID(),
      repoPath: review.repositoryRoot,
      reviewId: review.id,
    })) as { review: Review };
    expect(recaptured.review.id).toBe(review.id); // same review id...
    expect(recaptured.review.postTarget).toBeUndefined(); // ...but the PR target is gone

    const comments = publishComments();
    const payload = canonicalReviewPayload(comments);

    // A hand-crafted real post is refused structurally — nothing leaves.
    await expect(
      dispatch("publish.review", {
        commandId: randomUUID(),
        reviewId: review.id,
        target: SANDBOX_TARGET,
        comments,
        payload,
        dryRun: false,
      }),
    ).rejects.toThrow(/no pull request/i);
    expect(port.posts).toHaveLength(0);
  });
});

describe("createDispatch — publish.submitPr (own-branch submission, issue #257 / #107)", () => {
  // A local capture whose head is on a branch — the own-branch submission's baseline.
  function ownBranchCapture(): PatchsetCapturePort {
    return {
      capture: () =>
        Promise.resolve({
          ...patchset(),
          repository: { ...patchset().repository, headRef: "feat/reviewed" },
        }),
    };
  }

  const SUBMISSION = {
    title: "Reviewed change",
    body: "## Requested changes\n- fix it",
    base: "main",
    head: "feat/reviewed",
    draft: true,
  };
  const PAYLOAD = canonicalPrSubmissionPayload(SUBMISSION);

  it("pushes the branch and opens the PR, returning the URL (the sign-click is the whole authorization)", async () => {
    const submitPullRequest = vi.fn<NonNullable<DispatchDeps["submitPullRequest"]>>(async () => ({
      url: "https://github.com/acme/widget/pull/7",
      number: 7,
      reused: false,
    }));
    const { dispatch } = harness(
      fakePublishPort(),
      {},
      {
        capturePort: ownBranchCapture(),
        submitPullRequest,
      },
    );
    const review = await capturedReview(dispatch);

    const out = (await dispatch("publish.submitPr", {
      commandId: randomUUID(),
      reviewId: review.id,
      submission: SUBMISSION,
      payload: PAYLOAD,
    })) as { url: string; number: number; reused: boolean };

    expect(out).toEqual({ url: "https://github.com/acme/widget/pull/7", number: 7, reused: false });
    // The dep is called ONCE with the review's own branch ref (#107) — never a SHA.
    expect(submitPullRequest).toHaveBeenCalledTimes(1);
    expect(submitPullRequest).toHaveBeenCalledWith({
      repoRoot: REPO,
      headRef: "feat/reviewed",
      submission: SUBMISSION,
    });
  });

  it("refuses plainly when the review's own root is not admitted", async () => {
    const submitPullRequest = vi.fn<NonNullable<DispatchDeps["submitPullRequest"]>>(async () => ({
      url: "https://github.com/acme/widget/pull/7",
      number: 7,
      reused: false,
    }));
    const { dispatch, allowedRoots } = harness(
      fakePublishPort(),
      {},
      { capturePort: ownBranchCapture(), submitPullRequest },
    );
    const review = await capturedReview(dispatch);
    allowedRoots.delete(review.repositoryRoot);

    await expect(
      dispatch("publish.submitPr", {
        commandId: randomUUID(),
        reviewId: review.id,
        submission: SUBMISSION,
        payload: PAYLOAD,
      }),
    ).rejects.toThrow(/Repository access was not granted/);
    expect(submitPullRequest).not.toHaveBeenCalled();
  });

  it("refuses when the signed payload does not match the submission (what you see is what leaves)", async () => {
    const submitPullRequest = vi.fn<NonNullable<DispatchDeps["submitPullRequest"]>>();
    const { dispatch } = harness(
      fakePublishPort(),
      {},
      {
        capturePort: ownBranchCapture(),
        submitPullRequest,
      },
    );
    const review = await capturedReview(dispatch);

    await expect(
      dispatch("publish.submitPr", {
        commandId: randomUUID(),
        reviewId: review.id,
        submission: SUBMISSION,
        payload: canonicalPrSubmissionPayload({ ...SUBMISSION, title: "A DIFFERENT title" }),
      }),
    ).rejects.toThrow(/does not match its content/i);
    expect(submitPullRequest).not.toHaveBeenCalled();
  });

  it("refuses when the previewed head is not the review's own branch (no UI lie)", async () => {
    const submitPullRequest = vi.fn<NonNullable<DispatchDeps["submitPullRequest"]>>();
    const { dispatch } = harness(
      fakePublishPort(),
      {},
      {
        capturePort: ownBranchCapture(),
        submitPullRequest,
      },
    );
    const review = await capturedReview(dispatch);

    const wrong = { ...SUBMISSION, head: "some/other-branch" };
    await expect(
      dispatch("publish.submitPr", {
        commandId: randomUUID(),
        reviewId: review.id,
        submission: wrong,
        payload: canonicalPrSubmissionPayload(wrong),
      }),
    ).rejects.toThrow(/does not match the review's own branch/i);
    expect(submitPullRequest).not.toHaveBeenCalled();
  });

  it("refuses a detached HEAD (no branch to submit from)", async () => {
    const submitPullRequest = vi.fn<NonNullable<DispatchDeps["submitPullRequest"]>>();
    // No headRef on the capture ⇒ a detached HEAD.
    const { dispatch } = harness(fakePublishPort(), {}, { submitPullRequest });
    const review = await capturedReview(dispatch);
    const detached = { ...SUBMISSION, head: "(detached HEAD)" };
    await expect(
      dispatch("publish.submitPr", {
        commandId: randomUUID(),
        reviewId: review.id,
        submission: detached,
        payload: canonicalPrSubmissionPayload(detached),
      }),
    ).rejects.toThrow(/detached/i);
    expect(submitPullRequest).not.toHaveBeenCalled();
  });

  it("refuses a retrospective review (read-only, no branch to submit)", async () => {
    // A retrospective review is opened via the PR path with retrospective:true; it has
    // no own branch to submit. Reuse the harness's openPullRequest which stamps it.
    const submitPullRequest = vi.fn<NonNullable<DispatchDeps["submitPullRequest"]>>();
    const { dispatch } = harness(fakePublishPort(), {}, { submitPullRequest });
    await dispatch("repository.choose", {});
    const opened = (await dispatch("review.openPr", {
      commandId: randomUUID(),
      ref: "rbutera/rennet-egress-sandbox#1",
      repoPath: REPO,
      retrospective: true,
    })) as { review: Review };

    await expect(
      dispatch("publish.submitPr", {
        commandId: randomUUID(),
        reviewId: opened.review.id,
        submission: SUBMISSION,
        payload: PAYLOAD,
      }),
    ).rejects.toThrow(/retrospective/i);
    expect(submitPullRequest).not.toHaveBeenCalled();
  });

  it("fails honestly when no submission action is composed (never a fabricated success)", async () => {
    const { dispatch } = harness(fakePublishPort(), {}, { capturePort: ownBranchCapture() });
    const review = await capturedReview(dispatch);
    await expect(
      dispatch("publish.submitPr", {
        commandId: randomUUID(),
        reviewId: review.id,
        submission: SUBMISSION,
        payload: PAYLOAD,
      }),
    ).rejects.toThrow(/no GitHub PR submission is available/i);
  });
});

describe("createDispatch — publish.compose + publish-ready + handoff-completed (#382 M2)", () => {
  function ownBranchCapture(): PatchsetCapturePort {
    return {
      capture: () =>
        Promise.resolve({
          ...patchset(),
          repository: { ...patchset().repository, headRef: "feat/reviewed", baseRef: "main" },
        }),
    };
  }

  it("publish.compose composes an own-branch submission the engine's publish.submitPr round-trips exactly", async () => {
    const submitPullRequest = vi.fn<NonNullable<DispatchDeps["submitPullRequest"]>>(async () => ({
      url: "https://github.com/acme/widget/pull/9",
      number: 9,
      reused: false,
    }));
    const { dispatch } = harness(
      fakePublishPort(),
      {},
      { capturePort: ownBranchCapture(), submitPullRequest },
    );
    const review = await capturedReview(dispatch);

    const composed = (await dispatch("publish.compose", {
      commandId: randomUUID(),
      reviewId: review.id,
      mode: "pr",
    })) as { status: string; submission: unknown; payload: string; destination: string };
    expect(composed.status).toBe("pr");
    // The payload is byte-consistent with the composed submission — so posting it round-trips.
    expect(composed.payload).toBe(canonicalPrSubmissionPayload(composed.submission as never));
    expect(composed.destination).toContain("feat/reviewed");

    // The phone posts EXACTLY what compose returned — the engine accepts it and opens one PR.
    const out = (await dispatch("publish.submitPr", {
      commandId: randomUUID(),
      reviewId: review.id,
      submission: composed.submission as never,
      payload: composed.payload,
    })) as { url: string };
    expect(out.url).toBe("https://github.com/acme/widget/pull/9");
    expect(submitPullRequest).toHaveBeenCalledTimes(1);
  });

  it("publish.compose is honestly unavailable when HEAD is detached (no own branch)", async () => {
    const { dispatch } = harness();
    const review = await capturedReview(dispatch);
    const composed = (await dispatch("publish.compose", {
      commandId: randomUUID(),
      reviewId: review.id,
      mode: "pr",
    })) as { status: string; reason?: string };
    expect(composed.status).toBe("unavailable");
    expect(composed.reason).toMatch(/detached|branch/i);
  });

  it("publish.compose (mode review) composes a team-PR review the engine's publish.review posts byte-exact", async () => {
    // A postable review (postTarget = SANDBOX_TARGET) with a real staged ask to collate. The
    // durable ask projection — keyed by the review id — is the compose source (B11 cluster 3).
    const { dispatch } = harness();
    const review = await postableReview(dispatch);
    await dispatch("ask.stage", {
      sessionId: review.id,
      ask: { id: "a1", anchor: "src/a.ts:2", type: "request-change", body: "rename this" },
    });

    const composed = (await dispatch("publish.compose", {
      commandId: randomUUID(),
      reviewId: review.id,
      mode: "review",
    })) as {
      status: string;
      comments: ReviewCommentInput[];
      payload: string;
      verdict: ForgeReviewEvent;
      destination: string;
    };
    expect(composed.status).toBe("review");
    // One-source: the composed comments come from the durable ask projection, the payload is core's
    // canonical bytes, and the verdict is derived — exactly what publish.review re-verifies.
    expect(composed.comments.length).toBe(1);
    expect(composed.payload).toBe(canonicalReviewPayload(composed.comments));
    // The daemon composed the comments straight off the projection (one-source): a `path:line`
    // request-change ask becomes a RIGHT line comment carrying the body.
    expect(composed.comments[0]).toMatchObject({
      path: "src/a.ts",
      line: 2,
      side: "RIGHT",
      type: "request-change",
      body: "rename this",
    });
    expect(composed.verdict).toBe(deriveReviewEvent(composed.comments));
    expect(composed.verdict).toBe("REQUEST_CHANGES");
    expect(composed.destination).toContain("rennet-egress-sandbox#1");

    // The phone posts EXACTLY what compose returned — a real send lands one review.
    const out = (await dispatch("publish.review", {
      commandId: randomUUID(),
      reviewId: review.id,
      target: SANDBOX_TARGET,
      comments: composed.comments,
      payload: composed.payload,
      verdict: composed.verdict,
      dryRun: false,
    })) as { dryRun: boolean; outcome: { url: string | null } | null };
    expect(out.dryRun).toBe(false);
    expect(out.outcome).not.toBeNull();
  });

  it("normalizes matching renamed-base asks and routes frozen asks to the review body", async () => {
    const { dispatch, service } = harness();
    const review = await service.createReviewFromPatchset(
      randomUUID(),
      {
        ...prPatchset(),
        id: "renamed-active",
        files: [
          {
            path: "src/current.ts",
            previousPath: "src/previous.ts",
            status: "renamed",
            additions: 1,
            deletions: 1,
            binary: false,
            patch: "@@ -8 +8 @@\n-old\n+new",
          },
        ],
      },
      { postTarget: SANDBOX_TARGET },
    );
    await dispatch("ask.stage", {
      sessionId: review.id,
      ask: {
        id: "matching",
        anchor: "src/previous.ts:999",
        type: "request-change",
        body: "preserve the base-side contract",
        side: "RIGHT",
        codeRef: {
          patchsetId: review.activePatchsetId,
          path: "src/previous.ts",
          side: "base",
          startLine: 8,
          endLine: 10,
        },
      },
    });
    await dispatch("ask.stage", {
      sessionId: review.id,
      ask: {
        id: "frozen",
        anchor: "src/current.ts:999",
        type: "comment",
        body: "revisit the frozen concern",
        codeRef: {
          patchsetId: "renamed-frozen",
          path: "src/previous.ts",
          side: "base",
          startLine: 8,
          endLine: 10,
        },
      },
    });

    const composed = (await dispatch("publish.compose", {
      commandId: randomUUID(),
      reviewId: review.id,
      mode: "review",
    })) as {
      status: string;
      comments: ReviewCommentInput[];
      bodyNotes: ReviewBodyNote[];
      payload: string;
      verdict: ForgeReviewEvent;
      compositionId: string;
    };

    expect(composed.comments).toEqual([
      {
        path: "src/current.ts",
        line: 8,
        side: "LEFT",
        type: "request-change",
        body: "preserve the base-side contract",
      },
    ]);
    expect(composed.bodyNotes).toEqual([
      {
        id: "frozen",
        anchor: "src/current.ts:999",
        type: "comment",
        body: "revisit the frozen concern",
      },
    ]);
    await expect(
      dispatch("publish.review", {
        commandId: randomUUID(),
        reviewId: review.id,
        target: SANDBOX_TARGET,
        comments: composed.comments,
        bodyNotes: composed.bodyNotes,
        payload: composed.payload,
        verdict: composed.verdict,
        compositionId: composed.compositionId,
        dryRun: true,
      }),
    ).resolves.toMatchObject({ dryRun: true });
  });

  it("publish.compose (mode review) sources asks + line comments + verdict override; publish.review accepts the projection-composed bytes", async () => {
    const { dispatch } = harness();
    const review = await postableReview(dispatch);
    // Two strata from the durable projection: a line-anchored ask + a bare line comment.
    await dispatch("ask.stage", {
      sessionId: review.id,
      ask: { id: "a1", anchor: "src/a.ts:3", type: "request-change", body: "rename" },
    });
    await dispatch("ask.setLineComment", {
      sessionId: review.id,
      path: "src/b.ts",
      line: 8,
      body: "extract",
    });
    // Override the derived REQUEST_CHANGES down to a neutral COMMENT (derive-first, overridable).
    await dispatch("ask.setVerdictOverride", { sessionId: review.id, verdict: "COMMENT" });

    const composed = (await dispatch("publish.compose", {
      commandId: randomUUID(),
      reviewId: review.id,
      mode: "review",
    })) as {
      status: string;
      comments: ReviewCommentInput[];
      payload: string;
      verdict: ForgeReviewEvent;
      compositionId: string;
    };
    expect(composed.status).toBe("review");
    // Both strata composed, deterministic (path, line) order — line comments, not file-level.
    expect(composed.comments).toEqual([
      { path: "src/a.ts", line: 3, side: "RIGHT", type: "request-change", body: "rename" },
      { path: "src/b.ts", line: 8, side: "RIGHT", type: "comment", body: "extract" },
    ]);
    // The explicit override WINS over the derived REQUEST_CHANGES.
    expect(composed.verdict).toBe("COMMENT");
    expect(composed.payload).toBe(canonicalReviewPayload(composed.comments));

    // The phone posts EXACTLY the composed bytes + binding — the freshness mirror recomputes the
    // expected payload AND verdict from the SAME projection and accepts; a real send lands one
    // review. (The override rides in the binding, so posting the derived REQUEST_CHANGES instead
    // of the overridden COMMENT would be refused.)
    const out = (await dispatch("publish.review", {
      commandId: randomUUID(),
      reviewId: review.id,
      target: SANDBOX_TARGET,
      comments: composed.comments,
      payload: composed.payload,
      verdict: composed.verdict,
      compositionId: composed.compositionId,
      dryRun: false,
    })) as { dryRun: boolean; outcome: { url: string | null } | null };
    expect(out.dryRun).toBe(false);
    expect(out.outcome).not.toBeNull();
  });

  it("binds the composed artifact and refuses a stale-revision post (#382 M2 finding 2)", async () => {
    const { dispatch } = harness();
    const review = await postableReview(dispatch);
    await dispatch("ask.stage", {
      sessionId: review.id,
      ask: { id: "a1", anchor: "src/a.ts:2", type: "request-change", body: "rename this" },
    });
    const composed = (await dispatch("publish.compose", {
      commandId: randomUUID(),
      reviewId: review.id,
      mode: "review",
    })) as {
      compositionId: string;
      payload: string;
      verdict: ForgeReviewEvent;
      comments: ReviewCommentInput[];
    };
    expect(composed.compositionId).toBeTruthy();
    // Fresh preview: a post carrying the binding is accepted (dry-run, so nothing leaves).
    const fresh = (await dispatch("publish.review", {
      commandId: randomUUID(),
      reviewId: review.id,
      target: SANDBOX_TARGET,
      comments: composed.comments,
      payload: composed.payload,
      verdict: composed.verdict,
      compositionId: composed.compositionId,
      dryRun: true,
    })) as PublishResult;
    expect(fresh.dryRun).toBe(true);
    // An ask edit lands AFTER the preview (another client edited) — the phone still holds the old
    // binding. The daemon recomputes it from the CURRENT durable projection and refuses
    // (dry-run included, so the fault surfaces as a refusal not a plausible request).
    await dispatch("ask.edit", {
      sessionId: review.id,
      id: "a1",
      body: "actually, rename it to something else entirely",
    });
    await expect(
      dispatch("publish.review", {
        commandId: randomUUID(),
        reviewId: review.id,
        target: SANDBOX_TARGET,
        comments: publishComments(),
        payload: composed.payload,
        verdict: composed.verdict,
        compositionId: composed.compositionId,
        dryRun: true,
      }),
    ).rejects.toThrow(/stale|another review/i);
  });

  it("refuses a disposition with an unsafe path at ingestion (#382 M2 finding 8)", async () => {
    const { dispatch } = harness();
    const review = await postableReview(dispatch);
    await expect(
      dispatch("review.setDisposition", {
        commandId: randomUUID(),
        reviewId: review.id,
        patchsetId: review.activePatchsetId,
        path: "/etc/shadow",
        disposition: "comment",
        body: "escape",
      }),
    ).rejects.toThrow(/unsafe path/i);
  });

  it("publish.compose refuses a mismatched mode truthfully (pr on a team-PR review)", async () => {
    const { dispatch } = harness();
    const review = await postableReview(dispatch); // has a postTarget
    const composed = (await dispatch("publish.compose", {
      commandId: randomUUID(),
      reviewId: review.id,
      mode: "pr",
    })) as { status: string; reason?: string };
    expect(composed.status).toBe("unavailable");
    expect(composed.reason).toMatch(/team-PR|review/i);
  });

  it("publish.compose (mode review) is unavailable on an own-branch review (no PR to post to)", async () => {
    const { dispatch } = harness(fakePublishPort(), {}, { capturePort: ownBranchCapture() });
    const review = await capturedReview(dispatch); // no postTarget
    const composed = (await dispatch("publish.compose", {
      commandId: randomUUID(),
      reviewId: review.id,
      mode: "review",
    })) as { status: string; reason?: string };
    expect(composed.status).toBe("unavailable");
    expect(composed.reason).toMatch(/pull request|own-branch/i);
  });

  it("publish-ready raises when the own-branch draft is composed, and clears on the post", async () => {
    const raised: { family: string }[] = [];
    const acknowledged: { attentionId?: string }[] = [];
    const submitPullRequest = vi.fn<NonNullable<DispatchDeps["submitPullRequest"]>>(async () => ({
      url: "https://github.com/acme/widget/pull/9",
      number: 9,
      reused: false,
    }));
    const { dispatch } = harness(
      fakePublishPort(),
      {},
      {
        capturePort: ownBranchCapture(),
        submitPullRequest,
        raiseAttention: (event) => {
          raised.push({ family: event.family });
          return `${event.family}:${event.reviewId ?? "-"}`;
        },
        acknowledgeAttention: (selector) => {
          acknowledged.push(selector);
          return 1;
        },
      },
    );
    const review = await capturedReview(dispatch);

    await dispatch("review.draftPrBody", {
      commandId: randomUUID(),
      reviewId: review.id,
      base: "main",
      head: "feat/reviewed",
      dispositions: [],
    });
    expect(raised.some((r) => r.family === "publish-ready")).toBe(true);

    await dispatch("publish.submitPr", {
      commandId: randomUUID(),
      reviewId: review.id,
      submission: {
        title: "Reviewed change",
        body: "b",
        base: "main",
        head: "feat/reviewed",
        draft: true,
      },
      payload: canonicalPrSubmissionPayload({
        title: "Reviewed change",
        body: "b",
        base: "main",
        head: "feat/reviewed",
        draft: true,
      }),
    });
    expect(acknowledged.some((a) => a.attentionId === `publish-ready:${review.id}`)).toBe(true);
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
  detectedForges?: DetectedForge[];
  processEvents?: ProjectProcessEvent[];
  processedRepos?: ProcessedRepoSummary[];
  processProject?: DispatchDeps["processProject"];
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
    source: "local",
  };
  const deps: DispatchDeps = {
    service,
    allowedRoots,
    askLog: new AskLogStore(mkdtempSync(join(tmpdir(), "rennet-asks-"))),
    projectContextMap: () => Promise.resolve({ status: "absent", reason: "stub" }),
    projectContextAsk: () =>
      Promise.resolve({
        status: "failed",
        failureReason: "stub",
        cost: {
          turns: 0,
          model: null,
          effort: null,
          budgetGranted: true,
          overage: false,
          resolution: null,
        },
      }),
    knowledgeDisposition: ({ statementId }) =>
      Promise.resolve({ status: "not-found", statementId }),
    pairing: {
      mint: () => ({ code: "PAIRCODE", expiresAt: new Date().toISOString() }),
      exchange: () => ({ deviceToken: "device-token", deviceId: "device-1" }),
      listDevices: () => [],
      revokeDevice: () => [],
    },
    chooseRepository: () => Promise.resolve(REPO),
    openPullRequest: (commandId) => service.createReviewFromPatchset(commandId, patchset()),
    startWatching: () => undefined,
    isRepositoryDirty: () => false,
    setRepositoryDirty: () => undefined,
    publishPort: fakePublishPort(),
    projects: {
      list: () => stored,
      remove: () => ({ projects: stored }),
      rename: () => ({ project: null, projects: [...stored] }),
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
          source: input.discovery.source,
        };
        stored.push(project);
        return { project, projects: [...stored] };
      },
    },
    processProject:
      seed.processProject ??
      ((input, emit) => {
        processCalls.push(input);
        for (const event of seed.processEvents ?? []) emit(event);
        return Promise.resolve({ repos: seed.processedRepos ?? [] });
      }),
    discoverProject: (input) => {
      discoverCalls.push(input);
      return Promise.resolve({ ...discovery, path: input.path, kind: input.kind });
    },
    listDir: (input) =>
      Promise.resolve({
        path: input.path ?? "/home/rai",
        home: "/home/rai",
        parent: "/home",
        entries: [],
      }),
    detectHarnesses: () => Promise.resolve(seed.detected ?? []),
    detectForges: () => Promise.resolve(seed.detectedForges ?? []),
    github: {
      status: () => Promise.resolve({ state: "not-connected" as const, copy: "not connected" }),
      connectStart: () =>
        Promise.resolve({
          userCode: "ABCD-1234",
          verificationUri: "https://github.com/login/device",
        }),
      connectPoll: () => Promise.resolve({ phase: "idle" as const }),
      connectCancel: () => Promise.resolve(),
      setToken: () =>
        Promise.resolve({ state: "connected" as const, login: "rai", scopes: ["repo"] }),
      disconnect: () => Promise.resolve(),
    },
    projectDetail: () =>
      Promise.resolve({ viewer: { login: "rai" }, locals: [], prs: [], truncated: false }),
    cleanupWorktree: () => Promise.resolve({ ok: true }),
    prWorktree: () => Promise.resolve(null),
    flaggedReview: () =>
      Promise.resolve({ review: { status: "ok", findings: [] }, adjudication: null }),
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
    source: "local",
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
      source: "local",
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

  it("carries the selected source end to end: discover(source) → add → persisted Project.source", async () => {
    // The whole-branch promise: a non-local selection must survive to the persisted
    // Project. `discoverProject` can't name its own source (an in-distro POSIX path
    // reads as local), so the frontDoorHarness stub — like the real adapter — returns
    // `source: "local"`; the discover HANDLER is what stamps the SELECTED source onto
    // the discovery the client gets. This test fails if that stamp is missing.
    const { dispatch, discoverCalls, addCalls } = frontDoorHarness({});
    await dispatch("repository.choose", {});

    const discovered = (await dispatch("project.discover", {
      commandId: randomUUID(),
      path: REPO,
      kind: "repo",
      source: "wsl:Ubuntu",
    })) as { discovery: DiscoveryResult };
    // The adapter ran locally and reported "local"; the handler overrode it.
    expect(discoverCalls).toEqual([{ path: REPO, kind: "repo" }]);
    expect(discovered.discovery.source).toBe("wsl:Ubuntu");

    const added = (await dispatch("projects.add", {
      commandId: randomUUID(),
      discovery: discovered.discovery,
      includedRepos: [],
      primaryBranch: "main",
    })) as { project: Project; projects: Project[] };
    // The selected source rode through into the persisted Project.
    expect(added.project.source).toBe("wsl:Ubuntu");
    expect(addCalls[0]?.discovery.source).toBe("wsl:Ubuntu");
  });

  it("harness.detect returns the detected harnesses for the ambient line", async () => {
    const { dispatch } = frontDoorHarness({
      detected: [
        { id: "claude", version: "2.1.0" },
        { id: "codex", version: "0.55.0" },
      ],
    });
    const out = (await dispatch("harness.detect", {})) as { detected: DetectedHarness[] };
    expect(out.detected.map((harness) => harness.id)).toEqual(["claude", "codex"]);
  });

  it("forge.detect returns the detected forge CLIs for sourceControlByHost", async () => {
    const { dispatch } = frontDoorHarness({
      detectedForges: [
        {
          id: "github",
          version: "2.62.0",
          status: "available",
          detail: "Authenticated with GitHub through the `gh` CLI.",
        },
      ],
    });
    const out = (await dispatch("forge.detect", {})) as { detected: DetectedForge[] };
    expect(out.detected).toEqual([
      {
        id: "github",
        version: "2.62.0",
        status: "available",
        detail: "Authenticated with GitHub through the `gh` CLI.",
      },
    ]);
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

    const streamed: ProjectProgressEvent[] = [];
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

  it("project.process replays a live run on remount and does not start a second build", async () => {
    const summary: ProcessedRepoSummary = {
      repo: "atlas",
      path: "/orbital/atlas",
      ok: true,
      files: 12,
      symbols: 8,
    };
    let emitFromBuild: ((event: ProjectProcessEvent) => void) | undefined;
    let finishBuild: ((value: { repos: ProcessedRepoSummary[] }) => void) | undefined;
    const processCalls: { projectId: string }[] = [];
    const buildResult = new Promise<{ repos: ProcessedRepoSummary[] }>((resolve) => {
      finishBuild = resolve;
    });
    const { dispatch } = frontDoorHarness({
      processProject: (input, emit) => {
        processCalls.push(input);
        emitFromBuild = emit;
        emit({ kind: "repo-start", repo: "atlas", index: 1, total: 1 });
        return buildResult;
      },
    });
    const commandId = randomUUID();
    const beforeRemount: ProjectProgressEvent[] = [];
    const afterRemount: ProjectProgressEvent[] = [];

    const first = dispatch(
      "project.process",
      { commandId, projectId: "p1" },
      {
        progressRecipientId: "renderer-1",
        emitProgress: (event) => beforeRemount.push(event),
      },
    );
    await vi.waitFor(() =>
      expect(beforeRemount.map((event) => event.kind)).toEqual(["repo-start"]),
    );

    const remounted = dispatch(
      "project.process",
      { commandId, projectId: "p1" },
      {
        progressRecipientId: "renderer-1",
        emitProgress: (event) => afterRemount.push(event),
      },
    );
    await vi.waitFor(() => expect(afterRemount.map((event) => event.kind)).toEqual(["repo-start"]));
    expect(processCalls).toEqual([{ projectId: "p1" }]);

    emitFromBuild?.({
      kind: "repo-done",
      repo: "atlas",
      summary,
      artifact: { kind: "project", projectId: "p1" },
    });
    finishBuild?.({ repos: [summary] });

    await expect(first).resolves.toEqual({ repos: [summary] });
    await expect(remounted).resolves.toEqual({ repos: [summary] });
    expect(beforeRemount.map((event) => event.kind)).toEqual(["repo-start"]);
    expect(afterRemount.map((event) => event.kind)).toEqual(["repo-start", "repo-done", "done"]);
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

  it("a STREAMING ask raises ask-pending then clears it on completion (#383 batch)", async () => {
    const raised: { family: string; id: string }[] = [];
    const cleared: { reviewId?: string; attentionId?: string }[] = [];
    let n = 0;
    const h = harness(
      fakePublishPort(),
      {},
      {
        raiseAttention: (e) => {
          const id = `att-${n++}`;
          raised.push({ family: e.family, id });
          return id;
        },
        acknowledgeAttention: (sel) => {
          cleared.push(sel);
          return 1;
        },
      },
    );
    const review = await capturedReview(h.dispatch);
    raised.length = 0; // drop the capture's review-finished raise; focus on the ask
    await h.dispatch(
      "review.ask",
      { commandId: randomUUID(), reviewId: review.id, question: "q", threadId: "th", turnId: "tn" },
      { emitAskStream: () => undefined },
    );
    const askPending = raised.find((r) => r.family === "ask-pending");
    expect(askPending).toBeDefined();
    expect(raised.some((r) => r.family === "turn-failed")).toBe(false); // clean completion
    expect(cleared).toContainEqual({ attentionId: askPending?.id }); // cleared exactly it
  });

  it("a FAILED streaming ask raises turn-failed and clears ask-pending (#383 batch)", async () => {
    const raised: { family: string; id: string }[] = [];
    const cleared: { attentionId?: string; reviewId?: string }[] = [];
    let n = 0;
    const h = harness(
      fakePublishPort(),
      {},
      {
        raiseAttention: (e) => {
          const id = `att-${n++}`;
          raised.push({ family: e.family, id });
          return id;
        },
        acknowledgeAttention: (sel) => {
          cleared.push(sel);
          return 1;
        },
      },
    );
    const review = await capturedReview(h.dispatch);
    raised.length = 0;
    h.reviewAsk.askOrchestrator.mockRejectedValueOnce(new Error("harness exploded"));
    await expect(
      h.dispatch(
        "review.ask",
        {
          commandId: randomUUID(),
          reviewId: review.id,
          question: "q",
          threadId: "th",
          turnId: "tn",
        },
        { emitAskStream: () => undefined },
      ),
    ).rejects.toThrow(/harness exploded/);
    const askPending = raised.find((r) => r.family === "ask-pending");
    expect(raised.some((r) => r.family === "turn-failed")).toBe(true);
    expect(cleared).toContainEqual({ attentionId: askPending?.id });
  });

  it("a shade answer binds to the attention id: consumed once, a duplicate is refused (#382 M2 finding 3)", async () => {
    // Model the attention registry's active set: acknowledge(id) returns 1 the first time (it was
    // active) and 0 afterwards (already consumed) — the exact dedup the shade answer binds to.
    const active = new Set<string>();
    const h = harness(
      fakePublishPort(),
      {},
      {
        acknowledgeAttention: (sel) => {
          if (sel.attentionId && active.delete(sel.attentionId)) return 1;
          return 0;
        },
      },
    );
    const review = await capturedReview(h.dispatch);
    const attentionId = `ask-pending:${review.id}`;
    active.add(attentionId);
    // First shade tap: the ask is active ⇒ consumed ⇒ the turn runs.
    await h.dispatch(
      "review.ask",
      { commandId: randomUUID(), reviewId: review.id, question: "yes", attentionId },
      { emitAskStream: () => undefined },
    );
    expect(h.reviewAsk.askOrchestrator).toHaveBeenCalledTimes(1);
    // Second (duplicate) shade tap of the SAME push: the item is no longer active ⇒ refused
    // truthfully, and the turn does NOT run a second time.
    await expect(
      h.dispatch("review.ask", {
        commandId: randomUUID(),
        reviewId: review.id,
        question: "yes",
        attentionId,
      }),
    ).rejects.toThrow(/already answered/i);
    expect(h.reviewAsk.askOrchestrator).toHaveBeenCalledTimes(1);
    // A forged/stale attention id (never active) is refused for the same reason.
    await expect(
      h.dispatch("review.ask", {
        commandId: randomUUID(),
        reviewId: review.id,
        question: "yes",
        attentionId: "ask-pending:forged",
      }),
    ).rejects.toThrow(/already answered/i);
  });

  it("a ONE-SHOT (#139) ask raises no attention — it is a synchronous foreground call (#383 batch)", async () => {
    const raised: { family: string }[] = [];
    const h = harness(
      fakePublishPort(),
      {},
      {
        raiseAttention: (e) => {
          raised.push({ family: e.family });
          return "id";
        },
      },
    );
    const review = await capturedReview(h.dispatch);
    raised.length = 0;
    await h.dispatch("review.ask", { commandId: randomUUID(), reviewId: review.id, question: "q" });
    expect(raised.some((r) => r.family === "ask-pending" || r.family === "turn-failed")).toBe(
      false,
    );
  });

  it("hands BOTH legs one resolved snapshot — a mid-ask patchset swap cannot cross them (P1-2)", async () => {
    const { dispatch, reviewAsk, service, review } = await openReview();
    // Resolution goes through `service.reviewById()` (the by-id resolver, #324);
    // resolve-once means EXACTLY one call feeds both legs. Per-leg resolution (the
    // bug) would call it twice.
    const resolveSpy = vi.spyOn(service, "reviewById");
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
    expect(resolveSpy).toHaveBeenCalledTimes(1);
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

  it("passes selection without fabrication and emits focus on the existing ask stream", async () => {
    const { dispatch, reviewAsk, review } = await openReview();
    const selection = {
      anchor: "rennet:hunk/c1-h1#L1-L2@additions",
      excerpt: "const a = 1;\nconst b = 2;",
    };
    reviewAsk.askOrchestrator.mockImplementationOnce(async ({ onFocus }) => {
      onFocus?.("rennet:hunk/c1-h1#L2@additions");
      return { model: "Orchestrator · Claude", answer: "a" };
    });
    const events: ReviewAskStreamEvent[] = [];

    await dispatch(
      "review.ask",
      {
        commandId: randomUUID(),
        reviewId: review.id,
        question: "this?",
        selection,
        threadId: "th",
        turnId: "tn",
      },
      { emitAskStream: (event) => events.push(event) },
    );

    expect(reviewAsk.askOrchestrator).toHaveBeenCalledWith(
      expect.objectContaining({ review, question: "this?", selection }),
    );
    const focus = events.find((event) => event.kind === "ask-focus");
    expect(reviewAskStreamEventSchema.parse(focus)).toEqual({
      kind: "ask-focus",
      anchor: "rennet:hunk/c1-h1#L2@additions",
      threadId: "th",
      turnId: "tn",
    });
  });
});

describe("createDispatch — review.ask token streaming (issue #251)", () => {
  async function openReview() {
    const h = harness();
    const review = await capturedReview(h.dispatch);
    return {
      dispatch: h.dispatch,
      reviewAsk: h.reviewAsk,
      threadPersistence: h.threadPersistence,
      review,
    };
  }

  it("streams the orchestrator's tokens as ask-delta, then a terminal ask-complete carrying the SAME answer", async () => {
    const { dispatch, reviewAsk, review } = await openReview();
    // The port calls its onDelta for each token as it arrives, exactly as the live
    // orchestrator turn now does (text.delta → onDelta).
    reviewAsk.askOrchestrator.mockImplementationOnce(async ({ onDelta }) => {
      onDelta?.("Hel");
      onDelta?.("lo ");
      onDelta?.("world");
      return { model: "Orchestrator · Claude", answer: "Hello world" };
    });
    const events: ReviewAskStreamEvent[] = [];
    const out = (await dispatch(
      "review.ask",
      {
        commandId: randomUUID(),
        reviewId: review.id,
        mode: "orchestrator",
        question: "why?",
        threadId: "th",
        turnId: "tn",
        anchor: { kind: "chunk", label: "src/a.ts", key: "chunk|src/a.ts" },
      },
      { emitAskStream: (event) => events.push(event) },
    )) as { primary: { answer: string } };

    const deltas = events.filter((e) => e.kind === "ask-delta");
    expect(deltas.map((e) => (e.kind === "ask-delta" ? e.delta : ""))).toEqual([
      "Hel",
      "lo ",
      "world",
    ]);
    const complete = events.find((e) => e.kind === "ask-complete");
    expect(complete).toMatchObject({
      channel: "orchestrator",
      finalBody: "Hello world",
      model: "Orchestrator · Claude",
    });
    // The stream is a live ECHO: every event binds to the exact turn, and the durable
    // answer is the invoke's result — never a concatenation of the deltas here.
    expect(events.every((e) => e.turnId === "tn" && e.threadId === "th")).toBe(true);
    expect(out.primary.answer).toBe("Hello world");
    // The delta events precede the completion.
    expect(events.at(-1)?.kind).toBe("ask-complete");
  });

  it("streams and persists the normalized prose-tool-prose order as one stable turn", async () => {
    const { dispatch, reviewAsk, threadPersistence, review } = await openReview();
    const event = (seq: number, body: object): HarnessEvent =>
      ({
        seq,
        harness: "claude-code",
        sessionId: "harness-session",
        turnId: "native-turn",
        receivedAt: Date.parse("2026-08-29T10:00:00.000Z") + seq,
        native: {},
        ...body,
      }) as HarnessEvent;
    reviewAsk.askOrchestrator.mockImplementationOnce(async ({ onEvent }) => {
      onEvent?.(event(1, { kind: "text.message", text: "Before.", parentToolCallId: null }));
      onEvent?.(
        event(2, {
          kind: "tool.started",
          call: {
            id: "tool-1",
            name: "app_ask_stage",
            input: { sessionId: "session-1" },
            parentToolCallId: null,
            kind: "mcp",
          },
        }),
      );
      onEvent?.(
        event(3, {
          kind: "tool.output",
          callId: "tool-1",
          ok: true,
          output: { receipt: "once" },
          text: '{"receipt":"once"}',
        }),
      );
      onEvent?.(event(4, { kind: "text.message", text: "After.", parentToolCallId: null }));
      onEvent?.(
        event(5, {
          kind: "session.ended",
          outcome: { status: "completed", finalText: "Before.\n\nAfter." },
        }),
      );
      return { model: "Orchestrator · Claude", answer: "Before.\n\nAfter." };
    });
    const events: ReviewAskStreamEvent[] = [];
    await dispatch(
      "review.ask",
      {
        commandId: randomUUID(),
        reviewId: review.id,
        question: "stage it",
        threadId: "th",
        turnId: "tn",
        anchor: { kind: "fragment", label: "stage it", key: "th" },
      },
      { emitAskStream: (streamEvent) => events.push(streamEvent) },
    );

    const states = events.filter((streamEvent) => streamEvent.kind === "ask-state");
    const last = states.at(-1);
    if (last?.kind !== "ask-state") throw new Error("expected an ask-state");
    const turn = last.rows.find((row) => row.kind === "turn");
    if (turn?.kind !== "turn") throw new Error("expected a turn row");
    expect(turn.id).toBe("tn::orchestrator");
    expect(turn.blocks?.map((block) => block.kind)).toEqual(["text", "action", "text"]);

    const messages = threadPersistence.putMessage.mock.calls.map(
      ([input]) => (input as { message: { id: string; rows?: readonly unknown[] } }).message,
    );
    expect(messages.filter((message) => message.id === "tn::orchestrator").at(-1)?.rows).toEqual(
      last.rows,
    );
  });

  it("coalesces delta-heavy activity and forces one complete terminal snapshot", async () => {
    const { dispatch, reviewAsk, review } = await openReview();
    const event = (seq: number, body: object): HarnessEvent =>
      ({
        seq,
        harness: "claude-code",
        sessionId: "harness-session",
        turnId: "native-turn",
        receivedAt: Date.parse("2026-08-29T10:00:00.000Z") + seq,
        native: {},
        ...body,
      }) as HarnessEvent;
    const prose = "x".repeat(50);
    reviewAsk.askOrchestrator.mockImplementationOnce(async ({ onDelta, onEvent }) => {
      for (let seq = 1; seq <= 50; seq += 1) {
        onEvent?.(event(seq, { kind: "thinking.delta", text: "thought " }));
      }
      for (let seq = 51; seq <= 100; seq += 1) {
        onDelta?.("x");
        onEvent?.(event(seq, { kind: "text.delta", text: "x" }));
      }
      onEvent?.(
        event(101, {
          kind: "session.ended",
          outcome: { status: "completed", finalText: prose },
        }),
      );
      return { model: "Orchestrator · Claude", answer: prose };
    });
    const events: ReviewAskStreamEvent[] = [];

    await dispatch(
      "review.ask",
      {
        commandId: randomUUID(),
        reviewId: review.id,
        question: "show the work",
        threadId: "th",
        turnId: "tn",
      },
      { emitAskStream: (streamEvent) => events.push(streamEvent) },
    );

    expect(events.filter((streamEvent) => streamEvent.kind === "ask-delta")).toHaveLength(50);
    const states = events.filter((streamEvent) => streamEvent.kind === "ask-state");
    expect(states).toHaveLength(1);
    const terminalState = states[0];
    if (terminalState?.kind !== "ask-state") throw new Error("expected an ask-state");
    const turn = terminalState.rows.find((row) => row.kind === "turn");
    if (turn?.kind !== "turn") throw new Error("expected a turn row");
    expect(turn.status).toBe("complete");
    expect(turn.blocks?.map((block) => block.kind)).toEqual(["thought", "text"]);
    expect(events.at(-1)?.kind).toBe("ask-complete");
  });

  it("in BOTH mode, codex (one-shot, no token stream) lands its whole answer as an ask-complete", async () => {
    const { dispatch, reviewAsk, review } = await openReview();
    reviewAsk.askOrchestrator.mockImplementationOnce(async ({ onDelta }) => {
      onDelta?.("orch");
      return { model: "Orchestrator · Claude", answer: "orch" };
    });
    const events: ReviewAskStreamEvent[] = [];
    await dispatch(
      "review.ask",
      {
        commandId: randomUUID(),
        reviewId: review.id,
        mode: "both",
        question: "agree?",
        threadId: "th",
        turnId: "tn",
      },
      { emitAskStream: (event) => events.push(event) },
    );
    const completes = events.filter((e) => e.kind === "ask-complete");
    // Two completions, one per channel; codex has NO deltas (it is a single exec).
    expect(completes.map((e) => (e.kind === "ask-complete" ? e.channel : ""))).toEqual([
      "orchestrator",
      "codex",
    ]);
    expect(events.some((e) => e.kind === "ask-delta" && e.channel === "codex")).toBe(false);
  });

  it("emits NOTHING for a one-shot #139 ask with no thread/turn (back-compat)", async () => {
    const { dispatch, reviewAsk, review } = await openReview();
    const onDeltaSeen: boolean[] = [];
    reviewAsk.askOrchestrator.mockImplementationOnce(async ({ onDelta }) => {
      onDeltaSeen.push(onDelta !== undefined);
      return { model: "Orchestrator · Claude", answer: "a" };
    });
    const events: ReviewAskStreamEvent[] = [];
    await dispatch(
      "review.ask",
      { commandId: randomUUID(), reviewId: review.id, question: "q" },
      { emitAskStream: (event) => events.push(event) },
    );
    // No threadId/turnId → no stream, no onDelta handed to the port, no events.
    expect(events).toEqual([]);
    expect(onDeltaSeen).toEqual([false]);
  });

  it("persists a STREAMING placeholder BEFORE the turn and the durable answer AFTER (crash-recovery seam, criterion 3)", async () => {
    const { dispatch, reviewAsk, threadPersistence, review } = await openReview();
    reviewAsk.askOrchestrator.mockImplementationOnce(async ({ onDelta }) => {
      // ⭐ WHILE the turn is in flight, the streaming placeholder must ALREADY be on disk —
      // that ordering is the whole point: a kill here recovers it interrupted. If the
      // handler persisted the placeholder AFTER the await, this assertion reddens.
      const streamingWrites = threadPersistence.putMessage.mock.calls.filter(
        ([arg]) => (arg as { message: { status?: string } }).message.status === "streaming",
      );
      expect(streamingWrites).toHaveLength(1);
      onDelta?.("hi");
      return { model: "Orchestrator · Claude", answer: "the whole answer" };
    });
    await dispatch(
      "review.ask",
      {
        commandId: randomUUID(),
        reviewId: review.id,
        mode: "orchestrator",
        question: "why?",
        threadId: "th",
        turnId: "tn",
        anchor: { kind: "chunk", label: "src/a.ts", key: "chunk|src/a.ts" },
        turnBody: "why fail open?",
      },
      { emitAskStream: () => undefined },
    );
    expect(threadPersistence.upsertThread).toHaveBeenCalledTimes(1);
    const messages = threadPersistence.putMessage.mock.calls.map(
      ([arg]) =>
        (arg as { message: { id: string; author: string; body: string; status?: string } }).message,
    );
    // The reviewer's question persisted as the "you" message.
    expect(messages.some((m) => m.author === "you" && m.body === "why fail open?")).toBe(true);
    // The orchestrator turn: a streaming placeholder (empty body) then REPLACED by the
    // durable answer under the SAME id — not two separate messages.
    const orch = messages.filter((m) => m.id === "tn::orchestrator");
    expect(orch[0]?.status).toBe("streaming");
    expect(orch[0]?.body).toBe("");
    expect(orch.at(-1)?.status).toBeUndefined();
    expect(orch.at(-1)?.body).toBe("the whole answer");
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

  it("carries the tier + neighbours ACROSS the command boundary (parseCommandOutput must not strip them)", async () => {
    // The boundary that made #11 dark once: dispatch runs the lookup result through
    // parseCommandOutput (the IPC schema). If the schema omits `tier`/`neighbors`,
    // zod strips them here and the live tier chip + mini-browser never exist — even
    // though the isolated component tests pass on hand-built fixtures. This proves
    // the transport carries them through the SAME path the running app uses.
    const symbolLookup = vi.fn(async ({ name }: { review: Review; name: string }) => ({
      name,
      definition: {
        status: "ok" as const,
        sites: [{ path: "src/x.ts", line: 3, kind: "function", scope: null }],
        tier: { kind: "exact" as const, method: "structural" as const },
      },
      references: {
        status: "ok" as const,
        sites: [
          { path: "src/y.ts", line: 9, scope: null },
          { path: "src/z.ts", line: 4, scope: null },
        ],
        truncated: false,
        tier: { kind: "guess" as const, method: "textual" as const },
      },
      neighbors: {
        path: "src/x.ts",
        symbols: [
          { name: "makeThing", kind: "function", line: 3 },
          { name: "helper", kind: "function", line: 20 },
        ],
      },
    }));
    const h = harness(undefined, { symbolLookup });
    const review = await capturedReview(h.dispatch);

    const out = (await h.dispatch("review.symbolLookup", {
      reviewId: review.id,
      name: "makeThing",
    })) as {
      definition: { tier?: unknown };
      references: { tier?: unknown };
      neighbors?: unknown;
    };

    // Survives the schema: the exact tier on definitions, the textual tier on
    // references, and the whole neighbours block — none stripped at the boundary.
    expect(out.definition.tier).toEqual({ kind: "exact", method: "structural" });
    expect(out.references.tier).toEqual({ kind: "guess", method: "textual" });
    expect(out.neighbors).toEqual({
      path: "src/x.ts",
      symbols: [
        { name: "makeThing", kind: "function", line: 3 },
        { name: "helper", kind: "function", line: 20 },
      ],
    });
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

describe("createDispatch — settings.* routing (the config ladder, wireframe #15)", () => {
  it("delegates settings.get / guidance / setAppearance / setRepoVisibility to the settings dep", async () => {
    const setAppearance = vi.fn((scheme: "dark" | "light" | "system") => scheme);
    const setRepoVisibility = vi.fn(
      async (input: {
        projectId: string;
        repoPath: string;
        visibility: "local" | "git-visible";
      }) => ({
        status: "applied" as const,
        visibility: input.visibility,
        changed: true,
        gitignorePath: `${input.repoPath}/.rennet/.gitignore`,
      }),
    );
    const guidance = vi.fn(async () => ({ rules: [], reason: "absent" as const, dropped: 0 }));
    const settings = {
      get: async () => ({
        scheme: "light" as const,
        schemeProvenance: {
          layer: "global" as const,
          contributions: [
            { layer: "builtin" as const, value: "system", effective: false },
            { layer: "global" as const, value: "light", effective: true },
          ],
        },
        appearanceMalformed: false,
        projects: [],
      }),
      guidance,
      setAppearance,
      setRepoVisibility,
      resetRepoValue: vi.fn(async (input: { key: "visibility" }) => ({
        status: "applied" as const,
        key: input.key,
        project: null,
      })),
      pinRepoValue: vi.fn(async (input: { key: "visibility" }) => ({
        status: "applied" as const,
        key: input.key,
        project: null,
      })),
      setKeybinding: vi.fn((input: { id: string; keybinding?: string | null }) =>
        input.keybinding === undefined || input.keybinding === null
          ? {}
          : { [input.id]: input.keybinding },
      ),
      setCoachmarks: vi.fn((input: CoachMarks) => input),
      setThemePack: vi.fn((themePack) => themePack),
      completeWelcome: vi.fn(() => "2026-08-28T12:00:00.000Z"),
      setLastProject: vi.fn((input) => input),
      setTrackerValue: vi.fn(() => ({})),
      setProjectValue: vi.fn(async (input: { key: string }) => ({
        status: "applied" as const,
        key: input.key as "worktreePattern",
        project: null,
      })),
      setGuidance: vi.fn(async () => ({
        status: "applied" as const,
        guidance: { rules: [], reason: "empty" as const, dropped: 0 },
      })),
      daemonStatus: vi.fn(async () => []),
      reconnect: vi.fn(async () => ({ status: { source: "local" as const, reachable: false } })),
      update: vi.fn(async () => ({ status: { source: "local" as const, reachable: false } })),
      harnessHosts: vi.fn(async () => []),
      forgeHosts: vi.fn(async () => []),
      setHarnessEnabled: vi.fn(() => []),
      setForgeEnabled: vi.fn(() => []),
      // C16 (#485): the council mappings ride the same dep. The stub resolves the
      // real council DEFAULTS, so the route is proven against honest values.
      reviewRoles: vi.fn(() => reviewRoleMappings()),
      setRoleAssignment: vi.fn(() => reviewRoleMappings()),
    };
    const { dispatch } = harness(undefined, { settings });

    const view = (await dispatch("settings.get", {})) as { scheme: string };
    expect(view.scheme).toBe("light");

    await dispatch("settings.guidance", { projectId: "p1", repoPath: "/orbital" });
    // The route threads BOTH the projectId and the repoPath through to the dep.
    expect(guidance).toHaveBeenCalledWith("p1", "/orbital");

    const applied = (await dispatch("settings.setAppearance", { scheme: "dark" })) as {
      scheme: string;
    };
    expect(setAppearance).toHaveBeenCalledWith("dark");
    // The route re-resolves provenance from the dep's own answer.
    expect(applied.scheme).toBe("dark");

    const vis = (await dispatch("settings.setRepoVisibility", {
      commandId: crypto.randomUUID(),
      projectId: "p1",
      repoPath: "/orbital",
      visibility: "git-visible",
    })) as { status: string; changed: boolean; gitignorePath: string };
    expect(setRepoVisibility).toHaveBeenCalledWith({
      projectId: "p1",
      repoPath: "/orbital",
      visibility: "git-visible",
    });
    expect(vis.status).toBe("applied");
    expect(vis.changed).toBe(true);
    expect(vis.gitignorePath).toContain(".gitignore");

    // setProjectValue threads the repo-rung pref write through to the dep (C18 group A).
    const pref = (await dispatch("settings.setProjectValue", {
      projectId: "p1",
      repoPath: "/orbital",
      key: "worktreePattern",
      value: "{project}-{branch}",
    })) as { status: string; key: string };
    expect(settings.setProjectValue).toHaveBeenCalledWith({
      projectId: "p1",
      repoPath: "/orbital",
      key: "worktreePattern",
      value: "{project}-{branch}",
    });
    expect(pref.status).toBe("applied");
    // A key the registry does not carry is REJECTED at the boundary — the dep never
    // sees a pref that has no declaration to validate it.
    await expect(
      dispatch("settings.setProjectValue", {
        projectId: "p1",
        repoPath: "/orbital",
        key: "not-a-pref",
        value: "x",
      }),
    ).rejects.toThrow();
    expect(settings.setProjectValue).toHaveBeenCalledTimes(1);

    // setGuidance threads the rules through and returns what the FILE now holds.
    const saved = (await dispatch("settings.setGuidance", {
      projectId: "p1",
      repoPath: "/orbital",
      rules: [{ rule: "keep main releasable", severity: "high" }],
    })) as { status: string };
    expect(settings.setGuidance).toHaveBeenCalledWith({
      projectId: "p1",
      repoPath: "/orbital",
      rules: [{ rule: "keep main releasable", severity: "high" }],
    });
    expect(saved.status).toBe("applied");

    // setKeybinding threads the payload to the dep and returns the stored map (#44).
    const kb = (await dispatch("settings.setKeybinding", {
      id: "nav.back",
      keybinding: "mod+e",
    })) as { keybindings: Record<string, string | null> };
    expect(settings.setKeybinding).toHaveBeenCalledWith({ id: "nav.back", keybinding: "mod+e" });
    expect(kb.keybindings).toEqual({ "nav.back": "mod+e" });

    // setCoachmarks threads the whole slice to the dep and echoes the stored result (C13).
    const coach = (await dispatch("settings.setCoachmarks", {
      seen: ["start-review"],
      skipAll: true,
    })) as { seen: string[]; skipAll: boolean };
    expect(settings.setCoachmarks).toHaveBeenCalledWith({ seen: ["start-review"], skipAll: true });
    expect(coach).toEqual({ seen: ["start-review"], skipAll: true });

    // A malformed slice — an unknown MarkId in `seen` — is REJECTED at the command boundary
    // (coachMarksSchema in parseCommandInput), so it never reaches the dep: no bogus id is
    // persisted, no silent overwrite of the real seen-state (finding 4).
    await expect(
      dispatch("settings.setCoachmarks", {
        seen: ["not-a-real-mark"],
        skipAll: false,
      } as unknown as CoachMarks),
    ).rejects.toThrow();
    // Still called exactly once — only the valid write above reached the dep.
    expect(settings.setCoachmarks).toHaveBeenCalledTimes(1);

    // setRoleAssignment threads role + scenario + pick to the dep and returns the
    // dep's OWN re-resolved mappings for the optimistic adopt (C16, #485).
    const assigned = (await dispatch("settings.setRoleAssignment", {
      roleId: "lens-workers",
      scenario: "dual",
      assignment: { model: "sonnet-5", effort: "medium" },
    })) as { reviewRoles: ReviewRoleMapping[] };
    expect(settings.setRoleAssignment).toHaveBeenCalledWith({
      roleId: "lens-workers",
      scenario: "dual",
      assignment: { model: "sonnet-5", effort: "medium" },
    });
    expect(assigned.reviewRoles).toEqual(reviewRoleMappings());

    // A model outside the council set is REJECTED at the command boundary, so it
    // never reaches the dep — no fabricated routing is ever persisted (#89).
    await expect(
      dispatch("settings.setRoleAssignment", {
        roleId: "lens-workers",
        scenario: "dual",
        assignment: { model: "gpt-4o", effort: "high" },
      }),
    ).rejects.toThrow();
    expect(settings.setRoleAssignment).toHaveBeenCalledTimes(1);
  });

  it("daemon.status routes to the settings composition's per-host detection (C17)", async () => {
    const daemonStatus = vi.fn(async () => [
      { source: "local" as const, reachable: true, version: "0.1.5", updateAvailable: false },
      { source: "wsl:Ubuntu" as const, reachable: false, lastSeenVersion: "0.1.4" },
    ]);
    // Only the one route under test is stubbed; every other settings method is unreachable
    // from `daemon.status`, so a full composition would be scaffolding for its own sake.
    const settings = { daemonStatus } as unknown as DispatchDeps["settings"];
    const { dispatch } = harness(undefined, { settings });
    const out = (await dispatch("daemon.status", {})) as {
      hosts: { source: string; reachable: boolean; version?: string }[];
    };
    expect(daemonStatus).toHaveBeenCalledTimes(1);
    // The dark host crosses the wire with NO version — the wire shape cannot smuggle one in.
    expect(out.hosts[1]).toEqual({
      source: "wsl:Ubuntu",
      reachable: false,
      lastSeenVersion: "0.1.4",
    });
    expect(out.hosts[0]?.version).toBe("0.1.5");
  });

  it("daemon.status with NO settings dep reports NO hosts (never a fabricated one)", async () => {
    const { dispatch } = harness();
    expect(await dispatch("daemon.status", {})).toEqual({ hosts: [] });
  });

  it("harness.hosts routes to the settings composition's per-host agent detection (C17)", async () => {
    const harnessHosts = vi.fn(async () => [
      {
        source: "local" as const,
        asked: true,
        detected: [{ id: "claude", version: "2.1.0", enabled: true }],
      },
      { source: "remote:d1" as const, asked: false, detected: [] },
    ]);
    const settings = { harnessHosts } as unknown as DispatchDeps["settings"];
    const { dispatch } = harness(undefined, { settings });
    const out = (await dispatch("harness.hosts", {})) as {
      hosts: { source: string; asked: boolean; detected: { id: string }[] }[];
    };
    expect(harnessHosts).toHaveBeenCalledTimes(1);
    expect(out.hosts[0]?.detected).toEqual([{ id: "claude", version: "2.1.0", enabled: true }]);
    // The unaskable host crosses the wire EMPTY — the wire shape cannot smuggle the local
    // machine's agents onto a host nothing was observed on.
    expect(out.hosts[1]).toEqual({ source: "remote:d1", asked: false, detected: [] });
  });

  it("harness.hosts with NO settings dep reports NO hosts (never a fabricated one)", async () => {
    const { dispatch } = harness();
    expect(await dispatch("harness.hosts", {})).toEqual({ hosts: [] });
  });

  it("harness.setEnabled routes the per-host decision to the store, and fails loudly with none", async () => {
    const setHarnessEnabled = vi.fn(() => ["codex"]);
    const settings = { setHarnessEnabled } as unknown as DispatchDeps["settings"];
    const { dispatch } = harness(undefined, { settings });
    expect(
      await dispatch("harness.setEnabled", {
        source: "wsl:Ubuntu",
        harnessId: "codex",
        enabled: false,
      }),
    ).toEqual({ disabled: ["codex"] });
    // The HOST travels with the decision — it is not applied to whichever host is local.
    expect(setHarnessEnabled).toHaveBeenCalledWith({
      source: "wsl:Ubuntu",
      harnessId: "codex",
      enabled: false,
    });

    // No store ⇒ the write REJECTS. Reporting a decision that went nowhere would be the lie.
    const { dispatch: unwired } = harness();
    await expect(
      unwired("harness.setEnabled", { source: "local", harnessId: "codex", enabled: false }),
    ).rejects.toThrow(/settings store/);
  });

  it("with NO settings dep wired, degrades to the builtin view + unresolved write (never throws)", async () => {
    const { dispatch } = harness();
    const view = (await dispatch("settings.get", {})) as {
      scheme: string;
      appearanceMalformed: boolean;
      projects: unknown[];
    };
    expect(view.scheme).toBe("system");
    expect(view.appearanceMalformed).toBe(false);
    expect(view.projects).toEqual([]);
    // HONEST-PRESENT (C16, #485): the council tables are static, so the review-role
    // mappings are readable with no settings dep at all. The Review section renders
    // the real defaults rather than a blank — all eight roles, every cell `default`.
    const roles = (view as unknown as { reviewRoles: ReviewRoleMapping[] }).reviewRoles;
    expect(roles).toEqual(reviewRoleMappings());
    expect(roles).toHaveLength(8);
    // The Flagged Second Seat does not run single-provider: an honest null, not a guess.
    const secondSeat = roles.find((role) => role.id === "second-seat");
    expect(secondSeat?.claudeOnly.value).toBeNull();
    expect(secondSeat?.codexOnly.value).toBeNull();
    expect(secondSeat?.dual.value).not.toBeNull();

    const guidance = (await dispatch("settings.guidance", {
      projectId: "p1",
      repoPath: "/orbital",
    })) as { reason: string | null };
    expect(guidance.reason).toBe("absent");

    const vis = (await dispatch("settings.setRepoVisibility", {
      commandId: crypto.randomUUID(),
      projectId: "p1",
      repoPath: "/orbital",
      visibility: "git-visible",
    })) as { status: string; changed: boolean; gitignorePath: string };
    // A typed no-op — it never fabricates a repo write it did not perform.
    expect(vis.status).toBe("unresolved");
    expect(vis.changed).toBe(false);
    expect(vis.gitignorePath).toBe("");

    // A role write with no dep persists NOTHING, and says so: the response carries
    // the council defaults (every cell `default`), never a fake success echoing the
    // edit back as though it had been stored.
    const assigned = (await dispatch("settings.setRoleAssignment", {
      roleId: "lens-workers",
      scenario: "dual",
      assignment: { model: "sonnet-5", effort: "medium" },
    })) as { reviewRoles: ReviewRoleMapping[] };
    expect(assigned.reviewRoles).toEqual(reviewRoleMappings());
    expect(assigned.reviewRoles.find((role) => role.id === "lens-workers")?.dual).toEqual({
      value: { model: "opus-4.8", effort: "high" },
      layer: "default",
    });
  });
});

// ── The review→agent handoff loop (issue #18, Contracts §2.1) ──────────────────

/** A capture port that returns v1 on the first call (initial review.capture) and a
 *  changed v2 on the second (the handoff's post-turn capture), so the delta is real. */
function twoPhaseCapture(): PatchsetCapturePort {
  let calls = 0;
  return {
    capture: () => {
      calls += 1;
      if (calls === 1) return Promise.resolve(patchset()); // v1: patch-1, src/a.ts
      return Promise.resolve({
        ...patchset(),
        id: "patch-2",
        files: [
          {
            path: "src/a.ts",
            status: "modified",
            additions: 2,
            deletions: 0,
            binary: false,
            patch: "XY",
          },
          // An edit NO disposition mentioned — the totality guarantee must surface it.
          {
            path: "src/unrelated.ts",
            status: "added",
            additions: 1,
            deletions: 0,
            binary: false,
            patch: "Z",
          },
        ],
        rawDiff: "XYZ",
      });
    },
  };
}

const HANDOFF_TURN = {
  status: "completed" as const,
  finalText: "addressed the change",
  turnDiff: [
    "diff --git a/src/a.ts b/src/a.ts",
    "@@ -1 +1 @@",
    "diff --git a/src/unrelated.ts b/src/unrelated.ts",
    "@@ -0,0 +1 @@",
  ].join("\n"),
  filesTouched: ["src/a.ts", "src/unrelated.ts"],
};

const HANDOFF_DISPOSITIONS = [
  { path: "src/a.ts", type: "request-change" as const, body: "add a guard clause" },
];

/**
 * Compose the bundle for a review (issue #72) — the exact bundle `review.handoff.run`
 * now consumes. With no composer wired the dispatch returns the mechanical floor
 * (`composed:false`), a real runnable bundle; pass a `composeBundle` dep to get an
 * authored one. Runs go compose→run, never rebuild-from-dispositions.
 */
async function composeBundleFor(
  dispatch: ReturnType<typeof createDispatch>,
  reviewId: string,
  dispositions: readonly {
    path: string;
    type: "request-change" | "comment";
    body: string;
  }[] = HANDOFF_DISPOSITIONS,
): Promise<ComposedHandoffBundle> {
  const out = (await dispatch("review.handoff.compose", {
    commandId: randomUUID(),
    reviewId,
    dispositions,
  })) as { bundle: ComposedHandoffBundle };
  return out.bundle;
}

describe("createDispatch — review.handoff.* (the review→agent loop, issue #18)", () => {
  it("prepare composes a bundle and its disclosure (pure — no session, no gate)", async () => {
    const runHandoffTurn = vi.fn<NonNullable<DispatchDeps["runHandoffTurn"]>>();
    const { dispatch } = harness(undefined, {}, { runHandoffTurn });
    const review = await capturedReview(dispatch);

    const out = (await dispatch("review.handoff.prepare", {
      commandId: randomUUID(),
      reviewId: review.id,
      dispositions: HANDOFF_DISPOSITIONS,
    })) as {
      bundle: { digest: string; tasks: unknown[] };
      disclosure: { writeEnabled: boolean; editsWorkingTree: boolean; taskCount: number };
    };

    expect(out.bundle.tasks).toHaveLength(1);
    expect(out.disclosure.writeEnabled).toBe(true);
    expect(out.disclosure.taskCount).toBe(1);
    // Preparing NEVER runs the write turn.
    expect(runHandoffTurn).not.toHaveBeenCalled();
  });

  it("run captures a NEW patchset, preserves the prior byte-identical (R28), and proves totality", async () => {
    const runHandoffTurn = vi.fn<NonNullable<DispatchDeps["runHandoffTurn"]>>(
      async () => HANDOFF_TURN,
    );
    const { dispatch } = harness(undefined, {}, { capturePort: twoPhaseCapture(), runHandoffTurn });
    const review = await capturedReview(dispatch);
    const priorActiveId = review.activePatchsetId;

    // Compose the bundle (mechanical floor — no composer wired), then run THAT bundle.
    // A button-press IS the human act — run directly, no consent ceremony.
    const bundle = await composeBundleFor(dispatch, review.id);
    const out = (await dispatch("review.handoff.run", {
      commandId: randomUUID(),
      reviewId: review.id,
      bundle,
    })) as {
      status: string;
      result: {
        review: Review;
        turnDiff: string;
        filesTouched: string[];
        carriedForward: number;
        orphaned: number;
      };
    };

    expect(out.status).toBe("ran");
    expect(runHandoffTurn).toHaveBeenCalledTimes(1);
    // A NEW patchset is active; the prior one still exists (R28: never rewritten).
    expect(out.result.review.activePatchsetId).toBe("patch-2");
    expect(out.result.review.patchsets.map((p) => p.id)).toContain(priorActiveId);
    const preserved = out.result.review.patchsets.find((p) => p.id === priorActiveId);
    expect(preserved?.files).toEqual(patchset().files);
    // Totality: the agent's edit to a file no disposition mentioned still appears.
    expect(out.result.filesTouched).toContain("src/unrelated.ts");
    // The reported counts are the REAL post-capture review state (issue #254), not a
    // fabricated constant: they equal the actual carried/orphaned sets on `updated`.
    expect(out.result.carriedForward).toBe(out.result.review.dispositions.length);
    expect(out.result.orphaned).toBe(out.result.review.orphaned?.length ?? 0);
  });

  it("run's captured review attributes each ask to its composed task (traceMap consumed, #73 wave 3)", async () => {
    // A capture yielding a distinct successor so the fold stamps a successor account: p1 has
    // src/a.ts; the successor changes it (addressed).
    let calls = 0;
    const capturePort: PatchsetCapturePort = {
      capture: () => {
        calls += 1;
        return Promise.resolve(
          calls === 1
            ? {
                ...patchset(),
                id: "pa1",
                files: [
                  {
                    path: "src/a.ts",
                    status: "modified",
                    additions: 1,
                    deletions: 0,
                    binary: false,
                    patch: "A1",
                  },
                ],
                rawDiff: "A1",
              }
            : {
                ...patchset(),
                id: "pa2",
                files: [
                  {
                    path: "src/a.ts",
                    status: "modified",
                    additions: 2,
                    deletions: 0,
                    binary: false,
                    patch: "A2",
                  },
                ],
                rawDiff: "A2",
              },
        );
      },
    };
    const { dispatch } = harness(
      undefined,
      {},
      { capturePort, runHandoffTurn: async () => HANDOFF_TURN },
    );
    const review = await capturedReview(dispatch);
    // Stage a disposition the bundle ask will match by anchor identity.
    await dispatch("review.setDisposition", {
      commandId: randomUUID(),
      reviewId: review.id,
      patchsetId: review.activePatchsetId,
      path: "src/a.ts",
      disposition: "request-change",
      body: "add a guard clause",
    });
    const bundle = await composeBundleFor(dispatch, review.id, [
      { path: "src/a.ts", type: "request-change", body: "add a guard clause" },
    ]);
    const priorActiveId = review.activePatchsetId;
    const out = (await dispatch("review.handoff.run", {
      commandId: randomUUID(),
      reviewId: review.id,
      bundle,
    })) as { status: string; result: { review: Review } };

    expect(out.status).toBe("ran");
    // The traceMap is consumed: the ask names the composed task that ran it.
    const ask = out.result.review.successorAccount?.asks.find((entry) => entry.path === "src/a.ts");
    expect(ask?.handoffTask).toBeDefined();
    expect(ask?.handoffTask?.index).toBe(0);
    // R28 still holds: the prior patchset survives byte-identical alongside the successor.
    expect(out.result.review.patchsets.map((p) => p.id)).toContain(priorActiveId);
  });

  it("persists ask ids and the verified bundle's non-identity traceMap projection", async () => {
    const { dispatch, store } = harness(
      undefined,
      {},
      {
        capturePort: twoPhaseCapture(),
        runHandoffTurn: async () => HANDOFF_TURN,
      },
    );
    const review = await capturedReview(dispatch);
    const bundle = await composeBundleFor(dispatch, review.id, [
      { path: "src/a.ts", type: "request-change", body: "add a guard clause" },
      { path: "src/unrelated.ts", type: "request-change", body: "tighten the helper" },
    ]);
    const nonIdentityBundle = {
      ...bundle,
      traceMap: { d0: 1, d1: 0 },
    };

    await dispatch("review.handoff.run", {
      commandId: randomUUID(),
      reviewId: review.id,
      bundle: nonIdentityBundle,
    });

    const activated = store.events.find(
      (event): event is Extract<ReviewEvent, { type: "PatchsetActivated" }> =>
        event.type === "PatchsetActivated" && event.patchset.id === "patch-2",
    );
    expect(activated?.handoff).toEqual([
      expect.objectContaining({
        id: "d0",
        path: "src/a.ts",
        taskIndex: 1,
        taskTitle: bundle.tasks[1]?.title,
      }),
      expect.objectContaining({
        id: "d1",
        path: "src/unrelated.ts",
        taskIndex: 0,
        taskTitle: bundle.tasks[0]?.title,
      }),
    ]);
  });

  it("run reports the deterministic carry's REAL non-zero count, not a fabricated constant (issue #254)", async () => {
    // A file that stays BYTE-IDENTICAL across the handoff capture — its approval MUST
    // carry, so the reported `carriedForward` must be a real 1, pinned to the outcome.
    const keep: PatchFile = {
      path: "src/keep.ts",
      status: "modified",
      additions: 1,
      deletions: 0,
      binary: false,
      patch: "KEEP",
    };
    let calls = 0;
    const capturePort: PatchsetCapturePort = {
      capture: () => {
        calls += 1;
        return Promise.resolve(
          calls === 1
            ? { ...patchset(), id: "pv1", files: [keep], rawDiff: "KEEP" }
            : {
                ...patchset(),
                id: "pv2",
                files: [
                  keep, // byte-identical → carries
                  {
                    path: "src/new.ts",
                    status: "added",
                    additions: 1,
                    deletions: 0,
                    binary: false,
                    patch: "N",
                  },
                ],
                rawDiff: "KEEPN",
              },
        );
      },
    };
    const { dispatch } = harness(
      undefined,
      {},
      {
        capturePort,
        runHandoffTurn: async () => HANDOFF_TURN,
      },
    );
    const review = await capturedReview(dispatch);
    // Approve the byte-identical file.
    await dispatch("review.setDisposition", {
      commandId: randomUUID(),
      reviewId: review.id,
      patchsetId: review.activePatchsetId,
      path: "src/keep.ts",
      disposition: "approve",
      body: "",
    });

    const bundle = await composeBundleFor(dispatch, review.id);
    const out = (await dispatch("review.handoff.run", {
      commandId: randomUUID(),
      reviewId: review.id,
      bundle,
    })) as { status: string; result: { review: Review; carriedForward: number; orphaned: number } };

    expect(out.status).toBe("ran");
    // The approval carried: a REAL 1, and it equals the review's actual carried set — a
    // hardcoded 0 (or any constant) fails here.
    expect(out.result.carriedForward).toBe(1);
    expect(out.result.carriedForward).toBe(out.result.review.dispositions.length);
    expect(out.result.orphaned).toBe(out.result.review.orphaned?.length ?? 0);
  });

  it("run surfaces the files a FAILED turn changed before erroring (Codex F4)", async () => {
    const runHandoffTurn = vi.fn<NonNullable<DispatchDeps["runHandoffTurn"]>>(async () => ({
      status: "failed" as const,
      reason: "harness overloaded",
      turnDiff: "diff --git a/src/half.ts b/src/half.ts",
      filesTouched: ["src/half.ts"],
    }));
    const { dispatch } = harness(undefined, {}, { capturePort: twoPhaseCapture(), runHandoffTurn });
    const review = await capturedReview(dispatch);

    const bundle = await composeBundleFor(dispatch, review.id);
    const out = (await dispatch("review.handoff.run", {
      commandId: randomUUID(),
      reviewId: review.id,
      bundle,
    })) as { status: string; reason: string; filesTouched: string[] };

    expect(out.status).toBe("failed");
    // The edits made before the error are surfaced, not hidden.
    expect(out.filesTouched).toEqual(["src/half.ts"]);
  });

  it("run answers 'unavailable' honestly when no coding harness is wired", async () => {
    const { dispatch } = harness();
    const review = await capturedReview(dispatch);
    const bundle = await composeBundleFor(dispatch, review.id);
    const out = (await dispatch("review.handoff.run", {
      commandId: randomUUID(),
      reviewId: review.id,
      bundle,
    })) as { status: string };
    expect(out.status).toBe("unavailable");
  });

  it("run executes the COMPOSED order — a reversed composition reaches the write turn reversed (issue #72)", async () => {
    // Two asks with distinguishable bodies. The composer REVERSES them; the run must
    // hand the write turn the reversed composed prompt, NOT the mechanical order.
    const dispositions = [
      { path: "src/a.ts", type: "request-change" as const, body: "ALPHA-FIRST-ASK" },
      { path: "src/b.ts", type: "comment" as const, body: "BETA-SECOND-ASK" },
    ];
    // A real composer: reverse the two groups. `composeHandoffBundle` reconstructs the
    // bodies verbatim and renders a genuine (verifiable) composed prompt.
    const reversingPort: ComposePort = () =>
      Promise.resolve({
        status: "emitted",
        proposal: {
          groups: [
            { title: "second", dispositionIds: ["d1"] },
            { title: "first", dispositionIds: ["d0"] },
          ],
        },
      });
    const composeBundle = vi.fn<NonNullable<DispatchDeps["composeBundle"]>>(({ bundle }) =>
      composeHandoffBundle(bundle, reversingPort),
    );
    let ranPrompt = "";
    const runHandoffTurn = vi.fn<NonNullable<DispatchDeps["runHandoffTurn"]>>(
      async ({ prompt }) => {
        ranPrompt = prompt;
        return HANDOFF_TURN;
      },
    );
    const { dispatch } = harness(
      undefined,
      {},
      { capturePort: twoPhaseCapture(), composeBundle, runHandoffTurn },
    );
    const review = await capturedReview(dispatch);

    const bundle = await composeBundleFor(dispatch, review.id, dispositions);
    expect(bundle.composed).toBe(true);
    const out = (await dispatch("review.handoff.run", {
      commandId: randomUUID(),
      reviewId: review.id,
      bundle,
    })) as { status: string };

    expect(out.status).toBe("ran");
    // The order the WRITE TURN received is the composed (reversed) one: BETA before ALPHA.
    // RED-proof: rebuild mechanically at run time and BETA would follow ALPHA → this fires.
    expect(ranPrompt).toContain("BETA-SECOND-ASK");
    expect(ranPrompt).toContain("ALPHA-FIRST-ASK");
    expect(ranPrompt.indexOf("BETA-SECOND-ASK")).toBeLessThan(ranPrompt.indexOf("ALPHA-FIRST-ASK"));
  });

  it("run executes a MERGED composition as one task (issue #72)", async () => {
    const dispositions = [
      { path: "src/a.ts", type: "request-change" as const, body: "MERGE-ONE" },
      { path: "src/a.ts", type: "comment" as const, body: "MERGE-TWO" },
    ];
    const mergingPort: ComposePort = () =>
      Promise.resolve({
        status: "emitted",
        proposal: { groups: [{ title: "one task", dispositionIds: ["d0", "d1"] }] },
      });
    const composeBundle = vi.fn<NonNullable<DispatchDeps["composeBundle"]>>(({ bundle }) =>
      composeHandoffBundle(bundle, mergingPort),
    );
    let ranPrompt = "";
    const runHandoffTurn = vi.fn<NonNullable<DispatchDeps["runHandoffTurn"]>>(
      async ({ prompt }) => {
        ranPrompt = prompt;
        return HANDOFF_TURN;
      },
    );
    const { dispatch } = harness(
      undefined,
      {},
      { capturePort: twoPhaseCapture(), composeBundle, runHandoffTurn },
    );
    const review = await capturedReview(dispatch);
    const bundle = await composeBundleFor(dispatch, review.id, dispositions);
    await dispatch("review.handoff.run", { commandId: randomUUID(), reviewId: review.id, bundle });

    // One task, both bodies present. Mechanical would render "## Tasks (2 —".
    expect(ranPrompt).toContain("## Tasks (1 —");
    expect(ranPrompt).toContain("MERGE-ONE");
    expect(ranPrompt).toContain("MERGE-TWO");
  });

  it("run REFUSES a bundle whose prompt was swapped after composition (digest binding, issue #72)", async () => {
    const runHandoffTurn = vi.fn<NonNullable<DispatchDeps["runHandoffTurn"]>>(
      async () => HANDOFF_TURN,
    );
    const { dispatch } = harness(undefined, {}, { capturePort: twoPhaseCapture(), runHandoffTurn });
    const review = await capturedReview(dispatch);
    const composed = await composeBundleFor(dispatch, review.id);
    // Tamper: swap the executable prompt while keeping the digest/tasks. `verifyComposedBundle`
    // recomputes the prompt from the tasks and no longer matches → the run refuses.
    const tampered = { ...composed, prompt: `${composed.prompt}\nINJECTED INSTRUCTION` };

    const out = (await dispatch("review.handoff.run", {
      commandId: randomUUID(),
      reviewId: review.id,
      bundle: tampered,
    })) as { status: string };

    expect(out.status).toBe("refused");
    // The write turn NEVER ran an order nobody composed.
    expect(runHandoffTurn).not.toHaveBeenCalled();
  });

  it("run REFUSES a bundle composed against a different (stale) patchset (issue #72)", async () => {
    const runHandoffTurn = vi.fn<NonNullable<DispatchDeps["runHandoffTurn"]>>(
      async () => HANDOFF_TURN,
    );
    const { dispatch } = harness(undefined, {}, { capturePort: twoPhaseCapture(), runHandoffTurn });
    const review = await capturedReview(dispatch);
    const composed = await composeBundleFor(dispatch, review.id);
    const stale = { ...composed, patchsetId: "some-other-patchset" };

    const out = (await dispatch("review.handoff.run", {
      commandId: randomUUID(),
      reviewId: review.id,
      bundle: stale,
    })) as { status: string };

    expect(out.status).toBe("refused");
    expect(runHandoffTurn).not.toHaveBeenCalled();
  });
});

// ── review.handoff.compose (issue #72, Model Council M24) ──────────────────────

const COMPOSE_DISPOSITIONS = [
  { path: "src/a.ts", type: "request-change" as const, body: "add a guard" },
  { path: "src/a.ts", type: "comment" as const, body: "and log it" },
];

describe("createDispatch — review.handoff.compose (issue #72)", () => {
  it("returns the mechanical floor when no composer is wired (composed:false, nothing lost)", async () => {
    const { dispatch } = harness();
    const review = await capturedReview(dispatch);
    const out = (await dispatch("review.handoff.compose", {
      commandId: randomUUID(),
      reviewId: review.id,
      dispositions: COMPOSE_DISPOSITIONS,
    })) as { bundle: { composed: boolean; tasks: unknown[]; traceMap: Record<string, number> } };

    expect(out.bundle.composed).toBe(false);
    // One task per ask; both asks traced.
    expect(out.bundle.tasks).toHaveLength(2);
    expect(Object.keys(out.bundle.traceMap).sort()).toEqual(["d0", "d1"]);
  });

  it("delegates to the wired composer and returns its composed bundle", async () => {
    const composeBundle = vi.fn<NonNullable<DispatchDeps["composeBundle"]>>(async ({ bundle }) => ({
      reviewId: bundle.reviewId,
      patchsetId: bundle.patchsetId,
      tasks: [
        {
          title: "Guard and log",
          sourceDispositions: ["d0", "d1"],
          asks: bundle.tasks.map((task, index) => ({ ...task, id: `d${index}` })),
        },
      ],
      prompt: "composed",
      digest: "deadbeef",
      composed: true,
      traceMap: { d0: 0, d1: 0 },
    }));
    const { dispatch } = harness(undefined, {}, { composeBundle });
    const review = await capturedReview(dispatch);

    const out = (await dispatch("review.handoff.compose", {
      commandId: randomUUID(),
      reviewId: review.id,
      dispositions: COMPOSE_DISPOSITIONS,
    })) as { bundle: { composed: boolean; tasks: { title: string }[] } };

    expect(composeBundle).toHaveBeenCalledTimes(1);
    // It was handed the reviewed repo root for the compose session's cwd.
    expect(composeBundle.mock.calls[0]?.[0]?.repoRoot).toBe(review.repositoryRoot);
    expect(out.bundle.composed).toBe(true);
    expect(out.bundle.tasks[0]?.title).toBe("Guard and log");
  });

  it("refuses a stale/unknown review id", async () => {
    const { dispatch } = harness();
    await capturedReview(dispatch);
    await expect(
      dispatch("review.handoff.compose", {
        commandId: randomUUID(),
        reviewId: "not-a-real-review",
        dispositions: COMPOSE_DISPOSITIONS,
      }),
    ).rejects.toThrow();
  });
});

describe("createDispatch — review.ask scoped reaping (issue #251, criterion 4)", () => {
  // A recording registry that hands out REAL AbortControllers, so a test can assert the
  // exact controller instance reaches each leg and that register/settle bracket the turn.
  function spyRegistry(): {
    registered: { turnId: string; reviewId?: string; controller: AbortController }[];
    settled: string[];
    liveTurns: NonNullable<DispatchDeps["liveTurns"]>;
  } {
    const registered: { turnId: string; reviewId?: string; controller: AbortController }[] = [];
    const settled: string[] = [];
    const active = new Map<
      string,
      { reviewId?: string; controller: AbortController; body: string }
    >();
    return {
      registered,
      settled,
      liveTurns: {
        register(turnId: string, reviewId?: string): AbortController {
          const controller = new AbortController();
          registered.push({ turnId, reviewId, controller });
          active.set(turnId, { reviewId, controller, body: "" });
          return controller;
        },
        settle(turnId: string): void {
          settled.push(turnId);
          active.delete(turnId);
        },
        appendDelta(turnId: string, delta: string): void {
          const turn = active.get(turnId);
          if (turn) turn.body += delta;
        },
        bodyOf(turnId: string): string {
          return active.get(turnId)?.body ?? "";
        },
        abortReview(reviewId: string): number {
          let count = 0;
          for (const turn of active.values()) {
            if (turn.reviewId === reviewId) {
              turn.controller.abort();
              count += 1;
            }
          }
          return count;
        },
      },
    };
  }

  async function openReview(liveTurns: NonNullable<DispatchDeps["liveTurns"]>) {
    const h = harness(undefined, {}, { liveTurns });
    const review = await capturedReview(h.dispatch);
    return { dispatch: h.dispatch, reviewAsk: h.reviewAsk, review };
  }

  it("registers the turn on start, threads the SAME controller into BOTH legs, and settles it on completion", async () => {
    const reg = spyRegistry();
    const { dispatch, reviewAsk, review } = await openReview(reg.liveTurns);
    await dispatch(
      "review.ask",
      {
        commandId: randomUUID(),
        reviewId: review.id,
        mode: "both",
        question: "q",
        threadId: "th",
        turnId: "tn",
        anchor: { kind: "chunk", label: "src/a.ts", key: "chunk|src/a.ts" },
      },
      { emitAskStream: () => undefined },
    );
    // Entered the registry once, under this turn's id.
    expect(reg.registered.map((r) => r.turnId)).toEqual(["tn"]);
    const controller = reg.registered[0]?.controller;
    // BOTH legs received the identical AbortController — one quit-abort cancels both.
    const orchArg = reviewAsk.askOrchestrator.mock.calls[0]?.[0] as { abortController?: unknown };
    const codexArg = reviewAsk.askCodex.mock.calls[0]?.[0] as { abortController?: unknown };
    expect(orchArg.abortController).toBe(controller);
    expect(codexArg.abortController).toBe(controller);
    // Left the registry when the turn settled.
    expect(reg.settled).toEqual(["tn"]);
  });

  it("review.interrupt aborts the in-flight turn, emits ask-interrupted, clears ask-pending, raises turn-failed (#382 M2)", async () => {
    const reg = spyRegistry();
    const raised: { family: string; body: string }[] = [];
    const acknowledged: { attentionId?: string; reviewId?: string }[] = [];
    const h = harness(
      undefined,
      {},
      {
        liveTurns: reg.liveTurns,
        raiseAttention: (event) => {
          raised.push({ family: event.family, body: event.body });
          return `${event.family}:${event.reviewId ?? "-"}`;
        },
        acknowledgeAttention: (selector) => {
          acknowledged.push(selector);
          return 1;
        },
      },
    );
    const review = await capturedReview(h.dispatch);

    // The orchestrator blocks until its abort fires, then swallows it and returns — the
    // "leg swallowed its abort and returned" path (still an interrupted turn).
    let entered!: () => void;
    const enteredP = new Promise<void>((resolve) => {
      entered = resolve;
    });
    h.reviewAsk.askOrchestrator.mockImplementationOnce(
      async ({ abortController }: { abortController?: AbortController }) => {
        entered();
        await new Promise<void>((resolve) =>
          abortController?.signal.addEventListener("abort", () => resolve()),
        );
        return { model: "Orchestrator · Claude", answer: "partial" };
      },
    );

    const events: ReviewAskStreamEvent[] = [];
    const askPromise = h.dispatch(
      "review.ask",
      {
        commandId: randomUUID(),
        reviewId: review.id,
        mode: "orchestrator",
        question: "which fix?",
        threadId: "th",
        turnId: "tn",
        anchor: { kind: "chunk", label: "src/a.ts", key: "chunk|src/a.ts" },
      },
      { emitAskStream: (event) => events.push(event) },
    );

    await enteredP; // the turn is registered and the orchestrator is blocked on its abort
    const interrupt = (await h.dispatch("review.interrupt", {
      commandId: randomUUID(),
      reviewId: review.id,
    })) as { interrupted: number };
    expect(interrupt).toEqual({ interrupted: 1 });

    await askPromise;

    // The stream carries EXACTLY ONE terminal event (#382 M2 finding 6): the swallowed abort
    // must NOT emit `ask-complete` and THEN `ask-interrupted` — a killed turn would flash a
    // completed answer first. One `ask-interrupted`, zero `ask-complete`.
    const terminals = events.filter(
      (e) => e.kind === "ask-complete" || e.kind === "ask-interrupted",
    );
    expect(terminals).toHaveLength(1);
    expect(terminals[0]?.kind).toBe("ask-interrupted");
    // The badges agree: ask-pending cleared, turn-failed raised with the interrupted cause.
    expect(raised.some((r) => r.family === "ask-pending")).toBe(true);
    expect(raised.some((r) => r.family === "turn-failed")).toBe(true);
    expect(acknowledged.some((a) => a.attentionId === `ask-pending:${review.id}`)).toBe(true);
  });

  it("review.interrupt with nothing in flight is a truthful no-op (a double-tap Stop)", async () => {
    const reg = spyRegistry();
    const { dispatch, review } = await openReview(reg.liveTurns);
    const out = (await dispatch("review.interrupt", {
      commandId: randomUUID(),
      reviewId: review.id,
    })) as { interrupted: number };
    expect(out).toEqual({ interrupted: 0 });
  });

  it("SETTLES the turn even when the ask throws — the leak guard on the aborted/errored path", async () => {
    const reg = spyRegistry();
    const { dispatch, reviewAsk, review } = await openReview(reg.liveTurns);
    // A quit-abort rejects the in-flight orchestrator turn; simulate that throw.
    reviewAsk.askOrchestrator.mockRejectedValueOnce(new Error("aborted"));
    await expect(
      dispatch(
        "review.ask",
        {
          commandId: randomUUID(),
          reviewId: review.id,
          mode: "orchestrator",
          question: "q",
          threadId: "th",
          turnId: "tn",
          anchor: { kind: "chunk", label: "src/a.ts", key: "chunk|src/a.ts" },
        },
        { emitAskStream: () => undefined },
      ),
    ).rejects.toThrow(/aborted/);
    // The turn ENTERED and still LEFT the registry — settling only on success would leak
    // the aborted turn's controller forever. This reddens if `settle` is moved out of the
    // `finally` (into the success path after the return).
    expect(reg.registered.map((r) => r.turnId)).toEqual(["tn"]);
    expect(reg.settled).toEqual(["tn"]);
  });

  it("registers a one-shot ask (no turnId) under a fresh key and reaps it too", async () => {
    const reg = spyRegistry();
    const { dispatch, reviewAsk, review } = await openReview(reg.liveTurns);
    await dispatch("review.ask", {
      commandId: randomUUID(),
      reviewId: review.id,
      question: "q",
    });
    // A keyless one-shot ask still enters the registry under a generated key, so its
    // model child is reapable on quit rather than surviving unregistered.
    expect(reg.registered).toHaveLength(1);
    const key = reg.registered[0]?.turnId ?? "";
    expect(key.length).toBeGreaterThan(0);
    const orchArg = reviewAsk.askOrchestrator.mock.calls[0]?.[0] as { abortController?: unknown };
    expect(orchArg.abortController).toBe(reg.registered[0]?.controller);
    // Settled under the SAME generated key it registered with.
    expect(reg.settled).toEqual([key]);
  });

  it("threads NO controller when no registry is wired (fully back-compat)", async () => {
    const h = harness();
    const review = await capturedReview(h.dispatch);
    await h.dispatch("review.ask", {
      commandId: randomUUID(),
      reviewId: review.id,
      question: "q",
    });
    // No `liveTurns` dep ⇒ the port is called with exactly its existing input, no
    // abortController key added.
    expect(h.reviewAsk.askOrchestrator).toHaveBeenCalledWith({ review, question: "q" });
  });

  // ⭐ THE LOAD-BEARING PROOF (criterion 4 → criterion 3). The whole user-visible payoff is
  // the chain: abort ⇒ no durable completion is persisted ⇒ the `streaming` placeholder
  // survives on disk ⇒ next launch recovers it as `interrupted`. If a leg SWALLOWS its
  // abort and returns a normal answer, the completion-persist would replace the
  // placeholder with a durable answer for a turn that was killed — a fabricated
  // completion, the exact failure #251 exists to prevent. The guard makes the property
  // structural (it does not depend on the abort THROWING). These two tests pin it.
  function orchWritesFrom(threadPersistence: {
    putMessage: ReturnType<typeof vi.fn>;
  }): { id: string; status?: string; body: string }[] {
    return threadPersistence.putMessage.mock.calls
      .map(([arg]) => (arg as { message: { id: string; status?: string; body: string } }).message)
      .filter((m) => m.id === "tn::orchestrator");
  }

  const STREAMED_INPUT = {
    mode: "orchestrator" as const,
    threadId: "th",
    turnId: "tn",
    anchor: { kind: "chunk" as const, label: "src/a.ts", key: "chunk|src/a.ts" },
    turnBody: "why?",
  };

  it("does NOT persist a durable completion when the leg SWALLOWS its abort and returns an answer (placeholder survives)", async () => {
    const reg = spyRegistry();
    const h = harness(undefined, {}, { liveTurns: reg.liveTurns });
    const review = await capturedReview(h.dispatch);
    // The quit fires mid-turn (controller.abort()), but the port returns a normal answer
    // anyway — exactly what the codex leg does when it catches execa's cancel, and what
    // the claude leg would do if the SDK ever resolved an aborted turn instead of throwing.
    h.reviewAsk.askOrchestrator.mockImplementationOnce(async ({ abortController }) => {
      abortController?.abort();
      return { model: "Orchestrator · Claude", answer: "a partial answer that must NOT persist" };
    });
    await h.dispatch(
      "review.ask",
      { commandId: randomUUID(), reviewId: review.id, question: "q", ...STREAMED_INPUT },
      { emitAskStream: () => undefined },
    );
    // Two writes: the streaming placeholder, then the INTERRUPTED replacement (#382 M2 finding 6).
    // The swallowed answer NEVER persists as a durable completion — the second write is an
    // `interrupted` message carrying only the partial body that actually streamed (none here).
    const orch = orchWritesFrom(h.threadPersistence);
    expect(orch).toHaveLength(2);
    expect(orch[0]?.status).toBe("streaming");
    expect(orch[1]?.status).toBe("interrupted");
    expect(orch.some((m) => m.body === "a partial answer that must NOT persist")).toBe(false);
  });

  it("does NOT persist a durable completion when the aborted leg THROWS (placeholder survives)", async () => {
    const reg = spyRegistry();
    const h = harness(undefined, {}, { liveTurns: reg.liveTurns });
    const review = await capturedReview(h.dispatch);
    // The other arrival: the leg rejects WITHOUT the controller being aborted — a GENUINE
    // failure (not a Stop). No interrupted replacement is persisted (that is only for an
    // aborted turn, #382 M2 finding 6); the placeholder survives and recovers as interrupted.
    h.reviewAsk.askOrchestrator.mockRejectedValueOnce(new Error("boom"));
    await expect(
      h.dispatch(
        "review.ask",
        { commandId: randomUUID(), reviewId: review.id, question: "q", ...STREAMED_INPUT },
        { emitAskStream: () => undefined },
      ),
    ).rejects.toThrow(/boom/);
    // Only the streaming placeholder, no completion. The throw skips the completion-persist.
    const orch = orchWritesFrom(h.threadPersistence);
    expect(orch).toHaveLength(1);
    expect(orch[0]?.status).toBe("streaming");
  });

  it("PERSISTS the interrupted replacement when an aborted leg THROWS (#382 M2 finding 6)", async () => {
    const reg = spyRegistry();
    const h = harness(undefined, {}, { liveTurns: reg.liveTurns });
    const review = await capturedReview(h.dispatch);
    // The Stop path in production: the controller is aborted, THEN the SDK throws its cancel.
    h.reviewAsk.askOrchestrator.mockImplementationOnce(async ({ abortController }) => {
      abortController?.abort();
      throw new Error("Request was cancelled");
    });
    await expect(
      h.dispatch(
        "review.ask",
        { commandId: randomUUID(), reviewId: review.id, question: "q", ...STREAMED_INPUT },
        { emitAskStream: () => undefined },
      ),
    ).rejects.toThrow(/cancelled/);
    // Two writes: the streaming placeholder, then the INTERRUPTED replacement the catch persists —
    // so the turn survives a store reload as interrupted directly, not only via crash-recovery.
    const orch = orchWritesFrom(h.threadPersistence);
    expect(orch).toHaveLength(2);
    expect(orch[1]?.status).toBe("interrupted");
  });

  it("abort during the CODEX leg (orchestrator already returned genuinely) persists NO completion and NO codex record", async () => {
    // ⭐ The subtler window: askReview is sequential (orchestrator, then codex), so an
    // abort during the codex leg leaves a GENUINE orchestrator answer in hand while the
    // codex port SWALLOWS its cancel (its catch returns "Codex could not answer …"). The
    // ask then RESOLVES — no throw — so control flow alone would run the completion-persist
    // and (a) overwrite the placeholder with the real orchestrator answer AND (b) persist
    // the codex cancel as though the tool had FAILED, conflating "you quit" with "codex
    // broke". The abort guard is leg-agnostic — it fires on `signal.aborted` regardless of
    // which leg swallowed — so neither is persisted and the turn recovers as interrupted.
    const reg = spyRegistry();
    const h = harness(undefined, {}, { liveTurns: reg.liveTurns });
    const review = await capturedReview(h.dispatch);
    // Orchestrator finishes genuinely, WITHOUT aborting.
    h.reviewAsk.askOrchestrator.mockImplementationOnce(async () => ({
      model: "Orchestrator · Claude",
      answer: "a genuine, complete orchestrator answer",
    }));
    // Codex leg: the quit fires mid-exec (abort), and the port's catch returns a
    // failure-shaped answer rather than throwing — exactly `createLiveCodexAsk`'s behaviour.
    h.reviewAsk.askCodex.mockImplementationOnce(async ({ abortController }) => {
      abortController?.abort();
      return { model: "codex", answer: "Codex could not answer: Operation aborted" };
    });
    await h.dispatch(
      "review.ask",
      {
        commandId: randomUUID(),
        reviewId: review.id,
        question: "q",
        ...STREAMED_INPUT,
        mode: "both",
      },
      { emitAskStream: () => undefined },
    );
    const messages = h.threadPersistence.putMessage.mock.calls.map(
      ([arg]) => (arg as { message: { id: string; status?: string; body: string } }).message,
    );
    // Orchestrator: the streaming placeholder, then the INTERRUPTED replacement (#382 M2 finding
    // 6) — the genuine answer is NEVER persisted as a durable completion (the turn was killed).
    const orch = messages.filter((m) => m.id === "tn::orchestrator");
    expect(orch).toHaveLength(2);
    expect(orch[0]?.status).toBe("streaming");
    expect(orch[1]?.status).toBe("interrupted");
    expect(orch.some((m) => m.body === "a genuine, complete orchestrator answer")).toBe(false);
    // Codex: no record at all — the cancel is NOT persisted as a codex failure. Drop the
    // guard and this reddens (a `tn::codex` "could not answer" message appears).
    expect(messages.some((m) => m.id === "tn::codex")).toBe(false);
  });

  // ⭐ THE REATTACH CONTRACT (Finding A, #382 M2). The interrupted outcome must LAND IN THE
  // PERSISTED MESSAGES — a client that reattaches after a Stop/kill sees the turn as
  // `interrupted` in `threads`, never a turn hung forever in `inFlight`. The abort guard keeps
  // the streaming placeholder on disk; the store's crash-recovery transform reads it back as
  // `interrupted`; reattach returns it in `threads` with `inFlight` empty. Wired to a REAL
  // FileThreadStore (temp dir) so putMessage→loadThreads round-trips the real transform, not a
  // spy. This is the end-to-end proof the settle path gives for free — asserted, per the ruling.
  it("an interrupted turn lands in the persisted thread messages, not a hung inFlight (reattach contract)", async () => {
    const store = new FileThreadStore(mkdtempSync(join(tmpdir(), "rennet-threads-")));
    const reg = spyRegistry();
    const h = harness(
      undefined,
      {},
      {
        liveTurns: reg.liveTurns,
        threadPersistence: {
          upsertThread: (input) => store.upsertThread(input.reviewId, input),
          putMessage: (input) => store.putMessage(input.reviewId, input.threadId, input.message),
        },
        reattachThreads: async ({ reviewId }) => ({
          threads: store.loadThreads(reviewId),
          inFlight: [],
        }),
      },
    );
    const review = await capturedReview(h.dispatch);
    // The Stop path: the controller is aborted, then the SDK throws its cancel — so the catch
    // persists the explicit interrupted replacement (#382 M2 finding 6) into the real store.
    h.reviewAsk.askOrchestrator.mockImplementationOnce(async ({ abortController }) => {
      abortController?.abort();
      throw new Error("Request was cancelled");
    });
    await expect(
      h.dispatch(
        "review.ask",
        { commandId: randomUUID(), reviewId: review.id, question: "q", ...STREAMED_INPUT },
        { emitAskStream: () => undefined },
      ),
    ).rejects.toThrow(/cancelled/);
    // Reattach sees the interrupted turn IN the persisted messages, and NOTHING hung in-flight.
    const reattached = (await h.dispatch("review.reattach", {
      commandId: randomUUID(),
      reviewId: review.id,
    })) as {
      threads: { messages: { id: string; status?: string }[] }[];
      inFlight: unknown[];
    };
    expect(reattached.inFlight).toEqual([]);
    const orch = reattached.threads
      .flatMap((thread) => thread.messages)
      .find((message) => message.id === "tn::orchestrator");
    expect(orch?.status).toBe("interrupted");
  });
});

describe("createDispatch — device.registerPush + attention.acknowledge (#383 M1)", () => {
  function pushTokensSpy() {
    return { set: vi.fn(), delete: vi.fn() };
  }

  it("registers a push token keyed by the connection's authenticated device id", async () => {
    const pushTokens = pushTokensSpy();
    const { dispatch } = harness(undefined, {}, { pushTokens });
    const output = await dispatch(
      "device.registerPush",
      { pushToken: "ExponentPushToken[abc]", platform: "ios" },
      { deviceId: "dev-1" },
    );
    expect(output).toEqual({ registered: true });
    expect(pushTokens.set).toHaveBeenCalledWith("dev-1", "ExponentPushToken[abc]", "ios", []);
  });

  it("passes the device's muted families through to the store (#383 batch)", async () => {
    const pushTokens = pushTokensSpy();
    const { dispatch } = harness(undefined, {}, { pushTokens });
    await dispatch(
      "device.registerPush",
      { pushToken: "t", platform: "ios", disabledFamilies: ["handoff-completed", "publish-ready"] },
      { deviceId: "dev-1" },
    );
    expect(pushTokens.set).toHaveBeenCalledWith("dev-1", "t", "ios", [
      "handoff-completed",
      "publish-ready",
    ]);
  });

  it("clears the token on remove (permission lost on the phone)", async () => {
    const pushTokens = pushTokensSpy();
    const { dispatch } = harness(undefined, {}, { pushTokens });
    const output = await dispatch(
      "device.registerPush",
      { platform: "android", remove: true },
      { deviceId: "dev-1" },
    );
    expect(output).toEqual({ registered: false });
    expect(pushTokens.delete).toHaveBeenCalledWith("dev-1");
  });

  it("rejects registerPush on a connection with no authenticated device (loopback/pairing-only)", async () => {
    const { dispatch } = harness(undefined, {}, { pushTokens: pushTokensSpy() });
    await expect(
      dispatch("device.registerPush", { pushToken: "t", platform: "ios" }, {}),
    ).rejects.toThrow(/paired \(token-bearing\)/);
  });

  it("acknowledge routes the selector to the clear surface and returns the count", async () => {
    const acknowledgeAttention = vi.fn(() => 2);
    const { dispatch } = harness(undefined, {}, { acknowledgeAttention });
    const output = await dispatch("attention.acknowledge", { reviewId: "rev-1" });
    expect(output).toEqual({ cleared: 2 });
    expect(acknowledgeAttention).toHaveBeenCalledWith({ reviewId: "rev-1" });
  });

  it("acknowledge returns { cleared: 0 } when attention is off (no dep wired)", async () => {
    const { dispatch } = harness();
    expect(await dispatch("attention.acknowledge", { reviewId: "rev-1" })).toEqual({ cleared: 0 });
  });

  it("review.capture raises a review-finished attention with a digest deep-link", async () => {
    const raiseAttention = vi.fn();
    const { dispatch } = harness(undefined, {}, { raiseAttention });
    await dispatch("repository.choose", {});
    await dispatch("review.capture", { commandId: crypto.randomUUID(), repoPath: REPO });
    expect(raiseAttention).toHaveBeenCalledOnce();
    const event = raiseAttention.mock.calls[0]?.[0];
    expect(event).toMatchObject({ family: "review-finished" });
    expect(event.deepLink).toMatch(/^rennet:\/\/review\/.+\/digest$/);
  });
});

// ── The Context Map surface (change add-context-map-view) ────────────────────
describe("createDispatch — project.contextMap / contextAsk / knowledgeDisposition", () => {
  const sampleMap = {
    baseRef: "main",
    baseRefResolution: "symbolic-head" as const,
    baseOid: "abc123",
    fingerprint: "fp-1",
    files: [{ path: "src/a.ts", blobOid: "blob-1", size: 10, mode: "100644" }],
    scopes: [],
    edges: [],
    entryPoints: [],
    tests: [],
    ownership: [],
    conventions: [],
  };
  const sampleStatement = {
    id: "stmt-1",
    subject: "src/a.ts",
    aspect: "purpose" as const,
    claim: "a.ts is the entrypoint",
    evidence: [{ path: "src/a.ts", blobOid: "blob-1" }],
    confidence: "high" as const,
    status: "hypothesis" as const,
    provenance: { generator: "test", model: null, apiKeySource: null },
    learnedAgainst: { baseOid: "abc123", snapshotFingerprint: "fp-1" },
  };
  const sampleKnowledge = {
    schemaVersion: 1,
    repoKey: "repo-1",
    baseOid: "abc123",
    snapshotFingerprint: "fp-1",
    generator: "test",
    statements: [sampleStatement],
  };

  it("project.contextMap serves the persisted map + knowledge verbatim", async () => {
    const { dispatch } = harness(
      undefined,
      {},
      {
        projectContextMap: () =>
          Promise.resolve({ status: "ok", map: sampleMap, knowledge: sampleKnowledge }),
      },
    );
    const out = await dispatch("project.contextMap", { projectId: "proj-1" });
    expect(out).toEqual({ status: "ok", map: sampleMap, knowledge: sampleKnowledge });
  });

  it("project.contextMap returns a typed absent when nothing is persisted", async () => {
    const { dispatch } = harness();
    const out = await dispatch("project.contextMap", { projectId: "proj-1" });
    expect(out).toEqual({ status: "absent", reason: "stub" });
  });

  it("project.contextAsk carries the answered result with evidence + cost", async () => {
    const answered = {
      status: "answered" as const,
      answer: {
        answer: "yes",
        evidence: [{ path: "src/a.ts", blobOid: "blob-1" }],
        confidence: "high" as const,
        consulted: ["src/a.ts"],
        cost: {
          turns: 1,
          model: "claude",
          effort: null,
          budgetGranted: true,
          overage: false,
          resolution: null,
        },
      },
    };
    const projectContextAsk = vi.fn<DispatchDeps["projectContextAsk"]>(() =>
      Promise.resolve(answered),
    );
    const { dispatch } = harness(undefined, {}, { projectContextAsk });
    const out = await dispatch("project.contextAsk", {
      projectId: "proj-1",
      question: "is a.ts the entrypoint?",
      scope: "src",
    });
    expect(out).toEqual(answered);
    expect(projectContextAsk).toHaveBeenCalledWith({
      projectId: "proj-1",
      question: "is a.ts the entrypoint?",
      scope: "src",
    });
  });

  it("project.contextAsk surfaces the honest failed result (no harness) with its cost", async () => {
    const { dispatch } = harness();
    const out = (await dispatch("project.contextAsk", {
      projectId: "proj-1",
      question: "anything?",
    })) as { status: string; failureReason: string };
    expect(out.status).toBe("failed");
    expect(out.failureReason).toBe("stub");
  });

  it("project.knowledgeDisposition round-trips the flipped statement", async () => {
    const confirmed = { ...sampleStatement, status: "confirmed" as const };
    const knowledgeDisposition = vi.fn<DispatchDeps["knowledgeDisposition"]>(() =>
      Promise.resolve({ status: "ok", statement: confirmed }),
    );
    const { dispatch } = harness(undefined, {}, { knowledgeDisposition });
    const out = await dispatch("project.knowledgeDisposition", {
      projectId: "proj-1",
      statementId: "stmt-1",
      disposition: "confirmed",
    });
    expect(out).toEqual({ status: "ok", statement: confirmed });
    expect(knowledgeDisposition).toHaveBeenCalledWith({
      projectId: "proj-1",
      statementId: "stmt-1",
      disposition: "confirmed",
    });
  });

  it("project.knowledgeDisposition returns typed not-found for an unknown id", async () => {
    const { dispatch } = harness();
    const out = await dispatch("project.knowledgeDisposition", {
      projectId: "proj-1",
      statementId: "ghost",
      disposition: "rejected",
    });
    expect(out).toEqual({ status: "not-found", statementId: "ghost" });
  });
});

describe("createDispatch — onReviewOpened (#461, B7)", () => {
  it("fires on review.capture and review.openPr with the opened review — the retrieval kick point", async () => {
    const opened: string[] = [];
    const { dispatch } = harness(
      undefined,
      {},
      {
        onReviewOpened: (review) => opened.push(review.id),
      },
    );

    const captured = await capturedReview(dispatch);
    expect(opened).toEqual([captured.id]);

    const pr = (await dispatch("review.openPr", {
      commandId: randomUUID(),
      ref: "rbutera/orbital#7",
    })) as { review: Review };
    expect(opened).toEqual([captured.id, pr.review.id]);
  });

  it("review.load does NOT fire it — a reopen is a pure read, not a review open", async () => {
    const opened: string[] = [];
    const { dispatch } = harness(
      undefined,
      {},
      {
        onReviewOpened: (review) => opened.push(review.id),
      },
    );
    const captured = await capturedReview(dispatch);
    await dispatch("review.load", { commandId: randomUUID(), reviewId: captured.id });
    expect(opened).toEqual([captured.id]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// F1 E2E (#570) — the REAL `review.ask` dispatch path over the REAL live ports
// (`createLiveReviewAskPorts` + `createLiveOrchestratorAsk`) and the REAL durable
// thread store, with only the harness TURN faked. Every layer between the chat
// dock's mutation and the `claude` process is the shipped one, so this is what
// actually broke: the canned answer, the missing stream source, and the anchor
// that decides whether a turn is persisted at all.
// ─────────────────────────────────────────────────────────────────────────────

/** A fake `HandoffRunPort`: replays `deltas` through `onDelta`, then completes. */
function fakeTurnPort(finalText: string, deltas: readonly string[]): HandoffRunPort {
  return (input) => {
    for (const delta of deltas) input.onDelta?.(delta);
    return Promise.resolve({ status: "completed", finalText });
  };
}

/** The harness wired to the live ask ports and a real on-disk thread store. */
function liveAskHarness(runPort: HandoffRunPort | null): {
  h: ReturnType<typeof harness>;
  raised: { family: string }[];
  acknowledged: { attentionId?: string; reviewId?: string }[];
} {
  const store = new FileThreadStore(mkdtempSync(join(tmpdir(), "f1-threads-")));
  const raised: { family: string }[] = [];
  const acknowledged: { attentionId?: string; reviewId?: string }[] = [];
  const h = harness(
    undefined,
    {},
    {
      // The REAL live-turn registry, so `review.interrupt` reaches the live turn.
      liveTurns: new LiveTurnRegistry(),
      reviewAsk: createLiveReviewAskPorts({
        askOrchestrator: createLiveOrchestratorAsk({
          resolveRunPort: () => Promise.resolve(runPort),
        }),
      }),
      threadPersistence: {
        upsertThread: (input) => store.upsertThread(input.reviewId, input),
        putMessage: (input) => store.putMessage(input.reviewId, input.threadId, input.message),
      },
      reattachThreads: ({ reviewId }) =>
        Promise.resolve({ threads: store.loadThreads(reviewId), inFlight: [] }),
      raiseAttention: (event) => {
        raised.push({ family: event.family });
        return `${event.family}:${event.reviewId ?? "-"}`;
      },
      acknowledgeAttention: (selector) => {
        acknowledged.push(selector);
        return 1;
      },
    },
  );
  return { h, raised, acknowledged };
}

const CHAT_ANCHOR = { kind: "fragment" as const, label: "does b get used?", key: "th-1" };

describe("F1 E2E — review.ask over the LIVE orchestrator port (#570)", () => {
  it("streams the turn's real deltas, settles with its real answer, and survives a reload", async () => {
    const { h, raised, acknowledged } = liveAskHarness(
      fakeTurnPort("b is exported but never imported.", [
        "b is ",
        "exported but ",
        "never imported.",
      ]),
    );
    const review = await capturedReview(h.dispatch);
    raised.length = 0;
    const events: ReviewAskStreamEvent[] = [];
    await h.dispatch(
      "review.ask",
      {
        commandId: randomUUID(),
        reviewId: review.id,
        question: "does b get used?",
        threadId: "th-1",
        turnId: "tn-1",
        turnBody: "does b get used?",
        anchor: CHAT_ANCHOR,
      },
      { emitAskStream: (event) => events.push(event) },
    );

    // The deltas the FAKE TURN emitted reached the wire, in order — the streaming
    // source cluster 1 lit. Before F1 the SDK emitted no partial frames at all, so
    // this list was empty and the dock sat silent for the whole turn.
    const deltas = events.filter((e) => e.kind === "ask-delta");
    expect(deltas.map((e) => (e.kind === "ask-delta" ? e.delta : ""))).toEqual([
      "b is ",
      "exported but ",
      "never imported.",
    ]);
    // Exactly one terminal, carrying the TURN's text — not a canned constant.
    const terminals = events.filter(
      (e) => e.kind === "ask-complete" || e.kind === "ask-interrupted",
    );
    expect(terminals).toHaveLength(1);
    const complete = terminals[0];
    const answer = complete?.kind === "ask-complete" ? complete.finalBody : "";
    expect(answer).toBe("b is exported but never imported.");
    expect(answer).not.toMatch(/Board rebuild/i);
    // Every wire frame is schema-valid (no shape drift through the live port). `seq`
    // is stamped by the ws-listener downstream, so supply one to check the rest.
    for (const event of events) {
      expect(() => reviewAskStreamEventSchema.parse({ seq: 1, ...event })).not.toThrow();
    }
    // The badge lifecycle still holds under a live port: raised, then cleared.
    expect(raised.some((r) => r.family === "ask-pending")).toBe(true);
    expect(raised.some((r) => r.family === "turn-failed")).toBe(false);
    expect(acknowledged.some((a) => a.attentionId === `ask-pending:${review.id}`)).toBe(true);

    // RELOAD: `review.reattach` is the dock's own read. The exchange is on disk.
    const reattached = (await h.dispatch("review.reattach", {
      commandId: randomUUID(),
      reviewId: review.id,
    })) as { threads: { messages: { author: string; body: string }[] }[] };
    const bodies = reattached.threads.flatMap((t) => t.messages.map((m) => m.body));
    expect(bodies).toContain("does b get used?");
    expect(bodies).toContain("b is exported but never imported.");
  });

  it("POSITIVE CONTROL: without the anchor the answer is never persisted (reload loses it)", async () => {
    // Dispatch persists a turn ONLY when the ask carries an anchor. This is exactly the
    // state `main` shipped — the dock sent none — so a real answer vanished on reload and
    // the dock's own reattach read came back empty. Drop the anchor from `send()` and this
    // is what the reviewer gets.
    const { h } = liveAskHarness(fakeTurnPort("b is exported but never imported.", ["b"]));
    const review = await capturedReview(h.dispatch);
    await h.dispatch(
      "review.ask",
      {
        commandId: randomUUID(),
        reviewId: review.id,
        question: "does b get used?",
        threadId: "th-1",
        turnId: "tn-1",
        turnBody: "does b get used?",
      },
      { emitAskStream: () => undefined },
    );
    const reattached = (await h.dispatch("review.reattach", {
      commandId: randomUUID(),
      reviewId: review.id,
    })) as { threads: unknown[] };
    expect(reattached.threads).toEqual([]);
  });

  it("with NO harness installed it answers honestly, naming claude — never a plausible stand-in", async () => {
    const { h } = liveAskHarness(null);
    const review = await capturedReview(h.dispatch);
    const events: ReviewAskStreamEvent[] = [];
    await h.dispatch(
      "review.ask",
      {
        commandId: randomUUID(),
        reviewId: review.id,
        question: "does b get used?",
        threadId: "th-1",
        turnId: "tn-1",
        turnBody: "does b get used?",
        anchor: CHAT_ANCHOR,
      },
      { emitAskStream: (event) => events.push(event) },
    );
    const complete = events.find((e) => e.kind === "ask-complete");
    const answer = complete?.kind === "ask-complete" ? complete.finalBody : "";
    // It settles (no silent hang) and it names the missing binary.
    expect(answer).toBe(NO_HARNESS_ANSWER);
    expect(answer).toMatch(/claude/);
    expect(answer).not.toMatch(/Board rebuild/i);
  });

  it("review.interrupt mid-turn still yields EXACTLY ONE terminal under the live port", async () => {
    let entered!: () => void;
    const enteredP = new Promise<void>((resolve) => {
      entered = resolve;
    });
    // A turn that blocks until its abort fires, then swallows it and completes — the
    // path that would flash a completed answer before the interrupted one.
    const blockingPort: HandoffRunPort = async (input) => {
      entered();
      await new Promise<void>((resolve) => {
        if (input.signal?.aborted) resolve();
        else input.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      return { status: "completed", finalText: "too late" };
    };
    const { h } = liveAskHarness(blockingPort);
    const review = await capturedReview(h.dispatch);
    const events: ReviewAskStreamEvent[] = [];
    const askPromise = h.dispatch(
      "review.ask",
      {
        commandId: randomUUID(),
        reviewId: review.id,
        question: "q",
        threadId: "th-1",
        turnId: "tn-1",
        turnBody: "q",
        anchor: CHAT_ANCHOR,
      },
      { emitAskStream: (event) => events.push(event) },
    );
    await enteredP;
    const interrupt = (await h.dispatch("review.interrupt", {
      commandId: randomUUID(),
      reviewId: review.id,
    })) as { interrupted: number };
    expect(interrupt).toEqual({ interrupted: 1 });
    await askPromise;
    const terminals = events.filter(
      (e) => e.kind === "ask-complete" || e.kind === "ask-interrupted",
    );
    expect(terminals).toHaveLength(1);
    expect(terminals[0]?.kind).toBe("ask-interrupted");
  });
});
