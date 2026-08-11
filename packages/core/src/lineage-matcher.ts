import { normalizeQuote, sha256Hex } from "@rennet/protocol";
import { AUTO_CARRY_LINEAGES, autoCarries, type Lineage, type LineageEntry } from "@rennet/types";

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
  const firstRow = scores[0];
  const cols = firstRow ? firstRow.length : 0;
  const n = Math.max(rows, cols);
  if (n === 0) return [];
  // Flattened cost = -score, padded to n×n with 0 (a pad edge scores 0 and is
  // filtered out below). Hungarian minimises cost ⟺ maximises score. Every index
  // here is in bounds by construction; reads use `?? fallback` so the O(n^3) loops
  // satisfy `noUncheckedIndexedAccess` without non-null assertions.
  const INF = Number.POSITIVE_INFINITY;
  const cost = new Float64Array(n * n);
  for (let r = 0; r < rows; r += 1) {
    const scoreRow = scores[r];
    if (!scoreRow) continue;
    for (let c = 0; c < cols; c += 1) {
      const s = scoreRow[c];
      cost[r * n + c] = s === undefined ? 0 : -s;
    }
  }

  // Kuhn–Munkres with potentials (O(n^3)). `columnMatchRow[c]` = the row matched
  // to column c (1-indexed; 0 unmatched). Standard 1-indexed potential arrays.
  const potentialRow = new Float64Array(n + 1);
  const potentialCol = new Float64Array(n + 1);
  const columnMatchRow = new Int32Array(n + 1);
  for (let r = 1; r <= n; r += 1) {
    columnMatchRow[0] = r;
    let currentCol = 0;
    const minSlack = new Float64Array(n + 1).fill(INF);
    const slackFromCol = new Int32Array(n + 1);
    const used = new Uint8Array(n + 1);
    do {
      used[currentCol] = 1;
      const currentRow = columnMatchRow[currentCol] ?? 0;
      const rowBase = (currentRow - 1) * n;
      const pr = potentialRow[currentRow] ?? 0;
      let delta = INF;
      let nextCol = -1;
      for (let c = 1; c <= n; c += 1) {
        if (used[c]) continue;
        const reduced = (cost[rowBase + (c - 1)] ?? 0) - pr - (potentialCol[c] ?? 0);
        if (reduced < (minSlack[c] ?? INF)) {
          minSlack[c] = reduced;
          slackFromCol[c] = currentCol;
        }
        const slackC = minSlack[c] ?? INF;
        if (slackC < delta) {
          delta = slackC;
          nextCol = c;
        }
      }
      for (let c = 0; c <= n; c += 1) {
        if (used[c]) {
          const matchedRow = columnMatchRow[c] ?? 0;
          potentialRow[matchedRow] = (potentialRow[matchedRow] ?? 0) + delta;
          potentialCol[c] = (potentialCol[c] ?? 0) - delta;
        } else {
          minSlack[c] = (minSlack[c] ?? INF) - delta;
        }
      }
      currentCol = nextCol;
    } while ((columnMatchRow[currentCol] ?? 0) !== 0);
    // Augment along the alternating path.
    while (currentCol !== 0) {
      const previousCol = slackFromCol[currentCol] ?? 0;
      columnMatchRow[currentCol] = columnMatchRow[previousCol] ?? 0;
      currentCol = previousCol;
    }
  }

  const rowMatch = new Array<number>(rows).fill(-1);
  for (let c = 1; c <= n; c += 1) {
    const r = (columnMatchRow[c] ?? 0) - 1;
    const col = c - 1;
    if (r >= 0 && r < rows && col < cols) {
      const scoreRow = scores[r];
      const s = scoreRow ? scoreRow[col] : undefined;
      // Filter pad edges and any assignment that scored below the floor.
      if (s !== undefined && s >= floor) rowMatch[r] = col;
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

  // (body, path) frequency on each side. A byte-identical match is only carry-safe
  // when its (body, path) is UNIQUE — then PATH deterministically pins which
  // occurrence it is and content confirms it. When several occurrences share one
  // (body, path), path cannot disambiguate and only CONTEXT can, which is
  // fallible: a rotated or coincidental context reassigns the identity to the
  // wrong twin (proven — issue #16 Critical, the same hole that disqualified
  // `move`). Such a match is `exact` in shape but NOT safe to carry, so it is
  // downgraded to `ambiguous` (fail closed). Uniqueness is measured over the whole
  // side, not just the matched candidates, so an unclaimed identical twin still
  // blocks the carry.
  const bodyPathKey = (o: MatchOccurrence): string => `${sha256Hex(o.body)} ${o.path}`;
  const priorKeyCount = new Map<string, number>();
  for (const p of prior)
    priorKeyCount.set(bodyPathKey(p), (priorKeyCount.get(bodyPathKey(p)) ?? 0) + 1);
  const successorKeyCount = new Map<string, number>();
  for (const s of successor)
    successorKeyCount.set(bodyPathKey(s), (successorKeyCount.get(bodyPathKey(s)) ?? 0) + 1);
  const bodyPathUnique = (p: MatchOccurrence, s: MatchOccurrence): boolean =>
    (priorKeyCount.get(bodyPathKey(p)) ?? 0) <= 1 &&
    (successorKeyCount.get(bodyPathKey(s)) ?? 0) <= 1;

  // Which successors are the 1:1 partner of some prior (claimed by the matching).
  // Int32Array so index access is `number`, not `number | undefined`.
  const successorClaimedBy = new Int32Array(successor.length).fill(-1);
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
    const anchorPrior = successorClaimedBy[s] ?? -1;
    if (anchorPrior === -1) continue;
    const anchorRow = evidence[anchorPrior];
    const anchorEv = anchorRow ? anchorRow[s] : undefined;
    if (!anchorEv || anchorEv.contentExact) continue; // a whole-survivor is not a merge
    const folders: number[] = [anchorPrior];
    for (let p = 0; p < prior.length; p += 1) {
      if (p === anchorPrior) continue;
      if ((match[p] ?? -1) >= 0) continue; // a prior with its own 1:1 partner is not merging here
      const evP = evidence[p];
      const e = evP ? evP[s] : undefined;
      if (!evP || !e) continue;
      const best = evP.reduce((m, x) => Math.max(m, x.score), 0);
      if (e.content >= FANOUT_CONTENT_FLOOR && e.score >= best - TIE_EPSILON) folders.push(p);
    }
    if (folders.length >= 2) for (const p of folders) mergePartnersByPrior.set(p, s);
  }

  const classifications: LineageClassification[] = prior.map((p, row) => {
    const evidenceRow = evidence[row] ?? [];
    const col = match[row] ?? -1;

    // Merge: this prior folds into a shared successor.
    const mergeInto = mergePartnersByPrior.get(row);
    if (mergeInto !== undefined) {
      const me = evidenceRow[mergeInto];
      const mtarget = successor[mergeInto];
      if (me && mtarget) {
        return {
          fromId: p.id,
          lineage: "merge",
          toId: mtarget.id,
          confidence: me.score,
          evidence: me,
        };
      }
    }

    if (col < 0) {
      // No viable partner: terminated. Confidence carries the top rejected score.
      const top = evidenceRow.reduce((m, e) => Math.max(m, e.score), 0);
      return { fromId: p.id, lineage: "terminated", confidence: top };
    }

    const e = evidenceRow[col];
    const matched = successor[col];
    if (!e || !matched) return { fromId: p.id, lineage: "terminated", confidence: 0 };
    const matchedBody = matched.body;

    // Split: the prior fans out into the matched successor plus other unclaimed
    // successors that are DISTINCT slices of it (mutually dissimilar). Duplicate
    // copies of the matched body are excluded here — they route to the ambiguity
    // guard below. A byte-exact 1:1 never splits (the whole thing survived).
    if (!e.contentExact) {
      const members: number[] = [col];
      for (let s = 0; s < successor.length; s += 1) {
        if (s === col) continue;
        if (successorClaimedBy[s] !== -1) continue; // claimed by another prior's 1:1
        const es = evidenceRow[s];
        const cand = successor[s];
        if (!es || !cand || es.content < FANOUT_CONTENT_FLOOR) continue;
        if (lineSimilarity(matchedBody, cand.body) <= SPLIT_DISTINCT_MAX) members.push(s);
      }
      if (members.length >= 2) {
        const toIds: string[] = [];
        for (const s of members) {
          const cand = successor[s];
          if (cand) toIds.push(cand.id);
        }
        return { fromId: p.id, lineage: "split", toIds, confidence: e.score, evidence: e };
      }
    }

    // Ambiguity guard (fail closed): a competing successor within TIE_EPSILON of
    // the matched score — a near-tie the matcher cannot defensibly separate (the
    // duplicate-body case that would otherwise be a false `move`).
    const rival = evidenceRow.some(
      (other, s) => s !== col && other.score >= e.score - TIE_EPSILON && other.score >= MATCH_FLOOR,
    );
    if (rival) {
      return {
        fromId: p.id,
        lineage: "ambiguous",
        toId: matched.id,
        confidence: e.score,
        evidence: e,
      };
    }

    // 1:1 pair. Exact iff byte-identical body; the path splits exact vs move.
    if (e.contentExact) {
      const samePath = p.path === matched.path;
      // A same-path byte-identical match is `exact` and carry-safe ONLY when its
      // (body, path) is unique; a duplicated (body, path) was disambiguated by
      // fallible context, so it fails closed to `ambiguous` (never a wrong carry).
      if (samePath && !bodyPathUnique(p, matched)) {
        return {
          fromId: p.id,
          lineage: "ambiguous",
          toId: matched.id,
          confidence: e.score,
          evidence: e,
        };
      }
      const lineage: Lineage = samePath ? "exact" : "move";
      return { fromId: p.id, lineage, toId: matched.id, confidence: e.score, evidence: e };
    }
    // Changed body, confident single continuation → reopens for review.
    return {
      fromId: p.id,
      lineage: "one-to-one",
      toId: matched.id,
      confidence: e.score,
      evidence: e,
    };
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
      return (c.toIds ?? []).map((toId) => ({
        fromId: c.fromId,
        lineage: "split" as Lineage,
        toId,
      }));
    }
    return [{ fromId: c.fromId, lineage: c.lineage, ...(c.toId ? { toId: c.toId } : {}) }];
  });

  return { classifications, added, lineage };
}

// The auto-carry authority is DEFINED ONCE in `@rennet/types` (`AUTO_CARRY_LINEAGES`
// / `autoCarries`) so the disposition seam here and the graph consumer
// `resolveAnchor` in `@rennet/protocol` share one binding policy — a local copy
// here is exactly how the policy drifted from `resolveAnchor` (issue #16
// Critical 2). Re-exported for the existing import sites; `exact` only, after
// measurement disproved `move` (see the verdict doc).
export { AUTO_CARRY_LINEAGES, autoCarries };

// ── Measurement (the spike verdict) ───────────────────────────────────────────
//
// Precision and recall are measured PER mutation class against ground truth (the
// transformation actually applied to a fixture), never against a prediction of
// the matcher's own output. A classification counts as a true positive only when
// BOTH the lineage class AND the successor target match the truth — so a `move`
// pointing at the wrong file is a false positive, not a lucky hit. The safety
// number the auto-carry policy rests on is `autoCarry.precision`: it MUST be 1.

/** The true forward lineage of one prior occurrence in a fixture. */
export interface FixtureGroundTruth {
  readonly fromId: string;
  readonly lineage: Lineage;
  readonly toId?: string;
  readonly toIds?: readonly string[];
}

/** One measured patchset pair: prior/successor occurrence sets + ground truth. */
export interface LineageFixture {
  readonly name: string;
  /** Human label for the dominant mutation (for the verdict table's rows). */
  readonly mutationClass: string;
  readonly prior: readonly MatchOccurrence[];
  readonly successor: readonly MatchOccurrence[];
  readonly truth: readonly FixtureGroundTruth[];
  /** Successor ids that are genuinely new (no antecedent), if any. */
  readonly addedTruth?: readonly string[];
}

/** Per-class tallies. `support` is per-OBSERVATION; `fixturePairs` counts the
 *  distinct fixture pairs contributing observations (12 identical-body rows from
 *  one fixture are one INDEPENDENT pair, not twelve — issue #16 Medium 4). */
export interface ClassMetrics {
  readonly truePositive: number;
  readonly falsePositive: number;
  readonly falseNegative: number;
  readonly support: number;
  readonly fixturePairs: number;
  /** Observed pass rate on this SYNTHETIC corpus (TP/(TP+FP)). NOT a precision
   *  guarantee — see `renderMeasurementTables` for the uncertainty and the note
   *  that `exact` safety rests on a structural argument, not this number. */
  readonly passRate: number | null;
  readonly recall: number | null;
}

export interface MeasurementReport {
  readonly perClass: ReadonlyMap<Lineage, ClassMetrics>;
  /** The safety aggregate over the auto-carry classes (exact only, after #16). */
  readonly autoCarry: ClassMetrics;
  /** Auto-carries that landed on the WRONG code under the LIVE policy — the
   *  product's worst failure. MUST be 0. */
  readonly wrongCarries: number;
  /** Counterfactual: wrong carries that WOULD occur if `move` were auto-carried.
   *  The measured evidence for excluding it (delete-plus-copy, decoy-stolen). */
  readonly moveCounterfactualWrongCarries: number;
  /** Correct moves on the corpus — the benefit forgone by excluding `move`,
   *  shown alongside the counterfactual harm so the tradeoff is explicit. */
  readonly moveCorrect: number;
  readonly totalPriors: number;
}

/** Wilson score interval lower bound (95%) for k successes in n trials — the
 *  honest lower edge of a pass rate, so a small sample cannot masquerade as a
 *  guarantee (issue #16 Medium 4: 4/4 has a ~39.8% lower bound). */
export function wilsonLowerBound(successes: number, trials: number): number | null {
  if (trials === 0) return null;
  const z = 1.959963984540054;
  const phat = successes / trials;
  const z2 = z * z;
  const centre = phat + z2 / (2 * trials);
  const margin = z * Math.sqrt((phat * (1 - phat) + z2 / (4 * trials)) / trials);
  return Math.max(0, (centre - margin) / (1 + z2 / trials));
}

const ALL_LINEAGES: readonly Lineage[] = [
  "exact",
  "move",
  "one-to-one",
  "split",
  "merge",
  "ambiguous",
  "terminated",
];

/** Whether a prediction's target matches the truth for a class that has one. */
function targetMatches(pred: LineageClassification, truth: FixtureGroundTruth): boolean {
  if (truth.lineage === "split") {
    const a = new Set(pred.toIds ?? []);
    const b = new Set(truth.toIds ?? []);
    return a.size === b.size && [...b].every((id) => a.has(id));
  }
  if (truth.lineage === "terminated" || truth.lineage === "ambiguous") return true;
  return pred.toId === truth.toId;
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

/** Run the matcher over every fixture and tally per class + the safety aggregate. */
export function measure(fixtures: readonly LineageFixture[]): MeasurementReport {
  const tp = new Map<Lineage, number>();
  const fp = new Map<Lineage, number>();
  const fn = new Map<Lineage, number>();
  const support = new Map<Lineage, number>();
  const fixturePairs = new Map<Lineage, Set<string>>();
  for (const l of ALL_LINEAGES) {
    tp.set(l, 0);
    fp.set(l, 0);
    fn.set(l, 0);
    support.set(l, 0);
    fixturePairs.set(l, new Set<string>());
  }
  let autoTp = 0;
  let autoFp = 0;
  let autoSupport = 0;
  let wrongCarries = 0;
  let moveCounterfactualWrongCarries = 0;
  let moveCorrect = 0;
  let totalPriors = 0;
  const autoFixturePairs = new Set<string>();

  for (const fixture of fixtures) {
    const result = classifyLineage(fixture.prior, fixture.successor);
    const predByFrom = new Map(result.classifications.map((c) => [c.fromId, c]));
    for (const truth of fixture.truth) {
      totalPriors += 1;
      support.set(truth.lineage, (support.get(truth.lineage) ?? 0) + 1);
      fixturePairs.get(truth.lineage)?.add(fixture.name);
      if (autoCarries(truth.lineage)) {
        autoSupport += 1;
        autoFixturePairs.add(fixture.name);
      }
      const pred = predByFrom.get(truth.fromId);
      if (!pred) {
        fn.set(truth.lineage, (fn.get(truth.lineage) ?? 0) + 1);
        continue;
      }
      const correct = pred.lineage === truth.lineage && targetMatches(pred, truth);
      if (correct) {
        tp.set(pred.lineage, (tp.get(pred.lineage) ?? 0) + 1);
        if (autoCarries(pred.lineage)) autoTp += 1;
      } else {
        fp.set(pred.lineage, (fp.get(pred.lineage) ?? 0) + 1);
        fn.set(truth.lineage, (fn.get(truth.lineage) ?? 0) + 1);
      }
      // LIVE-policy safety: an auto-carry (exact) prediction that is not a correct
      // auto-carry landed read state on the wrong code.
      if (autoCarries(pred.lineage) && !(autoCarries(truth.lineage) && correct)) {
        autoFp += 1;
        wrongCarries += 1;
      }
      // COUNTERFACTUAL: if `move` were auto-carried, every predicted `move` that
      // is not a correct move-to-the-same-target would be a wrong carry. This is
      // the measured reason `move` is excluded.
      if (pred.lineage === "move") {
        if (truth.lineage === "move" && correct) moveCorrect += 1;
        else moveCounterfactualWrongCarries += 1;
      }
    }
  }

  const perClass = new Map<Lineage, ClassMetrics>();
  for (const l of ALL_LINEAGES) {
    const t = tp.get(l) ?? 0;
    const f = fp.get(l) ?? 0;
    const n = fn.get(l) ?? 0;
    perClass.set(l, {
      truePositive: t,
      falsePositive: f,
      falseNegative: n,
      support: support.get(l) ?? 0,
      fixturePairs: fixturePairs.get(l)?.size ?? 0,
      passRate: ratio(t, t + f),
      recall: ratio(t, t + n),
    });
  }

  const autoCarry: ClassMetrics = {
    truePositive: autoTp,
    falsePositive: autoFp,
    falseNegative: autoSupport - autoTp,
    support: autoSupport,
    fixturePairs: autoFixturePairs.size,
    passRate: ratio(autoTp, autoTp + autoFp),
    recall: ratio(autoTp, autoSupport),
  };

  return {
    perClass,
    autoCarry,
    wrongCarries,
    moveCounterfactualWrongCarries,
    moveCorrect,
    totalPriors,
  };
}

/** Render the measurement as the markdown tables the verdict doc commits. */
export function renderMeasurementTables(report: MeasurementReport): string {
  const pct = (v: number | null): string => (v === null ? "—" : `${(v * 100).toFixed(1)}%`);
  const rows = ALL_LINEAGES.flatMap((l) => {
    const m = report.perClass.get(l);
    if (!m) return [];
    return [
      `| \`${l}\` | ${m.support} | ${m.fixturePairs} | ${m.truePositive} | ${m.falsePositive} | ${m.falseNegative} | ${pct(m.passRate)} | ${pct(m.recall)} |`,
    ];
  });
  const a = report.autoCarry;
  const wilson = wilsonLowerBound(a.truePositive, a.truePositive + a.falsePositive);
  return [
    "| Class | Obs | Fixture pairs | TP | FP | FN | Fixture pass rate | Recall |",
    "|---|---|---|---|---|---|---|---|",
    ...rows,
    "",
    `**Auto-carry (exact only):** fixture pass rate ${pct(a.passRate)} over ${a.support} observations from ${a.fixturePairs} independent fixture pairs (95% Wilson lower bound ${pct(wilson)}). **Wrong carries under the live policy: ${report.wrongCarries}** (must be 0).`,
    "",
    `**Why not \`move\`:** enabling \`move\` auto-carry would produce **${report.moveCounterfactualWrongCarries} wrong carries** on this corpus (delete-plus-copy read as relocation; a decoy that kept the old context stealing the lineage) against ${report.moveCorrect} correct moves — so it is excluded. \`exact\` carry safety does NOT rest on the pass rate above (a synthetic-corpus statistic): it rests on the STRUCTURAL argument that a byte-identical body at a UNIQUE (body, path) can only be mismatched by a SHA-256 collision, and a duplicated (body, path) fails closed to \`ambiguous\`.`,
  ].join("\n");
}
