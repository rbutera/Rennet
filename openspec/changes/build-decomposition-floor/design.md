## Context

The Architecture Plan's D7 amendment specifies a validated hybrid decomposition: deterministic code owns totality, classification, size limits, and the offline fallback; a harness proposes a complete versioned graph on top; a validator (already built in the RSP core) admits or rejects. This slice implements only the deterministic FLOOR — the offline half — so #8 (angle generation) and #9 (agent comprehension ordering) have a real, byte-stable decomposition to build on. The governing ratified decisions: mechanical classification is the only admission authority for verified noise (R9); the 400-LOC ceiling holds by splitting an oversize hunk (R18); ordering is logical / dependency-based and agent-owned, with the deterministic DAG order as the baseline (Contracts §1, correction 8); the floor is a floor, never the authority.

## Goals / Non-Goals

**Goals:**

- A pure `decompose(patchset)` in `packages/core` — no network, model, clock, or filesystem — that is byte-stable across two runs on the same patchset and renders with no harness installed.
- Deterministic mechanical classification over the closed `MechanicalClass` vocabulary, as the sole admission authority for verified noise.
- Greedy chunking to a ≤400 changed-LOC budget that holds even against a single oversize hunk, by splitting it into contiguous ≤budget fragments.
- A code-dependency DAG derived from resolvable relative imports, and a topological reading order that is dependency-first with a logical layer/path tiebreak — never danger / salience.

**Non-Goals:**

- The tree-sitter `SymbolExtractor` implementation — a native, filesystem-reading, adapters concern behind the port defined here. The floor ships with the degraded (`""`) default.
- Mapping the native `Decomposition` onto RSP `decomposition.*` documents (anchors, provenance) — that is #8 territory and needs the offered manifest.
- The agent-produced final comprehension ordering (#9). This slice is the baseline it reads through, not the final order.
- Rich binary / submodule / truncated-input treatment beyond a single accounted-for synthetic hunk (R18's broader ingestion slice).

## Decisions

### The floor is split types-vs-core, matching the existing arrows

The decomposition data shapes join `Patchset` / `Review` and the RSP types in `packages/types` (import-nothing), so a future `packages/ui` can render the floor's output without importing `@rennet/core`. The engine joins the review logic in `packages/core` (which already consumes `Patchset`). The floor needs nothing `node:*`, so it stays pure and portable even though `core` is not required to be node-free.

### Classification precedence is file-signal first, then per-hunk

A hunk's mechanical class is decided in a fixed order so every fixture is unambiguous: lockfile path, then vendored path, then generated (path pattern OR a `@generated` / `DO NOT EDIT` marker in the added/context lines), then the whole-file structural signals (pure rename with zero net change, mode-only change with no body), then per-hunk formatting-only (added and deleted content identical after removing all whitespace, both sides non-empty), else substantive. A file with no text hunks (pure rename, mode-only, or a binary blob) is represented by one synthetic zero-LOC hunk so totality holds; a bare binary asset with no mechanical signal stays substantive because it is a real change the reviewer must see, just not text-diffable.

### Oversize splitting preserves the ≤400 invariant without straddling a changed line

Only substantive hunks are split (mechanical hunks go to appendix chunks and are skimmed, not budgeted). An oversize hunk is walked line by line and cut before a changed line once the current fragment holds `maxChunkLoc` changed lines, recomputing each fragment's old/new line ranges. Because every post-split hunk is `≤ maxChunkLoc`, greedy chunking then packs hunks up to the budget and every substantive chunk lands `≤ 400` — the invariant holds structurally rather than by assertion. `splitOf { index, total }` marks each fragment.

### The DAG is import-derived, acyclic by construction, and logical never salient

Edges come from resolvable relative import specifiers (`from './x'`, `require('./x')`, dynamic `import('./x')`) in a chunk's added and context lines, resolved POSIX-style against the importer to another changed file. An edge points from the imported file's defining chunk to the importing chunk (`enables`). Candidate edges are added in a deterministic sorted order and any edge that would close a cycle is dropped, so the stored `edges` is a guaranteed DAG (V103). The reading order is Kahn's algorithm with a deterministic tiebreak over `(layer, first-file-path, chunk-index)` — dependency-first, then the base-principles reading layer (schema → types → core → ui → tests → config → appendix), then path. This is logical ordering; nothing in the floor consults blast-radius or salience.

### The symbol extractor is a port with a degrading default

Grouping is `file → enclosingSymbol`. The `SymbolExtractor` port answers per file over that file's substantive hunks; the default returns `""` for every hunk, so the floor groups by file alone. A real tree-sitter extractor (parse-once-dispose, reading the working-tree file) is a follow-up adapter; the port contract requires it never to throw and to degrade to `""` on a missing grammar, so a language the floor cannot parse never blocks it.

## Risks / Trade-offs

- Import edges are derived from added and context lines only, not a full resolved import graph, so the DAG is a sparse floor. Mitigation: this is the deterministic baseline the agent ordering pass (#9) refines; a sparse-but-correct DAG still yields a valid, byte-stable topological order, and the layer/path tiebreak carries the ordering where no edge exists.
- A bare binary asset is classified substantive with zero LOC. Mitigation: it is surfaced as its own chunk rather than hidden; richer binary/submodule handling is a named follow-up (R18).
- Formatting-only detection strips all whitespace, so a change that only moves tokens across lines without altering non-whitespace content reads as formatting-only. Mitigation: this is the intended semantics (reindent / reflow is mechanical), and it is the safe direction — the deterministic pass is the admission authority for noise, and a mis-called reformat is visible in its appendix chunk, never dropped.
