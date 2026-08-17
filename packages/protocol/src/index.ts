import type {
  AnalysisCohort,
  AnalysisElement,
  AnchorSpan,
  Annotation,
  AskAnswer,
  AskReviewResult,
  BlastRadiusPaint,
  Canvas,
  CiFailure,
  CiSignal,
  ComposableAsk,
  ComposedHandoffBundle,
  ComposedTask,
  CompositionFreshness,
  CompositionStaleMember,
  ContextDocumentRecord,
  ContextManifest,
  ContextSendRecord,
  DecisionDetail,
  DecisionEvidence,
  DecisionsRunStatus,
  DecisionWhy,
  DeltaAccount,
  DeltaAskAccount,
  DeltaBeyondHunk,
  DeltaDigestResult,
  Disposition,
  DispositionAnchor,
  DualReviewNote,
  ElementDiff,
  ElementDiffs,
  FindingElement,
  FindingModelAnswer,
  FindingVerification,
  FlaggedReview,
  HandoffBundle,
  HandoffDisclosure,
  HandoffDisposition,
  HandoffRunResult,
  HandoffTask,
  NarrationEvidence,
  NoiseGroup,
  NoiseItem,
  NoiseReview,
  OpenSpecCapabilityNote,
  OpenSpecChange,
  OpenSpecCoverage,
  OpenSpecCoverageEdge,
  OpenSpecDesign,
  OpenSpecListItem,
  OpenSpecProposal,
  OpenSpecScenario,
  OpenSpecSource,
  OpenSpecSpecDelta,
  OpenSpecTasks,
  Patchset,
  PatchsetIntent,
  PatchsetSpecSnapshot,
  PrBodyDraftResult,
  Proposal,
  RefinementResult,
  RenderedHunkOccurrence,
  RepositoryProvenance,
  Review,
  ReviewEngine,
  ReviewHypothesis,
  ReviewNarration,
  RiskCrossCheck,
  SubstrateChunkRef,
  SymbolInspection,
  SymbolNeighbor,
  SymbolNeighbors,
} from "@rennet/types";
import { z } from "zod";

/**
 * Bind a `z.object` to a hand-written type `T` so that OMITTING ANY FIELD OF `T` —
 * an optional field included — is a BUILD ERROR, never a silent IPC strip (#242).
 *
 * The plain `z.ZodType<T>` annotation only catches a missing REQUIRED field (the
 * inferred output stops being assignable to `T`). A missing OPTIONAL field stays
 * assignable, so it slips the annotation, and `parseCommandOutput` then strips it
 * at runtime while every unit test on either side of the boundary stays green —
 * exactly how #179's `verification`, #238's `tier`/`neighbors` and #84's
 * `hunkOccurrences` reached the renderer as `undefined`. This closes the hole
 * structurally: the shape MUST carry a schema for every key of `T`, and each
 * field's schema must produce that field's type, so a forgotten field cannot
 * compile and therefore can never silently strip.
 *
 * Usage: `export const fooSchema = objectSchemaFor<Foo>()({ ...every key of Foo });`
 * Object types only. A union / record / discriminated-union keeps its own
 * `z.ZodType<T>` annotation; the object schemas that are its members use this.
 */
export function objectSchemaFor<T>() {
  // Return the PRECISE `z.ZodObject<S>`, not a `z.ZodType<T>` cast. The coverage
  // constraint on the parameter already guarantees the shape produces `T`, and the
  // precise object type preserves BOTH `z.output` AND `z.input`. A `z.ZodType<T>`
  // cast keeps the output but erases the input to `unknown` — harmless for an
  // output-only schema, but it breaks any command whose INPUT schema uses one
  // (disposition anchors, handoff dispositions), turning `z.input` into `unknown`
  // at the consumer.
  return <S extends { [K in keyof T]-?: z.ZodType<T[K]> }>(shape: S) => z.object(shape);
}

export * from "./bodies";
export * from "./rsp";
export * from "./sha256";

const fileChangeStatusSchema = z.enum(["added", "modified", "deleted", "renamed"]);

const repositoryProvenanceSchema = objectSchemaFor<RepositoryProvenance>()({
  id: z.string().min(1),
  root: z.string().min(1),
  commonDir: z.string().min(1),
  baseRef: z.string().min(1),
  baseOid: z.string().min(1),
  headOid: z.string().min(1),
  // The head's branch ref (#107) — named in the schema so it survives IPC intact
  // rather than being stripped (the type declares it, so the schema must carry it,
  // the #242 discipline). Optional: a detached HEAD has no branch, so the field is
  // absent, but when present it is the ref an own-branch PR `head` opens against.
  headRef: z.string().min(1).optional(),
});

// The change's stated intent (#136), captured with the patchset. It reaches the
// command boundary here so it survives IPC intact rather than being stripped: the
// type declares it, so the schema must carry it (#242).
const patchsetIntentSurfaceSchema = z.enum(["github-pr", "github-rest", "working-tree"]);
const patchsetSpecSnapshotSchema = objectSchemaFor<PatchsetSpecSnapshot>()({
  path: z.string(),
  digest: z.string(),
  content: z.string().optional(),
});
const patchsetIntentSchema = objectSchemaFor<PatchsetIntent>()({
  surface: patchsetIntentSurfaceSchema,
  prTitle: z.string().optional(),
  prBody: z.string().optional(),
  prBodyAbsent: z.boolean().optional(),
  specSnapshots: z.array(patchsetSpecSnapshotSchema).optional(),
  commitSubjects: z.array(z.string()).optional(),
});

export const patchsetSchema = objectSchemaFor<Patchset>()({
  id: z.string().min(1),
  createdAt: z.iso.datetime(),
  repository: repositoryProvenanceSchema,
  files: z.array(
    z.object({
      path: z.string(),
      previousPath: z.string().optional(),
      status: fileChangeStatusSchema,
      additions: z.number().int().nonnegative().nullable(),
      deletions: z.number().int().nonnegative().nullable(),
      binary: z.boolean(),
      patch: z.string(),
    }),
  ),
  rawDiff: z.string(),
  byteLength: z.number().int().nonnegative(),
  truncated: z.boolean(),
  // Provenance of the content, so a GitHub-PR (github-local/github-rest) patchset
  // survives the command round-trip intact — the renderer distinguishes a PR
  // snapshot from a working-tree capture by this, and the degraded badge reads
  // from `degraded`/`degradationReason`. Absent ⇒ `local` (additive; identity
  // ignores it). Without these here, zod strips them and every PR review looks
  // like a local capture.
  source: z.enum(["local", "github-local", "github-rest"]).optional(),
  degraded: z.boolean().optional(),
  degradationReason: z.string().optional(),
  // #144: the ProjectSnapshot the changeset was computed against, and #136: the
  // captured intent. Both optional/additive on the TYPE, so the old
  // `z.ZodType<Patchset>` annotation never noticed the schema omitted them and
  // stripped both at every IPC crossing (a silent #242 strip — the type promised
  // fields that never survived). Declared here so the schema matches the type.
  projectSnapshotId: z.string().optional(),
  intent: patchsetIntentSchema.optional(),
});

export const dispositionTypeSchema = z.enum(["approve", "request-change", "comment", "question"]);

/** A 1-based file-line span (issue #78). Shared by the disposition anchor + command inputs. */
const anchorSpanSchema = objectSchemaFor<AnchorSpan>()({
  startLine: z.number().int().min(1),
  endLine: z.number().int().min(1).optional(),
});
const anchorSideSchema = z.enum(["additions", "deletions", "context"]);

const dispositionAnchorSchema: z.ZodType<DispositionAnchor> = z
  .object({
    path: z.string(),
    contentDigest: z.string().min(1),
    // Optional span anchor (issue #78): a 1-based file-line range on `side`.
    span: z
      .object({
        startLine: z.number().int().min(1),
        endLine: z.number().int().min(1).optional(),
      })
      .optional(),
    side: z.enum(["additions", "deletions", "context"]).optional(),
    spanDigest: z.string().min(1).optional(),
  })
  // span/side/spanDigest are all-or-none: a span anchor needs all three; a
  // path-grained anchor has none. A partial presence is rejected.
  .refine(
    (anchor) =>
      [anchor.span, anchor.side, anchor.spanDigest].filter((field) => field !== undefined).length %
        3 ===
      0,
    { message: "span, side, and spanDigest must all be present (span anchor) or all absent" },
  )
  .refine(
    (anchor) =>
      anchor.span === undefined ||
      anchor.span.endLine === undefined ||
      anchor.span.endLine >= anchor.span.startLine,
    { message: "span.endLine must be >= span.startLine" },
  );

export const dispositionSchema = objectSchemaFor<Disposition>()({
  anchor: dispositionAnchorSchema,
  type: dispositionTypeSchema,
  body: z.string(),
});

// The real forge post-target — the single source of truth reused by BOTH the
// review snapshot (`Review.postTarget`) and the publish commands
// (`publishTargetSchema`), so the coordinates the renderer reads off a review are
// byte-identical to the ones it hands to `publish.requestConsent`/`publish.review`.
const forgeRepoSchema = z.object({
  forge: z.string().min(1),
  owner: z.string().min(1),
  name: z.string().min(1),
});

/** The pinned publish target: which PR, which node id, which reviewed head. */
const forgePublishTargetSchema = z.object({
  repo: forgeRepoSchema,
  number: z.number().int().positive(),
  /** The forge's opaque PR node id (carried, interpreted only in the adapter). */
  forgeRef: z.string().min(1),
  /** The reviewed head commit OID, pinned at review start (GraphQL `commitOID`). */
  headOid: z.string().min(1),
});

// The delta re-review account (issue #73): the deterministic record of what a
// successor patchset did to the staged asks + the paths it changed beyond them. It
// crosses IPC on `Review.deltaAccount`, so it is declared here (an unlisted optional
// on Review would be silently stripped at the boundary — the #242 discipline).
const deltaAskStatusSchema = z.enum(["addressed", "partially-addressed", "untouched"]);
const deltaAskAccountSchema = objectSchemaFor<DeltaAskAccount>()({
  path: z.string().min(1),
  span: anchorSpanSchema.optional(),
  side: anchorSideSchema.optional(),
  type: dispositionTypeSchema,
  summary: z.string(),
  status: deltaAskStatusSchema,
  // Handoff task attribution (issue #73 wave 3). Optional + additive: absent on a
  // regenerate and on every legacy account, so old snapshots parse unchanged.
  handoffTask: z.object({ index: z.number().int().nonnegative(), title: z.string() }).optional(),
});
// Hunk-grain beyond-asks (issue #73 wave 3): one uncovered new hunk, its file line range
// and bucket. `side: "deletions"` on a pure-deletion hunk (range is the old-file image).
const deltaBeyondHunkSchema = objectSchemaFor<DeltaBeyondHunk>()({
  path: z.string().min(1),
  span: anchorSpanSchema,
  side: anchorSideSchema.optional(),
  bucket: z.enum(["unasked-file", "asked-file"]),
  excerpt: z.string(),
});
export const deltaAccountSchema = objectSchemaFor<DeltaAccount>()({
  asks: z.array(deltaAskAccountSchema),
  beyondAsks: z.array(z.string()),
  // Hunk grain (issue #73 wave 3). Optional + additive: ABSENT ⇒ a legacy path-grain
  // account (render path grain only); an EMPTY ARRAY ⇒ computed, nothing beyond.
  beyondAskHunks: z.array(deltaBeyondHunkSchema).optional(),
});

export const reviewSchema = objectSchemaFor<Review>()({
  id: z.string().min(1),
  repositoryRoot: z.string().min(1),
  patchsets: z.array(patchsetSchema).min(1),
  activePatchsetId: z.string().min(1),
  pendingPatchsetId: z.string().optional(),
  dispositions: z.array(dispositionSchema),
  // The orphan tray (issue #16): dispositions whose occurrence VANISHED from the
  // successor patchset, surfaced against their last-known version rather than
  // dropped to void. Optional field crossing IPC — declared by hand (a `z.ZodType`
  // on Review only guards REQUIRED fields; an unlisted optional is silently
  // stripped at the boundary). Absent ⇒ no orphans, so every existing snapshot
  // validates unchanged.
  orphaned: z.array(dispositionSchema).optional(),
  status: z.enum(["current", "invalid"]),
  // A retrospective (read-only, no-post) review. Optional so every existing
  // review snapshot validates unchanged; absent ⇒ a normal postable review.
  retrospective: z.boolean().optional(),
  // The real PR post-target (issue #21). Present ONLY on a non-retrospective PR
  // review; its presence is exactly "this review can post to a real PR". Optional
  // so every existing snapshot (and every local/retrospective review) validates
  // unchanged.
  postTarget: forgePublishTargetSchema.optional(),
  // The delta re-review account (issue #73): stamped on a successor review, absent on
  // a first capture. Optional so every existing snapshot validates unchanged.
  deltaAccount: deltaAccountSchema.optional(),
});

// ── Canvas output schema (issue #54) ─────────────────────────────────────────
// The engine produces canvases from the durable log; this schema validates the
// live canvas set delivered to the renderer over `review.canvases`. It is a full,
// failing-capable schema (not a passthrough) so the IPC output surface has a real
// positive control, mirroring the `Canvas` shape in `@rennet/types`.

const canvasAngleSchema = z.enum(["spec", "sequence", "decisions", "claims", "noise", "flagged"]);

const substrateChunkRefSchema = objectSchemaFor<SubstrateChunkRef>()({
  chunkId: z.string(),
  hunkIds: z.array(z.string()),
  filePaths: z.array(z.string()),
});

// The rich decision detail (issue #137) carried on `kind:"decision"` elements.
// A full, failing-capable schema so the IPC surface preserves (rather than
// silently strips) the evidence chips + reconstructed why the decisions lens
// renders. `reconstructed` is pinned to the literal `true` so a `why` can only
// EXIST as reconstructed — the schema enforces the same guarantee as the type.
const decisionEvidenceSchema = objectSchemaFor<DecisionEvidence>()({
  kind: z.enum(["spec", "pr-body", "hunk"]),
  label: z.string(),
  detail: z.string(),
});
const decisionWhySchema = objectSchemaFor<DecisionWhy>()({
  reconstructed: z.literal(true),
  text: z.string(),
});
const decisionDetailSchema = objectSchemaFor<DecisionDetail>()({
  evidence: z.array(decisionEvidenceSchema),
  why: decisionWhySchema.optional(),
  alternatives: z.array(z.string()),
});

const analysisElementSchema = objectSchemaFor<AnalysisElement>()({
  elementKey: z.string(),
  docId: z.string(),
  anchor: z.string(),
  kind: z.string(),
  title: z.string(),
  // Present only on decision elements (issue #137); optional so every other
  // canvas's elements validate unchanged and the field is preserved when present.
  decision: decisionDetailSchema.optional(),
});

const analysisCohortSchema = objectSchemaFor<AnalysisCohort>()({
  cohortKey: z.string(),
  title: z.string(),
  elementKeys: z.array(z.string()),
});

const annotationSchema = objectSchemaFor<Annotation>()({
  annotationId: z.string(),
  target: z.string(),
  kind: z.enum(["highlight", "callout", "link"]),
  body: z.string(),
  pinned: z.boolean(),
});

const proposalSchema = objectSchemaFor<Proposal>()({
  proposalId: z.string(),
  kind: z.enum(["disposition", "regroup", "split"]),
  target: z.string(),
  payload: z.string(),
  status: z.enum(["pending", "accepted", "dismissed"]),
});

// Optional fields (issue #35) are declared BY HAND — a plain z.object strips any
// unlisted key at the IPC boundary, so a deterministic signal paint would arrive
// with `signal`/`reason`/`assessed` silently gone and the overlay would render
// nothing but the target. `docId` is now optional (deterministic paints omit it).
const blastRadiusPaintSchema = objectSchemaFor<BlastRadiusPaint>()({
  target: z.string(),
  docId: z.string().optional(),
  signal: z
    .enum([
      "deletions",
      "irreversibility",
      "codeowners",
      "safety-net",
      "fan-in",
      "contract-surface",
    ])
    .optional(),
  reason: z.string().optional(),
  assessed: z.boolean().optional(),
});

export const canvasSchema = objectSchemaFor<Canvas>()({
  canvasId: z.string(),
  reviewId: z.string(),
  patchsetId: z.string(),
  angle: canvasAngleSchema,
  layers: z.object({
    substrate: z.object({ chunks: z.array(substrateChunkRefSchema) }),
    analysis: z.object({
      elements: z.array(analysisElementSchema),
      cohorts: z.array(analysisCohortSchema),
      readingOrder: z.array(z.string()),
    }),
    disposition: z.object({ dispositions: z.array(dispositionSchema) }),
    annotation: z.object({
      annotations: z.array(annotationSchema),
      proposals: z.array(proposalSchema),
    }),
  }),
  overlay: z.array(blastRadiusPaintSchema),
});

/** The canvas set the live pipeline produces (`Record<CanvasAngle, Canvas>`). */
const canvasSetSchema = z.object({
  spec: canvasSchema,
  sequence: canvasSchema,
  decisions: canvasSchema,
  claims: canvasSchema,
  noise: canvasSchema,
  // The flagged angle (issue #138) — placed by `projectFlagged`; empty until the
  // finding runner lands, but always present so the set stays exhaustive.
  flagged: canvasSchema,
});

// ── Per-element real diff map (issue #60) ────────────────────────────────────
// Delivered ALONGSIDE the canvas set so the zoom surface renders the real
// captured hunk text instead of the `demoDiff` fixture. Keyed by `elementKey`; a
// doc-anchored element (flat angle, no code diff) simply has no entry. A full,
// failing-capable schema (path + diff both required) so the IPC surface keeps a
// real positive control.
//
// `hunkOccurrences` (issue #84) is REQUIRED, not optional — it is the mark↔row
// mapping, and it MUST survive the IPC boundary or every content row reaches the
// renderer identity-less and no occurrence mark can land. It was silently stripped
// once because the field was absent from this schema; making it required (with `[]`
// for genuinely identity-less patches) means the `z.ZodType<ElementDiffs>` annotation
// below fails to compile if the schema ever omits it again.
const renderedHunkOccurrenceSchema = objectSchemaFor<RenderedHunkOccurrence>()({
  id: z.string(),
  oldStart: z.number(),
  oldLines: z.number(),
  newStart: z.number(),
  newLines: z.number(),
});
const elementDiffSchema = objectSchemaFor<ElementDiff>()({
  path: z.string(),
  paths: z.array(z.string()),
  diff: z.string(),
  hunkOccurrences: z.array(z.array(renderedHunkOccurrenceSchema)),
});
const elementDiffsSchema: z.ZodType<ElementDiffs> = z.record(z.string(), elementDiffSchema);

// ── Roll-up narration placement (issue #70) ──────────────────────────────────
// Delivered ALONGSIDE the canvas set (like `elementDiffs`) so the zoom ladder
// renders the agent's account at each altitude. A discriminated union keeps the
// never-blank contract honest at the IPC boundary: a placement is a narrated
// account or an explicit pending/failed state — there is no shape for "blank".
const narrationEvidenceSchema = objectSchemaFor<NarrationEvidence>()({
  anchor: z.string(),
  quote: z.string(),
});
const narrationPlacementSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("narrated"),
    oneLine: z.string(),
    paragraph: z.string(),
    evidence: z.array(narrationEvidenceSchema).optional(),
  }),
  z.object({ status: z.literal("pending") }),
  z.object({ status: z.literal("failed") }),
]);
const reviewNarrationSchema = objectSchemaFor<ReviewNarration>()({
  rollup: narrationPlacementSchema,
  cohorts: z.record(z.string(), narrationPlacementSchema),
});

// ── The engine provenance (real-AI-default honesty signal) ───────────────────
// Delivered alongside the canvas set so the renderer can tell a real AI review
// from the deterministic mechanical outline (no model installed) and say so
// loudly. Optional on the wire so a desktop build that predates it still
// validates (absence → the UI shows no engine claim, never a false "AI" badge).
const reviewEngineSchema = objectSchemaFor<ReviewEngine>()({
  aiReview: z.boolean(),
  claudeAvailable: z.boolean(),
  codexAvailable: z.boolean(),
});

// ── The Decisions runner's status (issue #137/#160) ──────────────────────────
// Delivered alongside the canvas set so the renderer can paint a runner that
// FAILED distinctly from a review that ran and discerned nothing. This field MUST
// be in the `review.canvases` output schema or the command boundary strips it (the
// output is a strict `z.object`) and "the decisions pass crashed" would silently
// render identical to "found nothing" — the exact false-verdict #160 removes.
const decisionsRunStatusSchema: z.ZodType<DecisionsRunStatus> = z.union([
  z.object({ status: z.literal("ok") }),
  z.object({ status: z.literal("failed"), reason: z.string() }),
]);

// ── ContextManifest (issue #30) ──────────────────────────────────────────────
// The "what was sent" manifest crossing the desktop IPC boundary. An unlisted
// optional field is silently STRIPPED by the strict command output objects, so the
// manifest — and every one of its members — MUST be declared here, or the renderer
// receives a manifest missing exactly the assembly records the panel exists to show.
const compositionStaleMemberSchema: z.ZodType<CompositionStaleMember> = z.object({
  path: z.string(),
  repoRecordId: z.string(),
  reason: z.enum(["absent", "oid-mismatch", "digest-mismatch"]),
  expectedOid: z.string(),
  expectedDigest: z.string().optional(),
  observedOid: z.string().optional(),
  observedDigest: z.string().optional(),
});

const compositionFreshnessSchema: z.ZodType<CompositionFreshness> = z.union([
  z.object({ status: z.literal("current"), staleMembers: z.tuple([]) }),
  z.object({ status: z.literal("stale"), staleMembers: z.array(compositionStaleMemberSchema) }),
]);

const repoMapReferenceSchema = z.object({
  repoRecordId: z.string(),
  pinnedOid: z.string(),
  projectSnapshotId: z.string(),
  contentDigest: z.string(),
});

const repoMapMemberSchema = z.union([
  z.object({ status: z.literal("resolved"), path: z.string(), reference: repoMapReferenceSchema }),
  z.object({
    status: z.literal("absent"),
    path: z.string(),
    repoRecordId: z.string(),
    pinnedOid: z.string(),
  }),
]);

const contextDocumentRecordSchema: z.ZodType<ContextDocumentRecord> = z.object({
  order: z.number().int().nonnegative(),
  source: z.string(),
  sourcePath: z.string(),
  contentHash: z.string(),
  originalBytes: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
  state: z.enum(["included", "truncated", "dropped"]),
});

const contextSendRecordSchema: z.ZodType<ContextSendRecord> = z.object({
  seat: z.string(),
  harness: z.string(),
  channel: z.enum(["prompt", "system-append"]),
  attempt: z.number().int().nonnegative(),
  promptBytes: z.number().int().nonnegative(),
  promptDigest: z.string(),
  contextIncluded: z.boolean(),
  contextDigest: z.string().optional(),
  sentAt: z.string(),
});

const contextManifestSchema: z.ZodType<ContextManifest> = z.object({
  repoRecordId: z.string(),
  projectSnapshotId: z.string(),
  compositionDigest: z.string(),
  freshness: compositionFreshnessSchema,
  members: z.array(repoMapMemberSchema),
  documents: z.array(contextDocumentRecordSchema),
  totalBytes: z.number().int().nonnegative(),
  assembledPromptDigest: z.string(),
  exhaustive: z.boolean(),
  unmanagedSources: z.array(z.string()),
  sends: z.array(contextSendRecordSchema).optional(),
});

const commandIdSchema = z.uuid();

// ── Publish egress schemas (issue #21) ───────────────────────────────────────
// The forge-neutral shapes the renderer sends to MAIN for the outbound GitHub
// review post. The renderer supplies the pinned target, the canonical review
// content, and the canonical payload bytes; MAIN independently re-derives the
// bytes and fails CLOSED on any disagreement (the egress-side "what you see is what
// leaves", R33), then gates the real egress on the effective mode + a single-use,
// target-and-payload-bound consent token before anything leaves the machine.

// `forgeRepoSchema` and the publish target now live above `reviewSchema` (the
// single source of truth `Review.postTarget` also reuses). Alias kept so the
// publish-command definitions below read unchanged.
const publishTargetSchema = forgePublishTargetSchema;

/** The review verdict (the real GitHub review event). */
const forgeReviewEventSchema = z.enum(["APPROVE", "REQUEST_CHANGES", "COMMENT"]);

/** One review comment in the canonical `pr-review` shape (mirrors the ui preview). */
const reviewCommentSchema = z.object({
  path: z.string().min(1),
  /** The file line, when a span anchor is known (#78). Absent ⇒ a file-level note. */
  line: z.number().int().min(1).optional(),
  side: z.enum(["LEFT", "RIGHT"]),
  type: dispositionTypeSchema,
  body: z.string(),
});

const forgeRequestSchema = z.object({
  endpoint: z.string(),
  method: z.string(),
  // The GraphQL `{ query, variables }` document. Opaque here (validated by shape at
  // the adapter): it carries NO secret — the bearer token is a send-time header.
  body: z.unknown(),
});

const publishDegradationSchema = z.object({
  kind: z.literal("file-level-fold"),
  path: z.string(),
  detail: z.string(),
});

const publishOutcomeSchema = z.object({
  reviewRef: z.string(),
  url: z.string().nullable(),
  reused: z.boolean(),
});

/**
 * The own-branch PR submission (#257 / #107) — the title/body/base/head/draft the
 * paper previews and signs. `head` is a BRANCH ref, never a commit SHA: a GitHub PR
 * cannot open with a bare SHA as `head`. Mirrors the ui `PrSubmission`; the bytes
 * `prSubmissionPayload` serialises from it are what MAIN round-trips against `payload`.
 */
const prSubmissionSchema = z.object({
  title: z.string(),
  body: z.string(),
  base: z.string().min(1),
  head: z.string().min(1),
  draft: z.boolean(),
});

// ── The front door: projects + discovery (issue #29 / #37) ───────────────────
// The projects list is the app's entry; a project is a WORKSPACE (a folder of
// repos) or a single PROJECT REPO. These are the only two nouns the user meets;
// everything else is inferred by read-only discovery. The shapes are
// protocol-local: the renderer, the discovery adapter, and the project store all
// speak them, and they cross the command boundary intact.
export const projectKindSchema = z.enum(["workspace", "repo"]);
export type ProjectKind = z.infer<typeof projectKindSchema>;

/** A git repo discovered at (repo kind) or under (workspace kind) the pointed-at path. */
export const discoveredRepoSchema = z.object({
  name: z.string().min(1),
  /** Absolute path to the repo — the reviewable open target. */
  path: z.string().min(1),
  /** Local branch count (`for-each-ref refs/heads`). */
  branches: z.number().int().nonnegative(),
  /** `host/owner/name` parsed from the origin remote, when the repo has a forge remote. */
  remote: z.string().optional(),
  /** A terse, honest note surfaced by discovery (e.g. "docs only"); omitted when clean. */
  note: z.string().optional(),
});
export type DiscoveredRepo = z.infer<typeof discoveredRepoSchema>;

/**
 * The read-only discovery result: what the worktree-config step renders as
 * EDITABLE DEFAULTS, never questions (User Journey stage 1). `repos` are the
 * toggle rows (all on in the UI); `primaryBranch` is confirmed and editable; a
 * walk-vs-list disagreement is SURFACED in `reconciliation` rather than silently
 * resolved.
 */
export const discoveryResultSchema = z.object({
  path: z.string().min(1),
  kind: projectKindSchema,
  repos: z.array(discoveredRepoSchema),
  /** origin/HEAD, else the current branch, else `main`. */
  primaryBranch: z.string().min(1),
  /** A walk-vs-list disagreement, surfaced (not resolved); omitted when the two agree. */
  reconciliation: z.string().optional(),
});
export type DiscoveryResult = z.infer<typeof discoveryResultSchema>;

/** A persisted, listed project — the front door's populated state. */
export const projectSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  path: z.string().min(1),
  kind: projectKindSchema,
  /** The number of included repos (1 for a project repo). */
  repoCount: z.number().int().nonnegative(),
  /** The summed local-branch count across the included repos. */
  branchCount: z.number().int().nonnegative(),
  primaryBranch: z.string().min(1),
  /** The reviewable path a project row opens (the repo, or the first included repo). */
  openPath: z.string().min(1),
  /**
   * The working-tree paths of the repos the user INCLUDED at add time (a workspace
   * can exclude some of its repos). Persisted so live detail honours the selection
   * instead of re-scanning every repo under the workspace. Optional for
   * backward-compatibility: a project stored before this field existed has it
   * absent, and the reader falls back to discovering all repos under the path.
   */
  includedRepoPaths: z.array(z.string().min(1)).optional(),
  addedAt: z.iso.datetime(),
});
export type Project = z.infer<typeof projectSchema>;

/** A harness detected on the machine, for the ambient first-run detection line. */
export const detectedHarnessSchema = z.object({
  id: z.string().min(1),
  version: z.string().nullable(),
});
export type DetectedHarness = z.infer<typeof detectedHarnessSchema>;

// ── Processing a freshly-added project: the initial context dump ─────────────
// After `projects.add` persists a project, Rennet PROCESSES each included repo —
// building the deterministic ProjectSnapshot / repo-map that every later review
// reads. It is the "initial context dump" (Rai's wireframe #2): a delightful
// spinner with LIVE narration that explains what it is doing in real time. The
// narration is wired to the REAL generator stages (below), not scripted text.
//
// Progress is pushed main→renderer over the `onProgress` channel keyed by the
// `commandId`; the `project.process` command resolves with the final per-repo
// summary once every repo has been built (or has failed softly). No gate, no
// model spend: the snapshot build is pure over git.

/**
 * The real stages of a single repo's snapshot build, in order. Each maps 1:1 to
 * a step the {@link https://ProjectSnapshotGenerator} actually performs, so the
 * narration is honest: `resolve` (find the default branch) → `tree` (read the
 * file tree at the base OID) → `workspace` (map scopes/edges/entry points) →
 * `conventions` (learn conventions, ownership, tests) → `symbols` (extract
 * symbols + references from the changed closure) → `build` (assemble the map) →
 * `verify` (integrity check) → `store` (persist as current).
 */
export const snapshotStageSchema = z.enum([
  "resolve",
  "tree",
  "workspace",
  "conventions",
  "symbols",
  "build",
  "verify",
  "store",
]);
export type SnapshotStage = z.infer<typeof snapshotStageSchema>;

/** The outcome of processing one repo — real counts from the built snapshot. */
export const processedRepoSummarySchema = z.object({
  repo: z.string().min(1),
  path: z.string().min(1),
  ok: z.boolean(),
  /** Files in the tree at the base OID (present on success). */
  files: z.number().int().nonnegative().optional(),
  /** Symbol shards in the built snapshot (present on success). */
  symbols: z.number().int().nonnegative().optional(),
  /** Reference shards in the built snapshot (present on success). */
  references: z.number().int().nonnegative().optional(),
  /** Symbol shards reused verbatim from a previous snapshot (incremental builds). */
  reusedSymbols: z.number().int().nonnegative().optional(),
  /** The resolved primary branch the snapshot was taken at (present on success). */
  baseRef: z.string().optional(),
  /** A legible failure message (present on failure); the other repos still process. */
  error: z.string().optional(),
});
export type ProcessedRepoSummary = z.infer<typeof processedRepoSummarySchema>;

/**
 * A typed reference to the project a landed processing line produced (issue #71
 * anchoring). A landed progress event may carry one so the renderer can navigate
 * to it via the existing flow handlers; a line with no ref is honestly inert.
 */
export const progressArtifactRefSchema = z.object({
  kind: z.literal("project"),
  projectId: z.string().min(1),
});
export type ProgressArtifactRef = z.infer<typeof progressArtifactRefSchema>;

/**
 * A single live-narration event pushed while a project processes. `repo-start` and
 * `repo-done` bracket each repo; `stage` fires
 * as the build advances, each carrying a real `note` (and often a real `detail`,
 * e.g. "412 files"); `done` fires once at the end with the full per-repo summary.
 * `repo-error` is a SOFT failure for one repo — processing continues, and `done`
 * still fires.
 */
export const projectProcessEventSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("repo-start"),
    repo: z.string().min(1),
    /** 1-based position in the workspace's included repos. */
    index: z.number().int().positive(),
    total: z.number().int().positive(),
  }),
  z.object({
    kind: z.literal("stage"),
    repo: z.string().min(1),
    stage: snapshotStageSchema,
    /** The friendly, present-tense line ("Reading the file tree"). */
    note: z.string().min(1),
    /** A real, specific detail when known ("412 files", "main"). */
    detail: z.string().optional(),
  }),
  z.object({
    kind: z.literal("repo-done"),
    repo: z.string().min(1),
    summary: processedRepoSummarySchema,
    /** The landed artifact this repo produced, for anchoring (optional). */
    artifact: progressArtifactRefSchema.optional(),
  }),
  z.object({
    kind: z.literal("repo-error"),
    repo: z.string().min(1),
    message: z.string().min(1),
  }),
  z.object({
    kind: z.literal("done"),
    repos: z.array(processedRepoSummarySchema),
  }),
]);
export type ProjectProcessEvent = z.infer<typeof projectProcessEventSchema>;

// ── Project detail: the unified smart list (issue #37) ───────────────────────
// Clicking a project opens ONE scrolling surface: local work AND every pull
// request in a single list, rows visually distinct by state, filterable, HOT-sorted
// (recency of engagement) with a relevance boost that floats a row up when it needs
// the viewer. MAIN supplies the raw substrate — local worktrees/branches, pull
// requests, and the viewer login — and the renderer DERIVES the unified rows from
// it: dedupe (a branch with a PR shows as the PR, the worktree an annotation on it),
// ownership (row appearance + filter, not a hard wall), needs-you, and merged →
// read-only. Live git + GitHub wiring (the home-surface GraphQL query set + the
// REST-conditional polling loop) is a LATER slice; a fixture stands behind this
// typed boundary now so the screen comes alive without an invented integration.

/** Where a local piece of work sits in the local pipeline (captured > reviewed > prd). */
export const smartListStageSchema = z.enum(["captured", "reviewed", "prd"]);
export type SmartListStage = z.infer<typeof smartListStageSchema>;

/** Continuous-integration state for a pull request (honest "none" when unknown). */
export const smartListCiSchema = z.enum(["none", "passing", "failing", "pending"]);
export type SmartListCi = z.infer<typeof smartListCiSchema>;

/** A local worktree/branch detected for the project — private/local (backlight). */
export const localWorkSchema = z.object({
  /** A stable, unique worktree identifier — the clean-up target (unambiguous even
   * across a workspace and across a reused branch name). */
  id: z.string().min(1),
  /**
   * A stable identity for the repository this worktree belongs to. A workspace holds
   * several repos, so a branch NAME is unique only within one repo; dedupe keys on the
   * composite `(repository, branch)`, never the bare branch.
   */
  repository: z.string().min(1),
  /** The branch/worktree name (half of the composite dedupe key). */
  branch: z.string().min(1),
  /** The login that owns this local work — matched against the viewer for ownership. */
  author: z.string().min(1),
  /** Uncommitted changes present in the worktree. */
  dirty: z.boolean(),
  /**
   * Commits ahead of / behind the primary branch. `null` means the comparison could
   * NOT be computed (the base ref is unresolvable in this repo) — distinct from `0`,
   * which is a genuinely even branch. A live source must never collapse an
   * un-computable comparison to `0/0`, or a branch with an unknown base reads as
   * "fully merged, nothing to do" (a lying gauge).
   */
  ahead: z.number().int().nonnegative().nullable(),
  behind: z.number().int().nonnegative().nullable(),
  /** How far along the local pipeline this work sits. */
  stage: smartListStageSchema,
  /** Recency of engagement (ISO), the HOT-sort key. */
  lastActivityAt: z.iso.datetime(),
});
export type LocalWork = z.infer<typeof localWorkSchema>;

/** A pull request on the project — public/what-exists-in-the-world (ink). */
export const pullRequestSchema = z.object({
  id: z.string().min(1),
  number: z.number().int().positive(),
  title: z.string().min(1),
  /**
   * A stable identity for the repository this PR belongs to — the other half of the
   * composite `(repository, branch)` dedupe key. A workspace PR for `repo-a/feat/x`
   * must not match a local worktree `repo-b/feat/x`.
   */
  repository: z.string().min(1),
  /** The PR's head branch (half of the composite dedupe key against a local worktree). */
  branch: z.string().min(1),
  author: z.string().min(1),
  state: z.enum(["open", "merged", "closed"]),
  /** The viewer has been asked to review this PR — the relevance boost's core signal. */
  reviewRequestedFromViewer: z.boolean(),
  ci: smartListCiSchema,
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  changedFiles: z.number().int().nonnegative(),
  lastActivityAt: z.iso.datetime(),
});
export type PullRequest = z.infer<typeof pullRequestSchema>;

/** The signed-in GitHub user, so the renderer can tag ownership (mine vs theirs). */
export const projectViewerSchema = z.object({ login: z.string().min(1) });
export type ProjectViewer = z.infer<typeof projectViewerSchema>;

/** The raw project-detail substrate MAIN delivers; the renderer derives the rows. */
export const projectDetailSchema = z.object({
  viewer: projectViewerSchema,
  locals: z.array(localWorkSchema),
  prs: z.array(pullRequestSchema),
  /**
   * A >1000 upstream truncation, surfaced so a partial surface never renders as
   * complete (the SSO partial-results banner). The fixture sets it false today; the
   * live GraphQL loop sets it from the explicit truncation state later.
   */
  truncated: z.boolean(),
});
export type ProjectDetail = z.infer<typeof projectDetailSchema>;

// ── The Flagged lens: findings + dual-review agreement (issue #138) ───────────
// The automated review layer's output for a review, delivered behind the typed
// command boundary. A fixture stands behind it until the live finding-generation
// runner + aggregation land (they sequence with #32/#41). The renderer folds this
// into the flagged index; `status` keeps "ran clean" honestly apart from "the
// runner did not complete".
export const findingSeveritySchema = z.enum(["high", "medium", "low"]);
export const findingModelAnswerSchema = objectSchemaFor<FindingModelAnswer>()({
  model: z.string().min(1),
  answer: z.string(),
});
export const findingAgreementSchema = z.union([
  z.object({ kind: z.literal("concur"), agree: z.number(), total: z.number() }),
  z.object({ kind: z.literal("disagree"), answers: z.array(findingModelAnswerSchema) }),
]);
/**
 * The reproduce-or-refute verification chip (issue #179). Additive optional on a
 * finding: a `reproduced` chip carries its one-line evidence, an `inconclusive`
 * chip its honest caveat; a `refuted` finding never surfaces (core drops it before
 * the lens). This field MUST be in the schema or the `flagged.review` command
 * boundary strips it (the finding is a strict `z.object`) and the evidence the
 * verification pass computed would silently never reach the row (a delivery gap,
 * Rule 80) — the UI would render every finding as unverified.
 */
export const findingVerificationSchema = objectSchemaFor<FindingVerification>()({
  verdict: z.enum(["reproduced", "refuted", "inconclusive"]),
  evidence: z.string(),
});
export const findingElementSchema = objectSchemaFor<FindingElement>()({
  findingId: z.string().min(1),
  anchor: z.string().min(1),
  summary: z.string(),
  severity: findingSeveritySchema,
  agreement: findingAgreementSchema,
  verification: findingVerificationSchema.optional(),
});
/**
 * The dual-model provenance note (issue #41). Additive optional on the `ok`
 * flagged review: `seats` names the provider labels that ran; `secondSeatUnavailable`
 * is the honest degradation marker. It carries NO merged verdict.
 */
export const dualReviewNoteSchema = objectSchemaFor<DualReviewNote>()({
  seats: z.array(z.string().min(1)),
  secondSeatUnavailable: z.string().optional(),
});
/**
 * The predicted-risk cross-check (issue #181): one hypothesised risk reconciled
 * against the surfaced findings. `open` (no finding addressed it) carries an empty
 * `findingIds`; `confirmed` names the findings that addressed it. Additive optional
 * on the `ok` flagged review — a review formed without a hypothesis omits it. This
 * field MUST be in the schema or the command boundary would strip it before the
 * renderer (the ok branch is a strict `z.object`), so the anti-rubber-stamp payoff
 * would silently never reach the UI (a delivery check, Rule 80).
 */
export const riskCrossCheckSchema = objectSchemaFor<RiskCrossCheck>()({
  riskId: z.string().min(1),
  status: z.enum(["confirmed", "open"]),
  findingIds: z.array(z.string().min(1)),
});
export const ciFailureVerdictSchema = z.enum(["change-caused", "environmental", "unclassified"]);
export const ciFailureSchema = objectSchemaFor<CiFailure>()({
  checkId: z.string().min(1),
  checkName: z.string().min(1),
  verdict: ciFailureVerdictSchema,
  evidence: z.string(),
  implicatedPaths: z.array(z.string().min(1)),
  detailsUrl: z.string().url().optional(),
  classifiedBy: z.enum(["deterministic", "model"]),
  findingId: z.string().min(1).optional(),
});
export const ciSignalSchema: z.ZodType<CiSignal> = z.union([
  z.object({
    status: z.literal("checked"),
    overall: z.enum(["passing", "failing", "pending"]),
    failures: z.array(ciFailureSchema),
    headOid: z.string().min(1),
    incomplete: z.boolean(),
  }),
  z.object({ status: z.literal("no-checks"), headOid: z.string().min(1) }),
  z.object({ status: z.literal("unavailable"), reason: z.string().min(1) }),
]);
/**
 * The committed hypothesis (issue #178): the reviewer's reading frame — the domain,
 * in/out scope, the design we'd have chosen, and the predicted risks (each with the
 * `riskId` the pass minted). It rides the `ok` flagged review additively, ALONGSIDE
 * `crossChecks`, and this pairing is load-bearing: `riskId` is minted per pass with a
 * random id, and the crossChecks reconcile THIS hypothesis's risks against the
 * findings — so the reading frame must be folded from the SAME hypothesis, or every
 * risk would fall back to `open` (a riskId mismatch). Carrying both on one review
 * keeps that pair consistent. Absent ⇒ no hypothesis was produced (the pre-#178
 * shape); the reading frame is simply not shown.
 */
export const reviewHypothesisSchema = objectSchemaFor<ReviewHypothesis>()({
  domain: z.string(),
  scope: z.object({
    inScope: z.array(z.string()),
    outOfScope: z.array(z.string()),
  }),
  designExpectation: z.string(),
  risks: z.array(
    z.object({
      riskId: z.string().min(1),
      statement: z.string(),
      severity: findingSeveritySchema,
      disconfirmer: z.string(),
    }),
  ),
  repoContextPresent: z.boolean(),
});
// Incomplete-ingestion blocker (R18, #309): content the deterministic floor could
// not ingest. Rides FlaggedReview so it reaches the Flagged lens and PublishSheet
// as render-only honest copy. `path` is null for a patchset-wide truncation.
const flaggedBlockingStateSchema = z.object({
  reason: z.enum(["truncated", "binary", "submodule"]),
  path: z.string().nullable(),
  detail: z.string(),
});
export const flaggedReviewSchema: z.ZodType<FlaggedReview> = z.union([
  z.object({
    status: z.literal("ok"),
    findings: z.array(findingElementSchema),
    dual: dualReviewNoteSchema.optional(),
    crossChecks: z.array(riskCrossCheckSchema).optional(),
    // Additive informational CI signal (#182). This MUST be declared on BOTH
    // branches or the strict command boundary silently strips it (Rule 80).
    ciSignal: ciSignalSchema.optional(),
    hypothesis: reviewHypothesisSchema.optional(),
    // The patchset this result was computed against (#160/P0-2), so the renderer can
    // bind it to the canvases it is shown beside and drop a result that regenerate
    // left stale. Additive optional — absent ⇒ unbound (pre-#160 shape).
    patchsetId: z.string().min(1).optional(),
    // Incomplete-ingestion blockers (R18, #309). Declared on BOTH branches or the
    // strict boundary strips it (Rule 80). Additive optional — absent ⇒ pre-#309.
    blockingStates: z.array(flaggedBlockingStateSchema).optional(),
  }),
  z.object({
    status: z.literal("failed"),
    reason: z.string(),
    // CI facts survive even when the model review fails; omission strips them.
    ciSignal: ciSignalSchema.optional(),
    patchsetId: z.string().min(1).optional(),
    blockingStates: z.array(flaggedBlockingStateSchema).optional(),
  }),
]);

// ── review.ask: ask the AI a question, one model or both (issue #139) ─────────
// The wire shape of a review question's routing + result. `mode` defaults to
// "orchestrator" so an omitted mode NEVER fires a second model. The result can
// carry at most `primary` (always the orchestrator) + `secondOpinion` (Codex, only
// in "both" mode) — there is no field for a merged answer, so "no synthesis, ever"
// is enforced by the schema itself, not only by the router.
export const askModeSchema = z.enum(["orchestrator", "both"]);
export const askAnswerSchema = objectSchemaFor<AskAnswer>()({
  model: z.string().min(1),
  answer: z.string(),
});
export const askReviewResultSchema = objectSchemaFor<AskReviewResult>()({
  mode: askModeSchema,
  primary: askAnswerSchema,
  secondOpinion: askAnswerSchema.optional(),
});

// ── #251 conversation durability: token streaming + persistence + re-attach ───
// The final answer still returns from `invoke("review.ask")` (back-compat); these
// add the token STREAM alongside it, and the persisted-thread shapes a re-attach
// reloads. All fields optional on review.ask stay back-compatible with a #139 ask.

/** The channel a streamed answer arrives on — the orchestrator, or Codex's second opinion. */
export const streamChannelSchema = z.enum(["orchestrator", "codex"]);
export type StreamChannel = z.infer<typeof streamChannelSchema>;

/** A harness turn's lifecycle. ABSENT on a message = `complete` (back-compat). */
export const turnStatusSchema = z.enum(["streaming", "complete", "interrupted"]);
export type TurnStatus = z.infer<typeof turnStatusSchema>;

// Token-stream events, pushed main→renderer and keyed by `reviewId` (NOT commandId):
// a conversation stream must survive a renderer reload — Cmd-R keeps the turn running
// in main — whereas project.process's narration dies with its command. The kind
// literals are `ask-*`, DELIBERATELY disjoint from projectProcessEvent's own "done",
// so the two event families can never collide on a shared discriminator.
export const reviewAskStreamEventSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("ask-focus"),
    anchor: z.string().min(1),
    threadId: z.string().min(1).optional(),
    turnId: z.string().min(1).optional(),
  }),
  z.object({
    kind: z.literal("ask-delta"),
    threadId: z.string().min(1),
    turnId: z.string().min(1),
    channel: streamChannelSchema,
    delta: z.string(),
  }),
  z.object({
    kind: z.literal("ask-complete"),
    threadId: z.string().min(1),
    turnId: z.string().min(1),
    channel: streamChannelSchema,
    model: z.string().min(1),
    finalBody: z.string(),
  }),
  z.object({
    kind: z.literal("ask-interrupted"),
    threadId: z.string().min(1),
    turnId: z.string().min(1),
    channel: streamChannelSchema,
    reason: z.string().optional(),
  }),
]);
export type ReviewAskStreamEvent = z.infer<typeof reviewAskStreamEventSchema>;

/** The IPC representation of a conversation anchor. The UI `ConversationAnchor` lives in
 *  `@rennet/ui`, which protocol cannot import; the renderer maps to and from this shape. */
export const conversationAnchorSchema = z.object({
  kind: z.enum(["line", "range", "chunk", "fragment"]),
  label: z.string().min(1),
  key: z.string().min(1),
  side: anchorSideSchema.optional(),
  context: z.string().optional(),
  // The file this anchor hangs on (#251 slice 3), for orphan resolution on re-attach.
  // Absent for a conversation fragment (anchors to a message, not code).
  path: z.string().optional(),
});
export type ConversationAnchorWire = z.infer<typeof conversationAnchorSchema>;

/** A persisted thread message crossing IPC on re-attach. `status` absent = complete. */
export const persistedThreadMessageSchema = z.object({
  id: z.string().min(1),
  author: z.enum(["you", "harness"]),
  model: z.string().min(1).optional(),
  body: z.string(),
  status: turnStatusSchema.optional(),
});
export type PersistedThreadMessageWire = z.infer<typeof persistedThreadMessageSchema>;

// A persisted thread as it returns on re-attach: identity + content + the harness
// version that produced it. There is NO orphan flag here — orphan placement is resolved
// RENDERER-side against the current diff (main persists identity; the renderer, the only
// place holding both the thread and the live diff, decides placement and never re-anchors).
export const persistedThreadSchema = z.object({
  threadId: z.string().min(1),
  anchor: conversationAnchorSchema,
  harnessVersionAtCreation: z.string().optional(),
  messages: z.array(persistedThreadMessageSchema),
});
export type PersistedThreadWire = z.infer<typeof persistedThreadSchema>;

// An in-flight turn reported by re-attach (the main-alive live case): the renderer
// resumes this coalesced body and re-subscribes for the remaining deltas.
export const inFlightTurnSchema = z.object({
  threadId: z.string().min(1),
  turnId: z.string().min(1),
  channel: streamChannelSchema,
  model: z.string().min(1),
  bodySoFar: z.string(),
});
export type InFlightTurn = z.infer<typeof inFlightTurnSchema>;

export const reattachResultSchema = z.object({
  threads: z.array(persistedThreadSchema),
  inFlight: z.array(inFlightTurnSchema),
});
export type ReattachResult = z.infer<typeof reattachResultSchema>;

// ── review.refine: the comment-refinement loop's result (issue #19) ───────────
// A rough review note refined into a clean comment by a real model turn. The
// producer guarantees `refined` carries a non-empty body that is NOT byte-
// identical to the raw (a byte-identical "improvement" is `no-change`); an empty
// or absent turn maps to `failed`/`unavailable`. The shape has NO field for the
// raw dressed as refined, so "a failed refine never posts as refined" holds by
// construction: the renderer keeps showing the raw until a `refined` result lands
// and the user keeps it.
export const refinementResultSchema: z.ZodType<RefinementResult> = z.discriminatedUnion("status", [
  z.object({ status: z.literal("refined"), refined: z.string().min(1), model: z.string().min(1) }),
  z.object({ status: z.literal("no-change"), model: z.string().min(1) }),
  z.object({ status: z.literal("unavailable"), reason: z.string() }),
  z.object({ status: z.literal("failed"), reason: z.string() }),
]);

// ── review.draftPrBody: the PR title/body drafting result (issue #74, M26) ────
// A light-tier model turn drafts a PR title + body from the reviewed changeset so
// the own-branch submission preview (#22) opens with an honest account rather than
// a bare diffstat. The producer guarantees `drafted` carries a non-empty title AND
// body (an empty either way is `failed`); the shape has NO field for a fabricated
// draft, so a failed turn keeps the deterministic composed body — never a blank the
// human might sign unread. The draft is human-editable and posts NOTHING (R33).
export const prBodyDraftResultSchema: z.ZodType<PrBodyDraftResult> = z.discriminatedUnion(
  "status",
  [
    z.object({
      status: z.literal("drafted"),
      title: z.string().min(1),
      body: z.string().min(1),
      model: z.string().min(1),
    }),
    z.object({ status: z.literal("unavailable"), reason: z.string() }),
    z.object({ status: z.literal("failed"), reason: z.string() }),
  ],
);

// ── review.deltaDigest: the light-tier prose over the delta account (#73/M25) ──
// A light-tier model turn rephrases the DETERMINISTIC delta account (per-ask
// addressed/partially/untouched + beyond-asks) into a one/two-sentence TL;DR shown
// ON TOP of the facts. The producer guarantees `drafted` carries non-empty text (an
// empty turn is `failed`); the shape has NO field for a fabricated digest, so on
// anything but `drafted` the panel shows no headline and the facts are unchanged.
// The digest posts NOTHING and gates nothing.
export const deltaDigestResultSchema: z.ZodType<DeltaDigestResult> = z.discriminatedUnion(
  "status",
  [
    z.object({ status: z.literal("drafted"), text: z.string().min(1), model: z.string().min(1) }),
    z.object({ status: z.literal("unavailable"), reason: z.string() }),
    z.object({ status: z.literal("failed"), reason: z.string() }),
  ],
);

// ── The Noise lens: grouped low-signal churn (issue #34) ──────────────────────
// The low-signal churn a changeset touches, grouped away from the code that needs
// eyes and tagged with how each group was judged (a deterministic mechanical RULE
// vs the LLM NOISE JOB), delivered behind the typed command boundary. A fixture
// stands behind it until the live noise-classification runner lands. The renderer
// folds this into the noise index; `status` keeps "ran clean" honestly apart from
// "the runner did not complete".
export const noiseCategorySchema = z.enum([
  "formatting",
  "lockfile",
  "import-order",
  "generated",
  "fixture-rename",
  "comment-typo",
  "other",
]);
export const noiseJudgedBySchema = z.union([
  z.object({ kind: z.literal("rule"), rule: z.string().min(1) }),
  z.object({ kind: z.literal("noise-job"), model: z.string().min(1) }),
]);
export const noiseItemSchema = objectSchemaFor<NoiseItem>()({
  anchor: z.string().min(1),
  detail: z.string(),
  deviates: z.boolean().optional(),
});
export const noiseGroupSchema = objectSchemaFor<NoiseGroup>()({
  groupId: z.string().min(1),
  category: noiseCategorySchema,
  summary: z.string(),
  judgedBy: noiseJudgedBySchema,
  items: z.array(noiseItemSchema),
});
export const noiseReviewSchema: z.ZodType<NoiseReview> = z.union([
  z.object({ status: z.literal("ok"), groups: z.array(noiseGroupSchema) }),
  z.object({ status: z.literal("failed"), reason: z.string() }),
]);

// ── review.symbolLookup: the in-app symbol inspector's answer (Rai, wireframes #8)
// The wire shape the inspector renders: definition sites (go-to-definition) +
// reference sites (find-references) from Rennet's OWN model-free symbolic surface.
// Each section is gated so a snapshot that could not answer rides back as
// `unavailable` — never conflated with an empty `ok` ("nothing found"). NO model
// spend: this is deterministic index reads, not an LLM guess.
const symbolDefinitionRowSchema = z.object({
  path: z.string().min(1),
  line: z.number().int().positive(),
  kind: z.string().min(1),
  scope: z.string().nullable(),
});
const symbolReferenceRowSchema = z.object({
  path: z.string().min(1),
  line: z.number().int().positive(),
  scope: z.string().nullable(),
});
// The honest confidence tier (#11), a discriminated union so `exact` can only ever
// ride with `structural` — a textual result cannot carry `exact` across the wire.
// This MUST cross the boundary: without it the live tier chip never renders (the
// object schema below would otherwise strip the unknown `tier` key).
const symbolTierSchema = z.union([
  z.object({ kind: z.literal("exact"), method: z.literal("structural") }),
  z.object({
    kind: z.literal("guess"),
    method: z.literal("structural"),
    candidates: z.number().int().positive(),
  }),
  z.object({ kind: z.literal("guess"), method: z.literal("textual") }),
]);
function symbolSectionSchema<T extends z.ZodTypeAny>(row: T) {
  return z.union([
    z.object({
      status: z.literal("ok"),
      sites: z.array(row),
      truncated: z.boolean().optional(),
      tier: symbolTierSchema.optional(),
    }),
    z.object({ status: z.literal("unavailable"), reason: z.string() }),
  ]);
}
// The definition file's sibling symbols (#11), the pinned mini-browser's clickable
// rungs — likewise must survive the boundary or in-app navigation never exists.
const symbolNeighborSchema = objectSchemaFor<SymbolNeighbor>()({
  name: z.string().min(1),
  kind: z.string().min(1),
  line: z.number().int().positive(),
});
const symbolNeighborsSchema = objectSchemaFor<SymbolNeighbors>()({
  path: z.string().min(1),
  symbols: z.array(symbolNeighborSchema),
});
export const symbolInspectionSchema = objectSchemaFor<SymbolInspection>()({
  name: z.string().min(1),
  definition: symbolSectionSchema(symbolDefinitionRowSchema),
  references: symbolSectionSchema(symbolReferenceRowSchema),
  neighbors: symbolNeighborsSchema.optional(),
});

// ── The Spec angle's OpenSpec change (wireframes #9) ─────────────────────────
// The structured model the parser emits, validated at the IPC boundary so the
// live parse-on-open crosses to the renderer as the exact `OpenSpecChange` shape.
// Every node's `source` (artifact + line) rides across — that is what makes a
// Spec-view disposition durable against the real artifact file.
const openSpecSourceSchema = objectSchemaFor<OpenSpecSource>()({
  artifact: z.enum(["proposal", "design", "tasks", "spec"]),
  capability: z.string().optional(),
  line: z.number(),
});
const openSpecListItemSchema = objectSchemaFor<OpenSpecListItem>()({
  lead: z.string().optional(),
  text: z.string(),
  source: openSpecSourceSchema.optional(),
});
const openSpecBlockSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("paragraph"),
    text: z.string(),
    source: openSpecSourceSchema.optional(),
  }),
  z.object({
    kind: z.literal("list"),
    ordered: z.boolean(),
    items: z.array(openSpecListItemSchema),
    source: openSpecSourceSchema.optional(),
  }),
  z.object({
    kind: z.literal("code"),
    language: z.string(),
    code: z.string(),
    source: openSpecSourceSchema.optional(),
  }),
  z.object({
    kind: z.literal("table"),
    headers: z.array(z.string()),
    rows: z.array(z.array(z.string())),
    source: openSpecSourceSchema.optional(),
  }),
]);
const openSpecCapabilityNoteSchema = objectSchemaFor<OpenSpecCapabilityNote>()({
  name: z.string(),
  summary: z.string(),
  source: openSpecSourceSchema.optional(),
});
const openSpecProposalSchema = objectSchemaFor<OpenSpecProposal>()({
  why: z.array(openSpecBlockSchema),
  whatChanges: z.array(openSpecListItemSchema),
  newCapabilities: z.array(openSpecCapabilityNoteSchema),
  modifiedCapabilities: z.array(openSpecCapabilityNoteSchema),
  impact: z.array(z.object({ area: z.string(), detail: z.string() })),
});
const openSpecDesignSchema = objectSchemaFor<OpenSpecDesign>()({
  sections: z.array(
    z.object({
      id: z.string(),
      level: z.union([z.literal(2), z.literal(3)]),
      heading: z.string(),
      blocks: z.array(openSpecBlockSchema),
      source: openSpecSourceSchema.optional(),
    }),
  ),
});
const openSpecTasksSchema = objectSchemaFor<OpenSpecTasks>()({
  groups: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      items: z.array(
        z.object({
          text: z.string(),
          status: z.enum(["todo", "done"]),
          source: openSpecSourceSchema.optional(),
        }),
      ),
      total: z.number(),
      done: z.number(),
      source: openSpecSourceSchema.optional(),
    }),
  ),
  total: z.number(),
  done: z.number(),
});
const openSpecScenarioSchema = objectSchemaFor<OpenSpecScenario>()({
  name: z.string(),
  steps: z.array(z.object({ keyword: z.enum(["given", "when", "then", "and"]), text: z.string() })),
  source: openSpecSourceSchema.optional(),
});
const openSpecSpecDeltaSchema = objectSchemaFor<OpenSpecSpecDelta>()({
  capability: z.string(),
  groups: z.array(
    z.object({
      operation: z.enum(["added", "modified", "removed", "renamed"]),
      requirements: z.array(
        z.object({
          name: z.string(),
          statement: z.string(),
          scenarios: z.array(openSpecScenarioSchema),
          source: openSpecSourceSchema.optional(),
        }),
      ),
    }),
  ),
  source: openSpecSourceSchema.optional(),
});
export const openSpecChangeSchema = objectSchemaFor<OpenSpecChange>()({
  name: z.string(),
  proposal: openSpecProposalSchema.optional(),
  design: openSpecDesignSchema.optional(),
  tasks: openSpecTasksSchema.optional(),
  specDeltas: z.array(openSpecSpecDeltaSchema),
});

// ── The Spec view's requirement→hunk coverage (wireframes #9 / R53) ────────────
const openSpecCoverageEdgeSchema = objectSchemaFor<OpenSpecCoverageEdge>()({
  capability: z.string(),
  requirement: z.string(),
  hunks: z.array(z.string()),
  tests: z.number(),
});

export const openSpecCoverageSchema = objectSchemaFor<OpenSpecCoverage>()({
  status: z.enum(["ok", "failed"]),
  edges: z.array(openSpecCoverageEdgeSchema),
});

// ── Settings: the config ladder (wireframe #15, Settings and Setup Plan) ──────
// The settings surface edits a small, HONEST slice of the ladder the plan
// describes: what actually exists as consumed config today. Two axes the plan
// names — SCOPE (which layer a value applies to) and PROVENANCE (which layer it
// resolved from) — are preserved as first-class shapes here, so the surface can
// grow into the full ladder without re-keying. What ships:
//   • global scope: `appearance.scheme` — a personal, app-side preference the
//     renderer consumes as `data-scheme`. Side-effect-free, never a repo write.
//   • repo scope: `visibility` — per project, genuinely consumed by the map
//     visibility switch (writes the repo's Rennet-owned `.rennet/.gitignore`).
//   • repo scope: `promoted` — read-through (the real promotion state), shown with
//     provenance; changing it is the separate explicit promote act, not a toggle.
//   • per-repo guidance — the `.rennet/conventions.json` catalogue the review
//     runners read before every review, shown read-through (the wireframe panel).
// Deliberately NOT invented: execution-mode default, worktree location, and
// harness-selection preferences — none exist as stored/consumed config yet.

/** The appearance scheme: an explicit choice, or `system` (follow the OS). */
export const appearanceSchemeSchema = z.enum(["dark", "light", "system"]);
export type AppearanceScheme = z.infer<typeof appearanceSchemeSchema>;

/** How visible a project's derived map is to git (mirrors the adapter's union). */
export const projectVisibilitySchema = z.enum(["local", "git-visible"]);
export type ProjectVisibility = z.infer<typeof projectVisibilitySchema>;

/**
 * A project's execution locus on the wire (add-windows-support): the host OS, or a
 * named WSL distro. Structurally identical to the `Locus` type in `@rennet/types`
 * that the execution seam uses; kept as a schema here because `protocol` may not
 * import `core`.
 */
export const locusSchema = z.union([
  z.object({ kind: z.literal("host") }),
  z.object({ kind: z.literal("wsl"), distro: z.string().min(1) }),
]);
export type Locus = z.infer<typeof locusSchema>;

/**
 * The global (layer 1) config document, stored at `~/.rennet/config.json`. Every
 * field beyond `version` is optional so an untouched install is a trivially-valid
 * (or absent) `{ version }`; defaults are read-through, never migrated in.
 */
export const globalConfigSchema = z.object({
  version: z.number().int().nonnegative(),
  appearance: z.object({ scheme: appearanceSchemeSchema.optional() }).optional(),
  /**
   * User keybinding overrides for the command registry (#44), command id → chord
   * token (`mod+e`, `j`) or `null` for an explicit unbind; an absent id keeps the
   * command's catalogue default. Additive-optional: an untouched install stores
   * nothing, an old config parses unchanged, and a set override survives restart.
   * When the settings ladder lands it registers a `keybindings` global-layer key over
   * this same field with no migration.
   */
  keybindings: z.record(z.string(), z.string().nullable()).optional(),
});
export type GlobalConfig = z.infer<typeof globalConfigSchema>;

/**
 * Which ladder layer a resolved value came from. Precedence (lowest→highest):
 * `builtin` < `detected` < `global` < `repo`. `detected` is the environment-derived
 * rung (today: execution-locus auto-detection) — a machine guess any explicit user
 * choice beats. The single source of precedence is `LAYER_ORDER` in `@rennet/core`;
 * this enum only names the members, it does not order them.
 */
export const settingsLayerSchema = z.enum(["builtin", "detected", "global", "repo"]);
export type SettingsLayer = z.infer<typeof settingsLayerSchema>;

/**
 * A resolved setting carries WHERE it came from, not just the value — provenance
 * is the return type, not a feature (Settings and Setup Plan §1.4). `contributions`
 * lists every layer that offered a value, lowest-first, flagging the effective one.
 */
export const resolvedProvenanceSchema = z.object({
  layer: settingsLayerSchema,
  contributions: z.array(
    z.object({ layer: settingsLayerSchema, value: z.string(), effective: z.boolean() }),
  ),
});
export type ResolvedProvenance = z.infer<typeof resolvedProvenanceSchema>;

/**
 * One repo row on the settings ladder — its real, resolved repo-scope config. A
 * single-repo project contributes ONE row; a workspace contributes one row PER
 * included repo (each keyed by its own git top level), so a workspace's other
 * repos are reachable, not collapsed onto the first. `repoPath` is the canonical
 * git top-level path that addresses the row for reads and writes.
 */
export const settingsProjectSchema = z
  .object({
    projectId: z.string().min(1),
    name: z.string().min(1),
    /** The canonical git top-level path of THIS repo — the row's stable address. */
    repoPath: z.string().min(1),
    /** The resolved effective visibility, with the layer it came from. */
    visibility: projectVisibilitySchema,
    visibilityProvenance: resolvedProvenanceSchema,
    /** The resolved effective promotion state, with the layer it came from. */
    promoted: z.boolean(),
    promotedProvenance: resolvedProvenanceSchema,
    /**
     * The project's effective execution locus (add-windows-support): the persisted
     * override if set, else auto-detected from `repoPath` (a `\\wsl$` root ⇒ that
     * distro, else host). `locusOverridden` is true when it came from the config,
     * false when auto-detected — so the UI can show detected-vs-chosen.
     */
    locus: locusSchema,
    locusOverridden: z.boolean(),
    /**
     * The resolver's own provenance for the locus — the `detected < repo` ladder
     * (`detected` when auto-detected, `repo` when a persisted override wins, always
     * listing the suppressed detected offer as a non-effective contribution). Computed
     * fresh per read, never persisted; `locusOverridden` is derived (`layer === "repo"`).
     */
    locusProvenance: resolvedProvenanceSchema.optional(),
    /**
     * The repo's `config.json` exists but is malformed (or carries an invalid
     * value). The row then shows builtin defaults and REFUSES edits, so a write can
     * never overwrite bytes we could not parse (Rule 75). Absent config ⇒ `false`.
     */
    configMalformed: z.boolean(),
  })
  .transform((project) => {
    const layer = project.locusOverridden ? ("repo" as const) : ("detected" as const);
    const value = project.locus.kind === "host" ? "host" : `WSL · ${project.locus.distro}`;
    return {
      ...project,
      locusProvenance: project.locusProvenance ?? {
        layer,
        contributions: [{ layer, value, effective: true }],
      },
    };
  });
export type SettingsProject = z.infer<typeof settingsProjectSchema>;

/** The whole settings view: the global layer plus every repo's repo layer. */
export const settingsViewSchema = z.object({
  /** The resolved effective scheme (builtin `system`, overridden by global). */
  scheme: appearanceSchemeSchema,
  schemeProvenance: resolvedProvenanceSchema,
  /**
   * The global `~/.rennet/config.json` exists but is malformed. Appearance then
   * shows the builtin default and the control REFUSES to write, so an edit can
   * never overwrite unparseable bytes (Rule 75).
   */
  appearanceMalformed: z.boolean(),
  projects: z.array(settingsProjectSchema),
  /**
   * The stored keybinding-override map (#44), verbatim from the global config —
   * command id → chord token or `null` (explicit unbind). Additive: an untouched
   * install omits it, old `settings.get` callers ignore it. The renderer overlays
   * these on the catalogue defaults for dispatch, display, and conflict detection.
   */
  keybindings: z.record(z.string(), z.string().nullable()).optional(),
});
export type SettingsView = z.infer<typeof settingsViewSchema>;

/** The outcome of a repo-visibility write — distinguishes a real apply from a no-op. */
export const setRepoVisibilityOutcomeSchema = z.object({
  /**
   * `applied` — the switch ran (`changed`/`gitignorePath` describe the repo write).
   * `unresolved` — the project/checkout could not be resolved; NOTHING was written.
   * `malformed` — the repo config is malformed; the edit was REFUSED to protect it.
   */
  status: z.enum(["applied", "unresolved", "malformed"]),
  visibility: projectVisibilitySchema,
  changed: z.boolean(),
  gitignorePath: z.string(),
});
export type SetRepoVisibilityOutcome = z.infer<typeof setRepoVisibilityOutcomeSchema>;

/** The outcome of a repo-locus override write (add-windows-support). */
export const setRepoLocusOutcomeSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("applied"),
    locus: locusSchema,
    locusOverridden: z.boolean(),
    /** The fresh resolver-owned row after the override was written. */
    project: settingsProjectSchema,
  }),
  z.object({
    status: z.literal("unresolved"),
    locus: locusSchema,
    locusOverridden: z.boolean(),
    project: z.null(),
  }),
  z.object({
    status: z.literal("malformed"),
    locus: locusSchema,
    locusOverridden: z.boolean(),
    project: z.null(),
  }),
]);
export type SetRepoLocusOutcome = z.infer<typeof setRepoLocusOutcomeSchema>;

/**
 * The repo-scoped settings keys that can be reset-to-inherit and pinned-at-repo.
 * Only the two editable repo-layer settings with a write path — visibility (the
 * gitignore switch) and locus (the override store). Promotion is read-through here,
 * and appearance is a global-layer key (reset via `setAppearance` with a null scheme).
 */
export const settingsRepoValueKeySchema = z.enum(["visibility", "locus"]);
export type SettingsRepoValueKey = z.infer<typeof settingsRepoValueKeySchema>;

/**
 * The outcome of a Reset (clear the repo-layer entry, fall back down the ladder) or
 * Pin (write the current effective value at the repo layer). `applied` carries the
 * FRESHLY re-resolved row so the surface re-renders the resolver's own answer; a
 * `status` other than `applied` means NOTHING was written (an unresolved checkout or
 * a refused-because-malformed config, Rule 75) and `project` is null.
 */
export const settingsRepoWriteOutcomeSchema = z.object({
  status: z.enum(["applied", "unresolved", "malformed"]),
  key: settingsRepoValueKeySchema,
  project: settingsProjectSchema.nullable(),
});
export type SettingsRepoWriteOutcome = z.infer<typeof settingsRepoWriteOutcomeSchema>;

/** One convention rule shown in the per-repo guidance panel (never model-facing). */
export const settingsConventionRuleSchema = z.object({
  convention: z.string().min(1),
  rationale: z.string().min(1),
  severity: findingSeveritySchema,
  antiPattern: z.string().optional(),
});

/** Why no guidance catalogue was produced, or `null` when one was. */
export const conventionLoadReasonSchema = z.enum([
  "absent",
  "unreadable",
  "empty",
  "no-valid-rules",
]);

/** The per-repo guidance catalogue (`.rennet/conventions.json`) for one project. */
export const settingsGuidanceSchema = z.object({
  rules: z.array(settingsConventionRuleSchema),
  /** The typed reason the catalogue is empty, or `null` when rules are present. */
  reason: conventionLoadReasonSchema.nullable(),
  /** How many rules were dropped as malformed (itemwise honest degradation). */
  dropped: z.number().int().nonnegative(),
});
export type SettingsGuidance = z.infer<typeof settingsGuidanceSchema>;

// ── The review→agent handoff loop schemas (issue #18) ──────────────────────────
// Mirror the `@rennet/types` wire shapes. The OUTPUT schemas are annotated
// `z.ZodType<T>` so a field added to a type that is NOT added here fails the build
// (the IPC-strip guard: an optional field silently dropped at the boundary is the
// recurring #242 defect). The disposition INPUT schema is a plain object so its
// `z.input` type infers concretely (a `z.ZodType<T>` annotation defaults the Input
// param to `unknown`, which would type the command input's `dispositions` as
// `unknown[]`). The bundle's `z.ZodType<HandoffBundle>` annotation still catches a
// task-shape drift through `tasks: z.array(handoffTaskSchema)`.
const handoffDispositionSchema = objectSchemaFor<HandoffDisposition>()({
  path: z.string().min(1),
  type: dispositionTypeSchema,
  body: z.string(),
  span: anchorSpanSchema.optional(),
  side: anchorSideSchema.optional(),
});

const handoffTaskSchema = objectSchemaFor<HandoffTask>()({
  path: z.string().min(1),
  type: dispositionTypeSchema,
  instruction: z.string(),
  span: anchorSpanSchema.optional(),
  side: anchorSideSchema.optional(),
  context: z.string(),
});

const handoffBundleSchema = objectSchemaFor<HandoffBundle>()({
  reviewId: z.string().min(1),
  patchsetId: z.string().min(1),
  tasks: z.array(handoffTaskSchema),
  prompt: z.string(),
  digest: z.string().min(1),
});

const handoffDisclosureSchema = objectSchemaFor<HandoffDisclosure>()({
  harness: z.string().min(1),
  model: z.string().optional(),
  taskCount: z.number().int().nonnegative(),
  writeEnabled: z.literal(true),
  editsWorkingTree: z.literal(true),
  summary: z.string(),
});

const handoffRunResultSchema = objectSchemaFor<HandoffRunResult>()({
  review: reviewSchema,
  turnDiff: z.string(),
  filesTouched: z.array(z.string()),
  carriedForward: z.number().int().nonnegative(),
  orphaned: z.number().int().nonnegative(),
});

/**
 * The `review.handoff.run` outcome. A discriminated union so every non-success is
 * an HONEST, distinct state the renderer can render, never a fabricated result:
 *   • `ran`         — the write turn completed and a new patchset was captured.
 *   • `refused`     — the composed bundle handed to the run did not match its own
 *                     digest/prompt or was composed against a different review/patchset
 *                     than is active now (issue #72). Integrity, not a consent gate: the
 *                     honest outcome is re-compose, never run an order nobody composed.
 *   • `unavailable` — no coding harness is installed to run the write session.
 *   • `failed`      — the write turn ran but did not complete.
 */
const handoffRunOutputSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ran"), result: handoffRunResultSchema }),
  z.object({ status: z.literal("refused"), reason: z.string() }),
  z.object({ status: z.literal("unavailable"), reason: z.string() }),
  // A failed turn carries the files the agent changed BEFORE erroring (Codex F4), so a
  // partial mutation on disk is surfaced to the reviewer rather than hidden.
  z.object({
    status: z.literal("failed"),
    reason: z.string(),
    filesTouched: z.array(z.string()),
  }),
]);
export type HandoffRunOutput = z.infer<typeof handoffRunOutputSchema>;

// ── Handoff-bundle composition schemas (issue #72, M24) ────────────────────────
// The output shapes are annotated `z.ZodType<T>` for the IPC-strip guard; the input
// (`handoffDispositionSchema`, reused from #18) is the plain-object one.
const composableAskSchema = objectSchemaFor<ComposableAsk>()({
  path: z.string().min(1),
  type: dispositionTypeSchema,
  instruction: z.string(),
  span: anchorSpanSchema.optional(),
  side: anchorSideSchema.optional(),
  context: z.string(),
  id: z.string().min(1),
});

const composedTaskSchema = objectSchemaFor<ComposedTask>()({
  title: z.string(),
  sourceDispositions: z.array(z.string()),
  asks: z.array(composableAskSchema),
});

const composedHandoffBundleSchema = objectSchemaFor<ComposedHandoffBundle>()({
  reviewId: z.string().min(1),
  patchsetId: z.string().min(1),
  tasks: z.array(composedTaskSchema),
  prompt: z.string(),
  digest: z.string().min(1),
  composed: z.boolean(),
  traceMap: z.record(z.string(), z.number().int().nonnegative()),
});

export const commandDefinitions = {
  "app.bootstrap": {
    input: z.object({}),
    output: z.object({ review: reviewSchema.nullable(), repositoryPresent: z.boolean() }),
  },
  "repository.choose": {
    input: z.object({}),
    output: z.object({ path: z.string().nullable() }),
  },
  "review.capture": {
    input: z.object({
      commandId: commandIdSchema,
      repoPath: z.string().min(1),
      reviewId: z.string().optional(),
    }),
    output: z.object({ review: reviewSchema }),
  },
  // ── The GitHub PR front door (User Journey stage 2, second v1 source) ───────
  // Point Rennet at a pull request (`owner/repo#123` or a GitHub PR URL) and land
  // in the review surface with the PR's diff loaded. `repoPath` is the local clone
  // the user picked: the diff is taken locally against the PR's pinned OIDs
  // (full-fidelity, force-push-proof). One engine, two sources — this produces the
  // same immutable patchset + review the local capture does.
  "review.openPr": {
    input: z.object({
      commandId: commandIdSchema,
      /** The PR reference: `owner/repo#123` or a `https://github.com/.../pull/N` URL. */
      ref: z.string().min(1),
      /** The local clone of the PR's repository (picked via the directory dialog). */
      repoPath: z.string().min(1),
      /**
       * Open the PR RETROSPECTIVELY (read-only): the review is for READING an
       * already-merged (or any) PR, never for posting back. When true, the created
       * review is flagged `retrospective`, MAIN refuses egress on `publish.review`,
       * and the renderer hides the sign/publish affordance. Omitted/false ⇒ the
       * existing live open-PR review, unchanged. A merged PR works either way — the
       * diff is the git range base..head from history, with no "PR must be open"
       * assumption — but retrospective is the honest mode for one already landed.
       */
      retrospective: z.boolean().optional(),
    }),
    output: z.object({ review: reviewSchema }),
  },
  // ── review.load: reopen any persisted review by id (issue #324) ────────────
  // A PURE READ. Returns the review exactly as folded from its persisted events —
  // no event is appended, and the id need not be the globally-latest review. The
  // one extra fact main provides is `repositoryPresent`: whether the review's
  // recorded repository root still exists on disk, so the renderer can show honest
  // missing-context status and skip the working-tree freshness watcher. The
  // existing freshness/delta machinery decides staleness AFTER the load; nothing
  // here blocks the load (Rule Zero — reading the user's own local state).
  "review.load": {
    input: z.object({
      commandId: commandIdSchema,
      reviewId: z.string().min(1),
    }),
    output: z.object({ review: reviewSchema, repositoryPresent: z.boolean() }),
  },
  "review.setDisposition": {
    input: z.object({
      commandId: commandIdSchema,
      reviewId: z.string().min(1),
      patchsetId: z.string().min(1),
      path: z.string(),
      /** A disposition type sets/replaces the disposition; `null` clears it. */
      disposition: dispositionTypeSchema.nullable(),
      body: z.string(),
    }),
    output: z.object({ review: reviewSchema }),
  },
  "review.checkFreshness": {
    input: z.object({
      commandId: commandIdSchema,
      reviewId: z.string().min(1),
      repoPath: z.string().min(1),
    }),
    output: z.object({ review: reviewSchema }),
  },
  "review.regenerate": {
    input: z.object({
      commandId: commandIdSchema,
      reviewId: z.string().min(1),
      repoPath: z.string().min(1),
    }),
    output: z.object({ review: reviewSchema }),
  },
  // ── Live canvases (issue #54) ──────────────────────────────────────────────
  // Runs the live pipeline (decompose → budget-gated angle → ordering → place)
  // for the review's active patchset and returns the five-angle canvas set the
  // renderer reads. On-demand (opened Canvases view), not on every capture.
  // Running the harness (the model spend) is Rennet's whole job — it just runs;
  // nothing gates or asks permission before the model turn composes.
  "review.canvases": {
    input: z.object({
      commandId: commandIdSchema,
      reviewId: z.string().min(1),
      repoPath: z.string().min(1),
    }),
    // `elementDiffs` (issue #60): the real per-element diff map delivered with the
    // canvas set so zooming into an element shows real code, not the fixture.
    // `narration` (issue #70): the per-altitude narrated accounts, optional so a
    // desktop build that predates narration still validates (absence → the UI
    // shows the honest pending state, never a crash).
    output: z.object({
      canvases: canvasSetSchema,
      elementDiffs: elementDiffsSchema,
      narration: reviewNarrationSchema.optional(),
      // How this set was produced (real-AI-default honesty signal). Optional so a
      // desktop build that predates it still validates; absent ⇒ the UI makes no
      // engine claim (it never shows a false "AI review" badge on an unknown set).
      engine: reviewEngineSchema.optional(),
      // How the Decisions runner ran (issue #137/#160): `ok` vs `failed`. Optional
      // so a caller that does not run decisions omits it; absent ⇒ the UI defaults to
      // `ok` (the pre-#160 shape). Carried so the Decisions failed banner can fire
      // rather than reading a crashed pass as "no decisions".
      decisionsRun: decisionsRunStatusSchema.optional(),
      // `contextManifest` (issue #30): the "what was sent" manifest for this fleet
      // dispatch — the assembled documents in sent order, their hashes/bytes,
      // truncation state, and the assembled-prompt digest. Declared here because a
      // strict output object silently strips any undeclared optional (the exact
      // IPC-field-fidelity failure this field guards against). Optional so a build
      // that predates the wiring still validates; absent ⇒ the panel shows its
      // pending state, never a crash.
      contextManifest: contextManifestSchema.optional(),
    }),
  },
  // ── Publish consent request, main-issued (issue #21) ───────────────────────
  // Posting to GitHub is an EXTERNAL act, so it stays explicitly confirmed (running
  // a model, by contrast, just runs). The renderer REQUESTS approval to POST a
  // review; MAIN is the sole issuer of the authorization, and the token is bound to
  // the exact TARGET (PR + head) AND the exact PAYLOAD bytes.
  // A token minted to post payload P to PR#5@head-A cannot authorise a different
  // payload, a different PR, or a different head. Single-use, consumed at egress.
  "publish.requestConsent": {
    input: z.object({
      commandId: commandIdSchema,
      reviewId: z.string().min(1),
      target: publishTargetSchema,
      /** The canonical payload bytes the token authorises (bound by digest). */
      payload: z.string(),
      /**
       * The resolved review VERDICT/event the token authorises. Bound alongside the
       * payload because it is the one outbound field the payload bytes do not capture
       * (`buildForgeReviewPost` renders the GraphQL post as a pure function of review +
       * target + payload + verdict) — so an APPROVE/REQUEST_CHANGES cannot be swapped in
       * after the human approved a COMMENT. The renderer sends the same value here and
       * at `publish.review`.
       */
      verdict: forgeReviewEventSchema,
    }),
    output: z.object({
      /** The opaque, single-use authorization bound to (review, target, payload, verdict). */
      authorization: z.string().min(1),
    }),
  },
  // ── Publish a review to GitHub (issue #21) — the FIRST real egress ──────────
  // The pipeline NEVER autonomously posts to a real repo: egress exists ONLY behind
  // this command, from the trusted renderer origin, and every real send is gated.
  //   • `dryRun` defaults to TRUE (wrong-side-safe, Rule 75): an omitted flag NEVER
  //     posts. The renderer's real-post path must EXPLICITLY send `dryRun: false`.
  //   • MAIN re-derives the canonical payload from `comments` and refuses on any
  //     disagreement with `payload` (byte-exact), and refuses an ill-formed target —
  //     both on dry-run and real, so the dry-run surfaces integrity faults too.
  //   • A real send ALWAYS requires the single-use token from `publish.requestConsent`,
  //     bound to THIS review, target, and payload; absent / forged / replayed ⇒
  //     refused, nothing leaves. Posting to GitHub is an external act — it stays
  //     explicitly confirmed — unlike running a model, which just runs. Dry-run needs
  //     no token (it posts nothing).
  //   • The review event is always a neutral COMMENT — the outbound request has no
  //     shape for APPROVE (R33/#80).
  "publish.review": {
    input: z.object({
      commandId: commandIdSchema,
      reviewId: z.string().min(1),
      target: publishTargetSchema,
      /** The canonical review content (mirrors the ui `ReviewComment` preview). */
      comments: z.array(reviewCommentSchema),
      /** The canonical payload bytes the sheet previewed + signed (round-trip check). */
      payload: z.string(),
      /**
       * The review verdict. Optional: absent ⇒ derived from the dispositions (any
       * requested change ⇒ REQUEST_CHANGES; else approvals ⇒ APPROVE; else COMMENT).
       * When set, this explicit verdict WINS ("derive first, overridable"). A sign-time
       * verdict picker feeds this; until then it simply stays unset.
       */
      verdict: forgeReviewEventSchema.optional(),
      /** The single-use consent token from `publish.requestConsent` (real send only). */
      authorization: z.string().min(1).optional(),
      /** Default TRUE: an omitted flag never posts. Real egress must opt in with false. */
      dryRun: z.boolean().optional().default(true),
    }),
    output: z.object({
      /** Echoes the resolved dry-run flag (true ⇒ nothing left the machine). */
      dryRun: z.boolean(),
      /** The exact GitHub request that was (dry-run) or would be constructed + sent. */
      request: forgeRequestSchema,
      /** The deterministic idempotency marker embedded in the review body. */
      marker: z.string(),
      /** Every flattening applied, surfaced for the sheet's ledger (never silent). */
      ledger: z.array(publishDegradationSchema),
      /** The real-post outcome, or `null` on a dry-run (nothing posted). */
      outcome: publishOutcomeSchema.nullable(),
    }),
  },
  // ── Submit an own-branch PR (issue #257 / #107) — push + open the PR ─────────
  // The action the product is named for: on a single human sign-click, push the
  // review's OWN branch and open a real pull request with the drafted title/body.
  // This is a different verb on the same GitHub egress the other-pr post travels —
  // NOT a second submission path. There is no consent token here: pushing your own
  // branch is not publishing (AGENTS.md), and the sign-click is the whole
  // authorization — the review is the human's, over their signature.
  //   • MAIN re-derives the canonical `pr-submission` bytes from `submission` and
  //     refuses on any disagreement with `payload` (byte-exact) — the same "what you
  //     see is what leaves" honesty (R33) the review egress holds, so the previewed
  //     PR is exactly the one that opens.
  //   • A retrospective review (read-only over a merged/any PR) is refused: there is
  //     no own branch to submit.
  //   • Idempotent by head branch: an open PR from the same head is reused, so a
  //     retry (or a double sign) yields exactly one PR.
  "publish.submitPr": {
    input: z.object({
      commandId: commandIdSchema,
      reviewId: z.string().min(1),
      /** The PR to open — title/body (with the human's edits)/base/head/draft. */
      submission: prSubmissionSchema,
      /** The canonical `pr-submission` bytes the sheet previewed + signed (round-trip check). */
      payload: z.string(),
    }),
    output: z.object({
      /** The created (or reused) pull request's web URL. */
      url: z.string(),
      /** The pull request number. */
      number: z.number().int(),
      /** True when an open PR from this head already existed and was reused (idempotent). */
      reused: z.boolean(),
    }),
  },
  // ── Canvas user ops (issue #10) ────────────────────────────────────────────
  // The renderer reaches the canvas engine ONLY through this command map (R20).
  // These are the USER surface: `canvas.disposition` is the sovereign L2 write;
  // the orchestrator's ops are MCP tools (canvasOps@2), NOT commands here, so no
  // agent-reachable path can write L2 by construction (structural, see the test).
  "canvas.disposition": {
    input: z
      .object({
        commandId: commandIdSchema,
        reviewId: z.string().min(1),
        patchsetId: z.string().min(1),
        path: z.string(),
        /** A disposition type sets/replaces the disposition; `null` clears it. */
        disposition: dispositionTypeSchema.nullable(),
        body: z.string(),
        // Optional span-grained anchor (issue #78): the Spec view (and any future
        // line-grained lens) disposes at a `path`+line span so distinct nodes on one
        // file coexist. All-or-none; absent ⇒ path-grained (the diff lenses' default).
        span: anchorSpanSchema.optional(),
        side: anchorSideSchema.optional(),
      })
      .refine((input) => (input.span === undefined) === (input.side === undefined), {
        message: "span and side must both be present (span anchor) or both absent",
      }),
    output: z.object({ review: reviewSchema }),
  },
  "canvas.adjudicateProposal": {
    input: z.object({
      commandId: commandIdSchema,
      reviewId: z.string().min(1),
      canvasId: z.string().min(1),
      proposalId: z.string().min(1),
      outcome: z.enum(["accepted", "dismissed"]),
    }),
    output: z.object({ review: reviewSchema }),
  },
  "canvas.setCohortExpansion": {
    input: z.object({
      commandId: commandIdSchema,
      canvasId: z.string().min(1),
      cohortKey: z.string().min(1),
      expanded: z.boolean(),
    }),
    output: z.object({ ok: z.boolean() }),
  },
  "canvas.select": {
    input: z.object({
      commandId: commandIdSchema,
      canvasId: z.string().min(1),
      elementKey: z.string().min(1),
    }),
    output: z.object({ ok: z.boolean() }),
  },
  "canvas.pinAnnotation": {
    input: z.object({
      commandId: commandIdSchema,
      canvasId: z.string().min(1),
      annotationId: z.string().min(1),
    }),
    output: z.object({ ok: z.boolean() }),
  },
  "canvas.clearAnnotation": {
    input: z.object({
      commandId: commandIdSchema,
      canvasId: z.string().min(1),
      annotationId: z.string().min(1),
    }),
    output: z.object({ ok: z.boolean() }),
  },
  // ── The front door: projects + discovery (issue #29 / #37) ─────────────────
  // The empty projects list IS first run; the add-a-project flow that lives there
  // forever is the whole onboarding. Discovery reads the pointed-at path read-only
  // and never mutates the index or calls a model before harness disclosure.
  "harness.detect": {
    // The ambient detection line: which harnesses were found (felt, not ceremonial).
    input: z.object({}),
    output: z.object({ detected: z.array(detectedHarnessSchema) }),
  },
  "projects.list": {
    // The populated state: the projects the user has added.
    input: z.object({}),
    output: z.object({ projects: z.array(projectSchema) }),
  },
  "project.discover": {
    // Step 2 substrate: read-only discovery over the chosen path (already granted
    // via `repository.choose`) → editable defaults for the worktree-config screen.
    input: z.object({
      commandId: commandIdSchema,
      path: z.string().min(1),
      kind: projectKindSchema,
    }),
    output: z.object({ discovery: discoveryResultSchema }),
  },
  "projects.add": {
    // Confirm: persist the project from the discovery + the user's toggle choices.
    // MAIN derives the stored shape (name, counts, open target) so the renderer
    // cannot desync it; the confirmed primary branch rides through.
    input: z.object({
      commandId: commandIdSchema,
      discovery: discoveryResultSchema,
      /** The repo names the user kept enabled (a subset of `discovery.repos`). */
      includedRepos: z.array(z.string().min(1)),
      /** The confirmed, possibly edited primary branch. */
      primaryBranch: z.string().min(1),
    }),
    output: z.object({ project: projectSchema, projects: z.array(projectSchema) }),
  },
  "project.process": {
    // The initial context dump: build the ProjectSnapshot / repo-map for every
    // included repo of a freshly-added project. LIVE narration is pushed over the
    // `onProgress` channel keyed by `commandId` as the real generator stages
    // advance; this command RESOLVES with the final per-repo summary once every
    // repo has built (or failed softly). Pure over git — no gate, no model spend.
    input: z.object({
      commandId: commandIdSchema,
      projectId: z.string().min(1),
    }),
    output: z.object({ repos: z.array(processedRepoSummarySchema) }),
  },
  // ── Project detail: the unified smart list (issue #37) ─────────────────────
  // The raw substrate a project row opens into: local work + pull requests +
  // viewer, which the renderer folds into one deduped, sorted, filterable list.
  // Read-only; a fixture stands behind it until the live git/GitHub loop lands.
  "project.detail": {
    input: z.object({ projectId: z.string().min(1) }),
    output: projectDetailSchema,
  },
  // Merged PR → auto read-only, with a "clean up" that deletes the local worktree
  // / branch left behind. A destructive local act, so it is a command (not a
  // renderer-side effect); the host handler is a documented STUB this wave
  // (acknowledges the request; real worktree deletion is a follow-up), so nothing
  // is deleted from disk yet while the surface behaves correctly.
  "project.cleanupWorktree": {
    input: z.object({
      commandId: commandIdSchema,
      projectId: z.string().min(1),
      /**
       * The stable worktree identifier to remove (`LocalWork.id`). Targeting the
       * worktree identity — not a bare branch name — keeps clean-up unambiguous across
       * a workspace's repos and across a reused branch name.
       */
      worktreeId: z.string().min(1),
    }),
    output: z.object({ ok: z.boolean() }),
  },
  // ── The Flagged lens (issue #138) ──────────────────────────────────────────
  // Everything the automated review layer raised for a review — model-council
  // findings + dual-review agreement/disagreement — read-only. A fixture stands
  // behind the real boundary until the finding-generation runner + aggregation
  // land (deferred; they sequence with #32/#41). No model spend here.
  "flagged.review": {
    // `deepReview` (issue #41) selects the dual-model path: two provider seats run
    // the finding lens independently and their findings are reconciled into
    // agreement/disagreement. This is the DEFAULT (Rai's mandate, 2026-08-11) — an
    // OMITTED flag runs dual (dispatch defaults it to true), and only an explicit
    // `false` opts down to the single-Claude quick review. Hypothesis-first is ALWAYS
    // on; dual-model + per-finding verification (#179) are the default deep behaviour.
    input: z.object({ reviewId: z.string().min(1), deepReview: z.boolean().optional() }),
    output: flaggedReviewSchema,
  },
  // ── Ask the AI a question about the review (issue #139) ────────────────────
  // The reviewer's question goes to the ORCHESTRATOR by default; `mode: "both"`
  // ADDITIONALLY asks Codex, and the two labelled answers come back side by side.
  //   • `mode` defaults to "orchestrator" (wrong-side-safe): an omitted mode NEVER
  //     fires a second model behind the reviewer's back.
  //   • The output carries at most `primary` (always the orchestrator) + an optional
  //     `secondOpinion` (Codex, only in "both") — there is NO merged-answer field, so
  //     "no synthesis, ever" is a property of the schema, not just the router.
  // The routing law — orchestrator once, both adds Codex, never a synthesis — lives
  // in `@rennet/core`'s `askReview`. The ports are LIVE (a real orchestrator turn +
  // an optional `codex exec`); asking a model is Rennet's whole job, so it just runs
  // — no permission check, no consent token. Dispatch resolves the current review
  // ONCE and hands the SAME snapshot to both legs, so a "both" ask can never cross
  // two patchsets.
  "review.ask": {
    input: z.object({
      commandId: commandIdSchema,
      reviewId: z.string().min(1),
      /** Default "orchestrator": an omitted mode never fires a second model. */
      mode: askModeSchema.default("orchestrator"),
      /** The reviewer's question about the review. */
      question: z.string().min(1),
      // #251: when these are present, main persists the thread and streams the turn
      // under these ids (delta/complete/interrupted over `onAskStream`). ABSENT = a
      // one-shot #139 ask with no persistence and no stream — fully back-compatible.
      threadId: z.string().min(1).optional(),
      turnId: z.string().min(1).optional(),
      anchor: conversationAnchorSchema.optional(),
      selection: z
        .object({
          anchor: z.string().min(1),
          excerpt: z.string().optional(),
        })
        .optional(),
      // The reviewer's RAW question for this turn (not the folded transcript), persisted
      // as the "you" message so a re-attached thread shows what was asked. #251.
      turnBody: z.string().optional(),
    }),
    output: askReviewResultSchema,
  },
  // ── review.reattach: reload persisted threads + learn what is still streaming (#251)
  // Called on review load / after a renderer reload. Returns every persisted thread for
  // the review (identity + content + harness version) AND the turns still in flight in a
  // surviving main process (so the renderer resumes their coalesced bodies). A turn left
  // `streaming` by a KILLED main is not "in flight": the store reads it back as
  // `interrupted`, so it returns inside a thread's messages, never in `inFlight`.
  "review.reattach": {
    input: z.object({
      commandId: commandIdSchema,
      reviewId: z.string().min(1),
    }),
    output: reattachResultSchema,
  },
  // ── review.refine: refine one rough note into a clean comment (issue #19) ────
  // Rai's headline feature. A real model turn cleans the user's raw note into a
  // well-phrased comment in their own first-person voice; the renderer adopts it
  // as the item's `refined` body (which `effectiveBody` prefers through to the
  // published payload) ONLY when the user keeps it. `itemId` identifies the
  // collation item the renderer round-trips the result onto; `raw` is the note
  // (verbatim, never mutated by the turn); `type`/`lens`/`path` are the context
  // (Q5) that disambiguates a terse note. The result is honest end to end — a
  // failed/unavailable turn returns that state, never the raw dressed as refined.
  "review.refine": {
    input: z.object({
      commandId: commandIdSchema,
      reviewId: z.string().min(1),
      /** The collation item the refined body rounds back onto. */
      itemId: z.string().min(1),
      /** The disposition type — a request-change reads differently than a question. */
      type: dispositionTypeSchema,
      /** The user's raw note, refined VERBATIM (the turn reads it, never rewrites it here). */
      raw: z.string().min(1),
      /** Q5: the lens the user was on when they wrote it (disambiguates a terse note). */
      lens: z.string().optional(),
      /** The anchor path the note is attached to. */
      path: z.string().optional(),
      /**
       * The span-grained anchor (#78), all-or-none with `side`. Present ⇒ the note
       * anchors at a line span; the producer grounds against THAT hunk rather than a
       * truncation from the file's start. Absent ⇒ a path-grained note (the diff lenses).
       */
      span: anchorSpanSchema.optional(),
      side: anchorSideSchema.optional(),
    }),
    output: refinementResultSchema,
  },
  // ── review.draftPrBody: draft the PR title + body (issue #74, M26) ───────────
  // The own-branch destination's paper (#22) previews a PR submission; M26 drafts
  // its title + body from the reviewed changeset so it opens with an honest account
  // rather than a diffstat. The renderer already holds the drafting material (it
  // rendered the lenses), so it hands it in: the branch shape, the roll-up
  // narration if one was produced, the staged dispositions' resolutions, the spec
  // angle's requirements, and the decisions surfaced. `reviewId` freshness-pins the
  // review (a stale/unknown id is refused). The result is human-editable and posts
  // NOTHING — drafting produces text into a preview; creating the PR is a separate
  // explicit act (#21), and Rennet never pushes source (R33).
  "review.draftPrBody": {
    input: z.object({
      commandId: commandIdSchema,
      reviewId: z.string().min(1),
      /** The base branch the PR would target. */
      base: z.string().min(1),
      /** The head branch/ref the PR submits. */
      head: z.string().min(1),
      /** The roll-up narration (M22), when one was produced — the changeset's own voice. */
      narration: z.object({ oneLine: z.string(), paragraph: z.string() }).optional(),
      /** The staged dispositions' resolutions — what the reviewer asked for and approved. */
      dispositions: z.array(
        z.object({
          type: dispositionTypeSchema,
          path: z.string(),
          resolution: z.string(),
        }),
      ),
      /** The spec angle's requirements — what the change was meant to satisfy. */
      requirements: z.array(z.string()).optional(),
      /** The decisions the review surfaced — the WHY behind the change. */
      decisions: z.array(z.string()).optional(),
    }),
    output: prBodyDraftResultSchema,
  },
  // ── review.deltaDigest: the light-tier prose over the delta account (#73/M25) ─
  // The renderer holds the successor review's `deltaAccount` (it rendered the facts);
  // it asks MAIN to rephrase it into a one-glance TL;DR. `reviewId` freshness-pins the
  // review (a stale/unknown id is refused); MAIN reads that review's own deltaAccount
  // (absent ⇒ an honest `unavailable`). The digest is built from ONLY the account, so
  // it can add no fact the facts don't carry; it posts NOTHING and gates nothing.
  "review.deltaDigest": {
    input: z.object({
      commandId: commandIdSchema,
      reviewId: z.string().min(1),
    }),
    output: deltaDigestResultSchema,
  },
  // ── The Noise lens (issue #34) ─────────────────────────────────────────────
  // The low-signal churn the changeset touches, grouped away and tagged with how
  // each group was judged (mechanical rule vs LLM noise job) — read-only, no model
  // spend. A fixture stands behind the real boundary until the live noise-
  // classification runner lands (deferred). Nothing is silently hidden: the lens
  // renders every group inspectable and pull-back-able.
  "noise.review": {
    input: z.object({ reviewId: z.string().min(1) }),
    output: noiseReviewSchema,
  },
  // ── The symbol inspector (issue: wireframes #8) ────────────────────────────
  // Resolve one clicked identifier to its definition + reference sites from the
  // review's model-free symbolic surface (context.symbol / context.references).
  // Read-only, deterministic, no model spend. Dispatch resolves the current review
  // ONCE and reads both from the same snapshot.
  "review.symbolLookup": {
    input: z.object({ reviewId: z.string().min(1), name: z.string().min(1) }),
    output: symbolInspectionSchema,
  },
  // ── The Spec angle's live OpenSpec change (wireframes #9) ───────────────────
  // Parse-on-open of the change the reviewed patchset selected. Deterministic and
  // model-free — no gate, no spend. `null` when the review touches no
  // `openspec/changes/<name>/` (the Spec angle then shows its honest empty state).
  "openspec.change": {
    input: z.object({ reviewId: z.string().min(1) }),
    output: openSpecChangeSchema.nullable(),
  },
  // ── The Spec view's requirement→hunk coverage (wireframes #9 / R53) ──────────
  // The produced hunk↔requirement mapping over the review's OpenSpec change: a model
  // turn grounds each requirement to the offered hunks that implement it plus a test
  // count, budget-gated. `status: "failed"` (no model / budget refused / turn failed)
  // OR `null` (no change in the review) ⇒ the Spec view renders NO coverage chips —
  // an uncomputed mapping never masquerades as a real zero.
  "openspec.coverage": {
    input: z.object({ reviewId: z.string().min(1) }),
    output: openSpecCoverageSchema.nullable(),
  },
  // ── Open a review file in the reviewer's editor (wireframes #8) ────────────
  // The inspector's "open in editor" jump: open a repo-relative file (optionally at
  // a line) via the OS. `ok:false` when it could not be opened (no path escape, an
  // unavailable review, or the OS refusing the file). A best-effort side effect.
  "review.openInEditor": {
    input: z.object({
      reviewId: z.string().min(1),
      path: z.string().min(1),
      line: z.number().int().positive().optional(),
    }),
    output: z.object({ ok: z.boolean() }),
  },
  // ── Settings: read the config ladder (wireframe #15) ───────────────────────
  // The whole settings surface: the global appearance layer + every project's
  // resolved repo-scope config, each carrying its provenance. Read-only; no model
  // spend. Fail-safe — a corrupt global config or an unreadable project config
  // resolves to defaults, never a throw.
  "settings.get": {
    input: z.object({}),
    output: settingsViewSchema,
  },
  // ── Settings: the per-repo guidance catalogue for one repo (wireframe #15) ───
  // The `<repoPath>/.rennet/conventions.json` house rules the review runners read
  // before every review, shown read-through. `repoPath` is the row's canonical git
  // top level (validated against the project's included repos in MAIN). Absent/
  // unreadable/empty degrade to an honest empty catalogue with a typed reason —
  // never a throw, never a fabricated rule.
  "settings.guidance": {
    input: z.object({ projectId: z.string().min(1), repoPath: z.string().min(1) }),
    output: settingsGuidanceSchema,
  },
  // ── Settings: set the global appearance scheme (wireframe #15) ─────────────
  // A personal, app-side preference the renderer consumes as `data-scheme`.
  // Side-effect-free — writes only `~/.rennet/config.json`, never a repo.
  "settings.setAppearance": {
    // `scheme: null` RESETS the global appearance to the builtin (`system`) — clears
    // the `~/.rennet/config.json` entry so the value falls back down the ladder. A
    // plain write, no ceremony (Rule Zero). Refused (throws) when the config is
    // malformed, like every other write. The output `scheme` is always the resolved
    // concrete value (builtin after a reset).
    input: z.object({ scheme: appearanceSchemeSchema.nullable() }),
    output: z.object({
      scheme: appearanceSchemeSchema,
      schemeProvenance: resolvedProvenanceSchema,
    }),
  },
  // ── Settings: set (or reset) a command's keybinding override (#44) ─────────
  // A personal, app-side preference — writes only `~/.rennet/config.json`, never a
  // repo. Mirrors `setAppearance`: a plain write, first click, no confirmation, and
  // REFUSED (throws) when the config is malformed so an edit never overwrites
  // unparseable bytes. `keybinding`: a string SETS the override, `null` UNBINDS
  // (explicit), omitted RESETS (deletes the entry, back to the catalogue default). A
  // conflicting chord is accepted and persisted — the collision is disclosed in the
  // UI, never blocked (Rule Zero). Output returns the whole stored map after the write.
  "settings.setKeybinding": {
    input: z.object({
      id: z.string().min(1),
      keybinding: z.string().min(1).nullable().optional(),
    }),
    output: z.object({ keybindings: z.record(z.string(), z.string().nullable()) }),
  },
  // ── Settings: set a repo's repo-scope map visibility (wireframe #15) ───────
  // Genuinely consumed: runs the real visibility switch, which writes the repo's
  // Rennet-owned `.rennet/.gitignore` (exclusion state only — never stages,
  // un-stages, or commits) and records `visibility` in the repo's config. This is a
  // repo write, so the outcome carries `status`/`changed`/`gitignorePath`: a
  // `status` other than `applied` means NOTHING was written (an unresolved checkout
  // or a refused-because-malformed config), and the renderer must not adopt it as
  // done. `repoPath` addresses the row (validated against the project in MAIN).
  "settings.setRepoVisibility": {
    input: z.object({
      commandId: commandIdSchema,
      projectId: z.string().min(1),
      repoPath: z.string().min(1),
      visibility: projectVisibilitySchema,
    }),
    output: setRepoVisibilityOutcomeSchema,
  },
  // ── Settings: set (or clear) a repo's execution-locus override ─────────────
  // A plain editable setting (add-windows-support, Rule Zero — never a gate). The
  // override records `locus` in the repo's config; `locus: null` clears it back to
  // auto-detection. Refused when the config is malformed (Rule 75), like
  // visibility. `repoPath` addresses the row (validated against the project).
  "settings.setRepoLocus": {
    input: z.object({
      projectId: z.string().min(1),
      repoPath: z.string().min(1),
      locus: locusSchema.nullable(),
    }),
    output: setRepoLocusOutcomeSchema,
  },
  // ── Settings: reset a repo-scoped value to inheritance (issue #28) ──────────
  // Clear the repo-layer entry for `key` so the value falls back down the ladder.
  // For visibility this ALSO re-applies the gitignore switch toward the newly
  // effective value (a reset that changed the effective value without applying it
  // would be a lie in the UI). A plain config write, no ceremony (Rule Zero);
  // refused when the config is malformed (Rule 75). `repoPath` addresses the row.
  "settings.resetRepoValue": {
    input: z.object({
      projectId: z.string().min(1),
      repoPath: z.string().min(1),
      key: settingsRepoValueKeySchema,
    }),
    output: settingsRepoWriteOutcomeSchema,
  },
  // ── Settings: pin a repo-scoped value at the repo layer (issue #28) ─────────
  // Write the CURRENT effective value explicitly at the repo layer, so a change in
  // a lower layer or in detection no longer moves it (chiefly: freeze an
  // auto-detected locus). Defined as set-to-current-effective, so it reuses the
  // same write path as the explicit controls — no new validation. Refused when
  // malformed (Rule 75). `repoPath` addresses the row.
  "settings.pinRepoValue": {
    input: z.object({
      projectId: z.string().min(1),
      repoPath: z.string().min(1),
      key: settingsRepoValueKeySchema,
    }),
    output: settingsRepoWriteOutcomeSchema,
  },
  // ── The review→agent handoff loop (issue #18, Contracts §2.1 destination B) ──
  // Batch the reviewer's open request-change/comment dispositions into a task bundle,
  // hand it to a coding harness in a WRITE-enabled session, capture the result as a
  // NEW immutable patchset, and re-review only the delta. Two steps, no gates: a
  // button that runs the agent IS the human act (Rule Zero — no consent ceremony).
  //   • `prepare` composes the bundle and returns it + a disclosure to display. Pure.
  //   • `run` rebuilds the bundle from the dispositions against the current active
  //     patchset, runs the write turn, and captures the delta.
  "review.handoff.prepare": {
    input: z.object({
      commandId: commandIdSchema,
      reviewId: z.string().min(1),
      /** The addressed dispositions in effective (refined-if-kept, else raw) form. */
      dispositions: z.array(handoffDispositionSchema),
    }),
    output: z.object({ bundle: handoffBundleSchema, disclosure: handoffDisclosureSchema }),
  },
  "review.handoff.run": {
    input: z.object({
      commandId: commandIdSchema,
      reviewId: z.string().min(1),
      /**
       * The COMPOSED bundle to run (issue #72) — the exact one `review.handoff.compose`
       * produced, NOT a re-derivation from dispositions. The run executes this bundle's
       * ordered, verbatim `prompt`, bound by its `digest`: the handler recomputes the
       * digest + prompt from the tasks and refuses a bundle that no longer matches
       * (`verifyComposedBundle`), so the write session provably runs what was composed.
       * A `composed:false` mechanical floor is a legitimate thing to run — but only when
       * it IS the composed bundle, never as a silent stand-in for a lost `composed:true`.
       */
      bundle: composedHandoffBundleSchema,
    }),
    output: handoffRunOutputSchema,
  },
  // ── Compose the handoff bundle (issue #72, Model Council M24) ───────────────
  // The light-tier authoring step over the mechanical bundle: order the asks for
  // execution sense, merge overlapping asks, write a connective narrative — WITHOUT
  // altering what was asked (the model returns only a partition of ask ids; the
  // bodies are reconstructed verbatim). ⚠️ ORDERING CONTRACT for a future wiring:
  // compose ONCE, then run THE composed bundle — the exact one this command returns.
  // The ordering matters because the bundle the run turn executes must correspond to
  // the bundle that was composed; nothing is withheld from anyone. Recomposing between
  // compose and run, or letting a `composed:false` mechanical fallback stand in after
  // the composed bundle was prepared, makes the write session execute different work
  // than was composed. So: compose, then run that same bundle. This command only
  // produces the composed bundle; it does NOT itself spend beyond the one light-tier
  // compose turn, and posts nothing.
  "review.handoff.compose": {
    input: z.object({
      commandId: commandIdSchema,
      reviewId: z.string().min(1),
      /** The addressed dispositions in effective (refined-if-kept, else raw) form. */
      dispositions: z.array(handoffDispositionSchema),
    }),
    output: z.object({ bundle: composedHandoffBundleSchema }),
  },
} as const;

export type CommandName = keyof typeof commandDefinitions;
export type CommandInput<K extends CommandName> = z.input<(typeof commandDefinitions)[K]["input"]>;
export type CommandOutput<K extends CommandName> = z.output<
  (typeof commandDefinitions)[K]["output"]
>;

export function isCommandName(value: string): value is CommandName {
  return Object.hasOwn(commandDefinitions, value);
}

export function parseCommandInput<K extends CommandName>(name: K, input: unknown): CommandInput<K> {
  return commandDefinitions[name].input.parse(input) as CommandInput<K>;
}

export function parseCommandOutput<K extends CommandName>(
  name: K,
  output: unknown,
): CommandOutput<K> {
  return commandDefinitions[name].output.parse(output) as CommandOutput<K>;
}

export interface RennetBridge {
  invoke<K extends CommandName>(name: K, input: CommandInput<K>): Promise<CommandOutput<K>>;
  /**
   * Subscribe to live progress events pushed by a long-running command, keyed by
   * the `commandId` the caller passes to `invoke`. Returns an unsubscribe. Today
   * this carries `project.process`'s snapshot-build narration. Optional: a bridge
   * without a push channel simply omits it, and a subscriber degrades to the
   * command's final resolved value with no live narration.
   */
  onProgress?(commandId: string, listener: (event: ProjectProcessEvent) => void): () => void;
  /**
   * Subscribe to a conversation's token STREAM (issue #251), keyed by `reviewId` rather
   * than a commandId — a stream must survive a renderer reload while its turn keeps
   * running in main, so the subscription outlives any single `invoke`. Each event carries
   * its own `turnId` + `channel`, so a "both" ask's two channels route independently and a
   * stray delta from a superseded turn is ignorable. Optional: a bridge without a push
   * channel omits it, and a subscriber degrades to the command's final resolved value.
   */
  onAskStream?(reviewId: string, listener: (event: ReviewAskStreamEvent) => void): () => void;
  /**
   * Push the projected application-menu template to MAIN (#44). The renderer derives
   * these serializable sections from the command registry + live context + overrides;
   * MAIN builds `Menu.setApplicationMenu` from them and routes item clicks back through
   * `onMenuRun`. One-way (no result). Optional: a bridge without a menu channel omits
   * it (tests, non-Electron hosts) and the app simply has no registry-built menu.
   */
  updateMenu?(sections: MenuTemplateSection[]): void;
  /**
   * Subscribe to menu-item activations (#44): MAIN sends the clicked command's id, and
   * the renderer runs the SAME handler the palette would. Returns an unsubscribe.
   * Optional, mirroring `updateMenu`.
   */
  onMenuRun?(listener: (id: string) => void): () => void;
}

/** One projected application-menu item (#44): a registry command rendered in the menu. */
export interface MenuTemplateItem {
  id: string;
  label: string;
  /** The effective `mod+`-token binding, for MAIN to render as an accelerator. */
  accelerator?: string;
  enabled: boolean;
}

/** One projected menu section (#44), grouped by the command's registry group. */
export interface MenuTemplateSection {
  group: string;
  items: MenuTemplateItem[];
}
