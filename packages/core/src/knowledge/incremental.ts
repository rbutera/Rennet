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
import type { PartitionSlice } from "./partition";
import { fileBlobIndex, knowledgeStatementId } from "./read";

/** Whether a statement cites any of the changed paths (⇒ needs re-adjudication). */
export function statementIntersectsChange(
  statement: KnowledgeStatement,
  changed: ReadonlySet<string>,
): boolean {
  return statement.evidence.some((anchor) => changed.has(anchor.path));
}

/**
 * The partitions that own at least one changed path — the only workers a delta
 * re-runs. A changed path with no CURRENT owner (deleted, or ownership moved
 * with the scope graph) routes through its PRIOR owner: the current slices in
 * the same id family (equal id, or split-boundary drift — one id prefixing the
 * other) re-run so the area around the deletion is re-examined. A path whose
 * prior slice family vanished entirely routes nothing; `planReverify` still
 * re-adjudicates every statement citing it.
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
  for (const path of orphaned) {
    const prior = priorPartitions.find((slice) => slice.files.some((file) => file.path === path));
    if (prior === undefined) continue;
    for (const slice of partitions)
      if (
        slice.id === prior.id ||
        slice.id.startsWith(`${prior.id}/`) ||
        prior.id.startsWith(`${slice.id}/`)
      )
        routed.add(slice);
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
