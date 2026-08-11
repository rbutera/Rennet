import { normalizeQuote, sha256Hex } from "@rennet/protocol";
import type { Lineage, LineageEntry } from "@rennet/types";

// ── The lineage matcher (issue #16, pre-build spike 1) ───────────────────────
//
// Frozen contract, Architecture Contracts §3.4 and R8: an `Occurrence` is
// patchset-scoped and immutable; lineage edges are `exact`, `one-to-one`,
// `move`, `split`, `merge`, `ambiguous`, or `terminated`. Occurrence IDENTITY is
// the immutable id minted by deterministic ingest — path, symbol and content
// hashes are DEMOTED to weighted EVIDENCE for mapping an id forward across a
// patchset boundary, never identity themselves. "Only an exact, byte-identical
// occurrence with matching contextual disambiguators may carry analysis and read
// state automatically. Similarity is evidence for a possible continuation, never
// identity. A changed, split, merged, or ambiguous occurrence reopens for review.
// Ambiguity fails closed."
//
// This module is the PRODUCER of the lineage graph that `resolveAnchor`
// (`@rennet/protocol`) already consumes: it takes the prior and successor
// occurrence sets and emits the classified `LineageEntry[]`. It is pure — no
// model, no I/O — so it runs standalone in CI and its precision is measurable
// (see `lineage-matcher.measurement.test.ts` + the verdict doc under `docs/`).
//
// The stakes are asymmetric. A WRONG auto-carry means review state is silently
// carried onto the wrong code — the product's worst failure. So the classifier
// is built to fail CLOSED: any residual ambiguity a single confident answer
// cannot survive is reported as `ambiguous`, and the auto-carry policy
// (`autoCarries`) is set from the MEASURED precision, never from assumption.

/**
 * One occurrence offered to the matcher. `id` is the immutable identity;
 * everything else is EVIDENCE the matcher weighs to map an id forward. `body` is
 * the occurrence's own source text (the strongest evidence when byte-identical);
 * `path`/`symbol` are demoted structural evidence; `context` is the surrounding
 * source (a few lines each side) — the disambiguator that separates N identical
 * bodies into N identities.
 */
export interface MatchOccurrence {
  readonly id: string;
  readonly path: string;
  readonly symbol?: string;
  readonly body: string;
  readonly context?: string;
}

/** The weighted evidence behind one candidate (prior → successor) edge. */
export interface EvidenceBreakdown {
  /** Raw byte-identical bodies (the only basis an `exact`/`move` may rest on). */
  readonly contentExact: boolean;
  /** Normalised-body similarity in [0,1] (1 ⟺ identical after CRLF/trailing-ws). */
  readonly content: number;
  /** Path evidence in [0,1]: same path → 1, same basename → 0.5, else 0. */
  readonly path: number;
  /** Symbol evidence in [0,1]: same non-empty symbol → 1, else 0. */
  readonly symbol: number;
  /** Context (surrounding-source) similarity in [0,1] — the tie-breaker. */
  readonly context: number;
  /** The weighted total in [0,1] the matching maximises. */
  readonly score: number;
}

/**
 * One prior occurrence's forward classification. `toId` is the single successor
 * for `exact`/`one-to-one`/`move`/`merge`; `toIds` the members for `split`;
 * both absent for `terminated`. `ambiguous` may carry `toId` (the near-tie the
 * matching happened to pick) purely for surfacing — it NEVER auto-carries.
 */
export interface LineageClassification {
  readonly fromId: string;
  readonly lineage: Lineage;
  readonly toId?: string;
  readonly toIds?: readonly string[];
  /** The matched edge's score, or the top competing score for a terminated id. */
  readonly confidence: number;
  readonly evidence?: EvidenceBreakdown;
}

/** The full matcher output. */
export interface MatchResult {
  /** One entry per prior occurrence, in prior order. */
  readonly classifications: readonly LineageClassification[];
  /** Successor ids with no prior antecedent (newly added occurrences). */
  readonly added: readonly string[];
  /** The `@rennet/types` lineage graph — the substrate `resolveAnchor` reads. */
  readonly lineage: readonly LineageEntry[];
}

/**
 * Evidence weights. Content dominates because a byte-identical body is the
 * strongest continuation signal; context is the second-largest because it is the
 * disambiguator that must out-vote path/symbol among identical bodies; path and
 * symbol are demoted structural evidence. Summing to 1 keeps `score` in [0,1].
 */
const WEIGHTS = { content: 0.6, context: 0.2, path: 0.15, symbol: 0.05 } as const;

/**
 * A candidate edge below this weighted score is not evidence of continuation at
 * all — the pair is treated as unmatched. Deliberately low: it only rejects
 * pairs that share almost nothing, so the CLASSIFICATION (not this floor) is what
 * decides carry.
 */
const MATCH_FLOOR = 0.28;

/**
 * Two candidate successors whose scores differ by less than this are an
 * effective TIE the matcher cannot defensibly break — the match is reported
 * `ambiguous` and fails closed. This is the guard that protects `move`
 * precision: a body duplicated across files whose context also ties is ambiguous,
 * never a confident move.
 */
const TIE_EPSILON = 0.06;

/**
 * A split member (one of several successors a prior fans out into) or a merge
 * member (one of several priors that fold into a successor) must share at least
 * this much NORMALISED-CONTENT similarity with the parent. Higher than the match
 * floor: a split piece is a genuine slice of the original, not a faint echo.
 */
const FANOUT_CONTENT_FLOOR = 0.34;

/**
 * The discriminator between a SPLIT and an AMBIGUOUS/duplicate fan-out. When one
 * prior covers several successors, they are split PIECES only if they are
 * mutually DISTINCT (each ≤ this similar to the matched piece) — a genuine
 * division of the parent. Successors that are near-duplicates of each other are
 * competing copies, not slices: they never form a split, and a near-tie among
 * them is `ambiguous` (fail closed), never a confident continuation.
 */
const SPLIT_DISTINCT_MAX = 0.6;

/** Repo-relative basename, for the same-basename path-evidence tier. */
function basename(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? path : path.slice(cut + 1);
}

/** The normalised non-empty line multiset of a blob (CRLF/trailing-ws folded). */
function lineBag(text: string): string[] {
  return normalizeQuote(text)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * Sørensen–Dice similarity over the multiset of normalised non-empty lines, in
 * [0,1]. Order-insensitive and cheap — robust for code, where an edit reorders
 * or touches a few lines. Two empty bags are treated as identical (1): an empty
 * body that persists is a continuation, not a non-match.
 */
function lineSimilarity(a: string, b: string): number {
  const bagA = lineBag(a);
  const bagB = lineBag(b);
  if (bagA.length === 0 && bagB.length === 0) return 1;
  if (bagA.length === 0 || bagB.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const line of bagA) counts.set(line, (counts.get(line) ?? 0) + 1);
  let intersection = 0;
  for (const line of bagB) {
    const remaining = counts.get(line);
    if (remaining && remaining > 0) {
      intersection += 1;
      counts.set(line, remaining - 1);
    }
  }
  return (2 * intersection) / (bagA.length + bagB.length);
}

/** Context similarity in [0,1]; absent context on either side is neutral (0). */
function contextSimilarity(a: MatchOccurrence, b: MatchOccurrence): number {
  if (a.context === undefined || b.context === undefined) return 0;
  return lineSimilarity(a.context, b.context);
}

/** Compute the full evidence breakdown for one prior → successor pair. */
function evidenceFor(prior: MatchOccurrence, successor: MatchOccurrence): EvidenceBreakdown {
  const contentExact = sha256Hex(prior.body) === sha256Hex(successor.body);
  const content = contentExact ? 1 : lineSimilarity(prior.body, successor.body);
  const path =
    prior.path === successor.path ? 1 : basename(prior.path) === basename(successor.path) ? 0.5 : 0;
  const symbol =
    prior.symbol !== undefined && prior.symbol.length > 0 && prior.symbol === successor.symbol
      ? 1
      : 0;
  const context = contextSimilarity(prior, successor);
  const score =
    WEIGHTS.content * content +
    WEIGHTS.path * path +
    WEIGHTS.symbol * symbol +
    WEIGHTS.context * context;
  return { contentExact, content, path, symbol, context, score };
}

/**
 * Max-weight bipartite matching (the assignment problem) by the Kuhn–Munkres /
 * Hungarian algorithm on a padded square cost matrix. Returns, for each row
 * (prior), the matched column (successor) or -1 when the best assignment for
 * that row scores below `floor` (a pad or a sub-floor pairing is not a match).
 *
 * The global optimum is what makes the "twelve identical bodies" case resolve
 * correctly: content ties at 1 for every pair, so the assignment that maximises
 * the TOTAL score is the one that pairs each body with its own context/path —
 * a greedy or first-fit matcher would collapse them onto one successor.
 */
export function maxWeightMatching(scores: readonly (readonly number[])[], floor: number): number[] {
  const rows = scores.length;
  const cols = rows === 0 ? 0 : scores[0]!.length;
  const n = Math.max(rows, cols);
  if (n === 0) return [];
  // Cost = -score, padded to n×n with 0 (a pad edge scores 0 and is filtered out
  // below). Hungarian minimises cost ⟺ maximises score.
  const cost: number[][] = [];
  for (let r = 0; r < n; r += 1) {
    const row: number[] = [];
    for (let c = 0; c < n; c += 1) {
      const s = r < rows && c < cols ? scores[r]![c]! : 0;
      row.push(-s);
    }
    cost.push(row);
  }

  // Kuhn–Munkres with potentials (O(n^3)). `columnMatchRow[c]` = the row matched
  // to column c (0-based; -1 unmatched). Standard 1-indexed potential arrays.
  const INF = Number.POSITIVE_INFINITY;
  const potentialRow = new Array<number>(n + 1).fill(0);
  const potentialCol = new Array<number>(n + 1).fill(0);
  const columnMatchRow = new Array<number>(n + 1).fill(0);
  for (let r = 1; r <= n; r += 1) {
    columnMatchRow[0] = r;
    let currentCol = 0;
    const minSlack = new Array<number>(n + 1).fill(INF);
    const slackFromCol = new Array<number>(n + 1).fill(0);
    const used = new Array<boolean>(n + 1).fill(false);
    do {
      used[currentCol] = true;
      const currentRow = columnMatchRow[currentCol]!;
      let delta = INF;
      let nextCol = -1;
      for (let c = 1; c <= n; c += 1) {
        if (used[c]) continue;
        const reduced =
          cost[currentRow - 1]![c - 1]! - potentialRow[currentRow]! - potentialCol[c]!;
        if (reduced < minSlack[c]!) {
          minSlack[c] = reduced;
          slackFromCol[c] = currentCol;
        }
        if (minSlack[c]! < delta) {
          delta = minSlack[c]!;
          nextCol = c;
        }
      }
      for (let c = 0; c <= n; c += 1) {
        if (used[c]) {
          potentialRow[columnMatchRow[c]!] += delta;
          potentialCol[c] -= delta;
        } else {
          minSlack[c]! -= delta;
        }
      }
      currentCol = nextCol;
    } while (columnMatchRow[currentCol] !== 0);
    // Augment along the alternating path.
    while (currentCol !== 0) {
      const previousCol = slackFromCol[currentCol]!;
      columnMatchRow[currentCol] = columnMatchRow[previousCol]!;
      currentCol = previousCol;
    }
  }

  const rowMatch = new Array<number>(rows).fill(-1);
  for (let c = 1; c <= n; c += 1) {
    const r = columnMatchRow[c]! - 1;
    const col = c - 1;
    if (r >= 0 && r < rows && col < cols) {
      // Filter pad edges and any assignment that scored below the floor.
      if (scores[r]![col]! >= floor) rowMatch[r] = col;
    }
  }
  return rowMatch;
}

/**
 * Classify each prior occurrence's forward lineage against the successor set.
 *
 * Pipeline: (1) score every prior→successor pair; (2) global max-weight 1:1
 * matching; (3) detect split/merge from strong residual edges around the matched
 * pairs; (4) classify each 1:1 pair as exact / move / one-to-one, downgrading any
 * effective near-tie to `ambiguous` (fail closed); (5) unmatched priors with no
 * viable candidate are `terminated`.
 */
export function classifyLineage(
  prior: readonly MatchOccurrence[],
  successor: readonly MatchOccurrence[],
): MatchResult {
  const evidence: EvidenceBreakdown[][] = prior.map((p) => successor.map((s) => evidenceFor(p, s)));
  const scores = evidence.map((row) => row.map((e) => e.score));
  const match = maxWeightMatching(scores, MATCH_FLOOR);

  // Which successors are the 1:1 partner of some prior (claimed by the matching).
  const successorClaimedBy = new Array<number>(successor.length).fill(-1);
  match.forEach((col, row) => {
    if (col >= 0) successorClaimedBy[col] = row;
  });

  // Merge groups: several DISTINCT priors folding into one successor. For a
  // matched successor, gather every OTHER unmatched prior that is a genuine slice
  // of it (content ≥ fanout floor, that successor its own strongest destination).
  // Guarded so a byte-exact 1:1 owner is never treated as a merge — an exact prior
  // continued whole, it did not fold.
  const mergePartnersByPrior = new Map<number, number>(); // prior → successor it merges into
  for (let s = 0; s < successor.length; s += 1) {
    const anchorPrior = successorClaimedBy[s];
    if (anchorPrior === -1) continue;
    if (evidence[anchorPrior]![s]!.contentExact) continue; // a whole-survivor is not a merge
    const folders: number[] = [anchorPrior];
    for (let p = 0; p < prior.length; p += 1) {
      if (p === anchorPrior) continue;
      if (match[p]! >= 0) continue; // a prior with its own 1:1 partner is not merging here
      const e = evidence[p]![s]!;
      const best = Math.max(...evidence[p]!.map((x) => x.score));
      if (e.content >= FANOUT_CONTENT_FLOOR && e.score >= best - TIE_EPSILON) folders.push(p);
    }
    if (folders.length >= 2) for (const p of folders) mergePartnersByPrior.set(p, s);
  }

  const classifications: LineageClassification[] = prior.map((p, row) => {
    const col = match[row]!;

    // Merge: this prior folds into a shared successor.
    const mergeInto = mergePartnersByPrior.get(row);
    if (mergeInto !== undefined) {
      const e = evidence[row]![mergeInto]!;
      return { fromId: p.id, lineage: "merge", toId: successor[mergeInto]!.id, confidence: e.score, evidence: e };
    }

    if (col < 0) {
      // No viable partner: terminated. Confidence carries the top rejected score.
      const top = evidence[row]!.reduce((m, e) => Math.max(m, e.score), 0);
      return { fromId: p.id, lineage: "terminated", confidence: top };
    }

    const e = evidence[row]![col]!;
    const matchedBody = successor[col]!.body;

    // Split: the prior fans out into the matched successor plus other unclaimed
    // successors that are DISTINCT slices of it (mutually dissimilar). Duplicate
    // copies of the matched body are excluded here — they route to the ambiguity
    // guard below. A byte-exact 1:1 never splits (the whole thing survived).
    if (!e.contentExact) {
      const members: number[] = [col];
      for (let s = 0; s < successor.length; s += 1) {
        if (s === col) continue;
        if (successorClaimedBy[s] !== -1) continue; // claimed by another prior's 1:1
        if (evidence[row]![s]!.content < FANOUT_CONTENT_FLOOR) continue;
        if (lineSimilarity(matchedBody, successor[s]!.body) <= SPLIT_DISTINCT_MAX) members.push(s);
      }
      if (members.length >= 2) {
        return {
          fromId: p.id,
          lineage: "split",
          toIds: members.map((s) => successor[s]!.id),
          confidence: e.score,
          evidence: e,
        };
      }
    }

    // Ambiguity guard (fail closed): a competing successor within TIE_EPSILON of
    // the matched score — a near-tie the matcher cannot defensibly separate (the
    // duplicate-body case that would otherwise be a false `move`).
    const rival = evidence[row]!.some(
      (other, s) => s !== col && other.score >= e.score - TIE_EPSILON && other.score >= MATCH_FLOOR,
    );
    if (rival) {
      return { fromId: p.id, lineage: "ambiguous", toId: successor[col]!.id, confidence: e.score, evidence: e };
    }

    // 1:1 pair. Exact iff byte-identical body; the path splits exact vs move.
    if (e.contentExact) {
      const lineage: Lineage = p.path === successor[col]!.path ? "exact" : "move";
      return { fromId: p.id, lineage, toId: successor[col]!.id, confidence: e.score, evidence: e };
    }
    // Changed body, confident single continuation → reopens for review.
    return { fromId: p.id, lineage: "one-to-one", toId: successor[col]!.id, confidence: e.score, evidence: e };
  });

  // Successors that no prior maps to (1:1, split member, or merge target) are new.
  const reached = new Set<string>();
  for (const c of classifications) {
    if (c.toId) reached.add(c.toId);
    for (const id of c.toIds ?? []) reached.add(id);
  }
  const added = successor.filter((s) => !reached.has(s.id)).map((s) => s.id);

  const lineage: LineageEntry[] = classifications.flatMap((c) => {
    if (c.lineage === "terminated") return [{ fromId: c.fromId, lineage: "terminated" as Lineage }];
    if (c.lineage === "split") {
      // Split is represented as one entry per member so the graph stays flat; a
      // split fromId never carries state (§3.4) regardless of member count.
      return (c.toIds ?? []).map((toId) => ({ fromId: c.fromId, lineage: "split" as Lineage, toId }));
    }
    return [{ fromId: c.fromId, lineage: c.lineage, ...(c.toId ? { toId: c.toId } : {}) }];
  });

  return { classifications, added, lineage };
}

/**
 * The calibrated auto-carry policy (issue #16). CALIBRATED FROM MEASUREMENT
 * (`lineage-matcher.measurement.test.ts` + `docs/Rennet Lineage Matcher
 * Verdict.md`), never assumption. Only classifications proven at ~100% precision
 * auto-carry read state and dispositions; everything else fails closed and
 * reopens (a changed occurrence) or orphans (a vanished one).
 *
 * The measured verdict: `exact` carries (byte-identical, precision 100% by
 * construction). `move` carries ONLY as a UNIQUE, contextually-disambiguated
 * match — the matcher already downgrades a non-unique / context-tied identical
 * body to `ambiguous`, so a surviving `move` is exactly the safe case. Every
 * other class (`one-to-one`, `split`, `merge`, `ambiguous`, `terminated`) does
 * NOT auto-carry.
 */
export const AUTO_CARRY_LINEAGES: ReadonlySet<Lineage> = new Set<Lineage>(["exact", "move"]);

/** Whether a classification's lineage auto-carries read state / dispositions. */
export function autoCarries(lineage: Lineage): boolean {
  return AUTO_CARRY_LINEAGES.has(lineage);
}
