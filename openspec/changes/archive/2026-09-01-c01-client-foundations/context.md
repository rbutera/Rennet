# Context packet — C01 client-foundations

Read `openspec/BUILD-LOOP.md` first. Plan row: C1. Every later C-change builds on these seams — get them right, keep them thin.

## Objective

The four client foundations (client asset §2–4):

- **Data seam**: `app-ui/src/data/` — `BridgeProvider`/`useBridge`, `useCommand`, `useCommandStream` (pushes into the same cache entry), `useMutation` (invoke + invalidate). **Standing law: no component calls `bridge.invoke` directly.** Cache: evaluate `@tanstack/react-query` against `docs/developing/reference/dependency-standard.md`; if rejected, the ~120-line `Map` + `useSyncExternalStore` fallback — same hook surface either way so the swap stays internal.
- **Router**: injected history (hash in Electron, browser in the served tab), the #480 route table (`/` → `/new-chat`, `/s/:slug` + `?view/?lens/?file`, `/s/:slug/run`, `/archived`, `/projects/:id/{indexing,map}`, `/settings/:page`). Layout route owns sidebar + chat dock **outside the outlet**. Retire `app-ui/src/nav/history.ts`.
- **Store**: one zustand store, slices `ui`/`review`/`run`/`signal`, no persist; selectors beside their slice; derive-don't-store. No `sidebar` slice — the tree is a projection.
- **Test rig**: `MemoryBridge implements RennetBridge` in `app-ui/src/test/`; spike scenarios become fixture bridges. This is what makes INVENTORY §13 self-enforcing.

## Out of scope

Any surface. URL grammar beyond #480. Porting spike state code (autopsy S1/S3/S9 are the anti-patterns this change exists to prevent).

## Blocked by

Nothing hard — runs against existing commands; board-shaped queries stub until B3. Track C proper waits on B3.

## Sources

- Nav/state decision: https://github.com/rbutera/rennet/issues/480 · session identity: https://github.com/rbutera/rennet/issues/466
- Client asset §2–4 + risk 4: https://github.com/rbutera/rennet/issues/489#issuecomment-5431046569
- Autopsy S1/S2/S3/S9 (what not to rebuild): https://github.com/rbutera/rennet/issues/489#issuecomment-5431046732
- Inventory §2 (41 claims, nav + state): `spikes/board-prototype/INVENTORY.md`
- Incumbent to dismantle: `packages/app-ui/src/app/shell.tsx` (3,150 lines, ~25 invoke-effects)

## Verification

- `pnpm check` green. Tests: chat-dock DOM node survives a settings round-trip (risk 4); a component importing `bridge` directly fails lint; `MemoryBridge` boots the app shell with zero fixture imports under surface dirs.

## Completion sigil

`<promise>C01-COMPLETE</promise>`
