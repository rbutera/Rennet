import type { KnowledgeSet, KnowledgeStatement, WorkspaceScope } from "@rennet/protocol";
import { DEFAULT_ASK_MAX_STATEMENTS } from "../context-ask";
import { queryKnowledge } from "../knowledge/read";
import { type LoadedSnapshot, queryImportGraph, underPrefix } from "../project-context";
import { compareStrings } from "./blast-radius";

// ── The Delta packet's knowledge selection (context-map rebuild, W5b) ────────
//
// Before this, the WHOLE stored knowledge set was JSON-inlined into every lens
// drafter prompt, straight off `loadLocal` — two separate dishonesties in one
// field. It was UNPROJECTED, so a statement whose cited bytes the current
// snapshot had already changed reached a drafter labelled exactly like a current
// one, and a statement a human had explicitly REJECTED was offered as evidence.
// And it was UNBOUNDED, so at swarm scale the set alone would crowd out the diff
// the drafter is supposed to read.
//
// This module is the retrieval that replaces it: project first, then scope to
// what the change can plausibly touch, then cap — and DISCLOSE all three, because
// a thinner input that does not say it is thinner is the same defect one layer
// down. Pure over its inputs; the composition root supplies the snapshot.

/** How a {@link ScopedKnowledge} selection was arrived at — never inferred from what is missing. */
export type KnowledgeScopeMode =
  /** The import graph resolved AND covers the change: statements scoped to the changed files' 1-hop neighbourhood. */
  | "import-graph"
  /** No import graph, or none that covers the changed paths: the FULL projected set, never a silently narrower one. */
  | "projected-full"
  /** No fresh snapshot at all: statements carried unprojected (invalidation unknowable). */
  | "unprojected";

/** Statement accounting — what exists, what was offered, and what the cap dropped. */
export interface ScopedKnowledgeCounts {
  /** Every statement in the stored set. Larger than what is offered ⇒ ask `context.ask` for the rest. */
  readonly inStore: number;
  /** Statements dropped because a human explicitly rejected them — never offered as evidence. */
  readonly rejected: number;
  /** Files in the retrieval scope (changed files + their 1-hop import neighbours); 0 when unscoped. */
  readonly scopeFiles: number;
  /**
   * Statements SELECTED into the current list, BEFORE the cap. In `import-graph`
   * this is "current at the snapshot AND in scope"; in `projected-full` it is
   * "current at the snapshot" (there is no scope); in `unprojected` it is simply
   * "kept" — nothing there is known-current, because no anchor could be resolved.
   */
  readonly currentSelected: number;
  /**
   * Invalidated-pending statements selected, BEFORE the cap. Always 0 in
   * `unprojected`: with no snapshot nothing can be shown to be invalidated, so
   * those statements sit in the current list under a mode that says the check
   * did not happen.
   */
  readonly pendingSelected: number;
  /** Statements this packet's cap dropped (current + pending). Non-zero ⇒ the packet is partial. */
  readonly truncated: number;
  /** Changed paths considered — BOTH sides of a rename. The denominator of the two below. */
  readonly changedPaths: number;
  /**
   * ...of those, present in the BASE snapshot's file inventory. A gap here is the
   * honest reading of an added file (or one the snapshot's file cap never
   * indexed): the base cannot answer a dependency question about a path it does
   * not carry. 0 in `unprojected`, where there is no base snapshot at all.
   */
  readonly changedPathsAtBase: number;
  /**
   * ...of those, carrying at least one RESOLVED import edge in either direction.
   * This is what gates `import-graph` mode: a graph that answers nothing about the
   * changed paths would collapse the scope to the changed paths themselves and
   * discard the rest of the store while claiming a confident scoped selection.
   * Read together with `changedPathsAtBase`, it tells "no dependencies" (at base,
   * no edges) apart from "not present at base" (added or unindexed).
   */
  readonly changedPathsWithEdges: number;
}

/**
 * The knowledge a Delta packet carries: a projected, scoped, capped SUBSET of the
 * stored set, plus the disclosure that makes it honest.
 *
 * The asymmetry between the two statement lists is the one `context.ask` and the
 * Context Map view already honour, and it is deliberate:
 *  - `statements` — current at this snapshot (every anchor resolves);
 *  - `invalidatedPending` — the cited bytes changed, so the claim may no longer
 *    hold. DISCLOSED as pending rather than silently mixed in with the current
 *    ones, because a stale claim rendered as fresh is worse than an absent one;
 *  - REJECTED statements appear in neither. A human disowned them; offering one
 *    back to a drafter as evidence would re-launder a claim its owner killed.
 */
export interface ScopedKnowledge {
  /** The generator identity behind the set, or null when no set exists yet. */
  readonly generator: string | null;
  /**
   * The base OID the selection was made against — the SNAPSHOT's, except in
   * `unprojected` mode, where there is no snapshot and this is the set's own
   * learned-against OID instead.
   */
  readonly baseOid: string;
  /**
   * The snapshot fingerprint the selection was made against — again the
   * SNAPSHOT's, except in `unprojected` mode, where it is the fingerprint the set
   * was learned against. `mode` is what tells the two apart; never read this as
   * proof a snapshot was consulted.
   */
  readonly snapshotFingerprint: string;
  readonly mode: KnowledgeScopeMode;
  /** One line stating how this subset was chosen and where the rest still lives. */
  readonly note: string;
  /** Statements current at the snapshot and in scope, capped. */
  readonly statements: readonly KnowledgeStatement[];
  /** In-scope statements the snapshot invalidated — disclosed, capped. */
  readonly invalidatedPending: readonly KnowledgeStatement[];
  readonly counts: ScopedKnowledgeCounts;
}

/**
 * The per-packet statement cap, per list. DERIVED from `context.ask`'s own budget
 * rather than restated, because it is the same consumer with the same budget —
 * two surfaces disagreeing about what "too much knowledge for one prompt" means
 * would be a number nobody owns. Truncation is always disclosed in
 * {@link ScopedKnowledgeCounts.truncated}, and everything the cap drops is still
 * reachable through `context.ask` (when a snapshot exists for it to read).
 */
export const DEFAULT_PACKET_MAX_STATEMENTS = DEFAULT_ASK_MAX_STATEMENTS;

/** A workspace scope, narrowed to the two fields this selection reads. */
type ScopeEntry = Pick<WorkspaceScope, "name" | "root">;

/**
 * A REPO-LEVEL statement: one whose subject CONTAINS a changed file rather than
 * naming one, so it applies to this change without anchoring inside the subgraph.
 * `subject` is documented as "a workspace scope name or a repo-relative
 * path/subtree", and those are two INDEPENDENT namespaces, so both are checked:
 *  - the repo root itself (`""`, `.`, `/`);
 *  - a path subtree that a changed file lives under (`packages/core` ⊃ `packages/core/src/x.ts`);
 *  - a workspace SCOPE NAME (`@rennet/core`) whose root a changed file lives under —
 *    a scope name is not a path, so prefix-matching alone would miss every one.
 *
 * The path route is deliberately NOT gated on the scope table: a path-like subject
 * is a subtree claim in its own right, and a repo may legitimately have a scope
 * NAMED like a path that roots somewhere else. Both routes are pinned by test.
 *
 * Scope names are NOT unique — a workspace may carry two scopes with the same
 * name (`partition.ts` handles exactly that), so EVERY root bearing the name is
 * checked. Taking the first match would silently answer for the wrong package,
 * which is the many-repos-one-identity failure one level down.
 */
function isRepoLevelSubject(
  subject: string,
  changedPaths: readonly string[],
  scopes: readonly ScopeEntry[],
): boolean {
  if (subject === "" || subject === "." || subject === "/") return true;
  if (changedPaths.some((path) => underPrefix(path, subject))) return true;
  return scopes.some(
    (scope) => scope.name === subject && changedPaths.some((path) => underPrefix(path, scope.root)),
  );
}

/** In scope iff the statement's subject or ANY evidence anchor lands in the subgraph — or it is repo-level. */
function inScope(
  statement: KnowledgeStatement,
  scope: ReadonlySet<string>,
  changedPaths: readonly string[],
  scopes: readonly ScopeEntry[],
): boolean {
  if (scope.has(statement.subject)) return true;
  if (statement.evidence.some((anchor) => scope.has(anchor.path))) return true;
  return isRepoLevelSubject(statement.subject, changedPaths, scopes);
}

/**
 * Code-unit compare on the id — NOT `localeCompare`, whose default collation
 * varies by host locale and would make "byte-identical output for identical
 * inputs" a claim this module cannot keep.
 */
const byId = (left: KnowledgeStatement, right: KnowledgeStatement): number =>
  compareStrings(left.id, right.id);

/**
 * The comparator the UNSCOPED modes sort by: statements the change touches
 * WITHOUT needing an import graph first (0-hop: subject or anchor on a changed
 * path, or repo-level), then everything else, id-ordered within each band.
 *
 * This is what keeps the 0-HOP band monotone under the cap. `projected-full`
 * offers a superset of the scoped set — but with more statements than the cap, a
 * plain id sort lets low-id irrelevant rows evict rows the scoped mode kept, so
 * the "wider" mode hands the drafter strictly less useful evidence. Banding the
 * 0-hop-relevant statements first means the cap can never evict THEM.
 *
 * The guarantee stops at 0-hop, and that is the honest ceiling: a statement the
 * scoped mode kept via the 1-HOP import ring is invisible here (no graph, so no
 * ring), lands in band 1, and CAN be capped out by strictly-more-relevant rows.
 * Only the 0-hop band is protected, not the whole scoped set. Still fully
 * deterministic: two bands, each id-sorted.
 */
function byChangeRelevanceThenId(
  changedPaths: readonly string[],
  scopes: readonly ScopeEntry[],
): (left: KnowledgeStatement, right: KnowledgeStatement) => number {
  const zeroHop = new Set(changedPaths);
  const band = (statement: KnowledgeStatement): number =>
    inScope(statement, zeroHop, changedPaths, scopes) ? 0 : 1;
  return (left, right) => band(left) - band(right) || byId(left, right);
}

/**
 * Select the knowledge one Delta packet carries.
 *
 * The rule, in order:
 *  1. PROJECT through `queryKnowledge` against the fresh snapshot — current vs
 *     invalidated-pending — and drop rejected statements outright.
 *  2. SCOPE to the changed files plus their 1-hop import neighbourhood (both
 *     directions: what they import and what imports them). A statement is kept
 *     when its subject or any evidence anchor is in that subgraph, or when it is
 *     repo-level (see {@link isRepoLevelSubject}). Scoping requires the graph to
 *     actually COVER the change — see {@link ScopedKnowledgeCounts.changedPathsWithEdges}.
 *  3. CAP at `cap` PER LIST, and report what was dropped.
 *
 * Degradation is always toward MORE, never silently less: no usable import graph
 * ⇒ the full projected set (`projected-full`); no fresh snapshot ⇒ the stored set
 * unprojected minus rejected (`unprojected`). Either way `mode` and `note` say
 * which answer the packet actually got, and the unscoped modes order the 0-hop
 * change-relevant statements first so the cap keeps THAT band even under
 * pressure (the 1-hop ring is unknowable without the graph, so a ring-only
 * statement can still be capped out — see {@link byChangeRelevanceThenId}).
 *
 * Pure and deterministic: every comparison is code-unit, so the same inputs
 * produce byte-identical output on every host.
 */
export function selectPacketKnowledge(input: {
  /** The stored set, or null when the repo has never been enriched. */
  readonly set: KnowledgeSet | null;
  /** The snapshot the patchset's base OID gated fresh, or null when there is none. */
  readonly snapshot: LoadedSnapshot | null;
  /** The patchset's changed paths — both sides of a rename. */
  readonly changedPaths: readonly string[];
  readonly cap?: number;
}): ScopedKnowledge {
  const cap = input.cap ?? DEFAULT_PACKET_MAX_STATEMENTS;
  const inStore = input.set?.statements.length ?? 0;
  const changedPaths = input.changedPaths.length;
  const isRejected = (statement: KnowledgeStatement): boolean => statement.status === "rejected";

  if (input.snapshot === null) {
    // No snapshot ⇒ no anchor can be resolved, so current and invalidated are
    // indistinguishable. Say that, rather than presenting the set as projected.
    // There is no scope table either, so only the path routes of the repo-level
    // rule can fire when ordering; that is a weaker band, never a wrong one.
    const kept = (input.set?.statements ?? [])
      .filter((s) => !isRejected(s))
      .sort(byChangeRelevanceThenId(input.changedPaths, []));
    const statements = kept.slice(0, cap);
    return {
      generator: input.set?.generator ?? null,
      baseOid: input.set?.baseOid ?? "",
      snapshotFingerprint: input.set?.snapshotFingerprint ?? "",
      mode: "unprojected",
      note: `No fresh project snapshot for this patchset, so statements are carried UNPROJECTED — an invalidated claim cannot be told from a current one here. Rejected statements are still dropped. ${inStore} statement(s) in the store. context.ask reads the same snapshot, so it will refuse here too until the repo map is rebuilt (\`rennet map\`).`,
      statements,
      invalidatedPending: [],
      counts: {
        inStore,
        rejected: inStore - kept.length,
        scopeFiles: 0,
        currentSelected: kept.length,
        pendingSelected: 0,
        truncated: kept.length - statements.length,
        changedPaths,
        changedPathsAtBase: 0,
        changedPathsWithEdges: 0,
      },
    };
  }

  const snapshot = input.snapshot;
  const view = queryKnowledge(input.set, snapshot);
  const current = view.statements.filter((s) => !isRejected(s));
  const pending = view.invalidatedPending.filter((s) => !isRejected(s));
  const rejected =
    view.statements.length + view.invalidatedPending.length - (current.length + pending.length);

  // The 1-hop subgraph — but only when the graph can answer about THIS CHANGE.
  //
  // `edges.length === 0` counts as no graph: a snapshot built before the import
  // shard existed resolves "ok" with nothing in it. So does a graph that resolves
  // plenty of edges elsewhere in the repo and NONE touching a changed path — an
  // added file, or one the snapshot never indexed. Scoping on that would collapse
  // the scope to the changed paths themselves and discard the rest of the store
  // while stamping the packet with a confident `import-graph` mode. Coverage of
  // the change is the gate, not the mere existence of an edge somewhere.
  const graph = queryImportGraph(snapshot);
  const resolved = graph.ok && graph.graph.edges.length > 0 ? graph.graph : null;
  const baseFiles = new Set(snapshot.files.map((file) => file.path));
  const changedPathsAtBase = input.changedPaths.filter((path) => baseFiles.has(path)).length;
  const changedPathsWithEdges =
    resolved === null
      ? 0
      : input.changedPaths.filter(
          (path) => resolved.importsOf(path).length > 0 || resolved.importersOf(path).length > 0,
        ).length;

  const scope =
    resolved !== null && changedPathsWithEdges > 0
      ? (() => {
          const set = new Set(input.changedPaths);
          for (const path of input.changedPaths) {
            for (const neighbour of resolved.importsOf(path)) set.add(neighbour);
            for (const neighbour of resolved.importersOf(path)) set.add(neighbour);
          }
          return set;
        })()
      : null;

  const keep = (statement: KnowledgeStatement): boolean =>
    scope === null ? true : inScope(statement, scope, input.changedPaths, snapshot.scopes);
  const order =
    scope === null ? byChangeRelevanceThenId(input.changedPaths, snapshot.scopes) : byId;
  const currentSelected = current.filter(keep).sort(order);
  const pendingSelected = pending.filter(keep).sort(order);
  const statements = currentSelected.slice(0, cap);
  const invalidatedPending = pendingSelected.slice(0, cap);
  const truncated =
    currentSelected.length -
    statements.length +
    (pendingSelected.length - invalidatedPending.length);

  const mode: KnowledgeScopeMode = scope === null ? "projected-full" : "import-graph";
  const coverage = `${changedPathsWithEdges} of ${changedPaths} changed path(s) carry a resolved import edge; ${changedPathsAtBase} of ${changedPaths} exist at the base snapshot.`;
  const why =
    resolved === null
      ? graph.ok
        ? "no resolved import edges"
        : "import shard unavailable"
      : "no changed path appears in it (added, or never indexed)";
  const note =
    scope === null
      ? `The import graph is unusable for this change (${why}), so this is the FULL projected knowledge set rather than a scoped subset, ordered so the statements naming a changed path come first. ${coverage} ${inStore} statement(s) in the store; ask context.ask for anything not below.`
      : `Scoped by retrieval: the ${changedPaths} changed path(s) plus their 1-hop import neighbours (${scope.size} file(s)), and repo-level statements. ${coverage} ${inStore} statement(s) in the store, ${statements.length} offered below; ask context.ask for anything else you need.`;

  return {
    generator: view.generator,
    baseOid: view.baseOid,
    snapshotFingerprint: view.snapshotFingerprint,
    mode,
    note,
    statements,
    invalidatedPending,
    counts: {
      inStore,
      rejected,
      scopeFiles: scope?.size ?? 0,
      currentSelected: currentSelected.length,
      pendingSelected: pendingSelected.length,
      truncated,
      changedPaths,
      changedPathsAtBase,
      changedPathsWithEdges,
    },
  };
}
