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

import type { KnowledgeSet, KnowledgeStatement, KnowledgeStatus } from "@rennet/protocol";
import { type PartitionSlice, partitionIdFamily, sliceFamilies } from "./partition";
import { fileBlobIndex, knowledgeStatementId } from "./read";

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
 * re-runs. A changed path with no CURRENT owner (deleted, ownership moved with the
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
 * Split the prior set into re-verify vs carry per the changed-path closure.
 * When the new snapshot's file inventory is supplied, re-verify entries are
 * RE-ANCHORED against it before verification: each anchor's blobOid is
 * restamped from the new inventory (an anchor whose path vanished is dropped),
 * and a statement whose evidence thereby changed gets a fresh id and returns to
 * `hypothesis` — its prior verdict was about bytes that no longer exist. A
 * statement with NO surviving anchor lands in `invalidated`.
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
    const evidence = statement.evidence.flatMap((anchor) => {
      const blobOid = filesByPath.get(anchor.path);
      return blobOid === undefined ? [] : [{ ...anchor, blobOid }];
    });
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
