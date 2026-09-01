# C14 release blockers

## Why

C14's launched-app audits (2026-08-30 and the 2026-09-01 owner-journey proof) leave the release-defining journey — add a project → review boards → post a review or dispatch a second round — broken or unusable in six specific ways: two core lenses reject their own boards (#548), Noise emits nothing (#549), the Claude-or-Codex round dispatch that landed via PR #692 remains unproven end to end in the launched app (#681's residue), board generation takes ~11 minutes behind a false phase label with every settled board held until the slowest lane and coverage finish (#725), the round-report classifier envelope is unbounded (#727), and Rennet's own `.rennet/boards` artifacts falsely invalidate working-tree reviews after a daemon restart (#729). Together with #726's exhaustive-attribution requirement — folded into the classifier contract here because it is nearly free during the manifest redesign — these are the open C14 issues; C14 is not release-complete until they close.

Baseline: `origin/main@1ccd3f14`. PR #692 (harness resolution with durable provenance, 2026-08-30) and PR #728 (verified-report-before-fanout handoff, 2026-09-01) already landed; this change owns the residue, not those landings.

## What Changes

- Sequence and Decisions lens seats emit only references the target board document admits; bad refs are repaired at the producer/composition boundary, and the board service stays authoritative (#548).
- The Noise seat always emits a valid populated/empty board or a precise retryable failure account — never a silent no-board (#549).
- The landed Claude-or-Codex round dispatch (#692) is proven against #681's acceptance in the launched app: both single-harness cases complete the full second-round path, positive controls cover missing/misresolved harnesses, and the still-Claude-hardcoded coverage seat gets honest provenance (#681).
- Post-round board regeneration reveals Sequence, Decisions, and Flagged as each settles instead of holding all results behind a five-lane `Promise.allSettled` barrier; per-phase durable timings (report, each lens draft/repair/post-process, coverage, reveal) replace the false "Drafting the round report" label; retry budgets are proportional per lane and attempt (#725).
- The round-report classifier gets a bounded, typed evidence contract: canonically ordered manifest with stable evidence ids, UTF-8 byte budget enforced locally before any provider call, a discriminated evidence union for non-line changes (binary, mode, rename), provider output caps enforced before parsing, and overflow surfaced through the durable round-failure path (#727).
- Working-tree capture excludes app-owned `.rennet/boards/` state from patchset files, raw diff, and identity — without excluding intentionally tracked project content under `.rennet` — so a post-round daemon restart keeps an unchanged successor review current (#729).
- The round model is explicitly an unbounded loop: review → dispatch a round → re-review → … until the reviewer has nothing left to change, at which point the pull-request draft/submit exit closes the loop. No code, prompt, UI copy, or test may assume a round count; "two rounds" was proof scope (#685), never a product cap. Server dispatch already supports repeat dispatch — this change makes the contract explicit and sweeps out ordinal assumptions.
- Benchmark telemetry: while the debug benchmark-recording setting is enabled (on by default, toggleable in Settings), Rennet durably records stage-level timings for project processing (the scout and each deterministic Repo Map build stage — the context-map kill removed every model-backed layer), lens drafting (per lens, including the dual review, and the whole process), and the post-round report. A Settings benchmarks panel renders the recorded runs, and an exporter lands the data in the rennet repo to populate a dedicated docs benchmarks page.

## Capabilities

### New Capabilities

- `lens-board-drafting`: lens seats (Sequence, Decisions, Noise, and peers) emit semantically valid boards or exact typed failures; ref admission and repair at the producer boundary; board service authority. Covers #548 and #549.
- `round-harness-dispatch`: coding-round dispatch resolves the configured available harness (Claude or Codex), completes the edit/gate/land/regenerate loop on either, and records durable harness provenance. States the contract PR #692 implemented; #681's residue is the launched-app proof.
- `round-regeneration-reveal`: generation latency policy for initial and post-round generations — progressive per-lens reveal, durable reconstructable reveal state, honest per-phase timing including time-to-first-core-board, reduced retry budgets, coverage honesty without a global reveal barrier. Covers #725.
- `round-report-classification`: bounded and typed classifier evidence contract — manifest construction, byte budgets, evidence union, exactly-once evidence partition, transport-enforced output caps, overflow-as-durable-failure, safe-repeat crash semantics. Covers #727 and folds in #726.
- `review-round-loop`: rounds are an unbounded review loop terminated by the pull-request exit, never by a count. Dispatch availability after every landed round, ordinal-free copy and prompts, N-round ledger legibility, zero-round exits. Covers #730.
- `benchmark-telemetry`: default-on debug benchmark recording with stage breakdowns (deterministic Repo Map build stages, per-lens drafting including dual review, post-round report), a Settings benchmarks panel, repo-committed benchmark data, and the docs benchmarks page it populates. Covers #731.

### Modified Capabilities

- `local-review-capture`: working-tree capture SHALL exclude app-owned `.rennet/boards/` storage from patchset content and identity while preserving intentionally tracked `.rennet` project content; freshness recheck after restart keeps an unchanged tree current. Covers #729.

## Impact

- `packages/server/src/create-server.ts` (coverage-seat provenance and launched-app harness proofs, #681; round dispatch resolution itself landed via #692 at `resolveCodingHarness`/`runResolvedCodingHarnessTurn`)
- Scope boundary: closing C14 does not by itself make the first public release shippable — #298 (macOS signing) and #330 (Windows signing) own installers and update verification, outside this change
- Lens pipeline seats and board composition in `packages/core` / `packages/prompts` (#548, #549, #725)
- Round-report classifier envelope in `packages/core` (#727, boundary with landed #689 work)
- `packages/adapters/src/git-capture.ts`, `repo-watcher.ts`, `map-visibility.ts`; `packages/server/src/boards/boards-runtime.ts`; `packages/core/src/index.ts` freshness/invalidation (#729)
- Round loop: sweep of prompts, UI copy, specs, and tests for ordinal round assumptions; `packages/app-ui/src/rounds/` ledger and exits
- Benchmarks: telemetry spine shared with the #725 per-phase timing records; `packages/app-ui/src/settings/` (new benchmarks panel + recording toggle); `client-settings.json` surface in `packages/server/src/settings.ts`; benchmark data + new benchmarks page in `docs/`; snapshot-build and lens pipeline instrumentation in `packages/server/src/runtime/`
- Docs: `docs/using/guides/install-a-coding-harness.md` claim becomes true; classifier contract documentation gains declared limits; round-progress phase labels described accurately
- Tests: launched-app proofs (both harness cases, tiny-round timing rerun), regression fixtures containing the production failure shapes, positive controls per C14 closing standard
