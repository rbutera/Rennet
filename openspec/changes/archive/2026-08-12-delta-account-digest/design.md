# Design — delta-account-digest (#73 M25 half)

## The one principle: the digest is a rephrasing, never a source

The deterministic `DeltaAccount` (N2) is the ground truth. The digest is one plain-English sentence *over* it — it may reorder or summarise, but it **adds no fact** the account does not carry. So the model can be light and fast; the truth is underneath and always shown. This is the accountability guarantee restated: a scope-creep detector whose headline could hallucinate is worthless, so the headline is explicitly subordinate to the facts, and the facts render with or without it.

## Follow the shipped light-producer pattern

This is the fourth light producer in the same mould (rollup narration #70, refine #19, draft-pr-body #74). Reuse that spine, do not invent a new one:

- **Core producer** `buildDeltaDigest`: a pure-ish function of `(DeltaAccount, modelRunner, budget?)`. It resolves the `delta-rereview-summary` seat via `resolveAssignment`, consults `budget?.tryConsume(purpose) ?? absentBudgetGrant(purpose)` (an ABSENT budget runs ungated — no budget means no ceiling, not no spend), runs ONE light turn over a bounded prompt built from the account, and returns `{ status: "drafted", text, model } | { status: "unavailable", reason }`. Fail closed: a budget refusal, a thrown seat, an empty/whitespace result, or a deterministic seat resolution all yield `unavailable` — never a fabricated digest.
- **Bounded prompt.** The prompt is built only from the structured account (each ask's path + status + summary, and the beyond-asks paths). No repo content, no diff — the model sees only what the facts already state, which structurally prevents it inventing facts. The prompt instructs: one or two sentences, name what was addressed / left / done beyond the asks, plain English, no markdown.
- **Protocol** `review.deltaDigest`: input `{ commandId, reviewId }`; output the discriminated `{ status: "drafted", text } | { status: "unavailable", reason }` (mirrors `review.draftPrBody`). Named in the schema so nothing is stripped at IPC.
- **Dispatch**: an optional `draftDeltaDigest?` dep. The handler resolves the latest review, reads its `deltaAccount` (absent ⇒ `unavailable`, "no delta account on this review"), and calls the dep; a composition without the dep answers an honest `unavailable`, never throws.
- **Root**: compose `draftDeltaDigest` over the live council light runner (the same seat resolution + budget the other live producers use), in `apps/desktop/src/main/index.ts`. A `delta-digest-live.ts` module wraps the core producer (mirroring `draft-pr-body-live.ts`).

## Rendering (Zone A) — facts first, digest second

`DeltaAccountPanel` already renders the facts. Add an optional `digest?: string` prop it renders as a headline ABOVE the asks, with the honest "written from the facts below · light model" marker. In `app.tsx`: when `review.deltaAccount` is present, render the panel immediately (facts now) and fire `review.deltaDigest` once for that review; on a `drafted` result, pass the text into the panel; on `unavailable` (or error), the panel simply shows no headline. Guard so the digest fires at most once per (review, deltaAccount) — a re-render must not re-request, and a new re-review (new account) requests afresh. The facts never wait on the digest.

## Model-free floor — the proof

The red-then-green: build the account, stub the seat to throw, assert the command returns `unavailable` and the panel still renders every fact with no headline and no error thrown. If the digest's absence ever degrades or blanks the facts, the subordination is broken. A second pin: `buildDeltaDigest` over an account with a deterministic seat resolution (no model available) returns `unavailable` without a turn.

## What it must not do (Rule Zero)

The digest is informational. It never blocks re-review, never gates sign, never demands acknowledgement, and never posts anywhere. It is not a consent surface. It adds a sentence the reviewer may read or ignore.

## What stays untouched

`delta-account.ts` (the deterministic computation), the fold wiring, and the `DeltaAccount` shape are unchanged — the digest is strictly additive. The hunk-grain beyond-asks follow-up (#73) is out of scope.
