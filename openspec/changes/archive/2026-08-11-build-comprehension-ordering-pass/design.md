## Context

Issue #9 is the ordering pass. #7 gives the deterministic dependency-DAG baseline order; #8 gives the admitted decomposition (chunk set plus graph) and the generation infrastructure. This slice adds the agent-owned comprehension-ordering document and the pass that produces it, reusing #8's contract/validator/retry/fallback machinery verbatim.

## Goals / Non-Goals

- Goals: a validator-admitted `ordering` document; totality and no-minted checked; the deterministic baseline as the always-present fallback; a consumer surface that yields the live order and records which one is live; NO user-approval step.
- Non-Goals: within-cohort element ordering for the decisions lens; the rendered canvas; the salience within-cohort tiebreak; blind-comparison quality measurement. All deferred.

## Decisions

### A distinct `ordering` document, not an extension of `decomposition.proposal`
The issue offers either. A distinct type is the RSP-native choice: adding a docType is a well-trodden path (enum + registry + body schema + rules), and the ordering document has a genuinely different shape and admission contract from the decomposition proposal (it declares no chunks, mints no ids, and orders a set it was handed). Overloading the proposal body would conflate two admission contracts and blur what "the agent produced" means at each stage.

### The ordering document orders the decomposition's chunk set; it declares nothing
The body is `{ readingOrder: string[]; rationale: string }`. `readingOrder` references chunk ids from the admitted decomposition. Totality and no-minted are checked against the OFFERED CHUNK id set (the analogue of the decomposition's totality over the offered HUNK set), which is why `validateBodyRules` now takes the whole manifest and each family derives its own kind. Chunk ids are bare (consistent with the decomposition's own `readingOrder`), not `rennet:chunk/...` anchor strings, so the rules are body rules, not generic anchor checks.

### The baseline is the admitted decomposition's reading order; it is also the fallback
`runOrderingPass` takes a `DecompositionProposalBody` (chunks plus baseline `readingOrder`). The baseline is that body's `readingOrder` — the deterministic DAG topological order the floor produced, or the topological linearisation #8 admitted. On terminal failure the deterministic fallback body IS the baseline order, so the live document always carries a valid order and `provenance.route` records whether it is `agentic` or `deterministic`. "Canvas placement consumes the agent order when admitted, the baseline otherwise; provenance records which is live" is therefore a property of the returned document, not a separate branch a consumer must get right.

### No approval command, enforced structurally
Ordering is agent-owned (Q2, 2026-08-06: "too much effort from the user"). There is no `ordering.approve` command in the registry, and a test asserts the registry contains no ordering-approval command. "The human does not approve ordering" is a property of the wiring, not a prompt.

### Fail-closed on hard-constraint violation
If the agent order violates the baseline's hard dependency constraints or the validator rejects it, the pass falls back to the deterministic baseline. The floor doctrine: a valid order always stands, and the honest-null is the baseline, never a spinner.

## Risks / Trade-offs

- `validateBodyRules`'s signature changes from `offeredHunkIds` to the offered manifest. Blast radius is one internal caller (`validateDocument`); the decomposition tests go through `validateDocument` and are unaffected, and no external package imports `validateBodyRules`.
- Slice-1 orders the sequence-angle chunk set only. The decisions-lens within-cohort ordering is a superset problem deferred to a follow-up; the document shape (a flat reading order over ids) generalises to it without a breaking change (a future cohort-hierarchy body is a new schema version or a new field, additive).

## Migration Plan

Additive. New docType, new body schema, one internal signature change. No data migration; no consumer exists yet (the canvas is a later slice).
