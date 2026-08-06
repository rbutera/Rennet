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

export interface Patchset {
  id: string;
  createdAt: string;
  repository: RepositoryProvenance;
  files: PatchFile[];
  rawDiff: string;
  byteLength: number;
  truncated: boolean;
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

/** The eleven document types named by the Surfacing DSL plan (§2). */
export type RspDocType =
  | "spec.model"
  | "decomposition.skeleton"
  | "decomposition.proposal"
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
