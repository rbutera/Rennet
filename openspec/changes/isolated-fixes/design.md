# Design — isolated-fixes

## Context

The fixes share no runtime path and are grouped only because both are isolated, non-renderer corrections.

For #94, `runRollupNarration` already owns the `Decomposition` and builds a code manifest, but `renderPayload(nodes, patchsetId)` at `packages/core/src/rollup-narration.ts:217-224` emits only node structure. The prompt therefore asks the light-tier seat to account for code it cannot see. The design must add useful code context without turning a large diff into an unbounded light-tier prompt.

For #224, `EDITOR_CLIS` at `apps/desktop/src/main/open-in-editor.ts:16` defines an ordered family with a common `-g file:line` invocation. The desktop composition loops over those bare names at `apps/desktop/src/main/index.ts:1434-1445`. That inherits a useful shell PATH under `pnpm dev`, but Finder-launched packaged apps receive a minimal PATH. The existing path-to-review-file resolution, line-jump arguments, candidate fallback, and `shell.openPath` fallback are already correct and stay in place.

## Goals / Non-Goals

**Goals:**

- Put actual decomposition hunk lines in the roll-up narration payload under a fixed UTF-8 byte ceiling.
- Keep the excerpt deterministic, evenly useful across chunks, and explicit when truncated.
- Resolve every editor candidate to an absolute executable before spawning it, both from shell PATH directories and known macOS app bundles.
- Keep `pnpm dev` line jumps and the existing fallback ladder working without renderer or protocol changes.

**Non-goals:**

- No citation minimum, citation-based rejection, or other narration admission change.
- No editor picker, settings UI, new editor invocation grammar, or renderer work.
- No consent step, capability restriction, sandboxing, or adjacent hardening.

## Decision 1: add a separately bounded chunk-evidence section to `renderPayload`

Change the payload builder to receive the `Decomposition` and emit:

```ts
{
  patchsetId,
  nodes: [{ altitude, node, title, covers }],
  chunks: [{ chunkId, title, filePaths, excerpt, truncated }]
}
```

The excerpt for a chunk is derived only from the hunks named by its `hunkIds`. It carries hunk/file identity and the real `addedLines`, `deletedLines`, and `contextLines`, with line kinds labelled in the text. These are the code bytes already retained by the decomposition; the builder does not reconstruct or claim verbatim unified-diff ordering that the separated arrays no longer preserve.

Keep the existing node array byte-shape unchanged and add `chunks` as a sibling. This avoids coupling narration-node construction to evidence selection and gives the roll-up account the whole bounded change context while cohort accounts can associate evidence through chunk ids, titles, and file paths.

The alternative is to add patchset bytes to the runner or to require citations. The first widens the runner input for information the decomposition already contains. The second is the struck fail-closed gate: it can make narration disappear and does not improve the prompt itself.

## Decision 2: enforce one named total evidence ceiling with a fair per-chunk share

Define `NARRATION_CHUNK_EXCERPT_MAX_BYTES = 12_288` and `NARRATION_SINGLE_CHUNK_MAX_BYTES = 2_048` next to `renderPayload`. For `N` chunks, each chunk receives at most:

```text
min(NARRATION_SINGLE_CHUNK_MAX_BYTES, floor(NARRATION_CHUNK_EXCERPT_MAX_BYTES / max(1, N)))
```

Chunks remain in `decomposition.readingOrder`, with any unlisted chunk ids appended in their stable decomposition order. Hunk content remains in `chunk.hunkIds` order. Truncate at a UTF-8 boundary and include a `truncated` boolean; the encoded sum of all `excerpt` strings must be at most the total constant.

The per-chunk cap prevents a one-chunk diff from consuming the whole allowance. Dividing the total allowance across every chunk prevents early reading-order chunks from consuming all evidence before later chunks receive any. This is a money/quality bound on an existing prompt, not an admission condition: truncation never blocks or rejects narration.

The alternative is first-come truncation against one global buffer. It is simpler but biases the account toward the beginning of the reading order and can leave later cohorts title-only, reproducing the bug unevenly.

## Decision 3: resolve an ordered list of absolute editor executables

Move candidate resolution into a pure-effects seam in `apps/desktop/src/main/open-in-editor.ts`. Given platform, home directory, inherited PATH, harvested login-shell PATH, and an executable check, it returns a de-duplicated ordered list of absolute paths.

Resolution preserves `EDITOR_CLIS` priority. For each CLI name it considers inherited PATH directories first, then harvested login-shell PATH directories, then that editor's known bundle-relative executable under `/Applications` and `~/Applications`. The known bundle table covers only the existing common-grammar family: VS Code, Cursor, VS Code Insiders, VSCodium, and Sublime Text. Every candidate is made absolute and executable-checked before it is returned.

The desktop composition lazily memoizes the resolution and loops over the returned absolute paths with the existing `execFileAsync(executable, ["-g", fileLine])`. An environment-PATH fixture proves the `pnpm dev` route. An empty-PATH, installed-app-bundle fixture proves the packaged route. If a candidate fails to launch, the next resolved candidate is tried; if none succeeds, the existing `shell.openPath` fallback runs.

Using `open -a` was rejected because it cannot preserve the existing line-target contract. Adding a configured-editor setting was rejected for this change because zero-config discovery fixes the packaged bug without a renderer or settings migration.

## Risks / Trade-offs

- **The excerpt does not preserve unified-diff interleaving.** → Label additions, deletions, and context honestly and test exact source-line presence; do not call it a verbatim patch.
- **A very large chunk count gives each chunk a small excerpt.** → Equal allocation preserves some grounding for every chunk while holding the light-tier money ceiling; the title/file metadata still identifies each chunk.
- **App bundle paths vary outside the supported editor family.** → PATH discovery remains cross-platform and the existing OS fallback remains available; different CLI grammars stay deferred.
- **An editor installation can change after lazy resolution.** → Memoization is process-scoped; restarting the app refreshes discovery. No persisted state or migration is introduced.

## Approach

Implement #94 entirely in the core narration module and its focused tests: add byte-safe excerpt helpers, extend `renderPayload`, and capture the assembled prompt to prove real hunk content and the bound. Do not touch validation or narration output handling.

Implement #224 entirely in the desktop main process: add injected executable discovery beside `performOpenInEditor`, wire real filesystem/login-shell effects in the composition root, and keep the existing command boundary unchanged. No renderer, preload, protocol, package dependency, or persistence change is needed.
