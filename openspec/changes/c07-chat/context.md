# Context packet — C07 chat

Read `openspec/BUILD-LOOP.md` first. Plan row: C7.

## Objective

The persistent chat dock per INVENTORY §5 (34 claims): header, transcript (turns, thought blocks, action steps, streaming prose), composer + badges, orchestrator presence. **Port under review; rewrite the transcript source** onto the real session transcript + `onAskStream` via `useCommandStream` — the spike's scripted reply pairs die as fixtures and return as `MemoryBridge` streams. The dock mounts once in the layout route (C1/C3), travels across every surface, keeps transcript identity across takeover routes (R47/R52). Anchored threads render from board refs, content transcript-side (#466). Compaction surfaced honestly: compact_boundary timeline row, ask-don't-estimate meter (B9's data).

## Out of scope

The dock's slot/frame (C3), ask staging (C8), app-control command effects (B10 serves them).

## Blocked by

C3, C4. Live streams need B9.

## Sources

- Inventory §5, tagged `[ws:C7]` at kickoff · session mechanics: https://github.com/rbutera/rennet/issues/466
- Client asset §5 chat row + risk 4: https://github.com/rbutera/rennet/issues/489#issuecomment-5431046569
- Fence addendum: https://github.com/rbutera/rennet/issues/489#issuecomment-5431046732
- Spike reference (read-only): `spikes/board-prototype/components/{chat-column,conversation-pane,turn,thought-block,action-step,streaming-prose,input-bar}.tsx`

## Verification

- `pnpm check` green. E2E: a live turn streams into the transcript; navigate board → diff → settings and back — same dock DOM node, same transcript; a compaction boundary renders its honest row.

## Completion sigil

`<promise>C07-COMPLETE</promise>`
