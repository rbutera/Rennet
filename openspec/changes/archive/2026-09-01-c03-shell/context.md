# Context packet — C03 shell

Read `openspec/BUILD-LOOP.md` first. Plan row: C3.

## Objective

The three-region frame per INVENTORY §1 (63 claims): frame + resize divider, sidebar (collapse/rail, projects + sessions trees, Search → New Chat → Add Project → Add Environment block, Update/Help/Settings), 56px top bar with trail + Map·Diff pill slot, chat dock slot (dock itself is C7). **Sidebar is a rewrite**: tree from server projection, every mutation (rename, pin, archive) a command via `useMutation`, highlight derived from route; port row JSX only, through the fence. Fold state in the `ui` slice. Chat column hidden by width-zero + `inert`, never unmounted (R47 — the C1 test guards it).

## Out of scope

Chat dock internals (C7), command menu (C11), coach marks (C13), the surfaces the shell hosts.

## Blocked by

C1, C2. Session rows need B9's projections; stub via `MemoryBridge` until then.

## Sources

- Inventory §1 — every claim tagged `[ws:C3]` at kickoff; ruling refs inline (R35 sidebar rework, R47, R56...)
- Rulings thread: https://github.com/rbutera/rennet/issues/458
- Client asset §1 shell + §5 sidebar row: https://github.com/rbutera/rennet/issues/489#issuecomment-5431046569
- Autopsy S5 (`app-sidebar.tsx` 787 lines / 17-prop interface — the anti-pattern), fence addendum: https://github.com/rbutera/rennet/issues/489#issuecomment-5431046732
- Spike reference (read-only): `spikes/board-prototype/components/{shell,app-sidebar,resize-handle}.tsx`

## Verification

- `pnpm check` green. E2E: drive the real app — collapse/expand sidebar, rename a session, archive it, deep-link a session URL cold; every §1-tagged claim spot-checked against the running client.

## Completion sigil

`<promise>C03-COMPLETE</promise>`
