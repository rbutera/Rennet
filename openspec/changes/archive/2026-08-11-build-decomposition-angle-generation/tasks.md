## 1. Shared types (types)

- [x] 1.1 Add `ChunkAngle` (`sequence | decisions | claims | blast-radius`) and the decomposition body interfaces (`ProposalChunk`, `DecompositionSkeletonBody`, `DecompositionProposalBody`)
- [x] 1.2 Add the route-plan shapes (`InvocationTier`, `PlannedInvocation`, `RoutePlan`, `RoutePlanRefusal`, `RoutePlanResult`)

## 2. The prompt contract (instructions — new package)

- [x] 2.1 Scaffold `packages/instructions` (package.json, project.json, tsconfig, `layer:instructions` tag); wire the new arrows into `scripts/check-boundaries.mjs` and `eslint.config.mjs`; pnpm install links it
- [x] 2.2 Add the seven-slot `PromptContract` model and `renderBaseInstruction(contract)`; the ORDERING slot hard-wires logical/first-principles ordering, never salience/danger
- [x] 2.3 Author the two M0 contracts: `decomposition.skeleton@1` and `decomposition.proposal@1`; neither restates a JSON schema
- [x] 2.4 Add `assemblePrompt` — fixed composition order, layer-labelled, byte-budgeted, base NEVER truncated (later layers drop first)

## 3. Decomposition body schemas + rules (protocol)

- [x] 3.1 Add `bodies.ts`: Zod body schemas for `decomposition.skeleton`/`decomposition.proposal`, `bodyJsonSchema(docType)`, `CHUNK_ASSIGNABLE_ANGLES`
- [x] 3.2 Implement V100 (totality partition), V103 (acyclic + topological cover), V104 (angle restriction), V106 (graph completeness)
- [x] 3.3 Dispatch the body validators from `validateDocument` (atomic merge into the reject path); the generic anchor/quote walk is unchanged

## 4. Diff-to-angles machinery (core)

- [x] 4.1 Add `buildOfferedManifest(decomposition, patchset)` — hunk occurrences with per-side line text
- [x] 4.2 Add `buildRoutePlan(decomposition, opts)` — the initial-decomposition plan; REFUSES over `maxHarnessInvocations` (default 5) before any model runs
- [x] 4.3 Add `deterministicProposalBody(decomposition)` — the floor projected into a valid proposal body (the offline fallback)
- [x] 4.4 Add `runDecompositionAngle(...)` — assemble → drive injected session → stamp envelope → validate → retry ≤2 sharing budget → fall back to floor on terminal failure

## 5. Tests + gates

- [x] 5.1 Contract: render is deterministic, includes all seven slots incl. logical ordering, never restates a schema; assembly order fixed + layer-labelled; base survives a tight budget while later layers drop
- [x] 5.2 Body rules: one fixture per rule in both directions — totality partition (V100), cyclic edges + reading-order gaps (V103), a chunk assigned `noise`/`spec` (V104), a dangling/duplicate chunk id (V106)
- [x] 5.3 Brita filter (red-then-green): the plan for the largest fixture never exceeds five invocations; a seeded sixth is refused
- [x] 5.4 Orchestration (hermetic FakeSession): admit path; reject-then-retry-admit; terminal-reject falls back to the deterministic floor with a visible provenance route
- [x] 5.5 Red-then-green proof on the V104 angle-restriction rule (named test reddens on revert, restores green)
- [x] 5.6 Gated real-turn integration test (`RENNET_LIVE_CLAUDE`) driving the live SDK for one tiny decomposition; excluded from the default gate
- [x] 5.7 Full `pnpm check` green across all projects (format, architecture, licenses, lint, typecheck, test, build)
- [x] 5.8 File follow-up beads: decisions/spec/claims/noise body schemas + generation; live batching-curve on a real fixture; the SDK JSON-Schema-subset probe; additional spec parsers; `validation.report` as a persisted document
