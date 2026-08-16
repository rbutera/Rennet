## 1. Adapters: make `parseUnifiedDiffFiles` hunk-aware

- [x] 1.1 Add the per-block `inHunk` flag in `packages/adapters/src/git-range-diff.ts` (`parseUnifiedDiffFiles`), set when a line starts with `@@`, reset per `diff --git` block. Gate every metadata branch (`new file mode`, `deleted file mode`, `rename from `, `rename to `, `--- `, `+++ `) on `!inHunk` (design D1/D3).
- [x] 1.2 In-hunk counting classifies by first character only: `+` is an addition, `-` a deletion, with no `+++`/`---` exclusions inside hunks (design D2). Pre-hunk lines are never counted.
- [x] 1.3 Regression test — the #310 reproduction: a block for `actual.txt` whose hunk body includes an added line rendered `+++ b/pnpm-lock.yaml`. Assert the file keys `actual.txt`, `additions` includes the adversarial line, and no `pnpm-lock.yaml` entry exists (design D5).
- [x] 1.4 Regression test — the `--- ` sibling: a deleted line rendered `--- b/some/path` inside a hunk is counted in `deletions` and leaves `previousPath` untouched.
- [x] 1.5 Red-proofs, one mutation at a time: revert the `inHunk` gate on `+++ ` and watch the re-key assertion fire; separately revert only the in-hunk counting change and watch the count assertion fire. Restore full green after each (a red-proof validates only the assertion that fired).
- [x] 1.6 Confirm the existing `parseUnifiedDiffFiles` tests (binary detection, type-change coalescing, rename/mode fallbacks) still pass with the gated branches — their fixtures put metadata in the preamble, so no expected values should shift; if any do, understand why before touching the expectation.

## 2. Core: audit `parseFilePatch`, pin the correct behaviour

- [x] 2.1 Verify by inspection that `parseFilePatch` (`packages/core/src/decomposition.ts`) reads metadata only while `current === null` and classifies in-hunk lines by `charAt(0)` — the audit #310 asks for. Expected outcome: no code change (design D4). If the audit finds otherwise, stop and record the finding on the change before implementing anything beyond this proposal's scope.
- [x] 2.2 Pinning test in the core test file: a patch whose hunk contains `+++ b/other.txt` as an added line yields a hunk body carrying it as an addition with content `++ b/other.txt`; `addedOf` includes it; no metadata effect. This reddens if a refactor ever flattens core into the adapters shape.

## 3. Gate and hand off

- [x] 3.1 Run the affected gate from the worktree root (`pnpm nx affected -t lint,typecheck,test,build --base=origin/main`); GREEN means typecheck AND lint AND test all pass with 0 failing tests, read from the output values, not the exit code.
- [x] 3.2 Commit with descriptive messages, push the branch, open the PR (base `main`) referencing #310. Word the PR body so no closing keyword sits next to an issue number unless auto-close is intended. Note in the PR that bytes-first / non-ASCII hardening is deliberately out of scope and still owed.
