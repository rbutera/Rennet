/**
 * ProjectContext — the deterministic, MODEL-FREE read side of the ProjectSnapshot
 * (issue #14, Part 3: `context.map` / `context.file`, deterministic slice).
 *
 * The foundation (`project-snapshot.ts` + the adapters) WRITES a content-addressed
 * snapshot: a manifest that points at structural shards (files, scopes, edges,
 * entry points, tests, ownership, conventions) plus per-file symbol shards keyed
 * by `blobOid`. This module is the READ side — it turns that manifest + a shard
 * loader back into answers to two questions, with NO model anywhere in the path:
 *
 *  - `context.map`  → {@link queryProjectMap}:  "what is the shape of this project?"
 *  - `context.file` → {@link queryFileContext}: "what does the snapshot know about
 *                     THIS file?" (its structural entry + the symbols for its blob,
 *                     recovered by joining `path → blobOid → symbol shard`).
 *
 * Determinism: same snapshot in ⇒ same answer out. No clock, no randomness, no
 * IO — all shard bytes arrive through an injected loader `(digest) => bytes`, the
 * exact shape `verifySnapshotIntegrity` already uses. The functions are pure over
 * the manifest and that loader.
 *
 * Fail-closed: {@link materializeSnapshot} hash-checks every structural shard it
 * decodes, and {@link queryFileContext} hash-checks the one symbol shard it loads,
 * so a missing or corrupt shard yields a typed failure, never a silent wrong
 * answer — even when the caller has NOT run the whole-snapshot integrity gate.
 * (The adapter reader runs `verifySnapshotIntegrity` too, for the whole-snapshot
 * "a stale shard cannot enter a request" guarantee.)
 *
 * ⛔ This module is deliberately model-free. The LLM knowledge layer
 * (`context.knowledge`, `.rennet/knowledge/`) is a later wave and lives nowhere
 * near here — keeping it out is what preserves the checkability of the map.
 */

import type {
  BaseRefResolution,
  ConventionEntry,
  DependencyEdge,
  EntryPoint,
  OwnershipRule,
  ProjectSnapshotManifest,
  ReferenceShard,
  SnapshotFileEntry,
  SnapshotSymbol,
  StructuralShardSlot,
  SymbolShard,
  TestEntry,
  WorkspaceScope,
} from "@rennet/protocol";
import { sha256Hex } from "@rennet/protocol";
import type { FanInIndex } from "./blast-radius";

/** Load a content-addressed shard's bytes by digest, or `undefined` if absent. */
export type ShardLoader = (digest: string) => string | undefined;

// ── Shard decoding (fail-closed) ─────────────────────────────────────────────
//
// Structural shard bytes are `canonicalize({ slot, version, entries })`; a
// symbol shard's bytes are `canonicalize({ blobOid, extractor, symbols })`. We
// only ever PARSE here (never re-canonicalize), and we hash-check the bytes
// against the digest the manifest referenced before trusting the parse, so a
// corrupt or substituted shard cannot produce a wrong answer.

interface DecodedStructuralShard {
  readonly slot: string;
  readonly version: number;
  readonly entries: readonly unknown[];
}

/**
 * Load, hash-verify, and parse a structural shard, returning its `entries`, or
 * `undefined` on ANY problem (absent, hash mismatch, malformed JSON, wrong slot).
 */
function loadStructuralEntries(
  load: ShardLoader,
  slot: StructuralShardSlot,
  digest: string,
): readonly unknown[] | undefined {
  const bytes = load(digest);
  if (bytes === undefined) return undefined;
  if (sha256Hex(bytes) !== digest) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const shard = parsed as Partial<DecodedStructuralShard>;
  // Defensive: the slot is inside the bytes precisely so a shard cannot be served
  // for the wrong slot even if two digests were swapped.
  if (shard.slot !== slot || !Array.isArray(shard.entries)) return undefined;
  return shard.entries;
}

/**
 * Load, hash-verify, and parse a per-file symbol shard, or `undefined` on any
 * problem. Addressed by `blobOid`; carries no path.
 */
function loadSymbolShard(load: ShardLoader, digest: string): SymbolShard | undefined {
  const bytes = load(digest);
  if (bytes === undefined) return undefined;
  if (sha256Hex(bytes) !== digest) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const shard = parsed as Partial<SymbolShard>;
  if (typeof shard.blobOid !== "string" || typeof shard.extractor !== "string") return undefined;
  if (!Array.isArray(shard.symbols)) return undefined;
  return { blobOid: shard.blobOid, extractor: shard.extractor, symbols: shard.symbols };
}

/**
 * Load, hash-verify, and parse a per-file REFERENCE shard, or `undefined` on any
 * problem (absent, hash mismatch, malformed JSON, wrong shape). Addressed by
 * `blobOid`; carries no path — the exact analogue of {@link loadSymbolShard}.
 */
function loadReferenceShard(load: ShardLoader, digest: string): ReferenceShard | undefined {
  const bytes = load(digest);
  if (bytes === undefined) return undefined;
  if (sha256Hex(bytes) !== digest) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const shard = parsed as Partial<ReferenceShard>;
  if (typeof shard.blobOid !== "string" || typeof shard.extractor !== "string") return undefined;
  if (!Array.isArray(shard.references)) return undefined;
  return { blobOid: shard.blobOid, extractor: shard.extractor, references: shard.references };
}

// ── Materialization ──────────────────────────────────────────────────────────

/**
 * A snapshot decoded from its manifest into queryable structural collections,
 * plus the `blobOid → symbol-shard-digest` index and the loader — so a per-file
 * query can resolve the ONE symbol shard it needs lazily, rather than decoding
 * every file's symbols to answer a single-file question.
 */
export interface LoadedSnapshot {
  readonly manifest: ProjectSnapshotManifest;
  readonly files: readonly SnapshotFileEntry[];
  readonly scopes: readonly WorkspaceScope[];
  readonly edges: readonly DependencyEdge[];
  readonly entryPoints: readonly EntryPoint[];
  readonly tests: readonly TestEntry[];
  readonly ownership: readonly OwnershipRule[];
  readonly conventions: readonly ConventionEntry[];
  /** `blobOid → symbol-shard digest`, from `manifest.symbols`. */
  readonly symbolDigestByBlob: ReadonlyMap<string, string>;
  /** `blobOid → reference-shard digest`, from `manifest.references` (#200). */
  readonly referenceDigestByBlob: ReadonlyMap<string, string>;
  /** The shard loader, retained for lazy per-file symbol/reference resolution. */
  readonly load: ShardLoader;
}

export type MaterializeResult =
  | { readonly ok: true; readonly snapshot: LoadedSnapshot }
  | { readonly ok: false; readonly reason: "shard-unavailable"; readonly slots: readonly string[] };

const STRUCTURAL_SLOTS: readonly StructuralShardSlot[] = [
  "files",
  "scopes",
  "edges",
  "entryPoints",
  "tests",
  "ownership",
  "conventions",
];

/**
 * Decode a manifest into a {@link LoadedSnapshot}. Every structural shard is
 * loaded and hash-verified; if ANY is absent or corrupt the whole thing fails
 * closed (naming the failed slots) rather than returning a partial map. The
 * decoded entries are trusted after the hash-check — they are our own canonical
 * bytes — so the arrays are cast without a deep re-validation.
 */
export function materializeSnapshot(
  manifest: ProjectSnapshotManifest,
  load: ShardLoader,
): MaterializeResult {
  const decoded: Partial<Record<StructuralShardSlot, readonly unknown[]>> = {};
  const failed: string[] = [];
  for (const slot of STRUCTURAL_SLOTS) {
    const ref = manifest.shards[slot];
    const entries = ref ? loadStructuralEntries(load, slot, ref.digest) : undefined;
    if (entries === undefined) {
      failed.push(slot);
      continue;
    }
    decoded[slot] = entries;
  }
  if (failed.length > 0) return { ok: false, reason: "shard-unavailable", slots: failed };

  const symbolDigestByBlob = new Map<string, string>();
  for (const [blobOid, digest] of manifest.symbols) symbolDigestByBlob.set(blobOid, digest);

  const referenceDigestByBlob = new Map<string, string>();
  // `references` is required in v2, but tolerate a defensively-parsed manifest that
  // lacks it (⇒ an empty reference index, an honest "no references known").
  for (const [blobOid, digest] of manifest.references ?? []) {
    referenceDigestByBlob.set(blobOid, digest);
  }

  return {
    ok: true,
    snapshot: {
      manifest,
      files: decoded.files as readonly SnapshotFileEntry[],
      scopes: decoded.scopes as readonly WorkspaceScope[],
      edges: decoded.edges as readonly DependencyEdge[],
      entryPoints: decoded.entryPoints as readonly EntryPoint[],
      tests: decoded.tests as readonly TestEntry[],
      ownership: decoded.ownership as readonly OwnershipRule[],
      conventions: decoded.conventions as readonly ConventionEntry[],
      symbolDigestByBlob,
      referenceDigestByBlob,
      load,
    },
  };
}

// ── Path safety (repo-relative, escape-checked) ──────────────────────────────

/**
 * Whether `path` is a safe repo-relative POSIX path: non-empty, not absolute, no
 * backslashes, and no `.`/`..`/empty segments (so `../`, `a/../b`, `/abs`, `./x`,
 * `a//b`, and trailing slashes are all refused). This is the address check for
 * `context.file`; symlink-ESCAPE at content-read time is surfaced separately via
 * {@link FileContext.isSymlink} for the (deferred) content reader to refuse.
 */
export function isSafeRepoRelativePath(path: string): boolean {
  if (typeof path !== "string" || path.length === 0) return false;
  if (path.startsWith("/")) return false;
  if (path.includes("\\")) return false;
  for (const segment of path.split("/")) {
    if (segment === "" || segment === "." || segment === "..") return false;
  }
  return true;
}

// ── context.map ──────────────────────────────────────────────────────────────

/**
 * The deterministic structural map: the whole shape of the project at the pinned
 * base OID, or a scoped slice of it. Carries the base-ref pin + fingerprint so a
 * consumer can prove which snapshot it read.
 */
export interface ProjectMap {
  readonly baseRef: string;
  readonly baseRefResolution: BaseRefResolution;
  readonly baseOid: string;
  readonly fingerprint: string;
  readonly files: readonly SnapshotFileEntry[];
  readonly scopes: readonly WorkspaceScope[];
  readonly edges: readonly DependencyEdge[];
  readonly entryPoints: readonly EntryPoint[];
  readonly tests: readonly TestEntry[];
  readonly ownership: readonly OwnershipRule[];
  readonly conventions: readonly ConventionEntry[];
}

/**
 * Narrow the map to a subtree and/or a workspace scope. Filters compose (AND):
 * with both set, only entries that satisfy both survive. An unknown `scope` name
 * resolves to nothing, so the returned map is empty — an honest "no such scope"
 * the caller can detect by the empty `scopes`.
 */
export interface ProjectMapScope {
  /** Repo-relative POSIX path prefix; only entries within this subtree are kept. */
  readonly path?: string;
  /** A workspace scope name; only that scope and the entries belonging to it are kept. */
  readonly scope?: string;
}

/** Whether `entryPath` is `prefix` itself or lies within the `prefix/` subtree. */
function underPrefix(entryPath: string, prefix: string): boolean {
  if (prefix === "") return true;
  return entryPath === prefix || entryPath.startsWith(`${prefix}/`);
}

/**
 * Answer "what is the shape of this project?" from a materialized snapshot,
 * optionally scoped. Deterministic and total: the entries are already sorted in
 * the shard, and filtering preserves that order.
 */
export function queryProjectMap(snapshot: LoadedSnapshot, scope?: ProjectMapScope): ProjectMap {
  const m = snapshot.manifest;
  const identity = {
    baseRef: m.baseRef,
    baseRefResolution: m.baseRefResolution,
    baseOid: m.baseOid,
    fingerprint: m.fingerprint,
  };

  const wantPath = scope?.path;
  const wantScope = scope?.scope;
  if (wantPath === undefined && wantScope === undefined) {
    return { ...identity, ...structuralCollections(snapshot) };
  }

  // A named scope contributes its root as an extra path prefix, and restricts
  // scopes/edges/entryPoints to that scope. An unknown name matches nothing.
  let scopeRoot: string | undefined;
  let scopeNames: ReadonlySet<string> | undefined;
  if (wantScope !== undefined) {
    const resolved = snapshot.scopes.find((s) => s.name === wantScope);
    scopeNames = new Set(resolved ? [resolved.name] : []);
    scopeRoot = resolved?.root; // undefined ⇒ no path matches ⇒ empty map
  }

  const pathOk = (p: string): boolean => {
    if (wantPath !== undefined && !underPrefix(p, wantPath)) return false;
    if (wantScope !== undefined) {
      if (scopeRoot === undefined) return false;
      if (!underPrefix(p, scopeRoot)) return false;
    }
    return true;
  };
  const scopeOk = (name: string): boolean => {
    if (scopeNames !== undefined && !scopeNames.has(name)) return false;
    return true;
  };
  // A scope survives a path filter when its root lies within the requested
  // subtree (the subtree contains the scope), matching how files are filtered.
  const scopeRootOk = (root: string): boolean => {
    if (wantPath !== undefined && !underPrefix(root, wantPath)) return false;
    return true;
  };

  const keptScopes = snapshot.scopes.filter((s) => scopeOk(s.name) && scopeRootOk(s.root));
  const keptScopeNames = new Set(keptScopes.map((s) => s.name));

  return {
    ...identity,
    files: snapshot.files.filter((f) => pathOk(f.path)),
    scopes: keptScopes,
    // An edge is kept when BOTH endpoints survived (it describes a relationship
    // that is still fully within the slice).
    edges: snapshot.edges.filter((e) => keptScopeNames.has(e.from) && keptScopeNames.has(e.to)),
    entryPoints: snapshot.entryPoints.filter((e) => keptScopeNames.has(e.scope)),
    tests: snapshot.tests.filter((t) => pathOk(t.path)),
    ownership: snapshot.ownership.filter((o) => ownershipOk(o, wantPath, scopeRoot, wantScope)),
    conventions: snapshot.conventions.filter((c) => pathOk(c.path)),
  };
}

function structuralCollections(
  snapshot: LoadedSnapshot,
): Pick<
  ProjectMap,
  "files" | "scopes" | "edges" | "entryPoints" | "tests" | "ownership" | "conventions"
> {
  return {
    files: snapshot.files,
    scopes: snapshot.scopes,
    edges: snapshot.edges,
    entryPoints: snapshot.entryPoints,
    tests: snapshot.tests,
    ownership: snapshot.ownership,
    conventions: snapshot.conventions,
  };
}

/**
 * Ownership rules are CODEOWNERS globs (`*`, `packages/a/**`), not plain paths,
 * so they cannot be prefix-filtered like a file path without changing their
 * meaning (a `*` rule applies everywhere). Under a path/scope filter we keep a
 * rule when its pattern is plausibly relevant to the subtree: a catch-all (`*`,
 * or a leading-`/`-free glob with no directory) always applies; a directory-
 * anchored pattern is kept when its literal prefix overlaps the requested prefix
 * in EITHER direction (rule within subtree, or subtree within rule).
 */
function ownershipOk(
  rule: OwnershipRule,
  wantPath: string | undefined,
  scopeRoot: string | undefined,
  wantScope: string | undefined,
): boolean {
  const prefixes: string[] = [];
  if (wantPath !== undefined) prefixes.push(wantPath);
  if (wantScope !== undefined) {
    if (scopeRoot === undefined) return false;
    prefixes.push(scopeRoot);
  }
  if (prefixes.length === 0) return true;
  const literal = ownershipLiteralPrefix(rule.pattern);
  // A catch-all rule (no directory anchor) applies to every subtree.
  if (literal === "") return true;
  return prefixes.every(
    (prefix) => literal.startsWith(prefix) || prefix.startsWith(literal) || prefix === literal,
  );
}

/** The literal directory prefix of a CODEOWNERS pattern (up to the first glob char). */
function ownershipLiteralPrefix(pattern: string): string {
  const normalized = pattern.startsWith("/") ? pattern.slice(1) : pattern;
  const glob = normalized.search(/[*?[\]{}]/);
  const head = glob === -1 ? normalized : normalized.slice(0, glob);
  const lastSlash = head.lastIndexOf("/");
  return lastSlash === -1 ? "" : head.slice(0, lastSlash);
}

// ── context.file ─────────────────────────────────────────────────────────────

/** Everything the deterministic snapshot knows about one file. */
export interface FileContext {
  readonly path: string;
  /** The git blob OID of the file's content at the base OID (content identity). */
  readonly blobOid: string;
  readonly size: number;
  /** The git file mode, e.g. "100644", "100755", "120000" (symlink). */
  readonly mode: string;
  /** True when the tree entry is a symlink (mode 120000); a content reader must refuse to follow it (deferred). */
  readonly isSymlink: boolean;
  /** The workspace scope this file belongs to (the most specific scope root that contains it), or null. */
  readonly scope: string | null;
  /** Whether the file bears extractable symbols (a symbol shard exists for its blob). */
  readonly hasSymbols: boolean;
  /** The extractor identity that produced `symbols`, or null when the file bears no symbols. */
  readonly extractor: string | null;
  /** Symbols declared in the file, recovered via `path → blobOid → symbol shard`. */
  readonly symbols: readonly SnapshotSymbol[];
  /** Test-inventory entries for this exact path (present iff the file is itself a test). */
  readonly tests: readonly TestEntry[];
}

export type FileContextResult =
  | { readonly ok: true; readonly context: FileContext }
  | { readonly ok: false; readonly reason: "invalid-path"; readonly path: string }
  | { readonly ok: false; readonly reason: "not-found"; readonly path: string }
  | {
      readonly ok: false;
      readonly reason: "shard-unavailable";
      readonly path: string;
      readonly digest: string;
    };

// ── The fail-closed snapshot gate: shared result taxonomy ────────────────────
//
// These types are the CANONICAL shape of what the composed staleness+integrity
// gate can return (the adapter `ProjectContextReader` implements the gate; the
// pure `canvasOps@2` `context.map` / `context.file` handlers consume it). They
// live here — alongside `ProjectMap` and `FileContextResult` — so the pure tool
// port can speak them without the core → adapters dependency the reader would
// otherwise force. `absent | stale | corrupt` is the whole failure space (R30 +
// integrity), and every one is a TYPED reason, never a throw or a partial read.

/** Why the fail-closed snapshot gate refused to produce a queryable snapshot. */
export type SnapshotGateFailure =
  /** No snapshot has been generated for this repo yet. */
  | { readonly reason: "absent" }
  /** A snapshot exists but was built at a different OID than the request pins to (R30). */
  | { readonly reason: "stale"; readonly storedBaseOid: string; readonly requestedBaseOid: string }
  /** The stored snapshot failed the integrity gate (missing/corrupt shard or tampered manifest). */
  | {
      readonly reason: "corrupt";
      readonly missing: readonly string[];
      readonly mismatched: readonly string[];
    };

/**
 * `context.map` gated result: the deterministic map at the requested base OID, or
 * a typed gate failure. A failure is NEVER a served map — the gate fails closed.
 */
export type ProjectMapResult =
  | { readonly ok: true; readonly map: ProjectMap }
  | { readonly ok: false; readonly failure: SnapshotGateFailure };

/**
 * `context.file` gated result: the structural file context, the file-level
 * refusals `queryFileContext` already produces (invalid-path / not-found /
 * shard-unavailable), or a whole-snapshot gate failure wrapped as
 * `snapshot-unavailable`. One result type so a single call has one shape.
 */
export type ProjectFileResult =
  | FileContextResult
  | {
      readonly ok: false;
      readonly reason: "snapshot-unavailable";
      readonly failure: SnapshotGateFailure;
    };

/**
 * Answer "what does the snapshot know about THIS file?" — the file's structural
 * entry plus the symbols for its blob, joined `path → blobOid → symbol shard`.
 *
 * Fail-closed and total in its result type:
 *  - an unsafe address (`../`, absolute, …) ⇒ `invalid-path`;
 *  - a path not in the tree at the base OID ⇒ `not-found`;
 *  - a symbol shard the manifest references but the loader cannot produce intact
 *    ⇒ `shard-unavailable` (never a silent "no symbols");
 *  - a file with no symbol shard (e.g. a `.json`/`.md`, or a symlink) ⇒ ok with
 *    `hasSymbols: false` and empty `symbols` — a legitimate, non-error answer.
 */
export function queryFileContext(snapshot: LoadedSnapshot, path: string): FileContextResult {
  if (!isSafeRepoRelativePath(path)) return { ok: false, reason: "invalid-path", path };

  const file = snapshot.files.find((f) => f.path === path);
  if (!file) return { ok: false, reason: "not-found", path };

  const digest = snapshot.symbolDigestByBlob.get(file.blobOid);
  let symbols: readonly SnapshotSymbol[] = [];
  let extractor: string | null = null;
  let hasSymbols = false;
  if (digest !== undefined) {
    const shard = loadSymbolShard(snapshot.load, digest);
    if (shard === undefined) return { ok: false, reason: "shard-unavailable", path, digest };
    symbols = shard.symbols;
    extractor = shard.extractor;
    hasSymbols = true;
  }

  return {
    ok: true,
    context: {
      path: file.path,
      blobOid: file.blobOid,
      size: file.size,
      mode: file.mode,
      isSymlink: file.mode === "120000",
      scope: mostSpecificScope(snapshot.scopes, file.path),
      hasSymbols,
      extractor,
      symbols,
      tests: snapshot.tests.filter((t) => t.path === file.path),
    },
  };
}

// ── context.overview ─────────────────────────────────────────────────────────
//
// The LEANEST context-saver (repo-map-symbolic-surface, design §5 layer b): a
// file's top-level symbol overview — declared names, kinds, and 1-based lines, NO
// bodies — served straight from the SAME per-file symbol shard `context.file`
// joins (`path → blobOid → symbol shard`). Model-free and deterministic, on
// Rennet's OWN index (no LSP, no bundled engine). It is deliberately a NARROWER
// projection than `context.file`: only the symbol list plus the blob identity +
// extractor that prove which bytes it was recovered from — no size/mode/scope/
// tests. An agent asking "what's in this file?" pulls a compact symbol index
// instead of the whole structural record, or (worse) the file's contents.

/** A file's symbol overview: its declared top-level symbols, signatures-not-bodies. */
export interface FileOverview {
  readonly path: string;
  /** The git blob OID whose symbols these are (content identity — the evidence). */
  readonly blobOid: string;
  /** The extractor identity that produced `symbols`, or null when the file bears none. */
  readonly extractor: string | null;
  /** Whether a symbol shard exists for this file's blob. */
  readonly hasSymbols: boolean;
  /** The declared top-level symbols (name, kind, 1-based line) — never bodies. */
  readonly symbols: readonly SnapshotSymbol[];
}

export type FileOverviewResult =
  | { readonly ok: true; readonly overview: FileOverview }
  | { readonly ok: false; readonly reason: "invalid-path"; readonly path: string }
  | { readonly ok: false; readonly reason: "not-found"; readonly path: string }
  | {
      readonly ok: false;
      readonly reason: "shard-unavailable";
      readonly path: string;
      readonly digest: string;
    };

/**
 * `context.overview` gated result: the file overview, the file-level refusals, or
 * a whole-snapshot gate failure wrapped as `snapshot-unavailable` — one result
 * type so a single call has one shape (mirrors {@link ProjectFileResult}).
 */
export type ProjectFileOverviewResult =
  | FileOverviewResult
  | {
      readonly ok: false;
      readonly reason: "snapshot-unavailable";
      readonly failure: SnapshotGateFailure;
    };

/**
 * Answer "what top-level symbols does THIS file declare?" — the compact symbol
 * overview, joined `path → blobOid → symbol shard`, no bodies. Same fail-closed
 * taxonomy as {@link queryFileContext}:
 *  - an unsafe address ⇒ `invalid-path`;
 *  - a path not in the tree at the base OID ⇒ `not-found`;
 *  - a referenced symbol shard the loader cannot produce intact ⇒
 *    `shard-unavailable` (never a silent "no symbols");
 *  - a file with no symbol shard (e.g. a `.json`/`.md`, or a symlink) ⇒ ok with
 *    `hasSymbols: false` and empty `symbols` — a legitimate, non-error answer.
 */
export function queryFileOverview(snapshot: LoadedSnapshot, path: string): FileOverviewResult {
  if (!isSafeRepoRelativePath(path)) return { ok: false, reason: "invalid-path", path };

  const file = snapshot.files.find((f) => f.path === path);
  if (!file) return { ok: false, reason: "not-found", path };

  const digest = snapshot.symbolDigestByBlob.get(file.blobOid);
  if (digest === undefined) {
    return {
      ok: true,
      overview: {
        path: file.path,
        blobOid: file.blobOid,
        extractor: null,
        hasSymbols: false,
        symbols: [],
      },
    };
  }

  const shard = loadSymbolShard(snapshot.load, digest);
  if (shard === undefined) return { ok: false, reason: "shard-unavailable", path, digest };

  return {
    ok: true,
    overview: {
      path: file.path,
      blobOid: file.blobOid,
      extractor: shard.extractor,
      hasSymbols: true,
      symbols: shard.symbols,
    },
  };
}

// ── context.symbol (go-to-definition over the exported-symbol index) ──────────
//
// Rennet's OWN model-free go-to-definition (repo-map-symbolic-surface, design §5
// layer b — built on the giants we already have, NOT an LSP or bundled engine).
// The snapshot's `structural-ts-v1` extractor indexes each file's top-level
// EXPORTED declarations (`{name, kind, line}` per blob). This resolves a symbol
// NAME to its definition SITE(S) by scanning that index: `name → (every exported
// declaration of that name) → path (via blobOid) + line + owning scope`. An agent
// reading a diff pulls "where is `X` defined?" without dumping a file.
//
// HONEST SCOPE, stated in the reply, never papered over: it resolves EXPORTED
// top-level symbols only — not locals, not class members, not unexported
// declarations — because that is exactly what the deterministic index contains. A
// `reexport` site is returned with `kind: "reexport"` so the agent sees it is a
// re-export, not the original declaration (the index does not chase the re-export
// target). Multiple matches (a name exported from several files) are ALL returned,
// ranked deterministically — the honest "here are the N places", never one guess.
// Model-free and deterministic; identifier-level find-references needs data this
// index does not carry (occurrences / file text) and is a deliberate follow-up.

/** One definition site of an exported symbol: where it is declared. */
export interface SymbolDefinitionSite {
  /** Repo-relative POSIX path of the file the symbol is exported from. */
  readonly path: string;
  /** The exported symbol's name (`default` for a default export, `*` for `export *`). */
  readonly name: string;
  /** The declaration kind. */
  readonly kind: SnapshotSymbol["kind"];
  /** 1-based line of the declaration within the file. */
  readonly line: number;
  /** The owning workspace scope (most specific), or null. */
  readonly scope: string | null;
}

/** A go-to-definition answer: every exported declaration matching the queried name. */
export interface SymbolDefinitions {
  /** The queried symbol name. */
  readonly name: string;
  /** Every matching definition site, ranked deterministically by (path, line). May be empty. */
  readonly sites: readonly SymbolDefinitionSite[];
}

/** A `context.symbol` lookup: a name, optionally narrowed by kind and/or workspace scope. */
export interface SymbolLookup {
  /** The exported symbol name to resolve. */
  readonly name: string;
  /** Restrict to this declaration kind, if given. */
  readonly kind?: SnapshotSymbol["kind"];
  /** Restrict to definitions inside this workspace scope, if given. */
  readonly scope?: string;
}

export type SymbolDefinitionResult =
  | { readonly ok: true; readonly definitions: SymbolDefinitions }
  | {
      readonly ok: false;
      readonly reason: "shard-unavailable";
      readonly digest: string;
    };

/**
 * `context.symbol` gated result: the definition sites, a shard-decode failure, or
 * a whole-snapshot gate failure wrapped as `snapshot-unavailable` — one result
 * type so a single call has one shape (mirrors {@link ProjectFileResult}).
 */
export type ProjectSymbolDefinitionResult =
  | SymbolDefinitionResult
  | {
      readonly ok: false;
      readonly reason: "snapshot-unavailable";
      readonly failure: SnapshotGateFailure;
    };

/**
 * Resolve an exported symbol name to its definition site(s) across the snapshot's
 * per-file symbol shards. Deterministic and fail-closed: a symbol shard the
 * manifest references but the loader cannot produce intact ⇒ `shard-unavailable`
 * (never a silent partial answer). Each blob's shard is decoded at most once even
 * when several paths share the blob; a shared blob contributes a site per path
 * (a copied/renamed definition legitimately lives at each path).
 */
export function querySymbolDefinition(
  snapshot: LoadedSnapshot,
  query: SymbolLookup,
): SymbolDefinitionResult {
  // Decode each referenced symbol shard at most once (keyed by digest), fail-closed.
  const shardByDigest = new Map<string, SymbolShard>();
  const sites: SymbolDefinitionSite[] = [];

  for (const file of snapshot.files) {
    if (
      query.scope !== undefined &&
      mostSpecificScope(snapshot.scopes, file.path) !== query.scope
    ) {
      continue;
    }
    const digest = snapshot.symbolDigestByBlob.get(file.blobOid);
    if (digest === undefined) continue;

    let shard = shardByDigest.get(digest);
    if (shard === undefined) {
      const loaded = loadSymbolShard(snapshot.load, digest);
      if (loaded === undefined) return { ok: false, reason: "shard-unavailable", digest };
      shard = loaded;
      shardByDigest.set(digest, shard);
    }

    for (const symbol of shard.symbols) {
      if (symbol.name !== query.name) continue;
      if (query.kind !== undefined && symbol.kind !== query.kind) continue;
      sites.push({
        path: file.path,
        name: symbol.name,
        kind: symbol.kind,
        line: symbol.line,
        scope: mostSpecificScope(snapshot.scopes, file.path),
      });
    }
  }

  // Deterministic rank: by path, then by line (stable across identical snapshots).
  sites.sort((a, b) => (a.path === b.path ? a.line - b.line : a.path < b.path ? -1 : 1));
  return { ok: true, definitions: { name: query.name, sites } };
}

// ── context.references (find-references over the identifier-occurrence index) ──
//
// Rennet's OWN model-free find-references (#200 — the third symbolic op, completing
// `context.overview` + `context.symbol`). The snapshot's `structural-refs-v1`
// extractor records each blob's identifier occurrences (`name → lines`); this
// resolves a NAME to every occurrence SITE across the tree: `name → (every blob
// whose reference shard lists it) → path (via blobOid) + line + owning scope`. An
// agent reading a diff asks "where is `X` used?" (blast radius) without dumping a
// file. Deterministic and fail-closed, on the same shard model `context.symbol` uses.
//
// HONEST SCOPE, stated in the reply, never papered over: matching is NAME-BASED and
// TEXTUAL (the extractor is regex, not a parse), so two DISTINCT symbols that share
// a name are indistinguishable, and a mention in a line comment or a string literal
// is a real occurrence (block comments ARE skipped). It returns EVERY occurrence,
// including the declaration site — the honest "here are the N places the token
// appears", never a semantic guarantee. Optionally narrowed by workspace `scope`
// and/or a repo-relative `path` subtree.

/** One occurrence site of an identifier: where the token appears. */
export interface ReferenceSite {
  /** Repo-relative POSIX path of the file the occurrence is in. */
  readonly path: string;
  /** 1-based line of the occurrence within the file. */
  readonly line: number;
  /** The owning workspace scope (most specific), or null. */
  readonly scope: string | null;
}

/** A find-references answer: every occurrence site matching the queried name. */
export interface SymbolReferences {
  /** The queried identifier name. */
  readonly name: string;
  /** Every matching occurrence site, ranked deterministically by (path, line). May be empty. */
  readonly sites: readonly ReferenceSite[];
}

/** A `context.references` lookup: a name, optionally narrowed by workspace scope and/or path subtree. */
export interface ReferenceLookup {
  /** The identifier name to find occurrences of. */
  readonly name: string;
  /** Restrict to occurrences inside this workspace scope, if given. */
  readonly scope?: string;
  /** Restrict to occurrences under this repo-relative POSIX subtree prefix, if given. */
  readonly path?: string;
}

export type ReferenceResult =
  | { readonly ok: true; readonly references: SymbolReferences }
  | {
      readonly ok: false;
      readonly reason: "shard-unavailable";
      readonly digest: string;
    };

/**
 * `context.references` gated result: the occurrence sites, a shard-decode failure,
 * or a whole-snapshot gate failure wrapped as `snapshot-unavailable` — one result
 * type so a single call has one shape (mirrors {@link ProjectSymbolDefinitionResult}).
 */
export type ProjectReferenceResult =
  | ReferenceResult
  | {
      readonly ok: false;
      readonly reason: "snapshot-unavailable";
      readonly failure: SnapshotGateFailure;
    };

/**
 * Resolve an identifier name to its occurrence site(s) across the snapshot's
 * per-file reference shards. Deterministic and fail-closed: a reference shard the
 * manifest references but the loader cannot produce intact ⇒ `shard-unavailable`
 * (never a silent partial answer). Each blob's shard is decoded at most once even
 * when several paths share the blob; a shared blob contributes a site per path per
 * occurrence line. Optionally narrowed by workspace `scope` and/or a `path` subtree.
 */
export function queryReferences(snapshot: LoadedSnapshot, query: ReferenceLookup): ReferenceResult {
  const shardByDigest = new Map<string, ReferenceShard>();
  const sites: ReferenceSite[] = [];

  for (const file of snapshot.files) {
    if (query.path !== undefined && !underPrefix(file.path, query.path)) continue;
    const scope = mostSpecificScope(snapshot.scopes, file.path);
    if (query.scope !== undefined && scope !== query.scope) continue;

    const digest = snapshot.referenceDigestByBlob.get(file.blobOid);
    if (digest === undefined) continue;

    let shard = shardByDigest.get(digest);
    if (shard === undefined) {
      const loaded = loadReferenceShard(snapshot.load, digest);
      if (loaded === undefined) return { ok: false, reason: "shard-unavailable", digest };
      shard = loaded;
      shardByDigest.set(digest, shard);
    }

    const occurrence = shard.references.find((r) => r.name === query.name);
    if (occurrence === undefined) continue;
    for (const line of occurrence.lines) sites.push({ path: file.path, line, scope });
  }

  sites.sort((a, b) => (a.path === b.path ? a.line - b.line : a.path < b.path ? -1 : 1));
  return { ok: true, references: { name: query.name, sites } };
}

/**
 * Build the blast-radius {@link FanInIndex} (#200 → #35 follow-on) over a materialized
 * snapshot: `definedSymbols(path)` reads the file's symbol overview, `referencingFiles(name)`
 * reads the reference index and returns the DISTINCT files an identifier occurs in. Pure
 * over the snapshot (the composition resolves + materializes it, and only supplies the index
 * when the reference index is populated, so an empty index is a NOT-ASSESSED chip upstream,
 * never a silent zero). A shard-decode failure degrades to empty for that lookup — a
 * conservative under-count, never a crash.
 */
export function fanInIndexFromSnapshot(snapshot: LoadedSnapshot): FanInIndex {
  return {
    definedSymbols(path: string): readonly string[] {
      const result = queryFileOverview(snapshot, path);
      return result.ok ? result.overview.symbols.map((symbol) => symbol.name) : [];
    },
    referencingFiles(name: string): readonly string[] {
      const result = queryReferences(snapshot, { name });
      if (!result.ok) return [];
      const paths = new Set<string>();
      for (const site of result.references.sites) paths.add(site.path);
      return [...paths];
    },
  };
}

/** The name of the most specific (longest-root) scope that contains `path`, or null. */
function mostSpecificScope(scopes: readonly WorkspaceScope[], path: string): string | null {
  let best: WorkspaceScope | undefined;
  for (const scope of scopes) {
    if (!underPrefix(path, scope.root)) continue;
    if (best === undefined || scope.root.length > best.root.length) best = scope;
  }
  return best?.name ?? null;
}
