# delta-account-digest

**Issue:** #73 (the M25 half). **Owner:** Claude (Zone A). **Review:** dual Opus.
**Wireframe:** v3.3 `06a-delta-rereview` (the digest-on-top-of-facts presentation, blessed by Rai). **Depends on:** N2 delta-rereview-fix-accounting (`Review.deltaAccount`, shipped).

## Why

N2 shipped the deterministic delta account: after a re-review, the reviewer sees each staged ask marked addressed / partially / untouched and every path the agent changed beyond their asks — model-free, at the top of the successor review. Rai's ask (2026-08-12): *"I'd want an LLM pass over that final output to make it more digestible."* Reading a table of statuses is slower than reading one plain-English sentence. This ships that sentence — the deferred M25 light-tier prose (task 3 of N2, left open on #73) — **on top of** the facts, never replacing them.

## What Changes

- **A light-tier LLM digest over the delta account.** The existing `delta-rereview-summary` seat (M25, light tier) — today a catalogue row with no runner — gets a real producer that turns the structured `DeltaAccount` into a 1–2 sentence plain-English TL;DR ("Claude made your rename and added the bound, left the dead-branch cleanup, and also swapped in a logger you never asked for").
- **Rendered on top of the facts.** The digest is a headline above the existing `DeltaAccountPanel`; the addressed/partially/untouched + beyond-asks facts stay visible below it as the authoritative ground truth. The prose adds **no fact** the deterministic account does not already carry.
- **Auto, and never blocking.** The facts render the instant the re-review opens; the digest generates in the background (one light-model call per re-review) and slots in a beat later.
- **Model-free floor.** If the seat is absent, throws, or is over budget, the digest is simply **absent** and the facts are unchanged — an honest "no summary this time", never a blank card and never a guess.

## Acceptance

- Given a `Review.deltaAccount`, the producer returns a short prose digest derived from it, with **zero** claims not grounded in the account's asks/beyondAsks (red-then-green: a fixture account with 2 addressed / 1 untouched / 1 beyond-asks yields a digest naming those; the producer is a pure function of the account + model, no other input).
- **Model-free floor proven:** with the M25 seat stubbed to throw (or the budget exhausted), the command answers an honest `unavailable` and the `DeltaAccountPanel` renders the full facts with no digest and no error (red-proof: a fixture where the seat throws must NOT surface a digest and must NOT throw).
- The digest **renders on top** of the facts in the panel when present, and is simply absent otherwise; it **gates nothing** — re-review and sign proceed without it.
- Any field crossing IPC is named in the `packages/protocol` Zod schema (an unlisted optional is silently stripped).
- Full gate green. Strictly additive over N2's account — the deterministic computation is untouched.

## Impact

- **`packages/core`** — a new light producer `buildDeltaDigest(account, deps)` over `DeltaAccount`, routed through the model council (`resolveAssignment` for the `delta-rereview-summary` seat) and budget-gated (`InvocationBudget.tryConsume`), failing closed to `unavailable`. Follows the shipped `rollup-narration.ts` shape.
- **`packages/protocol`** — a `review.deltaDigest` command (input: reviewId; output: a discriminated `{ status: "drafted", text } | { status: "unavailable", reason }`).
- **`apps/desktop/src/main`** — an optional `draftDeltaDigest` dispatch dep (like `draftPrBody`/`refineComment`), composed over the live council; the handler resolves the review's `deltaAccount` and runs it. Absent dep ⇒ honest `unavailable`.
- **`packages/ui/src`** — the renderer calls `review.deltaDigest` when a `deltaAccount` is present and slots the returned prose atop `DeltaAccountPanel`; the facts render immediately regardless. **Zone A.**
- Dual Opus review: verify the digest is a rephrasing only (no invented facts), the model-free floor holds (facts render with the seat down), and it gates nothing.

## Deferred

- **True hunk-grain beyond-asks** — the other #73 follow-up; still deferred (needs a returned-hunk→disposition trace built first). This change is prose only.
- Streaming token-by-token render; the digest slots in whole when the light call returns (a light-tier one-shot is fast enough; token streaming is a later polish).
- No caps beyond the standard `InvocationBudget` the council already enforces (Rai: spend as needed, no per-advance ceiling).
