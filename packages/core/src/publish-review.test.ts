import type { AskProjection, Disposition, PatchFile, Patchset } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import type { ForgeCapabilities } from "./forge-port";
import { buildHandoffBundle } from "./handoff-loop";
import {
  buildForgeReviewPost,
  buildReviewMarker,
  canonicalReviewPayload,
  DEFAULT_REVIEW_EVENT,
  deriveReviewEvent,
  extractMarker,
  type ForgeReviewPostDescriptor,
  type ForgeReviewTarget,
  forgeReviewPostDescriptor,
  forgeTargetKey,
  handoffDispositionsFromProjection,
  markerComment,
  type ReviewArtifact,
  type ReviewBodyNote,
  type ReviewCommentInput,
  resolveComposedReviewEvent,
  reviewBodyNotesFromProjection,
  reviewCommentsFromDispositions,
  reviewCommentsFromProjection,
} from "./publish-review";

const TARGET: ForgeReviewTarget = {
  ref: { repo: { forge: "github", owner: "rbutera", name: "rennet-egress-sandbox" }, number: 7 },
  forgeRef: "PR_kwABC",
  headOid: "deadbeef0007",
};

const CAPS: ForgeCapabilities = {
  supportsThreadResolution: true,
  supportsBatchedReview: true,
  supportsMultiLineAnchors: true,
  supportsFileLevelThreads: true,
};

const OPENER = "I reviewed the change and checked the points below.";

function artifact(
  input: {
    readonly opener?: string;
    readonly comments?: readonly ReviewCommentInput[];
    readonly bodyNotes?: readonly ReviewBodyNote[];
  } = {},
): ReviewArtifact {
  return {
    opener: input.opener ?? OPENER,
    comments: input.comments ?? [],
    bodyNotes: input.bodyNotes ?? [],
  };
}

describe("canonicalReviewPayload (issue #21) — the egress round-trip bytes", () => {
  it("serialises the complete review artifact in a pinned field order", () => {
    const comments: ReviewCommentInput[] = [
      { path: "src/a.ts", line: 2, side: "RIGHT", type: "request-change", body: "rename" },
      { path: "README.md", side: "RIGHT", type: "comment", body: "note" },
    ];
    expect(canonicalReviewPayload(artifact({ comments }))).toBe(
      `{"kind":"pr-review","opener":${JSON.stringify(OPENER)},"comments":[` +
        '{"path":"src/a.ts","line":2,"side":"RIGHT","type":"request-change","body":"rename"},' +
        '{"path":"README.md","line":null,"side":"RIGHT","type":"comment","body":"note"}],"bodyNotes":[]}',
    );
  });

  it("serialises a missing line as null (a file-level note)", () => {
    const payload = canonicalReviewPayload(
      artifact({ comments: [{ path: "x.ts", side: "RIGHT", type: "comment", body: "b" }] }),
    );
    expect(payload).toContain('"line":null');
  });

  it("binds a multi-line span into the canonical bytes", () => {
    const payload = canonicalReviewPayload(
      artifact({
        comments: [
          {
            path: "src/range.ts",
            startLine: 8,
            line: 10,
            side: "RIGHT",
            type: "request-change",
            body: "keep this span together",
          },
        ],
      }),
    );

    expect(JSON.parse(payload).comments[0]).toEqual({
      path: "src/range.ts",
      startLine: 8,
      line: 10,
      side: "RIGHT",
      type: "request-change",
      body: "keep this span together",
    });
  });

  it("distinguishes a single-byte body change (so a === check is not a prefix check)", () => {
    const base: ReviewCommentInput[] = [
      { path: "a", line: 1, side: "RIGHT", type: "comment", body: "hello" },
    ];
    const flipped: ReviewCommentInput[] = [
      { path: "a", line: 1, side: "RIGHT", type: "comment", body: "hellp" },
    ];
    expect(canonicalReviewPayload(artifact({ comments: base }))).not.toBe(
      canonicalReviewPayload(artifact({ comments: flipped })),
    );
  });

  it("binds review-body-note identity and provenance into the canonical bytes", () => {
    const note = {
      id: "ask-overall",
      anchor: "Design · Retry policy",
      type: "comment",
      body: "the policy matches its documented boundary",
    } satisfies ReviewBodyNote;

    const payload = canonicalReviewPayload(artifact({ bodyNotes: [note] }));
    expect(JSON.parse(payload)).toEqual({
      kind: "pr-review",
      opener: OPENER,
      comments: [],
      bodyNotes: [note],
    });
    expect(payload).not.toBe(
      canonicalReviewPayload(
        artifact({ bodyNotes: [{ ...note, anchor: "Design · Failure policy" }] }),
      ),
    );
  });

  it("binds the byte-preserved nonblank opener into canonical bytes and the marker", () => {
    const opener = "  I checked the retry boundary exactly.  ";
    const exact = artifact({ opener });
    const mutated = artifact({ opener: `${opener}!` });
    const payload = canonicalReviewPayload(exact);
    const mutatedPayload = canonicalReviewPayload(mutated);

    expect(JSON.parse(payload).opener).toBe(opener);
    expect(mutatedPayload).not.toBe(payload);
    expect(buildReviewMarker("rev-1", TARGET, mutatedPayload, "COMMENT")).not.toBe(
      buildReviewMarker("rev-1", TARGET, payload, "COMMENT"),
    );
    expect(() => canonicalReviewPayload(artifact({ opener: " \n\t " }))).toThrow(/opener/i);
  });
});

describe("reviewCommentsFromDispositions (issue #382 M2) — the daemon's one-source review compose", () => {
  const disp = (
    path: string,
    type: Disposition["type"],
    body: string,
    span?: { startLine: number; side: "additions" | "deletions" | "context" },
  ): Disposition => ({
    anchor: {
      path,
      contentDigest: "d",
      ...(span ? { span: { startLine: span.startLine }, side: span.side, spanDigest: "s" } : {}),
    },
    type,
    body,
  });

  it("maps each disposition to one comment: span→line+side, path-grained→file-level", () => {
    const comments = reviewCommentsFromDispositions([
      disp("src/a.ts", "comment", "note", { startLine: 12, side: "additions" }),
      disp("src/a.ts", "request-change", "deleted here", { startLine: 3, side: "deletions" }),
      disp("README.md", "approve", "file-level ok"),
    ]);
    // Ordered path-then-line: README before src/a.ts; within src/a.ts line 3 before line 12.
    expect(comments).toEqual([
      { path: "README.md", side: "RIGHT", type: "approve", body: "file-level ok" },
      { path: "src/a.ts", line: 3, side: "LEFT", type: "request-change", body: "deleted here" },
      { path: "src/a.ts", line: 12, side: "RIGHT", type: "comment", body: "note" },
    ]);
  });

  it("its payload round-trips through canonicalReviewPayload byte-exact (preview == post)", () => {
    const dispositions = [
      disp("src/a.ts", "comment", "note", { startLine: 12, side: "context" }),
      disp("README.md", "question", "why?"),
    ];
    const comments = reviewCommentsFromDispositions(dispositions);
    // The bytes the phone previews are the bytes publish.review re-verifies.
    expect(() => JSON.parse(canonicalReviewPayload(artifact({ comments })))).not.toThrow();
    expect(deriveReviewEvent(comments)).toBe("COMMENT");
  });

  it("verdict derives from disposition types (a request-change escalates the whole review)", () => {
    const comments = reviewCommentsFromDispositions([
      disp("a", "approve", "ok"),
      disp("b", "request-change", "no"),
    ]);
    expect(deriveReviewEvent(comments)).toBe("REQUEST_CHANGES");
  });

  it("empty dispositions compose an empty (honest) review, not a throw", () => {
    expect(reviewCommentsFromDispositions([])).toEqual([]);
  });
});

describe("handoffDispositionsFromProjection", () => {
  const renamedFile: PatchFile = {
    path: "src/current.ts",
    previousPath: "src/previous.ts",
    status: "renamed",
    additions: 1,
    deletions: 1,
    binary: false,
    patch: "@@ -8,3 +8,3 @@\n-old\n+new",
  };
  const activePatchset: Patchset = {
    id: "patchset-active",
    createdAt: "2026-08-29T00:00:00.000Z",
    repository: {
      id: "repo",
      root: "/repo",
      commonDir: "/repo/.git",
      baseRef: "origin/main",
      baseOid: "base",
      headOid: "head",
    },
    files: [renamedFile],
    rawDiff: renamedFile.patch,
    byteLength: renamedFile.patch.length,
    truncated: false,
  };

  it("carries durable finding identity and orders same-line asks by ask id", () => {
    const finding = {
      generation: "generation-2",
      boardId: "board:flagged:generation-2",
      findingId: "finding-7",
    };
    const projection: AskProjection = {
      stagedAsks: {
        late: {
          id: "ask-z",
          anchor: "src/auth.ts:12",
          type: "comment",
          body: "second",
          finding,
        },
        early: {
          id: "ask-a",
          anchor: "src/auth.ts:12",
          type: "comment",
          body: "first",
        },
      },
      findingDispositions: {},
      lineComments: {},
      quoteThreads: {},
      retired: {},
      verdictOverride: null,
    };

    expect(handoffDispositionsFromProjection(projection, activePatchset)).toEqual([
      {
        id: "ask-a",
        path: "src/auth.ts",
        type: "comment",
        body: "first",
        span: { startLine: 12 },
        side: "additions",
      },
      {
        id: "ask-z",
        path: "src/auth.ts",
        type: "comment",
        body: "second",
        span: { startLine: 12 },
        side: "additions",
        finding,
      },
    ]);
  });

  it("uses the matching frozen CodeRef, maps a renamed base path, and preserves its full span", () => {
    const projection: AskProjection = {
      stagedAsks: {
        finding: {
          id: "finding",
          anchor: "src/previous.ts:999",
          type: "request-change",
          body: "preserve the old-side contract",
          side: "RIGHT",
          codeRef: {
            patchsetId: activePatchset.id,
            path: "src/previous.ts",
            side: "base",
            startLine: 8,
            endLine: 10,
          },
        },
      },
      findingDispositions: {},
      lineComments: {},
      quoteThreads: {},
      retired: {},
      verdictOverride: null,
    };

    expect(handoffDispositionsFromProjection(projection, activePatchset)).toEqual([
      {
        id: "finding",
        path: "src/current.ts",
        type: "request-change",
        body: "preserve the old-side contract",
        span: { startLine: 8, endLine: 10 },
        side: "deletions",
      },
    ]);
  });

  it("does not reinterpret a frozen CodeRef from another patchset through its legacy anchor", () => {
    const projection: AskProjection = {
      stagedAsks: {
        stale: {
          id: "stale",
          anchor: "src/current.ts:999",
          type: "request-change",
          body: "revisit this concern",
          side: "RIGHT",
          codeRef: {
            patchsetId: "patchset-frozen",
            path: "src/previous.ts",
            side: "base",
            startLine: 8,
            endLine: 10,
          },
        },
      },
      findingDispositions: {},
      lineComments: {},
      quoteThreads: {},
      retired: {},
      verdictOverride: null,
    };

    const dispositions = handoffDispositionsFromProjection(projection, activePatchset);
    expect(dispositions).toEqual([
      {
        id: "stale",
        path: "src/previous.ts",
        type: "request-change",
        body: "revisit this concern",
      },
    ]);
    expect(
      buildHandoffBundle({ reviewId: "review", patchset: activePatchset, dispositions }).tasks,
    ).toEqual([
      {
        id: "stale",
        path: "src/previous.ts",
        type: "request-change",
        instruction: "revisit this concern",
        context: "",
      },
    ]);
  });

  it("normalizes a matching renamed-base citation for publication", () => {
    const projection: AskProjection = {
      stagedAsks: {
        finding: {
          id: "finding",
          anchor: "src/previous.ts:999",
          type: "request-change",
          body: "preserve the base-side contract",
          side: "RIGHT",
          codeRef: {
            patchsetId: activePatchset.id,
            path: "src/previous.ts",
            side: "base",
            startLine: 8,
            endLine: 10,
          },
        },
      },
      findingDispositions: {},
      lineComments: {},
      quoteThreads: {},
      retired: {},
      verdictOverride: null,
    };

    expect(reviewCommentsFromProjection(projection, activePatchset)).toEqual([
      {
        path: "src/current.ts",
        startLine: 8,
        line: 10,
        side: "LEFT",
        type: "request-change",
        body: "preserve the base-side contract",
      },
    ]);
    expect(reviewBodyNotesFromProjection(projection, activePatchset)).toEqual([]);
  });

  it("routes a frozen citation from another patchset into the review body exactly once", () => {
    const projection: AskProjection = {
      stagedAsks: {
        frozen: {
          id: "frozen",
          anchor: "src/current.ts:999",
          type: "request-change",
          body: "revisit this concern",
          codeRef: {
            patchsetId: "patchset-frozen",
            path: "src/previous.ts",
            side: "base",
            startLine: 8,
            endLine: 10,
          },
        },
      },
      findingDispositions: {},
      lineComments: {},
      quoteThreads: {},
      retired: {},
      verdictOverride: null,
    };

    expect(reviewCommentsFromProjection(projection, activePatchset)).toEqual([]);
    expect(reviewBodyNotesFromProjection(projection, activePatchset)).toEqual([
      {
        id: "frozen",
        type: "request-change",
        body: "revisit this concern",
        anchor: "src/current.ts:999",
      },
    ]);
  });

  it("does not anchor a base ref that maps to more than one active file", () => {
    const ambiguousPatchset: Patchset = {
      ...activePatchset,
      files: [
        {
          path: "src/shared.ts",
          status: "modified",
          additions: 1,
          deletions: 1,
          binary: false,
          patch: renamedFile.patch,
        },
        {
          ...renamedFile,
          path: "src/current.ts",
          previousPath: "src/shared.ts",
        },
      ],
    };
    const projection: AskProjection = {
      stagedAsks: {
        ambiguous: {
          id: "ambiguous",
          anchor: "src/current.ts:999",
          type: "request-change",
          body: "resolve this without guessing",
          codeRef: {
            patchsetId: ambiguousPatchset.id,
            path: "src/shared.ts",
            side: "base",
            startLine: 8,
            endLine: 10,
          },
        },
      },
      findingDispositions: {},
      lineComments: {},
      quoteThreads: {},
      retired: {},
      verdictOverride: null,
    };

    expect(handoffDispositionsFromProjection(projection, ambiguousPatchset)).toEqual([
      {
        id: "ambiguous",
        path: "src/shared.ts",
        type: "request-change",
        body: "resolve this without guessing",
      },
    ]);
    expect(reviewCommentsFromProjection(projection, ambiguousPatchset)).toEqual([]);
    expect(reviewBodyNotesFromProjection(projection, ambiguousPatchset)).toHaveLength(1);
  });
});

describe("buildForgeReviewPost (issue #21)", () => {
  const comments: ReviewCommentInput[] = [
    { path: "src/a.ts", line: 5, side: "RIGHT", type: "request-change", body: "rename this" },
    { path: "src/b.ts", line: 9, side: "LEFT", type: "question", body: "why removed?" },
    { path: "README.md", side: "RIGHT", type: "comment", body: "a file-level note" },
  ];
  const reviewArtifact = artifact({ comments });
  const payload = canonicalReviewPayload(reviewArtifact);
  const post = buildForgeReviewPost(reviewArtifact, {
    reviewId: "rev-1",
    target: TARGET,
    payload,
    capabilities: CAPS,
  });

  it("keeps line-anchored comments as threads and folds no-line ones into the body", () => {
    expect(post.threads).toHaveLength(2);
    expect(post.threads.map((thread) => thread.path)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(post.threads[1]?.side).toBe("LEFT");
    // The no-line comment folds into the body as a file-level note.
    expect(post.body).toContain("File-level notes");
    expect(post.body).toContain("README.md");
  });

  it("keeps the complete multi-line span in the exact thread descriptor", () => {
    const rangedArtifact = artifact({
      comments: [
        {
          path: "src/range.ts",
          startLine: 8,
          line: 10,
          side: "RIGHT",
          type: "request-change",
          body: "change the whole branch",
        },
      ],
    });
    const ranged = buildForgeReviewPost(rangedArtifact, {
      reviewId: "rev-range",
      target: TARGET,
      payload: canonicalReviewPayload(rangedArtifact),
      capabilities: CAPS,
    });

    expect(ranged.threads).toEqual([
      {
        path: "src/range.ts",
        startLine: 8,
        line: 10,
        side: "RIGHT",
        body: "**Requested change** — change the whole branch",
      },
    ]);
  });

  it("folds an unsupported range into the body and durable ledger without narrowing it", () => {
    const rangedArtifact = artifact({
      comments: [
        {
          path: "src/range.ts",
          startLine: 8,
          line: 10,
          side: "RIGHT",
          type: "comment",
          body: "read these lines together",
        },
      ],
    });
    const ranged = buildForgeReviewPost(rangedArtifact, {
      reviewId: "rev-range-fold",
      target: TARGET,
      payload: canonicalReviewPayload(rangedArtifact),
      capabilities: { ...CAPS, supportsMultiLineAnchors: false },
    });

    expect(ranged.threads).toEqual([]);
    expect(ranged.body).toContain("`src/range.ts:8–10`");
    expect(ranged.ledger).toEqual([
      {
        kind: "thread-fold",
        path: "src/range.ts",
        detail: "The forge cannot anchor lines 8–10 — folded into the review body.",
      },
    ]);
  });

  it("ledgers every fold — a no-line disposition is surfaced, never silently dropped", () => {
    expect(post.ledger).toEqual([
      expect.objectContaining({ kind: "file-level-fold", path: "README.md" }),
    ]);
  });

  it("folds every line comment into one body note when the forge cannot batch a review", () => {
    const unbatched = buildForgeReviewPost(reviewArtifact, {
      reviewId: "rev-unbatched",
      target: TARGET,
      payload,
      capabilities: { ...CAPS, supportsBatchedReview: false },
    });

    expect(unbatched.threads).toEqual([]);
    expect(unbatched.body).toContain("## Line comments");
    expect(unbatched.body).toContain("`src/a.ts:5`");
    expect(unbatched.body).toContain("`src/b.ts:9`");
    expect(unbatched.ledger.filter((entry) => entry.kind === "thread-fold")).toHaveLength(2);
  });

  it("renders each disposition TYPE into its body independently of the resolved review event", () => {
    expect(post.threads[0]?.body).toContain("Requested change");
    expect(post.threads[1]?.body).toContain("Question");
  });

  it("resolves the verdict: derived from the dispositions, an explicit verdict wins", () => {
    expect(DEFAULT_REVIEW_EVENT).toBe("COMMENT");
    // The describe's comments include a request-change ⇒ the whole review is a change request.
    expect(post.event).toBe("REQUEST_CHANGES");
    // Derivation rules.
    const at = (type: ReviewCommentInput["type"]): ReviewCommentInput[] => [
      { path: "a.ts", line: 1, side: "RIGHT", type, body: "x" },
    ];
    expect(deriveReviewEvent(at("approve"))).toBe("APPROVE");
    expect(deriveReviewEvent(at("comment"))).toBe("COMMENT");
    expect(deriveReviewEvent(at("question"))).toBe("COMMENT");
    // A requested change dominates approvals (deriveReviewEvent needs only the `type`).
    expect(deriveReviewEvent([{ type: "approve" }, { type: "request-change" }])).toBe(
      "REQUEST_CHANGES",
    );
    expect(resolveComposedReviewEvent([])).toBe("APPROVE");
    expect(resolveComposedReviewEvent([], "COMMENT")).toBe("COMMENT");
    // An explicit verdict OVERRIDES the derived one.
    const overridden = buildForgeReviewPost(artifact({ comments: at("comment") }), {
      reviewId: "rev-3",
      target: TARGET,
      payload: "p",
      capabilities: CAPS,
      verdict: "APPROVE",
    });
    expect(overridden.event).toBe("APPROVE");
  });

  it("weaves BODY notes into the review body, ledgers them, and escalates the verdict (finding 2)", () => {
    const withBody = buildForgeReviewPost(
      artifact({
        comments: [
          { path: "src/a.ts", line: 1, side: "RIGHT", type: "comment", body: "a line note" },
        ],
        bodyNotes: [
          {
            id: "ask-boundary",
            anchor: "Architecture · Module boundary",
            type: "request-change",
            body: "restructure the module boundary",
          },
          {
            id: "ask-narrative",
            anchor: "Summary · Narrative",
            type: "comment",
            body: "nice narrative",
          },
        ],
      }),
      {
        reviewId: "rev-body",
        target: TARGET,
        payload: "p",
        capabilities: CAPS,
      },
    );
    // The pathless asks travel in the review body under a "Review notes" heading — not dropped.
    expect(withBody.body).toContain("Review notes");
    expect(withBody.body).toContain("restructure the module boundary");
    expect(withBody.body).toContain("nice narrative");
    // Each body note is ledgered (surfaced, never a silent drop).
    expect(withBody.ledger.filter((d) => d.kind === "body-note")).toHaveLength(2);
    // A prose request-change escalates the whole review to REQUEST_CHANGES, though no line
    // comment did — the verdict follows the WHOLE outbound set (handoff-and-exits.md).
    expect(withBody.event).toBe("REQUEST_CHANGES");
  });

  it("embeds the deterministic idempotency marker in the body", () => {
    expect(post.body).toContain(markerComment(post.marker));
    expect(extractMarker(post.body)).toBe(post.marker);
    // Deterministic in (reviewId, target, event, payload): identical inputs ⇒ identical marker.
    expect(buildReviewMarker("rev-1", TARGET, payload, post.event)).toBe(post.marker);
    // A different payload ⇒ a different marker (a retry after an edit is a new review).
    expect(buildReviewMarker("rev-1", TARGET, `${payload} `, post.event)).not.toBe(post.marker);
    // A verdict-only recompose is a distinct GitHub operation even when every body byte matches.
    expect(buildReviewMarker("rev-1", TARGET, payload, "APPROVE")).not.toBe(post.marker);
  });

  it("reads the final appended marker when authored prose quotes a marker-shaped comment", () => {
    const quoted = "f".repeat(64);
    const quotedArtifact = artifact({
      opener: `The documentation quotes <!-- rennet:review:${quoted} --> as an example.`,
    });
    const quotedPost = buildForgeReviewPost(quotedArtifact, {
      reviewId: "rev-quoted-marker",
      target: TARGET,
      payload: canonicalReviewPayload(quotedArtifact),
      capabilities: CAPS,
    });

    expect(quotedPost.marker).not.toBe(quoted);
    expect(extractMarker(quotedPost.body)).toBe(quotedPost.marker);
  });

  it("uses the exact opener as the first body block and exposes only the signed descriptor", () => {
    const opener = "  I checked the published behavior without rewriting this paragraph.  ";
    const exactArtifact = artifact({ opener, comments });
    const exactPost = buildForgeReviewPost(exactArtifact, {
      reviewId: "rev-opener",
      target: TARGET,
      payload: canonicalReviewPayload(exactArtifact),
      capabilities: CAPS,
    });
    const descriptor = forgeReviewPostDescriptor(exactPost) satisfies ForgeReviewPostDescriptor;

    expect(exactPost.body.startsWith(`${opener}\n\n`)).toBe(true);
    expect(exactPost.body).not.toContain("Rennet review.");
    expect(descriptor).toEqual({
      event: exactPost.event,
      body: exactPost.body,
      threads: exactPost.threads,
    });
    expect(Object.keys(descriptor)).toEqual(["event", "body", "threads"]);
    expect(() =>
      buildForgeReviewPost(artifact({ opener: " \n " }), {
        reviewId: "rev-blank",
        target: TARGET,
        payload: "p",
        capabilities: CAPS,
      }),
    ).toThrow(/opener/i);
  });
});

describe("forgeTargetKey (issue #21)", () => {
  it("pins the head OID AND the forgeRef so a token cannot cross to a different PR", () => {
    expect(forgeTargetKey(TARGET)).toBe(
      "github/rbutera/rennet-egress-sandbox#7@deadbeef0007:PR_kwABC",
    );
    // A moved head yields a different key (a token cannot cross to a different head).
    const moved: ForgeReviewTarget = { ...TARGET, headOid: "feed0008" };
    expect(forgeTargetKey(moved)).not.toBe(forgeTargetKey(TARGET));
    // A different node id yields a different key too, even with identical coordinates
    // and head: the adapter POSTS by forgeRef, so the binding must include it.
    const otherNode: ForgeReviewTarget = { ...TARGET, forgeRef: "PR_kwDIFFERENT" };
    expect(forgeTargetKey(otherNode)).not.toBe(forgeTargetKey(TARGET));
  });
});
