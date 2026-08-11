## 1. Full-granularity authoring (pure, TDD)

- [x] 1.1 `authorDisposition(canvas, act)` → `{ writes, trace }` for every altitude: line / hunk / symbol / element / cohort / rollup; roll-up/cohort/element/symbol delegate to #11 `fanOutApproval`, hunk/line resolve hunk → chunk → paths
- [x] 1.2 The trace binds the one act to its N writes and records the altitude + source (assert per granularity)

## 2. Raw-draft batch (pure, TDD)

- [x] 2.1 `DispositionDraft { path, type, raw }`; `draftsFromAuthored`, `addToBatch` (upsert-by-path, engine-fidelity)
- [x] 2.2 `editDraftBody` / `editDraftType` / `withdrawDraft`
- [x] 2.3 `batchViewModel` + `batchPayload` + `batchPayloadDigest`: batch view bytes == publish/handoff payload bytes
- [x] 2.4 Withdraw-before-publish leaves ZERO residue (byte-level sentinel assertion)
- [x] 2.5 `#19` seam documented on the draft; raw stays sovereign

## 3. Read-state fold + coverage (pure, TDD)

- [x] 3.1 `foldReadState(events)` → per-path read/skimmed/unread, max-rank, order-independent; `Actioned`→read, `ScrolledPast`→skimmed, `Collapsed`/absent→unread
- [x] 3.2 A scrolled-through, never-actioned chunk reports skimmed (not read); collapse never marks read
- [x] 3.3 `dispositionsToViewEvents` ties read to L2 actions only
- [x] 3.4 `coverageMosaic(paths, events)` + `nextUnread`: figures rebuild identically from event replay (any order)

## 4. Orphan tray (pure, TDD)

- [x] 4.1 `orphanedDispositions(before, after)` = set difference on path+contentDigest (the dropped, non-carrying dispositions)
- [x] 4.2 Renders on a seeded failed-carry fixture; empty is empty-but-honest

## 5. Components (SSR-tested)

- [x] 5.1 `BatchView` — renders exactly the payload entries; withdraw removes with no residue in markup
- [x] 5.2 `OrphanTray` — renders seeded orphans; nothing when empty
- [x] 5.3 `CoverageMosaicView` — read/skimmed/unread cells + counts + next-unread
- [x] 5.4 `GranularityAuthor` — the disposition affordance at each altitude of the ladder
- [x] 5.5 `CanvasWorkspace` additive optional sections (no props → nothing new renders → #11 untouched); `index.ts` exports

## 6. Gate

- [x] 6.1 `pnpm check` green (format, architecture, licenses, lint, typecheck, test, build): zero errors + `Successfully ran target(s)`
