# Context packet — B6 context-map-swarm

Read `openspec/BUILD-LOOP.md` first. Plan row: B6.

## Objective

Implement #460: scope-graph partitions as invisible plumbing (~subtree-split oversized, directory fallback), light-tier workers emitting full anchored statements (+ discardable `hint`), a medium verify/synthesis seat that confirms hypotheses itself (human confirm optional, never a gate) and mints cross-cutting statements, incremental partition-routed delta with carry on baseline advance. Plan lives in `core/knowledge/`, workers run via `adapters`, scheduled by `server/runtime/`. Council: knowledge stops bypassing the Model Council; add the versioned job ids (`partition-worker` light on cheap Codex, `map-verify` medium on Claude; claude-only/codex-only covered). No cost cap (decided).

## Out of scope

Lens agents consuming the statements (B8); project-scout (B7). The context-map *UI* is C12.

## Blocked by

B3 (statement + manifest shapes). Independent of B4/B5 — may run parallel to them within the track at the orchestrator's discretion, but the plan's default is serial.

## Sources

- The decision: https://github.com/rbutera/rennet/issues/460
- Council tables: `packages/core/src/model-council*` + engine asset §2 core/council: https://github.com/rbutera/rennet/issues/489#issuecomment-5431046330
- Existing spike: `spikes/context-map-view` (reference only) + `packages/app-ui/src/context-map/model.ts`
- Docs: `docs/using/guides/context-map.md`, `docs/developing/concepts/code-intelligence.md`, `model-council.md`

## Verification

- `pnpm check` green. E2E: run generation against this repo itself; assert partitions cover every in-scope file exactly once, statements carry anchors that resolve, and a second run after a small commit re-processes only touched partitions (carry visible in the output).

## Completion sigil

`<promise>B06-COMPLETE</promise>`
