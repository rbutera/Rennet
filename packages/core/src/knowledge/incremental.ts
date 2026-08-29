/**
 * Incremental partition-routed delta (#460): on a baseline advance only the
 * partitions owning changed paths re-run, and the verify seat re-adjudicates
 * only the statements whose cited evidence changed. Everything else carries
 * verbatim with the shipped carry semantics (extracted from the flat delta
 * pass, not rewritten): untouched statements are never re-run, and a human
 * disposition (confirmed/rejected) is durable by statement id.
 *
 * Cross-cutting statements need no special casing here: their evidence spans
 * slices, so `statementIntersectsChange` re-queues them whenever ANY cited
 * path changed — even one owned by a partition that is not re-running.
 */

import type {
  KnowledgeAnchor,
  KnowledgeSet,
  KnowledgeStatement,
  KnowledgeStatus,
} from "@rennet/protocol";
import { type LoadedSnapshot, queryBlobSignature } from "../project-context";
import { hasSymbolExtractor } from "../project-snapshot";
import { type PartitionSlice, partitionIdFamily, sliceFamilies } from "./partition";
import { fileBlobIndex, knowledgeStatementId } from "./read";

// ── Signature diff: cosmetic vs structural (context-map rebuild, W4) ──────────
//
// Content addressing already answers "unchanged" for free, and everything that is
// left pays a worker turn. Most of what is left is agent-written body churn: a
// function rewritten, a branch added, a comment fixed. None of that changes what the
// file EXPORTS, which is the skeleton a worker was fed and what its statements are
// about, so re-running its batch buys a re-worded version of the same claims.
//
// So the changed set is split before it reaches routing. A file whose SIGNATURE —
// its exported symbols, its generated bit, and the imports it names — is identical
// across the two snapshots is COSMETIC and routes no worker; everything else is
// STRUCTURAL and routes as before. Statements still re-anchor on EVERY blob change
// through `planReverify` — this decides which slices spend a model turn, not which
// statements are re-verified, and the two are deliberately different questions.

/** Whether two same-length-agnostic string lists are element-wise equal. */
function sameList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

/**
 * Whether one changed path's edit left the file's SIGNATURE alone — its export
 * surface, its generated bit, AND the imports it names.
 *
 * The decision table, and every honest "we cannot tell" in it lands on structural —
 * a needless turn is the cheap error here, a skipped one is invisible:
 *
 * | case                                                 | verdict    |
 * |------------------------------------------------------|------------|
 * | no prior snapshot, or one that will not materialize   | structural |
 * | a prior snapshot that is not the one the knowledge    |            |
 * | was learned against (fingerprint mismatch)            | structural |
 * | absent from either snapshot (added, deleted)          | structural |
 * | same blob on both sides (a mode change, a rename)     | cosmetic   |
 * | the symbol extractor does not read this language      | structural |
 * | either shard missing, unreadable, or about another    |            |
 * | blob than the one asked for                           | structural |
 * | the two sides were produced by different extractors   | structural |
 * | the generated-banner bit moved                        | structural |
 * | a symbol added, removed, renamed, or re-kinded        | structural |
 * | an import specifier added, removed, or re-pointed     | structural |
 * | identical symbols and imports, different lines/bodies | cosmetic   |
 *
 * The first two rows are WHOLE-RUN, not per-file: they are decided once by the caller
 * ({@link structuralChanges} is handed `null`) and make every path in the change
 * structural at a stroke. Two comparable snapshots are a precondition of this pass
 * saying anything at all.
 *
 * IMPORTS ARE PART OF THE SIGNATURE, and leaving them out was a real defect rather
 * than a stated ceiling. An import-only edit preserves every exported name and kind
 * while moving the file's partition membership, the module batch it lands in, that
 * batch's cut edges, and the neighbour maps its worker reads — so it was classified
 * cosmetic and routed no worker at all, and the map went on describing a graph the
 * repository had left. The imports shard is content-addressed on the same terms as
 * the symbols shard, so this costs one more shard decode per changed path.
 *
 * TWO CEILINGS, both deliberate and both stated because they are invisible from the
 * outside:
 *
 *  1. **Exports only.** `structural-ts-v2` extracts top-level exported declarations,
 *     so a rewritten private helper reads as cosmetic. That is the right answer for
 *     what the statements assert — they are anchored claims about the file's surface
 *     — and the wrong answer for a claim about an internal mechanism, which a worker
 *     is free to make. The mitigation is not a finer diff: it is that such a claim's
 *     anchors moved, so `planReverify` re-anchors it (dropping its now-stale line
 *     span) and the verify seat sees it flagged, told to re-read. What is genuinely
 *     lost is the chance to MINT a new statement about an internal change, and the
 *     answer to that is the next extractor, not this filter.
 *  2. **TS/JS only.** Every other file gets a symbols shard with `symbols: []` and no
 *     imports shard at all, so comparing shards would call every markdown edit
 *     cosmetic. {@link hasSymbolExtractor} refuses to guess: a `.md`, `.json`, `.py`
 *     or `.sql` edit is structural and re-runs its slice's worker. Widening this
 *     needs extractors, not heuristics.
 */
function isCosmetic(
  path: string,
  currentBlob: string | undefined,
  priorBlob: string | undefined,
  current: LoadedSnapshot,
  prior: LoadedSnapshot,
): boolean {
  if (currentBlob === undefined || priorBlob === undefined) return false;
  if (currentBlob === priorBlob) return true;
  if (!hasSymbolExtractor(path)) return false;
  const now = queryBlobSignature(current, currentBlob);
  const before = queryBlobSignature(prior, priorBlob);
  if (now === null || before === null) return false;
  // Same extraction on both sides, or the comparison is between two different
  // questions: a v1 shard's silence about the generated bit is not a v2 shard's
  // `false`, and a future extractor that indexes more can only differ from this one.
  if (
    now.symbolExtractor !== before.symbolExtractor ||
    now.importExtractor !== before.importExtractor
  ) {
    return false;
  }
  return (
    now.generated === before.generated &&
    sameList(now.symbols, before.symbols) &&
    sameList(now.imports, before.imports)
  );
}

/**
 * The subset of `changedPaths` whose edit could have moved the map — what
 * {@link routeDelta} should be given, in place of the raw changed set.
 *
 * `prior === null` (no snapshot at the delta base, or one that will not materialize)
 * returns the changed set UNTOUCHED: with nothing to compare against, every change is
 * structural. That is the fail-safe direction, and it is the behaviour this pass had
 * before the signature diff existed.
 */
export function structuralChanges(
  changedPaths: readonly string[],
  current: LoadedSnapshot,
  prior: LoadedSnapshot | null,
): readonly string[] {
  if (prior === null) return changedPaths;
  const after = new Map(current.files.map((file) => [file.path, file.blobOid]));
  const before = new Map(prior.files.map((file) => [file.path, file.blobOid]));
  return changedPaths.filter(
    (path) => !isCosmetic(path, after.get(path), before.get(path), current, prior),
  );
}

/** Whether a statement cites any of the changed paths (⇒ needs re-adjudication). */
export function statementIntersectsChange(
  statement: KnowledgeStatement,
  changed: ReadonlySet<string>,
): boolean {
  return statement.evidence.some((anchor) => changed.has(anchor.path));
}

/** The directory containing `path`; `""` (the repo root) for a top-level path. */
function parentDirectory(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

/**
 * Whether two partition-id FAMILIES name the same neighbourhood: equal, or one is
 * a `/`-separated prefix of the other (the hierarchical fallback's split-boundary
 * drift, `lib` ⇄ `lib/x`).
 */
function familiesMatch(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

/**
 * Whether a CURRENT slice answers to a prior owner's family — asked of every family
 * the slice carries, not just the one its id shows.
 *
 * A coalesced fallback slice is several constituents under one id, so the id names
 * only the first of them ({@link sliceFamilies}). Matching on the id alone would
 * route a deletion under any other constituent's directory to nothing at all, while
 * the slice that actually holds those files sat right there.
 */
function sliceAnswersTo(slice: PartitionSlice, priorFamily: string): boolean {
  return sliceFamilies(slice).some((family) => familiesMatch(family, priorFamily));
}

/**
 * The partitions that own at least one changed path — the only workers a delta
 * re-runs.
 *
 * ROUTING IS FILE-LEVEL, and that lives in what the caller passes here: `changedPaths`
 * is the STRUCTURAL subset ({@link structuralChanges}), not the raw diff. A slice
 * whose only changed member was a body-only edit is therefore never in the result —
 * not because this function inspects the edit, but because the path never arrives.
 * Passing the raw changed set is not wrong, it is the old partition-level behaviour:
 * every slice owning any touched file re-runs.
 *
 * A changed path with no CURRENT owner (deleted, ownership moved with the
 * scope graph, or the file is now mapping-ineligible) routes through its PRIOR
 * owner, by TWO independent rules whose results are unioned:
 *
 *  1. **Same id family.** Every current slice answering to the prior owner's family
 *     re-runs — asked of {@link sliceFamilies}, so a COALESCED fallback slice is
 *     matched on every constituent it merged and not only on the one whose id it
 *     kept. Family, not raw id, because a module
 *     batch's id carries a content hash over its members ({@link PartitionSlice.id})
 *     — losing a member changes the hash by design, so raw-id equality would report
 *     every re-formed batch as a stranger. This rule only ever fires WITHIN a tier
 *     (`mod:…` ⇄ `mod:…`, hierarchical ⇄ hierarchical): a `mod:` family can never
 *     prefix-match a hierarchical one, so on its own it routes NOTHING across tiers.
 *  2. **Nearest surviving directory.** Walk up from the deleted path's own parent
 *     directory to the first ancestor directory that still holds a surviving mapped
 *     file DIRECTLY (not merely somewhere in its subtree), and route every current
 *     slice holding such a file. The repo root (`""`) is the last stop and is
 *     treated like any other directory — it matches the slices holding top-level
 *     files, never "every slice in the repo".
 *
 * Rule 2 is what makes cross-tier routing work, and it is the rule that carries the
 * live caller: the current set is module batches (`mod:<path>#<hash>`) built by
 * `buildModuleBatches`, while prior ownership is rebuilt with the hierarchical
 * `buildPartitions` ids, so rule 1 alone matches no module batch at all and a
 * deleted connected file would route zero workers. With rule 2, a deleted file
 * re-runs the batches that hold its surviving neighbours on disk.
 *
 * A path with no prior owner, or one whose neighbourhood has vanished from both
 * rules, routes nothing; `planReverify` still re-adjudicates every statement citing
 * it.
 */
export function routeDelta(
  partitions: readonly PartitionSlice[],
  changedPaths: readonly string[],
  priorPartitions: readonly PartitionSlice[] = [],
): readonly PartitionSlice[] {
  const changed = new Set(changedPaths);
  const routed = new Set(
    partitions.filter((slice) => slice.files.some((file) => changed.has(file.path))),
  );
  const currentlyOwned = new Set(
    partitions.flatMap((slice) => slice.files.map((file) => file.path)),
  );
  const orphaned = changedPaths.filter((path) => !currentlyOwned.has(path));
  if (orphaned.length === 0) return partitions.filter((slice) => routed.has(slice));

  // `directory → the current slices holding a file DIRECTLY in it`, built once.
  const slicesByDirectory = new Map<string, PartitionSlice[]>();
  for (const slice of partitions) {
    for (const file of slice.files) {
      const directory = parentDirectory(file.path);
      const owners = slicesByDirectory.get(directory);
      if (owners === undefined) slicesByDirectory.set(directory, [slice]);
      else if (!owners.includes(slice)) owners.push(slice);
    }
  }

  for (const path of orphaned) {
    const prior = priorPartitions.find((slice) => slice.files.some((file) => file.path === path));
    if (prior === undefined) continue;
    const priorFamily = partitionIdFamily(prior.id);
    for (const slice of partitions) {
      if (sliceAnswersTo(slice, priorFamily)) routed.add(slice);
    }
    for (let directory = parentDirectory(path); ; directory = parentDirectory(directory)) {
      const owners = slicesByDirectory.get(directory);
      if (owners !== undefined) {
        for (const slice of owners) routed.add(slice);
        break;
      }
      if (directory === "") break;
    }
  }
  return partitions.filter((slice) => routed.has(slice));
}

export interface ReverifyPlan {
  /** Statements whose cited evidence changed — the verify seat re-adjudicates these. */
  readonly reverify: readonly KnowledgeStatement[];
  /** Untouched statements, carried verbatim (byte-identical; never re-run). */
  readonly carried: readonly KnowledgeStatement[];
  /**
   * Statements whose evidence is entirely GONE from the new snapshot: nothing
   * left to re-read, so they cannot be re-verified and must never be carried as
   * completed work — they die with their evidence.
   */
  readonly invalidated: readonly KnowledgeStatement[];
}

/**
 * Re-stamp ONE anchor against the new inventory: `[]` when its path vanished,
 * otherwise the anchor at the blob the path now carries.
 *
 * ⚠️ A moved blob DROPS `lines`. The span was measured against bytes that no longer
 * exist, and a cosmetic edit is exactly the case that moves every line below it while
 * leaving the export signature — and therefore the claim — intact. Carrying the old
 * span forward produced a statement that pointed at the WRONG code: the verify prompt
 * renders it ({@link renderHypothesis} in `swarm.ts`), so a seat re-reading "the cited
 * span" read the wrong lines, and the merge's `betterAnchored` ranked that stale-span
 * copy ABOVE a fresh mint carrying no span at all. `(path, blobOid)` is the documented
 * resolution key ({@link KnowledgeAnchor}); `lines` only narrows it, so dropping the
 * narrowing costs precision and keeps the anchor honest.
 *
 * `symbol` SURVIVES, and the asymmetry is deliberate: it is a declared NAME, not a
 * span, so it does not drift with an insertion above it. A rename or removal moves the
 * export signature, which classifies the edit structural and re-runs the worker
 * anyway; and a name that no longer resolves is visibly a name that no longer
 * resolves, where a stale span is silently the wrong lines.
 */
function reanchor(
  anchor: KnowledgeAnchor,
  filesByPath: ReadonlyMap<string, string>,
): KnowledgeAnchor[] {
  const blobOid = filesByPath.get(anchor.path);
  if (blobOid === undefined) return [];
  if (blobOid === anchor.blobOid) return [anchor];
  return [
    {
      path: anchor.path,
      blobOid,
      ...(anchor.symbol === undefined ? {} : { symbol: anchor.symbol }),
    },
  ];
}

/**
 * Split the prior set into re-verify vs carry per the changed-path closure.
 * When the new snapshot's file inventory is supplied, re-verify entries are
 * RE-ANCHORED against it before verification ({@link reanchor}): each anchor's
 * blobOid is restamped from the new inventory, an anchor whose path vanished is
 * dropped, a moved blob drops the anchor's stale line span, and a statement whose
 * evidence thereby changed gets a fresh id and returns to `hypothesis` — its prior
 * verdict was about bytes that no longer exist. A statement with NO surviving anchor
 * lands in `invalidated`.
 */
export function planReverify(
  knowledgeSet: KnowledgeSet,
  changedPaths: readonly string[],
  currentFiles?: readonly { readonly path: string; readonly blobOid: string }[],
): ReverifyPlan {
  const changed = new Set(changedPaths);
  const filesByPath = currentFiles === undefined ? null : fileBlobIndex(currentFiles);
  const reverify: KnowledgeStatement[] = [];
  const carried: KnowledgeStatement[] = [];
  const invalidated: KnowledgeStatement[] = [];
  for (const statement of knowledgeSet.statements) {
    if (!statementIntersectsChange(statement, changed)) {
      carried.push(statement);
      continue;
    }
    if (filesByPath === null) {
      reverify.push(statement);
      continue;
    }
    const evidence = statement.evidence.flatMap((anchor) => reanchor(anchor, filesByPath));
    if (evidence.length === 0) {
      invalidated.push(statement);
      continue;
    }
    const id = knowledgeStatementId({
      subject: statement.subject,
      aspect: statement.aspect,
      claim: statement.claim,
      evidence,
    });
    reverify.push(
      id === statement.id ? statement : { ...statement, id, evidence, status: "hypothesis" },
    );
  }
  return { reverify, carried, invalidated };
}

/**
 * The shipped disposition-durability rule: a human/seat disposition
 * (confirmed/rejected) is durable by statement id — if a re-adjudication
 * re-mints the SAME claim (same id) as a fresh HYPOTHESIS, it keeps the prior
 * status rather than resurfacing unlabelled. A statement already disposed in
 * the CURRENT pass (the verify seat just confirmed/rejected it) is never
 * overwritten — a fresh verdict outranks a stale one. A genuinely changed
 * claim gets a new id (its evidence blobOid moved) and is correctly a new
 * hypothesis.
 */
export function dispositionCarrier(
  priorSet: KnowledgeSet,
): (statement: KnowledgeStatement) => KnowledgeStatement {
  const prior = new Map<string, KnowledgeStatus>();
  for (const statement of priorSet.statements)
    if (statement.status !== "hypothesis") prior.set(statement.id, statement.status);
  return (statement) => {
    if (statement.status !== "hypothesis") return statement;
    const disposed = prior.get(statement.id);
    return disposed ? { ...statement, status: disposed } : statement;
  };
}
