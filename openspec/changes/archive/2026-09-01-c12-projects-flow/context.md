# Context packet — C12 projects-flow

Read `openspec/BUILD-LOOP.md` first. Plan row: C12. Largest client section (INVENTORY §10, 111 claims).

## Objective

Add-project through first review: Add Project dialog + directory browser (**reuse** `packages/app-ui/src/components/directory-browser.tsx` over `fs.listDir` — do not port the spike's), Add Environment pairing, scout phase preceding context-map generation, prefilled questionnaire (detected/guessed provenance chips, skippable, never a gate), map generation with progress + exits, context-map view (**reuse** `app-ui/src/context-map/model.ts`), ready state ending in full-width **Start a Review** CTA, New Chat target picker + smart list (**reuse** `app-ui/src/project/smart-list.ts`; row click mints session AND claims target, rows vanish from New chat, archive-only release), `/archived`. Simulated timelines (10.5s `setTimeout` in the store — autopsy S9) are replaced by real `project.process` progress channels.

## Out of scope

Scout/questionnaire engine (B7), context-map generation (B6), session minting (B9) — this change is their surfaces.

## Blocked by

C3; B6/B7/B9 for live flows (`MemoryBridge` first).

## Sources

- Inventory §10, tagged `[ws:C12]` at kickoff · the prototype decision: https://github.com/rbutera/rennet/issues/487 · retrieval config: https://github.com/rbutera/rennet/issues/461
- Client asset §5 add-project row: https://github.com/rbutera/rennet/issues/489#issuecomment-5431046569
- Autopsy S9/S10 (no fixture ids in routing — `"p1"` fallbacks die) + fence: https://github.com/rbutera/rennet/issues/489#issuecomment-5431046732
- Spike reference (read-only): `spikes/board-prototype/components/{add-project*,directory-browser,project-indexing-view,context-map,new-chat-view,archived-view}.tsx`
- Docs: `docs/using/guides/getting-started.md`, `context-map.md`

## Verification

- `pnpm check` green. E2E: add this repo as a project — scout runs, questionnaire prefills with provenance, map generates with live progress, Start a Review mints a session and lands in it; archive + restore from `/archived`.

## Completion sigil

`<promise>C12-COMPLETE</promise>`
