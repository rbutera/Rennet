/**
 * ProjectSnapshot — the deterministic base-branch structural map (issue #14).
 *
 * This module is the load-bearing core: the pure, MODEL-FREE, BYTE-REPRODUCIBLE
 * machinery that turns already-gathered structural facts (a file inventory,
 * workspace scopes, dependency edges, entry points, tests, ownership,
 * conventions) plus per-file symbol shards into a content-addressed snapshot —
 * a manifest that points at content-addressed shards.
 *
 * The load-bearing property: a snapshot built by recomputing only the
 * changed-path closure is BYTE-IDENTICAL to one built from a clean full scan of
 * the same tree. That is what makes "never consume stale context" checkable —
 * freshness is fingerprint/content equality, never age. To keep it true:
 *
 *  - No clock, no randomness, no environment reads anywhere in a serialized
 *    field. Every byte is a pure function of the tree at `baseOid`.
 *  - Everything that becomes bytes is put through `canonicalize` (sorted keys,
 *    2-space indent, LF) and content-addressed with the node-free `sha256Hex`.
 *  - Symbol shards are addressed by `blobOid` and their bytes are a pure function
 *    of blob content (NO path), so an unchanged blob yields a byte-identical shard
 *    whether reused or recomputed — and a blob that is renamed or copied resolves
 *    to the SAME shard regardless of path. Path is recovered from the `files`
 *    structural shard (`path → blobOid`), never baked into shard identity.
 *
 * All IO — git, the workspace tooling, and the filesystem store — lives in
 * `@rennet/adapters`. This module knows nothing about any of it; it is exercised
 * by a pure property test that never touches git or the disk.
 */

import type {
  BaseRefResolution,
  BuiltShard,
  BuiltSnapshot,
  ConventionEntry,
  DependencyEdge,
  EntryPoint,
  ImportShard,
  OwnershipRule,
  ProjectSnapshotManifest,
  ReferenceOccurrence,
  ReferenceShard,
  ShardRef,
  SnapshotFileEntry,
  SnapshotSymbol,
  StructuralShardSlot,
  SymbolShard,
  TestEntry,
  WorkspaceScope,
} from "@rennet/protocol";
import { canonicalize, PROJECT_SNAPSHOT_SCHEMA_VERSION, sha256Hex } from "@rennet/protocol";
import { classifyMappingEligibility, hasGeneratedMarker } from "./file-classification";
import { importSpecifiers, stripBlockComments } from "./import-specifiers";

/** Content-address any value: its canonical bytes and their sha256. */
export function contentAddress(value: unknown): BuiltShard {
  const bytes = canonicalize(value);
  return { bytes, digest: sha256Hex(bytes) };
}

/** The structural facts a snapshot is assembled from, all derived at `baseOid`. */
export interface SnapshotStructuralInputs {
  /** The store key: `escapePath(realpath(git-top-level))` (design §1.1). */
  readonly repoKey: string;
  readonly baseRef: string;
  readonly baseRefResolution: BaseRefResolution;
  readonly baseOid: string;
  readonly files: readonly SnapshotFileEntry[];
  readonly scopes: readonly WorkspaceScope[];
  readonly edges: readonly DependencyEdge[];
  readonly entryPoints: readonly EntryPoint[];
  readonly tests: readonly TestEntry[];
  readonly ownership: readonly OwnershipRule[];
  readonly conventions: readonly ConventionEntry[];
}

// ── Deterministic ordering ───────────────────────────────────────────────────
//
// Every collection is sorted by a total, content-derived key before it becomes
// bytes, so the assembled shard does not depend on the order the adapter happened
// to discover things in. `canonicalize` already sorts object KEYS; these sorts
// fix ARRAY order.

function byString(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sortedFiles(files: readonly SnapshotFileEntry[]): SnapshotFileEntry[] {
  return [...files].sort((l, r) => byString(l.path, r.path));
}

function sortedScopes(scopes: readonly WorkspaceScope[]): WorkspaceScope[] {
  return [...scopes]
    .map((scope) => ({ ...scope, tags: [...scope.tags].sort(byString) }))
    .sort((l, r) => byString(l.root, r.root) || byString(l.name, r.name));
}

function sortedEdges(edges: readonly DependencyEdge[]): DependencyEdge[] {
  return [...edges].sort(
    (l, r) => byString(l.from, r.from) || byString(l.to, r.to) || byString(l.kind, r.kind),
  );
}

function sortedEntryPoints(entryPoints: readonly EntryPoint[]): EntryPoint[] {
  return [...entryPoints]
    .map((entry) => ({ ...entry, bin: [...entry.bin].sort((l, r) => byString(l[0], r[0])) }))
    .sort((l, r) => byString(l.scope, r.scope));
}

function sortedTests(tests: readonly TestEntry[]): TestEntry[] {
  return [...tests].sort((l, r) => byString(l.path, r.path));
}

function sortedConventions(conventions: readonly ConventionEntry[]): ConventionEntry[] {
  return [...conventions].sort((l, r) => byString(l.path, r.path));
}

// Ownership is file-order-significant in git (last match wins), so it is the one
// collection NOT sorted — its order is part of its meaning and is preserved.

// ── Structural shards ────────────────────────────────────────────────────────

const STRUCTURAL_SHARD_VERSION = 1;

/**
 * Wrap a structural collection as a self-describing, content-addressed shard.
 * The `slot` and `version` are inside the bytes so two empty shards for
 * different slots never collide, and a shape change is visible in the digest.
 */
function structuralShard(slot: StructuralShardSlot, entries: readonly unknown[]): BuiltShard {
  return contentAddress({ slot, version: STRUCTURAL_SHARD_VERSION, entries });
}

/**
 * Content-address a per-file symbol shard. The shard bytes are a PURE FUNCTION OF
 * BLOB CONTENT (blobOid + extractor + symbols) and carry NO path — so a blob that
 * is renamed (same content, new path) or copied (one content, two paths) resolves
 * to the exact same shard digest whether it was freshly extracted at the new path
 * or reused verbatim from a prior build at the old path. Path is NOT identity
 * here; it is recovered from the `files` structural shard (`path → blobOid`).
 */
export function symbolShardBytes(shard: SymbolShard): BuiltShard {
  return contentAddress({
    blobOid: shard.blobOid,
    extractor: shard.extractor,
    generated: shard.generated,
    symbols: shard.symbols,
  });
}

/**
 * Content-address a per-file REFERENCE shard. Like {@link symbolShardBytes}, the
 * bytes are a PURE FUNCTION OF BLOB CONTENT (blobOid + extractor + references) and
 * carry NO path, so a blob that is renamed or copied resolves to the same shard
 * digest and an incremental rebuild reuses it verbatim.
 */
export function referenceShardBytes(shard: ReferenceShard): BuiltShard {
  return contentAddress({
    blobOid: shard.blobOid,
    extractor: shard.extractor,
    references: shard.references,
  });
}

/**
 * Content-address a per-file IMPORT shard. Like {@link symbolShardBytes}, the bytes
 * are a PURE FUNCTION OF BLOB CONTENT (blobOid + extractor + raw specifiers) and
 * carry NO path — which is exactly why the shard stores RAW specifiers rather than
 * resolved targets: resolving `./sibling` needs the importing file's path, and
 * baking a path in would break the rename/copy reuse contract. Resolution to
 * file→file edges happens at read time against the inventory (`queryImportGraph`).
 */
export function importShardBytes(shard: ImportShard): BuiltShard {
  return contentAddress({
    blobOid: shard.blobOid,
    extractor: shard.extractor,
    imports: shard.imports,
  });
}

// ── The fingerprint ──────────────────────────────────────────────────────────

/**
 * A manifest minus its own fingerprint — exactly what the fingerprint is computed
 * over. Every other canonical field is in here by construction, so no field can be
 * left out of the digest by forgetting to name it.
 */
export type UnfingerprintedManifest = Omit<ProjectSnapshotManifest, "fingerprint">;

/**
 * The freshness/integrity fingerprint: a digest over the ENTIRE canonical manifest
 * except the fingerprint field itself. Two manifests that differ in ANY other
 * respect — `repoKey`, `baseRef`, `baseRefResolution`, `baseOid`, `schemaVersion`,
 * a shard digest, a shard's declared `entries` count, the ORDER of a per-blob
 * pointer array, or an extra key smuggled in by a tamperer — get different
 * fingerprints. Deterministic and clock-free, so two builds of the same tree on the
 * same repo share a fingerprint; two snapshots are the same content iff their
 * fingerprints match (#4).
 *
 * Hashing the whole projection rather than a hand-listed subset is the point: the
 * earlier version re-derived `structural` from digests alone (dropping `entries`),
 * re-SORTED the pointer arrays before hashing (so a manifest whose arrays were out
 * of canonical order still verified), and hashed the schema CONSTANT rather than
 * the manifest's own `schemaVersion`. All three are covered now, for free.
 */
export function computeFingerprint(manifest: UnfingerprintedManifest): string {
  return sha256Hex(canonicalize(manifest));
}

/** Strip a manifest's own fingerprint, yielding the value {@link computeFingerprint} covers. */
export function unfingerprinted(manifest: ProjectSnapshotManifest): UnfingerprintedManifest {
  const { fingerprint, ...rest } = manifest;
  void fingerprint;
  return rest;
}

// ── The build ────────────────────────────────────────────────────────────────

/**
 * Assemble a snapshot from structural inputs and per-file symbol shards. Pure:
 * the same inputs always produce the same manifest bytes and the same shard
 * bytes. The caller (the generator adapter) decides WHICH symbol shards to pass —
 * a full build passes freshly-extracted shards for every eligible file, an
 * incremental build passes reused shards for unchanged blobs plus freshly
 * extracted shards for the changed closure. Because symbol shards are addressed
 * by `blobOid` and content-addressed by their bytes, those two shard sets are
 * byte-identical, so both builds produce a byte-identical result.
 */
export function buildSnapshot(
  inputs: SnapshotStructuralInputs,
  symbolShards: readonly SymbolShard[],
  referenceShards: readonly ReferenceShard[] = [],
  importShards: readonly ImportShard[] = [],
): BuiltSnapshot {
  const shardBytes = new Map<string, string>();

  const files = structuralShard("files", sortedFiles(inputs.files));
  const scopes = structuralShard("scopes", sortedScopes(inputs.scopes));
  const edges = structuralShard("edges", sortedEdges(inputs.edges));
  const entryPoints = structuralShard("entryPoints", sortedEntryPoints(inputs.entryPoints));
  const tests = structuralShard("tests", sortedTests(inputs.tests));
  const ownership = structuralShard("ownership", inputs.ownership);
  const conventions = structuralShard("conventions", sortedConventions(inputs.conventions));

  const structural: Record<StructuralShardSlot, { built: BuiltShard; entries: number }> = {
    files: { built: files, entries: inputs.files.length },
    scopes: { built: scopes, entries: inputs.scopes.length },
    edges: { built: edges, entries: inputs.edges.length },
    entryPoints: { built: entryPoints, entries: inputs.entryPoints.length },
    tests: { built: tests, entries: inputs.tests.length },
    ownership: { built: ownership, entries: inputs.ownership.length },
    conventions: { built: conventions, entries: inputs.conventions.length },
  };

  const shards = {} as Record<StructuralShardSlot, ShardRef>;
  for (const slot of Object.keys(structural) as StructuralShardSlot[]) {
    const { built, entries } = structural[slot];
    shards[slot] = { digest: built.digest, entries };
    shardBytes.set(built.digest, built.bytes);
  }

  // The three per-blob shard families (symbols, references, imports), each
  // de-duplicated by blobOid (the same content anywhere yields the same shard) and
  // sorted by blobOid for a stable manifest.
  const symbols = perBlobPointers(symbolShards, symbolShardBytes, shardBytes);
  const references = perBlobPointers(referenceShards, referenceShardBytes, shardBytes);
  const imports = perBlobPointers(importShards, importShardBytes, shardBytes);

  const unpinned: UnfingerprintedManifest = {
    schemaVersion: PROJECT_SNAPSHOT_SCHEMA_VERSION,
    repoKey: inputs.repoKey,
    baseRef: inputs.baseRef,
    baseRefResolution: inputs.baseRefResolution,
    baseOid: inputs.baseOid,
    shards,
    symbols,
    references,
    imports,
  };

  const manifest: ProjectSnapshotManifest = {
    ...unpinned,
    fingerprint: computeFingerprint(unpinned),
  };

  return { manifest, shards: shardBytes };
}

/**
 * De-duplicate a per-blob shard family by `blobOid`, content-address each shard,
 * record its bytes in `sink`, and return the manifest's `[blobOid, digest]` pointer
 * array sorted by blobOid. Shared by all three families so their manifest shape and
 * dedup semantics cannot drift.
 */
function perBlobPointers<S extends { readonly blobOid: string }>(
  shards: readonly S[],
  bytesOf: (shard: S) => BuiltShard,
  sink: Map<string, string>,
): (readonly [string, string])[] {
  const byBlob = new Map<string, S>();
  for (const shard of shards) if (!byBlob.has(shard.blobOid)) byBlob.set(shard.blobOid, shard);
  const pointers: (readonly [string, string])[] = [];
  for (const blobOid of [...byBlob.keys()].sort(byString)) {
    const shard = byBlob.get(blobOid);
    if (!shard) continue;
    const built = bytesOf(shard);
    pointers.push([blobOid, built.digest] as const);
    sink.set(built.digest, built.bytes);
  }
  return pointers;
}

/** The canonical bytes of a manifest, for byte-comparison and durable writes. */
export function serializeManifest(manifest: ProjectSnapshotManifest): string {
  return canonicalize(manifest);
}

// ── Freshness & the staleness gate (acceptance: a stale shard cannot be served) ─

/**
 * Whether a stored snapshot is fresh for a request pinned to `requestedBaseOid`.
 * Freshness is content equality of the pin, NEVER age: a snapshot is fresh iff it
 * was built at exactly the OID the request resolves to. A snapshot at any other
 * OID is stale and must be rebuilt before it can be served.
 */
export function isSnapshotFresh(
  manifest: ProjectSnapshotManifest,
  requestedBaseOid: string,
): boolean {
  return (
    manifest.baseOid === requestedBaseOid &&
    manifest.schemaVersion === PROJECT_SNAPSHOT_SCHEMA_VERSION
  );
}

/**
 * WHY the integrity gate refused, when the refusal is not "a shard is missing or
 * mismatched". Without it the three whole-manifest refusals all surfaced downstream
 * as `corrupt, missing=0 mismatched=0`, which reads as "the store is damaged" —
 * and for `schema-version` that is simply untrue. A manifest written by an older
 * build is STALE: nothing is damaged, the snapshot just needs rebuilding.
 */
export type IntegrityRefusal =
  /** The manifest's schema version is not the one this build speaks. Stale, not corrupt. */
  | "schema-version"
  /** A required per-blob shard family (`symbols` / `references` / `imports`) is absent. */
  | "missing-family"
  /** The manifest's own fingerprint does not cover its current contents (tampered/damaged). */
  | "fingerprint";

export interface IntegrityResult {
  readonly ok: boolean;
  /** Shard digests the manifest references but the store could not produce. */
  readonly missing: readonly string[];
  /** Digests whose stored bytes do not hash back to the digest (corruption). */
  readonly mismatched: readonly string[];
  /**
   * The whole-manifest refusal, when there is one. Absent on `ok`, and absent when
   * the refusal is fully described by `missing`/`mismatched`.
   */
  readonly refusal?: IntegrityRefusal;
}

/**
 * Verify that every shard family the schema requires is PRESENT, that every shard
 * the manifest references is present AND its bytes hash back to the referenced
 * digest, and that the manifest's own fingerprint matches the rest of the manifest.
 * This is the gate the harness passes a request through: a missing shard family, a
 * missing shard, a corrupt shard, or a tampered manifest all fail closed, so a
 * stale/corrupt shard can never enter a request. `load` returns the stored bytes
 * for a digest, or `undefined` if absent.
 */
export function verifySnapshotIntegrity(
  manifest: ProjectSnapshotManifest,
  load: (digest: string) => string | undefined,
): IntegrityResult {
  // FAIL CLOSED on a manifest this build does not speak, before anything else. A
  // PAST schema is not merely "a snapshot missing a field": every version bump
  // exists because a shard family or a shard's shape changed, so an older manifest
  // that happens to be internally consistent (correct fingerprint, all three
  // families present, every shard intact) would otherwise pass this gate and be
  // served with an answer the newer readers cannot get right. `isSnapshotFresh`
  // already rejects it on the live path; this is the same refusal at the second
  // door, for a caller that verifies without asking about freshness.
  if (manifest.schemaVersion !== PROJECT_SNAPSHOT_SCHEMA_VERSION) {
    return { ok: false, missing: [], mismatched: [], refusal: "schema-version" };
  }

  // FAIL CLOSED on a missing shard FAMILY. `symbols` is
  // required in v1, `references` in v2 and `imports` in v3, so a manifest that
  // omits one is not a snapshot with an empty index — it is a manifest this build
  // cannot read, and materializing it would silently claim "no import edges" for a
  // repo full of them. (It would also fail the fingerprint check below, since the
  // digest covers the whole manifest; this makes the refusal explicit rather than
  // incidental, and keeps the iteration underneath from throwing on a non-array.)
  if (
    !Array.isArray(manifest.symbols) ||
    !Array.isArray(manifest.references) ||
    !Array.isArray(manifest.imports)
  ) {
    return { ok: false, missing: [], mismatched: [], refusal: "missing-family" };
  }

  const missing: string[] = [];
  const mismatched: string[] = [];

  const digests = new Set<string>();
  for (const slot of Object.keys(manifest.shards) as StructuralShardSlot[]) {
    digests.add(manifest.shards[slot].digest);
  }
  for (const [, digest] of manifest.symbols) digests.add(digest);
  for (const [, digest] of manifest.references) digests.add(digest);
  for (const [, digest] of manifest.imports) digests.add(digest);

  for (const digest of digests) {
    const bytes = load(digest);
    if (bytes === undefined) {
      missing.push(digest);
      continue;
    }
    if (sha256Hex(bytes) !== digest) mismatched.push(digest);
  }

  const fingerprintOk = computeFingerprint(unfingerprinted(manifest)) === manifest.fingerprint;

  return {
    ok: fingerprintOk && missing.length === 0 && mismatched.length === 0,
    missing: missing.sort(byString),
    mismatched: mismatched.sort(byString),
    // Only when the shard walk itself found nothing: a run with missing/mismatched
    // digests is already described by those lists, and naming the fingerprint too
    // would report a consequence as if it were the cause.
    ...(fingerprintOk || missing.length > 0 || mismatched.length > 0
      ? {}
      : { refusal: "fingerprint" as const }),
  };
}

// ── Incremental symbol planning ──────────────────────────────────────────────
//
// The pure half of the incremental rebuild: given the eligible files at the new
// OID and the symbol shards from the previous snapshot (indexed by blobOid),
// decide which blobs can be REUSED verbatim and which must be RE-EXTRACTED. Only
// the changed closure is re-extracted; everything else is carried by content.

/** File extensions the default extractor understands. */
const SYMBOL_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);

function extensionOf(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot).toLowerCase();
}

/**
 * Whether the symbol extractor understands this path's language at all.
 *
 * The distinction matters beyond extraction planning, because a shard is emitted for
 * files the extractor does NOT understand too ({@link structuralFactFiles}) — it
 * carries `symbols: []` and a real `generated` bit. So "the shard lists no symbols"
 * is TWO different facts, and only this predicate tells them apart: a `.ts` with no
 * exports, versus a `.md` the extractor never had anything to say about. A caller
 * comparing two shards to decide whether a file's structure moved must not read the
 * second as "nothing changed".
 */
export function hasSymbolExtractor(path: string): boolean {
  return SYMBOL_EXTENSIONS.has(extensionOf(path));
}

/** The files eligible for symbol extraction (source files the extractor understands). */
export function eligibleSymbolFiles(files: readonly SnapshotFileEntry[]): SnapshotFileEntry[] {
  return files.filter((file) => hasSymbolExtractor(file.path));
}

/**
 * The files a per-blob STRUCTURAL-FACTS shard is emitted for — the `symbols` family,
 * which carries two facts about a blob: what the symbol extractor found in it, and
 * whether it opens with a generator's banner ({@link SymbolShard.generated}).
 *
 * It is the UNION of two sets, because the family answers two questions:
 *  - every file the SYMBOL extractor understands (TypeScript/JavaScript), wherever it
 *    lives — so `context.symbol` / `context.overview` keep exactly the coverage they
 *    had, including inside a `dist/` or vendored tree;
 *  - every file whose mapping eligibility is NOT already decided by its path, so the
 *    banner check reaches a generated `.py`, `.sql` or `.graphql` that no path rule
 *    catches. A file the path rules already exclude (vendored, a lockfile, a `dist/`
 *    output, a binary extension) is skipped: content evidence cannot overturn a
 *    verdict the path has already made, so reading it would buy nothing.
 *
 * A non-TS/JS file gets a shard with `symbols: []` and its real `generated` bit. That
 * is the honest encoding — the extractor genuinely has nothing to say about a `.py` —
 * and it keeps the whole classification in ONE per-blob family, with one manifest
 * pointer array, one integrity walk and one incremental planner, rather than a fourth
 * family duplicating all of it to carry a single bit.
 *
 * Residual ceiling: `isBinaryPath` is an extension list, so an extensionless or
 * novel binary format still reads as text here. It costs one blob read and yields
 * `symbols: []` plus a banner bit that is almost certainly `false`; no file content
 * ever reaches the shard, so the cost is time, not correctness.
 */
export function structuralFactFiles(files: readonly SnapshotFileEntry[]): SnapshotFileEntry[] {
  return files.filter(
    (file) => hasSymbolExtractor(file.path) || classifyMappingEligibility(file.path) === null,
  );
}

/** A per-blob shard family's incremental plan: what to carry, what to re-extract. */
export interface ShardPlan<S> {
  /** Shards carried verbatim from the previous snapshot (blob unchanged). */
  readonly reuse: readonly S[];
  /** Files whose shard must be freshly extracted (blob new or previously absent). */
  readonly toExtract: readonly SnapshotFileEntry[];
}

/** A per-blob shard: addressed by blob content, stamped with its extractor's identity. */
interface BlobShard {
  readonly blobOid: string;
  readonly extractor: string;
}

/**
 * Plan an incremental extraction for one per-blob shard family. A file whose
 * `blobOid` already has a shard in `previousByBlob` (from the same extractor) is
 * reused verbatim — its bytes are a pure function of blob content (no path), so it
 * is byte-identical to what a clean build would extract at this file's path, and
 * reuse is free and path-independent. Everything else is queued for extraction.
 * The result is independent of iteration order.
 */
function planIncremental<S extends BlobShard>(
  eligible: readonly SnapshotFileEntry[],
  previousByBlob: ReadonlyMap<string, S>,
  extractorId: string,
): ShardPlan<S> {
  const reuse: S[] = [];
  const toExtract: SnapshotFileEntry[] = [];
  const seen = new Set<string>();
  for (const file of eligible) {
    if (seen.has(file.blobOid)) continue;
    seen.add(file.blobOid);
    const prior = previousByBlob.get(file.blobOid);
    if (prior && prior.extractor === extractorId) reuse.push(prior);
    else toExtract.push(file);
  }
  return { reuse, toExtract };
}

/** Index a previous snapshot's per-blob shards by blobOid, for reuse planning. */
function indexByBlob<S extends BlobShard>(shards: readonly S[]): Map<string, S> {
  const index = new Map<string, S>();
  for (const shard of shards) if (!index.has(shard.blobOid)) index.set(shard.blobOid, shard);
  return index;
}

export type SymbolPlan = ShardPlan<SymbolShard>;

/** Plan an incremental SYMBOL extraction — see {@link planIncremental}. */
export function planIncrementalSymbols(
  eligible: readonly SnapshotFileEntry[],
  previousByBlob: ReadonlyMap<string, SymbolShard>,
  extractorId: string,
): SymbolPlan {
  return planIncremental(eligible, previousByBlob, extractorId);
}

/** Index a previous snapshot's symbol shards by blobOid, for reuse planning. */
export function indexSymbolShards(shards: readonly SymbolShard[]): Map<string, SymbolShard> {
  return indexByBlob(shards);
}

// ── The default deterministic symbol extractor (structural-ts-v1) ─────────────
//
// A dependency-free, deterministic extractor for TypeScript/JavaScript top-level
// EXPORTS. It is deliberately shallow and structural — it reads statement-leading
// `export` declarations, not a full parse tree — because the load-bearing
// property of this map is REPRODUCIBILITY, not symbol completeness. It is a pure
// function of the file's bytes, so it satisfies the content-addressed reuse
// contract. Richer extraction (a real AST, more languages, nested and local
// symbols, references) is a follow-on that swaps this port implementation without
// changing the snapshot shape. The `extractor` id below invalidates old shards
// honestly when that upgrade lands.

// `structural-ts-v2` is the same extraction with one more recorded fact: the
// generated-banner flag (W2). The id moved because the SHARD BYTES moved, which is
// exactly what the extractor identity is for — a v1 shard cannot answer
// `generated`, so it must not be reused as if it could.
export const DEFAULT_SYMBOL_EXTRACTOR_ID = "structural-ts-v2";

/** Extract a source file's symbols. Same bytes ⇒ same symbols, always. */
export type SnapshotSymbolExtractor = (path: string, text: string) => SnapshotSymbol[];

const DECLARATION_PATTERNS: readonly {
  readonly re: RegExp;
  readonly kind: SnapshotSymbol["kind"];
}[] = [
  { re: /^export\s+(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/, kind: "function" },
  { re: /^export\s+(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, kind: "class" },
  { re: /^export\s+(?:declare\s+)?const\s+enum\s+([A-Za-z_$][\w$]*)/, kind: "enum" },
  { re: /^export\s+(?:declare\s+)?enum\s+([A-Za-z_$][\w$]*)/, kind: "enum" },
  { re: /^export\s+(?:declare\s+)?const\s+([A-Za-z_$][\w$]*)/, kind: "const" },
  { re: /^export\s+(?:declare\s+)?let\s+([A-Za-z_$][\w$]*)/, kind: "let" },
  { re: /^export\s+(?:declare\s+)?var\s+([A-Za-z_$][\w$]*)/, kind: "var" },
  { re: /^export\s+interface\s+([A-Za-z_$][\w$]*)/, kind: "interface" },
  { re: /^export\s+type\s+([A-Za-z_$][\w$]*)/, kind: "type" },
];

/**
 * The default extractor. Walks physical lines, skipping block comments, and
 * records the exported declaration on any line that begins (after leading
 * whitespace) with `export`. Named re-exports (`export { A, B as C }`) record the
 * exported binding name; `export default` records `default`; `export * from`
 * records `*`. It is best-effort: a `export` inside a template literal is an
 * accepted false-positive source, documented above. Deterministic in all cases.
 */
export const structuralTsExtractor: SnapshotSymbolExtractor = (path, text) => {
  const ext = extensionOf(path);
  if (!SYMBOL_EXTENSIONS.has(ext)) return [];
  const symbols: SnapshotSymbol[] = [];
  const lines = text.split("\n");
  let inBlockComment = false;

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index] ?? "";
    const line = rawLine.trim();
    const lineNumber = index + 1;

    if (inBlockComment) {
      const close = line.indexOf("*/");
      if (close === -1) continue;
      inBlockComment = false;
      // Fall through to inspect anything after the close on the same line only if
      // it starts an export; conservatively, we skip the remainder this line.
      continue;
    }
    if (line.startsWith("/*")) {
      if (line.indexOf("*/", 2) === -1) inBlockComment = true;
      continue;
    }
    if (!line.startsWith("export")) continue;
    // Require a word boundary after `export` so `exportfoo` never matches.
    if (!/^export[\s{*]/.test(line) && line !== "export") continue;

    if (/^export\s+default\b/.test(line)) {
      symbols.push({ name: "default", kind: "default", line: lineNumber });
      continue;
    }
    if (/^export\s*\*/.test(line)) {
      symbols.push({ name: "*", kind: "reexport", line: lineNumber });
      continue;
    }
    const braceMatch = /^export\s+(?:type\s+)?\{([^}]*)\}/.exec(line);
    if (braceMatch) {
      for (const raw of (braceMatch[1] ?? "").split(",")) {
        const spec = raw.trim();
        if (!spec) continue;
        const asMatch = /\bas\s+([A-Za-z_$][\w$]*)/.exec(spec);
        const name = asMatch ? asMatch[1] : /^([A-Za-z_$][\w$]*)/.exec(spec)?.[1];
        if (name) symbols.push({ name, kind: "reexport", line: lineNumber });
      }
      continue;
    }
    for (const { re, kind } of DECLARATION_PATTERNS) {
      const match = re.exec(line);
      if (match?.[1]) {
        symbols.push({ name: match[1], kind, line: lineNumber });
        break;
      }
    }
  }
  return symbols;
};

/** Build a symbol shard for a file from its content and an extractor. */
export function extractSymbolShard(
  file: SnapshotFileEntry,
  text: string,
  extract: SnapshotSymbolExtractor = structuralTsExtractor,
  extractorId: string = DEFAULT_SYMBOL_EXTRACTOR_ID,
): SymbolShard {
  return {
    blobOid: file.blobOid,
    extractor: extractorId,
    // `file.path` gates extraction (the extractor understands only source
    // extensions), but it is NOT stored on the shard: the shard is a pure
    // function of blob content, so its path is recovered from the `files` shard.
    symbols: extract(file.path, text),
    // Derived HERE rather than inside `extract`, so a substituted extractor cannot
    // drop it — and from the text alone, so it stays a pure function of the blob.
    generated: hasGeneratedMarker(text),
  };
}

// ── The default deterministic REFERENCE extractor (structural-refs-v1) ─────────
//
// The occurrence-index analogue of the symbol extractor, for `context.references`
// (#200). Deliberately SHALLOW and TEXTUAL, in the same spirit as the symbol
// extractor: it records every identifier token's 1-based line occurrences, skipping
// block comments and a small set of language keywords, but does NOT parse. That is
// what keeps it a pure, byte-reproducible function of the blob (so an unchanged blob
// reuses its shard for free). Its honest, documented limits:
//   - NAME-based, not semantic: two distinct symbols that share a name are indistinct.
//   - TEXTUAL: a mention in a line comment or a string literal is recorded as an
//     occurrence (an accepted false-positive; block comments ARE skipped).
//   - It records the declaration site too — every textual occurrence of the name.
// Richer, scope-aware references are a follow-on that swaps this extractor; the id
// below invalidates old reference shards honestly when that lands.

export const DEFAULT_REFERENCE_EXTRACTOR_ID = "structural-refs-v1";

/** Extract a source file's identifier occurrences. Same bytes ⇒ same references, always. */
export type SnapshotReferenceExtractor = (path: string, text: string) => ReferenceOccurrence[];

// JavaScript/TypeScript reserved words and primitive-type keywords. Excluded so the
// index holds referenceable identifiers, not language syntax — a query is never for
// `const` or `return`, and keeping them out bounds the index without hurting the
// blast-radius use case. A fixed, finite set, so the exclusion is deterministic.
const REFERENCE_STOPWORDS: ReadonlySet<string> = new Set([
  "abstract",
  "any",
  "as",
  "asserts",
  "async",
  "await",
  "bigint",
  "boolean",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "declare",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "from",
  "function",
  "get",
  "if",
  "implements",
  "import",
  "in",
  "infer",
  "instanceof",
  "interface",
  "is",
  "keyof",
  "let",
  "namespace",
  "never",
  "new",
  "null",
  "number",
  "object",
  "of",
  "override",
  "package",
  "private",
  "protected",
  "public",
  "readonly",
  "return",
  "satisfies",
  "set",
  "static",
  "string",
  "super",
  "switch",
  "symbol",
  "this",
  "throw",
  "true",
  "try",
  "type",
  "typeof",
  "undefined",
  "unique",
  "unknown",
  "var",
  "void",
  "while",
  "with",
  "yield",
]);

const IDENTIFIER_TOKEN = /[A-Za-z_$][\w$]*/g;

/**
 * The default reference extractor. Walks physical lines, skipping block comments
 * (like the symbol extractor), and records every identifier token's 1-based line,
 * minus the language keywords in {@link REFERENCE_STOPWORDS}. Returns one
 * {@link ReferenceOccurrence} per distinct name, `lines` sorted ascending and
 * de-duplicated, the whole list sorted by name — a deterministic pure function of
 * the bytes.
 */
export const structuralReferenceExtractor: SnapshotReferenceExtractor = (path, text) => {
  const ext = extensionOf(path);
  if (!SYMBOL_EXTENSIONS.has(ext)) return [];
  const linesByName = new Map<string, Set<number>>();
  const stripped = stripBlockComments(text.split("\n"));

  for (let index = 0; index < stripped.length; index += 1) {
    const scan = stripped[index] ?? "";
    const lineNumber = index + 1;

    for (const match of scan.matchAll(IDENTIFIER_TOKEN)) {
      const name = match[0];
      if (REFERENCE_STOPWORDS.has(name)) continue;
      let set = linesByName.get(name);
      if (set === undefined) {
        set = new Set<number>();
        linesByName.set(name, set);
      }
      set.add(lineNumber);
    }
  }

  return [...linesByName.keys()].sort(byString).map((name) => ({
    name,
    lines: [...(linesByName.get(name) ?? new Set<number>())].sort((a, b) => a - b),
  }));
};

/** Build a reference shard for a file from its content and an extractor. */
export function extractReferenceShard(
  file: SnapshotFileEntry,
  text: string,
  extract: SnapshotReferenceExtractor = structuralReferenceExtractor,
  extractorId: string = DEFAULT_REFERENCE_EXTRACTOR_ID,
): ReferenceShard {
  return {
    blobOid: file.blobOid,
    extractor: extractorId,
    references: extract(file.path, text),
  };
}

export type ReferencePlan = ShardPlan<ReferenceShard>;

/**
 * Plan an incremental reference extraction — the exact analogue of
 * {@link planIncrementalSymbols}. A file whose `blobOid` already has a reference
 * shard from the same extractor is reused; otherwise it is queued for extraction.
 */
export function planIncrementalReferences(
  eligible: readonly SnapshotFileEntry[],
  previousByBlob: ReadonlyMap<string, ReferenceShard>,
  extractorId: string,
): ReferencePlan {
  return planIncremental(eligible, previousByBlob, extractorId);
}

/** Index a previous snapshot's reference shards by blobOid, for reuse planning. */
export function indexReferenceShards(
  shards: readonly ReferenceShard[],
): Map<string, ReferenceShard> {
  return indexByBlob(shards);
}

// ── The default deterministic IMPORT extractor (structural-imports-v1) ─────────
//
// The third per-blob family, and the one the context map's module batching is built
// on: the repo-wide file-to-file import graph. Like its two siblings it is
// deliberately SHALLOW and TEXTUAL — it matches the four import forms with the
// shared regexes in `./import-specifiers` after stripping block comments, and does
// NOT parse. That is what keeps it a pure, byte-reproducible function of the blob,
// so an unchanged blob reuses its shard for free.
//
// The shard holds RAW specifiers, never resolved paths: relative resolution depends
// on the IMPORTING FILE'S path, and a path in the shard bytes would break the
// rename/copy reuse contract the other two families rely on. The extractor is not
// even GIVEN the path, so that contract cannot be broken by a substituted
// extractor. Resolution to real
// file→file edges is a separate, equally deterministic step over the shard plus the
// `files` inventory and the `scopes` table (`queryImportGraph`, project-context.ts).
// Its honest, documented limits:
//   - TEXTUAL: a specifier in a template literal or a line comment is recorded (an
//     accepted false positive; block comments ARE stripped).
//   - A COMPUTED specifier (`import(pathVariable)`) is invisible — no string, no match.
//   - Type-only imports are indistinguishable from value imports.

export const DEFAULT_IMPORT_EXTRACTOR_ID = "structural-imports-v1";

/**
 * Extract a source file's raw import specifiers from its BYTES. Same bytes ⇒ same
 * specifiers, always.
 *
 * ⭐ It is handed no path, ON PURPOSE. `planIncremental` reuses a shard for any file
 * whose blob is unchanged, on the stated grounds that the shard is a pure function
 * of blob content — so a path-sensitive extractor would make an incremental build
 * differ from a clean one (same blob, moved file ⇒ different shard) and break that
 * contract from the outside. Denying the path makes the contract structural rather
 * than a promise a custom extractor can quietly break. WHICH files are extracted at
 * all is an eligibility question the CALLER answers ({@link eligibleSymbolFiles}),
 * before the bytes ever reach here.
 */
export type SnapshotImportExtractor = (text: string) => string[];

/**
 * The default import extractor. Strips block comments and matches the four import
 * forms — a deterministic pure function of the bytes. Ordering and de-duplication
 * are the shard boundary's job ({@link extractImportShard}), not the extractor's.
 */
export const structuralImportExtractor: SnapshotImportExtractor = (text) =>
  importSpecifiers(stripBlockComments(text.split("\n")));

/**
 * Build an import shard for a file from its content and an extractor.
 *
 * Only `file.blobOid` is read — never `file.path` — so the shard bytes are a pure
 * function of blob content and the extractor's identity, which is exactly what
 * makes blob-keyed reuse safe (see {@link SnapshotImportExtractor}). The specifiers
 * are NORMALIZED here, distinct and sorted in code-unit order, so a custom
 * extractor's ordering or duplicates cannot vary the shard's canonical bytes.
 *
 * The caller passes only files it has already decided are eligible for extraction
 * ({@link eligibleSymbolFiles}); this does not re-decide it, because re-deciding
 * from `file.path` is the path dependence the family is built to avoid.
 */
export function extractImportShard(
  file: SnapshotFileEntry,
  text: string,
  extract: SnapshotImportExtractor = structuralImportExtractor,
  extractorId: string = DEFAULT_IMPORT_EXTRACTOR_ID,
): ImportShard {
  return {
    blobOid: file.blobOid,
    extractor: extractorId,
    imports: [...new Set(extract(text))].sort(byString),
  };
}

export type ImportPlan = ShardPlan<ImportShard>;

/**
 * Plan an incremental import extraction — the exact analogue of
 * {@link planIncrementalSymbols}. A file whose `blobOid` already has an import
 * shard from the same extractor is reused; otherwise it is queued for extraction.
 */
export function planIncrementalImports(
  eligible: readonly SnapshotFileEntry[],
  previousByBlob: ReadonlyMap<string, ImportShard>,
  extractorId: string,
): ImportPlan {
  return planIncremental(eligible, previousByBlob, extractorId);
}

/** Index a previous snapshot's import shards by blobOid, for reuse planning. */
export function indexImportShards(shards: readonly ImportShard[]): Map<string, ImportShard> {
  return indexByBlob(shards);
}
