# Tasks

## Move one — orphan-section guard (standalone PR, ships first)

- [x] `flagged.md`: state exactly ONE top-level section; never attach a `code_ref` (or anything but a finding) directly to a section; code refs live inside a finding's `code` field.
- [x] `flagged.md`: remove any wording implying the branch is green; add one scope-and-cost line that running the repo's build/test/lint gate is out of scope.
- [x] Flagged render/projection: a direct `code_ref` child of a Flagged section does not render as a standalone block; a top-level Flagged section with no finding child is suppressed. Scope the guard to the Flagged lens (Design sections legitimately hold no findings).
- [x] Positive-control test using the #927 element shape (section with children `[code_ref, code_ref, code_ref, finding, finding]` plus a sibling "Findings" section). Break the guard, watch it redden, restore.
- [x] `pnpm check` green in the worktree; PR description notes no prompt-size or token-cost change beyond the prompt edit.

## Move two — review-then-compile pipeline

- [ ] Split the Flagged seat prompt into a REVIEW prompt: investigate and write a structured findings file under `.rennet/`, one finding per section in `concern` shape; no board tools; do not run the repo gate.
- [ ] `runFlaggedDual`: each seat writes its findings file instead of drafting the shared board; drop the shared BoardWriter from the review stage.
- [ ] Compiler turn: reuse `composeContextFiles` / `renderComposePrompt`; hand the compiler both file paths; it writes the whole board via `write_board` — flat ranked list, findings verbatim, concurrence + origin stamped as its own judgment.
- [ ] Move the concurrence/accord logic out of `reconcileFlaggedVoices` into the compiler; retire location-matching for Flagged.
- [ ] Thread `collector` usage through the new compiler turn (no dropped spend).
- [ ] Tests: two-seat fixture where the same bug is described at different lines proves semantic concurrence (the case location-matching missed); a fixture proving a solo keeps its origin author; a fixture proving finding prose is verbatim (not paraphrased).
- [ ] Docs: update `docs/developing/concepts/lens-pipeline.md` for the Flagged review→compile stages; PR description names the one added orchestrator-class turn per run.
