# Context packet — C04 review-machinery

Read `openspec/BUILD-LOOP.md` first. Plan row: C4. **The load-bearing shared layer** — board, diff, chat, and exits all render these.

## Objective

`app-ui/src/review/`: the shared review components — `code-block` + `code-tabs` (multi-site evidence, impl↔test flip per R41), `LineCommentEditor` (one editor for chat blocks, board excerpts, diff — autopsy keep-list seam), selection toolbar (`ProseSelectionLayer` mode union, kept), rich text (R45 markdown subset), reference chips, citations with click-to-reveal `path:line`. **Port presentation, rewrite state** onto the `review` store slice; the dead `CodeCommentsProvider` shim and its phantom `store?.` guards do not travel (autopsy S3, fence rule 4). Source hydration through the **patchset span-read command** (B3) — never a filesystem read; `/api/source` has no successor.

## Out of scope

The surfaces themselves (C5–C9). Ask staging logic (C8 over B11).

## Blocked by

C1; B3 for the span-read command (stub via `MemoryBridge` until B4 serves it live).

## Sources

- Inventory §3 shared-machinery claims, tagged `[ws:C4]` at kickoff (R24/R26/R27/R30/R41/R45 refs inline)
- Client asset §1 review layer + risk 2: https://github.com/rbutera/rennet/issues/489#issuecomment-5431046569
- Autopsy keep-list (`LineCommentEditor`, mode union) + fence: https://github.com/rbutera/rennet/issues/489#issuecomment-5431046732
- Spike reference (read-only): `spikes/board-prototype/components/{code-block,code-tabs,selection-toolbar,rich-text,code-comments}.tsx`

## Verification

- `pnpm check` green. E2E: the same comment object created from a board excerpt and from a diff line lands in the same store shape; a citation resolves its span from a `MemoryBridge` patchset, not the working tree.

## Completion sigil

`<promise>C04-COMPLETE</promise>`
