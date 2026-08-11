# Design — decomposition angle generation

## Context

The floor (#7) emits a complete `Decomposition` (hunks, classifications, chunks, an import-derived DAG, a topological reading order, an always-empty residue). The RSP core (#6) validates any document's envelope and walks its opaque body generically. This slice makes the model-facing transformation real for the decomposition angle only, and it does so without spending the subscription in the default gate: every unit here is a pure function or is driven by an injected session.

Three packages move, in dependency order:

```
types (add: ChunkAngle, decomposition body shapes, RoutePlan shapes)
  └─ protocol (add: body schemas + V100/V103/V104/V106, dispatched from validateDocument)
  └─ instructions (NEW: PromptContract, the two M0 base instructions, assemblePrompt)
       └─ core (add: buildOfferedManifest, buildRoutePlan, deterministicProposalBody, runDecompositionAngle)
```

## Decision: a new `packages/instructions`, node-free, types-only

The docs name it explicitly (`Rennet Product and Vision` §4.10; issue #8). It is product content plus deterministic assembly — a phone could import it — so it depends on `@rennet/types` only and pulls in no runtime dependency. Digests over the assembled bytes are computed by the caller in `core` (which has protocol's `sha256Hex`), not here, so `instructions` stays a clean leaf and the provenance wiring lives where the run is owned.

New dependency arrows: `instructions → types`, and `core → instructions`. Both are added to the two boundary enforcers (`scripts/check-boundaries.mjs` and the `eslint.config.mjs` `@nx/enforce-module-boundaries` `depConstraints`, via a new `layer:instructions` tag). The graph stays acyclic: protocol never sees instructions.

## Decision: the seven-slot uniform prompt contract

Per the C-angles design (§3.3), a base instruction is a *filled* uniform template, not N bespoke prompts, so the versioned `instruction` provenance block makes each slot's bytes attributable and A/B-able against rejection rate. The slots:

1. ROLE — "you surface, you do not decide; the app validates and renders".
2. EMIT — the single docType by name + version. The JSON schema travels separately as the structured-output constraint; the instruction never restates it.
3. INPUT — the offered occurrence manifest, and the hard rule that every id cited must come from it (never mint identity).
4. DISCIPLINE — anchor + byte-exact quote rules, closed vocabularies.
5. FAILURE VALVE — the honest-null for this angle: emit `residue` rather than dropping an unplaceable hunk; say you could not, never guess.
6. ORDERING — correction 8, hard-wired: logical dependency, first principles, ground-up; NOT salience/danger/blast-radius.
7. GUIDANCE SLOT — wrapped, layer-labelled, untrusted repo text quoted as material, never merged into instruction.

`assemblePrompt` composes the fixed order (base → instructions.general → instructions.angle → instructions.task → instructions.files → context → payload) and is byte-budgeted: when a budget is set and layers overflow, LATER layers are dropped first and the base instruction is NEVER truncated (a truncated base produces a document the validator rejects). Every emitted layer is labelled, so the assembled text is fully attributable.

## Decision: the route plan is the budget gate, refused before any model runs

`buildRoutePlan(decomposition, opts)` returns the ordered `PlannedInvocation[]` for initial decomposition: one heavy skeleton call (first paint), one heavy proposal call, and light rationale calls batched at ≤10 chunks each (never process-per-hunk). It counts harness (heavy + light model) invocations and, if the count exceeds `maxHarnessInvocations` (default 5, R10), returns a refusal rather than a plan. This is the Brita filter: a unit test asserts the plan for the largest fixture never exceeds five, and that a seeded sixth invocation is refused. The gate is mechanical and runs before any spend, so an over-budget change is caught at plan time, not at bill time.

Rationale batching keeps the count bounded regardless of PR size: N chunks cost `ceil(N/10)` light calls, so even a 3,000-line PR stays well under five for the *initial decomposition* plan. (Findings, decisions, and claims are separate later passes, out of this slice and this budget line.)

## Decision: the orchestration stamps the envelope; the agent emits only the body

The agent is schema-constrained to the *body* alone. `runDecompositionAngle` builds the trustworthy envelope around the returned body: it mints the `docId` (ULID, adapter authority), stamps `provenance` (harness/model/tier/route/`runId`, the three-layer capability snapshot, tokens, and `inputDigest` = `computeInputDigest(patchset, manifest)`), and only then validates. This realises "agents never mint identity" structurally — the agent cannot forge a docId or an inputDigest because it never writes them.

On rejection the orchestration builds a machine-readable `validation.report` (the errors, by code and pointer) and retries in the same session, up to two retries sharing the budget. On terminal failure the deterministic floor stands: `deterministicProposalBody(decomposition)` projects the floor's own chunks/edges/reading-order into a valid `decomposition.proposal` body, which is admitted with a visible "generated by the deterministic floor" provenance route. Never a spinner over an empty screen.

## Decision: four atomic body rules, dispatched from the generic gate

Both decomposition documents are `atomic` in the existing `DOC_TYPE_REGISTRY`, so any body error rejects the whole document. `validateDocument` gains a body-validator dispatch: after the envelope checks and the generic anchor/quote walk, if the docType has a registered body validator, run it and merge its errors into the atomic-reject path.

- **V100 totality.** The multiset of `chunks[].hunkIds` ∪ `residue[].hunkId` must equal the set of `hunk`-kind occurrences in the offered manifest, exactly: no missing hunk, no extra/minted hunk, and no hunk placed in two chunks (a partition). This subsumes V008 for the decomposition case and is the "no hunk silently escapes grouping" guarantee.
- **V103 acyclic reading order.** `edges` (proposal only) must be a DAG; `readingOrder` must be a permutation of the declared chunk ids that covers each exactly once and respects every edge (from before to). The skeleton has no edges, so V103 checks only the cover.
- **V104 angle restriction.** Every value in `chunks[].angles` must be one of `sequence | decisions | claims | blast-radius`. A chunk that declares `noise` or `spec` (the two non-chunk-assignable angles) rejects — the deterministic-admission-authority acceptance.
- **V106 graph completeness.** Chunk ids are unique, and every chunk id referenced by an edge or the reading order is a declared chunk.

## Testing strategy

TDD, one fixture per rule in both directions. The Brita-filter refusal is red-then-green proven (assert five passes, seed a sixth, assert refusal). The orchestration is exercised hermetically through a `FakeSession` that yields a scripted body: an admit path, a reject-then-retry-admit path, and a terminal-reject-falls-back-to-floor path. A gated real-turn integration test (mirroring the existing `RENNET_LIVE_CLAUDE` pattern) drives the live SDK for one tiny decomposition and is excluded from the default gate.
