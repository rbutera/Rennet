# Context packet — B5 delta-packet

Read `openspec/BUILD-LOOP.md` first. Plan row: B5.

## Objective

Consolidate `core/delta/`: patchset → hunk index with stable ids, `element-diffs` (the KEEP-list differ — it becomes the hunk-identity + section-carry engine powering lineage carry, the successor account, and composition `delta: new|reworked` stamps), collation/counterpart, blast-radius signal taxonomy (overlay framing dead), openspec parse, deterministic noise pre-classification. Single seam: `buildDeltaPacket(patchset, knowledge, dossier, successorAccount) → DeltaPacket` — **the lens drafters' entire input** (#464: inlined, not tool-fetched). `core/board/successor-account.ts` (renamed in B2) feeds it on rounds.

## Out of scope

Drafter dispatch and composition (B8); knowledge generation (B6); dossier fetching (B7) — B5 consumes their *shapes* from B3.

## Blocked by

B3.

## Sources

- Drafter input spec: https://github.com/rbutera/rennet/issues/464 (the Delta packet contents)
- Derivations that survive as typed-fact producers: #464 dec. 2 + https://github.com/rbutera/rennet/issues/459 KEEP list
- Engine asset §2 core/delta + §5: https://github.com/rbutera/rennet/issues/489#issuecomment-5431046330
- Existing code: `packages/core/src/element-diffs*`, `collation*`, `counterpart*`, `blast-radius*`, `noise*`, `delta-account*` (post-B2 names)
- Docs: `docs/developing/concepts/delta-rereview-and-lineage.md`, `context-assembly.md`

## Verification

- `pnpm check` green. Fixture test: a real captured patchset produces a DeltaPacket whose hunk ids are stable across a re-run and whose successor-account section is present iff a prior generation exists.

## Completion sigil

`<promise>B05-COMPLETE</promise>`
