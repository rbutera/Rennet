import type { SnapshotSymbol } from "@rennet/protocol";
import { sha256Hex } from "@rennet/protocol";
import { UndirectedGraph } from "graphology";
import louvain from "graphology-communities-louvain";
import { classifyInventory } from "../file-classification";
import {
  type ImportGraph,
  type LoadedSnapshot,
  queryImportGraph,
  querySymbolIndex,
} from "../project-context";
import type { KnowledgeSnapshotContext } from "./mint";

/**
 * Partitioning is invisible plumbing (#460): slices exist only for the duration
 * of a swarm run — no partition-shaped artifact survives it. What changed in the
 * context-map rebuild (W2) is what a slice is SHAPED BY.
 *
 * There are two tiers, and which one a file lands in is decided by evidence, not
 * by preference:
 *
 *  1. **Module batches** ({@link buildModuleBatches}) — Louvain communities over
 *     the repo-wide import graph, targeting ~25–35 files. A batch is a module in
 *     the sense that matters to a reader: the files that talk to each other. Each
 *     batch also carries a {@link MemberNeighbors} map so the edges the batching
 *     cut are still visible to the worker that reads it.
 *  2. **The directory fallback** ({@link buildPartitions}) — the original
 *     scope/subtree hierarchy, for files with NO import edges (documentation,
 *     config, assets, an unreferenced leaf) and for the whole tree when the import
 *     index is unavailable. Honest degradation: a worse partitioning, not a crash.
 *
 * Mapping-INELIGIBLE files (vendored, generated, lockfiles, binaries — see
 * `../file-classification`) are batched by neither. They stay in the inventory, so
 * the map remains truthful about what the tree holds; they simply do not consume a
 * worker's turn.
 *
 * Every ELIGIBLE file lands in EXACTLY one slice, by construction: the two tiers
 * partition the eligible set on a single predicate (has a resolved import edge to
 * another eligible file), and each tier partitions its own half.
 *
 * Pure and deterministic throughout: same snapshot → same slices, same order,
 * same ids. Louvain is run with its randomisation disabled; see
 * {@link LOUVAIN_OPTIONS}.
 */

/** Target per-worker slice size for the DIRECTORY FALLBACK (#460: "~120-file per-worker cap"). */
export const DEFAULT_PARTITION_CAP = 120;

/** The size a module batch aims for — the plan's ~25–35 window, expressed as its centre. */
export const DEFAULT_BATCH_TARGET = 30;

/** The size above which a community is split. A batch may legitimately sit anywhere up to this. */
export const MAX_BATCH_SIZE = 35;

/** Below this, a community is too small to be worth a turn and is pooled with its neighbours in scope. */
export const MIN_BATCH_SIZE = 3;

/** The cap on a pooled misc batch. Lower than {@link MAX_BATCH_SIZE}: pooled files are less coherent. */
export const POOLED_BATCH_CAP = 25;

/**
 * The cap a COALESCED fallback slice aims for ({@link coalesceFallbackSlices}).
 *
 * The first measured coalesce used 25. On Rennet's later 111-slice proof snapshot,
 * 75 is the smallest legible cap that removes a whole 16-lane wave: 54 fallback
 * slices become 39 and 111 total turns become 96, with exact file coverage. Caps
 * 90 and 120 remain six waves while joining more unrelated routing families and
 * reducing the aggregate worker-hypothesis ceiling, so they buy no useful latency.
 *
 * This stays distinct from both {@link POOLED_BATCH_CAP} and
 * {@link DEFAULT_PARTITION_CAP}. A fallback batch is less coherent than an import
 * community, while the 120-file degradation path covers a different population
 * when no import graph can be read.
 */
export const FALLBACK_COALESCE_CAP = 75;

/** The most cross-batch neighbours recorded for one file. */
export const NEIGHBOR_CAP = 50;

/** One file in a slice. */
export interface FileEntry {
  readonly path: string;
  readonly blobOid: string;
  /**
   * The file's declared top-level symbols — the SKELETON a mapping worker reads
   * before it reads any source (W3, Stage 2). Present and EMPTY for a file the
   * symbol extractor indexed and found nothing in (a `.md`, a `.json`); ABSENT
   * when no symbol shard covers the blob, or when the slice was not built from a
   * snapshot at all (routing-only partitions, test fixtures).
   *
   * The distinction is the packet's honesty: "indexed, declares nothing" and "not
   * indexed" are different facts about a file, and a worker told the second one
   * knows to go and read.
   */
  readonly symbols?: readonly SnapshotSymbol[];
}

/** One resolved import edge BETWEEN two members of the same slice. */
export interface SliceImport {
  readonly from: string;
  readonly to: string;
}

/** One cross-batch import neighbour of a batch member. */
export interface BatchNeighbor {
  /** The neighbour's repo-relative path. It is never a member of this batch. */
  readonly path: string;
  /** Which way the edge runs, from the MEMBER's point of view. */
  readonly direction: "imports" | "imported-by" | "both";
  /** The neighbour's exported symbol names, distinct and sorted. Empty when it exports nothing indexed. */
  readonly symbols: readonly string[];
}

/** One batch member's 1-hop neighbourhood OUTSIDE the batch. */
export interface MemberNeighbors {
  readonly path: string;
  /** The kept neighbours, sorted by path. */
  readonly neighbors: readonly BatchNeighbor[];
  /**
   * How many 1-hop neighbours the {@link NEIGHBOR_CAP} dropped. `0` when the list
   * is complete. Recorded rather than silent: a hub file's neighbourhood is
   * genuinely bigger than what is shown, and a worker that is told so can go and
   * read the rest.
   */
  readonly truncated: number;
}

/** One worker's slice of the inventory. */
export interface PartitionSlice {
  /**
   * Deterministic id.
   *
   * A MODULE BATCH is `mod:<lexically-first member path>#<hash8>`, where the hash
   * is the first 8 hex of sha256 over the batch's sorted member paths joined by
   * newlines. Neither half comes from Louvain's community NUMBERING, which is an
   * artifact of iteration order and carries no meaning across builds: the id is a
   * pure function of the batch's CONTENT. So a rebuild with no changes reproduces
   * every id exactly, and any change to a batch's membership — a file added,
   * removed, or moved to another batch — changes that batch's hash while leaving
   * every untouched batch's id alone. The path half is the routing FAMILY (see
   * {@link partitionIdFamily}): it stays stable across membership churn that does
   * not disturb the lexically-first member, so a delta can still recognise a batch
   * as "the same neighbourhood, re-formed".
   *
   * A DIRECTORY-FALLBACK slice keeps the original hierarchical id: the scope name,
   * `<id>/<dir>` per subtree split, `<id>/.` for direct files; `dir:<top-level>` /
   * `dir:.` for the no-scope fallback. A fallback slice that {@link
   * coalesceFallbackSlices} MERGED carries the first constituent's hierarchical id
   * plus its own `#<hash8>` over the merged membership — the hierarchical half stays
   * the family, so `familiesMatch`'s prefix rule reaches it exactly as before, and
   * the hash half makes the id a pure function of what the slice now holds. An
   * unmerged fallback slice carries no `#` and is its own family.
   */
  readonly id: string;
  /**
   * EVERY routing family this slice answers to, when that is more than the one its
   * {@link id} carries. Present only on a slice {@link coalesceFallbackSlices}
   * MERGED; absent everywhere else, where {@link partitionIdFamily} of the id is
   * the whole answer. Read it through {@link sliceFamilies}, never directly.
   *
   * A merge takes several constituents and keeps ONE of their ids, so the other
   * constituents' families would otherwise vanish — and with them the only route a
   * delta has for a path deleted under one of those directories. `dir:docs/b` is
   * not a prefix of `dir:docs/a`, so `familiesMatch` would find nothing and the
   * merged slice, which is where those files actually live now, would not re-run.
   */
  readonly families?: readonly string[];
  readonly files: readonly FileEntry[];
  /**
   * Cross-batch neighbours, one entry per member that HAS any — a member with no
   * neighbour outside its batch is simply absent, which is the honest encoding of
   * "nothing was cut here".
   *
   * Always empty for a directory-fallback slice, and the two ways a slice gets there
   * do NOT mean the same thing:
   *  - in the two-tier path, the fallback holds exactly the files with no resolved
   *     import edge, so an empty list is the truth about those files;
   *  - on the DEGRADATION path ({@link partitionsFromSnapshot} with an unreadable
   *    import or symbol shard), the whole eligible inventory goes through
   *    {@link buildPartitions}, so an empty list means the graph could not be read —
   *    not that the file is edge-less.
   *
   * {@link imports} is the machine-readable answer to which case it is.
   */
  readonly neighbors: readonly MemberNeighbors[];
  /**
   * The resolved import edges joining two MEMBERS of this slice, sorted by
   * `(from, to)`. Together with {@link neighbors} (the edges batching cut) this is
   * the whole of what the import graph says about the slice.
   *
   * PRESENT AND EMPTY means the graph was read and joins nothing here — the truth
   * about a fallback slice of documentation. ABSENT means the graph could not be
   * read at all, which is the degradation path, and a worker packet built from an
   * absent list says so rather than claiming the files are unconnected.
   */
  readonly imports?: readonly SliceImport[];
}

function byString(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The routing FAMILY of a partition id: the part that survives a membership
 * change. `mod:packages/core/src/a.ts#1a2b3c4d` → `mod:packages/core/src/a.ts`;
 * a hierarchical fallback id is its own family.
 *
 * `routeDelta` uses this to recognise the current slice that succeeded a prior one
 * when a deleted path has to be routed through its old owner. Without it, every
 * module batch would look like a brand-new slice on every membership change,
 * because the content hash is (deliberately) volatile.
 */
export function partitionIdFamily(id: string): string {
  const hash = id.lastIndexOf("#");
  return hash < 0 ? id : id.slice(0, hash);
}

/**
 * Every routing family a slice answers to: its {@link PartitionSlice.families} when
 * a coalesce recorded several, otherwise the single family its id carries.
 *
 * The one accessor, so no caller re-derives "the family" from the id alone and
 * silently loses a merged slice's other constituents.
 */
export function sliceFamilies(slice: PartitionSlice): readonly string[] {
  return slice.families ?? [partitionIdFamily(slice.id)];
}

/** The id for a module batch: content-derived, never Louvain's community number. */
function moduleBatchId(sortedPaths: readonly string[]): string {
  const first = sortedPaths[0] ?? "";
  return `mod:${first}#${sha256Hex(sortedPaths.join("\n")).slice(0, 8)}`;
}

// ── The directory fallback (the original #460 partitioner) ───────────────────

function underPrefix(path: string, prefix: string): boolean {
  if (prefix === "") return true;
  return path === prefix || path.startsWith(`${prefix}/`);
}

/** Subtree-split one group by directory prefix walk until each piece is under the cap. */
function splitGroup(
  id: string,
  prefix: string,
  files: readonly FileEntry[],
  cap: number,
  out: PartitionSlice[],
): void {
  if (files.length <= cap) {
    out.push({ id, files, neighbors: [] });
    return;
  }
  const direct: FileEntry[] = [];
  const byDir = new Map<string, FileEntry[]>();
  for (const file of files) {
    const rest = prefix === "" ? file.path : file.path.slice(prefix.length + 1);
    const slash = rest.indexOf("/");
    if (slash < 0) {
      direct.push(file);
    } else {
      const dir = rest.slice(0, slash);
      const group = byDir.get(dir);
      if (group === undefined) byDir.set(dir, [file]);
      else group.push(file);
    }
  }
  if (byDir.size === 0) {
    // A flat directory over the cap cannot split further; it stays oversized.
    out.push({ id, files, neighbors: [] });
    return;
  }
  if (direct.length > 0) out.push({ id: `${id}/.`, files: direct, neighbors: [] });
  for (const dir of [...byDir.keys()].sort()) {
    const group = byDir.get(dir) as FileEntry[];
    const childPrefix = prefix === "" ? dir : `${prefix}/${dir}`;
    splitGroup(`${id}/${dir}`, childPrefix, group, cap, out);
  }
}

/**
 * The DIRECTORY FALLBACK tier: partition an inventory by workspace scope and
 * directory subtree. Every file lands in exactly one slice, by construction:
 *
 * - one slice per workspace scope, a file belonging to the DEEPEST scope root
 *   that prefixes it (nested scopes never double-claim);
 * - a scope over the cap subtree-splits by directory prefix walk until under it
 *   (a flat directory that cannot split further stays oversized — the cap is a
 *   target, not a hard bound);
 * - files outside every scope (or a snapshot with no scopes at all) fall back
 *   to top-level-directory slices, cap-split the same way.
 *
 * This was the whole partitioner before W2 and is now the tier for files the
 * import graph cannot speak about — plus the whole tree when the import index is
 * unavailable, which is the degradation path {@link partitionsFromSnapshot} takes
 * instead of failing.
 */
export function buildPartitions(
  snapshot: Pick<KnowledgeSnapshotContext, "files" | "scopes">,
  cap: number = DEFAULT_PARTITION_CAP,
): readonly PartitionSlice[] {
  // Deepest-root-first, so the first prefix match IS the most specific scope.
  const scopes = [...snapshot.scopes].sort(
    (a, b) => b.root.length - a.root.length || byString(a.root, b.root),
  );
  // Ownership is keyed by ROOT (the identity prefix matching actually uses);
  // two scopes sharing a name stay distinct, and a duplicated root collapses to
  // one group instead of emitting its files twice. Slice ids stay the scope
  // name where unique, `name:root` where names collide.
  const scopeByRoot = new Map<string, { name: string; root: string }>();
  for (const scope of scopes) if (!scopeByRoot.has(scope.root)) scopeByRoot.set(scope.root, scope);
  const nameCount = new Map<string, number>();
  for (const scope of scopeByRoot.values())
    nameCount.set(scope.name, (nameCount.get(scope.name) ?? 0) + 1);
  const sliceId = (scope: { name: string; root: string }): string =>
    nameCount.get(scope.name) === 1 ? scope.name : `${scope.name}:${scope.root}`;

  const byRoot = new Map<string, FileEntry[]>();
  const unscoped: FileEntry[] = [];
  const sortedFiles = [...snapshot.files].sort((a, b) => byString(a.path, b.path));
  for (const file of sortedFiles) {
    const owner = scopes.find((scope) => underPrefix(file.path, scope.root));
    if (owner === undefined) {
      unscoped.push(file);
      continue;
    }
    const group = byRoot.get(owner.root);
    if (group === undefined) byRoot.set(owner.root, [file]);
    else group.push(file);
  }

  const out: PartitionSlice[] = [];
  for (const scope of [...scopeByRoot.values()].sort((a, b) => byString(sliceId(a), sliceId(b)))) {
    const group = byRoot.get(scope.root);
    if (group === undefined || group.length === 0) continue;
    splitGroup(sliceId(scope), scope.root, group, cap, out);
  }
  if (unscoped.length > 0) {
    const byTop = new Map<string, FileEntry[]>();
    const rootFiles: FileEntry[] = [];
    for (const file of unscoped) {
      const slash = file.path.indexOf("/");
      if (slash < 0) {
        rootFiles.push(file);
        continue;
      }
      const top = file.path.slice(0, slash);
      const group = byTop.get(top);
      if (group === undefined) byTop.set(top, [file]);
      else group.push(file);
    }
    if (rootFiles.length > 0) out.push({ id: "dir:.", files: rootFiles, neighbors: [] });
    for (const top of [...byTop.keys()].sort()) {
      splitGroup(`dir:${top}`, top, byTop.get(top) as FileEntry[], cap, out);
    }
  }
  return out;
}

// ── Coalescing the fallback tail ─────────────────────────────────────────────

/**
 * The bucket a fallback slice coalesces WITHIN: its workspace scope root where a
 * scope owns it, otherwise its top-level directory (`top:` with an empty tail for a
 * file that lives at the repo root).
 *
 * Root, not name — the same identity prefix {@link buildPartitions} and
 * {@link poolTiny} key on, so two packages sharing a `name` never merge. Deriving
 * it from the slice's first FILE rather than from its id is what keeps this
 * independent of the id scheme: `buildPartitions` names a scope slice after the
 * scope and an unscoped one `dir:<top>`, and both answer here from the path.
 */
function coalesceGroupKey(
  scopes: readonly { readonly name: string; readonly root: string }[],
  path: string,
): string {
  const root = scopeRootOf(scopes, path);
  if (root !== "") return `scope:${root}`;
  const slash = path.indexOf("/");
  return slash < 0 ? "top:" : `top:${path.slice(0, slash)}`;
}

/** Merge one run of adjacent fallback slices into a single content-addressed slice. */
function mergeFallbackRun(run: readonly PartitionSlice[]): PartitionSlice {
  const files = run.flatMap((slice) => slice.files).sort((a, b) => byString(a.path, b.path));
  if (run.length === 1 && run[0] !== undefined) return run[0];
  // The FIRST constituent's hierarchical id is kept as the routing family, so the
  // fallback tier's ids stay legible (`dir:docs`, `@rennet/core`) and
  // `familiesMatch`'s prefix rule keeps working across the tier exactly as it did
  // before coalescing. The `#hash` half is the same content-addressing the module
  // batches use ({@link PartitionSlice.id}): membership decides the id, so an
  // unchanged rebuild reproduces it and a changed run moves only itself.
  //
  // The other constituents' families are kept explicitly ({@link
  // PartitionSlice.families}). Keeping only the head's would make a deletion under
  // a non-head constituent's directory route NOTHING: `dir:docs/b` neither equals
  // nor prefixes `dir:docs/a`, so the slice now HOLDING those files would not
  // re-run. Every constituent's family, deduped and sorted so the field is as
  // deterministic as the id.
  const head = run[0]?.id ?? "dir:.";
  const families = [...new Set(run.flatMap(sliceFamilies))].sort(byString);
  return {
    id: `${head}#${sha256Hex(files.map((file) => file.path).join("\n")).slice(0, 8)}`,
    families,
    files,
    neighbors: [],
  };
}

/**
 * Coalesce the directory fallback's slices up to {@link FALLBACK_COALESCE_CAP}
 * files each, merging only ADJACENT slices within one bucket
 * ({@link coalesceGroupKey}).
 *
 * Adjacent, not re-partitioned: `buildPartitions` already emits a bucket's slices
 * in sorted-path order and never splits a directory across two of them, so merging
 * runs of them preserves that directory coherence while removing the turns. A
 * slice already at or over the cap is a run of one and passes through untouched —
 * as does a bucket that yields a single slice, which keeps its original id rather
 * than acquiring a hash for a merge that never happened.
 *
 * NOT applied on {@link partitionsFromSnapshot}'s degradation path: there the
 * fallback holds the WHOLE eligible inventory at a 120-file cap. The measured
 * 75-file policy is for the isolated tail left after module batching, not for that
 * different failure-mode population.
 */
export function coalesceFallbackSlices(
  slices: readonly PartitionSlice[],
  scopes: readonly { readonly name: string; readonly root: string }[],
  cap: number = FALLBACK_COALESCE_CAP,
): readonly PartitionSlice[] {
  const buckets = new Map<string, PartitionSlice[]>();
  for (const slice of slices) {
    const key = coalesceGroupKey(scopes, slice.files[0]?.path ?? "");
    const bucket = buckets.get(key);
    if (bucket === undefined) buckets.set(key, [slice]);
    else bucket.push(slice);
  }

  const out: PartitionSlice[] = [];
  for (const key of [...buckets.keys()].sort(byString)) {
    let run: PartitionSlice[] = [];
    let size = 0;
    for (const slice of buckets.get(key) as PartitionSlice[]) {
      if (run.length > 0 && size + slice.files.length > cap) {
        out.push(mergeFallbackRun(run));
        run = [];
        size = 0;
      }
      run.push(slice);
      size += slice.files.length;
    }
    if (run.length > 0) out.push(mergeFallbackRun(run));
  }
  return out;
}

// ── Module batching (Louvain over the import graph) ──────────────────────────

/**
 * Louvain's settings, pinned so the result is a pure function of the graph.
 *
 * `randomWalk: false` is the load-bearing one: it is the only place the library
 * consults its RNG (it randomises the node index the local-move sweep starts
 * from), and with it off the sweep always starts at index 0. `rng` is pinned to a
 * constant anyway, so a future default change cannot smuggle entropy back in
 * through a path this comment did not anticipate.
 *
 * `getEdgeWeight: "weight"` reads the weight we set explicitly on every edge (the
 * number of distinct import relations between the pair), rather than leaving the
 * library to find an attribute that is not there. `resolution: 1` is the standard
 * modularity resolution; batch SIZE is governed by splitting and pooling below,
 * not by tuning this.
 */
export const LOUVAIN_OPTIONS = {
  getEdgeWeight: "weight",
  randomWalk: false,
  resolution: 1,
  rng: () => 0,
} as const;

/** What {@link buildModuleBatches} needs. All of it is derivable from a loaded snapshot. */
export interface ModuleBatchInput {
  /** The mapping-ELIGIBLE files, in any order. Ineligible files must not appear. */
  readonly files: readonly FileEntry[];
  /** Workspace scopes, for pooling coherence and for the fallback tier. */
  readonly scopes: readonly { readonly name: string; readonly root: string }[];
  /** The repo-wide import graph. */
  readonly graph: ImportGraph;
  /** A file's exported symbol names, for the neighbour map. */
  readonly exportsOf: (path: string) => readonly string[];
}

/** Chunk `n` items into near-equal pieces, each at most `max`. Deterministic. */
function chunkSizes(n: number, max: number, target: number): number[] {
  if (n <= max) return [n];
  const pieces = Math.max(2, Math.ceil(n / target));
  const base = Math.floor(n / pieces);
  const remainder = n % pieces;
  return Array.from({ length: pieces }, (_, i) => base + (i < remainder ? 1 : 0));
}

/**
 * The ROOT of the most specific (longest-root) scope containing `path`, or `""` for
 * a path under no scope.
 *
 * Root, not name: the root is the identity prefix ownership is actually decided by,
 * so two distinct packages that happen to share a `name` stay distinct here — the
 * same rule {@link buildPartitions} keys its groups on.
 */
function scopeRootOf(scopes: readonly { name: string; root: string }[], path: string): string {
  let best: { name: string; root: string } | undefined;
  for (const scope of scopes) {
    if (!underPrefix(path, scope.root)) continue;
    if (best === undefined || scope.root.length > best.root.length) best = scope;
  }
  return best?.root ?? "";
}

/**
 * Batch the mapping-eligible files by import-graph community.
 *
 * The shape, in order:
 *  1. Files with no resolved edge to another eligible file are handed to the
 *     DIRECTORY FALLBACK — Louvain has nothing to say about an isolated node, and
 *     inventing a community for it would be noise dressed as structure.
 *  2. The rest become an undirected weighted graph (nodes inserted in sorted path
 *     order, edges in sorted pair order, so the input is itself deterministic) and
 *     Louvain runs with {@link LOUVAIN_OPTIONS}.
 *  3. A community over {@link MAX_BATCH_SIZE} splits into near-equal chunks of its
 *     SORTED member paths. Sorted paths cluster by directory, so alphabetic
 *     chunking is directory chunking in practice, without a second heuristic.
 *  4. A community under {@link MIN_BATCH_SIZE} is pooled — always WITHIN one
 *     workspace scope, never across scopes, and per MEMBER, so a tiny community
 *     that straddles two packages contributes to each package's own pool.
 *     Coherence beats compaction: a batch of unrelated two-file communities from
 *     one package is still a package, and a scope with too few leftovers to fill a
 *     batch keeps its own undersized one.
 *  5. Every batch gets its {@link MemberNeighbors} map (see {@link NEIGHBOR_CAP}).
 *
 * Batches come back ordered by their lexically-first member, so the whole result
 * is a pure, stable function of the input.
 */
export function buildModuleBatches(input: ModuleBatchInput): readonly PartitionSlice[] {
  const eligible = new Map<string, FileEntry>();
  for (const file of [...input.files].sort((a, b) => byString(a.path, b.path))) {
    if (!eligible.has(file.path)) eligible.set(file.path, file);
  }

  // Undirected adjacency over ELIGIBLE files only, weighted by how many distinct
  // import relations join the pair. Restricting to the eligible set here is what
  // makes "a neighbour is always in some other batch" true later on.
  const adjacency = new Map<string, Map<string, number>>();
  const bump = (from: string, to: string): void => {
    let row = adjacency.get(from);
    if (row === undefined) {
      row = new Map();
      adjacency.set(from, row);
    }
    row.set(to, (row.get(to) ?? 0) + 1);
  };
  const outgoing = new Map<string, Set<string>>();
  for (const edge of input.graph.edges) {
    if (edge.from === edge.to) continue;
    if (!eligible.has(edge.from) || !eligible.has(edge.to)) continue;
    let seen = outgoing.get(edge.from);
    if (seen === undefined) {
      seen = new Set();
      outgoing.set(edge.from, seen);
    }
    if (seen.has(edge.to)) continue; // one file→file relation, however many specifiers
    seen.add(edge.to);
    bump(edge.from, edge.to);
    bump(edge.to, edge.from);
  }

  const connected: FileEntry[] = [];
  const isolated: FileEntry[] = [];
  for (const file of eligible.values()) {
    if ((adjacency.get(file.path)?.size ?? 0) > 0) connected.push(file);
    else isolated.push(file);
  }

  const slices: PartitionSlice[] = [];
  if (connected.length > 0) {
    for (const members of communityBatches(connected, adjacency, input.scopes)) {
      slices.push({
        id: moduleBatchId(members.map((f) => f.path)),
        files: members,
        neighbors: neighborMap(members, adjacency, outgoing, input.exportsOf),
        imports: withinBatchImports(members, outgoing),
      });
    }
  }
  slices.sort((a, b) => byString(a.files[0]?.path ?? "", b.files[0]?.path ?? ""));

  // The isolated tail follows every module batch, coalesced so an edge-less file
  // does not cost a worker turn per handful (see {@link FALLBACK_COALESCE_CAP}).
  // `imports: []` is stamped on it deliberately: the graph WAS read, and it says
  // these files join nothing — which is exactly why they are here.
  const fallback = coalesceFallbackSlices(
    buildPartitions({ files: isolated, scopes: input.scopes }),
    input.scopes,
  ).map((slice) => ({ ...slice, imports: [] as readonly SliceImport[] }));
  return [...slices, ...fallback];
}

/** The resolved edges joining two members of one batch, sorted by `(from, to)`. */
function withinBatchImports(
  members: readonly FileEntry[],
  outgoing: ReadonlyMap<string, ReadonlySet<string>>,
): readonly SliceImport[] {
  const inBatch = new Set(members.map((file) => file.path));
  const out: SliceImport[] = [];
  for (const member of members) {
    for (const to of [...(outgoing.get(member.path) ?? [])].sort(byString)) {
      if (inBatch.has(to)) out.push({ from: member.path, to });
    }
  }
  return out.sort((a, b) => byString(a.from, b.from) || byString(a.to, b.to));
}

/** Run Louvain, then split the oversized communities and pool the tiny ones. */
function communityBatches(
  connected: readonly FileEntry[],
  adjacency: ReadonlyMap<string, ReadonlyMap<string, number>>,
  scopes: readonly { readonly name: string; readonly root: string }[],
): FileEntry[][] {
  const graph = new UndirectedGraph();
  // Insertion order is part of the algorithm's input, so it is fixed: nodes in
  // sorted path order, then each undirected edge once, in sorted pair order.
  const sorted = [...connected].sort((a, b) => byString(a.path, b.path));
  for (const file of sorted) graph.addNode(file.path);
  for (const file of sorted) {
    const row = adjacency.get(file.path);
    if (row === undefined) continue;
    for (const other of [...row.keys()].sort(byString)) {
      if (byString(file.path, other) >= 0) continue; // add each undirected pair once
      graph.addEdge(file.path, other, { weight: row.get(other) ?? 1 });
    }
  }

  const communities = louvain(graph, LOUVAIN_OPTIONS);
  const byCommunity = new Map<number, FileEntry[]>();
  for (const file of sorted) {
    // Every node was inserted above, so the lookup always hits; `-1` is a
    // never-taken arm that keeps a hypothetical miss out of community 0's group.
    const id = communities[file.path] ?? -1;
    const group = byCommunity.get(id);
    if (group === undefined) byCommunity.set(id, [file]);
    else group.push(file);
  }

  // Community NUMBERS carry no meaning across builds, so they are dropped here:
  // the groups are re-ordered by their own lexically-first member before anything
  // downstream can depend on Louvain's numbering.
  const groups = [...byCommunity.values()].sort((a, b) =>
    byString(a[0]?.path ?? "", b[0]?.path ?? ""),
  );

  const batches: FileEntry[][] = [];
  const tiny: FileEntry[][] = [];
  for (const group of groups) {
    if (group.length < MIN_BATCH_SIZE) {
      tiny.push(group);
      continue;
    }
    let cursor = 0;
    for (const size of chunkSizes(group.length, MAX_BATCH_SIZE, DEFAULT_BATCH_TARGET)) {
      batches.push(group.slice(cursor, cursor + size));
      cursor += size;
    }
  }
  return [...batches, ...poolTiny(tiny, scopes)];
}

/**
 * Pool the sub-{@link MIN_BATCH_SIZE} communities into misc batches of at most
 * {@link POOLED_BATCH_CAP}, keeping every pool inside ONE workspace scope. A scope
 * whose leftovers do not reach the cap keeps its own (undersized) batch rather than
 * being blended with an unrelated package — a small coherent batch reads better than
 * a large incoherent one, and the cost of an extra turn is the cheap half of this
 * trade. Nothing is ever pooled ACROSS scopes.
 *
 * Bucketing is PER MEMBER, not per community: a tiny community can legitimately
 * straddle two packages (that is what an import edge between them means), and
 * filing the whole thing under its first member's scope would drop the other
 * package's file into a batch of a package it is not in. Each member is filed under
 * its own most-specific scope ROOT — the identity prefix, so two packages sharing a
 * `name` never blend either.
 */
function poolTiny(
  tiny: readonly FileEntry[][],
  scopes: readonly { readonly name: string; readonly root: string }[],
): FileEntry[][] {
  const byScopeRoot = new Map<string, FileEntry[]>();
  for (const group of tiny) {
    for (const member of group) {
      const root = scopeRootOf(scopes, member.path);
      const bucket = byScopeRoot.get(root);
      if (bucket === undefined) byScopeRoot.set(root, [member]);
      else bucket.push(member);
    }
  }
  const pooled: FileEntry[][] = [];
  for (const root of [...byScopeRoot.keys()].sort(byString)) {
    const files = (byScopeRoot.get(root) as FileEntry[]).sort((a, b) => byString(a.path, b.path));
    for (let i = 0; i < files.length; i += POOLED_BATCH_CAP) {
      pooled.push(files.slice(i, i + POOLED_BATCH_CAP));
    }
  }
  return pooled;
}

/**
 * The batch's cross-batch neighbour map: for each member, the 1-hop import
 * neighbours OUTSIDE this batch (either direction), each with the neighbour's
 * exported symbol names.
 *
 * This is what keeps a partition from lying by omission. Batching cuts edges; a
 * worker that sees only its own files would read a module as if those edges did
 * not exist. The map hands back exactly what was cut, with enough of the other
 * side (its exported names) to reason about, and says so when the
 * {@link NEIGHBOR_CAP} truncated the list.
 *
 * Truncation keeps the HIGHEST-DEGREE neighbours: on a hub file the useful
 * neighbours are the ones the rest of the repo also depends on. The kept set is
 * then emitted in path order, so the output does not vary with degree ties.
 */
function neighborMap(
  members: readonly FileEntry[],
  adjacency: ReadonlyMap<string, ReadonlyMap<string, number>>,
  outgoing: ReadonlyMap<string, ReadonlySet<string>>,
  exportsOf: (path: string) => readonly string[],
): MemberNeighbors[] {
  const inBatch = new Set(members.map((f) => f.path));
  const degreeOf = (path: string): number => adjacency.get(path)?.size ?? 0;
  const out: MemberNeighbors[] = [];
  for (const member of members) {
    const row = adjacency.get(member.path);
    if (row === undefined) continue;
    const outside = [...row.keys()].filter((path) => !inBatch.has(path)).sort(byString);
    if (outside.length === 0) continue;
    const kept = new Set(
      [...outside]
        .sort((a, b) => degreeOf(b) - degreeOf(a) || byString(a, b))
        .slice(0, NEIGHBOR_CAP),
    );
    // The undirected adjacency decided WHO is a neighbour; `outgoing` — the SAME
    // directed edge set the adjacency was bumped from — says which way, so the worker
    // can tell a dependency from a dependent. Reading direction off that one source
    // is what makes "neither direction" unrepresentable rather than merely unlikely:
    // an adjacency entry exists only because some `from → to` was recorded here, so
    // at least one of the two lookups below is always true, and the final arm is a
    // real deduction instead of a fallback that could quietly mislabel an edge.
    const imports = outgoing.get(member.path);
    out.push({
      path: member.path,
      neighbors: outside
        .filter((path) => kept.has(path))
        .map((path) => ({
          path,
          direction: imports?.has(path)
            ? outgoing.get(path)?.has(member.path)
              ? ("both" as const)
              : ("imports" as const)
            : ("imported-by" as const),
          symbols: exportsOf(path),
        })),
      truncated: outside.length - kept.size,
    });
  }
  return out;
}

// ── The wiring: a loaded snapshot to slices ──────────────────────────────────

/**
 * Partition a materialized snapshot for a mapping run: classify the inventory,
 * batch the eligible connected files by import community, and hand the rest to
 * the directory fallback.
 *
 * DEGRADES, never throws. A shard family the loader cannot produce costs exactly
 * what it covers and nothing else — refusing to map at all over one unavailable
 * shard family trades a degraded map for no map:
 *
 *  - **No import graph** → no communities to batch by, so the whole eligible
 *    inventory goes through the directory fallback, and every slice's `imports`
 *    stays ABSENT so a worker packet says the graph could not be read.
 *  - **No symbol index** → no skeletons and no neighbour export names, so every
 *    file's `symbols` stays ABSENT and a packet says so per file.
 *
 * The two used to be ONE condition, which made either failure report both: a
 * repository whose symbol shards were missing was told its import graph was
 * unreadable, and the fallback it fell into then said "these files join nothing"
 * about a graph that was sitting right there. Neither claim was true and both were
 * about the file the worker was reading. They are independent here because they are
 * independent facts.
 */
export function partitionsFromSnapshot(snapshot: LoadedSnapshot): readonly PartitionSlice[] {
  const symbols = querySymbolIndex(snapshot);
  const classified = classifyInventory(
    snapshot.files,
    symbols.ok ? symbols.index.generatedBlobs : new Set(),
  );
  const eligible = classified
    .filter((entry) => entry.ineligible === null)
    .map((entry) => ({ path: entry.path, blobOid: entry.blobOid }));

  // Each eligible file carries its own skeleton, so the worker packet is built
  // from the slice alone. `symbols` stays ABSENT for a blob with no shard — and
  // for EVERY blob when the index itself could not be read.
  const index = symbols.ok ? symbols.index : null;
  const files =
    index === null
      ? eligible
      : eligible.map((file) => {
          const declared = index.symbolsByBlob.get(file.blobOid);
          return declared === undefined ? file : { ...file, symbols: declared };
        });

  const graph = queryImportGraph(snapshot);
  if (!graph.ok) {
    // No graph: the directory tier partitions the whole eligible inventory, and
    // `imports` is absent on every slice. The skeletons above still ride along —
    // an unreadable import shard says nothing about the symbol shards.
    return buildPartitions({ files, scopes: snapshot.scopes });
  }

  const blobByPath = new Map(snapshot.files.map((file) => [file.path, file.blobOid] as const));
  return buildModuleBatches({
    files,
    scopes: snapshot.scopes,
    graph: graph.graph,
    // No symbol index means no export names to show — an empty list per neighbour,
    // which the packet renders as a bare path rather than as "exports nothing".
    exportsOf: (path) => {
      const blobOid = blobByPath.get(path);
      return blobOid === undefined || index === null
        ? []
        : (index.exportsByBlob.get(blobOid) ?? []);
    },
  });
}
