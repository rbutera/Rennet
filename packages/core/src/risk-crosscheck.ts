/**
 * The predicted-risk cross-check (issue #181): the downstream half of the
 * hypothesis-first pass.
 *
 * After the lens runners return, this pure, deterministic function (NO model turn)
 * reconciles each risk the hypothesis predicted against the findings the runners
 * produced. A risk a finding addresses is `confirmed` (a predicted-and-found
 * signal, with the finding linked); a risk no finding addresses is `open` — the
 * anti-rubber-stamp payoff, surfaced to the human as a manual check they must make
 * themselves, NEVER silently discarded.
 *
 * Matching is by semantic overlap of the risk's salient words (its statement +
 * disconfirmer) against a finding's summary. It is deliberately CONSERVATIVE: a
 * false `confirmed` would mark a real risk as handled when it was not (hiding it —
 * the exact "prettier rubber stamp" this whole change fights), whereas a false
 * `open` merely tells the human to re-check something already flagged (safe,
 * mildly redundant). So the bias is toward `open`: a match requires real,
 * meaningful token overlap, never an incidental shared stopword.
 */

import type {
  FindingElement,
  FlaggedReview,
  ReviewHypothesis,
  RiskCrossCheck,
} from "@rennet/types";

/** The minimum number of shared salient tokens for a finding to address a risk. */
export const RISK_MATCH_MIN_SHARED_TOKENS = 2;

/** Words too common to carry meaning; a match on these alone is not a match. */
const STOPWORDS = new Set<string>([
  "the",
  "this",
  "that",
  "with",
  "from",
  "into",
  "when",
  "then",
  "than",
  "over",
  "under",
  "code",
  "change",
  "changes",
  "changed",
  "check",
  "value",
  "values",
  "author",
  "should",
  "would",
  "could",
  "does",
  "done",
  "make",
  "made",
  "used",
  "using",
  "have",
  "here",
  "there",
  "which",
  "where",
  "what",
  "will",
  "must",
  "case",
  "cases",
  "line",
  "lines",
  "hunk",
  "diff",
]);

/**
 * The salient token set of a piece of text: lowercased words of length >= 4 that
 * are not stopwords. Non-alphanumeric characters split words, so `fail-closed`
 * contributes `fail`? no — `fail` is length 4 and kept, `closed` kept. Identifier
 * fragments (`repoKey`, `git-common-dir`) split into their meaningful parts.
 */
export function salientTokens(text: string): Set<string> {
  const tokens = text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 4 && !STOPWORDS.has(token));
  return new Set(tokens);
}

/** The count of tokens present in both sets. */
function sharedCount(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return shared;
}

/**
 * Cross-check every hypothesised risk against the produced findings. Each risk
 * becomes a `RiskCrossCheck`: `confirmed` with the ids of the findings that
 * address it, or `open` with an empty finding list. Deterministic and total —
 * every risk is accounted for exactly once, in order, and no finding match can
 * cause a risk to be dropped.
 */
export function crossCheckRisks(
  hypothesis: ReviewHypothesis,
  findings: readonly FindingElement[],
): RiskCrossCheck[] {
  const findingTokens = findings.map((finding) => ({
    id: finding.findingId,
    tokens: salientTokens(finding.summary),
  }));

  return hypothesis.risks.map((risk): RiskCrossCheck => {
    const riskTokens = salientTokens(`${risk.statement} ${risk.disconfirmer}`);
    const findingIds: string[] = [];
    for (const finding of findingTokens) {
      if (sharedCount(riskTokens, finding.tokens) >= RISK_MATCH_MIN_SHARED_TOKENS) {
        findingIds.push(finding.id);
      }
    }
    return findingIds.length > 0
      ? { riskId: risk.riskId, status: "confirmed", findingIds }
      : { riskId: risk.riskId, status: "open", findingIds: [] };
  });
}

/**
 * Surface the predicted-risk cross-check onto a completed `FlaggedReview` (the
 * live-path wiring for issue #181). This is the ONE composition point that turns
 * the pure `crossCheckRisks` reconciliation into something the review carries to
 * the UI, and it is deliberately the LAST transform of the review:
 *
 *   • It runs on the review's FINAL findings — after dual-model reconciliation
 *     (#41) AND after per-finding verification (#179) have dropped any refuted
 *     finding. Cross-checking earlier would let a false, later-dropped finding mark
 *     a risk `confirmed` and then vanish, leaving a risk that looks handled by a
 *     finding no reader can see — the exact "prettier rubber stamp" this fights.
 *   • It is a pure, deterministic, NO-model-turn step ($0), so it runs on BOTH the
 *     deep (dual + verified) and quick (single-seat) paths, never gated on spend.
 *   • It degrades honestly: a `failed` review, or one produced with NO hypothesis
 *     (an absent adapter, a failed hypothesis pass), is returned UNCHANGED — no
 *     `crossChecks` field, byte-identical to the pre-#181 shape. A hypothesis with
 *     no risks yields an empty `crossChecks`, which is honestly "nothing predicted",
 *     never a silent all-clear.
 *
 * The result rides the review's `ok` variant additively, so the Flagged lens
 * boundary and every existing consumer are unchanged; `buildHypothesisFrame`
 * (`@rennet/ui`) folds the same `RiskCrossCheck[]` next to the hypothesis into the
 * reader's frame, defaulting any risk it cannot match to `open`.
 */
export function attachRiskCrossCheck(
  review: FlaggedReview,
  hypothesis: ReviewHypothesis | undefined,
): FlaggedReview {
  if (review.status !== "ok" || hypothesis === undefined) return review;
  return { ...review, crossChecks: crossCheckRisks(hypothesis, review.findings) };
}
