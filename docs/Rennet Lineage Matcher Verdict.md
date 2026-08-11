# Rennet Lineage Matcher Verdict (spike 1)

Issue #16. The pre-build spike ranked first by information value: the
occurrence-ID lineage matcher, its measured precision/recall, and the calibrated
auto-carry policy that gates read-state and disposition carry across patchsets.

Source: `packages/core/src/lineage-matcher.ts`; fixtures
`packages/core/src/lineage-matcher-fixtures.ts`; the reddening measurement
`packages/core/src/lineage-matcher.measurement.test.ts`.

## What the matcher is

A pure function from two occurrence sets (a prior patchset's and a successor's)
to the classified lineage graph the contract freezes in Architecture Contracts
§3.4 and R8. Occurrence **identity** is the immutable id minted by deterministic
ingest. Path, symbol, and content hashes are **demoted to weighted evidence** for
mapping an id forward — never identity themselves.

The pipeline:

1. **Evidence.** For every prior→successor pair, score four signals into `[0,1]`:
   content (byte-identity, else Sørensen–Dice over normalised non-empty lines),
   path (same path 1.0, same basename 0.5), symbol (same non-empty symbol 1.0),
   and context (Dice over the surrounding source). Weights `0.60 / 0.20 / 0.15 /
   0.05` (content / context / path / symbol) — content dominates, context is the
   disambiguator that must out-vote path among identical bodies.
2. **Global matching.** Max-weight bipartite matching (Kuhn–Munkres / Hungarian)
   over the score matrix. The **global** optimum is what makes the twelve
   identical bodies resolve to twelve identities: content ties at 1.0 for every
   pair, so the assignment that maximises the *total* score pairs each body with
   its own context — a greedy matcher collapses them onto one.
3. **Classification.** Each prior is classified `exact` / `move` / `one-to-one` /
   `split` / `merge` / `ambiguous` / `terminated`, with two fail-closed guards:
   - a fan-out into *distinct* slices is a **split**; a fan-out into *duplicate*
     bodies is not — its near-tie is **ambiguous**;
   - any competing successor within an effective tie (Δscore < 0.06) that the
     matcher cannot defensibly separate downgrades the match to **ambiguous**.

## The measurement

Sixteen self-authored, synthetic patchset pairs (⛔ never client PRs), one per
mutation class plus mixed and adversarial cases, 25 auto-carryable priors in
total. Ground truth is the transformation actually applied to each fixture, not a
prediction of the matcher's output; a classification is a true positive only when
**both** the class **and** the successor target match. The adversarial fixtures —
`near-duplicate-helpers`, `rename-and-edit`, `duplicate-ambiguous`,
`twelve-identical-handlers`, `whitespace-only` — are the ones whose correct class
was set from the edit's semantics, not chosen to flatter the matcher.

<!-- Regenerate this table from renderMeasurementTables(measure(LINEAGE_FIXTURES)); the measurement test asserts it verbatim. -->

| Class | Support | TP | FP | FN | Precision | Recall |
|---|---|---|---|---|---|---|
| `exact` | 21 | 21 | 0 | 0 | 100.0% | 100.0% |
| `move` | 4 | 4 | 0 | 0 | 100.0% | 100.0% |
| `one-to-one` | 6 | 6 | 0 | 0 | 100.0% | 100.0% |
| `split` | 1 | 1 | 0 | 0 | 100.0% | 100.0% |
| `merge` | 2 | 2 | 0 | 0 | 100.0% | 100.0% |
| `ambiguous` | 1 | 1 | 0 | 0 | 100.0% | 100.0% |
| `terminated` | 2 | 2 | 0 | 0 | 100.0% | 100.0% |

**Auto-carry aggregate (exact + move):** precision 100.0%, recall 100.0% over 25
carryable priors. **Wrong carries: 0** (must be 0).

## The recommended auto-carry policy

**Auto-carry `exact` and `move`. Fail closed on everything else.** Encoded as
`AUTO_CARRY_LINEAGES` / `autoCarries()` in the matcher module.

The evidence for each half:

- **`exact` — carry.** An exact edge is byte-identical content at the same path.
  Precision is 100% *by construction*: the only way to misclassify is a SHA-256
  collision. This is the #10 floor, unchanged. Whitespace-only and any body edit
  fall out of `exact` (measured as `one-to-one`) and correctly do **not** carry.
- **`move` — carry, re-anchored.** A move is byte-identical content at a *new*
  path (a rename). Its precision is **not** free: two genuinely different files
  with identical content (boilerplate, an empty module) could be paired wrongly.
  That risk is exactly what the ambiguity guard neutralises — a non-unique or
  context-tied identical body downgrades to `ambiguous`, so a surviving `move` is
  the unique, contextually-disambiguated case. Measured precision 100% across the
  move and duplicate fixtures, including `duplicate-ambiguous` (correctly withheld
  as ambiguous) and `move-with-stable-sibling` (no cross-file leak).
- **`one-to-one`, `split`, `merge`, `ambiguous`, `terminated` — fail closed.** A
  changed / split / merged / ambiguous occurrence reopens for review; a vanished
  one orphans, surfaced against its last-known version. None auto-carries.

## Honest limits

- The ~100% is measured on a **synthetic** corpus of 16 pairs. It proves the
  *design* (byte-identity floor + ambiguity fail-closed) does not misclassify on a
  representative and deliberately adversarial set; it is not a claim about every
  real diff. `exact` precision is structural (hash identity), so it generalises;
  `move` precision rests on the ambiguity guard holding, which the fixtures
  exercise but real duplicate-content collisions could still stress — the guard's
  conservatism means the failure direction is **withholding a carry** (ambiguous),
  never a wrong carry.
- Real-diff lossiness (256 KiB truncation, binary/partial patches) is handled at
  the carry-application floor (`anchorCarries` in `@rennet/core`), not in the
  matcher: the matcher sees occurrence bodies, and the application refuses to
  carry over content it cannot fully certify. See the application section of #16.
- The similarity metric is line-level Dice — order-insensitive and cheap. It is
  sufficient to separate the fail-closed classes (whose exact boundaries are
  informational, since none carries), but it is not a semantic diff. A future
  slice can upgrade the `one-to-one`/`split`/`merge` boundaries without touching
  the carry-critical `exact`/`move`/`ambiguous` guards.

## What consumes this

`resolveAnchor` (`@rennet/protocol`) already reads the `LineageEntry[]` graph the
matcher emits. The disposition/read-state carry seam (#10's exact-only v1) is
upgraded to it in the same issue: `exact` carries unchanged (the preserved
floor), `move` carries re-anchored to the new path, a vanished occurrence orphans
(surfaced, never dropped to void). #18's §2.1 delta re-review consumes the same
graph.
