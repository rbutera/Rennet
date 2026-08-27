# B05 — delta-packet (core/delta consolidation + buildDeltaPacket seam)

Packet: `context.md` (scope authority). Plan row B5. Blocked-by B3 (landed, PR #497). Authored 2026-08-27 against main @ cf29b017 (B04 landed).

## What this change does

Creates `packages/core/src/delta/` — the one folder that turns an immutable patchset into the lens drafters' entire input — and its single seam:

```ts
buildDeltaPacket(patchset, knowledge, dossier, successorAccount) → DeltaPacket
```

Contents (per #464 resolution decisions 1–2, engine asset §2 `core/delta`):

- **Hunk index** — patchset → hunks with **stable ids** (deterministic digest; same patchset → same ids on every run).
- **element-diffs** — the #459 KEEP differ, moved verbatim; it is the hunk-identity + section-carry engine powering lineage carry, the successor account, and composition `delta: new|reworked` stamps (those consumers wire in at B8).
- **Blast-radius signals** — the deterministic signal taxonomy as Delta-packet input; the "paint as overlay" framing dies here.
- **openspec parse** — the artifact parser as a typed-fact producer for the Design drafter.
- **Deterministic noise pre-classification** — NEW: mechanical rules (lockfiles, generated-scaffold stamps per R22) classifying hunks as noise candidates with the rule recorded; the model judges the remainder (B8's `lens-draft-noise`).
- **Counterpart hints** — test↔impl pairing among changed paths, as Sequence-drafter candidate data (placement per reconciliation 1).

Derived facts enter the packet as **typed data, never hand-retyped** (#464 dec. 2), doubling as validation inputs downstream.

## Out of scope (consume shapes only)

Drafter dispatch + composition incl. the every-hunk check (B8); knowledge generation (B6); dossier fetching (B7); `patchset.readSpan` dispatch binding (B10). Protocol `delta/` contracts (CodeRef, HunkId, KnowledgeStatement/KnowledgeSet, DossierItem, serializeDossier) landed in B03 — B05 **consumes** them; re-modeling a published contract is a defect (B03 precedent).

## Reconciliation ledger

1. **collation/counterpart placement — RULED (track-b, 2026-08-27): split verdict approved as proposed; helpers land at `packages/protocol/src/delta/counterpart.ts` exported through the delta seam.** Packet + engine asset §2 place "collation/counterpart" in `core/delta`. Reality: both live in `packages/app-ui/src/canvas/` (post-B2 survivors, B02 ruling), and **app-ui may not import core** (boundary law), so a plain move breaks the UI consumers (`code-view.tsx`, app-ui index). Split verdict proposed:
   - *counterpart*: the pure path-pairing helpers (`isTestPath`, `implementationPathFor`, `testPathsFor` — pure string logic, no deps) move to **protocol** (precedent: `sha256.ts` utility lives in protocol; both core and app-ui may import protocol); app-ui's `counterpart.ts` keeps only the UI-side element resolution and imports the helpers; `core/delta` derives counterpart hints from them. No duplication, no boundary breach.
   - *collation*: `app-ui/src/canvas/collation.ts` is the **publishing-side editable collation model** (dispositions → review comments; server dispatch comment names the client layer as its owner). #464 dec. 2's "collation powers the composition-side every-hunk check" is composition bookkeeping = `core/board` = **B8**. Verdict: collation stays in app-ui untouched; nothing for B05.
2. **"Deterministic noise pre-classification" does not exist yet.** `core/noise-generation.ts` is the *LLM* noise runner (its own header records the deterministic mechanical-rules engine as a deferred follow-up). B05 authors the deterministic pre-classifier as a new small module; `noise-generation.ts` is untouched (not on the engine asset's retire list; drafter supersession is B8's concern).
3. **successor-account location.** Packet says `core/board/successor-account.ts`; reality is `packages/core/src/successor-account.ts` (B2 renamed the *name* delta-account → successor-account; no `core/board/` folder exists). B05 imports it where it lives; creating `core/board/` is B8/B9's. No move.
4. **HunkId becomes operational.** Protocol `hunkIdSchema` (B03) is an opaque `z.string().min(1)`. B05 defines the id *format* in `core/delta` (digest via protocol's `sha256Hex` over path + hunk header + body; truncation-marker-aware) and re-points `SkippedHunkSchema.hunk` in `board/lens-board.ts` to `hunkIdSchema` — the one-liner B03's cluster-3 hand-off pre-priced.
5. **DeltaPacket type home = core/delta, not protocol.** It is the drafter *input assembly* (engine asset places the seam in core); its constituent shapes (KnowledgeSet, DossierItem, SuccessorAccount, CodeRef/HunkId) are the protocol contracts. B8 serializes the packet into prompts; if a wire contract emerges then, promoting it is B8's call.
6. **element-diffs moves verbatim, canvas-era signature intact.** Its `DiffSliceCanvas` local shape is the recorded standalone-survivor state (B2). Re-wiring onto the Board surface happens with its consumers (B8); B05 is a mechanical move + import repoint, no behavior change.

7. **Amendment (cluster 4): two packet sections are patchset-only by the no-I/O rule.** The seam's pinned signature supplies only the patchset plus the three producer contracts, so (a) `blastRadius` is computed with no ownership rules and no fan-in index — both live with the project snapshot (I/O); blast-radius's own honest-absence design covers this (fan-in stays a NOT-ASSESSED mark, no CODEOWNERS ⇒ no ownership marks), and B8's dispatch, which owns the snapshot, feeds them in when it wires the real callers; (b) `openspec` is path grain (`{name, artifactPaths}` per touched change dir) — artifact TEXT is read off disk, so the full `parseOpenSpecChange` runs where the text lives (B8), over the same seam-exported parser. Neither weakens the packet contract; both are recorded at the seam's JSDoc.

8. **Amendment (cluster 6): the "real captured patchset" fixture is frozen, not found.** Core's test corpus held no captured-patchset fixture (every existing test builds synthetic `Patchset`s), so cluster 6 froze one: `core/src/delta/real-capture-fixture.json`, a real per-file `git diff` capture of this repository's own commit 3228a4cc (the B04 heal fix — an impl+test pair), validated through `patchsetSchema` in the test. Own-repo code only; no client material (fixture rule).

## Review-fix amendments (PR #514 round 1)

9. **HunkId hashes the verbatim hunk slice, not the parsed body.** `parseFilePatch` drops `\ No newline at end of file` markers, so hashing `path + header + parsed body` (reconciliation 4's original recipe) collided marker-on-deleted-side with marker-on-added-side — distinct changes, same id. The id is now `sha256Hex(path + "\n" + slice)` where the slice is the hunk's raw text from `@@` header to the next header, markers included. Collision regression test added; `parseFilePatch` itself is untouched (three other consumers count body lines).

10. **HunkId contract pinned patchset-local.** Rerun stability over the same patchset is the whole contract; an unchanged hunk whose header drifts mints a new id. Cross-round identity is lineage / element-diffs (B8). Recorded in the `IndexedHunk` JSDoc.

11. **Mode-only changes reach the packet.** The parser saw `old mode`/`new mode` lines but the packet discarded them, so a chmod-only file (zero hunks) vanished from the drafters' "entire input". `parseFilePatch` now returns the typed pair and `DeltaPacketFile` carries `modeChange: {old, new}` where present; chmod-only fixture test added.

12. **Generated-output rule narrowed to the approved globs.** Delegating to decomposition's `isGeneratedPath` swept up hand-authorable paths (`routes.map`, `build/config.ts`) — beyond mechanical certainty. The rule now matches only a `dist/` path segment, `*.min.*`, and JS/CSS sourcemap suffixes, locally in `noise-preclass.ts`; negative fixtures added.

13. **Packet ordering is code-unit, not locale.** `localeCompare` collation varies by host locale, breaking cross-host determinism; the packet's sorted sections (openspec changes/paths, counterpart hints) now reuse blast-radius's exported code-unit `compareStrings`, with a fixed-Unicode-order test.

14. **`openspecTouch` sees renames.** Only `file.path` was examined, so a rename OUT of a change dir (old side in `previousPath`) omitted the touched change. Both sides are checked now; rename-out and rename-between tests added.

## Verification (packet)

`pnpm check` green. Fixture test: a real captured patchset produces a DeltaPacket whose hunk ids are **stable across a re-run** and whose successor-account section is **present iff** a prior generation exists. Positive control that can fail (mutate a hunk body → id changes; omit successorAccount → section absent).
