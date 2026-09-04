## 1. Citations by path and line (D5)

- [x] 1.1 Replace the board citation and skipped-hunk shapes in `packages/protocol/src/board` with `codeRef` citations only; remove `SkippedHunkSchema`, `skippedHunks`, and every `hunkIdSchema` reference outside `packages/protocol/src/delta`
- [x] 1.2 Give lint a patchset-regions context (changed ranges per path and side) and an `unresolvable-citation` rule that carries path, side and range; delete the hunk-id resolution and the skip-reason rules; control: a citation outside the change reddens, one overlapping a changed range passes
- [x] 1.3 Delete the composition cross-lens coverage gate and the coverage turn (`coverage-mapping.ts`, `coverage-turn-backend.ts`, their prompt contract); add a daemon projection of cited regions if `app-ui` keeps a coverage view, and rewire or remove that view
- [x] 1.4 Key delta marks on `(path, side, start, end)`; recompute marks from citations on read and show no marks for a legacy id-keyed board, with the reason
- [x] 1.5 Remove the hunk-id vocabulary and the inventory sentences from `investigate-before-you-draft.md`, `sequence.md`, `decisions.md`, `flagged.md`, `noise.md`, `design.md`, `report.md`; state prompt size before and after in the PR
- [x] 1.6 Update `docs/developing/concepts` (lens pipeline, architecture contracts) for path-and-line citations and the absence of a coverage gate

## 2. Session context files (D3)

- [x] 2.1 Add `context/` to the managed ignore block in `map-visibility.ts` and ensure the block before any context write
- [x] 2.2 Implement the single writer for `.rennet/context/<sessionId>/` with its `README.md` index, and the purge; call the purge from `session.archive` beside `forgetSession`, from the round-settle re-sweep, and from a daemon-start orphan sweep that logs its count; tests with controls for write, purge on archive, orphan sweep, and never-staged
- [x] 2.3 Add a mechanical check on the send tap (`recordSeatSend`) that fails a test when a sent prompt contains a JSON object larger than two kilobytes, so the rule is asserted for every harness path

## 3. Convert or delete the inline sites, biggest first (D4)

- [x] 3.1 `renderDrafterPrompt`: the context layer becomes a path reference; write `round.json` for a regeneration; drop the inventory, blast radius and counterpart hints unless a prompt still needs them as files; before/after sizes for all five lenses in the PR
- [x] 3.2 `renderRetryPrompt`: delete; the ephemeral legs use `renderRepairTurn`; control: a retry on the Claude and Codex ephemeral legs carries only pointers
- [x] 3.3 `renderComposePrompt`: boards written to `boards/<lens>.json`, voice rules referenced by path from the prompts bundle
- [x] 3.4 Round-report classifier: evidence manifest written to `evidence.json`; `report.md` rewritten to read it
- [x] 3.5 Noise: offered manifest without line bodies written to `noise-offer.json`; the assembled context text referenced at its existing persisted path; `noise.md` and `NOISE_CONTRACT.input` rewritten
- [x] 3.6 Hypothesis and convention layers: reference `.rennet/conventions.json` and a written `hypothesis.json`
- [x] 3.7 Review opener, draft PR body, handoff compose and work order, delta digest: boards, asks and the work order written to the context directory; `renderComposedPrompt` and `renderHandoffPrompt` name `work-order.md` instead of embedding asks and diff fences
- [x] 3.8 Project scout: reference the guidance files in the cwd instead of embedding them; related context: reference the persisted dossier
- [x] 3.9 Finding verification, refine comment, CI classification: `pointers.json` naming file and lines; the prompt contracts' "you are shown a window" sentences rewritten
- [x] 3.10 Codex utility port: the retry report stays pointer-only and bounded
- [x] 3.11 Confirm every cold utility turn passes the bound root as `cwd`; add the missing ones

## 4. Design lens respec (D6)

- [x] 4.1 Rewrite `design.md`: find the spec for this branch (openspec changes, BMAD, Kiro, grill-me, ADRs, superpowers; commit messages and PR body as the clue), draft from it citing by path, or return the `no-spec` absence
- [x] 4.2 Delete `design-artifact-discovery.ts`, `DESIGN_ARTIFACT_LIMITS`, `fitDesignArtifactsToPrompt`/`fitDesignArtifactsToBytes`, the `designArtifacts` schema, the no-material candidate accounting, and their tests
- [x] 4.3 Add `no-spec` to the Design lane's admissible absences; bench reader shows "no spec found for this branch"; the lens switcher and board routes omit an absent Design tab; dom tests with controls for both surfaces
- [x] 4.4 Docs: the Design lens page under `docs/using` and the lens pipeline concept

## 5. One workspace per session (D1, D2)

- [ ] 5.1 Record the bound root on the session at creation: current checkout when on the branch, a Rennet-created branch worktree otherwise, the PR-head worktree for a snapshot; surface it beside the branch name
- [ ] 5.2 Create the session thread, seat threads and handoff thread with the bound `worktreePath`; fail with the missing path when the root is gone (includes the WSL leg: `ClaudeAdapter` runs the child with `wsl.exe --cd <distro root>` from `locusContextForRepo(repoRoot)`, so a seat's bound root must reach `wslCwd` too, or a PR-snapshot seat on WSL drafts in the wrong tree; found by PR #789)
- [ ] 5.3 Run the round worker as a turn in the bound root; read the turn's checkpoint as the receipt; capture the successor patchset from the bound root; record root and checkpoint in the round account and show them
- [ ] 5.4 Delete `planWorkspace`, `round-worktrees`, round-collation landing, `settleRoundCommits`, the round use of `cleanupWorktree`, the review evidence worktree, and the WSL round path translation; delete their tests
- [ ] 5.5 Daemon-start sweep removes legacy round and review worktrees with a logged count; sessions from before the wave bind lazily on first use
- [x] 5.7 Board jobs run on T3 seats only: delete the ephemeral Claude and Codex board-drafting legs in `council-seat-turn.ts` and the direct-call/desktop fallback shapes that reach them (no seam is the existing typed "T3 sidecar unavailable" failure); drive `owner-loop-proof.integration.test.ts` and `lens-settlement-proof-fixture.ts` through a fake T3 seam instead of the scripted Claude plan, so a pointer-only repair is answerable in the e2e (found by PR #800: a scripted plan cannot answer a repair that carries no prompt text)
- [ ] 5.6 Docs: `handoff-and-exits.md`, `t3code-sidecar.md`, `architecture-contracts.md` (a round advances the patchset from the bound root), the rounds pages under `docs/using`

## 6. Proof

- [ ] 6.1 One real drive of the packaged app on a large branch: record per-seat prompt sizes and timings in `t3code-sidecar.md` beside the 2026-09-03 numbers; Design settles absent on a branch with no spec and drafts on one with an OpenSpec change
- [ ] 6.2 One real round: commits land on the bound branch, the round account names the checkpoint, no worktree appears under the data directory, and archive removes the context directory
