import type { KnowledgeSet, KnowledgeStatement } from "@rennet/protocol";
import { queryKnowledge } from "../knowledge/read";
import { type LoadedSnapshot, queryImportGraph } from "../project-context";

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
  /** The import graph resolved: statements scoped to the changed files' 1-hop neighbourhood. */
  | "import-graph"
  /** No usable import graph: the FULL projected set, never a silently narrower one. */
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
  /** Current statements matching the scope, BEFORE the cap. */
  readonly currentInScope: number;
  /** Invalidated-pending statements matching the scope, BEFORE the cap. */
  readonly pendingInScope: number;
  /** Statements this packet's cap dropped (current + pending). Non-zero ⇒ the packet is partial. */
  readonly truncated: number;
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
  /** The base OID the selection was made against. */
  readonly baseOid: string;
  /** The snapshot fingerprint the selection was made against. */
  readonly snapshotFingerprint: string;
  readonly mode: KnowledgeScopeMode;
  /** One line stating how this subset was chosen and where the rest still lives. */
  readonly note: string;
  /** Statements current at the snapshot and in scope, capped. Ordered by statement id. */
  readonly statements: readonly KnowledgeStatement[];
  /** In-scope statements the snapshot invalidated — disclosed, capped, ordered by id. */
  readonly invalidatedPending: readonly KnowledgeStatement[];
  readonly counts: ScopedKnowledgeCounts;
}

/**
 * The per-packet statement cap. The SAME number `context.ask` puts in front of a
 * model in one prompt (`DEFAULT_ASK_MAX_STATEMENTS`), because it is the same
 * consumer with the same budget — two surfaces disagreeing about what "too much
 * knowledge for one prompt" means would be a number nobody owns. Truncation is
 * always disclosed in {@link ScopedKnowledgeCounts.truncated}, and everything the
 * cap drops is still reachable through `context.ask`.
 */
export const DEFAULT_PACKET_MAX_STATEMENTS = 80;

/** `path` is `prefix` or lives under it. `""` matches everything (the repo root). */
function underPrefix(path: string, prefix: string): boolean {
  if (prefix === "") return true;
  return path === prefix || path.startsWith(`${prefix}/`);
}

/**
 * A REPO-LEVEL statement: one whose subject CONTAINS a changed file rather than
 * naming one, so it applies to this change without anchoring inside the subgraph.
 * `subject` is documented as "a workspace scope name or a repo-relative
 * path/subtree", and those are two namespaces, so both are checked:
 *  - the repo root itself (`""`, `.`, `/`);
 *  - a path subtree that a changed file lives under (`packages/core` ⊃ `packages/core/src/x.ts`);
 *  - a workspace SCOPE NAME (`@rennet/core`) whose root a changed file lives under —
 *    a scope name is not a path, so prefix-matching alone would miss every one.
 */
function isRepoLevelSubject(
  subject: string,
  changedPaths: readonly string[],
  scopes: readonly { readonly name: string; readonly root: string }[],
): boolean {
  if (subject === "" || subject === "." || subject === "/") return true;
  if (changedPaths.some((path) => underPrefix(path, subject))) return true;
  const root = scopes.find((scope) => scope.name === subject)?.root;
  return root !== undefined && changedPaths.some((path) => underPrefix(path, root));
}

/** In scope iff the statement's subject or ANY evidence anchor lands in the subgraph — or it is repo-level. */
function inScope(
  statement: KnowledgeStatement,
  scope: ReadonlySet<string>,
  changedPaths: readonly string[],
  scopes: readonly { readonly name: string; readonly root: string }[],
): boolean {
  if (scope.has(statement.subject)) return true;
  if (statement.evidence.some((anchor) => scope.has(anchor.path))) return true;
  return isRepoLevelSubject(statement.subject, changedPaths, scopes);
}

const byId = (left: KnowledgeStatement, right: KnowledgeStatement): number =>
  left.id.localeCompare(right.id);

/**
 * Select the knowledge one Delta packet carries.
 *
 * The rule, in order:
 *  1. PROJECT through `queryKnowledge` against the fresh snapshot — current vs
 *     invalidated-pending — and drop rejected statements outright.
 *  2. SCOPE to the changed files plus their 1-hop import neighbourhood (both
 *     directions: what they import and what imports them). A statement is kept
 *     when its subject or any evidence anchor is in that subgraph, or when it is
 *     repo-level (see {@link isRepoLevelSubject}).
 *  3. CAP at `cap` per list, and report what was dropped.
 *
 * Degradation is always toward MORE, never silently less: no usable import graph
 * ⇒ the full projected set (`projected-full`); no fresh snapshot ⇒ the stored set
 * unprojected minus rejected (`unprojected`). Either way `mode` and `note` say
 * which answer the packet actually got.
 *
 * Pure and deterministic: ordering is by statement id throughout, so the same
 * inputs produce byte-identical output.
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
  const isRejected = (statement: KnowledgeStatement): boolean => statement.status === "rejected";

  if (input.snapshot === null) {
    // No snapshot ⇒ no anchor can be resolved, so current and invalidated are
    // indistinguishable. Say that, rather than presenting the set as projected.
    const kept = (input.set?.statements ?? []).filter((s) => !isRejected(s)).sort(byId);
    const statements = kept.slice(0, cap);
    return {
      generator: input.set?.generator ?? null,
      baseOid: input.set?.baseOid ?? "",
      snapshotFingerprint: input.set?.snapshotFingerprint ?? "",
      mode: "unprojected",
      note: `No fresh project snapshot for this patchset, so statements are carried UNPROJECTED — an invalidated claim cannot be told from a current one here. Rejected statements are still dropped. ${inStore} statement(s) in the store; ask context.ask for anything not below.`,
      statements,
      invalidatedPending: [],
      counts: {
        inStore,
        rejected: inStore - kept.length,
        scopeFiles: 0,
        currentInScope: kept.length,
        pendingInScope: 0,
        truncated: kept.length - statements.length,
      },
    };
  }

  const snapshot = input.snapshot;
  const view = queryKnowledge(input.set, snapshot);
  const current = view.statements.filter((s) => !isRejected(s));
  const pending = view.invalidatedPending.filter((s) => !isRejected(s));
  const rejected =
    view.statements.length + view.invalidatedPending.length - (current.length + pending.length);

  // The 1-hop subgraph. `edges.length === 0` counts as no graph: a snapshot built
  // before the import shard existed resolves "ok" with nothing in it, and scoping
  // against an empty graph would silently offer a drafter almost nothing.
  const graph = queryImportGraph(snapshot);
  const scope =
    graph.ok && graph.graph.edges.length > 0
      ? (() => {
          const set = new Set(input.changedPaths);
          for (const path of input.changedPaths) {
            for (const neighbour of graph.graph.importsOf(path)) set.add(neighbour);
            for (const neighbour of graph.graph.importersOf(path)) set.add(neighbour);
          }
          return set;
        })()
      : null;

  const keep = (statement: KnowledgeStatement): boolean =>
    scope === null ? true : inScope(statement, scope, input.changedPaths, snapshot.scopes);
  const currentInScope = current.filter(keep);
  const pendingInScope = pending.filter(keep);
  const statements = currentInScope.slice(0, cap);
  const invalidatedPending = pendingInScope.slice(0, cap);
  const truncated =
    currentInScope.length - statements.length + (pendingInScope.length - invalidatedPending.length);

  const mode: KnowledgeScopeMode = scope === null ? "projected-full" : "import-graph";
  const note =
    scope === null
      ? `The import graph is unavailable for this snapshot (${graph.ok ? "no resolved import edges" : "import shard unavailable"}), so this is the FULL projected knowledge set rather than a scoped subset. ${inStore} statement(s) in the store; ask context.ask for anything not below.`
      : `Scoped by retrieval: the ${input.changedPaths.length} changed path(s) plus their 1-hop import neighbours (${scope.size} file(s)), and repo-level statements. ${inStore} statement(s) in the store, ${statements.length} offered below; ask context.ask for anything else you need.`;

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
      currentInScope: currentInScope.length,
      pendingInScope: pendingInScope.length,
      truncated,
    },
  };
}
