## 1. Shared types (types)

- [x] 1.1 Add `"ordering"` to the `RspDocType` closed enum
- [x] 1.2 Add the `OrderingBody` interface (`readingOrder: string[]`, `rationale: string`) with the totality/no-minted/rationale contract documented

## 2. The ordering prompt contract (instructions)

- [x] 2.1 Author `ORDERING_CONTRACT` (`ordering@1`): seven slots, the ordering slot hard-wires logical/first-principles/high-level-then-ground-up and forbids salience/danger/blast-radius; the failure valve emits the baseline unchanged rather than dropping a chunk; no slot restates a JSON schema
- [x] 2.2 Register it in `BASE_CONTRACTS` so the shared contract tests cover it

## 3. Ordering document schema + rules (protocol)

- [x] 3.1 Add `"ordering"` to `RSP_DOC_TYPES` and `DOC_TYPE_REGISTRY` (atomic, schemaVersion 1)
- [x] 3.2 Add the ordering body Zod schema to `bodies.ts` and its `bodyJsonSchema` projection
- [x] 3.3 Change `validateBodyRules` to receive the offered manifest; derive `hunk` ids for the decomposition family and `chunk` ids for the ordering family; update the single caller in `rsp.ts`
- [x] 3.4 Implement V111 (totality/cover: every offered chunk ordered exactly once; missing and duplicate both reject), V112 (no minted: an ordered id absent from the offered chunk set rejects), V113 (rationale non-empty); shape failures reject with V108

## 4. The comprehension-ordering pass (core)

- [x] 4.1 Add `buildChunkManifest(proposal)` — chunk occurrences from the admitted decomposition
- [x] 4.2 Add `deterministicOrderingBody(proposal)` — the baseline reading order projected into a valid ordering body (the offline fallback)
- [x] 4.3 Add `runOrderingPass(...)` — assemble the contract prompt over the chunk ids plus baseline order, drive an injected session, stamp the `ordering` envelope, validate, retry <=2 sharing the budget, fall back to the baseline on terminal failure
- [x] 4.4 Add `resolveLiveOrder(result)` — the agent order when admitted, the baseline otherwise; the provenance route records which is live

## 5. Tests + gates

- [x] 5.1 Ordering body rules, both directions: a well-formed ordering admits; a fabricated chunk id rejects (V112); an offered chunk missing from the order rejects (V111 totality); a duplicated chunk rejects (V111); an empty rationale rejects (V113); a mis-shaped body rejects (V108)
- [x] 5.2 Contract: `ORDERING_CONTRACT` renders all seven slots, names `ordering@1`, carries the logical-ordering terms and the salience/danger/blast-radius prohibition, and restates no schema
- [x] 5.3 Pass orchestration (red-then-green): admits a valid agent order and stamps the envelope (route agentic); feeds a rejection back and admits on retry; falls back to the baseline when every attempt is rejected and when the turn fails (route deterministic)
- [x] 5.4 Resolver switch fixture: an agent order that differs from the baseline resolves to the agent order (route agentic) when admitted and to the baseline (route deterministic) on fallback; both are valid covers of the chunk set
- [x] 5.5 Structural: the command registry contains no ordering-approval command (the user does not approve ordering)
- [x] 5.6 Full `pnpm check` green across all projects
