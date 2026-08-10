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

import { canonicalize, sha256Hex } from "@rennet/protocol";
import type {
  BaseRefResolution,
  BuiltShard,
  BuiltSnapshot,
  ConventionEntry,
  DependencyEdge,
  EntryPoint,
  OwnershipRule,
  ProjectSnapshotManifest,
  ShardRef,
  SnapshotFileEntry,
  SnapshotSymbol,
  StructuralShardSlot,
  SymbolShard,
  TestEntry,
  WorkspaceScope,
} from "@rennet/types";
import { PROJECT_SNAPSHOT_SCHEMA_VERSION } from "@rennet/types";

/** Content-address any value: its canonical bytes and their sha256. */
export function contentAddress(value: unknown): BuiltShard {
  const bytes = canonicalize(value);
  return { bytes, digest: sha256Hex(bytes) };
}

/** The structural facts a snapshot is assembled from, all derived at `baseOid`. */
export interface SnapshotStructuralInputs {
  /** The RepoRecord key: `realpath(git-common-dir)` (R19). */
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
    symbols: shard.symbols,
  });
}

// ── The fingerprint ──────────────────────────────────────────────────────────

/**
 * The identifying pin the fingerprint covers, alongside the shard digests. This
 * is EVERY canonical manifest field except the shard pointers themselves and the
 * fingerprint: so two manifests that differ only in `repoKey`, `baseRef`, or
 * `baseRefResolution` get DIFFERENT fingerprints (#4), while two builds of the
 * same tree on the same repo share one.
 */
export interface FingerprintPin {
  /** The RepoRecord key: `realpath(git-common-dir)` (R19). */
  readonly repoKey: string;
  readonly baseRef: string;
  readonly baseRefResolution: BaseRefResolution;
  readonly baseOid: string;
}

/**
 * The freshness/integrity fingerprint: a digest over the pin (`schemaVersion`,
 * `repoKey`, `baseRef`, `baseRefResolution`, `baseOid`) plus every shard digest.
 * It covers all canonical manifest content (#4), so the fingerprint alone
 * identifies the snapshot's content. Deterministic and clock-free, so two builds
 * of the same tree on the same repo share a fingerprint; two snapshots are the
 * same content iff their fingerprints match.
 */
export function computeFingerprint(
  pin: FingerprintPin,
  shards: Readonly<Record<StructuralShardSlot, ShardRef>>,
  symbols: readonly (readonly [string, string])[],
): string {
  const structural: Record<string, string> = {};
  for (const slot of Object.keys(shards).sort() as StructuralShardSlot[]) {
    structural[slot] = shards[slot].digest;
  }
  const symbolDigests = [...symbols]
    .map(([blobOid, digest]) => [blobOid, digest] as const)
    .sort((l, r) => byString(l[0], r[0]));
  return sha256Hex(
    canonicalize({
      schemaVersion: PROJECT_SNAPSHOT_SCHEMA_VERSION,
      repoKey: pin.repoKey,
      baseRef: pin.baseRef,
      baseRefResolution: pin.baseRefResolution,
      baseOid: pin.baseOid,
      structural,
      symbols: symbolDigests,
    }),
  );
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

  // Symbol shards, de-duplicated by blobOid (the same content anywhere yields
  // the same shard) and sorted by blobOid for a stable manifest.
  const byBlob = new Map<string, SymbolShard>();
  for (const shard of symbolShards) {
    if (!byBlob.has(shard.blobOid)) byBlob.set(shard.blobOid, shard);
  }
  const symbols: (readonly [string, string])[] = [];
  for (const blobOid of [...byBlob.keys()].sort(byString)) {
    const shard = byBlob.get(blobOid);
    if (!shard) continue;
    const built = symbolShardBytes(shard);
    symbols.push([blobOid, built.digest] as const);
    shardBytes.set(built.digest, built.bytes);
  }

  const fingerprint = computeFingerprint(
    {
      repoKey: inputs.repoKey,
      baseRef: inputs.baseRef,
      baseRefResolution: inputs.baseRefResolution,
      baseOid: inputs.baseOid,
    },
    shards,
    symbols,
  );

  const manifest: ProjectSnapshotManifest = {
    schemaVersion: PROJECT_SNAPSHOT_SCHEMA_VERSION,
    repoKey: inputs.repoKey,
    baseRef: inputs.baseRef,
    baseRefResolution: inputs.baseRefResolution,
    baseOid: inputs.baseOid,
    fingerprint,
    shards,
    symbols,
  };

  return { manifest, shards: shardBytes };
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

export interface IntegrityResult {
  readonly ok: boolean;
  /** Shard digests the manifest references but the store could not produce. */
  readonly missing: readonly string[];
  /** Digests whose stored bytes do not hash back to the digest (corruption). */
  readonly mismatched: readonly string[];
}

/**
 * Verify that every shard the manifest references is present AND its bytes hash
 * back to the referenced digest, and that the manifest's own fingerprint matches
 * its shard digests. This is the gate the harness passes a request through: a
 * missing shard, a corrupt shard, or a tampered manifest all fail closed, so a
 * stale/corrupt shard can never enter a request. `load` returns the stored bytes
 * for a digest, or `undefined` if absent.
 */
export function verifySnapshotIntegrity(
  manifest: ProjectSnapshotManifest,
  load: (digest: string) => string | undefined,
): IntegrityResult {
  const missing: string[] = [];
  const mismatched: string[] = [];

  const digests = new Set<string>();
  for (const slot of Object.keys(manifest.shards) as StructuralShardSlot[]) {
    digests.add(manifest.shards[slot].digest);
  }
  for (const [, digest] of manifest.symbols) digests.add(digest);

  for (const digest of digests) {
    const bytes = load(digest);
    if (bytes === undefined) {
      missing.push(digest);
      continue;
    }
    if (sha256Hex(bytes) !== digest) mismatched.push(digest);
  }

  const fingerprintOk =
    computeFingerprint(
      {
        repoKey: manifest.repoKey,
        baseRef: manifest.baseRef,
        baseRefResolution: manifest.baseRefResolution,
        baseOid: manifest.baseOid,
      },
      manifest.shards,
      manifest.symbols,
    ) === manifest.fingerprint;

  return {
    ok: fingerprintOk && missing.length === 0 && mismatched.length === 0,
    missing: missing.sort(byString),
    mismatched: mismatched.sort(byString),
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

/** The files eligible for symbol extraction (source files the extractor understands). */
export function eligibleSymbolFiles(files: readonly SnapshotFileEntry[]): SnapshotFileEntry[] {
  return files.filter((file) => SYMBOL_EXTENSIONS.has(extensionOf(file.path)));
}

export interface SymbolPlan {
  /** Shards carried verbatim from the previous snapshot (blob unchanged). */
  readonly reuse: readonly SymbolShard[];
  /** Files whose symbols must be freshly extracted (blob new or previously absent). */
  readonly toExtract: readonly SnapshotFileEntry[];
}

/**
 * Plan an incremental symbol extraction. A file whose `blobOid` already has a
 * shard in `previousByBlob` (from the same extractor) is reused; otherwise it is
 * queued for extraction. The result is independent of iteration order.
 */
export function planIncrementalSymbols(
  eligible: readonly SnapshotFileEntry[],
  previousByBlob: ReadonlyMap<string, SymbolShard>,
  extractorId: string,
): SymbolPlan {
  const reuse: SymbolShard[] = [];
  const toExtract: SnapshotFileEntry[] = [];
  const seen = new Set<string>();
  for (const file of eligible) {
    if (seen.has(file.blobOid)) continue;
    seen.add(file.blobOid);
    const prior = previousByBlob.get(file.blobOid);
    if (prior && prior.extractor === extractorId) {
      // Reuse the prior shard verbatim. Its bytes are a pure function of blob
      // content (no path), so it is byte-identical to what a clean build would
      // extract at this file's path — reuse is free and path-independent.
      reuse.push(prior);
    } else {
      toExtract.push(file);
    }
  }
  return { reuse, toExtract };
}

/** Index a previous snapshot's symbol shards by blobOid, for reuse planning. */
export function indexSymbolShards(shards: readonly SymbolShard[]): Map<string, SymbolShard> {
  const index = new Map<string, SymbolShard>();
  for (const shard of shards) if (!index.has(shard.blobOid)) index.set(shard.blobOid, shard);
  return index;
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

export const DEFAULT_SYMBOL_EXTRACTOR_ID = "structural-ts-v1";

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
  };
}
