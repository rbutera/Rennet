## 1. Decomposition types (types)

- [x] 1.1 Add the `MechanicalClass` closed vocabulary and `HunkKind`
- [x] 1.2 Add `Hunk` (line ranges, added/deleted/context, `changedLoc`, `splitOf` fragment marker) and `HunkClassification` (kind + mechanical class + `""`-degrading `enclosingSymbol`)
- [x] 1.3 Add `DecompositionChunk` (substantive/appendix, layer, budgeted LOC), `DecompositionEdgeKind`/`DecompositionEdge`, and `DecompositionResidueItem`
- [x] 1.4 Add the top-level `Decomposition` (hunks, classifications, chunks, edges, readingOrder, residue)

## 2. Classification (core)

- [x] 2.1 Parse hunks from a file's patch (line ranges, prefixed body, mode-change detection)
- [x] 2.2 File-signal classification: lockfile / vendored / generated (path pattern or `@generated` marker) in precedence order
- [x] 2.3 Structural + per-hunk classification: pure-rename, mode-only, formatting-only (whitespace-stripped equality, both sides non-empty), else substantive; a no-text-hunk file gets one accounted-for synthetic hunk

## 3. Chunking + the ≤400 budget (core)

- [x] 3.1 Split an oversize substantive hunk into contiguous ≤`maxChunkLoc` fragments, recomputing line ranges and marking `splitOf`
- [x] 3.2 Group `file → enclosingSymbol` via the `SymbolExtractor` port (degraded `""` default) and greedy-merge to the budget; mechanical hunks form per-file appendix chunks
- [x] 3.3 Assign deterministic chunk ids and titles (symbol in the title when a chunk is single-symbol)

## 4. Dependency DAG + reading order (core)

- [x] 4.1 Derive `enables` edges from resolvable relative imports in added/context lines (POSIX resolution to a changed file)
- [x] 4.2 Add edges deterministically, dropping any that would close a cycle so `edges` is a guaranteed DAG
- [x] 4.3 Linearise with Kahn's algorithm and a deterministic `(layer, first-path, chunk-index)` tiebreak — logical, never danger/salience

## 5. Tests + gates

- [x] 5.1 Golden classification fixtures: lockfile, vendored, generated (path + marker), formatting-only, pure-rename, mode-only, and a substantive control
- [x] 5.2 Chunking: the ≤400 invariant asserted; a 1,000-line hunk demonstrably splits (3 fragments, LOC preserved); symbol grouping and the degraded default
- [x] 5.3 DAG: an import produces an `enables` edge, ordered dependency-first; an import cycle is broken so `edges` is a DAG; totality (every hunk placed once) and topological validity asserted
- [x] 5.4 Byte-stability across two runs on the same patchset (identical serialisation), and a realistic multi-file patchset rendering the floor with no harness and no network
- [x] 5.5 Red-then-green proof on the oversize-split test (disable the splitter → the named test reddens → restore → green)
- [x] 5.6 Full `pnpm check` green across all 7 projects (format, architecture, licenses, lint, typecheck, test, build)
- [x] 5.7 File follow-up beads: tree-sitter `SymbolExtractor` in adapters; RSP `decomposition.*` document emission; richer binary/submodule handling; end-to-end `GitCaptureAdapter` → `decompose` integration test
