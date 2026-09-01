# Context packet — C05 board-surface

Read `openspec/BUILD-LOOP.md` first. Plan row: C5. The biggest surface (INVENTORY §3, 137 claims).

## Objective

The lens board document: **element registry** — one renderer file per #462 kind, registry maps kind→renderer, `assertNever` default (adding a kind is a compile error until rendered; the spike's 325-line switch with silent `default: return null` is the named anti-pattern, autopsy S4). Fold grammar on the `collapse` primitive, section rollups, durable quote highlights + anchored threads (refs from boards, content transcript-side), prose + selection controls (C4 components), Design/Findings board compositions, lens switcher (absent-not-disabled — a lens with no board yields no segment), delta marks (`new|reworked`, transient gold dot, lens-segment rollup, clears on interaction), generation drill-down to frozen drafts. Data: the `LensBoard` projection (B3) via `useCommand`; **the client never invents board shape locally**. Port element JSX per kind through the fence; the spike's `lib/lens-data.ts` model informed the protocol shape — the protocol wins on any divergence.

## Out of scope

Diff (C6), exits (C8), round report rendering (C9 — it reuses this registry).

## Blocked by

C4; B3 shapes; live data needs B4+B8 (build against `MemoryBridge` boards first — the spike fixtures convert into fixture bridges here).

## Sources

- Inventory §3, tagged `[ws:C5]` at kickoff (R17–R22, R44–R50 refs inline); rulings thread: https://github.com/rbutera/rennet/issues/458
- Kinds: https://github.com/rbutera/rennet/issues/462 · topology/generations: https://github.com/rbutera/rennet/issues/457 · delta marks: https://github.com/rbutera/rennet/issues/486
- Client asset §1 board + risk 1: https://github.com/rbutera/rennet/issues/489#issuecomment-5431046569
- Autopsy S4 + keep-list + fence: https://github.com/rbutera/rennet/issues/489#issuecomment-5431046732
- Spike reference (read-only): `spikes/board-prototype/components/lens-board.tsx`, `lib/lens-data.ts`, `lib/fixtures/`

## Verification

- `pnpm check` green. E2E: render a full fixture board set — every kind renders, an unregistered kind fails compile (positive control), folds/threads/delta marks behave per tagged claims; then a live B8 board renders identically.

## Completion sigil

`<promise>C05-COMPLETE</promise>`
