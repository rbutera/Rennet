---
tags: [rennet, architecture, plans]
categories: [project]
status: active
created: 2026-08-04
updated: 2026-08-05
---

# Rennet Architecture Plan

> [!IMPORTANT] Current implementation authority, 2026-08-06
> ⛔ **SUPERSEDED 2026-08-06: the banner below (originally 2026-08-05) restated two rules that are now reversed. Rennet is MIT throughout (no AGPL-3.0-only, no Apache-2.0 split), and the Claude Agent SDK is ADOPTED, not banned — see Master Plan R2/R3. The rest of the banner's rulings still stand.**
> This is a detailed historical plan for **Rennet**. [[Rennet Master Plan]], [[Rennet Architecture Contracts]], [[Rennet Dependency Standard]], and [[Rennet Navi Handoff]] override every conflicting recipe below. In particular: use `@rennet/*`; use the final package tree in Master Plan R21; `ui` imports only `protocol` and `types`; ~~licence open packages as `AGPL-3.0-only`; never link the Claude Agent SDK~~ (both superseded 2026-08-06, see note above); use occurrence IDs plus a lineage graph; use validated hybrid decomposition; never invoke a harness per hunk; the six angles exclude Subtraction; route handoff is removed; use `ForgePort`, not `GithubPort`; and use Nx + Vite 8 + Electron Forge, not Turbo or mixed packagers. Sections and backlog rows that retain the old design are evidence and rationale only, not build instructions.

Implementation architecture for [[Code Review Harness App]]. The product name is Rennet; the filename is retained only to preserve existing Obsidian links. Current package choices are in [[Rennet Dependency Standard]]; the older stack note remains research evidence.

Audience: an autonomous implementation agent (Navi). This document is decision-complete where it can be and explicitly refinement-hooked where it cannot. Read [[Code Review Harness App]] first for product intent and [[Rennet Dependency Standard]] for package choices.

Evidence rule applied throughout: every capability claim either cites the stack note or was verified today against the package's own `.d.ts` / schema / a live command. Verification transcripts are summarised in "Verified findings" below. Nothing here is asserted from memory.

---

## 0. Verified findings that change the stack note

Four things were checked directly today because the plan leans on them. Two of them materially change the plan the stack note anticipated.

### 0.1 `@pierre/diffs` ships virtualization AND a worker pool (RESOLVES spike #1)

The stack note lists this as the single highest-information-value unknown: *"Virtualization is not documented... Unverified. Prototype this first, before any other engineering."*

**It is not unknown. It ships.** Verified by extracting the published tarball and reading the type definitions (`@pierre/diffs@1.2.12`; the 1.3.x line was published after this environment's registry cutoff of 2026-07-28 and could not be fetched, so treat the exact 1.3.2 surface as *very likely a superset* and re-confirm on first install).

Confirmed exports from `@pierre/diffs/react`:

- `Virtualizer`, `VirtualizerContext`, `useVirtualizer` — a first-class virtualization component with a `config?: Partial<VirtualizerConfig>` prop.
- `CodeView` — a **multi-file** virtualized surface taking `items: readonly CodeViewItem<LAnnotation>[]`, with a `CodeViewHandle` exposing `addItems`, `updateItem`, `updateItemId`, `scrollTo(target)`, `setSelectedLines`, `getSelectedLines`. Controlled and uncontrolled variants.
- `WorkerPoolContextProvider`, `useWorkerPool`, and from `@pierre/diffs/worker`: `WorkerPoolManager`, `getOrCreateWorkerPoolSingleton`, `terminateWorkerPoolSingleton`. Every render component takes `disableWorkerPool?: boolean`.
- Virtualization plumbing types: `RenderWindow {top,bottom}`, `RenderRange {startingLine,totalLines,bufferBefore,bufferAfter}`, `VirtualWindowSpecs`, `VirtualFileMetrics {hunkLineCount, lineHeight, diffHeaderHeight, spacing, ...}`, plus `DEFAULT_RENDER_RANGE`, `DEFAULT_VIRTUAL_FILE_METRICS`, `computeVirtualFileMetrics()`.
- Generic annotations: `DiffLineAnnotation<T> = { side: 'deletions'|'additions'; lineNumber: number } & OptionalMetadata<T>`, with `renderAnnotation(annotation, item) => ReactNode`. **The annotation payload type is a generic parameter**, so our domain annotation type slots in without a fork.
- `parsePatchFiles` is exported, returning `ParsedPatch { patchMetadata?: string; files: FileDiffMetadata[] }`.
- `CodeViewDiffItem<T> = { id: string; type: 'diff'; fileDiff: FileDiffMetadata; annotations?: DiffLineAnnotation<T>[]; version?: number; collapsed?: boolean }`.

Three consequences:

1. **Spike #1 collapses from "does this work at all" to "measure it".** The remaining question is only whether it hits 120Hz on a 5k-line file, not whether windowed rendering exists.
2. **Shiki-in-a-worker is largely provided, not hand-built.** The stack note's item 5 ("Shiki in a worker, tokens over postMessage") is Pierre's worker pool. Do not build a parallel one.
3. **`@tanstack/react-virtual` is probably redundant for the diff surface.** `CodeView` already virtualizes across files and lines. Keep react-virtual only for non-diff lists (the chunk rail, the finding queue). This is a small dependency saving and, more importantly, avoids two competing scroll owners on one surface. See D14.

The `version?: number` and `updateItemId` on `CodeViewHandle` are a gift: they map directly onto our patchset model (D5) and let a force-push re-render in place without remounting the surface.

### 0.2 Kysely + node-sqlite3-wasm needs a ~40-line shim, not a custom dialect

Kysely's built-in `SqliteDialect` accepts any object satisfying its structural `SqliteDatabase` interface, so **no custom `Dialect`/`Driver`/`Adapter`/`Introspector` is needed**. Verified against `kysely@0.29.4`'s own files:

```ts
// kysely: dialect/sqlite/sqlite-dialect-config.d.ts (verbatim shape)
interface SqliteDatabase { close(): void; prepare(sql: string): SqliteStatement }
interface SqliteStatement {
  readonly reader: boolean
  all(parameters: ReadonlyArray<unknown>): unknown[]
  run(parameters: ReadonlyArray<unknown>): { changes: number|bigint; lastInsertRowid: number|bigint }
  iterate(parameters: ReadonlyArray<unknown>): IterableIterator<unknown>
}
```

`kysely`'s `SqliteConnection.executeQuery` branches on `stmt.reader` to choose `all()` vs `run()` (read from `dialect/sqlite/sqlite-driver.js`). `node-sqlite3-wasm@0.8.60`'s `Statement` provides `run/all/get/iterate/finalize` but **has no `reader` property**, so the shim must supply it. It also requires explicit `finalize()` because it is a WASM build whose statement memory is not garbage-collected, and Kysely never finalizes. Both gaps are handled in D8.

`SqliteDialect` and friends are exported from the kysely root via `export *` re-exports of `dialect/sqlite/*`.

> Calibration note worth carrying: my first check for `SqliteDialect` in `index.d.ts` returned zero hits and I nearly recorded "not exported". The locator was wrong (the symbols arrive via `export *`), not the fact. An empty result that confirms a convenient assumption is the highest-risk output there is; the fix was to chase where it *does* live.

### 0.3 The workspace model is correct, and Rai's layout proves it

Ran real `git` plumbing against the actual machine (`/usr/bin/git` 2.50.1 and `/opt/homebrew/bin/git` 2.53.0):

| Directory | `--git-common-dir` | `--show-toplevel` |
|---|---|---|
| `/workspace` | `/workspace/.git` | `/workspace` |
| `/workspace/docs` | `/workspace/.git` | `/workspace` |
| `/workspace/product-repo` | `/workspace/product-repo/.git` | `/workspace/product-repo` |
| `/workspace/wt/feature-branch` | **`/workspace/product-repo/.git`** | `/workspace/wt/feature-branch` |

The last row is the whole argument in one line: a directory sitting physically **inside** the `/workspace` repo tree belongs, by object store, to **product-repo**. `wt/` is gitignored by `/workspace` (`.gitignore:28`), which is how the two coexist. `git worktree list --porcelain` on product-repo also reports worktrees in a *second* location, `/workspace/product-repo/.claude/worktrees/*`, so worktree roots are plural and unpredictable.

Keying review state on directory path would file the same product-repo review under two or three different identities. Keying on `--git-common-dir` groups them correctly and for free. **The four-noun model is validated against ground truth, not just reasoning.**

### 0.4 Never spawn git through a shell

While gathering the above, `git worktree list --porcelain` invoked through this agent's shell returned *human-readable* output (`/workspace/product-repo <private-ref> [main]`), while invoking either git binary directly returned correct porcelain (`worktree <path>` / `HEAD <oid>` / `branch <ref>`). I did not isolate the cause (an interactive `zsh -i` showed `git` resolving to the plain binary, so it is environment-specific rather than a user alias I could reproduce).

The cause does not matter; the rule does. **`GitPort` must resolve an absolute git path and `spawn` it with `shell: false`, then defensively assert the output shape** (e.g. first line of a porcelain worktree listing starts with `worktree `). A review tool that silently mis-parses a wrapped git produces a plausible wrong answer, which is the worst failure mode available to it. This constraint is not in the stack note; it belongs in the wrapper.

### 0.5 Biome can enforce import boundaries

Verified against `@biomejs/biome@2.5.6`'s own `configuration_schema.json`: `style/noRestrictedImports` exists and takes `{ paths, patterns }`, where `patterns[].group` is an array of gitignore-style source patterns and `paths` maps a module specifier to a message string. There is also `nursery/noRestrictedDependencies`, but it is nursery (unstable) and its options schema is empty, so it is not load-bearing here. Config in D3.

---

## 1. Decisions

Each decision states the call, why, and what was rejected. **Frozen** decisions are load-bearing; Navi must not change them without escalating. **Adjustable** decisions are defaults Navi may revise given evidence.

### D1 — SUPERSEDED: original five-package sketch

> [!IMPORTANT] Current package tree
> Use `packages/{types, protocol, core, adapters, ui, instructions, tsconfig}` plus `apps/{desktop, mobile-placeholder}`, `scripts/`, and non-workspace `spikes/`. Packages use `@rennet/*`. `protocol` and `types` are Apache-2.0 and import no other in-repo packages. `ui` imports only those two packages. The old tree below is historical. ⛔ **SUPERSEDED 2026-08-06: the Apache-2.0 designation on `protocol`/`types` is gone — every package is MIT.**

The hub note proposes `core/` + `shell/` + `ui/`. Concretely:

```
wingman/
├── packages/
│   ├── core/         @wingman/core       portable domain. zero node:*, zero react, zero electron
│   ├── adapters/     @wingman/adapters   Node implementations of core's ports
│   └── ui/           @wingman/ui         renderer React app. zero node:*, zero electron
├── apps/
│   ├── desktop/      @wingman/desktop    Electron shell (main + preload) == the hub's `shell/`
│   └── mobile/       @wingman/mobile     Expo companion (LATER)
└── tooling/          shared tsconfig, biome config, boundary check script
```

`core` exposes three subpath entries per the stack note's `exports` sketch: `.` (full domain, desktop only), `./protocol` (wire types + command contract), `./types` (domain types). **The phone imports only `./protocol` and `./types`.**

Why `adapters` is its own package rather than living in `apps/desktop`: it makes the port/implementation seam a *package boundary*, which is mechanically enforceable (D3) rather than a convention. It is also the package a Tauri port deletes and rewrites in Rust, so isolating it now sizes the port honestly.

Rejected: a single package with folders (boundaries become vibes); `core` split into `core-domain` + `core-protocol` (two packages to save one subpath export, and the stack note already specifies subpaths).

### D2 — AMENDED: dependency rules

The current dependency matrix is the package tree above plus Master Plan R3/R4/R20/R21. In particular, `ui → core` and mobile importing core subpaths are prohibited; `protocol` may import `types`, and neither Apache package may import anything else in-repo. ⛔ **SUPERSEDED 2026-08-06: there is no "Apache package" distinction any more — `protocol` and `types` are MIT, same as the rest of the repo. The import-boundary rule itself (architecture, not licensing) still stands.**

| Package | May import | Must never import |
|---|---|---|
| `core` | nothing internal; pure TS + `zod` | `node:*`, `electron`, `react`, `@wingman/*` |
| `adapters` | `core`, `node:*`, Node libs | `react`, `electron` renderer APIs, `@wingman/ui` |
| `ui` | `core` (types/protocol/commands), React libs | `node:*`, `electron`, `@wingman/adapters` |
| `desktop` | `core`, `adapters`, `ui`, `electron`, `node:*` | — |
| `mobile` | `core/protocol`, `core/types` only | everything else internal |

The rule that carries the most weight: **`core` imports nothing from `node:*` at module scope** (stack note §10, rule 1). Every platform capability enters through a port declared in `core` and implemented in `adapters`.

Ports (declared in `core`, implemented in `adapters`):
`GitPort`, `FsPort`, `StorePort`, `HarnessPort`, `ForgePort` (GitHub), `ClockPort`, `RandomPort`, `LoggerPort`, `DialogPort`.

`DialogPort` exists specifically because the stack note flags that Playwright cannot intercept native Electron dialogs, so every dialog must be behind an injectable seam for tests. `ClockPort` and `RandomPort` exist so event streams are deterministic under test — this matters more than usual for an event-sourced system, because replay tests are the primary correctness tool.

### D3 — Boundary enforcement is mechanical, in four independent layers. FROZEN

A convention nobody can violate beats a convention everybody agrees with. Four layers, each of which alone would catch most violations:

1. **Package manifests (strongest).** `@wingman/ui`'s `package.json` simply does not list `@wingman/adapters`. Under pnpm's strict non-hoisted `node_modules` (stack note §10) the import fails to resolve. This cannot be argued with.
2. **`core`'s tsconfig has `"types": []` and no `@types/node`.** Without Node's ambient types, `import { readFile } from 'node:fs'` fails `tsc --noEmit`. This is the cheapest possible guard against the single most important rule, and it fails at typecheck rather than at review.
3. **Biome `style/noRestrictedImports`** (verified available, §0.5), scoped per package via `overrides`:

```jsonc
// biome.jsonc
{
  "overrides": [
    {
      "includes": ["packages/core/**", "packages/ui/**"],
      "linter": { "rules": { "style": { "noRestrictedImports": { "level": "error",
        "options": { "patterns": [
          { "group": ["node:*"], "message": "core/ and ui/ are portable. Add a port to core/ports and implement it in adapters/." },
          { "group": ["electron", "electron/*"], "message": "Electron belongs to apps/desktop only." }
        ] } } } } }
    },
    {
      "includes": ["packages/ui/**"],
      "linter": { "rules": { "style": { "noRestrictedImports": { "level": "error",
        "options": { "patterns": [{ "group": ["@wingman/adapters", "@wingman/adapters/**"],
          "message": "The renderer never holds domain logic. Go through the IPC command contract." }] } } } } }
    }
  ]
}
```

4. **`tooling/check-boundaries.ts`, run in CI and in `pre-push`.** ~40 lines: parse every `import`/`export ... from` specifier in each package, assert against the D2 matrix, exit non-zero with the offending file:line. This exists because it is the only layer that can also assert the *positive* rule (`core/protocol` and `core/types` must not import `core` internals), which keeps the mobile surface at the ~15% the stack note budgets for.

Calibration requirement on layer 4: **the boundary checker ships with a fixture that violates each rule**, and CI asserts the checker fails on the fixture. A boundary check that cannot fail has not passed.

### D4 — SUPERSEDED: content-addressed hunk identity

> [!DANGER] Do not implement this identity model
> The current model is an immutable `OccurrenceId` plus an explicit lineage graph with exact, one-to-one, split, merge, move, ambiguous, and rejected edges. Path, symbol, content hashes, and similarity are matcher evidence only. Similarity never carries read state; ambiguity fails closed and reopens the occurrence. Exact byte-identical lineage may preserve unaffected analysis only after the matcher-precision gate passes. `hunkKey` survives only as a feature and dismissal-key input. See Master Plan R8 and the canonical review/patchset contract.

The remainder of D4 records the superseded design and its original rationale.

This is the load-bearing decision of the whole system, so it gets the fullest defence.

**The call: content-derived identity, with an explicit similarity-match tier, and line positions kept only as presentation data that is never used for identity.**

Three tiers:

1. **`hunkKey`** — stable identity used to carry state across patchsets.
   `sha256(fileIdentity ‖ enclosingSymbolPath ‖ normalizedBody)`, truncated to 128 bits, base32url.
   - `fileIdentity` = the *new* path, with rename detection recording `prevPath` separately (git's `--find-renames` gives this).
   - `enclosingSymbolPath` = e.g. `PaymentService::applyRefund` from `web-tree-sitter` (stack note §3: tree-sitter for structure, not diffing). Empty string when no parser exists for the language, which degrades identity gracefully rather than failing.
   - `normalizedBody` = **only the `+`/`-` lines**, whitespace-collapsed, with line numbers absent. Context lines are deliberately excluded.
2. **`hunkVersionId`** — what read state actually attaches to.
   `sha256(hunkKey ‖ patchsetId ‖ exactBody)`. "Read" always means "read *this* version".
3. **Similarity carry-forward** — when a `hunkKey` finds no exact match in the previous patchset, compare unmatched hunks *within the same file and symbol* by token-level similarity (jsdiff, which the stack note already includes for intraline work). At or above threshold (default 0.6), emit `hunk.carriedForward` with `method: 'similar'` and a confidence score.

**Why context lines are excluded from `normalizedBody`:** a rebase changes the code *around* your change without changing your change. Including context would break identity on every rebase, which is exactly the failure being designed against.

**Why `fileIdentity` and `enclosingSymbolPath` are included:** without them, the same three-line boilerplate added to twelve files hashes to one key, and marking one read would mark all twelve read. That is a silent correctness failure in the direction of false confidence — the worst direction for this product.

**What the similarity tier buys:** the single most common force-push is "author addressed review feedback by editing two lines". Pure content-addressing treats that as a brand-new hunk and throws away the thread, the obligations, and the reviewer's context. Similarity matching keeps the anchor, marks the hunk `needsReread`, and — because both versions are retained — lets the UI show a **version-to-version mini-diff** ("you read v1; here is what changed"). That view is only possible because identity is content-based and both versions persist.

**Alternative rejected — line-anchored identity (GitHub's model):** cheaper, exact positions, no matching pass. Rejected because a line anchor is a function of the diff, which is a function of the base commit; a rebase changes the base and therefore invalidates every anchor at once. GitHub's own visible symptom of this — comments going "outdated" after a force-push — is a named part of the problem this product exists to solve. Adopting the mechanism that causes it would be self-defeating.

**Alternative rejected — git blob OIDs as identity:** OIDs identify whole file contents, not hunks, and change on any edit anywhere in the file. Too coarse.

**Alternative rejected — LLM-assigned stable ids:** non-deterministic, unavailable offline, and unauditable. Identity must be computable with zero model calls; the product must survive with the network off.

Cost, stated honestly: the matching pass is O(n) with an O(k²) fallback within a file's unmatched set, k being small. On a 200-hunk changeset this is milliseconds. Rename-heavy or generated-file-heavy changesets are where similarity matching will misfire; those are also where `mechanical: true` classification (D10) suppresses the cost of getting it wrong.

### D5 — Patchsets are immutable snapshots; mid-review pushes never mutate in place. FROZEN

Ratified in the hub note ("snapshot + auto-reopen is the mid-review model"). Mechanically:

- A `Patchset` is `(baseOid, headOid, capturedAt)` where `baseOid` is the merge-base with the target ref, not the target tip. Using merge-base means an unrelated advance of `main` does not manufacture a new patchset.
- New head OID observed → append `patchset.observed`, compute the diff, run the D4 matching pass, emit carry-forward / appeared / disappeared events, recompute angles.
- **No event is ever rewritten.** A hunk being superseded is a new event, not an edit.
- The reviewer is never yanked: the current reading position stays on the patchset they are reading. The new patchset arrives as an offer ("3 new commits, 12 hunks changed — review changes"), which the UI can honour without losing place because `CodeViewHandle.updateItemId` and `CodeViewItem.version` exist (§0.1).

### D6 — Angles are pure computed views over one hunk set, never stored groupings. FROZEN

The hub note's ratified vocabulary: the concurrent breakdowns are **angles**; the groups are **chunks**.

An angle is a **total function** `(HunkVersion[], AngleInput) => AngleView`. Consequences that fall out for free:

- The fixed-point rule (the hunk under the cursor never moves on angle rotation) is trivial, because every angle is a re-projection of the same array.
- Universal read state is trivial, because read state lives on `hunkVersionId`, not on the angle.
- The **residue check** is a totality assertion: every hunk must appear in the sequence angle. A hunk that no angle places raises `residue.detected`, which is a loud error state, not a silent omission.
- Angles are recomputable at any time, so they never need migrating. Only their *inputs* (harness proposals, human corrections) are events.

`AngleView` is cached in a projection keyed by `(angleId, patchsetId, inputDigest)` so rotation is instant, but the cache is always disposable.

### D7 — AMENDED: validated hybrid decomposition

> [!IMPORTANT] Current rule
> Deterministic code owns totality, classification, size limits, validation, and the offline fallback. A harness proposes one complete, versioned decomposition graph with rationale; it never emits per-hunk regroup operations. The validator rejects omission, duplication, oversize chunks, and invalid anchors. A human accepts or edits the proposal. The deterministic result is the floor, not the semantic authority. Initial decomposition must remain under five harness invocations and produce a useful first chunk within 15 seconds.

This closes the hub's open question *"Cohorting engine: deterministic vs LLM-proposed vs hybrid?"*

**Superseded answer retained for history:** the original plan made the deterministic baseline authoritative. Master Plan R9 replaces that with the validated hybrid contract above.

The deterministic pass:

1. Classify each hunk: `mechanical` (lockfiles, generated-file markers, pure renames, formatting-only, vendored paths) vs `substantive`.
2. Group `substantive` hunks by `(file → enclosingSymbol)`.
3. Merge greedily into chunks of **≤ 400 changed LOC** (the SmartBear/Cisco ceiling in the hub note), never splitting a hunk across chunks.
4. Order by layer heuristic: migrations/schema → types/interfaces → core logic → call sites → UI → tests → config → generated. This is the *default* strategy; the hub note requires ordering be **named switchable strategies** (tests-first and spine-first are the other two published orders), so `orderStrategy` is a parameter, not a constant.
5. `mechanical` hunks form appendix chunks, pre-collapsed with a summary row, eligible for `skimmed` rather than `read`.

Why deterministic-first rather than LLM-first: the app must open a PR and be useful with the network down, with no key configured, and in under a second. A model that improves the grouping is a large win; a model that is *required* for the grouping makes the core unusable when it is slow, absent, or wrong. It also makes the grouping testable — a golden-file test over a fixture repo, which an LLM-first design cannot have.

The old `hunk.regrouped` harness recipe is retired. Harness output is admitted atomically as `decomposition.proposed`, then accepted, rejected, or human-edited as a complete graph. Human corrections remain durable inputs; deterministic validation remains mandatory.

### D8 — Event store: SQLite via kysely, synchronous fold-forward projections. FROZEN

Store lives in the engine utility process (D12), which is the **single writer**.

The kysely seam, given §0.2 — this is the whole adapter, and it is the only place the WASM/native distinction leaks:

```ts
// adapters/store/sqlite-wasm-bridge.ts
import { Database } from 'node-sqlite3-wasm'
import type { SqliteDatabase, SqliteStatement } from 'kysely'

const READER = /^\s*(?:select|with|pragma|explain)\b/i
const RETURNING = /\breturning\b/i

export function bridge(db: Database): SqliteDatabase {
  return {
    close: () => db.close(),
    prepare(sql): SqliteStatement {
      const stmt = db.prepare(sql)
      // node-sqlite3-wasm exposes no `reader`; kysely branches on it.
      const reader = READER.test(sql) || RETURNING.test(sql)
      // node-sqlite3-wasm is WASM: statement memory is NOT gc'd and kysely never
      // finalizes. Finalize eagerly after terminal ops or the process leaks.
      return {
        reader,
        all: (p) => { try { return stmt.all(p as never) } finally { stmt.finalize() } },
        run: (p) => { try { return stmt.run(p as never) } finally { stmt.finalize() } },
        iterate: (p) => stmt.iterate(p as never), // caller-driven; finalized by the store wrapper
      }
    },
  }
}
```

Two hazards encoded above, both verified rather than assumed: the missing `reader` property, and the un-GC'd statement memory. The `RETURNING` clause is included in the reader test because a `RETURNING` insert must go through `all()` to yield rows.

**Refinement hook:** the `reader` regex is the weakest line in this file. If `node:sqlite` turns out to be available in Electron 43 (stack note §6, "check on day one"), its `StatementSync` may expose a cleaner signal; and either way this deserves a unit test that runs every statement shape the query builder actually emits.

Schema:

```sql
CREATE TABLE events (
  seq           INTEGER PRIMARY KEY AUTOINCREMENT,
  id            TEXT    NOT NULL UNIQUE,          -- uuidv7, client-generated
  review_id     TEXT    NOT NULL,
  patchset_id   TEXT,
  ts            INTEGER NOT NULL,
  actor_kind    TEXT    NOT NULL,                 -- human | harness | system
  actor_id      TEXT,
  type          TEXT    NOT NULL,
  v             INTEGER NOT NULL,                 -- per-type payload schema version
  private       INTEGER NOT NULL DEFAULT 0,       -- see D9
  causation_id  TEXT,
  payload       TEXT    NOT NULL                  -- JSON
) STRICT;
CREATE INDEX events_review_seq  ON events(review_id, seq);
CREATE INDEX events_review_type ON events(review_id, type, seq);

CREATE TABLE projection_meta (name TEXT PRIMARY KEY, last_seq INTEGER NOT NULL, schema_version INTEGER NOT NULL) STRICT;
```

Projections (all disposable, all rebuildable from `events`): `proj_hunk_state`, `proj_chunk_membership`, `proj_obligation`, `proj_thread`, `proj_finding`, `proj_decision`, `proj_review_summary`.

**Projection strategy: fold forward synchronously inside the same transaction as the append.** There is exactly one writer, the volume is tiny (a thorough review of a 3,000-line PR is order 2,000 events), and the UI wants the read model to be correct the instant the command returns. Asynchronous projections would buy nothing and cost cache-invalidation bugs.

Rejected: an async projection worker (no benefit at this scale, real complexity); keeping only events and folding on every read (fine at 2k events, wrong at 50k, and the fix is exactly this table).

### D9 — Pace and dwell data are private by construction, not by policy. FROZEN

The hub note ratifies *"pace/coverage data is private to the reviewer, full stop"*. A policy note in a spec is a check that cannot fail. Instead:

- Every event type carries a static `private: boolean` in the type registry, persisted onto the row.
- `hunk.read`'s `dwellMs`, `session.*`, and all pace-derived events are `private: true`.
- **The publish projection reads from a view that excludes `private = 1` rows**, and the publish payload builder takes only that projection as input. It is structurally incapable of seeing dwell time.
- A test asserts that for a review containing private events, the publish payload digest is byte-identical to one produced from a store with those events deleted.

That test is the mechanism. Without it this is a promise; with it, it is a property.

### D10 — Diff pipeline: parse once in `core`, hand raw patch text to Pierre. FROZEN

`core` owns the domain parse (identity, chunking, angles). `ui` owns the render. They must not share a type, because `FileDiffMetadata` is Pierre's and would drag a UI dependency into `core`.

The seam: `core` retains, per file, both its own `FileDiffIR` **and** the raw unified-diff text slice for that file. `ui` feeds the raw slice to Pierre (`PatchDiff` takes `patch: string`; `CodeView` takes items) and uses `FileDiffIR` only to compute annotations and anchors. This avoids reimplementing Pierre's parsing expectations and keeps one source of truth for what is on screen.

Rejected: mapping `FileDiffIR` → `FileDiffMetadata` by hand in `core` (couples core to a UI package's type, and to its version churn); using Pierre's `parsePatchFiles` as the domain parser (it lives in a React rendering package; `core` must not import it).

### D11 — Typed IPC: one command map in `core`, zod-validated at the boundary, streams over `MessageChannelMain`. FROZEN

Per the stack note: write it (~200 lines), do not adopt electron-trpc (stale, no tRPC 11 support) — the boundary is a public API precisely so a Tauri port stays a port.

The core rule this encodes: **the renderer never holds domain logic.** The command map is the only door.

### D12 — AMENDED: main routes, engine owns state, adapters own harness lifecycle

> [!IMPORTANT] Claude process rule
> ⛔ **SUPERSEDED 2026-08-06: the ban on the Claude Agent SDK below is reversed — the SDK is now adopted; see Master Plan R2.** The clean-room process-per-turn CLI wrapper this rule prescribes is no longer the mandated design.
> Never import or bundle `@anthropic-ai/claude-agent-sdk`. The Claude adapter starts a clean `claude -p` child process for each turn, using `--resume <id> --fork-session` when continuing a logical Rennet thread. Rennet persists the logical thread and the minimum harness session identifier needed to continue it, not a long-lived SDK process. Other adapters may be long-lived only where their verified protocol requires it. Process ownership follows the adapter capability, not a universal one-process-per-session rule.

Per the stack note §1: heavy work goes in `utilityProcess`, not the main process and not `child_process.fork`.

- **main** — windows, menus, IPC dispatch, `safeStorage`, updates. No domain work, ever. It must never block.
- **engine** (one `utilityProcess`) — `GitPort`, diff parse, tree-sitter, chunking, angles, **and the SQLite event store**. Single writer. The store lives here rather than in main specifically because `node-sqlite3-wasm` is synchronous, and synchronous SQLite on the main process is a jank source on exactly the frames the product is judged by.
- **harness adapter host** — supervises child processes according to the verified adapter contract. Claude is process-per-turn over the installed CLI; Codex uses its app-server protocol. No proprietary SDK or harness binary is linked or bundled. ⛔ **SUPERSEDED 2026-08-06: the Claude Agent SDK is adopted; the "no proprietary SDK" posture no longer applies to Claude.**
- **renderer** — React, `@pierre/diffs`, and Pierre's worker pool for highlighting.

### D13 — Two streaming channels: ephemeral deltas bypass the store, durable events do not. FROZEN

A harness emits thousands of token deltas per response. Persisting them would bloat the log with data nobody replays and make projection folds hot.

- **Durable channel:** harness process → engine → normalize to protocol event → **append + fold** → push to renderer. Everything that constitutes review state.
- **Ephemeral channel:** harness process → engine (coalesced at ~16ms) → renderer, **not persisted**. Token deltas, progress, spinners.

When a response completes, the engine appends one `thread.messageAdded` with the assembled content. Reload after a crash therefore loses an in-flight partial answer and nothing else, which is the correct trade.

### D14 — One scroll owner per surface. ADJUSTABLE

Given §0.1, `CodeView` owns virtualization and scrolling on the diff surface. `@tanstack/react-virtual` is used only for the chunk rail, finding queue, and PR inbox. Do not nest a react-virtual scroller inside `CodeView`.

Adjustable because it depends on the spike: if `CodeView`'s windowing proves inadequate for a 5k-line file, the fallback is to virtualize *files* with react-virtual and render whole files with Pierre, which the stack note already identifies as the graceful degradation.

### D15 — Publish is a three-phase, idempotent act. FROZEN

`publish.prepared` (records exactly what will be sent, plus a payload digest) → `publish.signed` (the human ceremony; the hub's ratified signature gesture) → `publish.succeeded` (records GitHub's returned ids) or `publish.failed`.

Why three phases: submitting a review is the one irreversible external side effect in the product. If the network dies between "signed" and "succeeded", a retry must not double-post. Recording external ids on success and the digest on prepare makes retry safe and makes "did this land?" answerable from the log alone.

GitHub mechanics per the stack note §8: batch every comment into one `addPullRequestReview` + `submitPullRequestReview` via `@octokit/graphql`, so a decomposed review lands as **one** review event rather than a spray of notifications. Auth via `gh auth token`, never stored.

---

## 2. Type sketches

Illustrative, not final. Names are load-bearing where D-decisions reference them.

### 2.1 Workspace and repo model (`core/types`)

```ts
/** Identity is the git common dir, resolved and realpath'd. NEVER a working path. */
export type RepoId = string & { readonly __brand: 'RepoId' }
export type WorktreeId = string & { readonly __brand: 'WorktreeId' }
export type ChangesetKey = string & { readonly __brand: 'ChangesetKey' }
export type ReviewId = string & { readonly __brand: 'ReviewId' }      // `${RepoId}:${ChangesetKey}`
export type PatchsetId = string & { readonly __brand: 'PatchsetId' }
export type HunkKey = string & { readonly __brand: 'HunkKey' }
export type HunkVersionId = string & { readonly __brand: 'HunkVersionId' }

export interface Repo {
  id: RepoId                 // realpath of --git-common-dir
  displayName: string
  worktrees: Worktree[]
  defaultRemote?: { host: 'github.com' | string; owner: string; name: string }
}

export interface Worktree {
  id: WorktreeId             // realpath of --show-toplevel
  repoId: RepoId
  path: string
  head: { oid: string; branch?: string; detached: boolean }
  isPrimary: boolean
  /** True when this worktree lives inside a DIFFERENT repo's tree (Rai's /workspace/wt/*). */
  nestedInForeignRepo: boolean
}

export interface Workspace {
  rootPath: string
  mode: 'project' | 'workspace'
  repos: Repo[]
  config?: WorkspaceConfig   // optional, committable; zero-config path never requires it
}

/** The review unit. A PR is one source of these. */
export interface Changeset {
  key: ChangesetKey
  repoId: RepoId
  source:
    | { kind: 'pull-request'; forge: 'github'; number: number; owner: string; name: string }
    | { kind: 'branch-diff'; baseRef: string; headRef: string }
    | { kind: 'working-tree'; worktreeId: WorktreeId }
  title?: string
}
```

### 2.2 Diff pipeline intermediate representations (`core/diff`)

Each stage's output is the next stage's input. All are plain data, all serialisable.

```ts
// Stage 1 -> 2 : GitPort emits raw unified diff text (streamed, cancellable)
export interface RawDiff { patchsetId: PatchsetId; text: string; truncated: boolean }

// Stage 2 -> 3 : own parser (stack note: plan to own it; parse-diff only to bootstrap)
export type ChangeKind = 'added' | 'deleted' | 'modified' | 'renamed' | 'copied' | 'mode-changed'

export interface RawFileDiff {
  path: string
  prevPath?: string
  changeKind: ChangeKind
  isBinary: boolean
  isSubmodule: boolean
  oldMode?: string
  newMode?: string
  oldOid?: string
  newOid?: string
  hunks: RawHunk[]
  /** Byte range into RawDiff.text for this file. Handed verbatim to the renderer (D10). */
  textRange: [start: number, end: number]
}

export interface RawHunk {
  oldStart: number; oldLines: number
  newStart: number; newLines: number
  header: string                 // the @@ line's trailing context, if any
  lines: RawLine[]
  textRange: [number, number]
}

export interface RawLine {
  kind: 'context' | 'add' | 'del' | 'no-newline'
  content: string
  oldLineNumber?: number
  newLineNumber?: number
}

// Stage 3 -> 4 : tree-sitter enrichment (web-tree-sitter, WASM)
export interface EnrichedHunk extends RawHunk {
  enclosingSymbolPath: string    // '' when no grammar available: degrades, never fails
  language?: string
}

// Stage 4 -> 5 : identity (D4)
export interface HunkVersion {
  hunkVersionId: HunkVersionId
  hunkKey: HunkKey
  patchsetId: PatchsetId
  path: string
  prevPath?: string
  enclosingSymbolPath: string
  changedLoc: number             // added + deleted, the chunk budget unit
  mechanical: MechanicalClass | null
  hunk: EnrichedHunk
}

export type MechanicalClass =
  | 'lockfile' | 'generated' | 'pure-rename' | 'formatting-only' | 'vendored' | 'mode-only'

export interface FileDiffIR {
  path: string
  prevPath?: string
  changeKind: ChangeKind
  isBinary: boolean
  textRange: [number, number]
  hunks: HunkVersion[]
}

// Stage 5 -> 6 : chunking (D7)
export interface Chunk {
  chunkId: string
  title: string
  rationale?: string             // prose collapsed by default in the UI
  hunkVersionIds: HunkVersionId[]
  changedLoc: number             // invariant: <= 400 unless a single hunk exceeds it alone
  kind: 'substantive' | 'appendix'
  order: number
}

// Stage 6 -> 7 : angles (D6). Every angle is a total function over the hunk set.
export type AngleId = 'sequence' | 'decisions' | 'claims' | 'subtraction' | 'blast-radius'
export type AngleSpecies = 'sequence' | 'queue' | 'overlay'

export interface AngleView {
  angleId: AngleId
  species: AngleSpecies
  patchsetId: PatchsetId
  inputDigest: string            // cache key; angles are disposable
  chunks?: Chunk[]               // sequence species
  items?: ObligationItem[]       // queue species
  scores?: Record<HunkVersionId, number>   // overlay species
  /** Totality guarantee (D6): every hunk placed, or listed here as residue. */
  residue: HunkVersionId[]
}

// Stage 7 -> render: ui/ maps this to @pierre/diffs CodeViewItem[] + DiffLineAnnotation<WingmanAnnotation>[]
export interface WingmanAnnotation {
  kind: 'thread' | 'finding' | 'obligation' | 'decision' | 'disagreement' | 'carried-forward'
  id: string
  severity?: 'p0' | 'p1' | 'p2' | 'p3'
  hunkVersionId: HunkVersionId
}
```

### 2.3 Event taxonomy (`core/events`)

> [!WARNING] Illustrative, not exhaustive
> The code sketch below predates the canonical schema. Do not copy its union. The current taxonomy includes patch failure/cancellation/truncation, lineage ambiguity/confirmation/rejection/split/merge, review abandoned/superseded/attached, atomic decomposition proposal/accept/reject, external-forge changes, command deduplication, and publish cancel/supersede/retry/outcome-unknown/reconcile. `route.drafted` is deleted. Unknown event types stop projection and publishing with a clear upgrade error; they are preserved but never skipped-and-continued.

```ts
export interface EventEnvelope<T extends ReviewEventType = ReviewEventType> {
  seq: number                    // assigned by the store on append
  id: string                     // uuidv7
  reviewId: ReviewId
  patchsetId: PatchsetId | null
  ts: number                     // ClockPort
  actor: { kind: 'human' | 'harness' | 'system'; id?: string }
  type: T
  v: number                      // payload schema version, per type
  causationId?: string
  payload: PayloadOf<T>
}

export type ReviewEventType =
  // lifecycle
  | 'review.opened' | 'session.started' | 'session.ended'
  // patchsets and identity (D4, D5)
  | 'patchset.observed' | 'patchset.diffComputed'
  | 'hunk.appeared' | 'hunk.carriedForward' | 'hunk.disappeared'
  // reading (private, D9)
  | 'hunk.read' | 'hunk.skimmed' | 'hunk.unread' | 'hunk.reopened'
  // angles, chunks, obligations (D6, D7)
  | 'angle.computed' | 'angle.invalidated'
  | 'chunk.formed' | 'hunk.regrouped'
  | 'obligation.raised' | 'obligation.discharged' | 'obligation.reopened'
  | 'residue.detected'
  // conversation and findings
  | 'thread.created' | 'thread.messageAdded' | 'thread.resolved' | 'thread.reopened'
  | 'finding.proposed' | 'finding.promoted' | 'finding.dismissed' | 'finding.demoted'
  | 'harness.disagreementDetected'
  // decisions
  | 'decision.recorded'
  // publish (D15)
  | 'publish.prepared' | 'publish.signed'
  | 'publish.succeeded' | 'publish.failed'

export interface EventTypeMeta {
  /** Excluded from every published payload, structurally (D9). */
  private: boolean
  currentVersion: number
  schema: ZodType
  /** Read-time migration. Events are NEVER rewritten. */
  upcast?: (v: number, payload: unknown) => unknown
}

// Representative payloads
export interface HunkCarriedForwardPayload {
  hunkKey: HunkKey
  fromVersionId: HunkVersionId
  toVersionId: HunkVersionId
  method: 'exact' | 'similar'
  confidence: number             // 1 for exact
  readStateCarried: boolean      // false for 'similar': needs re-read
}

export interface HunkReadPayload {
  hunkVersionId: HunkVersionId
  viaAngle: AngleId
  dwellMs: number                // PRIVATE. never leaves the machine (D9)
  depth: 'read' | 'skimmed'
}

export interface ObligationDischargedPayload {
  obligationId: string
  disposition: 'accepted' | 'rejected' | 'raised-with-author' | 'acknowledged'
  note?: string
}

export interface DecisionRecordedPayload {
  decisionId: string
  anchor: { hunkVersionId: HunkVersionId } | { chunkId: string }
  question: string
  why: { text: string; reconstructedFrom: 'plan' | 'spec' | 'ticket' | 'session' | 'none'; isReconstructed: boolean }
  disposition: 'accepted' | 'rejected' | 'raised-with-author'
  note?: string
}

export interface PublishPreparedPayload {
  publishId: string
  target: { forge: 'github'; owner: string; name: string; number: number; headOid: string }
  payloadDigest: string          // idempotency key (D15)
  includes: { route: boolean; decisions: boolean; comments: number }
}
```

**Migration story.** Two independent axes, and neither requires a data migration over history:

1. *Event payloads* are versioned per type and **upcast at read time**. History is immutable; a schema change ships an `upcast` function, never an `UPDATE`. This is what makes the append-only guarantee real rather than aspirational.
2. *Projections* are disposable. Bump `PROJECTION_SCHEMA_VERSION`; on boot, if `projection_meta.schema_version` differs, drop every projection table and replay from `seq 0`. There are no projection migration scripts, ever.

That leaves SQL migrations applying only to the `events` table itself, which should change approximately never and only additively.

### 2.4 IPC contract (`core/protocol`)

```ts
export interface CommandDef<I extends ZodType, O extends ZodType> { input: I; output: O }

export const commands = {
  'workspace.open':        { input: z.object({ path: z.string() }), output: WorkspaceSchema },
  'workspace.listRepos':   { input: z.object({}), output: z.array(RepoSchema) },
  'review.open':           { input: z.object({ repoId: z.string(), changeset: ChangesetSchema }), output: ReviewSummarySchema },
  'review.refresh':        { input: z.object({ reviewId: z.string() }), output: PatchsetSchema },
  'angle.get':             { input: z.object({ reviewId: z.string(), angleId: AngleIdSchema }), output: AngleViewSchema },
  'hunk.markRead':         { input: HunkReadPayloadSchema, output: z.object({ seq: z.number() }) },
  'obligation.discharge':  { input: ObligationDischargedPayloadSchema, output: z.object({ seq: z.number() }) },
  'thread.create':         { input: ThreadCreateSchema, output: z.object({ threadId: z.string() }) },
  'thread.ask':            { input: ThreadAskSchema, output: z.object({ streamId: z.string() }) }, // deltas via event channel
  'publish.prepare':       { input: z.object({ reviewId: z.string() }), output: PublishPreviewSchema },
  'publish.sign':          { input: z.object({ publishId: z.string() }), output: PublishResultSchema },
  'request.cancel':        { input: z.object({ requestId: z.string() }), output: z.object({ cancelled: z.boolean() }) },
} as const satisfies Record<string, CommandDef<ZodType, ZodType>>

export type CommandName = keyof typeof commands
export type Input<K extends CommandName>  = z.infer<(typeof commands)[K]['input']>
export type Output<K extends CommandName> = z.infer<(typeof commands)[K]['output']>

/** Server -> client push. Durable events (D13) plus ephemeral stream frames. */
export type ServerEvent =
  | { kind: 'event';  event: EventEnvelope }
  | { kind: 'delta';  streamId: string; text: string }          // ephemeral, never persisted
  | { kind: 'progress'; requestId: string; phase: string; pct?: number }
  | { kind: 'stream-end'; streamId: string; reason: 'complete' | 'cancelled' | 'error' }
```

Renderer side (~40 lines of the ~200):

```ts
// ui/ipc.ts — the ONLY door from renderer to domain (D11)
export async function invoke<K extends CommandName>(
  name: K, input: Input<K>, opts?: { signal?: AbortSignal }
): Promise<Output<K>> { /* requestId, postMessage, await reply, validate with zod */ }

export function subscribe(fn: (e: ServerEvent) => void): () => void
```

Main side: **one** `ipcMain.handle` dispatcher that (a) looks the name up in `commands`, rejecting unknown names, (b) parses input with zod *before* the payload reaches any domain code, (c) forwards to the engine over `MessagePortMain`, (d) parses the output with zod in dev builds. The stack note's reasoning applies exactly: validate even though the renderer is "ours", because the renderer is the process that renders untrusted diff content.

Cancellation: every request carries a `requestId`; `request.cancel` aborts the matching `AbortController` in the engine, which is threaded into `GitPort` spawns (stack note §2: per-call `AbortSignal` cancellation when the user switches PRs mid-parse) and into harness process kills.

### 2.5 Ports (`core/ports`)

```ts
export interface GitPort {
  /** Resolved absolute binary, spawned with shell:false. See §0.4. */
  revParse(cwd: string, args: string[], o?: PortOpts): Promise<string[]>
  worktreeList(repoPath: string, o?: PortOpts): Promise<Worktree[]>
  mergeBase(repoPath: string, a: string, b: string, o?: PortOpts): Promise<string>
  diff(repoPath: string, spec: DiffSpec, o?: PortOpts): AsyncIterable<string>  // streamed, never buffered
  catFile(repoPath: string, oid: string, o?: PortOpts): Promise<Uint8Array>
}
export interface PortOpts { signal?: AbortSignal }

export interface StorePort {
  append(events: Omit<EventEnvelope, 'seq'>[]): Promise<{ lastSeq: number }>  // append + fold, one txn
  read(reviewId: ReviewId, fromSeq?: number): AsyncIterable<EventEnvelope>
  project<T>(name: string, reviewId: ReviewId): Promise<T>
  rebuildProjections(): Promise<void>
}

export interface HarnessPort {
  detect(): Promise<HarnessDescriptor[]>          // zero-config North Star
  start(d: HarnessDescriptor, req: HarnessRequest): AsyncIterable<HarnessEvent>
  cancel(sessionId: string): Promise<void>
}

/** The normalized protocol IS the asset (stack note §7). Harness plurality is a positioning claim. */
export type HarnessEvent =
  | { type: 'session.started'; sessionId: string }
  | { type: 'text.delta'; text: string }
  | { type: 'tool.call'; name: string; input: unknown }
  | { type: 'tool.result'; name: string; output: unknown }
  | { type: 'finding'; finding: ProposedFinding }
  | { type: 'session.ended'; reason: 'complete' | 'cancelled' | 'error' }
  | { type: 'error'; message: string }
```

---

## 3. v1 dogfood cut

> [!IMPORTANT] Superseded by Master Plan §4
> M0 dogfood includes both local pre-PR and remote PR sources. It uses all six angle shapes, with Claims and Evidence emission deferred, and no route handoff. The detailed table below is historical wherever it disagrees.

v1 as ratified by Rai: **daily driver for reviewing real the enterprise client PRs. Claude Code adapter first. GitHub publish working. Rough edges allowed.**

Both review modes are in the dogfood cut. Local review is the first vertical slice; remote PR review follows through the same immutable patchset model.

| Component | v1 | Note |
|---|---|---|
| Monorepo scaffold, pnpm + turbo + Biome + TS 7 | **MUST** | TS 7 for `tsc --noEmit` only; skip type-aware lint (stack note §10) |
| Boundary enforcement (4 layers, D3) + failing fixtures | **MUST** | Cheap now, unaffordable later |
| `GitPort` spawn wrapper, streaming, `AbortSignal`, shell:false | **MUST** | §0.4 hardening included |
| Workspace / repo / worktree discovery (four nouns) | **MUST** | Validated against Rai's layout, §0.3 |
| GitHub PR ingestion via `gh auth token` + `@octokit/graphql` | **MUST** | PR list, files, threads, checks in one round trip |
| Own unified-diff parser (byte offsets, renames, binary, submodule) | **MUST** | parse-diff to bootstrap only |
| tree-sitter symbol enrichment | **MUST** | Degrades to `''` without a grammar; identity still works |
| Occurrence IDs + lineage graph, exact carry only after precision gate | **MUST** | Master Plan R8 |
| Ambiguous/similar lineage reopens + version-to-version mini-diff | **MUST** | Similarity is evidence, never identity |
| Validated hybrid decomposition ≤400 LOC + deterministic floor | **MUST** | Master Plan R9/R10 |
| Event store, projections, upcast mechanism | **MUST** | Mechanism MUST; actual upcasts LATER |
| Private-event structural exclusion + its test | **MUST** | D9. Without the test it is not a guarantee |
| Typed IPC + command registry + cancellation | **MUST** | D11 |
| Engine utility process | **MUST** | D12 |
| Claude Code CLI adapter | **MUST** | Clean-room `claude -p`, process-per-turn; nothing bundled. ⛔ SUPERSEDED 2026-08-06: SDK adopted, no clean-room mandate — see Master Plan R2 |
| Angle: the sequence | **MUST** | The primary rail |
| Angle: decisions | **MUST** | Strongest validated positioning fit |
| Angle: blast radius | **MUST** | Cheap explainable signals only, no churn-heat |
| Angle: claims-and-evidence | LATER | Needs test-delta analysis |
| Subtraction rule families and propose-deletion findings | **MUST** | Not an angle; absorbed into findings/noise |
| Residue check + loud error state | **MUST** | Falls out of D6 totality; costs almost nothing |
| Anchored threads + diff chat (one harness) | **MUST** | Second-opinion switcher LATER |
| Findings: rubric, severity floor, sticky dismissal | **MUST** | FP budget is CORE per validation |
| Publish: prepare → sign → succeed, batched GraphQL review | **MUST** | D15. Ceremony *act* MUST, ceremony *polish* LATER |
| Keyboard command registry feeding palette + menu bar | **MUST** | ~300 lines; daily-driver ergonomics |
| Unsigned local dev build | **MUST** | Enough to daily-drive |
| Signing, notarization, `@electron/fuses`, asarUnpack | LATER | Needed for distribution, not for Rai |
| Auto-update | LATER | |
| Glass chrome / vibrancy identity | LATER | Ratified identity, but rough edges allowed in v1 |
| Codex + oh-my-pi adapters | LATER | Interface must exist in v1; impls later |
| Harness disagreement | LATER | Needs ≥2 adapters + stochasticity baseline |
| Local PR submission preview | **MUST** | Preview only; pushing remains an explicit action |
| Drag hunks between chunks | LATER | `hunk.regrouped` event should exist in v1 |
| LLM chunk refinement | LATER | Deterministic baseline must stand alone first |
| Watch mode | LATER | |
| CI regression comparator | LATER | Lift from prawn |
| difftastic detect-and-use | LATER | |
| Event snapshots / log compaction | LATER | Replay is trivial at v1 volumes |
| Mobile companion | LATER | Whole phase |
| MCP server over review state | LATER | Event store design must not preclude it |

---

## 4. Open questions and refinement hooks

### Frozen — do not change without escalating to Rai

- **Durable repo identity = `RepoRecord`; git common dir is a machine-local alias**, never the durable identity.
- **Occurrence IDs plus an explicit lineage graph** (Master Plan R8). Similarity is matcher evidence only; ambiguity fails closed.
- **Events are append-only; corrections are new events** (D8).
- **Private events are structurally excluded from publish** (D9), with the test as the mechanism.
- **`core` has zero `node:*` imports** (D2/D3).
- **Validated hybrid decomposition with an always-available deterministic floor** (Master Plan R9/R10).
- **Publish is an explicit three-phase human act** (D15) — ratified by Rai as the signature gesture.
- **Renderer holds no domain logic** (D11).

### Adjustable — Navi may revise with evidence

- **Similarity threshold (0.6) and the similarity metric.** Tune against real force-pushes on the enterprise client PRs. Record the fixtures.
- **Chunk budget (400 LOC)** and the default order strategy. Must remain a named switchable strategy set, not a constant.
- **The `reader` regex in the kysely bridge** (D8). Weakest line in the store; needs a test per emitted statement shape.
- **Whether `node:sqlite` replaces `node-sqlite3-wasm`** (stack note: 30-second check on day one). If it works, the bridge shrinks or disappears.
- **Projection table set.** Add or split freely; they are disposable by construction.
- **`@tanstack/react-virtual` retention** (D14), pending the Pierre measurement.
- **Coalescing interval for ephemeral deltas** (D13, default 16ms).
- **Whether the engine is one process or two** (git/diff vs store). Start with one; split if profiling demands it.

### Genuinely open — needs a decision, flagged rather than guessed

1. **The `@pierre/diffs` measurement still has to happen.** Virtualization exists (§0.1); whether it holds 120Hz on a 5,000-line highlighted file is unmeasured. This remains spike #1, but its downside collapsed from "rewrite the rendering plan" to "add file-level virtualization above it".
2. **1.3.2's exact surface is unconfirmed.** All type evidence here is from 1.2.12 because this environment's registry is capped at 2026-07-28. The stack note independently reports 1.3.2 as current with `File`/`FileDiff`, annotations, and `EditProvider`, which is consistent. Re-confirm on first install; if `Virtualizer` or the worker pool were removed (very unlikely across a minor), D14 and §0.1's consequences change.
3. **Pierre's vendor coupling.** `@pierre/theme` and `@pierre/theming` are hard dependencies, and the stack note could not locate a public source repo — the licence reads Apache-2.0 but the ability to fork is unverified. Acceptable for v1; a real risk to name before the product depends on it commercially.
4. **Skimmed-vs-read boundary.** Ratified that the distinction exists; the exact trigger (viewport dwell? expansion? explicit key?) is unspecified and materially affects whether the coverage map is honest. Recommend: `read` requires the hunk's diff lines to have been *mounted and visible*, `skimmed` is anything discharged from a collapsed summary row.
5. **Obligation ceiling for the decisions angle.** The hub note requires a *hard visible cap* on the count ("the count IS the product") but does not set it. Needs a number before the angle ships.
6. **Where the author-side (pre-PR) surface enters.** The story fronts it, the dogfood cut defers it. If Rai wants the positioning proved before the tool is habitual, this ordering flips. Contested — see §6.
7. **Rename detection strategy.** `--find-renames` threshold affects `fileIdentity` and therefore identity stability. Default 50% is git's; unvalidated for LLM-generated PRs, which move code aggressively (GitClear: moved/refactored code collapsed 21%→3.8%).

---

## 5. Bead candidates

> [!DANGER] Do not execute this backlog verbatim
> It predates the reconciled handoff. Use [[Rennet Navi Handoff]] for current sequencing. Any row below mentioning `@wingman`, five packages, `hunkKey` identity, deterministic-authoritative chunking, the Claude Agent SDK, route handoff, or a Pierre renderer fallback is superseded.

Sized for autonomous agent execution. Dependencies are hard unless marked soft.

| # | Title | P | Depends on | Description |
|---|---|---|---|---|
| B1 | Scaffold the Rennet monorepo (pnpm + turbo + Biome + TS 7 + Vitest) | P0 | — | Create the final package layout from Master Plan R21 with `@rennet/*` names and the Apache/AGPL boundary from R3/R4. No app code, just a green build/test/boundary gate. ⛔ SUPERSEDED 2026-08-06: no Apache/AGPL boundary — everything is MIT. |
| B2 | Implement and prove the four-layer boundary enforcement | P0 | B1 | Wire Biome `noRestrictedImports` per D3, write `tooling/check-boundaries.ts`, and add fixture files that violate each rule. CI must assert the checker *fails* on the fixtures — a boundary check that cannot fail has not passed. |
| B3 | Spike: measure `@pierre/diffs` against a real 5,000-line diff | P0 | B1 | Render a genuine large the enterprise client PR diff through `CodeView` with the worker pool on, profile with Chrome DevTools, record frame times. Confirm 1.3.2 still exports `Virtualizer`/`useWorkerPool`. Outcome decides D14. Highest information value in the list. |
| B4 | Spikes: `node:sqlite` in Electron and direct Claude CLI fidelity/isolation | P0 | B1 | The store check may delete a dependency. The CLI spike verifies process-per-turn resume/fork/schema/partial frames/cancellation/context isolation. No SDK binary is linked or bundled. ⛔ SUPERSEDED 2026-08-06: SDK adopted — see Master Plan R2. |
| B5 | `GitPort`: spawn wrapper with streaming, cancellation, and shell:false hardening | P0 | B1 | ~250 lines per the stack note. Plumbing commands only, NUL-delimited parsing, `AbortSignal` per call, streamed stdout never buffered. Resolve an absolute git path and assert output shape defensively (§0.4). |
| B6 | Workspace / repo / worktree discovery (the four nouns) | P0 | B5 | Implement `RepoId` = realpath of `--git-common-dir`, worktree enumeration via `--porcelain`, nested-repo and foreign-worktree detection. Golden test against Rai's actual layout: `/workspace`, nested `product-repo`, worktrees at `/workspace/wt/*` and `product-repo/.claude/worktrees/*`. |
| B7 | Own the unified-diff parser | P0 | B5 | Replace parse-diff with a parser carrying byte offsets, per-line old/new numbers, rename and mode detection, binary and submodule cases. Fixture-driven, including malformed and truncated input. |
| B8 | Event store: schema, kysely bridge, append+fold transaction | P0 | B1, B4(soft) | Implement D8 including the `SqliteDatabase` shim with the `reader` derivation and eager `finalize()`. Unit-test the bridge against every statement shape the query builder emits, including `RETURNING`. |
| B9 | Event taxonomy, zod schemas, upcast mechanism, projection rebuild | P0 | B8 | Encode the D-2.3 taxonomy with per-type `private` flags and `currentVersion`. Implement read-time upcasting and drop-and-replay projection rebuild on `PROJECTION_SCHEMA_VERSION` bump. Property test: replay from zero equals incremental fold. |
| B10 | Private-event exclusion, with the byte-identical publish test | P0 | B9 | Implement the publish-projection view that excludes `private=1`, and the test asserting the publish payload digest is unchanged when private events are deleted from the store (D9). This test *is* the guarantee. |
| B11 | Occurrence IDs, lineage graph, and matcher-precision gate | P0 | B7, B9 | Implement immutable occurrence identities and explicit exact/move/split/merge/ambiguous/rejected edges. Hashes are evidence only. Duplicate-body and ambiguity fixtures must fail closed. |
| B12 | Possible-continuation UI and version-to-version mini-diff | P1 | B11 | Similarity may propose lineage but never carries read/analysis state. Preserve stale prior artifacts visibly and reopen changed/ambiguous occurrences. |
| B13 | tree-sitter enrichment pipeline (web-tree-sitter, WASM) | P1 | B7 | Load grammars lazily per language, extract enclosing symbol path per hunk. Must never throw on an unknown language; must never block the pipeline on a missing grammar. |
| B14 | Validated hybrid decomposition with deterministic floor | P0 | B11 | Harness emits one complete versioned graph; validator proves totality, uniqueness, anchors, DAG, and ≤400 LOC. Offline deterministic fallback remains available. Enforce <5 invocations and <15s first useful chunk. |
| B15 | Angle framework + the sequence angle + residue check | P0 | B14 | Implement `AngleView` as a pure total function with the `inputDigest` cache and the totality assertion emitting `residue.detected`. Ship the sequence angle over B14's chunks. |
| B16 | Typed IPC layer and command registry | P0 | B9 | ~200 lines per D11/2.4: command map in `core/protocol`, single validating `ipcMain.handle` dispatcher, `MessageChannelMain` streaming, `requestId` cancellation. Reject unknown command names loudly. |
| B17 | Engine utility process and process supervision | P0 | B16, B8 | Stand up the engine `utilityProcess` owning git, diff, and the store (D12). Main becomes a pure router. Include crash detection and restart with in-flight request rejection. |
| B18 | Claude Code CLI adapter behind the normalized protocol | P0 | B17 | Implement the clean-room process-per-turn `claude -p` wrapper with tolerant decoders, resume/fork identifiers, isolation disclosure, and no SDK/credential access. Cancellation kills only the owned turn process. ⛔ SUPERSEDED 2026-08-06: the SDK is adopted; this is no longer the mandated design — see Master Plan R2. |
| B19 | Two-channel streaming (durable events vs ephemeral deltas) | P1 | B18, B16 | Implement D13: coalesce token deltas at ~16ms straight to the renderer without persisting; append one `thread.messageAdded` on completion. Verify a mid-stream crash loses only the partial answer. |
| B20 | GitHub ingestion: `gh auth token` + GraphQL PR/threads/checks | P0 | B1 | Read the token from `gh`, never store a copy. One GraphQL round trip for PR, files, threads, comments, check runs. Device-flow fallback is LATER; stub the seam. |
| B21 | Renderer: `CodeView` integration with domain annotations | P0 | B3, B15, B16 | Map `FileDiffIR` + raw patch slices to `CodeViewItem[]` per D10, with `DiffLineAnnotation<WingmanAnnotation>`. One scroll owner (D14). Wire `updateItemId`/`version` for patchset changes. |
| B22 | Reading state UI: coverage map, read vs skimmed, keyboard traversal | P0 | B21, B15 | The always-visible coverage mosaic plus per-hunk read/skim transitions. Settle open question #4 (the read trigger) and record the decision in this note. |
| B23 | Anchored threads and diff chat over one harness | P1 | B21, B18 | Right-margin panel with anchor chips, threads persisted as events anchored to hunk versions, answers streaming via the ephemeral channel. Promotion to finding/comment is B25. |
| B24 | Decisions angle (queue) with reconstructed why | P1 | B15, B18 | Queue-species angle with a hard visible cap on item count (settle open question #5). Each item carries a reconstructed WHY marked as reconstructed, plus everything needed to discharge it in place. |
| B25 | Findings: rubric, verifier cull, severity floor, sticky dismissal | P1 | B18, B9 | Lift prawn's REVIEW_RUBRIC shape: introduced-by-THIS-change discipline, P0-P3, forced JSON validated with zod, verifier cull before display. One-keystroke sticky dismissal recorded as an event. |
| B26 | Blast-radius angle from cheap explainable signals | P1 | B15, B13 | Overlay angle over irreversibility, contract surface, deletions, fan-in, CODEOWNERS overlap, and the safety-net-weakening preset. Never churn-heat. Every score must be explainable in one line or it reads as astrology. |
| B27 | Publish: prepare → sign → succeed, batched as one GitHub review | P0 | B20, B10, B9 | Implement D15 including the payload digest, idempotent retry, and external-id recording. One `addPullRequestReview` + `submitPullRequestReview`, never a spray of comments. |
| B28 | Command registry, palette, and menu-bar parity | P1 | B16 | ~300 lines: `Command` records with `when` clauses, keymap resolver with chords, conflict detection, JSON user overrides. Feeds palette (cmdk) and menu bar from one source. tinykeys as the sequence matcher only. |
| B29 | Deterministic-replay test harness | P1 | B9 | Wire `ClockPort`/`RandomPort` fakes so an entire review is reproducible from a recorded event log. This is the primary correctness tool for an event-sourced system and unlocks regression fixtures for B12 and B14. |
| B30 | Force-push end-to-end scenario test | P1 | B12, B15, B21 | Build a fixture repo, review it, force-push an amended commit, assert: read state carries for untouched hunks, edited hunks reopen with anchors intact, disappeared hunks surface their orphaned threads rather than vanishing. The wedge, proven. |

Critical path to a dogfoodable build: **B1 → B2 → B5 → B6 → B7 → B11 → B14 → B15 → B8/B9 → B16 → B17 → B18 → B20 → B21 → B22 → B27.** B3 and B4 run in parallel from the start and can invalidate B21's approach, so they must not be deferred.

---

## 6. Contested calls

Three places where I made a call Rai may want to overturn.

1. **Resolved:** local author-side review leads and both modes ship in dogfood. Route handoff is removed. Local publishing produces a PR submission preview; every GitHub mutation remains a separate explicit action.
2. **`@tanstack/react-virtual` is demoted.** The stack note lists it as must-use; §0.1 shows Pierre virtualizes already. I kept it for non-diff lists only. If the B3 measurement disappoints, it returns to the diff surface at file granularity.
3. **Similarity carry-forward is MUST, not LATER.** It is genuinely more work than exact matching and could plausibly be cut from v1. I kept it because force-push survival is the defensible wedge per the market analysis, and a v1 that loses your place on every amended commit will not survive contact with the enterprise client PR churn — it would fail exactly where the product claims to win.
