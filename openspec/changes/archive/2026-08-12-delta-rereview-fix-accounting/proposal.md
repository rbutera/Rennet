# delta-rereview-fix-accounting (N2)

**Issue:** #73 (feature). **Owner:** Navi (Zone A). **Review:** dual Opus.
**Wireframes:** `06-review-heart` (the review canvas), `17-flow-overview` (stage 7, the delta loop). **Depends on:** #18, #16 (merged); #254 (its honest deterministic carry, **already shipped** — see below).

> **Scope note.** #254 (wire the honest deterministic carry into the delta re-review) was **already shipped and closed** — the `PatchsetActivated` fold runs `carryDispositionsByLineage` (`packages/core/src/index.ts:613`), the handoff run result reports it as `carriedForward` + `orphaned` (`apps/desktop/src/main/dispatch.ts:1061`), the dead `LineageCarryPort`/`matcher-not-wired` seam is gone, and the fuzzy matcher is deliberately kept out. So N2 is **#73 only**: narrate that already-honest carry to the reviewer.

## Why

The delta re-review's *safety* is structural and shipped: approved-unchanged hunks carry, agent changes arrive unread, vanished occurrences orphan (surfaced, never dropped), and the run result already counts what carried vs orphaned. What is missing is the *account*. Without narration the reviewer re-derives what happened from raw deltas, and the changes an agent made **beyond what you asked** — the ones a tired reviewer skims past — are invisible. Honesty about what the coding agent actually did is the accountability the loop is named for.

## What Changes

When the handoff loop (#18) returns a new patchset, a summarisation job narrates the delta **before re-read**, rendered at the top of the successor canvas (journey stage 7), the entry point to delta re-review:

- **"What moved"** — per staged ask: *addressed / partially addressed / untouched*, mapped via the bundle's disposition-id trace + the shipped lineage carry (`carried` / `orphaned`).
- **"What the agent did beyond your asks"** — hunks in the new patchset that map to **no** staged disposition, surfaced **loudly**. This is the scope-creep detector — the sibling of the claims angle's UNCLAIMED bucket.
- **Deterministic skeleton** (lineage diff + trace-map arithmetic) is complete with **no model call**. Light-tier prose (Model Council seat M25) is optional garnish over it, budget-gated.
- Summary items **anchor**: tapping one navigates to the moved hunks.

## Acceptance

- Fixture — a bundle of **3 asks** where the returned patchset **addresses 2, ignores 1, and adds 1 unrequested** change → the summary states all four facts, and flags the unrequested change as **beyond-asks** (red-then-green test: with the beyond-asks detection reverted, the unrequested change is not flagged and the test reddens).
- The deterministic skeleton is complete with **zero** model calls — the "beyond-asks" claim holds with no model available (prove it: run the skeleton with the light-tier seat stubbed to throw; the account is still correct).
- Tapping a summary item navigates to its hunk(s).
- Renders at the top of the successor canvas (stage 7) as the entry to delta re-review.
- Full gate green; no other review path changes.

## Impact

- `packages/core` — the deterministic delta/trace-map skeleton + the light-tier narration seat (M25). Reads the shipped `carried`/`orphaned` from the handoff result and the disposition-id trace; adds no new carry logic.
- `packages/ui/src` — the successor-canvas surface (stage 7 top-of-canvas) rendering the account with anchoring. Renderer touch → **Zone A**.
- Dual Opus review: verify the deterministic skeleton is genuinely **model-free** (a beyond-asks claim must hold with no model), and that the account never blocks or gates re-review.

## Deferred

- **Same-path re-anchor for a byte-identical hunk that only *shifted line position*** (was #266, closed as out-of-scope): a purely line-shifted hunk still reopens and would appear as untouched/reopened in the account. Disclosed, not fixed here. *(Flag for Rai: #266 was closed with the durability tail; reopen if he wants this floor lifted.)*
- Light-tier prose quality tuning beyond the deterministic skeleton. The skeleton is the guarantee; prose is enrichment.
- No gate: the account is informational and never blocks re-review or sign.
