## Why

Issue #8 turns the deterministic floor (#7) and the RSP core (#6) into a fleet pipeline: point a harness at a patchset and get validator-admitted RSP documents for the decomposition angle, under a mechanical budget gate, generated through a per-angle prompt contract. The floor already produces a complete decomposition; the RSP validator already resolves anchors and byte-matches quotes generically. What is missing is the three pieces that make "diff to angles" a real transformation: the versioned prompt contract that instructs an agent what to emit and how to fail, the route-plan budget gate that bounds the transformation before any model runs, and the per-body validator rules that let the gate decide admission of the decomposition documents themselves (totality, an acyclic reading order, and the closed set of chunk-assignable angles).

This slice builds exactly those three, plus the thin orchestration that ties them into one transformation, hermetically testable with an injected session. Ordering emitted here is the floor's provisional dependency order; the final comprehension ordering is #9's job and is out of scope. Decisions, spec, claims, and noise body schemas, the live-model batching-curve measurement, and the SDK schema-subset probe are deferred to follow-up beads under umbrella `workspace-3svrc`.

## What Changes

- Add `packages/instructions` (new, MIT, node-free, depends on `@rennet/types` only): the RSP prompt contract. A uniform seven-slot `PromptContract` (role, emit, input, discipline, failure valve, ordering, guidance slot), the two M0 decomposition base instructions (`decomposition.skeleton@1`, `decomposition.proposal@1`), and a deterministic byte-budgeted `assemblePrompt` that composes base then guidance layers in the fixed order and never truncates the base. The ORDERING slot hard-wires correction 8: logical dependency, first principles, ground-up, never salience/danger/blast-radius. No instruction restates a JSON schema (two sources of truth for one shape is how they drift).
- Add the decomposition body schemas and their validator rules to `packages/protocol` (extending #6's generic gate): `decomposition.skeleton` and `decomposition.proposal` body Zod schemas, a `bodyJsonSchema` projection for the structured-output constraint, and a `BODY_VALIDATORS` registry dispatched from `validateDocument`. Four new rules, all atomic (graph documents reject wholesale): V100 totality (`⋃chunks.hunkIds ∪ residue == the offered hunk set`, exactly — a partition, no missing, no extra, no double-placement), V103 acyclic reading order (edges are a DAG and `readingOrder` is a topological cover of every chunk exactly once), V104 angle restriction (a chunk may only declare `sequence | decisions | claims | blast-radius`; noise and spec are never chunk-assignable), and V106 graph completeness (every chunk id in `edges`/`readingOrder` is a declared, uniquely-named chunk).
- Add the diff-to-angles machinery to `packages/core` (depends on `@rennet/instructions` too): `buildOfferedManifest` (the deterministic hunk manifest an agent may cite), `buildRoutePlan` (the invocation plan for initial decomposition, which REFUSES a plan exceeding `maxHarnessInvocations` — default 5 — before any model runs), `deterministicProposalBody` (the floor's decomposition projected into a valid proposal body, the always-present offline fallback), and `runDecompositionAngle` (assemble the contract prompt, drive an injected session, stamp a trustworthy envelope around the agent's body, validate, retry on rejection up to twice sharing the budget, and fall back to the deterministic floor on terminal failure).

## Capabilities

### New Capabilities

- `angle-prompt-contract`: The uniform seven-slot per-angle prompt contract, the two M0 decomposition base instructions, and deterministic layer assembly with a never-truncated base.
- `decomposition-angle-generation`: The offered-manifest builder, the route-plan budget gate (the CI-tested Brita filter), the deterministic proposal fallback, and the retry-loop orchestration that drives a harness to a validator-admitted decomposition document.

### Modified Capabilities

- `rsp-validator`: Gains per-body schemas and rules for the decomposition documents (V100/V103/V104/V106), dispatched from the existing generic gate; the anchor/quote/vocabulary/identity guarantees are unchanged.

## Impact

- Adds `packages/instructions/**` (new Nx project, `layer:instructions` tag, arrows: instructions to types; core gains an arrow to instructions in `scripts/check-boundaries.mjs` and `eslint.config.mjs`). Adds `packages/protocol/src/bodies.ts` and `packages/core/src/{manifest,route-plan,angle-generation}.ts`, all re-exported and colocated-tested.
- `pnpm-lock.yaml` changes to link the new workspace package and core's `workspace:*` edge to it. No new external production dependency: instructions is dependency-free, and body-to-JSON-schema reuses the `zod` already in protocol.
- Deferred to follow-up beads (this is slice 1 of umbrella `workspace-3svrc`): decisions/spec/claims/noise body schemas and their generation passes; the live-model end-to-end on a real fixture PR and the batching-curve measurement; the SDK JSON-Schema-subset probe and the flattening fallback; additional deterministic spec parsers; and the full `validation.report` surfacing as its own persisted document. #9 owns the final comprehension ordering.
