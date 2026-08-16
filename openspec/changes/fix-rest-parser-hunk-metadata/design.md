## Context

The REST fallback path (`github-changeset-source.ts` → `parseUnifiedDiffFiles`) parses raw unified-diff text because the degraded source has no structured `--name-status`/`--numstat` to lean on. The parser walks every line of each `diff --git` block through one flat `for` loop whose branches match metadata prefixes (`--- `, `+++ `, `new file mode`, `deleted file mode`, `rename from `, `rename to `) before falling through to `+`/`-` counting.

Unified diffs are **positional**: file metadata is legal only in the block preamble, before the first `@@` hunk header; after it, every line is hunk content carrying a one-character role prefix (`+`, `-`, ` `, `\`). The flat loop ignores that grammar, so an added body line whose *content* begins `++ b/` — rendered `+++ b/…` — matches the destination-path branch. Two concrete corruptions follow:

1. **Re-keying (the false-clear).** `path` is assigned with `=`, so the last match wins: the adversarial body line overwrites the real header, and the whole block — hunks, counts, raw patch — is attributed to the wrong file. In the reproduced case an ordinary `actual.txt` change was re-keyed to `pnpm-lock.yaml` and decomposed into the appendix as noise. Nothing records an ingestion gap; the review reads clean. This is exactly the direction `local-review-capture`'s "incomplete capture is visible" requirement exists to forbid — except here the capture is not incomplete, it is *silently wrong*, which is worse.
2. **Miscounting.** The counting branches exclude `+++`/`---` prefixes (to skip headers), so the adversarial line is counted as neither addition nor metadata-that-matters — it simply vanishes from `additions`/`deletions`.

`parseFilePatch` in `packages/core/src/decomposition.ts` was named by #310 as possibly sharing the class. Audit finding: **it does not.** It reads metadata only while `current === null` (before the first hunk), matches hunk headers with the anchored `HUNK_HEADER` regex (`/^@@ …/` — a `+`-prefixed body line cannot match), and classifies in-hunk lines by `line.charAt(0)` alone. Its correctness is currently *implicit*, though: no test pins it, so a refactor could flatten it into the adapters shape without anything going red.

## Goals / Non-Goals

**Goals:**
- After the first `@@` in a block, `parseUnifiedDiffFiles` never interprets a line as file metadata.
- In-hunk `+`/`-` lines are counted regardless of what their content looks like (a `+++ …`-rendered added line is an addition).
- The #310 reproduction is a committed regression test in adapters, and core's already-correct behaviour is pinned by its own test.
- The fix's failure direction is preserved: when in doubt the parser must *count* a line as change, never *promote* it to metadata.

**Non-Goals:**
- Bytes-first / non-ASCII hardening (deferred ingestion-bead items 3–5) — a separate encoding-family change, proposed separately.
- Any change to the structured (non-REST) capture path, which never runs this parser.
- Restructuring `parseUnifiedDiffFiles` into a shared parser with core's `parseFilePatch`. Tempting, but a cross-package refactor is not needed to fix #310 and would widen the blast radius of an overnight slice (Rule Zero: no robustness for robustness' sake).

## Decisions

### D1: An `inHunk` flag, not a two-pass split

The block is parsed in one pass with a boolean set when `line.startsWith("@@")`. Body lines cannot start with `@@` (their first character is `+`, `-`, ` `, or `\`), so the flag cannot be spoofed from content. Alternative considered: split the block at the first `@@` and run metadata extraction on the preamble slice only. Equivalent semantics, but the flag keeps the diff minimal and the existing loop structure (and its comments) intact.

The flag is per-block state, reset for each `diff --git` block, and **latches**: once in hunks, later lines are never metadata again. Between-hunks lines inside one block are `@@` headers or hunk content; git never re-emits file headers mid-block, and if a malformed input did, treating it as (uncounted, unmatched) content is the safe direction — it cannot re-key the file.

### D2: In-hunk counting drops the `+++`/`---` exclusions

Today: `line.startsWith("+") && !line.startsWith("+++")`. The exclusion exists only to avoid counting the *header* as an addition; once headers are structurally confined to the preamble, the exclusion inside hunks is exactly the bug's second half (it uncounts adversarial lines). In-hunk, the branch becomes first-character classification, matching core's `parseFilePatch`. Pre-hunk, nothing is counted (a well-formed preamble has no `+`/`-` content lines; a malformed one miscounting toward zero is preferable to metadata-promotion).

### D3: All metadata branches gate on `!inHunk`, not just `+++ `

Only `+++ ` (last-write-wins) and `--- ` (count loss) are demonstrably exploitable — `new file mode`/`rename from`/etc. are matched at column 0 and in-hunk lines always carry a prefix character, so they cannot fire in a well-formed diff. They are gated anyway: the guard is one condition, it makes the parser's grammar claim ("metadata is preamble-only") uniform and auditable, and it holds even for malformed input where a prefix-less line appears mid-hunk.

### D4: Core gets a pinning test, not a code change

`parseFilePatch` is verified correct by inspection; the deliverable is the test that keeps it that way: a patch whose hunk contains `+++ b/other.txt` as an added line yields one hunk whose body includes that line as an addition (content `++ b/other.txt`), with no metadata effect. If someone later unifies the parsers or "simplifies" the preamble handling, this reddens.

### D5: Regression fixtures assert the full downstream contract

The #310 test asserts three things on one fixture, because each catches a different regression: the file keys as `actual.txt` (re-key refused), `additions` includes the adversarial line (count restored), and no `pnpm-lock.yaml` entry exists in the result (no phantom file). Red-proof discipline: reverting the `inHunk` gate must redden the key assertion specifically; reverting only the counting change must redden the count assertion specifically — two separately revertible mutations, so each test is proven to guard its own layer (a red-proof validates only the assertion that fired).

## Risks / Trade-offs

- **Behaviour change on malformed diffs.** A block whose `---`/`+++` headers appear *after* an `@@` line (never produced by git) previously re-keyed; now it falls to the `diff --git` header fallback or is skipped. That is the safe direction — degraded parsing must fail toward "counted as change / kept under the header key", never toward relabeling.
- **Counts shift on existing adversarial-shaped inputs.** Any historical block containing in-hunk `+++`/`---`-rendered lines gains additions/deletions it previously dropped. That is the fix, not a regression, but the existing test suite's expected counts are re-checked rather than trusted.
- **The two parsers remain separate.** The class could re-enter via a third parser someday; the spec delta (metadata is preamble-only on the degraded path) is the durable statement, and the core pinning test guards the known sibling.
