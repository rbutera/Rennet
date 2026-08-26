# Context packet — B3 protocol-contracts

Read `openspec/BUILD-LOOP.md` first. Plan row: B3. **This change gates Track C proper — its shapes are the frozen contract the client consumes.**

## Objective

Restructure `packages/protocol` into contract folders, one public seam each (engine asset §2):

- `board/` — the #462 host schema: 12 kinds + shared envelope in Zod on `@whiteboard/core`'s authoring kit (structured `author {kind}`, `severity high|medium|low`, `code_ref` cites patchset, no `custom` kind, no protocol relations). `DraftBoardSchema` **derived** from `HostBoardSchema` by `omit` — never hand-written — with a drift test that fails if derivation breaks. Exports `parseDraft`, `Blemish`, `Violation`. Plus the **`LensBoard` projection shape** (client asset risk 1 — it does not exist anywhere today; the client must not invent it).
- `commands/` — the #465 registry: `{id, args, label, exposure:{ui,commandMenu,agent}, locus}`, absorbing today's `commandDefinitions`. One table, three readers (sidebar, ⌘K, `app_*` tools).
- `session/` — session, claim, review, generation, round, harness cursor, thread/anchor shapes (#466, #457).
- `delta/` — patchset, hunk id, code-ref, knowledge statement, related-context dossier item (#461), **and the patchset span-read command** (client asset risk 2 — citations hydrate from the captured patchset, never a working tree).
- `manifests/` — council job ids, lens ids, prompt ids as data.

## Out of scope

Implementations (runtime B4+, dispatch rebuild B10). Shapes and their tests only.

## Blocked by

B2. Note: `@whiteboard/core` must be on npm (Track A5) for the `board/` folder's authoring-kit dependency — if A5 hasn't shipped, stub the kit import behind a local interface and swap on alpha.

## Sources

- Host schema: https://github.com/rbutera/rennet/issues/462 · element/board model: https://github.com/rbutera/rennet/issues/457
- Commands: https://github.com/rbutera/rennet/issues/465 · session: https://github.com/rbutera/rennet/issues/466 · dossier: https://github.com/rbutera/rennet/issues/461
- Engine asset §2 protocol + risk 4 (drift tests): https://github.com/rbutera/rennet/issues/489#issuecomment-5431046330
- Wire shapes: whiteboard `spec/` corpus (#456, in the whiteboard repo once it exists)
- Docs: `docs/developing/reference/protocol-compatibility.md`

## Verification

- `pnpm check` green; the two derivation-drift tests exist and a deliberate schema edit makes them fail (run once, revert).

## Completion sigil

`<promise>B03-COMPLETE</promise>`
