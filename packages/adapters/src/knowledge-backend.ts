import { type KnowledgeQuery, type KnowledgeResult, queryKnowledge } from "@rennet/core";
import type { KnowledgeStore } from "./knowledge-store";
import type { ResolvedRepoContext } from "./project-context-backend";
import type { ProjectContextReader } from "./project-context-reader";

// ─────────────────────────────────────────────────────────────────────────────
// The `context.knowledge` slice of a `CanvasOpsBackend` (repo-map-knowledge,
// layer c). The ONLY model-backed layer — but this READ runs NO model. It gates
// through the SAME fail-closed snapshot reader the deterministic context reads use
// (so a stale/absent/corrupt snapshot is a typed refusal, never a served-but-wrong
// answer), then serves the already-enriched knowledge set VERBATIM via the pure
// `queryKnowledge` handler, which resolves each statement's anchors against the
// fresh snapshot and discloses the invalidated ones as pending.
//
// Knowledge is OFF the review's critical path: an absent set (not yet enriched) is
// an honest EMPTY view, never a gate failure — a review proceeds on the model-free
// structural + symbolic layers regardless of whether knowledge exists.
//
// The knowledge SET read here is the LOCAL set (committed→local seeding is a
// project-open concern, `KnowledgeStore.discoverCommitted`), so the hot read stays
// off the filesystem-walk of committed discovery — same `ResolvedRepoContext` the
// other context accessors resolve to.
// ─────────────────────────────────────────────────────────────────────────────

/** The `CanvasOpsBackend` accessor this adapter supplies. */
export interface KnowledgeBackendPart {
  knowledge(query?: KnowledgeQuery): KnowledgeResult;
}

/**
 * Build the `context.knowledge` backend accessor from the fail-closed
 * {@link ProjectContextReader} gate, a {@link KnowledgeStore}, and the per-review
 * base-context resolver. Every call re-resolves `{repoKey, baseOid}`, gates the
 * snapshot at that OID, then serves the local knowledge set through
 * `queryKnowledge` — so knowledge is always read against the CURRENT fresh
 * snapshot (invalidated statements disclosed, never served wrong).
 */
export function knowledgeBackend(
  reader: ProjectContextReader,
  knowledgeStore: KnowledgeStore,
  resolve: () => ResolvedRepoContext,
): KnowledgeBackendPart {
  return {
    knowledge(query?: KnowledgeQuery): KnowledgeResult {
      const { repoKey, baseOid } = resolve();
      const gated = reader.loadFresh(repoKey, baseOid);
      if (!gated.ok) return { ok: false, failure: gated.failure };
      const set = knowledgeStore.loadLocal(repoKey);
      return { ok: true, knowledge: queryKnowledge(set, gated.snapshot, query) };
    },
  };
}
