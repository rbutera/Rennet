// Types owned by the wire schemas in ./index (protocol is the source of truth).
import type {
  AnalysisCohort,
  AnalysisElement,
  AnchorSpan,
  Annotation,
  Canvas,
  CiFailure,
  DecisionEvidence,
  DecisionWhy,
  DeltaAccount,
  Disposition,
  DualReviewNote,
  ElementDiff,
  FindingAdjudication,
  FindingElement,
  FindingModelAnswer,
  NarrationEvidence,
  NoiseGroup,
  OpenSpecListItem,
  OpenSpecScenario,
  OpenSpecSource,
  Patchset,
  Proposal,
  ReviewHypothesis,
  RiskCrossCheck,
  SubstrateChunkRef,
  UiScreenshot,
} from "./index";

export type FileChangeStatus = "added" | "modified" | "deleted" | "renamed";

export interface PatchFile {
  path: string;
  previousPath?: string;
  status: FileChangeStatus;
  additions: number | null;
  deletions: number | null;
  binary: boolean;
  patch: string;
}

/**
 * The sentinel `visible()` (`@rennet/adapters`) appends when it truncates a diff
 * past its byte cap. A `PatchFile.patch` containing this marker is content-lossy:
 * hashing it yields an identity for only the first N bytes, so two files that
 * differ only BEYOND the cap share a `fileContentDigest`. The path-grained
 * disposition carry in `@rennet/core` must therefore refuse to carry over a
 * patch that carries this marker (fail closed). Declared here — the one module
 * both the producer (`visible`) and the consumer (`fileContentDigest`'s carry
 * check) depend on — so the two cannot drift apart and silently reopen the hole.
 */
export const DIFF_TRUNCATION_MARKER = "[diff truncated by Rennet]";

/**
 * Where a patchset's content came from. `local` is the working-tree capture
 * (`GitCaptureAdapter`); `github-local` is a GitHub PR diffed from the on-disk
 * clone (full context, the angles can run); `github-rest` is the degraded REST
 * diff fallback used when the clone is not on disk or its SHAs are unfetchable.
 * Absent means `local` (additive: the existing local-capture identity is unchanged).
 */
export type PatchsetSource = "local" | "github-local" | "github-rest";

/** Which surface a patchset's captured intent came from. */
export type PatchsetIntentSurface = "github-pr" | "github-rest" | "working-tree";

/**
 * The unit a disposition is attached to.
 *
 * Slice 1 anchors at FILE granularity, reusing the MVP's file-level read
 * identity: `path` names the changed file and `contentDigest` is a hash of that
 * file's patch text at authoring time. The digest is the exact-match key that
 * lets a disposition survive a re-capture only when the file is byte-identical.
 * Hunk / line / symbol anchoring and fuzzy lineage matching are a later slice
 * (Spike 1); this shape is deliberately the minimal reuse of what exists.
 */
export interface DispositionAnchor {
  path: string;
  contentDigest: string;
  /**
   * OPTIONAL span anchor (issue #78). A 1-based FILE-LINE range on `side`.
   * `span`/`side`/`spanDigest` travel together: all three present ⟺ the
   * disposition is span-grained; all three absent ⟺ path-grained (today's
   * shape, unchanged). A partial presence is invalid (enforced by the protocol
   * schema).
   *
   * These are ABSOLUTE file lines, side-qualified — NOT the RSP grammar's
   * within-occurrence `AnchorSpan` ordinal. Anchoring by file line + side makes
   * carry and the publish payload read `Patchset.files[].patch` directly and
   * registrar-independently, so #78 sidesteps #84 (the CodeView's positional
   * occurrence map) at the data model. `side` selects the image the span reads:
   * `additions`/`context` → the post-image (new-file) lines; `deletions` → the
   * pre-image (old-file) lines.
   */
  span?: AnchorSpan;
  side?: AnchorSide;
  /** Digest of the span's side-text at authoring time — the span carry key. */
  spanDigest?: string;
}

export type DispositionType = "approve" | "request-change" | "comment" | "question";

/**
 * How a returned patchset acted on ONE staged ask's target (issue #73). Derived
 * deterministically from the shipped lineage carry + the successor's changed paths —
 * never a model call:
 *  - `untouched` — the ask's target carried byte-identically AND its file was not
 *    changed at all (the agent left it alone).
 *  - `partially-addressed` — the ask's target span carried byte-identically, but the
 *    file WAS changed elsewhere (the agent worked the file, not the flagged span).
 *  - `addressed` — the ask's target changed (it did not carry: reopened, or its file
 *    was deleted).
 */
export type DeltaAskStatus = "addressed" | "partially-addressed" | "untouched";

/**
 * A disposition the deterministic floor DROPPED on a re-capture, offered to the
 * relevance judge (issue #78, Rai's #48 ruling). `successorPatch` is the new
 * file's patch text when the file survives; absent when the file is gone.
 */
export interface RelevanceCandidate {
  disposition: Disposition;
  successorPatch?: string;
}

/**
 * The judge's verdict for one candidate (positional to the candidates array).
 * `carry: true` re-attaches the disposition; a `reAnchor` re-points it to a new
 * span/path (validated + re-digested against the successor before it attaches).
 */
export interface RelevanceVerdict {
  carry: boolean;
  reAnchor?: DispositionAnchor;
}

/**
 * The model layer ABOVE the byte-identical carry floor. A port (never a live
 * model in the pure core / CI): given the dropped candidates and the successor
 * patchset, it judges whether each prior disposition is still relevant. The
 * `disposition-relevance-judge` Model Council job routes the real call.
 */
export interface DispositionRelevanceJudge {
  judge(candidates: RelevanceCandidate[], patchset: Patchset): Promise<RelevanceVerdict[]>;
}

/**
 * The GitHub review-thread publish payload (issue #78 — the single line/side
 * contract #22 and #21 build on once). A span disposition carries the end file
 * `line`, a `startLine` for a multi-line span, and a `side` (deletions → LEFT /
 * old file; additions and context → RIGHT / new file). A path-grained
 * disposition carries neither line nor side (a file-level comment).
 */
export interface PublishThread {
  path: string;
  line?: number;
  startLine?: number;
  side?: "LEFT" | "RIGHT";
  body: string;
  type: DispositionType;
}

/**
 * The real forge coordinates a review can POST back to (issue #21, the real-post
 * flip). Present ONLY on a non-retrospective review opened from a real pull request
 * (`review.openPr`): it carries the exact identity a real GitHub egress needs — the
 * repo, the PR number, the forge's opaque PR node id (`forgeRef`), and the reviewed
 * head OID. Mirrors the protocol `publishTargetSchema` byte-for-byte so the renderer
 * hands it straight to `publish.requestConsent` + `publish.review` with no re-derive.
 *
 * A LOCAL working-tree capture has no PR, so it has NO postTarget — the renderer
 * falls to the local-preview dry-run and genuinely cannot post (there is no PR to
 * post to). A RETROSPECTIVE review also omits it (nothing may be posted). So the
 * PRESENCE of this field is exactly the set of reviews a real post is legitimate for.
 */
export interface ReviewPostTarget {
  readonly repo: { readonly forge: string; readonly owner: string; readonly name: string };
  readonly number: number;
  /** The forge's opaque PR node id (GraphQL `pullRequestId`); carried, never parsed here. */
  readonly forgeRef: string;
  /** The reviewed head commit OID, pinned at review start (GraphQL `commitOID`). */
  readonly headOid: string;
}

export interface CommandFailure {
  code: "INVALID_COMMAND" | "INVALID_INPUT" | "INTERNAL_ERROR";
  message: string;
  details?: unknown;
}

export type CommandResult<T> = { ok: true; value: T } | { ok: false; error: CommandFailure };

// ─────────────────────────────────────────────────────────────────────────────
// Rennet Surfacing Protocol (RSP) — document core (issue #6)
//
// The document substrate every fleet emission passes through: a universal
// envelope, a provenance block, an anchor grammar, and the deterministic
// validator gate. Per-docType body schemas (decomposition, decision, …)
// land with angle generation (#8); this slice is the core machinery, so `body`
// is deliberately opaque here.
//
// Deterministic validation is a MECHANISM in service of digestibility, never
// the product's purpose (2026-08-06 correction). Nothing below caps a decision:
// there is no `maxItems` anywhere in this schema, by design.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The document types named by the Surfacing DSL plan (§2), plus `ordering`: the
 * agent-owned comprehension reading order over an admitted decomposition's chunks
 * (issue #9). `ordering` is a distinct type rather than an extension of
 * `decomposition.proposal` because it declares no chunks and mints no ids — it
 * orders a set it was handed.
 */
export type RspDocType =
  | "spec.model"
  | "decomposition.skeleton"
  | "decomposition.proposal"
  | "ordering"
  | "rollup-narration"
  | "decision.record"
  | "adjudication"
  | "test.mapping"
  | "noise.patternProposal"
  | "noise"
  | "anomaly"
  | "finding"
  | "review.hypothesis"
  | "validation.report";

/** Task tier: a property of the task, not the wallet (§1). */
export type RspTier = "heavy" | "light" | "deterministic";

/** Which subsystem produced the document. */
export type RspRoute = "agentic" | "utility" | "deterministic";

/** How the model id was learned; never guessed silently. */
export type RspModelReportedBy = "harness" | "config" | "unknown";

/**
 * The three-layer capability model (adjudication pt 1): a CI-proven flag can
 * still be unavailable in a given session, so a document produced under a
 * degraded capability is labelled rather than silently trusted.
 */
export interface RspCapabilityLayers {
  implementedByAdapter: boolean;
  advertisedByHarness: boolean;
  availableInSession: boolean;
}

/** The capability snapshot carried on every provenance block. */
export interface RspCapabilitySnapshot {
  structuredOutput: RspCapabilityLayers;
  perCallModelSelection: RspCapabilityLayers;
}

/** Token accounting. `reasoning` is null when the harness does not report it. */
export interface RspTokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number | null;
  total: number;
}

/**
 * The provenance block. This is the piece the architecture critique requires to
 * exist before the first adapter freezes the protocol. `reportedUsd` and
 * `derivedUsd` are kept distinct and never merged: one number for both would be
 * a lie about the harness that reports no monetary figure.
 */
export interface RspProvenance {
  harness: string;
  harnessVersion: string;
  adapterVersion: string;
  model: string;
  modelReportedBy: RspModelReportedBy;
  tier: RspTier;
  route: RspRoute;
  runId: string;
  /** Full fingerprint of the input actually offered to the run (§2.2). */
  inputDigest: string;
  capability: RspCapabilitySnapshot;
  tokens: RspTokenUsage;
  /** null unless the harness reports a monetary figure; never substituted. */
  reportedUsd: number | null;
  /** null unless the app derived a cost; never merged into `reportedUsd`. */
  derivedUsd: number | null;
  /** Groups repeated runs of the same prompt+input (N=3). Optional in slice 1. */
  sampleGroupId?: string;
  sampleIndex?: number;
  startedAt?: number;
  completedAt?: number;
  /**
   * The effort/thinking level the Model Council assigned this invocation
   * (low/medium/high/xhigh). Optional: absent on documents stamped before a
   * council assignment was threaded (the provenance schema is `.loose()`, so
   * absence validates and the input digest is unaffected — it is computed over
   * the offered input, never over provenance).
   */
  effort?: string;
  /**
   * The Model Council resolution trace: why this job ran on this model. Optional
   * for the same reason as `effort`. This is the string the UI can show so an
   * override is only ever over something visible.
   */
  resolutionTrace?: ResolutionTrace;
}

/**
 * The universal envelope every document carries, no exceptions (§2.1).
 *
 * `docId` is minted by the ADAPTER on receipt, never by the agent, so it is
 * absent on an agent's emission. `x` is the extension bag: unknown keys are
 * preserved verbatim and round-tripped (raw-frame doctrine — silent loss is the
 * failure mode). `body` is opaque until the per-docType schemas land with #8.
 */
export interface RspEnvelope {
  rsp: number;
  docType: RspDocType;
  schemaVersion: number;
  docId?: string;
  patchsetId: string;
  reviewId?: string;
  projectSnapshotId?: string;
  supersedes?: string | null;
  provenance: RspProvenance;
  body: unknown;
  x: Record<string, unknown>;
}

// ── Anchor grammar (§3) ──────────────────────────────────────────────────────

/** The anchor kinds. `spec`/`requirement` let a document exist with no code. */
export type AnchorKind =
  | "hunk"
  | "file"
  | "symbol"
  | "chunk"
  | "patchset"
  | "reach"
  | "doc"
  | "noisegroup"
  | "spec"
  | "requirement";

/** The side of a diff a span addresses; spans are always side-qualified. */
export type AnchorSide = "additions" | "deletions" | "context";

/** A parsed `rennet:` anchor. `span` and `pointer` are mutually exclusive. */
export interface ParsedAnchor {
  raw: string;
  kind: AnchorKind;
  id: string;
  span?: AnchorSpan;
  pointer?: string;
  side?: AnchorSide;
  proposal?: string;
}

/** Lineage classification when an id maps forward across patchsets (§3.3). */
export type Lineage =
  | "exact"
  | "one-to-one"
  | "split"
  | "merge"
  | "move"
  | "ambiguous"
  | "terminated";

/**
 * The auto-carry authority (issue #16, frozen contract §3.4). The SINGLE source
 * of truth for which lineage classes may carry analysis and read state forward
 * WITHOUT re-review — read by both the disposition carry seam (`@rennet/core`)
 * AND the graph consumer `resolveAnchor` (`@rennet/protocol`), so the policy
 * cannot be advisory in one place and binding in another. It lives in the lowest
 * layer precisely so no consumer can drift from it.
 *
 * ⭐ `exact` ONLY. §3.4: "Only an exact, byte-identical occurrence with matching
 * contextual disambiguators may carry." `move` was REMOVED after measurement
 * (`docs/developing/concepts/delta-rereview-and-lineage.md`): content + optional context cannot
 * distinguish a move from a delete-plus-copy or a context-rotated reassignment,
 * so a confidently-labelled `move` can point at the WRONG occurrence — the
 * product's worst failure. `move` returns as a carry class only behind
 * deterministic provenance that PROVES continuation. Everything else
 * (`one-to-one`, `split`, `merge`, `ambiguous`, `terminated`) reopens or orphans.
 */
export const AUTO_CARRY_LINEAGES: ReadonlySet<Lineage> = new Set<Lineage>(["exact"]);

/** Whether a lineage class auto-carries analysis and read state (exact only). */
export function autoCarries(lineage: Lineage): boolean {
  return AUTO_CARRY_LINEAGES.has(lineage);
}

/** The four (and only four) resolution outcomes. */
export type ResolutionOutcome = "resolved" | "unresolved" | "superseded" | "orphaned";

/** The total result of resolving an anchor against a patchset's manifest. */
export interface Resolution {
  outcome: ResolutionOutcome;
  /** The resolved id (`resolved`) or the successor id (`superseded`). */
  occurrenceId?: string;
  /** The resolved span's text, present when a span+side resolve (for quotes). */
  resolvedText?: string;
  lineage?: Lineage;
  /** Never true under ambiguous lineage: ambiguity fails closed (§3.3). */
  carriesState?: boolean;
  /** Why an anchor did not resolve, for precise validator error codes. */
  reason?:
    | "malformed"
    | "unknown-kind"
    | "unknown-side"
    | "minted"
    | "out-of-bounds"
    | "no-such-side";
}

/** One occurrence offered to a run. Agents may reference these, never mint new. */
export interface ManifestOccurrence {
  id: string;
  kind: AnchorKind;
  /** Repo-relative path for file-backed occurrences such as offered hunks. */
  path?: string;
  /** Side line text (1-based access via span), for span bounds and quotes. */
  sides?: Partial<Record<AnchorSide, readonly string[]>>;
}

/** A prior-patchset id mapped forward by the lineage graph. */
export interface LineageEntry {
  fromId: string;
  lineage: Lineage;
  /** The successor id; absent when the lineage terminates. */
  toId?: string;
}

/**
 * The occurrence manifest offered to a run: the deterministic ingest's immutable
 * occurrence ids, plus the lineage graph mapping prior ids forward. This is the
 * full substrate the validator needs — it runs standalone against this alone.
 */
export interface OfferedManifest {
  occurrences: readonly ManifestOccurrence[];
  lineage?: readonly LineageEntry[];
}

/**
 * Size limits (§4.2). Exceeding one is a REJECTION with a code, never a
 * truncation. There is deliberately NO item-count / `maxItems` limit here:
 * decisions are never capped (issue #6). `documentBytes` is a whole-document
 * DoS guard on total serialized size, not a cap on how many items a document
 * may carry.
 */
export interface SizeLimits {
  documentBytes: number;
  quoteBytes: number;
}

/**
 * The validator's settings projection. It structurally cannot see guidance
 * (§6.4): guidance changes emphasis, never a schema or an admission rule, so it
 * is simply not a field here.
 */
export interface SettingsProjection {
  sizeLimits: SizeLimits;
}

/** Whether a document is admitted whole-or-nothing, or item-by-item (§4.3). */
export type AdmissionKind = "atomic" | "itemwise";

/** A minimal reference to the immutable patchset a document binds to. */
export interface PatchsetRef {
  id: string;
}

/** One machine-readable validation error, addressed by a JSON Pointer. */
export interface ValidationError {
  code: string;
  pointer: string;
  message: string;
  detail?: unknown;
}

/** A rejected collection item, with the errors that dropped it. */
export interface RejectedItem {
  pointer: string;
  errors: ValidationError[];
}

/**
 * The validator's verdict. For an item-wise document, `admitted` is true when
 * the envelope is sound even if some items were dropped; `rejectedItemCount` is
 * MANDATORY and visible — a silent per-item drop is the failure mode this whole
 * design exists to prevent.
 */
export interface ValidationReport {
  docType: RspDocType | null;
  admission: AdmissionKind | null;
  admitted: boolean;
  errors: ValidationError[];
  admittedItemCount: number | null;
  rejectedItemCount: number;
  rejectedItems: RejectedItem[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Deterministic decomposition floor (issue #7)
//
// The always-present, offline, zero-model floor over a captured Patchset: it
// classifies every hunk mechanical-vs-substantive, groups file→symbol, chunks to
// a ≤400 changed-LOC budget (splitting an oversize hunk — R18), and computes the
// code-dependency DAG plus its topological reading order. This is the floor under
// the hybrid (Contracts R9), not the semantic authority, and it is the ordering
// BASELINE the agent comprehension-ordering pass (#9) reads through. Ordering here
// is LOGICAL/dependency-based, never danger/blast-radius/salience (Contracts §1,
// correction 8).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The mechanical (non-substantive) classification of a hunk (Architecture Plan
 * D7). A mechanical hunk is VERIFIED noise; this deterministic pass is the ONLY
 * admission authority for it (R9). Closed vocabulary.
 *
 * `binary` and `submodule` are first-class per R18: a binary blob or a submodule
 * gitlink pointer advance is a real change whose CONTENT the text floor cannot
 * ingest. Classifying them mechanical keeps them out of the substantive review
 * surface (they must never read as reviewed content) while the parallel
 * `Decomposition.blockingStates` names them as un-ingested so an absence of
 * findings over them cannot let a done or publish gate report completeness.
 */
export type MechanicalClass =
  | "lockfile"
  | "generated"
  | "pure-rename"
  | "formatting-only"
  | "vendored"
  | "mode-only"
  | "binary"
  | "submodule";

/** Whether a hunk carries reviewable meaning or is mechanical noise. */
export type HunkKind = "substantive" | "mechanical";

/**
 * A contiguous change region within one file's patch — the atomic unit of the
 * floor. `oldStart`/`newStart` are 1-based file line numbers from the hunk
 * header; `changedLoc` is `addedLines.length + deletedLines.length`. `splitOf` is
 * present only on a fragment produced by splitting an oversize hunk (R18).
 */
export interface Hunk {
  id: string;
  filePath: string;
  previousPath?: string;
  fileStatus: FileChangeStatus;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  addedLines: string[];
  deletedLines: string[];
  contextLines: string[];
  changedLoc: number;
  /** Fragment `index` of `total` when this hunk is a piece of an oversize split. */
  splitOf?: { index: number; total: number };
}

/**
 * The per-hunk classification. `mechanical` is non-null iff `kind` is
 * `"mechanical"`. `enclosingSymbol` is the tree-sitter enrichment where a grammar
 * is available and degrades to `""` (never blocks the floor).
 */
export interface HunkClassification {
  hunkId: string;
  kind: HunkKind;
  mechanical: MechanicalClass | null;
  enclosingSymbol: string;
}

/** A substantive chunk carries reviewable change; an appendix chunk collects a
 *  file's mechanical hunks, pre-collapsed and eligible to be skimmed. */
export type ChunkKind = "substantive" | "appendix";

/**
 * A greedily-merged group of hunks. `changedLoc` is `≤ maxChunkLoc` for a
 * substantive chunk (every hunk is `≤` the budget after oversize splitting);
 * appendix chunks are not budget-bounded because they are skimmed, not read.
 * `layer` is the logical reading layer (schema→types→core→ui→tests→config→
 * appendix), used as a deterministic ordering tiebreak.
 */
export interface DecompositionChunk {
  chunkId: string;
  kind: ChunkKind;
  title: string;
  layer: number;
  filePaths: string[];
  hunkIds: string[];
  changedLoc: number;
}

/**
 * The DAG edge vocabulary (DSL §2.4). The deterministic floor emits only
 * `"enables"` (dependency → dependent, derived from import resolution); the richer
 * kinds are agent-proposed (#8).
 */
export type DecompositionEdgeKind =
  | "enables"
  | "evidenced-by"
  | "contradicts"
  | "duplicates"
  | "refactor-of";

/** A directed dependency edge between two chunk ids. */
export interface DecompositionEdge {
  from: string;
  to: string;
  kind: DecompositionEdgeKind;
}

/**
 * A hunk the floor could not place in a chunk. Always empty from the
 * deterministic floor (it places every hunk); present so totality is provable —
 * `⋃chunks.hunkIds ∪ residue == the offered hunk set` (V100).
 */
export interface DecompositionResidueItem {
  hunkId: string;
  reason: string;
}

/** The reason decomposition cannot certify the captured change as complete. */
export type DecompositionBlockingReason = "truncated" | "binary" | "submodule";

/**
 * A first-class blocking state showing that the deterministic floor could not
 * fully ingest some captured content (R18: binary / submodule / truncated
 * inputs are first-class). Its presence is the operative fact for a done or
 * publish gate: an absence of findings over the affected content is not
 * evidence of cleanliness, which is the exact false-clear this floor prevents.
 *
 * This is the patchset-level companion to `residue` (which proves hunk-placement
 * totality). `residue` can only speak in terms of a `hunkId`; a truncated tail
 * has no hunk to point at, so incomplete ingestion needs its own carrier. A
 * consumer can refuse a false-clear with `blockingStates.length > 0` without
 * re-deriving capture semantics from hunks or patch text.
 */
export interface DecompositionBlockingState {
  readonly reason: DecompositionBlockingReason;
  /** The file that triggered the state, or `null` for patchset-wide truncation. */
  readonly path: string | null;
  /** Human-facing explanation for the sheet or refusal surface. */
  readonly detail: string;
}

/**
 * The deterministic decomposition of one patchset: every hunk classified, every
 * substantive hunk chunked to the budget, the dependency DAG, and its topological
 * reading order. Byte-stable across two runs on the same patchset; zero model
 * calls, no network (R9). `readingOrder` is a topological linearisation of `edges`
 * that covers every chunk exactly once.
 */
export interface Decomposition {
  patchsetId: string;
  hunks: Hunk[];
  classifications: HunkClassification[];
  chunks: DecompositionChunk[];
  edges: DecompositionEdge[];
  readingOrder: string[];
  residue: DecompositionResidueItem[];
  /**
   * Incomplete-ingestion blockers (R18). Empty means the floor fully ingested
   * every captured byte. Non-empty means some content (a truncated tail, a
   * binary blob, or a submodule pointer's child repo) was not ingested, so a
   * done or publish gate must not claim completeness. Deterministically ordered:
   * any patchset-wide state first, then per-file states in path order.
   */
  blockingStates: DecompositionBlockingState[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Decomposition angle generation (issue #8)
//
// The document bodies a fleet emits for the decomposition angle, plus the shapes
// of the route-plan budget gate that bounds the transformation. Ordering emitted
// here is the floor's provisional dependency order; the final comprehension
// ordering is #9's job. Nothing here caps a chunk or a decision.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The angles a chunk may be assigned to. Deliberately a CLOSED set that excludes
 * `noise` (verified only by deterministic checkers, never chunk membership) and
 * `spec` (a queue over requirements). The `claims` angle is retired (issue #221):
 * the Decisions lens owns that ground. Enforced by validator rule V104.
 */
export type ChunkAngle = "sequence" | "decisions" | "blast-radius";

/** A chunk in a `decomposition.skeleton` body: boundaries + angle assignment only. */
export interface SkeletonChunk {
  chunkId: string;
  hunkIds: string[];
  angles: ChunkAngle[];
}

/** A chunk in a `decomposition.proposal` body: the complete graph node. */
export interface ProposalChunk {
  chunkId: string;
  title: string;
  hunkIds: string[];
  angles: ChunkAngle[];
  rationale: string;
}

/**
 * The `decomposition.skeleton` body: chunk boundaries + a reading order, no
 * rationale and no edges. Exists to beat the <15s first-paint budget.
 */
export interface DecompositionSkeletonBody {
  chunks: SkeletonChunk[];
  readingOrder: string[];
  residue: DecompositionResidueItem[];
}

/**
 * The `decomposition.proposal` body: the complete versioned graph — chunks with
 * rationale, the dependency `edges`, the topological `readingOrder`, and the
 * residue. Admitted atomically; the validator rejects on totality/DAG/angle/
 * completeness violations (V100/V103/V104/V106).
 */
export interface DecompositionProposalBody {
  chunks: ProposalChunk[];
  edges: DecompositionEdge[];
  readingOrder: string[];
  residue: DecompositionResidueItem[];
}

/** The tier a planned harness invocation runs at. Deterministic steps are not invocations. */
export type PlannedInvocationTier = "heavy" | "light";

/** The purpose of a planned invocation in the initial-decomposition plan. */
export type PlannedInvocationPurpose = "skeleton" | "proposal" | "rationale";

/**
 * One planned harness invocation. `chunkBatch` is present only for `rationale`
 * (light, batched ≤10 chunks/call — never process-per-hunk).
 */
export interface PlannedInvocation {
  purpose: PlannedInvocationPurpose;
  tier: PlannedInvocationTier;
  label: string;
  chunkBatch?: string[];
}

/**
 * The result of planning the initial decomposition. Either a plan whose
 * harness-invocation count is within budget, or a refusal computed BEFORE any
 * model runs (R10: the budget is a mechanical gate, not a guideline).
 */
export type RoutePlanResult =
  | {
      refused: false;
      invocations: PlannedInvocation[];
      harnessInvocationCount: number;
      maxHarnessInvocations: number;
    }
  | {
      refused: true;
      harnessInvocationCount: number;
      maxHarnessInvocations: number;
      reason: string;
    };

// ─────────────────────────────────────────────────────────────────────────────
// Comprehension ordering (issue #9)
//
// The agent-owned comprehension reading order over an admitted decomposition's
// chunk set. The deterministic dependency-DAG order (#7) is the baseline; an
// agent is asked whether that is the clearest way to understand the change or
// whether a better high-level-then-ground-up structure exists, and PRODUCES the
// final order as this document. The user does NOT approve it (2026-08-06, Q2):
// ordering is an agent-owned comprehension task, and the deterministic baseline
// remains the fallback whenever the agent order is rejected or absent (the floor
// doctrine). Ordering is LOGICAL, never danger/blast-radius/salience.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The `ordering` body: a comprehension reading order over the chunk ids of an
 * admitted decomposition, plus a required rationale. `readingOrder` references
 * ONLY chunk ids the decomposition declared (no minted identity — V112) and
 * orders every one of them exactly once (totality — V111). Admitted atomically;
 * the rationale is required (V113). This is a flat order over the chunk set; the
 * richer within-cohort element ordering for the decisions lens is a later slice
 * and is an additive extension of this shape.
 */
export interface OrderingBody {
  readingOrder: string[];
  rationale: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Roll-up narration (issue #70, Model Council job M22)
//
// The zoom ladder's own voice: every altitude above a single chunk — the whole
// changeset (rollup), each grouping (group), each cohort — gets a one-line + one-
// paragraph narrated account so "approve at ANY granularity" is an INFORMED act at
// every granularity. Narration is a light-tier, batched, council-routed model job
// (rollup-narration); its document is validator-admitted like any other, and its
// optional code citations are byte-verified by the generic `{anchor, quote}` walk
// (V006), where the anchor is a real `rennet:` code anchor in the offered manifest.
//
// The `anchor` on a narration ENTRY is a canvas-node key (a cohortKey, a group
// key, or the rollup key), NOT a `rennet:` code anchor — the code-anchor walk
// ignores it, and node coverage (every offered node narrated once, only offered
// nodes, altitude consistent) is enforced by the RUNNER against the live node set,
// exactly as the ordering pass enforces its dependency floor outside the validator.
// ─────────────────────────────────────────────────────────────────────────────

/** The altitude a narration entry accounts for. `rollup` is the whole changeset. */
export type NarrationAltitude = "rollup" | "group" | "cohort";

/**
 * One narrated account at one altitude. `anchor` is the canvas-node key it is
 * about (the rollup key, a group key, or a cohortKey — a plain node key, never a
 * `rennet:` code anchor). `oneLine` is the collapsed-view sentence; `paragraph`
 * is the expanded account. `evidence` optionally cites code, byte-verified.
 */
export interface NarrationEntry {
  altitude: NarrationAltitude;
  anchor: string;
  oneLine: string;
  paragraph: string;
  evidence?: NarrationEvidence[];
}

/** The `rollup-narration` body: the batch of per-altitude narrated accounts. */
export interface RollupNarrationBody {
  narrations: NarrationEntry[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Canvas state model (issue #10)
//
// A canvas is a named, addressable, LAYERED projection over the event store,
// scoped to (reviewId, patchsetId, angle). Every element on a canvas is anchored
// to code or to an admitted RSP document; the canvas is a pure projection and is
// rebuildable from the store at any time (projections are disposable, R17).
//
// Four layers encode the actor partition STRUCTURALLY:
//   L0 substrate   — deterministic ingest owns it; read-only above.
//   L1 analysis    — validator-admitted RSP documents, deterministically placed.
//                    Fleet agents never touch a canvas; the layer adds zero
//                    fabrication surface. Elements reference admitted docs by
//                    docId + anchor and MINT NO IDENTITY.
//   L2 disposition — USER-SOVEREIGN. No agent, including the orchestrator, may
//                    write it (enforced by command-surface composition in core).
//   L3 annotation  — the orchestrator's marks, session-scoped ephemeral,
//                    user-pinnable; can never alter L1/L2/cohorts/ordering.
// The blast-radius OVERLAY paints amber onto the other canvases and owns no
// surface of its own; it is never a layer anyone writes.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The five canvas angles. `blast-radius` is deliberately NOT here: it is an
 * overlay, not a canvas (Canvas Paradigm §1 — promoting it to a sixth canvas
 * would silently turn the overlay into a writable queue).
 */
export type CanvasAngle = "spec" | "sequence" | "decisions" | "noise" | "flagged";

/** The canvas angles as a frozen list, in a stable order. */
export const CANVAS_ANGLES: readonly CanvasAngle[] = [
  "spec",
  "sequence",
  "decisions",
  "noise",
  "flagged",
] as const;

/**
 * The canvas-facing shape of a decision. `decisionId`, `anchor`, and `title` are
 * all the projector needs for PLACEMENT (grouping by anchored chunk — the chunk's
 * title IS the theme label the lens shows, e.g. "Storage and state"); the richer
 * fields (issue #137) are an ADDITIVE superset the surface renders: the evidence
 * chips a decision was drawn from, an optional reconstructed why, and the
 * alternatives not taken where the diff or PR body made them discernible.
 */
export interface DecisionRecordElement {
  decisionId: string;
  anchor: string;
  title: string;
  evidence?: DecisionEvidence[];
  why?: DecisionWhy;
  alternatives?: string[];
}

/** The `decision.record` body as consumed by the decisions-canvas projector. */
export interface DecisionRecordBody {
  decisions: DecisionRecordElement[];
}

/**
 * The Decisions runner's per-review status (issue #137), mirroring `FlaggedReview`.
 * A review that RAN and discerned no decisions is honestly empty; a runner that
 * FAILED to run is a different state and must never be conflated with "no
 * decisions". The live decision-extraction runner (deferred, depends on #136's
 * intent capture) sets this; until then it is `ok` behind the fixture.
 */
export type DecisionsRunStatus = { status: "ok" } | { status: "failed"; reason: string };

// ─── The `finding` doc family + the Flagged lens (issue #138) ─────────────────
//
// A `finding` is one thing the automated review layer raised: a model-council
// finding, or a dual-review agreement/disagreement. It carries a severity, an
// agreement state (both models concur, with vote counts; or they disagree, with
// each model's answer shown side by side and labelled), and an anchor. The
// Flagged lens is the INDEX over these — it points at the mark at its anchor, it
// does not own it. This shape is deliberately small and stable (like
// `DecisionRecordElement`); the richer #32 finding schema is an additive superset.

/** A flag's severity. Three levels; ordered high → medium → low for the lens. */
export type FindingSeverity = "high" | "medium" | "low";

/**
 * Whether the models agree on a flag. `concur` carries the vote counts (e.g. 3 of
 * 3); `disagree` carries each model's answer, shown side by side and labelled. The
 * disagreement flare lives HERE in the index, never as a chat interruption or a
 * synthesis block.
 */
export type FindingAgreement =
  | { kind: "concur"; agree: number; total: number }
  | {
      kind: "disagree";
      answers: FindingModelAnswer[];
      /**
       * The cross-harness adjudication verdict (issue #41), when the adjudication
       * pass ran on this contested row. ADDITIVE and OPTIONAL: a disagree row without
       * it validates and renders exactly as before — both seats' verbatim answers,
       * no third opinion. When present it is an informational third opinion beside
       * those answers ("code supports Claude", "code contradicts this flag", or an
       * honest "could not adjudicate"). It NEVER drops, hides, or reorders the row,
       * and no render or publish path waits on it (Rule Zero).
       */
      adjudication?: FindingAdjudication;
    };

/**
 * The cross-harness adjudication verdict (issue #41). When two harness seats
 * disagree, an explicit adjudication turn on the Model Council's `adjudication`
 * seat asks the real code who is right: `supported` (the code evidences the flagged
 * claim), `contradicted` (the code refutes it), or `insufficient` (neither could be
 * established — a genuine unknown, a failed/guarded turn, the per-review cap, or an
 * exhausted budget, each with its honest reason). Deliberately NOT reusing
 * `FindingVerdict`: reproduced/refuted carries a DROP semantic, and a contested row
 * must NEVER drop on any verdict — a distinct vocabulary keeps the no-drop rule
 * structural rather than a convention someone can forget.
 */
export type FindingAdjudicationVerdict = "supported" | "contradicted" | "insufficient";

/**
 * The verdict of a per-finding reproduce-or-refute verification (issue #179). A
 * fresh session — by default a different seat than the one that raised the finding
 * — is fed the REAL code around the anchor (more than the offered hunk) and asked
 * to REPRODUCE the claim (cite the concrete failure path or the exact lines that
 * make it true), REFUTE it (show why it does not hold), or, if it can establish
 * neither, return INCONCLUSIVE. The disposition is load-bearing and asymmetric: a
 * `refuted` finding is DROPPED before the lens (the anti-hallucination-of-substance
 * gate), a `reproduced` finding surfaces with its evidence, and an `inconclusive`
 * finding surfaces WITH an honest caveat and is NEVER silently dropped — a dead or
 * uncertain verifier must never read as an all-clear (Rule 75/81ak: could-not-check
 * beats a false clear, because for a claim of a PROBLEM the silent drop fails toward
 * hiding a real bug).
 */
export type FindingVerdict = "reproduced" | "refuted" | "inconclusive";

/** Maximum bytes `review.uiEvidence` will read for one screenshot. */
export const MAX_UI_EVIDENCE_BYTES = 8 * 1024 * 1024;

/** Maximum screenshot references retained from one verify-ui turn. */
export const MAX_UI_SCREENSHOTS_PER_RUN = 12;

/** Maximum wire length of an 8 MiB screenshot encoded as a data URL. */
export const MAX_UI_EVIDENCE_DATA_URL_LENGTH = Math.ceil(MAX_UI_EVIDENCE_BYTES / 3) * 4 + 64;

/**
 * The additive verify-ui status (issue #183) that rides an `ok` FlaggedReview. It
 * is INFORMATIONAL and never a gate (Rule Zero): sign and publish behave exactly
 * as they would without it. The four states are kept DISTINCT on purpose, and the
 * asymmetry is load-bearing (Rule 75/81ak, could-not-check beats a false clear):
 *
 *   • `ran`         — the turn mounted (or statically reviewed) the change and
 *                     produced observations (surfaced as ordinary findings) plus any
 *                     `screenshots`. `mounted` is false when the turn could only do a
 *                     labelled static review (no screenshot claimed).
 *   • `pending`     — MAIN scheduled the slow late pass; immediate findings render,
 *                     but an empty result is not yet a full all-clear.
 *   • `not-ui`      — the deterministic classifier found no UI-surface file, so no
 *                     turn ran and nothing was spent. This is "not applicable", NOT
 *                     an all-clear.
 *   • `unavailable` — the turn could not run or could not mount (no verifier, the
 *                     shared budget was exhausted, or the turn failed/returned
 *                     nothing usable). `reason` says which. This is disclosed as
 *                     inconclusive, NEVER reported as "no UI problems found".
 */
export type UiVerification =
  | {
      status: "ran";
      classifierVersion: number;
      screenshots: UiScreenshot[];
      observationCount: number;
      mounted: boolean;
    }
  | { status: "pending"; classifierVersion: number }
  | { status: "not-ui"; classifierVersion: number }
  | { status: "unavailable"; classifierVersion: number; reason: string };

/**
 * Attribution of a failing CI check. Uncertainty is always `unclassified`, never
 * `environmental`: an unknown failure stays visible instead of being waved away
 * as infrastructure.
 */
export type CiFailureVerdict = "change-caused" | "environmental" | "unclassified";

/** Informational CI state for the pinned head under review. Never a review gate. */
export type CiSignal =
  | {
      status: "checked";
      overall: "passing" | "failing" | "pending";
      failures: CiFailure[];
      headOid: string;
      incomplete: boolean;
    }
  | { status: "no-checks"; headOid: string }
  | { status: "unavailable"; reason: string };

/** The `finding` doc body as consumed by the flagged-canvas projector. */
export interface FindingBody {
  findings: FindingElement[];
}

/**
 * The Flagged lens's per-review input, behind the typed boundary. A review that
 * RAN and found nothing (`ok` with an empty `findings`) is honestly empty; a
 * runner that FAILED (`failed`, with a reason) is a different state and must never
 * be conflated with "no findings". This distinction is load-bearing for the lens.
 *
 * The optional `dual` note (issue #41) records how the review was produced — a
 * single seat, or two provider seats reconciled into agreement/disagreement. It is
 * additive: an `ok` review with no `dual` is exactly the pre-#41 shape.
 *
 * The optional `crossChecks` (issue #181) is the predicted-risk cross-check: each
 * risk the hypothesis predicted, reconciled against the FINAL surfaced findings —
 * `confirmed` (a finding addressed it) or `open` (predicted but no finding covered
 * it, the anti-rubber-stamp payoff the human must check themselves). Computed by
 * the deterministic `crossCheckRisks` (NO model turn), on the findings AFTER
 * verification (a refuted, dropped finding must never mark a risk handled). It is
 * additive and present only when a hypothesis was produced: a review with no
 * hypothesis omits it, exactly the pre-#181 shape, and never fabricates coverage.
 */
export type FlaggedReview =
  | {
      status: "ok";
      findings: FindingElement[];
      dual?: DualReviewNote;
      crossChecks?: readonly RiskCrossCheck[];
      ciSignal?: CiSignal;
      /**
       * The committed hypothesis (issue #178) that produced this review, carried so
       * the surface can fold the reader's reading frame. It rides ALONGSIDE
       * `crossChecks` on purpose: the cross-check reconciles THIS hypothesis's risks
       * (matched by the per-pass-minted `riskId`) against the findings, so the frame
       * must be built from the SAME hypothesis or every risk would fall back to
       * `open`. Additive and present only when a hypothesis was produced: a review
       * with no hypothesis omits it, exactly the pre-#178 shape.
       */
      hypothesis?: ReviewHypothesis;
      /**
       * The active patchset this flagged result was computed against (issue #160/P0-2),
       * stamped by the command boundary. The renderer binds the result to the canvases
       * it is displayed beside: a REGENERATE activates a new patchset under the same
       * review id, and the flagged result (findings, hypothesis, cross-check) goes stale
       * as a unit. Without this the new diff could render beside the OLD flagged result —
       * internally consistent, about the wrong diff. Additive: absent ⇒ unbound (the
       * pre-#160 shape); the effect-level clear-and-refetch is the primary guard, this is
       * the structural belt-and-braces.
       */
      patchsetId?: string;
      /**
       * Incomplete-ingestion blockers (R18, issue #309), stamped by the flagged
       * runner from the deterministic `decompose()` it already computes. Non-empty
       * means some captured content (a truncated tail, a binary blob, or a submodule
       * pointer) was NOT ingested, so an absence of findings over it is not an
       * all-clear. The Flagged lens and PublishSheet disclose it as render-only
       * honest copy — it NEVER gates the sign (Rule Zero). Additive: absent ⇒ the
       * pre-#309 shape.
       */
      blockingStates?: readonly DecompositionBlockingState[];
      /**
       * The verify-ui status (issue #183), when a UI-touching changeset ran the
       * pass. Additive and optional: a review without it validates and renders
       * exactly as before this capability (a non-UI changeset omits it, or carries
       * `not-ui`). Its observations surface as ordinary `findings` above — this
       * field only carries the pending/ran/not-ui/unavailable status and the screenshot
       * references. It NEVER gates the sign (Rule Zero).
       */
      uiVerification?: UiVerification;
      /**
       * MAIN scheduled a non-blocking enrichment for this exact review/patchset/mode.
       * The renderer polls the late channel whenever this is true; it is independent
       * of whether any row needs adjudication. Transient and informational only.
       */
      lateEnrichmentScheduled?: true;
    }
  | {
      status: "failed";
      reason: string;
      ciSignal?: CiSignal;
      /** The active patchset this failed result was computed against. See the `ok` variant. */
      patchsetId?: string;
      /** Incomplete-ingestion blockers (R18, issue #309). See the `ok` variant; stamped even on a failed run because blocked ingestion is deterministic, not a model result. */
      blockingStates?: readonly DecompositionBlockingState[];
    };

// ─── review.ask: ask the AI a question, one model or both (issue #139) ────────
//
// When the reviewer asks a question ABOUT the review, it goes to the ORCHESTRATOR
// — the one model they converse with — by DEFAULT. A per-message affordance lets
// them ask BOTH models instead, and then two labelled answers arrive side by side
// and the reviewer decides for themselves. The load-bearing invariant (Rai, #139):
// there is NO synthesis block, NO auto-merge, EVER, and nothing fires to a second
// model behind the reviewer's back. These shapes carry that law: the response can
// hold at most a `primary` (always the orchestrator) plus a `secondOpinion`
// (Codex, ONLY in "both" mode) — it has no field for a third, merged answer, so
// the invariant is structural, not merely a convention.

/** Which minds answer a review question. Default "orchestrator" — one model. */
export type AskMode = "orchestrator" | "both";

// ─── review.refine: the comment-refinement loop's result (issue #19) ──────────
//
// Rai's headline feature: a rough review note refined into a clean comment by a
// real model turn. The wire result the renderer adopts (or doesn't). `refined`
// carries a body GUARANTEED non-empty and not byte-identical to the raw (the
// producer enforces it); `no-change` means the raw was already clear (it posts
// unchanged); `unavailable`/`failed` are honest states the UI shows plainly while
// the raw stays the effective body — the loop failing means worse prose, never a
// silent rewrite and never lost review work. `model` rides the two success states
// for provenance (there is NO AI-attribution marker on the POSTED comment).
export type RefinementResult =
  | { readonly status: "refined"; readonly refined: string; readonly model: string }
  | { readonly status: "no-change"; readonly model: string }
  | { readonly status: "unavailable"; readonly reason: string }
  | { readonly status: "failed"; readonly reason: string };

// ─── review.draftPrBody: the PR title/body drafting result (issue #74, M26) ────
//
// The own-branch destination's PR-submission preview (#22) needs a title + body.
// A light-tier, council-routed model turn drafts them from the reviewed changeset
// — the roll-up narration, the staged dispositions' resolutions, the spec angle's
// requirements, the decisions surfaced — so the body reads as an HONEST ACCOUNT of
// the change rather than a diffstat. The draft is a STARTING POINT handed to the
// human, never an act: the human edits it, and the edited form is what a later,
// separate, explicit create act (#21) would use. Nothing here posts, pushes, or
// otherwise egresses (R33) — drafting only produces text into a preview.
//
//   - `drafted`      — the turn produced a non-empty title AND body (the producer
//                      enforces both non-empty; an empty title or body is `failed`,
//                      never a blank preview). `model` records who wrote the draft.
//   - `unavailable`  — no model seat is installed to draft with (the deterministic
//                      fallback body still previews; the UI says so plainly).
//   - `failed`       — a turn ran and did not produce a usable title+body.
//
// Like `RefinementResult`, the shape has NO field for a fabricated success: a
// failed draft returns an honest state, and the preview keeps the deterministic
// composed body, never a blank the human might sign unread.
export type PrBodyDraftResult =
  | {
      readonly status: "drafted";
      readonly title: string;
      readonly body: string;
      readonly model: string;
    }
  | { readonly status: "unavailable"; readonly reason: string }
  | { readonly status: "failed"; readonly reason: string };

// ─── review.deltaDigest: the light-tier prose over the delta account (#73/M25) ─
//
// The deterministic delta account (N2, `DeltaAccount`) is the ground truth: per-ask
// addressed/partially/untouched + the paths changed beyond the asks. This is the
// optional light-tier LLM rephrasing of that account into a one/two-sentence
// plain-English TL;DR, rendered ON TOP of the facts (never replacing them). The
// prose adds NO fact the account does not carry — it is built only from the account,
// so a scope-creep detector's headline cannot hallucinate. Like `PrBodyDraftResult`,
// the shape has NO field for a fabricated success:
//   - `drafted`     — the turn produced a non-empty digest. `model` records who wrote it.
//   - `unavailable` — no model seat is installed / the review carries no delta account.
//   - `failed`      — a turn ran and produced no usable text.
// On anything but `drafted` the panel simply shows no headline and the facts are
// unchanged — an honest "no summary this time", never a blank card and never a guess.
export type DeltaDigestResult =
  | { readonly status: "drafted"; readonly text: string; readonly model: string }
  | { readonly status: "unavailable"; readonly reason: string }
  | { readonly status: "failed"; readonly reason: string };

// ─── review.hypothesis: the hypothesis-first pre-read pass (issue #178) ────────
//
// Florence's single most load-bearing anti-rubber-stamp move: BEFORE the lens
// runners read a hunk, the system commits to what this change SHOULD be — its
// Domain, its in/out Scope, the Design it would have chosen, and 5-10 concrete
// Risks it would look for — from the change's stated intent + structure + repo
// context, NOT the full hunk bodies (a genuine prior, not a diff summary). The
// committed hypothesis then feeds every lens runner as a labelled disconfirmation
// layer ("did the author diverge from what we'd have done") and surfaces to the
// human as their reading frame. These shapes are additive: nothing here changes an
// existing field, so documents stamped before this change validate unchanged.

/**
 * The change's stated intent, widening the live `DecisionIntent` seam the
 * Decisions runner already consumes. Every field is optional: absent, the pass
 * reasons over structure and repo context alone (a degraded but honest read). The
 * #136 frozen-immutable-snapshot capture is deferred; this is the live seam.
 */
export interface ReviewIntent {
  readonly prTitle?: string;
  readonly prBody?: string;
  readonly spec?: string;
}

/**
 * A compact, node-free projection of the ProjectSnapshot the Repo-Map builds,
 * handed to the hypothesis pass by the composition root (which reads the snapshot
 * through the `context.map`/`context.file` backend — the pass never touches the
 * store). Absent or a typed refusal degrades the pass to intent + structure alone;
 * it is never fabricated.
 */
export interface HypothesisRepoFileContext {
  readonly path: string;
  /** A one-line note about what this file is / its role, when the snapshot has one. */
  readonly summary?: string;
}

export interface HypothesisRepoContext {
  /** A short account of the repo / area the change touches (conventions, neighbours). */
  readonly summary?: string;
  /** The changed files with what-they-are context, when the snapshot serves it. */
  readonly files?: readonly HypothesisRepoFileContext[];
}

/**
 * The change's structure the pass sees INSTEAD of the hunk bodies: the changed
 * file list and the decomposition chunk titles. This is what keeps the prior
 * genuine — the pass forms expectations from the shape of the change, not from the
 * code it is meant to check.
 */
export interface HypothesisStructure {
  readonly changedFiles: readonly string[];
  readonly chunkTitles: readonly string[];
}

/**
 * One risk the pass predicts: a concrete failure mode to look for, its severity
 * (the closed high|medium|low vocabulary, reused from findings), and the
 * disconfirmer — the check a lens runner applies ("did the author diverge from
 * what we'd have done"). `riskId` is minted by the PASS (agents never mint
 * identity), so the model-facing emission omits it and the runner stamps it.
 */
export interface HypothesisRisk {
  readonly riskId: string;
  readonly statement: string;
  readonly severity: FindingSeverity;
  readonly disconfirmer: string;
}

/** The in/out scope the change is expected to cover. */
export interface HypothesisScope {
  readonly inScope: readonly string[];
  readonly outOfScope: readonly string[];
}

/**
 * The `review.hypothesis` document body: the committed prior. An atomic doc — any
 * body error rejects the whole document (a half-formed hypothesis is not a
 * hypothesis). `risks` is validator-bounded to 5-10.
 */
export interface ReviewHypothesisBody {
  readonly domain: string;
  readonly scope: HypothesisScope;
  readonly designExpectation: string;
  readonly risks: readonly HypothesisRisk[];
}

/**
 * The Flagged lens's per-review hypothesis input, behind the typed boundary. A
 * pass that RAN and produced a hypothesis (`ok`) is strictly apart from one that
 * FAILED (`failed`, with a reason) — a failed pass is "no hypothesis," never an
 * empty-but-successful one. This mirrors the `FlaggedReview` distinction exactly.
 */
export type HypothesisPass =
  | { status: "ok"; hypothesis: ReviewHypothesis }
  | { status: "failed"; reason: string };

// ─── The per-project convention / anti-pattern catalogue (issue #180) ─────────
//
// Florence's /review-pr agents carry an injected anti-pattern + convention
// checklist that shapes what they flag; Rennet's lens runners did not. This is
// the per-project catalogue, injected into every lens runner as a labelled
// checklist layer (mirroring the hypothesis disconfirmation layer, #178). It is
// sourced from an OPTIONAL per-project file by an adapter; absent or empty it
// degrades honestly to no layer and the runners assemble byte-identically to
// before. The load-bearing product rule (#180): a finding that fires on a
// convention reports the underlying REASON in plain language, never a rule
// number — so the catalogue carries the reason next to the convention, and the
// author-facing `id` is NEVER shown to the model (surfacing it would invite a
// rule-number citation).

/**
 * One project convention or anti-pattern a lens runner checks the change against.
 * `convention` states, in plain language, what the project expects; `rationale`
 * is WHY it matters — the underlying reason a finding reports instead of a rule
 * number. `severity` reuses the findings vocabulary (how heavily a violation
 * weighs); `antiPattern` names what a violation looks like, when the author
 * states it. `id` is for authoring / dedup only and is deliberately NOT injected
 * into the prompt.
 */
export interface ConventionRule {
  /** Author-facing stable id for dedup / reference. NOT rendered into the prompt. */
  readonly id?: string;
  /** The convention in plain language: what the project expects. */
  readonly convention: string;
  /** Why it matters — the underlying reason a finding reports (never a rule number). */
  readonly rationale: string;
  /** The findings severity vocabulary: how heavily a violation weighs. */
  readonly severity: FindingSeverity;
  /** What a violation looks like, when the author states it. Optional. */
  readonly antiPattern?: string;
}

/**
 * The per-project convention / anti-pattern catalogue (#180), injected into every
 * lens runner as a labelled checklist layer. Sourced from an optional per-project
 * file; absent, empty, or with no valid rules it degrades honestly to no layer.
 * `source` is a human-readable provenance note (e.g. the file path it was read
 * from), for the reading frame and telemetry — never model-facing.
 */
export interface ConventionCatalogue {
  readonly rules: readonly ConventionRule[];
  /** Where the catalogue came from (e.g. the file path). Optional provenance. */
  readonly source?: string;
}

// ─── The `noise` doc family + the Noise lens (issue #34) ──────────────────────
//
// The Noise lens groups the low-signal churn a changeset touches — formatting,
// lockfile regeneration, import reordering, generated output, fixture renames,
// comment typos — AWAY from the code that needs eyes. Each group is collapsed
// under a plain-speech one-line summary, tagged with HOW it was judged (a
// deterministic mechanical RULE, or the LLM NOISE JOB), and is pull-back-able:
// nothing is silently hidden, only grouped, and any group can be reopened into
// the main review. This shape is deliberately small and stable (like
// `FindingElement`); the live noise-classification runner (deferred) will emit it.

/**
 * The kind of churn a noise group collects. A CLOSED vocabulary matching the
 * lens's plain-speech categories; `other` is the honest catch-all so a group is
 * never forced into a wrong bucket to be placed (totality over tidiness).
 */
export type NoiseCategory =
  | "formatting"
  | "lockfile"
  | "import-order"
  | "generated"
  | "fixture-rename"
  | "comment-typo"
  | "other";

/**
 * How a noise group was judged, shown per group as a chip (issue #34). A `rule`
 * chip is a deterministic mechanical rule (the formatter, the lockfile path, an
 * import-order AST check) — mechanical CERTAINTY; a `noise-job` chip is the LLM
 * noise job's call over the ambiguous remainder — a MODEL's judgment. The two are
 * kept distinct so a reviewer can tell settled-by-machine from settled-by-model.
 */
export type NoiseJudgedBy = { kind: "rule"; rule: string } | { kind: "noise-job"; model: string };

/**
 * The `noise` doc body (docType `noise`, issue #34): the live noise-classification
 * runner's structured output, consumed by the noise-lens derivation. The runner
 * (`runNoiseAngle`) emits it, culls each group's churn items to the GROUNDED ones
 * (an anchor that resolves to an offered hunk), mints the `groupId`, and stamps the
 * `noise-job` chip's `model` — so identity and the model label are the runner's,
 * never the model's to assert (mirroring the finding/decision runners).
 */
export interface NoiseBody {
  groups: NoiseGroup[];
}

/**
 * The Noise lens's per-review input, behind the typed boundary (issue #34). A
 * review that RAN and grouped nothing (`ok` with empty `groups`) is honestly empty;
 * a runner that FAILED (`failed`, with a reason) is a different state and must never
 * be conflated with "no noise" — an all-clear that masks a runner that never ran is
 * the exact lie the empty-vs-failed distinction refuses. The live noise-classification
 * runner (`runNoiseAngle`, #34) sets this: `ok` with the grounded groups it emitted,
 * or `failed` with the reason on a budget refusal or terminal turn failure.
 */
export type NoiseReview =
  | { status: "ok"; groups: NoiseGroup[] }
  | { status: "failed"; reason: string };

/** L0 substrate layer: read-only, owned entirely by deterministic ingest. */
export interface SubstrateLayer {
  chunks: SubstrateChunkRef[];
}

/**
 * L1 analysis layer. `elements` are in canvas order; `cohorts` group them for the
 * decisions canvas (empty for the flat canvases); `readingOrder` is the ordered
 * list of cohort keys (decisions) or element keys (flat) the canvas presents.
 */
export interface AnalysisLayer {
  elements: AnalysisElement[];
  cohorts: AnalysisCohort[];
  readingOrder: string[];
}

/** L2 disposition layer: the user's dispositions relevant to this canvas. */
export interface DispositionLayer {
  dispositions: Disposition[];
}

/** The orchestrator's L3 mark kinds (glass — chrome, visually distinct). */
export type AnnotationKind = "highlight" | "callout" | "link";

/** The kinds of proposal the orchestrator may raise (a suggestion — user decides). */
export type ProposalKind = "disposition" | "regroup" | "split";

/** A proposal's lifecycle: pending until the user accepts or dismisses it. */
export type ProposalStatus = "pending" | "accepted" | "dismissed";

/** L3 annotation layer: the orchestrator's marks and proposals. */
export interface AnnotationLayer {
  annotations: Annotation[];
  proposals: Proposal[];
}

/**
 * The blast-radius signals (issue #35). A signal is a deterministic, one-line-
 * explainable reason a change carries risk. Blast radius is PAINT: it MARKS these,
 * it never gates, reorders, or withholds anything (Rule Zero). `fan-in` and
 * `contract-surface` are deferred in the first slice and surfaced as NOT ASSESSED
 * so their absence never reads as "checked and clear".
 */
export type BlastRadiusSignal =
  | "deletions"
  | "irreversibility"
  | "codeowners"
  | "safety-net"
  | "fan-in"
  | "contract-surface";

/** The per-element real diff map, keyed by `AnalysisElement.elementKey` (issue #60). */
export type ElementDiffs = Record<string, ElementDiff>;

/**
 * The placement of narration at ONE canvas node (issue #70). Delivered ALONGSIDE
 * the canvas set (like `ElementDiffs`), never embedded on the `Canvas`, so the
 * canvas projection stays byte-identical for replay. Every visible node above a
 * chunk resolves to a placement — `narrated` when an account was admitted, else an
 * HONEST `pending`/`failed` state, NEVER a silent blank (the acceptance floor).
 *
 *   - `narrated`: an admitted account is present (oneLine + paragraph).
 *   - `pending`:  no model turn ran (budget refused, no executor, or not enabled).
 *   - `failed`:   a turn ran but its narration was terminally rejected.
 */
export type NarrationPlacement =
  | { status: "narrated"; oneLine: string; paragraph: string; evidence?: NarrationEvidence[] }
  | { status: "pending" }
  | { status: "failed" };

/**
 * A canvas-scoped post-commit change notification (R35's ONE change feed, canvas
 * half). Keyed `(reviewId, canvasId, elementKey)` with the covering `seqRange`;
 * a conflated notification names the seq range it covers. This is an
 * INVALIDATION HINT — truth stays the store; a consumer that misses one
 * re-queries the projection. Never a raw event; never a private row.
 */
export interface CanvasChangeNotification {
  reviewId: string;
  canvasId: string;
  elementKey: string;
  seqRange: { from: number; to: number };
}

// ─────────────────────────────────────────────────────────────────────────────
// The Model Council (issue #69)
//
// The named subsystem that decides which mind does which job. This file carries
// its VOCABULARY: the model set, the tiers, the availability scenarios, the
// versioned job-catalogue entry shape, the user-override shape, the resolution
// result and its inspectable trace, and the live invocation-budget contract. The
// catalogue data, the three assignment tables, and the pure `resolveAssignment`
// resolver live in `@rennet/core` (`model-council.ts`); the budget closure lives
// in `@rennet/core` (`invocation-budget.ts`). Doc authority:
// `docs/developing/concepts/model-council.md`.
// ─────────────────────────────────────────────────────────────────────────────

/** The provider a council model belongs to. Determines the harness it runs on. */
export type CouncilProvider = "claude" | "codex";

/**
 * The council model set (Model Council §3). Claude: Haiku / Sonnet 5 / Opus 4.8.
 * Codex: GPT-5.5 / 5.6-Sol / 5.6-Terra / 5.6-Luna. Adding a model is a schema
 * edit here plus a table edit in `@rennet/core`.
 */
export type CouncilModel =
  | "haiku"
  | "sonnet-5"
  | "opus-4.8"
  | "gpt-5.5"
  | "gpt-5.6-sol"
  | "gpt-5.6-terra"
  | "gpt-5.6-luna";

/**
 * The effort knob. `low`/`medium`/`high`/`xhigh` is the Codex effort; thinking
 * budget is the analogous Claude knob. `xhigh` is the divergence-triggered
 * self-consistency ceiling only.
 */
export type CouncilEffort = "low" | "medium" | "high" | "xhigh";

/**
 * The tier test (Model Council §1): does this task need to look at code it was
 * not given? Input fully enumerable -> `light`; the model must go find something
 * -> `heavy`; a tool can be 100% right -> `deterministic` (no model at all).
 */
export type CouncilTier = "light" | "heavy" | "deterministic";

/** The three canonical availability scenarios that key the assignment tables. */
export type CouncilScenario = "both" | "claude-only" | "codex-only";

/**
 * The batching shape of a model-facing job. `session-rider` marks a heavy job
 * that rides another job's session (its assignment granularity is the seat, not
 * the call). `none` is the deterministic floor's shape.
 */
export type CouncilBatching = "per-call" | "batched" | "session-rider" | "none";

/**
 * The harness a council model runs on. Codex models run on `codex`; Claude
 * models on `claude-code`. This is how the resolver NAMES a Codex seat (#66)
 * without building it — a subset of the core `HarnessId`.
 */
export type CouncilHarnessId = "claude-code" | "codex";

/** A single model+effort pick from an assignment table. */
export interface CouncilPick {
  readonly model: CouncilModel;
  readonly effort: CouncilEffort;
}

/** A stable job id in the versioned catalogue. */
export type CouncilJobId = string;

/**
 * One catalogue entry: WHAT the job is (its tier, batching shape, and whether it
 * rides another session) — never WHICH model, which is the assignment table's
 * job. Shipped versioned like a schema; job ids are stable.
 */
export interface CouncilJob {
  readonly jobId: CouncilJobId;
  readonly tier: CouncilTier;
  readonly batching: CouncilBatching;
  /** True when the job rides another job's session (granularity is the seat). */
  readonly sessionRider: boolean;
  /** Optional matrix row number, purely for the resolution-trace flavour. */
  readonly row?: number;
  readonly label: string;
}

/** Which harnesses are installed (the availability probe result). */
export interface CouncilAvailability {
  readonly installed: readonly CouncilHarnessId[];
}

/**
 * A per-field override. Sets `model` and/or `effort` only — harness is NOT
 * overridable (#89): it always derives from the resolved model's provider, so no
 * override can produce a model/harness pair that names different providers.
 */
export interface CouncilOverridePick {
  readonly model?: CouncilModel;
  readonly effort?: CouncilEffort;
}

/**
 * User overrides (all personal, never shareable). `task` keys by jobId
 * (routing.task.<jobId>); `tier` keys by tier (routing.tier.<tier>). The #28
 * settings keys deserialise into exactly this shape — the override layer is
 * supported by construction so #28 attaches without a core change.
 */
export interface CouncilOverrides {
  readonly task?: Readonly<Record<CouncilJobId, CouncilOverridePick>>;
  readonly tier?: Partial<Readonly<Record<CouncilTier, CouncilOverridePick>>>;
}

/** The ultimate fallback (resolution order step 4: the harness's own default). */
export interface CouncilHarnessDefault {
  readonly harness: CouncilHarnessId;
  readonly model: CouncilModel;
  readonly effort: CouncilEffort;
}

/** The context `resolveAssignment` resolves against. */
export interface CouncilResolveContext {
  readonly availability: CouncilAvailability;
  readonly overrides?: CouncilOverrides;
  readonly harnessDefault?: CouncilHarnessDefault;
}

/** Which layer of the resolution order won. */
export type ResolutionSource =
  | "task-override"
  | "tier-override"
  | "council-table"
  | "harness-default"
  | "degraded";

/**
 * The structured, inspectable trace of one resolution — "why did this job run on
 * that model." The `summary` is the one-line string the UI can show; an override
 * is only usable if the resolution it overrides is visible.
 */
export interface ResolutionTrace {
  readonly jobId: CouncilJobId;
  readonly tier: CouncilTier;
  readonly scenario: CouncilScenario | "degraded";
  readonly source: ResolutionSource;
  /** True when a light job was placed on a different harness than the review (R39). */
  readonly crossHarness?: boolean;
  readonly row?: number;
  readonly summary: string;
}

/**
 * The result of resolving a job. A model-facing job resolves to a `model` result
 * with its harness/model/effort; a deterministic-tier job resolves to a
 * `deterministic` result with a trace and NO model, so reading a model off a
 * deterministic resolution is a type error.
 */
export type CouncilResolution =
  | {
      readonly kind: "model";
      readonly harness: CouncilHarnessId;
      readonly model: CouncilModel;
      readonly effort: CouncilEffort;
      readonly trace: ResolutionTrace;
    }
  | { readonly kind: "deterministic"; readonly trace: ResolutionTrace };

// ── The live invocation budget (issue #69, fixes bead p0wwp) ──────────────────

/** The stable code for a runtime budget refusal (R10, the money ceiling). */
export const R10_BUDGET_EXHAUSTED = "R10_BUDGET_EXHAUSTED" as const;

/** The result of one `tryConsume` on the shared invocation budget. */
export type BudgetGrant =
  | {
      readonly granted: true;
      readonly purpose: string;
      readonly consumed: number;
      readonly remaining: number;
    }
  | {
      readonly granted: false;
      readonly code: typeof R10_BUDGET_EXHAUSTED;
      readonly purpose: string;
      readonly consumed: number;
      readonly max: number;
      readonly reason: string;
    };

/**
 * A shared runtime budget for model invocations. One is created per review and
 * threaded through every runner, so the first attempt AND every retry across
 * decomposition and ordering draw from the same ceiling — the live enforcement
 * of R10 the pre-flight route-plan count never provided (bead p0wwp). A refused
 * turn falls to the runner's deterministic floor rather than crashing, and
 * `refused` latches so the pipeline can surface an out-of-budget review as
 * degraded rather than let it present as a completed AI review (#260). A malformed
 * ceiling (`NaN`/`Infinity`/negative) is a caller defect, so it falls back to the
 * DEFAULT ceiling — never a fail-closed zero (which faked a review), never unbounded
 * (which would let a wiring bug spend without limit). A configured `0` is honored as
 * a deliberate "spend nothing" (#260).
 */
export interface InvocationBudget {
  readonly max: number;
  readonly consumed: number;
  readonly remaining: number;
  /** True once any turn was refused for a genuinely exhausted finite ceiling. */
  readonly refused: boolean;
  tryConsume(purpose: string): BudgetGrant;
}

// ── ProjectSnapshot (issue #14, Part 1) ──────────────────────────────────────
//
// The deterministic base-branch structural map. Pinned to the resolved
// default-branch OID; MODEL-FREE and BYTE-REPRODUCIBLE. Every structural fact is
// a pure function of the tree at `baseOid`, so an incremental rebuild of the
// changed-path closure is byte-identical to a clean full build (the load-bearing
// property that makes "never consume stale context" checkable). No LLM anywhere
// in this map; no clock in any serialized field (a timestamp would defeat
// reproducibility — freshness is fingerprint/content equality, never age).
//
// Storage is LOCAL-FIRST in an app-owned store keyed by the escaped absolute
// top-level PATH (`escapePath(realpath(git-top-level))`, R55/#141): each checkout
// path — including a worktree on a branch — keys its OWN entry, replacing wave-1's
// `realpath(git-common-dir)` which made all worktrees share one. Opt-in in-repo
// promotion, the knowledge layer, context.* tools, and multi-repo WorkspaceContext
// are deliberate follow-ups.

/**
 * The current ProjectSnapshot schema version. Bumped on any breaking shard shape
 * change. v2 (repo-map-symbolic-surface, #200) added the per-file REFERENCE index
 * (`manifest.references` + reference shards), a new manifest field the fingerprint
 * covers — so every v1 snapshot is stale under v2 and re-derives (the freshness
 * gate keys on `schemaVersion`), never served with a missing reference dimension.
 */
export const PROJECT_SNAPSHOT_SCHEMA_VERSION = 2;

/** How the pinned default-branch ref was resolved (most-authoritative first). */
export type BaseRefResolution =
  | "forge-metadata"
  | "symbolic-head"
  | "configured-upstream"
  | "explicit-setting";

/** A single tracked file in the tree at `baseOid`. Sorted by `path` in the shard. */
export interface SnapshotFileEntry {
  /** Repo-relative POSIX path. */
  readonly path: string;
  /** The git blob OID of the file's content at `baseOid`. Content identity. */
  readonly blobOid: string;
  /** Blob size in bytes. */
  readonly size: number;
  /** The git file mode, e.g. "100644", "100755", "120000" (symlink). */
  readonly mode: string;
}

/** A workspace scope (package / project), derived from the workspace tooling config. */
export interface WorkspaceScope {
  /** The package name (from package.json `name`), or the directory name if unnamed. */
  readonly name: string;
  /** Repo-relative POSIX path to the scope root. */
  readonly root: string;
  /** Repo-relative POSIX source root, when a `project.json` declares one. */
  readonly sourceRoot?: string;
  /** Nx `projectType` when a `project.json` declares one. */
  readonly type?: "library" | "application";
  /** Whether `package.json` marks the scope private. */
  readonly private: boolean;
  /** Nx tags, sorted, when a `project.json` declares them. */
  readonly tags: readonly string[];
}

/** A dependency edge between two workspace scopes (never a folder heuristic, #142). */
export interface DependencyEdge {
  /** The depending scope name. */
  readonly from: string;
  /** The depended-on scope name. */
  readonly to: string;
  /** `manifest` = a workspace: dependency in package.json; `implicit` = project.json implicitDependencies. */
  readonly kind: "manifest" | "implicit";
}

/** The entry surface a scope exposes, read from its `package.json`. */
export interface EntryPoint {
  /** The owning scope name. */
  readonly scope: string;
  readonly main?: string;
  readonly module?: string;
  readonly types?: string;
  /** The `exports` field, canonicalized; opaque JSON preserved verbatim. */
  readonly exports?: unknown;
  /** `bin` entries as name → path, sorted by name. */
  readonly bin: readonly (readonly [string, string])[];
}

/** A test file, classified from the file inventory by configured conventions. */
export interface TestEntry {
  readonly path: string;
  /** The owning scope name, or null if outside any scope. */
  readonly scope: string | null;
  /** The convention glob that matched. */
  readonly matchedBy: string;
}

/** A CODEOWNERS rule, in file order (order is significant — last match wins in git). */
export interface OwnershipRule {
  readonly pattern: string;
  readonly owners: readonly string[];
}

/** A configured convention input: a config file present at `baseOid`, content-addressed. */
export interface ConventionEntry {
  /** Repo-relative POSIX path of the config file. */
  readonly path: string;
  /** Content identity of the file at `baseOid` (its git blob OID — a pure function of the bytes). */
  readonly digest: string;
  /** A stable label for the kind of convention this file carries. */
  readonly kind:
    | "formatter"
    | "linter"
    | "typescript"
    | "workspace"
    | "nx"
    | "editorconfig"
    | "rennet"
    | "other";
}

/** A symbol extracted deterministically from a source file's bytes. */
export interface SnapshotSymbol {
  /** The declared name (`default` for a default export). */
  readonly name: string;
  /** The kind of declaration. */
  readonly kind:
    | "function"
    | "class"
    | "const"
    | "let"
    | "var"
    | "interface"
    | "type"
    | "enum"
    | "default"
    | "reexport";
  /** 1-based line of the declaration within the file. */
  readonly line: number;
}

/**
 * The per-file symbol shard, addressed by `blobOid` and content-addressed as a
 * PURE FUNCTION OF BLOB CONTENT — it carries no path. Because the same blob
 * yields byte-identical symbols under a fixed extractor, an unchanged blob yields
 * a byte-identical shard, so an incremental rebuild reuses it for free and a clean
 * full build recomputes the same bytes. This is what makes incremental==clean
 * hold for renames and same-content copies: a blob that moves path (rename) or is
 * shared by two paths (copy) resolves to the SAME shard regardless of path. The
 * path a shard belongs to is recovered from the `files` structural shard, which
 * lists `path → blobOid`; a blob shared by N paths is one shard referenced N times.
 */
export interface SymbolShard {
  readonly blobOid: string;
  /** The extractor identity, so a future upgrade invalidates old shards honestly. */
  readonly extractor: string;
  readonly symbols: readonly SnapshotSymbol[];
}

/**
 * One identifier's occurrences within a single file: the identifier `name` and the
 * 1-based `lines` it appears on (sorted ascending, de-duplicated). This is the unit
 * of the model-free reference index (#200) that backs `context.references`.
 */
export interface ReferenceOccurrence {
  /** The identifier token (e.g. `buildCanvas`). */
  readonly name: string;
  /** 1-based line numbers the identifier occurs on, sorted ascending and de-duplicated. */
  readonly lines: readonly number[];
}

/**
 * The per-file REFERENCE shard, addressed by `blobOid` and content-addressed as a
 * PURE FUNCTION OF BLOB CONTENT — it carries no path, exactly like {@link SymbolShard}.
 * It records every identifier's textual occurrences in the blob (name → lines),
 * so `context.references` can answer "where is this name used?" (blast radius)
 * WITHOUT file text at query time. Because the bytes are a pure function of the
 * blob, an unchanged blob reuses its shard verbatim across an incremental rebuild
 * (renames/copies resolve to the same shard); path is recovered from the `files`
 * shard. Honest scope: NAME-based and textual (regex, not a parse), so it cannot
 * tell two distinct symbols that share a name apart — a documented limit surfaced
 * on the read.
 */
export interface ReferenceShard {
  readonly blobOid: string;
  /** The reference-extractor identity, so a future upgrade invalidates old shards honestly. */
  readonly extractor: string;
  /** Every identifier's occurrences in the blob, sorted by `name`. */
  readonly references: readonly ReferenceOccurrence[];
}

/** A pointer from the manifest to a content-addressed structural shard. */
export interface ShardRef {
  readonly digest: string;
  readonly entries: number;
}

// ── The symbol inspector's lookup answer (Rai, wireframes #8) ────────────────
// The UI-facing shape the `review.symbolLookup` command returns and the in-app
// SymbolInspector renders: definition sites (go-to-definition) + reference sites
// (find-references), each gated so a snapshot that could not answer is a first-
// class `unavailable`, never conflated with a real empty `ok`. It is a lossy
// projection of the symbolic surface's own results (`querySymbolDefinition` /
// `queryReferences`) onto the plain rows the panel shows — no shard digests, no
// gate-failure internals cross this boundary.

/** One definition site the inspector shows: where an exported symbol is declared. */
export interface SymbolInspectorDefinitionRow {
  /** Repo-relative POSIX path of the declaring file. */
  readonly path: string;
  /** 1-based line of the declaration. */
  readonly line: number;
  /** The declaration kind (e.g. "function", "class", "reexport"). */
  readonly kind: string;
  /** The owning workspace scope (most specific), or null. */
  readonly scope: string | null;
}

/** One reference site the inspector shows: where an identifier occurs. */
export interface SymbolInspectorReferenceRow {
  /** Repo-relative POSIX path of the occurrence. */
  readonly path: string;
  /** 1-based line of the occurrence. */
  readonly line: number;
  /** The owning workspace scope (most specific), or null. */
  readonly scope: string | null;
}

/**
 * How confident a section's answer is — the LSP-honesty doctrine made a discrete
 * signal (Rai, wireframes #11), NOT a decorative label. It is a projection of what
 * the model-free symbolic surface ACTUALLY did, never an LLM guess:
 *  - `exact` / `structural`: go-to-definition resolved the queried name to a SINGLE
 *    exported declaration by structural extraction (`context.symbol`). Unambiguous.
 *    (Honest scope: a structural parse of exported top-level declarations, NOT a
 *    TypeScript LSP type-resolution — Rennet has no LSP. The chip says `exact`, its
 *    method says `structural`, so it never overclaims an LSP answer.)
 *  - `guess` / `structural` with `candidates > 1`: several files export the name, so
 *    the index cannot pick one — the N sites ARE the candidate list, surfaced.
 *  - `guess` / `textual`: find-references is NAME-BASED and textual (`context.references`
 *    is regex, not a parse), so two distinct symbols that share a name are
 *    indistinguishable. Always a guess.
 * A DISCRIMINATED UNION, so the honesty guarantee is a COMPILE error, not just a
 * test: there is no `{ kind: "exact", method: "textual" }` arm, so a textual result
 * can never carry `exact`. A structural guess always names its candidate count; a
 * textual guess never carries one.
 */
export type SymbolTier =
  | { readonly kind: "exact"; readonly method: "structural" }
  | { readonly kind: "guess"; readonly method: "structural"; readonly candidates: number }
  | { readonly kind: "guess"; readonly method: "textual" };

/**
 * One gated section of a lookup: the sites, or an honest `unavailable` when the
 * snapshot could not answer (stale/absent/corrupt) — NEVER conflated with an empty
 * `ok` (a real "nothing found"). `truncated` marks a section capped for display.
 * `tier` labels the answer's confidence (present only for a non-empty `ok`).
 */
export type SymbolInspectorSection<Row> =
  | {
      readonly status: "ok";
      readonly sites: readonly Row[];
      readonly truncated?: boolean;
      readonly tier?: SymbolTier;
    }
  | { readonly status: "unavailable"; readonly reason: string };

/** The logical structural shards a manifest points at (excluding per-file symbol shards). */
export type StructuralShardSlot =
  | "files"
  | "scopes"
  | "edges"
  | "entryPoints"
  | "tests"
  | "ownership"
  | "conventions";

/**
 * The ProjectSnapshot manifest: the root pointer document. Contains NO clock —
 * every field is a pure function of the tree at `baseOid`, so two builds at the
 * same OID produce byte-identical manifests. The `fingerprint` is a digest over
 * the pin plus the sorted shard digests; freshness is fingerprint/content
 * equality, never age.
 */
export interface ProjectSnapshotManifest {
  readonly schemaVersion: number;
  /** The store key: `escapePath(realpath(git-top-level))` (design §1.1). Part of the fingerprint pin. */
  readonly repoKey: string;
  /** The resolved default-branch ref name. */
  readonly baseRef: string;
  /** How `baseRef` was resolved. */
  readonly baseRefResolution: BaseRefResolution;
  /** The pinned default-branch commit OID. */
  readonly baseOid: string;
  /** Digest over all canonical manifest content: `{ schemaVersion, repoKey, baseRef, baseRefResolution, baseOid, structural shard digests, symbol shard digests, reference shard digests }`. */
  readonly fingerprint: string;
  /** The structural shard pointers, keyed by slot. */
  readonly shards: Readonly<Record<StructuralShardSlot, ShardRef>>;
  /** Per-file symbol shard pointers, sorted by `blobOid`. */
  readonly symbols: readonly (readonly [blobOid: string, digest: string])[];
  /**
   * Per-file REFERENCE shard pointers (the identifier-occurrence index, #200),
   * sorted by `blobOid`. Always present (empty when nothing was indexed); the
   * fingerprint covers these digests, so a dropped/tampered reference shard fails
   * the integrity gate closed exactly as a symbol shard does.
   */
  readonly references: readonly (readonly [blobOid: string, digest: string])[];
}

/** A built shard: its canonical bytes and their content digest. */
export interface BuiltShard {
  readonly digest: string;
  readonly bytes: string;
}

/** The full result of a snapshot build: the manifest plus every shard's bytes by digest. */
export interface BuiltSnapshot {
  readonly manifest: ProjectSnapshotManifest;
  /** digest → canonical bytes, for every structural, symbol, and reference shard the manifest references. */
  readonly shards: ReadonlyMap<string, string>;
}

export type ScopeProvenance = "pnpm" | "nx" | "cargo" | "go-work";

export interface ScopeTreeNode {
  readonly id: string;
  readonly name: string;
  readonly root: string;
  readonly parentId: string | null;
  readonly provenance: readonly ScopeProvenance[];
  readonly dependencies: readonly string[];
}

export interface ScopeTree {
  readonly repoRecordId: string;
  readonly rootId: string;
  readonly nodes: readonly ScopeTreeNode[];
  readonly contentDigest: string;
}

export interface RepoMapReference {
  readonly repoRecordId: string;
  readonly pinnedOid: string;
  readonly projectSnapshotId: string;
  readonly contentDigest: string;
}

export type RepoMapMember =
  | { readonly status: "resolved"; readonly path: string; readonly reference: RepoMapReference }
  | {
      readonly status: "absent";
      readonly path: string;
      readonly repoRecordId: string;
      readonly pinnedOid: string;
    };

export type CompositionStaleReason = "absent" | "oid-mismatch" | "digest-mismatch";

export interface CompositionStaleMember {
  readonly path: string;
  readonly repoRecordId: string;
  readonly reason: CompositionStaleReason;
  readonly expectedOid: string;
  readonly expectedDigest?: string;
  readonly observedOid?: string;
  readonly observedDigest?: string;
}

export type CompositionFreshness =
  | { readonly status: "current"; readonly staleMembers: readonly [] }
  | { readonly status: "stale"; readonly staleMembers: readonly CompositionStaleMember[] };

export interface RepoComposition {
  readonly repoRecordId: string;
  readonly pinnedOid: string;
  readonly projectSnapshotId: string;
  readonly scopeTree: ScopeTree;
  readonly submodules: readonly RepoMapMember[];
  readonly contentDigest: string;
  readonly freshness: CompositionFreshness;
}

export interface WorkspaceMember {
  readonly repoRecordId: string;
  readonly pinnedOid: string;
  readonly projectSnapshotId: string;
  readonly compositionDigest: string;
}

export interface CrossRepoEdge {
  readonly sourceRepoRecordId: string;
  readonly sourceScopeId: string;
  readonly kind: "workspace" | "dependency" | "shared-contract";
  readonly destination: RepoMapReference;
}

export interface WorkspaceContext {
  readonly workspaceId: string;
  readonly members: readonly WorkspaceMember[];
  readonly edges: readonly CrossRepoEdge[];
  readonly contentDigest: string;
  readonly freshness: CompositionFreshness;
}

/**
 * The included/truncated/dropped state of one assembled context document (issue
 * #30). `included` = the whole document was assembled; `truncated` = the byte
 * budget cut it at a section boundary (its `bytes` < `originalBytes`); `dropped` =
 * the budget was exhausted before it, so 0 bytes were assembled. Every cut is
 * RECORDED — the budget never silently drops content.
 */
export type ContextDocumentState = "included" | "truncated" | "dropped";

/**
 * One document in the deterministic context assembly (issue #30). Records its
 * order position, source label (CLAUDE.md, AGENTS.md, `.rennet/`, the project map,
 * knowledge — labelled, never gated), source path, a content hash over the
 * ORIGINAL bytes, the original size, the bytes actually assembled after budgeting,
 * and its included/truncated/dropped state.
 */
export interface ContextDocumentRecord {
  /** 0-based order position in the assembled context (the composition order). */
  readonly order: number;
  /** The source label, e.g. "claude-md" | "agents-md" | "rennet" | "project-map" | "knowledge". */
  readonly source: string;
  /** The repo-relative (or synthetic) source path of the document. */
  readonly sourcePath: string;
  /** sha256 of the ORIGINAL document content (content identity, pre-truncation). */
  readonly contentHash: string;
  /** The full byte size of the document before any budget truncation. */
  readonly originalBytes: number;
  /** The bytes actually assembled: == originalBytes when included, < when truncated, 0 when dropped. */
  readonly bytes: number;
  readonly state: ContextDocumentState;
}

/**
 * The manifest of context Rennet composed for a review (issue #30). The type already
 * existed (repoRecordId/projectSnapshotId/compositionDigest/freshness/members —
 * the absent-member disclosure); this change ADDS the per-document assembly
 * record: each composed document (hash, source path, order, included/truncated/dropped
 * state), the total assembled byte size, a digest of the assembled context, and `exhaustive` set from
 * evidence (false until an isolation probe proves the harness sees only
 * pipeline-assembled context) with `unmanagedSources` naming what may have reached
 * the harness outside the pipeline. The absent-member disclosure (`members`) is
 * PRESERVED, not redefined.
 */
export interface ContextManifest {
  readonly repoRecordId: string;
  readonly projectSnapshotId: string;
  readonly compositionDigest: string;
  readonly freshness: CompositionFreshness;
  readonly members: readonly RepoMapMember[];
  /** The assembled documents in composition order, with per-document truncation state. */
  readonly documents: readonly ContextDocumentRecord[];
  /** The total bytes actually assembled across all documents (post-budget). */
  readonly totalBytes: number;
  /** sha256 of the assembled context text — the byte-identity anchor for the inspector. */
  readonly assembledPromptDigest: string;
  /** Whether the manifest provably covers everything the harness saw (false until a probe proves it). */
  readonly exhaustive: boolean;
  /** Sources that may have reached the harness outside the pipeline (e.g. its own ambient reads). */
  readonly unmanagedSources: readonly string[];
  /** The exact prompt or system-append bytes handed to fleet harnesses, recorded per attempt. */
  readonly sends?: readonly ContextSendRecord[];
}

export interface ContextSendRecord {
  readonly seat: string;
  readonly harness: string;
  readonly channel: "prompt" | "system-append";
  readonly attempt: number;
  readonly promptBytes: number;
  readonly promptDigest: string;
  readonly contextIncluded: boolean;
  readonly contextDigest?: string;
  readonly sentAt: string;
}

// ── Base + overlay for a non-default base (#143, design §3) ───────────────────
//
// The default-branch ProjectSnapshot is the BASE. A review against a NON-DEFAULT
// base reads a MERGED view = base + a per-non-default-base OVERLAY, rather than a
// full independent snapshot or a per-branch tracked map. The overlay is the
// deterministic `defaultOid..nonDefaultBaseOid` delta: it records only the shard
// keys that DIFFER from the base (overlay-wins), plus tombstones for symbol shards
// the non-default base dropped, so the merged read reconstructs — BYTE-IDENTICALLY
// — the snapshot at the non-default-base OID while storing only what changed.
//
// MODEL-FREE and deterministic: a pure function of the base manifest and the
// target (non-default-base) manifest. Freshness is keyed on the `(defaultOid,
// nonDefaultBaseOid)` pair — captured here as `baseFingerprint` (which pins the
// default side, since the fingerprint covers `baseOid`) + `targetBaseOid` — so
// when the default base advances the overlay is stale and re-derives.

/**
 * The current overlay schema version. Bumped on any breaking overlay shape change.
 * v2 (#200) added the reference-shard delta (`referenceUpserts` /
 * `referenceTombstones`), mirroring the symbol delta, so a merged non-default-base
 * view reconstructs the target's reference index byte-identically. A v1 overlay is
 * stale under v2 and re-derives.
 */
export const SNAPSHOT_OVERLAY_SCHEMA_VERSION = 2;

/**
 * A base+overlay delta pinning a non-default-base review's effective snapshot.
 * Applying it to the base manifest ({@link mergeOverlay}) reconstructs the target
 * manifest exactly (byte-equivalent to a clean full build at `targetBaseOid`).
 */
export interface SnapshotOverlay {
  readonly schemaVersion: number;
  /** The store key this overlay belongs to (same as the base map's). */
  readonly repoKey: string;
  /**
   * The fingerprint of the BASE map this overlay was derived against — freshness
   * key part 1. Because the fingerprint covers `baseOid`, a default-branch advance
   * changes it, which stales the overlay (it must re-derive against the new base).
   */
  readonly baseFingerprint: string;
  /** The default-branch OID the base map was at when this overlay was derived. */
  readonly baseDefaultOid: string;
  /** The non-default base ref the overlay targets. */
  readonly targetBaseRef: string;
  /** How `targetBaseRef` was resolved. */
  readonly targetBaseRefResolution: BaseRefResolution;
  /** The non-default base OID — freshness key part 2; the merged view's `baseOid`. */
  readonly targetBaseOid: string;
  /** The merged snapshot's own fingerprint (== a clean full build at `targetBaseOid`). */
  readonly targetFingerprint: string;
  /**
   * The composite `(base, overlay)` id the review pins to — the value a non-default
   * base review stamps on `Patchset.projectSnapshotId`. A digest over the base and
   * target fingerprints, so it changes if EITHER side moves.
   */
  readonly compositeId: string;
  /**
   * Structural shard slots whose digest DIFFERS from the base (overlay-wins). A
   * slot absent here is inherited from the base verbatim.
   */
  readonly structuralDelta: Partial<Record<StructuralShardSlot, ShardRef>>;
  /**
   * Per-file symbol shard pointers that are new-or-changed vs the base
   * (overlay-wins), sorted by `blobOid`.
   */
  readonly symbolUpserts: readonly (readonly [blobOid: string, digest: string])[];
  /**
   * blobOids present in the base but ABSENT from the target — tombstones the merged
   * read omits (e.g. a file deleted on the non-default base). Sorted.
   */
  readonly symbolTombstones: readonly string[];
  /**
   * Per-file REFERENCE shard pointers new-or-changed vs the base (overlay-wins),
   * sorted by `blobOid` — the reference-index analogue of `symbolUpserts` (#200).
   */
  readonly referenceUpserts: readonly (readonly [blobOid: string, digest: string])[];
  /**
   * blobOids whose reference shard is present in the base but ABSENT from the
   * target — tombstones the merged reference index omits. Sorted.
   */
  readonly referenceTombstones: readonly string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Deterministic novelty ledger (issue #144, Stage 1)
//
// The MODEL-FREE half of net-novel detection: given a base-branch ProjectSnapshot
// and a captured Patchset, classify each changed unit `novel` / `extends` /
// `conforms` against the baseline the snapshot records. Reproducible and golden-
// testable: same (snapshot, patchset) in ⇒ same ledger out, no clock, no
// randomness, no model. Every classification carries the concrete baseline
// evidence it matched (a snapshot shard entry + the snapshot fingerprint pin), so
// the DEFERRED Stage 2 (the LLM-cite layer) can turn an entry into cited prose:
// "every net-novel judgment cites a (projectSnapshotId, shard ref)" (R54).
//
// Scope is deliberately NARROW (what keeps Stage 1 assertable in CI): two unit
// kinds — changed files and changed exported symbols — each adjudicated purely
// from the snapshot's structural shards + the diff. The remaining unit kinds the
// direction enumerates (internal dependency edges, external deps + version
// changes, entry points, ownership crossings, submodule gitlink advances) need
// head-side manifest / lockfile / submodule content the base snapshot does not
// index, and are a documented later wave — NOT folded in with a fuzzy guess.
// ─────────────────────────────────────────────────────────────────────────────

/** The three-way novelty verdict for a changed unit (R54). */
export type NoveltyClassification =
  /** Not present in the baseline — a genuinely new file / symbol. */
  | "novel"
  /** Builds on a specific existing baseline entity (same path / same-named symbol). */
  | "extends"
  /** New, but a structural instance of an established convention the snapshot records. */
  | "conforms";

/** The granularity a novelty entry is about. Narrow by design (#144). */
export type NoveltyUnitKind = "file" | "symbol" | "gitlink";

/** The changed unit a classification is attached to. */
export interface NoveltyUnit {
  readonly kind: NoveltyUnitKind;
  /** The changed file's post-image repo-relative path (the new path for a rename). */
  readonly path: string;
  /** The file's change status in the diff. */
  readonly fileStatus: FileChangeStatus;
  /** The previous path, present only for a renamed file. */
  readonly previousPath?: string;
  /** The exported symbol name — present iff `kind === "symbol"`. */
  readonly symbol?: string;
  /** The child RepoRecord identity — present iff `kind === "gitlink"`. */
  readonly repoRecordId?: string;
  readonly oldOid?: string;
  readonly newOid?: string;
}

/**
 * The concrete baseline match (or absence of one) that DECIDED a classification.
 * A discriminated union so the deferred LLM-cite layer can cite the exact shard
 * entry: an "…-present"/"…-renamed"/"…-removed" match cites an existing baseline
 * entity (an `extends`/`conforms` proof); an "…-absent" match is the proof of
 * novelty (nothing in the baseline to cite, which is itself the citation).
 */
export type NoveltyMatch =
  /** Novel file: the path is absent from the snapshot `files` shard. */
  | { readonly kind: "file-absent"; readonly path: string }
  /** Extends: the modified file exists in the baseline at this blob. */
  | { readonly kind: "file-present"; readonly path: string; readonly blobOid: string }
  /** Extends: the file was renamed from an existing baseline path. */
  | {
      readonly kind: "file-renamed";
      readonly from: string;
      readonly to: string;
      readonly fromBlobOid: string;
    }
  /** Extends: the change removes an existing baseline file. */
  | { readonly kind: "file-removed"; readonly path: string; readonly blobOid: string }
  /** Novel symbol: an introduced export with no same-named baseline symbol in the file. */
  | { readonly kind: "symbol-absent"; readonly path: string; readonly symbol: string }
  /** Extends: an introduced export whose name already exists in the baseline file. */
  | {
      readonly kind: "symbol-present";
      readonly path: string;
      readonly symbol: SnapshotSymbol;
      readonly blobOid: string;
    }
  /** Conforms: a new file that is another instance of an established test convention. */
  | {
      readonly kind: "test-convention";
      readonly path: string;
      readonly matchedBy: string;
      readonly siblingTestCount: number;
    }
  | {
      readonly kind: "gitlink-advance";
      readonly path: string;
      readonly repoRecordId: string;
      readonly oldOid: string;
      readonly newOid: string;
    };

/**
 * Supplementary snapshot context on the file a unit belongs to — never the
 * deciding evidence, but the cross-references the Stage 2 layer reads for framing
 * (which workspace scope, whether the baseline already knew this path as a test /
 * a convention config, and whether the diff for this file was truncated so the
 * symbol coverage is partial).
 */
export interface NoveltyFileContext {
  /** The most specific workspace scope the file belongs to, or null. */
  readonly scope: string | null;
  /** Whether the path is a known test in the baseline `tests` shard. */
  readonly isKnownTest: boolean;
  /** Whether the path is a known convention config in the baseline `conventions` shard. */
  readonly isConvention: boolean;
  /**
   * True when this file's patch was truncated (carries `DIFF_TRUNCATION_MARKER`),
   * so introduced-symbol coverage is PARTIAL and an absence of symbol units is not
   * a guarantee of no novel symbols. Fail-open honesty for the deferred judge.
   */
  readonly patchTruncated: boolean;
}

/** The baseline evidence a single classification cites (R54). */
export interface NoveltyEvidence {
  /** The fingerprint of the snapshot compared against — the freshness/content pin. */
  readonly snapshotFingerprint: string;
  /** The base commit OID the snapshot was built at. */
  readonly baseOid: string;
  /**
   * The snapshot shard the deciding evidence came from (`"symbols"` for a symbol
   * shard), or null when the decision is an ABSENCE (nothing in the baseline).
   */
  readonly shard: StructuralShardSlot | "symbols" | null;
  /** The concrete baseline match (or absence) that decided the classification. */
  readonly match: NoveltyMatch;
  /** Cross-reference context on the owning file. */
  readonly context: NoveltyFileContext;
}

/** One classified unit: what changed, the verdict, and the baseline evidence for it. */
export interface LedgerEntry {
  readonly unit: NoveltyUnit;
  readonly classification: NoveltyClassification;
  readonly evidence: NoveltyEvidence;
}

/**
 * The deterministic novelty ledger for one patchset against one snapshot. Pinned
 * to the snapshot `fingerprint` + `baseOid` and the `patchsetId`, so a consumer
 * can prove which (baseline, diff) pair produced it — and re-run the ledger when
 * the baseline advances mid-review (R29), LLM-re-adjudicating only the entries
 * whose classification changed. `entries` are in a deterministic total order.
 */
export interface NoveltyLedger {
  /** Effective base-map identity (the base fingerprint or base+overlay composite). */
  readonly projectSnapshotId: string;
  readonly snapshotFingerprint: string;
  readonly baseOid: string;
  readonly patchsetId: string;
  readonly entries: readonly LedgerEntry[];
}

/** A concrete source a Stage-2 novelty judgment was drawn from. */
export type NoveltyJudgmentEvidence =
  | {
      readonly kind: "snapshot-shard";
      readonly projectSnapshotId: string;
      readonly shardRef: string;
    }
  | { readonly kind: "knowledge"; readonly statementId: string };

/** Stage-2 may assert a cited finding, or retain an uncited idea as a hypothesis. */
export type Stage2NoveltyJudgment =
  | {
      readonly status: "finding";
      readonly entryKey: string;
      readonly classification: NoveltyClassification;
      readonly rationale: string;
      readonly evidence: readonly NoveltyJudgmentEvidence[];
    }
  | {
      readonly status: "hypothesis";
      readonly entryKey: string;
      readonly classification: NoveltyClassification;
      readonly rationale: string;
      readonly evidence?: readonly NoveltyJudgmentEvidence[];
    };

// ── LLM knowledge layer (layer c, #14 knowledge half — design §6) ─────────────
//
// The ONLY Repo Map layer a model writes; it never enters the structural map (a)
// or the symbolic surface (b). Each learned statement about what a module does,
// the conventions it embodies, and the reconstructed WHY carries EVIDENCE ANCHORS
// that resolve against a snapshot, PROVENANCE, a CONFIDENCE, and the snapshot it
// was learned against. A model-derived statement is a LABELLED HYPOTHESIS until
// confirmed; a statement whose anchors do not resolve is INVALID and is never
// served. It is invalidated with its snapshot inputs, and disclosed as
// invalidated-pending (never silently dropped) when a delta pass invalidated it.

/** How sure the generator is of a knowledge statement. */
export type KnowledgeConfidence = "high" | "medium" | "low";

/**
 * Whether a statement is a model-derived HYPOTHESIS, a CONFIRMED fact, or a
 * human-REJECTED claim. A model-derived statement is a hypothesis until a human
 * (or evidence) confirms it — the same honesty contract as the symbolic
 * surface's `exact`/`guess` tier label (a `guess` is never rendered as exact; a
 * hypothesis is never rendered as an asserted fact). A rejection is a RECORDED
 * state, not a deletion: it survives delta passes so re-enrichment cannot
 * resurrect the same claim as a fresh hypothesis (add-context-map-view).
 */
export type KnowledgeStatus = "hypothesis" | "confirmed" | "rejected";

/** Which aspect of understanding a statement reconstructs. */
export type KnowledgeAspect = "purpose" | "convention" | "why";

/**
 * An evidence anchor: the concrete code a knowledge statement is DRAWN FROM. It
 * RESOLVES against a snapshot iff the file at `path` still carries `blobOid` in
 * that snapshot's file inventory — so a statement is invalidated exactly when the
 * bytes it cited change. `symbol`/`lines` narrow WHICH part of the file the claim
 * is drawn from, but the `(path, blobOid)` pair is the resolution key (content
 * identity, the same join the symbol shards use).
 */
export interface KnowledgeAnchor {
  /** Repo-relative POSIX path of the cited file. */
  readonly path: string;
  /** The git blob OID of that file at the snapshot the statement was learned against. */
  readonly blobOid: string;
  /** The cited exported symbol name, when the claim is about one symbol. */
  readonly symbol?: string;
  /** A 1-based line span within the file the claim is drawn from. */
  readonly lines?: AnchorSpan;
}

/** Who/what produced a knowledge statement (the generator + credential facts). */
export interface KnowledgeProvenance {
  /** The generator identity (prompt+schema version); a generator change invalidates old statements honestly. */
  readonly generator: string;
  /** The model the harness reported, or null when unseen / deterministic. */
  readonly model: string | null;
  /** The credential source; `oauth`/`none` are the unmetered subscription path, a metered source is money. */
  readonly apiKeySource: string | null;
}

/**
 * One learned statement. `learnedAgainst` pins the snapshot it was reconstructed
 * from (baseOid + fingerprint) so it is invalidated with its inputs. `evidence`
 * is non-empty by contract — an unanchored statement is INVALID and never served.
 */
export interface KnowledgeStatement {
  /** Stable id: a content hash over {subject, aspect, claim, sorted anchors}. */
  readonly id: string;
  /** What the statement is about — a workspace scope name or a repo-relative path/subtree. */
  readonly subject: string;
  /** Which aspect of understanding this reconstructs. */
  readonly aspect: KnowledgeAspect;
  /** The reconstructed statement, served verbatim. */
  readonly claim: string;
  /** The code this claim is drawn from — at least one anchor, each resolvable against the snapshot. */
  readonly evidence: readonly KnowledgeAnchor[];
  readonly confidence: KnowledgeConfidence;
  /** `hypothesis` until confirmed — a model-derived statement is never served as an asserted fact. */
  readonly status: KnowledgeStatus;
  readonly provenance: KnowledgeProvenance;
  /** The snapshot this statement was learned against (freshness/content pin). */
  readonly learnedAgainst: {
    readonly baseOid: string;
    readonly snapshotFingerprint: string;
  };
}

/** The current knowledge-set schema version. Bumped on a breaking statement-shape change. */
export const KNOWLEDGE_SCHEMA_VERSION = 1;

/**
 * The stored knowledge set for one repo, pinned to the snapshot it was generated
 * against. This is the on-disk shape under `knowledge/knowledge.json` locally and
 * the promoted `<repo>/.rennet/knowledge/knowledge.json`. Statements are in a
 * deterministic total order (by id), so the file is byte-reproducible.
 */
export interface KnowledgeSet {
  readonly schemaVersion: number;
  /** The store key the set belongs to. */
  readonly repoKey: string;
  /** The base OID the set was generated against. */
  readonly baseOid: string;
  /** The snapshot fingerprint the set was generated against. */
  readonly snapshotFingerprint: string;
  /** The generator identity that produced the set. */
  readonly generator: string;
  readonly statements: readonly KnowledgeStatement[];
}

// ─────────────────────────────────────────────────────────────────────────────
// OpenSpec change artifact model (the "Spec" angle).
//
// An OpenSpec change is a directory of markdown artifacts with a KNOWN shape:
// a `proposal.md` (Why / What Changes / Capabilities / Impact), a `design.md`
// (sectioned prose), a `tasks.md` (grouped checklists with per-item state), and
// a set of per-capability spec deltas (`specs/<cap>/spec.md`: ADDED / MODIFIED /
// REMOVED requirements, each with SHALL statements and WHEN/THEN scenarios).
//
// Because the shape is known ahead of time, the Spec angle renders it STRUCTURED
// rather than as a markdown dump: the requirement/scenario tree, the task
// checklist with an honest progress roll-up, the capabilities, the spec deltas as
// structured diffs. These types are the parsed model `parseOpenSpecChange`
// (`@rennet/core`) produces and the reading surface (`@rennet/app-ui`) renders.
// ─────────────────────────────────────────────────────────────────────────────

/** Which artifact file a reviewable node came from. */
export type OpenSpecArtifact = "proposal" | "design" | "tasks" | "spec";

/** One rendered block inside a section: a paragraph, a list, a fenced code block, or a table. */
export type OpenSpecBlock =
  | { readonly kind: "paragraph"; readonly text: string; readonly source?: OpenSpecSource }
  | {
      readonly kind: "list";
      readonly ordered: boolean;
      readonly items: readonly OpenSpecListItem[];
      readonly source?: OpenSpecSource;
    }
  | {
      readonly kind: "code";
      readonly language: string;
      readonly code: string;
      readonly source?: OpenSpecSource;
    }
  | {
      readonly kind: "table";
      readonly headers: readonly string[];
      readonly rows: readonly (readonly string[])[];
      readonly source?: OpenSpecSource;
    };

/** One row of a proposal's Impact section (the area touched + what changes there). */
export interface OpenSpecImpactEntry {
  /** The impacted area — a package or seam (the bold/code lead, e.g. `packages/types`). */
  readonly area: string;
  readonly detail: string;
}

/** A design-doc section (a `##` or `###` heading and its rendered blocks). */
export interface OpenSpecDesignSection {
  /** A slug anchor derived from the heading (for the table of contents + jumps). */
  readonly id: string;
  readonly level: 2 | 3;
  readonly heading: string;
  readonly blocks: readonly OpenSpecBlock[];
  readonly source?: OpenSpecSource;
}

/** Whether a checklist task is ticked. */
export type OpenSpecTaskStatus = "todo" | "done";

/** One checklist item and its state. */
export interface OpenSpecTaskItem {
  readonly text: string;
  readonly status: OpenSpecTaskStatus;
  readonly source?: OpenSpecSource;
}

/** One task group (`## N. Title`) and its checklist. */
export interface OpenSpecTaskGroup {
  /** A slug anchor derived from the title. */
  readonly id: string;
  readonly title: string;
  readonly items: readonly OpenSpecTaskItem[];
  /** Items in this group. */
  readonly total: number;
  /** Ticked items in this group. */
  readonly done: number;
  readonly source?: OpenSpecSource;
}

/** A spec-delta operation heading (`## ADDED Requirements`, etc.). */
export type OpenSpecDeltaOperation = "added" | "modified" | "removed" | "renamed";

/** A Gherkin-style scenario step keyword. */
export type OpenSpecScenarioKeyword = "given" | "when" | "then" | "and";

/** One scenario step (`- **WHEN** …`). */
export interface OpenSpecScenarioStep {
  readonly keyword: OpenSpecScenarioKeyword;
  readonly text: string;
}

/** One requirement (`### Requirement: …`): its SHALL statement and its scenarios. */
export interface OpenSpecRequirement {
  readonly name: string;
  /** The normative prose beneath the heading (the SHALL statement). */
  readonly statement: string;
  readonly scenarios: readonly OpenSpecScenario[];
  readonly source?: OpenSpecSource;
}

/** The requirements under one delta operation (all the ADDED ones, all the MODIFIED ones, …). */
export interface OpenSpecRequirementGroup {
  readonly operation: OpenSpecDeltaOperation;
  readonly requirements: readonly OpenSpecRequirement[];
}

/**
 * The coverage of ONE requirement: which changeset hunks CLAIM it, and how many
 * tests exercise it (the requirements-side mouth of the hunk↔requirement mapping,
 * Rai wireframes #9 / R53). `hunks` are diff-anchor strings the Spec view jumps to
 * (the same anchor grammar the diff lenses navigate by); `hunks.length === 0` is a
 * COMPUTED zero — the requirement is genuinely unimplemented, distinct from coverage
 * that was never computed at all (which the view represents by having NO entry). This
 * is a produced signal, never inferred at render time: the derivation attaches
 * exactly what a mapping runner emitted, so the honest zero and an absent mapping
 * stay distinguishable.
 */
export interface OpenSpecRequirementCoverage {
  /** The changeset hunk anchors that claim this requirement (jump targets). */
  readonly hunks: readonly string[];
  /** The count of tests that exercise this requirement. */
  readonly tests: number;
}

/**
 * The ask trace a handoff run hands to the successor capture (issue #73 wave 3) — the
 * verified bundle's `traceMap` and task titles MATERIALISED per ask, projected down to
 * exactly what the delta account needs to attribute each ask to its composed task. One
 * entry per bundle ask: its stable id, anchor identity (path + span + side + type, so
 * the fold matches it to a review disposition), and the `taskIndex` plus preview
 * `taskTitle` the traceMap assigns it. Deliberately a SMALL projection — no prompts, no
 * instruction bodies, no contexts — so nothing an agent executes enters the event log.
 */
export interface HandoffAskTrace {
  readonly id: string;
  readonly path: string;
  readonly span?: AnchorSpan;
  readonly side?: AnchorSide;
  readonly type: DispositionType;
  readonly taskIndex: number;
  readonly taskTitle: string;
}
