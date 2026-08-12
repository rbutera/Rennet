/**
 * The deterministic novelty ledger (issue #144, Stage 1) — the MODEL-FREE half of
 * net-novel detection. Given a base-branch {@link LoadedSnapshot} and a captured
 * {@link Patchset}, {@link classifyNovelty} classifies each changed unit
 * `novel` / `extends` / `conforms` against the baseline the snapshot records, and
 * attaches the concrete baseline evidence each verdict cites.
 *
 * Load-bearing property: same `(snapshot, patchset)` in ⇒ same ledger out. There
 * is no clock, no randomness, no IO and no model anywhere in this module — every
 * byte of the result is a pure function of the snapshot's structural shards and
 * the diff. The base symbols come through the same fail-closed `queryFileContext`
 * join the read layer uses; the introduced symbols come from re-running the
 * snapshot's OWN deterministic extractor (`structuralTsExtractor`) over the diff's
 * added lines, so the two symbol sets share one vocabulary by construction.
 *
 * Scope is deliberately narrow — two unit kinds, `file` and `symbol` — because
 * those are the two the base snapshot can adjudicate WITHOUT head-side manifest /
 * lockfile / submodule content. The remaining unit kinds the direction enumerates
 * (dependency edges, external deps + versions, entry points, ownership crossings,
 * submodule advances) are a documented later wave, not a fuzzy guess here.
 *
 * The extends/conforms/novel boundary (the one #144 asks to define crisply):
 *  - `extends` and `conforms` ALWAYS cite a concrete existing baseline entity.
 *  - `extends`  ← the SAME entity exists at base (same file path, or same-named
 *    exported symbol in an existing file). The change builds on a specific thing.
 *  - `conforms` ← a NEW file that is another structural instance of a testing
 *    convention the snapshot already records (≥1 existing test shares the glob).
 *    This is the single deterministic "instance of an existing pattern" case; all
 *    broader structural conformance is left to the deferred Stage-2 LLM.
 *  - `novel`    ← everything else new, INCLUDING any change whose expected base
 *    entity is absent from the snapshot (with no baseline entity to cite, the
 *    honest verdict is novelty).
 */

import type {
  FileChangeStatus,
  LedgerEntry,
  NoveltyEvidence,
  NoveltyFileContext,
  NoveltyLedger,
  NoveltyMatch,
  PatchFile,
  Patchset,
  SnapshotSymbol,
  StructuralShardSlot,
  TestEntry,
  WorkspaceScope,
} from "@rennet/types";
import { DIFF_TRUNCATION_MARKER } from "@rennet/types";
import type { LoadedSnapshot, SnapshotGateFailure } from "./project-context";
import { queryFileContext } from "./project-context";
import { structuralTsExtractor } from "./project-snapshot";

/**
 * `context.novelty` gated result (issue #144): the deterministic novelty ledger
 * for the review's change against the base snapshot, or a typed gate failure. A
 * failure is NEVER a served ledger — the snapshot gate fails closed, so the ledger
 * can never be computed against a mismatched (stale/absent/corrupt) baseline.
 *
 * CANONICAL here — alongside `classifyNovelty` and the gate-failure taxonomy — so
 * the pure `canvasOps@2` `context.novelty` handler (the backend port lives in
 * core) can speak it without a core → adapters edge, exactly as `ProjectMapResult`
 * does for `context.map`. The adapter `NoveltyLedgerReader` produces this shape and
 * re-exports it as `NoveltyLedgerResult` for stability.
 */
export type NoveltyResult =
  | { readonly ok: true; readonly ledger: NoveltyLedger }
  | { readonly ok: false; readonly failure: SnapshotGateFailure };

// ── Diff parsing (pure, added-lines only) ─────────────────────────────────────

/**
 * The added source lines of a unified-diff patch: every line beginning with a
 * single `+` (the file header `+++` is excluded), with the leading `+` stripped.
 * Deterministic and order-preserving. Hunk headers, context and deletions are
 * dropped — introduced symbols live only on added lines.
 */
export function parseAddedLines(patch: string): string[] {
  const added: string[] = [];
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++")) continue;
    if (line.startsWith("+")) added.push(line.slice(1));
  }
  return added;
}

/** Whether a patch was truncated past the byte cap (symbol coverage is partial). */
export function patchIsTruncated(patch: string): boolean {
  return patch.includes(DIFF_TRUNCATION_MARKER);
}

/**
 * The exported symbols a diff INTRODUCES in a file, recovered by re-running the
 * snapshot's own deterministic extractor over the added-line text. De-duplicated
 * by name (first occurrence wins), in first-seen order. Same extractor as the
 * baseline ⇒ one symbol vocabulary, so a name that appears both here and in the
 * baseline is genuinely the same declared export.
 */
export function introducedExports(path: string, addedLines: readonly string[]): SnapshotSymbol[] {
  const symbols = structuralTsExtractor(path, addedLines.join("\n"));
  const seen = new Set<string>();
  const unique: SnapshotSymbol[] = [];
  for (const symbol of symbols) {
    if (seen.has(symbol.name)) continue;
    seen.add(symbol.name);
    unique.push(symbol);
  }
  return unique;
}

// ── Test-convention detection (the deterministic `conforms` case) ─────────────
//
// Mirrors the adapter's `matchesTestGlob` (project-snapshot-source.ts) so an added
// file "is a test" by the SAME rule the snapshot used to populate its `tests`
// shard. The result is only ever acted on when the snapshot already records ≥1
// test under the same glob, so the verdict is anchored to real baseline evidence
// even if this classifier and the adapter ever drift.

/** The closed set of test-convention globs the snapshot records (mirror of the adapter). */
export function classifyTestGlob(path: string): string | null {
  const base = path.slice(path.lastIndexOf("/") + 1);
  if (/\.(test|spec)\.\w+$/.test(base)) {
    return /\.spec\./.test(base) ? "**/*.spec.*" : "**/*.test.*";
  }
  if (/(^|\/)(test|tests|__tests__)\//.test(path)) {
    return path.includes("/__tests__/")
      ? "**/__tests__/**"
      : path.includes("/tests/")
        ? "**/tests/**"
        : "**/test/**";
  }
  return null;
}

// ── Scope resolution (independent of file presence) ───────────────────────────

/** The name of the most specific (longest-root) scope that contains `path`, or null. */
export function scopeForPath(scopes: readonly WorkspaceScope[], path: string): string | null {
  let best: WorkspaceScope | undefined;
  for (const scope of scopes) {
    const within = path === scope.root || path.startsWith(`${scope.root}/`);
    if (!within) continue;
    if (best === undefined || scope.root.length > best.root.length) best = scope;
  }
  return best?.name ?? null;
}

// ── Base-file lookup (fail-closed via the read layer's join) ───────────────────

interface BaseFile {
  readonly blobOid: string;
  readonly symbolNames: ReadonlyMap<string, SnapshotSymbol>;
}

/**
 * Look up a base path in the snapshot: its blob OID and its exported symbols,
 * indexed by name. Returns `null` when the path is absent from the baseline (or,
 * defensively, when its symbol shard would not decode — impossible after the
 * loadFresh integrity gate, treated as "no base symbols" rather than a throw).
 */
function baseFileFor(snapshot: LoadedSnapshot, path: string): BaseFile | null {
  const result = queryFileContext(snapshot, path);
  if (!result.ok) return null; // not-found / invalid-path / shard-unavailable
  const symbolNames = new Map<string, SnapshotSymbol>();
  for (const symbol of result.context.symbols) {
    if (!symbolNames.has(symbol.name)) symbolNames.set(symbol.name, symbol);
  }
  return { blobOid: result.context.blobOid, symbolNames };
}

// ── The classifier ────────────────────────────────────────────────────────────

/** The base path a change's baseline entity lives at (previous path for a rename). */
function basePathOf(file: PatchFile): string {
  return file.status === "renamed" && file.previousPath ? file.previousPath : file.path;
}

function fileContext(
  snapshot: LoadedSnapshot,
  file: PatchFile,
  knownTestPaths: ReadonlySet<string>,
  conventionPaths: ReadonlySet<string>,
): NoveltyFileContext {
  const basePath = basePathOf(file);
  return {
    scope: scopeForPath(snapshot.scopes, file.path),
    isKnownTest: knownTestPaths.has(basePath),
    isConvention: conventionPaths.has(basePath),
    patchTruncated: patchIsTruncated(file.patch),
  };
}

function evidence(
  snapshot: LoadedSnapshot,
  shard: StructuralShardSlot | "symbols" | null,
  match: NoveltyMatch,
  context: NoveltyFileContext,
): NoveltyEvidence {
  return {
    snapshotFingerprint: snapshot.manifest.fingerprint,
    baseOid: snapshot.manifest.baseOid,
    shard,
    match,
    context,
  };
}

/**
 * Classify one changed file into its `file` unit, plus a helper decision the
 * symbol pass reuses: the base file (present ⇒ extends/conforms cite it; absent ⇒
 * the change is novel because there is no baseline entity to cite).
 */
function classifyFile(
  snapshot: LoadedSnapshot,
  file: PatchFile,
  testGlobCounts: ReadonlyMap<string, number>,
  context: NoveltyFileContext,
): { entry: LedgerEntry; base: BaseFile | null } {
  const unit = {
    kind: "file" as const,
    path: file.path,
    fileStatus: file.status,
    ...(file.previousPath ? { previousPath: file.previousPath } : {}),
  };

  const base = baseFileFor(snapshot, basePathOf(file));

  // Added file: conforms to an established test convention, else novel.
  if (file.status === "added") {
    const glob = classifyTestGlob(file.path);
    const siblingTestCount = glob ? (testGlobCounts.get(glob) ?? 0) : 0;
    if (glob && siblingTestCount > 0) {
      const match: NoveltyMatch = {
        kind: "test-convention",
        path: file.path,
        matchedBy: glob,
        siblingTestCount,
      };
      return {
        entry: {
          unit,
          classification: "conforms",
          evidence: evidence(snapshot, "tests", match, context),
        },
        base,
      };
    }
    return {
      entry: {
        unit,
        classification: "novel",
        evidence: evidence(snapshot, null, { kind: "file-absent", path: file.path }, context),
      },
      base,
    };
  }

  // Modified / renamed / deleted: extends iff the baseline entity exists to cite.
  if (base) {
    const match = fileMatchFor(file, base.blobOid);
    return {
      entry: {
        unit,
        classification: "extends",
        evidence: evidence(snapshot, "files", match, context),
      },
      base,
    };
  }

  // No baseline entity to cite ⇒ novel (honest fallback; documented precedence).
  return {
    entry: {
      unit,
      classification: "novel",
      evidence: evidence(snapshot, null, { kind: "file-absent", path: file.path }, context),
    },
    base,
  };
}

function fileMatchFor(file: PatchFile, blobOid: string): NoveltyMatch {
  if (file.status === "renamed" && file.previousPath) {
    return { kind: "file-renamed", from: file.previousPath, to: file.path, fromBlobOid: blobOid };
  }
  if (file.status === "deleted") return { kind: "file-removed", path: file.path, blobOid };
  return { kind: "file-present", path: file.path, blobOid };
}

/** The `symbol` units a file contributes: each introduced export, extends-or-novel. */
function classifySymbols(
  snapshot: LoadedSnapshot,
  file: PatchFile,
  base: BaseFile | null,
  context: NoveltyFileContext,
): LedgerEntry[] {
  if (file.status === "deleted") return []; // no added lines
  const introduced = introducedExports(file.path, parseAddedLines(file.patch));
  const entries: LedgerEntry[] = [];
  for (const symbol of introduced) {
    const unit = {
      kind: "symbol" as const,
      path: file.path,
      fileStatus: file.status,
      ...(file.previousPath ? { previousPath: file.previousPath } : {}),
      symbol: symbol.name,
    };
    const prior = base?.symbolNames.get(symbol.name);
    if (prior && base) {
      const match: NoveltyMatch = {
        kind: "symbol-present",
        path: file.path,
        symbol: prior,
        blobOid: base.blobOid,
      };
      entries.push({
        unit,
        classification: "extends",
        evidence: evidence(snapshot, "symbols", match, context),
      });
    } else {
      entries.push({
        unit,
        classification: "novel",
        evidence: evidence(
          snapshot,
          null,
          { kind: "symbol-absent", path: file.path, symbol: symbol.name },
          context,
        ),
      });
    }
  }
  return entries;
}

const KIND_RANK: Record<"file" | "symbol" | "gitlink", number> = {
  file: 0,
  symbol: 1,
  gitlink: 2,
};
const STATUS_RANK: Record<FileChangeStatus, number> = {
  added: 0,
  modified: 1,
  renamed: 2,
  deleted: 3,
};

/** A total, content-derived order so the ledger is byte-stable across runs. */
function compareEntries(a: LedgerEntry, b: LedgerEntry): number {
  if (a.unit.path !== b.unit.path) return a.unit.path < b.unit.path ? -1 : 1;
  if (a.unit.kind !== b.unit.kind) return KIND_RANK[a.unit.kind] - KIND_RANK[b.unit.kind];
  const sa = a.unit.symbol ?? "";
  const sb = b.unit.symbol ?? "";
  if (sa !== sb) return sa < sb ? -1 : 1;
  if (a.unit.fileStatus !== b.unit.fileStatus) {
    return STATUS_RANK[a.unit.fileStatus] - STATUS_RANK[b.unit.fileStatus];
  }
  return 0;
}

/**
 * Classify every changed unit in `patchset` against `snapshot`. Pure and total:
 * the caller (the adapter reader) is responsible for having paired a FRESH,
 * integrity-verified snapshot with the patchset it was computed against — this
 * function assumes that pairing and never does IO. Determinism is guaranteed by
 * the total {@link compareEntries} order over the emitted entries.
 */
export function classifyNovelty(
  snapshot: LoadedSnapshot,
  patchset: Patchset,
  projectSnapshotId = snapshot.manifest.fingerprint,
): NoveltyLedger {
  const knownTestPaths = new Set<string>(snapshot.tests.map((t: TestEntry) => t.path));
  const conventionPaths = new Set<string>(snapshot.conventions.map((c) => c.path));

  // How many baseline tests share each convention glob — the "established
  // convention" count that gates a `conforms` verdict.
  const testGlobCounts = new Map<string, number>();
  for (const test of snapshot.tests) {
    testGlobCounts.set(test.matchedBy, (testGlobCounts.get(test.matchedBy) ?? 0) + 1);
  }

  const entries: LedgerEntry[] = [];
  for (const file of patchset.files) {
    const context = fileContext(snapshot, file, knownTestPaths, conventionPaths);
    const { entry, base } = classifyFile(snapshot, file, testGlobCounts, context);
    entries.push(entry);
    entries.push(...classifySymbols(snapshot, file, base, context));
  }

  entries.sort(compareEntries);

  return {
    projectSnapshotId,
    snapshotFingerprint: snapshot.manifest.fingerprint,
    baseOid: snapshot.manifest.baseOid,
    patchsetId: patchset.id,
    entries,
  };
}
