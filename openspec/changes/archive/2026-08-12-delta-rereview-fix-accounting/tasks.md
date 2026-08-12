# Tasks — delta-rereview-fix-accounting (N2 / #73)

Gate: `NX_DAEMON=false pnpm check` (green = exit 0 AND `Successfully ran target`). Red-proof every fix with the prediction named first, then a full green pass. Assert the contract, never your own implementation. #254's carry is **already shipped** — read it, do not rebuild it.

> **Shipped narrower than proposed (honest close-out).** Verified against the shipped substrate: there is **no returned-hunk→disposition trace** and **no structured hunks** (`HandoffTask` has no id; `PatchFile.patch` is raw text; `HandoffRunResult` exposes only counts). So the account is built from the shipped lineage carry (`carried`/`orphaned`) + a changed-path set, at **PATH grain** for beyond-asks (span-precise for per-ask status) — the honest ceiling of the data. **M25 prose is DEFERRED** (optional garnish; the `delta-rereview-summary` seat is a catalogue row with no runner). #73 stays **open** for those two follow-ups: (a) true hunk-grain (needs a hunk→disposition trace built first) and (b) the M25 light-tier prose.

## 1. Read the shipped substrate
- [x] 1.1 Read the carry and its result fields: `carryDispositionsByLineage` (`packages/core/src/index.ts`), the `PatchsetActivated` fold, and `carriedForward`/`orphaned` on the handoff run result (`apps/desktop/src/main/dispatch.ts`).
- [x] 1.2 Find the disposition-id trace — **FOUND ABSENT**: `HandoffTask` has no disposition id (matches by path+span+side); the only id is `ComposableAsk`'s positional ordinal; `HandoffRunResult` gives counts only. Documented in `delta-account.ts`; the account is built from the carry + changed-path set instead.
- [x] 1.3 Confirm the Model Council M25 light seat — the `delta-rereview-summary` (light) job exists in the catalogue but has **no runner**; deferred (see the note above).

## 2. Deterministic skeleton (core, model-free)
- [x] 2.1 Classify each ask addressed / partially-addressed / untouched from the carry + changed-path set (`buildDeltaAccount`). Matches ask→carried by a **rename-surviving identity** (spanDigest, else path+contentDigest) so a rename-carry is not misread as addressed.
- [x] 2.2 Compute the beyond-asks set: changed paths targeting no ask (rename targets of an asked/carried file are covered, never scope-creep).
- [x] 2.3 Total partition holds **by construction** (`beyondAsks = changed \ covered`). The initial runtime assertion was **removed** — dual review proved it tautological (a dead guard is false confidence).
- [x] 2.4 Red-proof: `RED-PROOF: an unrequested change is flagged beyond-asks` — reverting beyond-asks detection reddens it (verified live by both reviewers).

## 3. Optional prose (M25 light seat)
- [ ] 3.1 **DEFERRED** — route a light-tier narration job over the structured account. The seat has no runner; the deterministic account is complete without it (proposal: "prose is enrichment").
- [x] 3.2 Model-free proof — STRONGER than the proposed stub: `buildDeltaAccount`/`changedPathsBetween` take no model/seat/budget parameter, so the account is model-free by construction; a determinism test pins it. (The "stub M25 to throw" form is moot — no M25 runner exists.)

## 4. Render on the successor canvas (Zone A / ui)
- [x] 4.1 Render the account at the top of the successor review (`DeltaAccountPanel`, above the view tabs).
- [x] 4.2 Anchor each item: activating it opens the Files view on that path (`setView("review") + setSelectedPath`). *(Path-grain navigation; the diff "pulse" animation is not implemented — path-grain ceiling.)*
- [ ] 4.3 **NOT DONE** — cross-check against wireframes `06-review-heart` / `17-flow-overview`. Placed at top-of-review per the issue prose; a wireframe cross-check is a small follow-up.
- [x] 4.4 The account gates nothing: it is an informational `<section>`, no dismissal, re-review/sign proceed without acknowledging it.

## 5. Prove it
- [x] 5.1 Red-then-green: the 3-ask fixture yields all four facts at unit AND fold grain; beyond-asks flagged; reverting detection reddens the named test.
- [x] 5.2 Full gate green. Feature tip `ffbb5f9` (ff from `d4819a1`); `NX_DAEMON=false pnpm check` → Successfully ran targets for 8 projects, exit 0. core 827.
