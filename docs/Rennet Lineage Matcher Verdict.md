# Rennet Lineage Matcher Verdict (spike 1)

Issue #16. The pre-build spike ranked first by information value: the
occurrence-ID lineage matcher, its measured behaviour on an adversarial corpus,
and the calibrated auto-carry policy that gates read-state and disposition carry.

Source: `packages/core/src/lineage-matcher.ts`; fixtures
`packages/core/src/lineage-matcher-fixtures.ts`; the reddening measurement
`packages/core/src/lineage-matcher.measurement.test.ts`.

> **Correction (2026-08-11, after dual review).** An earlier draft of this verdict
> claimed `move` auto-carries safely and that the disposition seam was "upgraded to
> the same graph". Both were wrong and are corrected below. `move` is REMOVED from
> auto-carry; the matcher and the disposition seam are TWO SEPARATE mechanisms.

## Two separate mechanisms (do not conflate them)

1. **The fuzzy occurrence matcher** (`classifyLineage`) — content/path/context
   evidence, global max-weight matching, emits the `LineageEntry[]` graph that
   `resolveAnchor` (`@rennet/protocol`) consumes for ANALYSIS-artifact carry and
   that #18's delta re-review will use. It classifies at sub-file occurrence
   granularity, where git gives no lineage.
2. **The disposition / read-state carry seam** (`carryDispositionsByLineage`,
   `@rennet/core`) — DETERMINISTIC, and it does NOT run the fuzzy matcher. It keys
   on same-path patch-digest and same-file-line span byte-identity. Across a git
   rename (`previousPath` distinguishes moved from vanished):
   - a **span-grained** disposition whose side-text is byte-identical at the new
     path **carries**, re-anchored (`carrySpanMoveOntoRename`) — safe because it is
     the same bytes, targeted by git's deterministic rename link, not a similarity
     match. A pure rename renders the new file as a full-add with byte-identical
     additions (verified against the git-capture adapter), which is this shape.
   - a **path-grained** disposition **reopens**: a real rename's whole-file patch
     differs from the original in its `diff --git`/`index`/`+++` headers, so the
     whole-file digest never matches — the path-grained move-carry was a dead branch
     and was removed (Opus F1). A vanished file orphans.

   ⭐ This seam's move-carry is git provenance + byte-identity, DECOUPLED from
   `AUTO_CARRY_LINEAGES` (which stays exact-only for the fuzzy graph). The two carry
   decisions were conflated behind one flag; keeping `move` in the allowlist to
   preserve this safe capability would also have made `resolveAnchor` carry fuzzy
   `move` edges — the Critical-2 bug. Decoupling fixes the graph and keeps the seam.

The fuzzy-graph consumer's authority is `AUTO_CARRY_LINEAGES` / `autoCarries` in
`@rennet/types` (the lowest layer, so a consumer cannot drift from it — the flaw
that let `resolveAnchor` carry `one-to-one` state while the policy said otherwise).

## The auto-carry policy: `exact` only

`AUTO_CARRY_LINEAGES = { exact }`. Everything else reopens (a changed occurrence,
superseded to its successor with `carriesState: false`) or orphans (`ambiguous` /
`terminated`). The measurement below is the evidence.

## The measurement

Nineteen self-authored, synthetic patchset pairs (⛔ never client PRs), including
the three adversarial cases that disproved `move`. Ground truth is the
transformation actually applied; a true positive requires BOTH the class AND the
target. `Obs` is per-observation; `Fixture pairs` counts the INDEPENDENT pairs
contributing (twelve identical-body rows from one fixture are one pair, not
twelve — so a headline rate is not inflated by correlated observations).

<!-- Regenerate from renderMeasurementTables(measure(LINEAGE_FIXTURES)); the measurement test asserts this doc contains it verbatim. -->

| Class | Obs | Fixture pairs | TP | FP | FN | Fixture pass rate | Recall |
|---|---|---|---|---|---|---|---|
| `exact` | 21 | 7 | 21 | 0 | 0 | 100.0% | 100.0% |
| `move` | 5 | 4 | 4 | 2 | 1 | 66.7% | 80.0% |
| `one-to-one` | 6 | 5 | 6 | 0 | 0 | 100.0% | 100.0% |
| `split` | 1 | 1 | 1 | 0 | 0 | 100.0% | 100.0% |
| `merge` | 2 | 1 | 2 | 0 | 0 | 100.0% | 100.0% |
| `ambiguous` | 7 | 2 | 7 | 0 | 0 | 100.0% | 100.0% |
| `terminated` | 3 | 3 | 2 | 0 | 1 | 100.0% | 66.7% |

**Auto-carry (exact only):** fixture pass rate 100.0% over 21 observations from 7 independent fixture pairs (95% Wilson lower bound 84.5%). **Wrong carries under the live policy: 0** (must be 0).

**Why not `move`:** enabling `move` auto-carry would produce **2 wrong carries** on this corpus (delete-plus-copy read as relocation; a decoy that kept the old context stealing the lineage) against 4 correct moves — so it is excluded. `exact` carry safety does NOT rest on the pass rate above (a synthetic-corpus statistic): it rests on the STRUCTURAL argument that a byte-identical body at a UNIQUE (body, path) can only be mismatched by a SHA-256 collision, and a duplicated (body, path) fails closed to `ambiguous`.

## Why `exact` is safe and `move` is not (the structural argument)

- **`exact` carries** iff a byte-identical body sits at a UNIQUE `(body, path)`.
  Then path deterministically pins WHICH occurrence it is and content confirms it;
  the only misclassification is a hash collision. When several occurrences share
  one `(body, path)` — identical twins in one file — path cannot disambiguate and
  only CONTEXT can, which is fallible (a rotated or coincidental context reassigns
  the identity to the wrong twin). Such a match fails closed to `ambiguous`. This
  guard is what makes `exact` safe rather than merely usually-right: the
  `same-path-rotated-context` fixture (six identical bodies, contexts rotated) is
  classified `ambiguous`, not a confident wrong `exact`.
- **`move` cannot be made safe** from content + optional context. A relocated
  identical body is INDISTINGUISHABLE from a delete-plus-an-unrelated-copy (both
  are "the same bytes, elsewhere"), and when several copies exist the target is
  chosen by context, which can lie. The corpus proves it: `move` scores 66.7%,
  and the two failures are exactly a wrong carry each if it were enabled. `move`
  returns as a carry class only behind deterministic provenance that PROVES
  continuation (e.g. stable occurrence ids from ingest), never from this evidence.

## The consumer, made binding

`resolveAnchor` now reads `carriesState: autoCarries(entry.lineage)` — so a mapped
`one-to-one`/`move`/`split`/`merge` supersedes to its successor (re-anchors) but
does NOT carry state; only `exact` does. Tested across all seven classes
(`rsp.test.ts`). Before the fix it returned `carriesState: true` for every
targeted non-ambiguous class, i.e. read state carried onto edited code.

## Honest limits

- The rates are on a SYNTHETIC corpus of 19 pairs. They demonstrate the design on
  a representative and deliberately adversarial set; `exact` safety generalises
  because it is structural (hash identity + the uniqueness guard), and its failure
  direction is always WITHHOLDING a carry (ambiguous), never a wrong one.
- A residual worth naming: `exact` safety assumes the fuzzy matcher's `(body,
  path)`-unique matches are trustworthy. They are, because such a match is forced
  by path + content with no reliance on context. The moment ingest can hand the
  matcher stable occurrence ids, carry authority should move onto that
  deterministic provenance rather than the classifier at all.
- The disposition seam is deterministic and does not depend on any of the above.
  Across a real (adapter-produced) git rename, a byte-identical span carries and a
  path-grained disposition reopens; it never wrong-carries.
