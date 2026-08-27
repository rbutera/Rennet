# B06 — context-map-swarm (#460: partitioned knowledge swarm on the Model Council)

Packet: `context.md` (scope authority). Plan row B6. Blocked-by B3 (landed). Authored 2026-08-27 against main @ 4fad6d62 (B05 landed, C01 merged).

## What this change does

Implements #460's resolved architecture, replacing the single flat knowledge pass (the `DEFAULT_KNOWLEDGE_MAX_FILES = 400` git-order cap and its silent ~10% coverage):

- **Partitions are invisible plumbing** (`core/knowledge/`): one worker slice per workspace scope from the structural map (`project-context.ts` scopes); oversized scopes subtree-split under a ~120-file per-worker cap; plain directory split when scope detection finds nothing. Coverage total by construction — every in-scope file in exactly one slice. No partition-shaped artifact survives the run.
- **Light-tier workers emit full statements at the edge**: the existing statement schema with the shipped mint-time honesty contract (anchors resolved to blobOids from the snapshot inventory, anchor-or-drop, hypothesis label) plus one optional free-text `hint` for the synthesizer — discardable, never stored.
- **A verify/synthesis seat confirms hypotheses itself** (human confirm stays an optional override, never a gate — Rai's ruling + Rule Zero): re-reads each hypothesis's cited spans (bounded by anchors, not a repo re-read), flips to `confirmed`/`rejected`, mints the cross-cutting statements no single worker could see, dedups.
- **Incremental thereafter**: on baseline advance only workers whose slice contains changed paths re-run; the verify seat re-adjudicates only statements whose cited evidence changed; everything else carries verbatim; cross-cutting statements re-verify when any cited path changed.
- **Knowledge stops bypassing the Model Council**: `partition-worker` (light) and `map-verify` (heavy seat, medium-class model) enter the three versioned assignment tables in `core/model-council.ts`; adapters resolve the assignment and run the turn on the resolved harness (cheap Codex for the light volume in the both/codex-only scenarios, per R39).
- **No cost cap** (decided): the swarm path takes no `InvocationBudget`; R10 stays intact for every other model path.
- Scheduling lives in `server/runtime/` (new), with per-partition progress lines (queued / running / statement counts) and the verify stage as its own line.

## Out of scope (consume shapes only)

Lens agents consuming statements (B8); project-scout (B7); the context-map UI (C12). `KnowledgeStatement`/`KnowledgeSet`/`KnowledgeAnchor`/`KnowledgeStatus` and the council manifest ids are B03-frozen protocol contracts — consumed, never re-modeled.

## Reconciliation ledger

1. **The job ids already exist in protocol.** Packet says "add the versioned job ids"; B03 already encoded `partition-worker` and `map-verify` in `COUNCIL_JOB_IDS` (`protocol/src/manifests/index.ts:49`). The B06 work is the CORE table rows: `JOB_CATALOGUE` entries + three assignment-table rows in `core/model-council.ts` (`CouncilJobId` is `string`, so no protocol type touch). Routing stays in core exactly as the manifest's JSDoc says.
2. **"map-verify medium" is the model class, not a tier.** The council has tiers light|heavy|deterministic. `map-verify` lands as a HEAVY-tier job whose both-scenario pick is `sonnet-5`/`medium` (#460 point 4 verbatim); `partition-worker` is light on `gpt-5.6-luna` (both/codex-only) and `haiku` (claude-only). Effort values where #460 is silent follow the house `[extrapolated]` convention already used in the tables.
3. **`server/runtime/` does not exist.** Today's scheduling is `create-server.ts:1338` + `cli.ts:586` calling adapters' `enrichKnowledgeForRepo`. Verdict: create `server/runtime/knowledge-swarm.ts` as the scheduler home (packet names the folder), re-point both callers, and the implementer records the actual wiring point in this ledger (B04 precedent).
4. **No-cost-cap vs the existing R10 plumbing.** `runKnowledgeEnrichment`/`runKnowledgeDeltaPass` are budget-gated; #460 point 5 rules the map path uncapped ("R10 budget refusal does not gate this path"). The swarm functions take no budget parameter at all — uncapped by construction, no bypass flag, R10 untouched elsewhere.
5. **deterministic E2E — RULED (track-b, 2026-08-27): approved as proposed.** Model-backed generation cannot run in the gate. Chosen approach: the swarm's plumbing (partitioning, mint honesty, verify flow, incremental routing, carry) is pure over the injected `runTurn` seam the flat pass already established — the packet E2E runs against THIS repo's real snapshot with a deterministic stub `runTurn` (canned statements derived from the slice it is handed); the council-routed REAL path is proven by contract tests (resolveAssignment routing per scenario + turn-construction assertions against the harness port), never a live model in the gate.
6. **flat-pass retirement — RULED (track-b, 2026-08-27): migrate-callers-then-delete approved.** #460's question text says "replace the single flat knowledge pass". Verdict: migrate-callers-then-delete — the shared mint/honesty helpers are extracted and reused by the swarm, then `runKnowledgeEnrichment`, `runKnowledgeDeltaPass`, `DEFAULT_KNOWLEDGE_MAX_FILES`, and their adapters orchestration are deleted once the swarm path is wired. No dormant legacy path kept.
7. **`hint` is worker-output-only.** It exists in the worker output schema and dies at synthesis — never enters `KnowledgeStatement` (protocol untouched), matching "discardable, never stored".
8. **Verify needs no protocol change.** `KnowledgeStatus` already carries `hypothesis|confirmed|rejected` with rejection-as-recorded-state semantics (`citations.ts:150`) — the verify seat writes the existing vocabulary.
9. **Amendment (cluster 2): `core/src/knowledge.ts` re-homed as `knowledge/read.ts`.** Creating the packet-mandated `core/knowledge/` folder collided with the existing `knowledge.ts` file (module resolution would let the file shadow the folder at `./knowledge`). The pure read side moved into the folder as `read.ts` (git mv, content unchanged except relative-import depth); the folder index re-exports it, so every `./knowledge` / `@rennet/core` importer keeps compiling verbatim. Zero consumer edits.

## Verification (packet)

`pnpm check` green. E2E against this repo itself: partitions cover every in-scope file exactly once; emitted statements carry anchors that resolve against the snapshot; a second run after a small commit re-processes only touched partitions (carry visible in the output). Positive controls that can fail (drop a file from every slice → coverage assert fails; break anchor resolution → mint drops the statement and the assert fails; touch one file → exactly the owning partition re-runs).
