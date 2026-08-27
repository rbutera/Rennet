# Tasks — b04-boards-runtime (B4, #489)

Read `openspec/BUILD-LOOP.md` and `context.md` first, then `proposal.md` (its Reconciliations section is part of the spec). One cluster per session; the repo compiles and the gate is green after every cluster. Sources of record: #457 (event-log model, append-then-freeze, topology A — comment 2026-08-23), #453 (op-id dedup, get_events, facade constraints), #455 (the five locked tools — final comment), engine asset §2 server + §3 (#489 comment 5431046330), `packages/server/src/projection.ts` + `docs/developing/concepts/architecture-contracts.md` (privacy). Cluster gate = `sh -c 'pnpm nx affected -t lint,typecheck,test'` unless stated.

## 1. Dependency + FileBoardStore

- [x] 1.1 Add `@wboard/server@0.1.0-alpha.2` (exact pin) to `packages/server/package.json`; add `@wboard/server` to `minimumReleaseAgeExclude` in `pnpm-workspace.yaml` (name-scoped, same comment style as the `@wboard/core` entry); `sh -c 'pnpm install'`; licenses gate accepts it (MIT).
- [x] 1.2 Author `packages/server/src/boards/file-board-store.ts`: `FileBoardStore implements BoardStore` rooted at a directory (the runtime will pass `.rennet/boards/` under the project root). Per board: `schema.json` (written once by `createBoard`) and `log.jsonl` (one event per line, appended atomically with contiguous seqs starting at 1; a batch lands contiguously or not at all). Honor the contract's ownership rule (no aliasing caller memory — plain-JSON deep copies on write and read; `structuredClone` is fine). `getEvents(boardId, afterSeq)` streams from the log; unknown board reads yield empty, `getSchema` yields undefined. Node stdlib only.
- [x] 1.3 Tests (`file-board-store.test.ts`, temp dirs): contract behavior (create/getSchema round-trip; append assigns contiguous seqs; getEvents afterSeq filtering; unknown-board semantics; ownership — mutating what was passed/read does not reach stored state), and **durability**: append, drop the store instance, construct a fresh `FileBoardStore` on the same directory, identical events come back.
- [x] 1.4 Cluster gate green. Commit.

## 2. server/boards/ runtime

- [x] 2.1 Author `packages/server/src/boards/boards-runtime.ts`: owns one `BoardService` over a `FileBoardStore` rooted under the review project's `.rennet/boards/`; exposes the service plus `createRennetBoard()` minting a board with `BOARD_WIRE_SCHEMA` from `@rennet/protocol`. No freeze/generation policy (B8/B9 own lifecycle); no transport. Confirm `.rennet/` remains ignored-by-default (no gitignore change should be needed — verify, don't assume).
- [x] 2.2 Tests: in-process round-trip — `createRennetBoard` → `apply` ops valid under the host schema (use a fixture from protocol's board tests as a model) → `getEvents` → `getState`/`project` shows the applied elements; an op invalid under the host schema rejects the whole batch and appends nothing; op_id replay appends nothing (idempotent per #453).
- [ ] 2.3 Cluster gate green. Commit.

## 3. adapters/whiteboard-client.ts — the only writer

- [ ] 3.1 Add the dependency per reconciliation 3 (as ruled by the dispatcher): `packages/adapters` gains `@wboard/server` (type-only usage) — record the ruling outcome here if it differs. Author `packages/adapters/src/whiteboard-client.ts`: a typed client over an injected `BoardService` exposing exactly the five #455 tools — `create(schema)`, `schema(boardId)`, `apply(boardId, ops, actor)`, `describe(boardId)`, `events(boardId, cursor?)` — with op-id minting (caller may supply; client mints UUIDs otherwise) so replay dedup works by construction. JSDoc states the invariant: **this module is the only writer of board ops in Rennet**.
- [ ] 3.2 Grep proof of the invariant recorded in the test or a comment: no other workspace module calls `BoardService.apply` (or constructs board ops) — `sh -c 'grep -rn "\.apply(" packages/ apps/ --include="*.ts" | grep -v test'` reviewed; the only board-op writer is whiteboard-client.
- [ ] 3.3 Tests: five tools against a `BoardService` over `InMemoryBoardStore` (create→schema→apply→describe→events), op-id minting uniqueness, supplied-op-id passthrough, invalid batch surfaces the service's verbatim rejection.
- [ ] 3.4 Cluster gate green. Commit.

## 4. Privacy seam + broadcast

- [ ] 4.1 Extend `packages/server/src/projection.ts` (KEEP as-is — additive only): `projectBoardEvent(event, ctx)` and `projectBoardProjection(elements, ctx)` deep-scrub board payloads with the module's existing walker (host-path fields → repo references where structural, blanket known-root/home-dir scrub in remaining strings; model-authored prose rule unchanged — board prose attributes are scrubbed only by the blanket pass, same as today's free text).
- [ ] 4.2 Wire broadcast: board events from the runtime flow to connected clients through the existing push/live-event path (inspect `create-server.ts`'s registry — reconciliation 7; record the actual wiring point here). Loopback connections receive raw events; `projected` connections receive wrapped ones. No new transport channel.
- [ ] 4.3 Tests: a board event/projection whose data carries an absolute host path and a home-dir string comes out of the wrap with repo-reference/`~` substitutions; loopback path untouched. **This is the packet's positive control — it must be capable of failing** (see 6.3).
- [ ] 4.4 Cluster gate green. Commit.

## 5. Docs (definition of done)

- [ ] 5.1 `docs/developing/concepts/architecture-contracts.md`: board event logs persist under `.rennet/boards/` (local, never staged — extend the persistence section); the client-projection section now also names board events/projections as wrapped surfaces.
- [ ] 5.2 `docs/developing/concepts/architecture-overview.md` + `docs/developing/reference/monorepo-map.md`: server row gains `@wboard/server` (embedded board service), adapters row gains whiteboard-client (the only board-op writer). Match the Nx graph exactly (check-docs.mjs enforces).
- [ ] 5.3 Re-grep `docs/` (excluding `docs/dist`) for claims a reader would now find wrong about board storage/broadcast; fix stragglers.
- [ ] 5.4 Cluster gate green. Commit.

## 6. Verification (packet)

- [ ] 6.1 `sh -c 'pnpm check'` green — exit 0 captured on its own line, not a masked pipe status.
- [ ] 6.2 E2E (the packet's scripted sequence, as a real test run and shown): create board with the Rennet host wire schema → apply ops → read events → project → **restart** (dispose service, new `BoardService` + `FileBoardStore` on the same `.rennet/` directory) → identical projection. Show the passing run output.
- [ ] 6.3 Positive control: temporarily break the privacy wrap (e.g. bypass the scrub for board events) — the 4.3 test MUST fail. Show the failure, revert, re-run green, `git status` clean.
- [ ] 6.4 Writer-invariant sweep: show the 3.2 grep output at final HEAD — whiteboard-client is still the only board-op writer.
- [ ] 6.5 Flip `b04` in `BUILD-STATUS.json` to done/passes:true (only that line); check boxes; commit; push; verify local == origin. Output the completion sigil `<promise>B04-COMPLETE</promise>`.
