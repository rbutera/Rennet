## Why

Ordering is the product. The whole value of Rennet over "read the changed files top-down on GitHub" is the reading order plus the cohorts plus the surfaced decisions (Product and Vision §3). Issue #7 shipped the deterministic dependency-DAG order as the baseline; issue #8 shipped the admitted decomposition (the chunk set plus its graph) and the fleet-generation infrastructure (the seven-slot prompt contract, the RSP validator dispatch, the retry loop, the deterministic floor fallback). What is missing is the comprehension-ordering pass itself: ask an agent whether the baseline order is the clearest way to understand this change, or whether a better high-level-then-bottom-up structure exists, and let the agent PRODUCE the final reading order as a validator-admitted RSP document.

Two properties are load-bearing and settled (Contracts and Rulings §1, correction 8; Q2 2026-08-06): the ordering is agent-owned (the user does NOT approve it, structurally there is no such command), and it is logical, never danger/blast-radius/salience. The deterministic baseline stays as the fallback whenever the agent ordering is rejected or absent (the floor doctrine).

This slice builds exactly the mechanism, reusing #8's generation infrastructure end to end. Cohort-hierarchy (within-cohort element ordering for the decisions lens), the rendered canvas UI, the salience within-cohort tiebreak, and the blind-comparison quality measurement are deferred to follow-up beads under umbrella `workspace-3svrc`.

## What Changes

- Add the `ordering` document type to `packages/types` and `packages/protocol`: a new closed-enum `RspDocType` member, an `OrderingBody` interface (`{ readingOrder: string[]; rationale: string }`), an atomic `DOC_TYPE_REGISTRY` entry, a Zod body schema, and its `bodyJsonSchema` projection. The ordering document references only chunk ids the admitted decomposition declared (no minted identity), orders every one of them exactly once (totality), and carries a required rationale.
- Add the ordering body validator rules to `packages/protocol` (extending #6's generic gate, dispatched from `validateDocument` alongside the decomposition rules). `validateBodyRules` now receives the whole offered manifest so each family derives the id set it cares about (decomposition over `hunk` occurrences, ordering over `chunk` occurrences). Three new rules, all atomic: V111 totality/cover (`readingOrder` lists every offered chunk exactly once; a missing element and a duplicate both reject), V112 no minted identity (every ordered id is an offered chunk id; a fabricated id rejects), V113 required rationale. Shape failures reject with the shared V108 gate. The generic anchor/quote/vocabulary/identity guarantees and the decomposition rules are unchanged.
- Add the `ORDERING_CONTRACT` (`ordering@1`) to `packages/instructions`: a seven-slot base instruction whose ordering slot hard-wires correction 8 (logical, first principles, high-level then ground-up; never salience/danger/blast-radius) and whose failure valve emits the baseline unchanged rather than dropping a chunk. It does not restate a JSON schema.
- Add the comprehension-ordering pass to `packages/core` (`ordering-pass.ts`): `buildChunkManifest(proposal)` (the chunk occurrences an agent may cite), `deterministicOrderingBody(proposal)` (the baseline reading order projected into a valid ordering body, the always-present offline fallback), `runOrderingPass(...)` (assemble the contract prompt over the chunk ids plus their baseline order, drive an injected session, stamp a trustworthy `ordering` envelope around the agent body, validate, retry on rejection up to twice sharing the budget, and fall back to the baseline on terminal failure or hard-constraint violation), and `resolveLiveOrder(result)` (the consumer surface: the agent order when admitted, the baseline otherwise, with the provenance route recording which is live).

## Capabilities

### New Capabilities

- `ordering-document`: The `ordering` RSP document type, its body schema, and its validator rules (V111 totality, V112 no-minted, V113 rationale) dispatched from the generic gate.
- `comprehension-ordering-pass`: The chunk-manifest builder, the deterministic baseline fallback body, the agent-driven ordering orchestration with retry and floor fallback, and the live-order resolver that records which order is live.

### Modified Capabilities

- `rsp-validator`: `validateBodyRules` receives the offered manifest (not a pre-filtered hunk-id set) so it can dispatch both the decomposition and ordering families; the decomposition rules and every generic guarantee are behaviourally unchanged.

## Impact

- Adds `packages/core/src/ordering-pass.ts` (re-exported, colocated-tested). Extends `packages/types/src/index.ts`, `packages/protocol/src/{rsp,bodies}.ts`, and `packages/instructions/src/index.ts`. No new package, no new external dependency, no dependency-arrow change: architecture and licenses gates are untouched.
- No user-approval command is added for ordering, by design and asserted structurally (the command registry contains no ordering-approval command). Ordering is an agent-owned comprehension task.
- Deferred to follow-up beads under umbrella `workspace-3svrc`: within-cohort element ordering for the decisions lens (the richer cohort-hierarchy model); the rendered canvas that switches between live and baseline order; the salience within-cohort tiebreak (needs Rai, Canvas Paradigm OQ2); and the blind-comparison quality measurement on 8-12 real PRs (spike 4, explicitly non-blocking per the issue's acceptance note).
