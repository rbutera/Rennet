import type {
  Canvas,
  Disposition,
  DispositionAnchor,
  ElementDiffs,
  Patchset,
  Review,
  ReviewNarration,
} from "@rennet/types";
import { z } from "zod";
import { permissionModeSchema } from "./permission-mode";

export * from "./bodies";
export * from "./permission-mode";
export * from "./rsp";
export * from "./sha256";

const fileChangeStatusSchema = z.enum(["added", "modified", "deleted", "renamed"]);

const repositoryProvenanceSchema = z.object({
  id: z.string().min(1),
  root: z.string().min(1),
  commonDir: z.string().min(1),
  baseRef: z.string().min(1),
  baseOid: z.string().min(1),
  headOid: z.string().min(1),
});

export const patchsetSchema: z.ZodType<Patchset> = z.object({
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
});

export const dispositionTypeSchema = z.enum(["approve", "request-change", "comment", "question"]);

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

export const dispositionSchema: z.ZodType<Disposition> = z.object({
  anchor: dispositionAnchorSchema,
  type: dispositionTypeSchema,
  body: z.string(),
});

export const reviewSchema: z.ZodType<Review> = z.object({
  id: z.string().min(1),
  repositoryRoot: z.string().min(1),
  patchsets: z.array(patchsetSchema).min(1),
  activePatchsetId: z.string().min(1),
  pendingPatchsetId: z.string().optional(),
  dispositions: z.array(dispositionSchema),
  status: z.enum(["current", "invalid"]),
});

// ── Canvas output schema (issue #54) ─────────────────────────────────────────
// The engine produces canvases from the durable log; this schema validates the
// live canvas set delivered to the renderer over `review.canvases`. It is a full,
// failing-capable schema (not a passthrough) so the IPC output surface has a real
// positive control, mirroring the `Canvas` shape in `@rennet/types`.

const canvasAngleSchema = z.enum(["spec", "sequence", "decisions", "claims", "noise"]);

const substrateChunkRefSchema = z.object({
  chunkId: z.string(),
  hunkIds: z.array(z.string()),
  filePaths: z.array(z.string()),
});

const analysisElementSchema = z.object({
  elementKey: z.string(),
  docId: z.string(),
  anchor: z.string(),
  kind: z.string(),
  title: z.string(),
});

const analysisCohortSchema = z.object({
  cohortKey: z.string(),
  title: z.string(),
  elementKeys: z.array(z.string()),
});

const annotationSchema = z.object({
  annotationId: z.string(),
  target: z.string(),
  kind: z.enum(["highlight", "callout", "link"]),
  body: z.string(),
  pinned: z.boolean(),
});

const proposalSchema = z.object({
  proposalId: z.string(),
  kind: z.enum(["disposition", "regroup", "split"]),
  target: z.string(),
  payload: z.string(),
  status: z.enum(["pending", "accepted", "dismissed"]),
});

const blastRadiusPaintSchema = z.object({ target: z.string(), docId: z.string() });

export const canvasSchema: z.ZodType<Canvas> = z.object({
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

/** The five-angle canvas set the live pipeline produces (`Record<CanvasAngle, Canvas>`). */
const canvasSetSchema = z.object({
  spec: canvasSchema,
  sequence: canvasSchema,
  decisions: canvasSchema,
  claims: canvasSchema,
  noise: canvasSchema,
});

// ── Per-element real diff map (issue #60) ────────────────────────────────────
// Delivered ALONGSIDE the canvas set so the zoom surface renders the real
// captured hunk text instead of the `demoDiff` fixture. Keyed by `elementKey`; a
// doc-anchored element (flat angle, no code diff) simply has no entry. A full,
// failing-capable schema (path + diff both required) so the IPC surface keeps a
// real positive control.
const elementDiffSchema = z.object({ path: z.string(), diff: z.string() });
const elementDiffsSchema: z.ZodType<ElementDiffs> = z.record(z.string(), elementDiffSchema);

// ── Roll-up narration placement (issue #70) ──────────────────────────────────
// Delivered ALONGSIDE the canvas set (like `elementDiffs`) so the zoom ladder
// renders the agent's account at each altitude. A discriminated union keeps the
// never-blank contract honest at the IPC boundary: a placement is a narrated
// account or an explicit pending/failed state — there is no shape for "blank".
const narrationEvidenceSchema = z.object({ anchor: z.string(), quote: z.string() });
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
const reviewNarrationSchema: z.ZodType<ReviewNarration> = z.object({
  rollup: narrationPlacementSchema,
  cohorts: z.record(z.string(), narrationPlacementSchema),
});

const commandIdSchema = z.uuid();

// ── Publish egress schemas (issue #21) ───────────────────────────────────────
// The forge-neutral shapes the renderer sends to MAIN for the outbound GitHub
// review post. The renderer supplies the pinned target, the canonical review
// content, and the canonical payload bytes; MAIN independently re-derives the
// bytes and fails CLOSED on any disagreement (the egress-side "what you see is what
// leaves", R33), then gates the real egress on the effective mode + a single-use,
// target-and-payload-bound consent token before anything leaves the machine.

const forgeRepoSchema = z.object({
  forge: z.string().min(1),
  owner: z.string().min(1),
  name: z.string().min(1),
});

/** The pinned publish target: which PR, which node id, which reviewed head. */
const publishTargetSchema = z.object({
  repo: forgeRepoSchema,
  number: z.number().int().positive(),
  /** The forge's opaque PR node id (carried, interpreted only in the adapter). */
  forgeRef: z.string().min(1),
  /** The reviewed head commit OID, pinned at review start (GraphQL `commitOID`). */
  headOid: z.string().min(1),
});

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

export const commandDefinitions = {
  "app.bootstrap": {
    input: z.object({}),
    output: z.object({ review: reviewSchema.nullable() }),
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
    }),
    output: z.object({ review: reviewSchema }),
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
  // ── Settings: permission modes (issue #103) ────────────────────────────────
  // The workspace-level permission MODE (manual / auto / bypass) that governs
  // gated actions. `settings.permissionMode` reads the persisted default;
  // `settings.setPermissionMode` writes it. The renderer layers a per-run
  // override over this (resolvePermissionMode); the persisted value is the
  // workspace default. First consumer: the #58 Canvases harness-run gate.
  "settings.permissionMode": {
    input: z.object({}),
    output: z.object({ mode: permissionModeSchema }),
  },
  "settings.setPermissionMode": {
    input: z.object({ mode: permissionModeSchema }),
    output: z.object({ mode: permissionModeSchema }),
  },
  // ── Harness-run consent, main-issued (issue #58 / #103, bead workspace-fyvxb) ─
  // The renderer REQUESTS approval for a review's harness run; MAIN mints the
  // authorization. This is the whole point of the fyvxb hardening: the per-run
  // consent signal carried on `review.canvases` is no longer a renderer-supplied
  // boolean (forgeable + replayable), but a single-use, review-BOUND token that
  // only MAIN can issue and that MAIN consumes before the model spend. The
  // renderer's role shrinks to asking; it can no longer ASSERT consent, only
  // relay a token it obtained here. Minting is harmless under auto/bypass (the
  // token is simply never checked); the enforcement lives entirely at consume
  // time in `review.canvases`.
  "harness.requestConsent": {
    input: z.object({
      commandId: commandIdSchema,
      reviewId: z.string().min(1),
    }),
    output: z.object({
      // The opaque, single-use authorization bound to `reviewId`. Present it once
      // on `review.canvases`; MAIN consumes it and a replay is rejected.
      authorization: z.string().min(1),
    }),
  },
  // ── Live canvases (issue #54) ──────────────────────────────────────────────
  // Runs the live pipeline (decompose → budget-gated angle → ordering → place)
  // for the review's active patchset and returns the five-angle canvas set the
  // renderer reads. On-demand (opened Canvases view), not on every capture.
  "review.canvases": {
    input: z.object({
      commandId: commandIdSchema,
      reviewId: z.string().min(1),
      repoPath: z.string().min(1),
      // The #58/#103 harness-run authorization (bead workspace-fyvxb). Under a
      // consent-requiring mode (`manual`) MAIN requires a single-use token that it
      // ITSELF minted for THIS review via `harness.requestConsent`, verifies it
      // matches the review and has not been used, and CONSUMES it before invoking
      // the harness. Absent / forged / already-consumed ⇒ refused, no build. This
      // REPLACES the old renderer-supplied `consent: boolean`, which was forgeable
      // (any caller could assert `true`) and replayable (reusable across runs).
      // Under `auto`/`bypass` no authorization is required. The effective mode is
      // still resolved from the persisted WORKSPACE store (the j98dt authority),
      // so the vital model-spend circuit has two independent guards (Rule 75: no
      // single fault clears it — a laxer mode can't be smuggled, and the consent
      // signal can no longer be forged or replayed).
      authorization: z.string().min(1).optional(),
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
    }),
  },
  // ── Publish consent request, main-issued (issue #21, bead workspace-fyvxb lineage) ─
  // The renderer REQUESTS approval to POST a review to GitHub; MAIN mints the
  // authorization. Like `harness.requestConsent`, MAIN is the sole issuer — but the
  // egress is MORE vital than a model run, so the token is bound to MORE than the
  // review: it is bound to the exact TARGET (PR + head) AND the exact PAYLOAD bytes.
  // A token minted to post payload P to PR#5@head-A cannot authorise a different
  // payload, a different PR, or a different head. Single-use, consumed at egress.
  "publish.requestConsent": {
    input: z.object({
      commandId: commandIdSchema,
      reviewId: z.string().min(1),
      target: publishTargetSchema,
      /** The canonical payload bytes the token authorises (bound by digest). */
      payload: z.string(),
    }),
    output: z.object({
      /** The opaque, single-use authorization bound to (review, target, payload). */
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
  //   • Under a consent-requiring mode (`manual`) a real send requires the
  //     single-use token from `publish.requestConsent`, bound to THIS review, target,
  //     and payload; absent / forged / replayed ⇒ refused, nothing leaves. Dry-run
  //     needs no token (it posts nothing).
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
  // ── Canvas user ops (issue #10) ────────────────────────────────────────────
  // The renderer reaches the canvas engine ONLY through this command map (R20).
  // These are the USER surface: `canvas.disposition` is the sovereign L2 write;
  // the orchestrator's ops are MCP tools (canvasOps@2), NOT commands here, so no
  // agent-reachable path can write L2 by construction (structural, see the test).
  "canvas.disposition": {
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
}
