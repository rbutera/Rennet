/**
 * The DETERMINISTIC merge pass (context-map rebuild, W3 / Stage 3): a script, not a
 * seat, combining the partition workers' outputs.
 *
 * The seat it replaces was asked to re-adjudicate EVERY hypothesis the swarm minted
 * — on Rennet, ~1,900 of them in one prompt, which is the prompt that died with
 * "Prompt is too long" and discarded whole runs. Most of that adjudication was
 * mechanical: the same claim minted twice, an id collision, an import relation the
 * repository's own edge shard already answers. A model was being asked to check what
 * a script can check, and the volume of that checking is what broke the run.
 *
 * So this pass does the mechanical half and hands the seat only what is left:
 *
 *  - **Duplicate ids** collapse (a statement id is a hash of subject+aspect+claim+
 *    evidence, so two workers minting the same claim over the same evidence produce
 *    the same id).
 *  - **The same claim over different evidence** collapses to the BETTER-ANCHORED one
 *    — more anchors, then more line spans, then the lexicographically smaller id.
 *    Deterministic all the way down, because two runs of the same swarm must merge
 *    the same way.
 *  - **Import-shaped claims** are checked against the authoritative import graph. A
 *    claim asserting an import relation between two files it names or cites, where
 *    no resolved edge joins any pair of them, is FLAGGED — not deleted and not
 *    rewritten. The edge shard is textual and misses computed imports, so a
 *    contradiction is a reason for judgment, not a proof of error, and silently
 *    editing a model's claim would be the worst of both.
 *  - **Seams** are grouped once per source slice. Each group carries every active
 *    IMPORT cut endpoint, the worker's highest-ranked local statement, and at most
 *    one path-resolved non-import hint. The verifier sees the complete boundary
 *    without re-reading one residue item per local statement.
 *
 * Nothing here mints, and nothing here is provenance-bearing: every surviving
 * statement keeps the worker's own provenance, byte for byte.
 */

import type { KnowledgeStatement } from "@rennet/protocol";
import type { KnowledgeSnapshotContext } from "./mint";
import type { PartitionSlice, SliceImport } from "./partition";
import type { PartitionWorkerResult, WorkerCrossSliceHint, WorkerStatement } from "./swarm";

/** A statement the deterministic pass cannot settle, with the reason a seat must weigh. */
export interface FlaggedStatement {
  readonly statement: KnowledgeStatement;
  /** Model-facing: what the script found, in the words the verify prompt will use. */
  readonly reason: string;
}

/** One authoritative import edge crossing from this group's slice to another. */
export interface SeamCutEdge {
  readonly localPath: string;
  readonly offSlicePath: string;
}

/** One path-resolved hint with the local statement that made it actionable. */
export interface SeamGroupHint extends WorkerCrossSliceHint {
  readonly sourceStatement: KnowledgeStatement;
}

interface SeamGroupBase {
  readonly sourceSliceId: string;
  /** The worker ranked this local statement highest; it starts the seat's reading. */
  readonly leadStatement: KnowledgeStatement;
}

/** The bounded synthesis unit: one source slice, with every active far endpoint. */
export type SeamGroup =
  | (SeamGroupBase & {
      readonly kind: "cut";
      /** Every cut edge whose far endpoint another slice wrote about. */
      readonly cutEdges: readonly [SeamCutEdge, ...SeamCutEdge[]];
      /** At most one concrete non-import lead outside the slice. */
      readonly hint?: SeamGroupHint;
    })
  | (SeamGroupBase & {
      readonly kind: "hint";
      readonly cutEdges: readonly [];
      readonly hint: SeamGroupHint;
    });

export interface DeterministicMergeInput {
  /** The `ok` worker results. A failed worker contributes nothing and is not represented. */
  readonly workerResults: readonly PartitionWorkerResult[];
  /** The slices those workers ran, for membership and the cut-edge (neighbour) maps. */
  readonly slices: readonly PartitionSlice[];
  readonly snapshot: KnowledgeSnapshotContext;
  /**
   * The authoritative repo-wide import edges. ABSENT when the import graph could not
   * be read — in which case no claim is checked against it, because a graph nothing
   * could read contradicts nothing.
   */
  readonly importEdges?: readonly SliceImport[];
  /**
   * Prior statements whose cited evidence changed on a delta. Mechanically
   * unresolvable by definition (the bytes moved), so they go straight to the seat.
   */
  readonly reverify?: readonly KnowledgeStatement[];
}

export interface DeterministicMergeResult {
  /** Every surviving statement, deduped, in id order. Worker provenance untouched. */
  readonly statements: readonly KnowledgeStatement[];
  /** What the seat must judge: contradictions, plus a delta's changed-evidence statements. */
  readonly flagged: readonly FlaggedStatement[];
  /** Cross-batch synthesis work grouped once per source slice. */
  readonly seamGroups: readonly SeamGroup[];
  /** How many entries collapsed because two workers produced the SAME statement id. */
  readonly duplicateIds: number;
  /** How many collapsed because two workers made the same claim over different evidence. */
  readonly duplicateClaims: number;
}

function byString(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** One worker statement with the slice that produced it — the merge's unit of work. */
interface MergeRow {
  readonly sliceId: string;
  readonly entry: WorkerStatement;
  readonly rank: number;
}

/**
 * The composite-key separator: NUL, the one byte a path, a subject or a claim
 * cannot contain, so no printable separator can be forged inside a field to
 * collide two different keys.
 *
 * Built with `String.fromCharCode`, not written into a literal. A literal NUL makes
 * this whole file BINARY to git — undiffable in review, which is how three of them
 * survived here unnoticed — and the escape form is one careless copy away from
 * becoming one again.
 */
const KEY_SEPARATOR = String.fromCharCode(0);

/**
 * `subject`, `aspect`, `claim` joined by {@link KEY_SEPARATOR} — the same claim
 * regardless of what it was anchored to.
 */
function claimKey(statement: KnowledgeStatement): string {
  return [statement.subject, statement.aspect, statement.claim].join(KEY_SEPARATOR);
}

/**
 * Which of two statements of the SAME claim is better anchored: more evidence
 * anchors, then more anchors carrying a line span, then the smaller id.
 *
 * The last tiebreak is not decoration — without it the winner would depend on which
 * worker happened to finish first, and two runs of one swarm would produce different
 * sets from identical inputs.
 */
function betterAnchored(left: KnowledgeStatement, right: KnowledgeStatement): KnowledgeStatement {
  const spans = (statement: KnowledgeStatement): number =>
    statement.evidence.filter((anchor) => anchor.lines !== undefined).length;
  if (left.evidence.length !== right.evidence.length) {
    return left.evidence.length > right.evidence.length ? left : right;
  }
  if (spans(left) !== spans(right)) return spans(left) > spans(right) ? left : right;
  return byString(left.id, right.id) <= 0 ? left : right;
}

/**
 * Claim text that ASSERTS an import relation. Deliberately narrow: these are the
 * verbs the repository's own edge shard can speak to. "uses", "wraps", "is built on"
 * are real relationships the import graph has no opinion about, so they are not here.
 */
const IMPORT_ASSERTION =
  /\b(imports?|importing|imported\s+by|re-?exports?|depends\s+(?:directly\s+)?on|dependency\s+of)\b/i;

/**
 * The inventory paths an import-shaped claim identifies as its ENDPOINTS: every
 * path named in its own words (subject + claim), plus every path it cites as
 * evidence. Sorted, distinct.
 *
 * Prose alone was too narrow to catch the claim shape workers actually emit. "This
 * module imports the store" names one path in words and cites the other as
 * evidence, which is two resolvable endpoints and an assertion the edge shard can
 * answer — and it went unchecked, because only the prose was read.
 *
 * THE CEILING, stated rather than implied: a claim whose second endpoint is neither
 * written down nor cited stays unchecked and stays a hypothesis. That is deliberate.
 * Guessing the other end from a bare module name would put unresolvable assertions
 * in front of the verify seat by the hundred, and a residue nobody can adjudicate is
 * worse than a claim nobody checked.
 */
function importEndpoints(statement: KnowledgeStatement, inventory: ReadonlySet<string>): string[] {
  const named = new Set<string>();
  for (const token of `${statement.subject} ${statement.claim}`.split(/[\s,;:()[\]{}"'`]+/)) {
    // Trim sentence punctuation a path can pick up in prose: `src/a.ts.` / `src/a.ts,`.
    const trimmed = token.replace(/[.,;:!?]+$/, "");
    if (inventory.has(trimmed)) named.add(trimmed);
    else if (inventory.has(token)) named.add(token);
  }
  for (const anchor of statement.evidence) if (inventory.has(anchor.path)) named.add(anchor.path);
  return [...named].sort(byString);
}

/**
 * Run the deterministic merge. Pure: same worker outputs, same result, every time.
 */
export function mergeWorkerResults(input: DeterministicMergeInput): DeterministicMergeResult {
  // Iterate in a fixed order — (sliceId, statement id) — so every "keep the first"
  // below is a decision about the inputs, not about which promise settled first.
  const entries: MergeRow[] = [];
  for (const result of [...input.workerResults].sort((a, b) => byString(a.sliceId, b.sliceId))) {
    if (result.status !== "ok") continue;
    const ranked = result.statements.map((entry, rank) => ({
      sliceId: result.sliceId,
      entry,
      rank,
    }));
    for (const row of ranked.sort((a, b) => byString(a.entry.statement.id, b.entry.statement.id))) {
      entries.push(row);
    }
  }

  // 1. Duplicate ids: the same claim over the same evidence, minted twice.
  const byId = new Map<string, MergeRow>();
  let duplicateIds = 0;
  for (const row of entries) {
    if (byId.has(row.entry.statement.id)) duplicateIds += 1;
    else byId.set(row.entry.statement.id, row);
  }

  // 2. The same claim over DIFFERENT evidence: keep the better-anchored one.
  const byClaim = new Map<string, MergeRow>();
  let duplicateClaims = 0;
  for (const row of byId.values()) {
    const key = claimKey(row.entry.statement);
    const held = byClaim.get(key);
    if (held === undefined) {
      byClaim.set(key, row);
      continue;
    }
    duplicateClaims += 1;
    const winner = betterAnchored(held.entry.statement, row.entry.statement);
    if (winner !== held.entry.statement) byClaim.set(key, row);
  }
  const kept = [...byClaim.values()].sort((a, b) =>
    byString(a.entry.statement.id, b.entry.statement.id),
  );

  // 3. Import-shaped claims the authoritative edge shard contradicts.
  const flagged: FlaggedStatement[] = [];
  if (input.importEdges !== undefined) {
    const inventory = new Set(input.snapshot.files.map((file) => file.path));
    const edges = new Set(
      input.importEdges.map((edge) => `${edge.from}${KEY_SEPARATOR}${edge.to}`),
    );
    for (const row of kept) {
      const statement = row.entry.statement;
      if (!IMPORT_ASSERTION.test(statement.claim)) continue;
      const endpoints = importEndpoints(statement, inventory);
      // Fewer than two resolvable endpoints names no relation, so there is nothing
      // to contradict — and nothing a seat could adjudicate. See importEndpoints.
      if (endpoints.length < 2) continue;
      const joined = endpoints.some((from) =>
        endpoints.some((to) => from !== to && edges.has(`${from}${KEY_SEPARATOR}${to}`)),
      );
      if (joined) continue;
      flagged.push({
        statement,
        reason: `no resolved import edge joins the files this claim names or cites (${endpoints.join(", ")}); the import index is textual, so a computed or dynamic import would look exactly like this`,
      });
    }
  }

  // A delta's changed-evidence statements are judgment by construction — EXCEPT
  // where a worker in THIS run re-minted the identical claim over identical
  // evidence. A statement id hashes its anchors' blobOids, so an id collision here
  // means a worker read the current bytes and said the same thing: nothing is stale
  // and the FRESH mint is the one that survives, with its own provenance. The prior
  // used to be appended straight past the id map, which put two copies of one claim
  // in the set and sent the seat a residue entry about bytes just re-read.
  const keptIds = new Set(kept.map((row) => row.entry.statement.id));
  const reverify = [...(input.reverify ?? [])]
    .filter((statement) => !keptIds.has(statement.id))
    .sort((a, b) => byString(a.id, b.id));
  for (const statement of reverify) {
    flagged.push({
      statement,
      // The span disclosure is unconditional, and that is the honest shape: this pass
      // sees the RE-ANCHORED statement, not the pair, so it cannot tell an anchor
      // whose span was just dropped from one that never carried a span. Saying "a
      // span you see is current, and an absent one may have been dropped" is true of
      // every entry here; naming only some of them would need `planReverify` to
      // report which, for a sentence the seat should act on either way.
      reason:
        "a prior statement whose cited evidence changed at this baseline; its anchors were re-stamped to the new blobs and any line span on a moved anchor was DROPPED as stale — re-read the cited file rather than trusting a span",
    });
  }

  const seamGroups = groupSeams(entries, input.slices, input.snapshot, input.importEdges);
  return {
    statements: [...kept.map((row) => row.entry.statement), ...reverify].sort((a, b) =>
      byString(a.id, b.id),
    ),
    flagged,
    seamGroups,
    duplicateIds,
    duplicateClaims,
  };
}

/**
 * `path → the paths a CUT import edge joins it to` — an edge whose two ends are
 * owned by two DIFFERENT slices.
 *
 * Derived from the AUTHORITATIVE edge list plus slice ownership when the graph was
 * readable, and only from the slices' own neighbour maps when it was not.
 *
 * The neighbour map cannot be the source of truth here, obvious though it looks. It
 * is capped at `NEIGHBOR_CAP` entries per member for PROMPT SIZE — a hub file's
 * fifty-first neighbour is dropped from the packet on purpose — and a seam derived
 * from it silently inherits that cap. A claim connected through a discarded edge is
 * then neither seam nor flag: it never reaches the verify seat, and nothing reports
 * the loss. The whole edge list is already in hand at merge time
 * ({@link DeterministicMergeInput.importEdges}), so seam detection reads that and
 * the cap stays where it belongs — on the worker packet.
 */
function cutEdgeMap(
  slices: readonly PartitionSlice[],
  importEdges: readonly SliceImport[] | undefined,
): ReadonlyMap<string, readonly string[]> {
  const joined = new Map<string, Set<string>>();
  const link = (from: string, to: string): void => {
    const row = joined.get(from);
    if (row === undefined) joined.set(from, new Set([to]));
    else row.add(to);
  };
  if (importEdges === undefined) {
    // Degraded: the packets' capped view is all there is. Same shape, smaller truth.
    for (const slice of slices) {
      for (const member of slice.neighbors) {
        for (const neighbor of member.neighbors) link(member.path, neighbor.path);
      }
    }
  } else {
    const ownerOf = new Map<string, string>();
    for (const slice of slices) for (const file of slice.files) ownerOf.set(file.path, slice.id);
    for (const edge of importEdges) {
      const from = ownerOf.get(edge.from);
      const to = ownerOf.get(edge.to);
      // An edge to a path no slice in this run owns was not cut by the batching; on
      // a delta it simply was not partitioned this time round.
      if (from === undefined || to === undefined || from === to) continue;
      link(edge.from, edge.to);
      link(edge.to, edge.from);
    }
  }
  return new Map([...joined].map(([path, row]) => [path, [...row].sort(byString)]));
}

/**
 * Cross-batch synthesis work grouped once per source slice.
 *
 * A worker can only cite files in its own slice (anchor-or-drop enforces that at
 * mint), so no worker statement's evidence ever spans two batches — the synthesis
 * job is not "find the statements that already span", it is "preserve every cut
 * endpoint whose two sides were written about, then read those endpoints together".
 *
 * WHAT THIS SIGNAL IS, exactly, because the name promises more than it delivers:
 * the seam signal is IMPORT CUT EDGES and nothing else ({@link cutEdgeMap}). Two
 * batches related by something the import graph cannot see — a shared convention, a
 * protocol both ends implement, a runtime registration — produce no cut seam here.
 * The escape hatch is one structured worker hint naming a concrete off-slice path
 * and the unresolved coupling. It is not a completeness claim about relationships
 * the workers did not identify.
 *
 * PRE-DEDUPE ORIGINS decide it. Two workers on opposite ends of one cut edge often
 * mint the SAME claim, and step 2 may collapse one. Groups therefore read pre-dedupe
 * origins. The lead statement also comes from that original ranked order, so claim
 * dedupe cannot erase a slice's orientation.
 */
function groupSeams(
  origins: readonly MergeRow[],
  slices: readonly PartitionSlice[],
  snapshot: KnowledgeSnapshotContext,
  importEdges: readonly SliceImport[] | undefined,
): readonly SeamGroup[] {
  // path → the slices whose statements cite it, from the pre-dedupe origins: a
  // collapsed twin still proves its slice wrote about its end of the edge.
  const citedBy = new Map<string, Set<string>>();
  for (const row of origins) {
    for (const anchor of row.entry.statement.evidence) {
      const owners = citedBy.get(anchor.path);
      if (owners === undefined) citedBy.set(anchor.path, new Set([row.sliceId]));
      else owners.add(row.sliceId);
    }
  }

  const cutNeighbors = cutEdgeMap(slices, importEdges);
  const sliceById = new Map(slices.map((slice) => [slice.id, slice]));
  const inventory = new Set(snapshot.files.map((file) => file.path));
  const actionableHint = (row: MergeRow): WorkerCrossSliceHint | undefined => {
    const hint = row.entry.hint;
    const slice = sliceById.get(row.sliceId);
    if (
      hint === undefined ||
      slice === undefined ||
      !inventory.has(hint.path) ||
      slice.files.some((file) => file.path === hint.path) ||
      hint.coupling.trim().length === 0
    ) {
      return;
    }
    return hint;
  };

  const rankedOrigins = [...origins].sort(
    (a, b) =>
      byString(a.sliceId, b.sliceId) ||
      a.rank - b.rank ||
      byString(a.entry.statement.id, b.entry.statement.id) ||
      byString(a.entry.hint?.path ?? "", b.entry.hint?.path ?? "") ||
      byString(a.entry.hint?.coupling ?? "", b.entry.hint?.coupling ?? ""),
  );
  const anchorBySlice = new Map<string, KnowledgeStatement>();
  const hintBySlice = new Map<string, SeamGroupHint>();
  const edgesBySlice = new Map<string, Map<string, SeamCutEdge>>();
  for (const row of rankedOrigins) {
    if (!anchorBySlice.has(row.sliceId)) anchorBySlice.set(row.sliceId, row.entry.statement);
    const hint = actionableHint(row);
    if (hint !== undefined && !hintBySlice.has(row.sliceId)) {
      hintBySlice.set(row.sliceId, { ...hint, sourceStatement: row.entry.statement });
    }
    for (const anchor of row.entry.statement.evidence) {
      for (const offSlicePath of cutNeighbors.get(anchor.path) ?? []) {
        const owners = citedBy.get(offSlicePath);
        if (owners === undefined) continue;
        let hasOtherOwner = false;
        for (const owner of owners) {
          if (owner === row.sliceId) continue;
          hasOtherOwner = true;
          break;
        }
        if (!hasOtherOwner) continue;
        const edge: SeamCutEdge = { localPath: anchor.path, offSlicePath };
        const key = `${edge.localPath}${KEY_SEPARATOR}${edge.offSlicePath}`;
        const held = edgesBySlice.get(row.sliceId);
        if (held === undefined) edgesBySlice.set(row.sliceId, new Map([[key, edge]]));
        else held.set(key, edge);
      }
    }
  }

  const groupIds = new Set([...edgesBySlice.keys(), ...hintBySlice.keys()]);
  const groups = [...groupIds].sort(byString).flatMap((sliceId): SeamGroup[] => {
    const leadStatement = anchorBySlice.get(sliceId);
    if (leadStatement === undefined) return [];
    const cutEdges = [...(edgesBySlice.get(sliceId)?.values() ?? [])].sort(
      (a, b) => byString(a.localPath, b.localPath) || byString(a.offSlicePath, b.offSlicePath),
    );
    const hint = hintBySlice.get(sliceId);
    if (cutEdges.length === 0) {
      return hint === undefined
        ? []
        : [{ kind: "hint", sourceSliceId: sliceId, leadStatement, cutEdges: [], hint }];
    }
    const [first, ...rest] = cutEdges;
    if (first === undefined) return [];
    return [
      {
        kind: "cut",
        sourceSliceId: sliceId,
        leadStatement,
        cutEdges: [first, ...rest],
        ...(hint === undefined ? {} : { hint }),
      },
    ];
  });

  return groups;
}
