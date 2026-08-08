export type FileChangeStatus = "added" | "modified" | "deleted" | "renamed";

export interface RepositoryProvenance {
  id: string;
  root: string;
  commonDir: string;
  baseRef: string;
  baseOid: string;
  headOid: string;
}

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

export interface Patchset {
  id: string;
  createdAt: string;
  repository: RepositoryProvenance;
  files: PatchFile[];
  rawDiff: string;
  byteLength: number;
  truncated: boolean;
  /** Provenance of the content. Absent ⇒ `local` (additive; identity ignores it). */
  source?: PatchsetSource;
  /** True when this changeset was produced by a degraded path (the REST fallback). */
  degraded?: boolean;
  /** Human-facing reason a degraded changeset is degraded (the badge copy). */
  degradationReason?: string;
}

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
 * A reviewer action taken against an anchor. In this model a file/chunk is
 * "read" iff it carries a disposition: reading is an action, never scroll/dwell.
 */
export interface Disposition {
  anchor: DispositionAnchor;
  type: DispositionType;
  body: string;
}

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

export interface Review {
  id: string;
  repositoryRoot: string;
  patchsets: Patchset[];
  activePatchsetId: string;
  pendingPatchsetId?: string;
  /**
   * The reviewer's dispositions against the active patchset. This is the
   * canonical read-state: the derived read-set is the distinct anchor paths.
   */
  dispositions: Disposition[];
  status: "current" | "invalid";
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
// validator gate. Per-docType body schemas (decomposition, decision, claim, …)
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
  | "claim"
  | "adjudication"
  | "test.mapping"
  | "noise.patternProposal"
  | "anomaly"
  | "finding"
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

/** A 1-based line span WITHIN the anchored unit (never absolute file lines). */
export interface AnchorSpan {
  startLine: number;
  endLine?: number;
}

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
 */
export type MechanicalClass =
  | "lockfile"
  | "generated"
  | "pure-rename"
  | "formatting-only"
  | "vendored"
  | "mode-only";

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
 * `spec` (a queue over requirements, joined to code through claim documents).
 * Enforced by validator rule V104.
 */
export type ChunkAngle = "sequence" | "decisions" | "claims" | "blast-radius";

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
 * An optional code citation on a narration entry: a `rennet:` code anchor plus the
 * byte-exact quote it stands on. The generic validator walk (V006) byte-verifies
 * every `{anchor, quote}` pair against the resolved span, so a fabricated quote is
 * rejected. Absent when a narration cites no specific code.
 */
export interface NarrationEvidence {
  anchor: string;
  quote: string;
}

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
export type CanvasAngle = "spec" | "sequence" | "decisions" | "claims" | "noise";

/** The canvas angles as a frozen list, in a stable order. */
export const CANVAS_ANGLES: readonly CanvasAngle[] = [
  "spec",
  "sequence",
  "decisions",
  "claims",
  "noise",
] as const;

/**
 * The minimal canvas-facing shape of a decision, as the decisions canvas needs
 * it: an id, the anchor it is about, and a title. The richer `decision.record`
 * body (issue #26) is an ADDITIVE superset of this; the canvas placement only
 * needs the id + anchor + title, so this stays deliberately small and stable.
 */
export interface DecisionRecordElement {
  decisionId: string;
  anchor: string;
  title: string;
}

/** The `decision.record` body as consumed by the decisions-canvas projector. */
export interface DecisionRecordBody {
  decisions: DecisionRecordElement[];
}

/** L0 — a slice of the substrate a canvas is about: the chunks it covers. */
export interface SubstrateChunkRef {
  chunkId: string;
  hunkIds: string[];
  filePaths: string[];
}

/** L0 substrate layer: read-only, owned entirely by deterministic ingest. */
export interface SubstrateLayer {
  chunks: SubstrateChunkRef[];
}

/**
 * L1 — one placed analysis element. `elementKey` is DERIVED from `docId` + anchor
 * (never minted). `kind` is the element species label; `title` is display text.
 */
export interface AnalysisElement {
  elementKey: string;
  docId: string;
  anchor: string;
  kind: string;
  title: string;
}

/**
 * L1 — a cohort: a deterministically grouped set of element keys (the decisions
 * canvas groups into cohorts; hard-baked grouping, OQ17 closed). Collapsible in
 * the UI; never capped.
 */
export interface AnalysisCohort {
  cohortKey: string;
  title: string;
  elementKeys: string[];
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

/**
 * An L3 annotation: an orchestrator mark on an element or anchor. Ephemeral by
 * default (`pinned: false`), promoted to persistent only by the user pinning it.
 */
export interface Annotation {
  annotationId: string;
  target: string;
  kind: AnnotationKind;
  body: string;
  pinned: boolean;
}

/** The kinds of proposal the orchestrator may raise (a suggestion — user decides). */
export type ProposalKind = "disposition" | "regroup" | "split";

/** A proposal's lifecycle: pending until the user accepts or dismisses it. */
export type ProposalStatus = "pending" | "accepted" | "dismissed";

/**
 * An orchestrator PROPOSAL, rendered on L3 next to its target. A disposition
 * proposal becomes L2 ONLY when the user accepts it — accepting is a user act
 * (L2 sovereignty). `payload` carries the proposed content opaquely.
 */
export interface Proposal {
  proposalId: string;
  kind: ProposalKind;
  target: string;
  payload: string;
  status: ProposalStatus;
}

/** L3 annotation layer: the orchestrator's marks and proposals. */
export interface AnnotationLayer {
  annotations: Annotation[];
  proposals: Proposal[];
}

/** A single amber blast-radius paint, targeting an element or anchor. */
export interface BlastRadiusPaint {
  target: string;
  docId: string;
}

/**
 * A canvas: the layered projection scoped to `(reviewId, patchsetId, angle)`.
 * `canvasId` is deterministic (hash of the key). The overlay is the amber
 * blast-radius paint, never a writable layer.
 */
export interface Canvas {
  canvasId: string;
  reviewId: string;
  patchsetId: string;
  angle: CanvasAngle;
  layers: {
    substrate: SubstrateLayer;
    analysis: AnalysisLayer;
    disposition: DispositionLayer;
    annotation: AnnotationLayer;
  };
  overlay: BlastRadiusPaint[];
}

/**
 * The real diff material for one canvas element (issue #60). Delivered ALONGSIDE
 * the canvas set (never embedded on the `Canvas`, so the canvas projection stays
 * byte-identical for replay). `diff` is sliced VERBATIM from the captured
 * patchset — the exact hunk text git produced — so zooming into an element shows
 * the real code, not a fixture.
 */
export interface ElementDiff {
  path: string;
  diff: string;
}

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
 * The narration placed onto a review's canvases, keyed by the node the reader is
 * looking at (issue #70). `rollup` is the whole-changeset account; `cohorts` maps
 * each cohortKey to its account. Consumed by the renderer at the matching zoom
 * level (rollup zoom → `rollup`; cohort zoom → `cohorts[cohortKey]`).
 */
export interface ReviewNarration {
  rollup: NarrationPlacement;
  cohorts: Record<string, NarrationPlacement>;
}

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
// `docs/MODEL_COUNCIL.md` (§2 catalogue, §3 tables, §4 resolver + gate).
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

/** A per-field override; any field may be set independently of the others. */
export interface CouncilOverridePick {
  readonly model?: CouncilModel;
  readonly effort?: CouncilEffort;
  readonly harness?: CouncilHarnessId;
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
 * of R10 the pre-flight route-plan count never provided (bead p0wwp). A refusal
 * is fail-closed: the runner falls to its deterministic floor rather than crash.
 */
export interface InvocationBudget {
  readonly max: number;
  readonly consumed: number;
  readonly remaining: number;
  tryConsume(purpose: string): BudgetGrant;
}
