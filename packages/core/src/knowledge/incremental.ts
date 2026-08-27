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

/** Whether a statement cites any of the changed paths (⇒ needs re-adjudication). */
export function statementIntersectsChange(
  statement: KnowledgeStatement,
  changed: ReadonlySet<string>,
): boolean {
  return statement.evidence.some((anchor) => changed.has(anchor.path));
}

/** The partitions that own at least one changed path — the only workers a delta re-runs. */
export function routeDelta(
  partitions: readonly PartitionSlice[],
  changedPaths: readonly string[],
): readonly PartitionSlice[] {
  const changed = new Set(changedPaths);
  return partitions.filter((slice) => slice.files.some((file) => changed.has(file.path)));
}

export interface ReverifyPlan {
  /** Statements whose cited evidence changed — the verify seat re-adjudicates these. */
  readonly reverify: readonly KnowledgeStatement[];
  /** Untouched statements, carried verbatim (byte-identical; never re-run). */
  readonly carried: readonly KnowledgeStatement[];
}

/** Split the prior set into re-verify vs carry per the changed-path closure. */
export function planReverify(
  knowledgeSet: KnowledgeSet,
  changedPaths: readonly string[],
): ReverifyPlan {
  const changed = new Set(changedPaths);
  const reverify: KnowledgeStatement[] = [];
  const carried: KnowledgeStatement[] = [];
  for (const statement of knowledgeSet.statements) {
    if (statementIntersectsChange(statement, changed)) reverify.push(statement);
    else carried.push(statement);
  }
  return { reverify, carried };
}

/**
 * The shipped disposition-durability rule: a human/seat disposition
 * (confirmed/rejected) is durable by statement id — if a re-adjudication
 * re-mints the SAME claim (same id), it keeps the prior status rather than
 * resurfacing as a fresh hypothesis. A genuinely changed claim gets a new id
 * (its evidence blobOid moved) and is correctly a new hypothesis.
 */
export function dispositionCarrier(
  priorSet: KnowledgeSet,
): (statement: KnowledgeStatement) => KnowledgeStatement {
  const prior = new Map<string, KnowledgeStatus>();
  for (const statement of priorSet.statements)
    if (statement.status !== "hypothesis") prior.set(statement.id, statement.status);
  return (statement) => {
    const disposed = prior.get(statement.id);
    return disposed && disposed !== statement.status
      ? { ...statement, status: disposed }
      : statement;
  };
}
