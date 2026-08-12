# isolated-fixes

**Issues:** #94 (internal), #224 (bug). **Owner:** Codex (Zone B). **Review:** single codex.
**Depends on:** nothing; #224 receives its packaged-`.app` smoke proof again in the #42 packaging track.

## Why

Two isolated main-process/core defects weaken otherwise-live product actions. Roll-up narration currently receives only node titles and covered-element titles (`packages/core/src/rollup-narration.ts:217-224`), so the light-tier account has no code content to describe; `review.openInEditor` currently spawns bare names from `EDITOR_CLIS` (`apps/desktop/src/main/open-in-editor.ts:16`, `apps/desktop/src/main/index.ts:1434-1445`), which works under `pnpm dev` but not from a packaged macOS app's minimal PATH.

## What Changes

- **#94 / `narration-prompt-grounding` — ground narration in bounded code excerpts.** Extend `renderPayload` to serialise deterministic, bounded excerpts from the decomposition's chunks alongside the existing node structure. Preserve the current light-tier seat and admission behaviour; this changes what the model can read, not whether an account may appear.
- **#224 / `packaged-editor-resolution` — resolve editor executables before spawn.** Resolve the ordered `EDITOR_CLIS` candidates to absolute executable paths from the inherited/login-shell PATH and known VS Code/Cursor-family macOS app-bundle locations, then spawn the absolute path with the existing `-g file:line` arguments. A shell-PATH hit keeps the `pnpm dev` path working; app-bundle discovery makes the packaged `.app` path work.
- Keep both fixes below the renderer. No protocol or UI contract changes.

## Acceptance

- A narration turn's payload contains real added/deleted/context line content from each offered decomposition chunk, associated with that chunk's id/title/files, while the total excerpt bytes never exceed the named constant.
- The excerpt selection is deterministic and UTF-8 byte-bounded. A fixture larger than the ceiling truncates predictably; a small fixture is carried without truncation.
- The narration runner's existing validator and coverage behaviour are unchanged. In particular, an account is not rejected merely because it has no citation.
- `review.openInEditor` resolves and spawns an absolute VS Code or Cursor executable from a macOS `.app` bundle when the ambient PATH lacks the editor CLI, preserving `-g <absolute-file>:<line>`.
- The same resolver finds a CLI supplied by the inherited or harvested shell PATH, proving the existing `pnpm dev` behaviour remains live. Candidate order and OS-level no-line fallback remain unchanged.
- Red-proof: removing chunk evidence makes the payload-grounding assertion fail; reverting to bare CLI spawn makes the packaged-PATH fixture fail.

## Impact

- **#94:** `packages/core/src/rollup-narration.ts` and its focused tests. No new model turn, package, runtime dependency, output schema, or renderer change; the bounded excerpt increases only the existing light-tier prompt within a fixed ceiling.
- **#224:** `apps/desktop/src/main/open-in-editor.ts`, its focused tests, and the desktop composition at `apps/desktop/src/main/index.ts:1434-1445`. The `review.openInEditor` protocol and renderer caller remain unchanged.

## Deferred

- Editor preference UI or a new configured-editor setting; #224 is fixed through zero-config absolute discovery without touching the renderer.
- Editors with invocation shapes other than the existing `-g file:line` family.
- **Explicitly excluded by #94's Rule Zero amendment:** requiring a byte-verified citation per account or rejecting an uncited account. That proposal is a fail-closed admission gate, so it is not part of this change.
- Any consent step, confirmation, sandbox, capability denial, read-only posture, or unrelated hardening.
