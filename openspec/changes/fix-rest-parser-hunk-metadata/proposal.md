## Why

`parseUnifiedDiffFiles` — the degraded github-rest parser in `packages/adapters/src/git-range-diff.ts` — interprets `+++ `, `--- `, and file-metadata lines **anywhere** in a per-file block, not just in the header preamble. An ordinary added source line whose content is `++ b/<path>` appears in the unified diff as `+++ b/<path>` and is mistaken for the destination-path header, **re-keying the whole file** to `<path>`. Because the path assignment is last-write-wins, an adversarial (or merely unlucky) body line late in the block silently relabels e.g. an `actual.txt` change as `pnpm-lock.yaml` — which decomposition then routes into the appendix as noise, with **no ingestion gap recorded: a false-clear**, the dangerous direction. Reproduced with real git by the Codex reviewer (#310); pre-existing on `main`, and it is the adversarial-content parser hardening deferred from the incomplete-ingestion bead.

The same body lines are also miscounted: an added `+++ …` line is excluded from `additions` and a deleted `--- …` line from `deletions`, so the adversarial content is invisible to the substantive/noise counts even when the path survives.

## What Changes

- **`parseUnifiedDiffFiles` becomes hunk-aware.** Track an `inHunk` flag per block, set at the first `@@` hunk header. Before it: interpret file metadata exactly as today (`--- `/`+++ ` path headers, `new file mode`/`deleted file mode`, `rename from`/`rename to`). After it: **no line is ever metadata** — every `+`-prefixed line counts as an addition and every `-`-prefixed line as a deletion, *including* lines starting `+++`/`---`, which are precisely the adversarial bodies the old exclusions dropped.
- **Regression tests pinning the failure case.** The #310 reproduction — a block for `actual.txt` whose hunk body contains an added line rendering as `+++ b/pnpm-lock.yaml` — stays keyed `actual.txt`, is counted substantive (the adversarial line included in `additions`), and produces no phantom `pnpm-lock.yaml` file. A sibling test covers the `--- ` deletion-count case.
- **Audit of `parseFilePatch`** (`packages/core/src/decomposition.ts`, the same-family parser named by #310): it is **already hunk-aware** — metadata is read only while `current === null` (the preamble), hunk headers are matched by an anchored regex a prefixed body line cannot satisfy, and body lines are classified by first character only. The audit outcome is a **pinning test**, not a rewrite: assert a `+++ b/<path>` body line inside a hunk stays hunk body (an added line with content `++ b/<path>`), so a future refactor cannot regress core into the adapters bug.

## Out of scope — said honestly

Bytes-first / non-ASCII parser hardening (items 3–5 of the deferred ingestion bead, mentioned by #310 as "belongs here too") is **not** in this slice. It is a different failure family (encoding, not line-role confusion), touches both parsers more invasively, and the #310 re-keying bug is the highest-value fix that ships cleanly overnight. It should be proposed separately once this lands.

## Capabilities

### New Capabilities

<!-- None. -->

### Modified Capabilities

- `local-review-capture`: adds the requirement that hunk-body content is never interpreted as file metadata on the degraded REST path — a body line is data to be counted, never a header that re-keys or restates a file.

## Impact

- **`packages/adapters/src/git-range-diff.ts`** — `parseUnifiedDiffFiles` gains the `inHunk` flag; metadata branches gate on `!inHunk`; in-hunk counting drops the `+++`/`---` exclusions (they exist only to skip headers, and in-hunk there are none). No signature or output-shape change.
- **`packages/adapters/src/git-range-diff.test.ts`** — the #310 regression fixtures (re-key refused, counts include adversarial lines, no phantom file).
- **`packages/core/src/decomposition.ts`** — no code change expected (audit confirms preamble-only metadata); its test file gains the pinning regression.
- **Consumers** — `github-changeset-source.ts` calls `parseUnifiedDiffFiles` unchanged; correct keys/counts flow through to decomposition and the substantive/noise split for free.
