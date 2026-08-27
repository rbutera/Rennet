# B05 tasks — delta-packet

Serial clusters; fresh implementer session per cluster; one commit per checked task; no placeholders. Gate per cluster: `pnpm nx affected -t lint,typecheck,test` green with EXIT captured on its own line. Ledger rule: an amendment discovered mid-cluster is recorded in proposal.md in the same commit.

## Cluster 1 — hunk index + HunkId format

- [x] 1.1 `packages/core/src/delta/hunk-index.ts`: parse each `PatchFile.patch` into hunks (`@@` header + interleaved body, verbatim slices — reuse/extract the existing parse in `decomposition.ts`/`element-diffs.ts` rather than writing a third parser). `buildHunkIndex(patchset) → HunkIndex` where each hunk carries `{id: HunkId, path, header, body, spans}`. `id = sha256Hex(path + "\n" + header + "\n" + body)` (protocol's `sha256Hex`); a patch containing `DIFF_TRUNCATION_MARKER` yields hunks flagged content-lossy (id still minted, flag recorded — mirrors the existing fail-closed carry rule). `packages/core/src/delta/index.ts` is the folder's only import surface.
- [x] 1.2 Tests: same patchset twice → identical ids (stability); body mutation → id changes; truncated patch → lossy flag; empty/binary files → no hunks, no throw.
- [x] 1.3 Protocol one-liner: `SkippedHunkSchema.hunk` in `board/lens-board.ts` re-points from plain `z.string().min(1)` to `hunkIdSchema` (B03 hand-off note honored; observable behavior unchanged).
- [x] 1.4 Gate green; check boxes; commit per task.

## Cluster 2 — move the survivors under core/delta

- [x] 2.1 `git mv` `element-diffs.ts` + `element-diffs.test.ts` → `src/delta/`, repoint relative imports and `core/src/index.ts` re-export. Verbatim move — no signature change (reconciliation 6).
- [x] 2.2 `git mv` `blast-radius.ts` + test → `src/delta/`. Rename the local `BlastRadiusPaint` shape to `BlastRadiusSignalMark` (or similar non-overlay name) and strip overlay/paint framing from comments — the signal taxonomy is Delta-packet input now. Keep the not-assessed semantics byte-for-byte (that is the KEEP list's point).
- [x] 2.3 `git mv` `openspec-change.ts` + tests → `src/delta/`, repoint imports (`openspec-disposition-durability.test.ts` and any other siblings).
- [x] 2.4 Gate green (positive proof: `pnpm nx run-many -t typecheck -p rennet-core rennet-server rennet-adapters` — no consumer lost an export).

## Cluster 3 — deterministic noise pre-classification (new)

- [x] 3.1 `packages/core/src/delta/noise-preclass.ts`: pure rules over the hunk index → `NoisePreclassFact[]` `{hunkId, rule, reason}`. Rules (mechanical only): lockfile paths (`pnpm-lock.yaml`, `package-lock.json`, `yarn.lock`, `Cargo.lock`, etc.), generated-scaffold stamps (`.openspec.yaml` per R22), generated-output globs (`dist/`, `*.min.*`, sourcemaps). NO formatting/import-order heuristics — a model judges the remainder (#464 dec. 2); do not grow the rule set beyond what is mechanically certain.
- [x] 3.2 Tests: each rule fires on a fixture hunk; a plain source hunk yields no fact; verdicts carry the firing rule (the "which judged" record).
- [x] 3.3 Gate green.

## Cluster 4 — counterpart hints + the buildDeltaPacket seam

- [x] 4.1 Apply track-b's reconciliation-1 ruling: move `isTestPath`/`implementationPathFor`/`testPathsFor` from `app-ui/src/canvas/counterpart.ts` to `packages/protocol/src/delta/counterpart.ts` (ruled placement, delta seam export), repoint app-ui to import them, keep app-ui's UI-side resolution local. `core/delta/counterpart-hints.ts` derives `{testPath, implPath}` pairs among the patchset's changed paths.
- [ ] 4.2 `core/delta/index.ts`: `DeltaPacket` type + `buildDeltaPacket(patchset, knowledge: KnowledgeSet, dossier: DossierItem[], successorAccount?: SuccessorAccount) → DeltaPacket` — assembly only (no I/O, no model): `{patchset meta, hunks (index), knowledge, dossier, successorAccount?, blastRadius, openspec?, noisePreclass, counterpartHints}`. openspec section present iff the patchset touches openspec artifacts. Parameter shapes are the protocol contracts — no re-modeling.
- [ ] 4.3 Tests: assembly includes every producer's facts; `successorAccount` section present iff the argument is supplied; determinism (two calls, deep-equal result).
- [ ] 4.4 Gate green.

## Cluster 5 — docs

- [ ] 5.1 `docs/developing/concepts/delta-rereview-and-lineage.md`: name `core/delta/` as the home of the hunk index + differ; successor account feeds `buildDeltaPacket` on rounds.
- [ ] 5.2 `docs/developing/concepts/context-assembly.md`: the DeltaPacket is the drafters' inlined input (#464: inlined, not tool-fetched) — one paragraph + updated flow if the page draws one. Sweep `docs/` for stale claims about the moved files' paths (code-map rows included).
- [ ] 5.3 Gate green (docs test inside).

## Cluster 6 — verification

- [ ] 6.1 `pnpm check` → EXIT=0 captured on its own line, tail shown.
- [ ] 6.2 Packet fixture test: a REAL captured patchset fixture (reuse an existing capture fixture from core's test corpus) → `buildDeltaPacket` → hunk ids identical across a second run; successor-account section present iff a prior generation exists (both arms exercised).
- [ ] 6.3 Positive controls, fail-then-revert with evidence: (a) mutate a fixture hunk body → id assertion fails; (b) drop the `successorAccount` argument in the present-arm test → presence assertion fails. Revert, re-run green, tree clean.
- [ ] 6.4 BUILD-STATUS.json: `b05` → `{"status":"done","passes":true}` (only that line). Commit, push, local == origin.
- [ ] 6.5 Output the sigil: `<promise>B05-COMPLETE</promise>`
