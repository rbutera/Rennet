## 1. Shared foundations

- [x] 1.1 Create the shared app-owned-paths authority module (declares the `.rennet/boards/` prefix) and consume it from `repo-watcher.ts` AND the board-store writer in `boards-runtime.ts` (D6)
- [x] 1.2 Extend the canonical lens settlement domain (`LensBoardOutcome` + absence reasons in protocol `session/model.ts`): retryable classification for the no-board path, lens-specific admissible absences (Sequence admits none, Noise admits `no-noise`) — no parallel union (D2)

## 2. Capture excludes app-owned artifacts (#729)

- [x] 2.1 Sanitize the temporary reviewed tree of app-owned paths BEFORE deriving anything, so OID, diff, file list, byte counts, intent, and patchset identity all come from the one sanitized tree; preserve tracked `.rennet` content (D6)
- [x] 2.2 Narrow the watcher's blanket `.rennet` ignore to the app-owned prefix and align freshness evaluation: unchanged source tree after restart stays current, no app-artifact candidate becomes pending
- [x] 2.3 Real-repository test: capture → write board state → restart/rearm freshness → review stays current; positive controls: an edited reviewed source file invalidates, AND a tracked `.rennet/` project-file edit invalidates; fixture shapes include `.rennet/boards-extra` (prefix boundary), separator variants, staged and untracked board artifacts

## 3. Lens ref admission (#548)

- [ ] 3.1 Add the ref-admission pass at the producer/composition boundary: repair only when the unique intended target is provable (recorded account); otherwise retry or settle typed failure — never drop an element and accept the board (D1)
- [ ] 3.2 Regression fixture containing the production `bad-ref` shape; positive control bypasses repair and asserts board-service rejection
- [ ] 3.3 Launched-app real-harness run populates Sequence and Decisions on a representative branch with anchors navigating to the captured patchset

## 4. Noise seat settles honestly (#549)

- [ ] 4.1 Make the "drafting turn emitted no board" path (`lens-pipeline.ts:1251`) settle as a typed retryable failure driving the existing retry path, and promote the `no-noise` absence to first-class success presentation
- [ ] 4.2 Regression fixture with the production no-board shape; positive control withholds the board and fails the proof
- [ ] 4.3 Launched-app run settles Noise for both a mechanically noisy change (populated board) and a signal-only change (`no-noise` absence)

## 5. Harness dispatch residue (#681 — resolution landed via #692)

- [ ] 5.1 Verify the landed resolution against #681's acceptance (typed unavailable failure, no silent fallback, durable displayed provenance) and give the still-Claude-hardcoded coverage seat (`runLiveCoverage`) honest provenance or typed absence on non-Claude installs (D3)
- [ ] 5.2 Launched-app second-round proof in both resolution cases (Claude-only, Codex-only) plus positive control for missing/misresolved harness
- [ ] 5.3 Verify `docs/using/guides/install-a-coding-harness.md` claims against landed behavior; correct if needed

## 6. Classifier evidence contract (#727 + #726)

- [x] 6.1 Build the canonically ordered evidence manifest with stable ids and the discriminated evidence union (text-hunk, binary, mode-change, rename; no invented line anchors); ordering algorithm and id derivation defined per D5
- [x] 6.2 Declare the byte/entry limits as named constants in one protocol-level module; enforce the UTF-8 byte budget on the complete serialized manifest: intact at/under limit, typed local failure over limit with zero provider calls, never truncate/split/summarize
- [x] 6.3 Extend the session-spec contract with an output cap and enforce raw-size rejection at the transport boundary in BOTH the Claude and Codex adapters before structured-output decoding; decoded entry/cardinality limits before persistence; cap failure routes to the durable round-failure path, never spawns another turn
- [x] 6.4 Enforce exactly-once evidence partition (#726): every manifest id in exactly one ask or the `beyond asks` bucket; reject unknown, missing, or duplicate ids before persistence
- [x] 6.5 Boundary controls: multibyte UTF-8 at exact limit and one byte over, deterministic ordering, zero-provider-calls-on-overflow, every non-text variant, raw/schema output caps, omitted and duplicated evidence ids
- [x] 6.6 Crash-semantics test: repeat provider call after crash-before-projection yields exactly one durable report projection
- [x] 6.7 Update the classifier contract documentation with the declared limits, partition rule, and failure behavior

## 7. Progressive reveal and honest timing, initial and post-round (#725)

- [ ] 7.1 Start core lanes when their inputs are ready (initial: captured patchset; post-round: the #728-verified report); publish each lane's settlement immediately; remove `Promise.allSettled` and coverage completion from the reveal path in BOTH generation kinds (D4)
- [ ] 7.2 Make reveal state durable and generation-keyed: per-lane settlements plus coverage `pending`/`complete`/`failed`; reconnect/daemon-restart reconstructs partial state; writes from superseded attempts rejected
- [ ] 7.3 Render the explicit coverage state in the client; coverage annotates revealed boards, never rewrites them
- [ ] 7.4 Record distinct durable timings per phase: report, each lane's draft/repair/post-process, coverage, reveal, time-to-first-core-board; fix phase labels to name the running phase
- [ ] 7.5 Implement the per-lane, per-attempt retry budget table; second whole-board attempt gets an explicitly reduced ladder
- [ ] 7.6 Positive controls: reintroduced global barrier fails the reveal assertion; lens time routed under the report label fails the timing assertion; late write from a superseded attempt is rejected

## 8. Unbounded round loop

- [x] 8.1 Sweep prompts, UI copy, and fixtures for ordinal round ASSUMPTIONS (caps, round-two special cases); leave legitimate descriptive fixture names and comments alone
- [x] 8.2 Parameterized arbitrary-N state-machine test over the round loop: every dispatch/land cycle's transitions identical, no ordinal-dependent branch; positive control introduces a cap and fails it
- [x] 8.3 Verify the submit exit at zero rounds and after N rounds; a composed PR draft does NOT terminate the loop (rounds stay dispatchable with a draft in hand); ledger stays legible and complete at five-plus rounds
- [ ] 8.4 Launched-app three-round session proof: dispatch, land, regenerate, re-dispatch, exit via PR submit on the final successor
  - BLOCKED (2026-09-01, not environmental). The launched-app e2e (`apps/desktop/e2e/owner-loop-685.spec.ts`)
    builds, launches, adds the project, drafts boards, dispatches round one, runs the worker
    and PASSES the gate (`npm run check · passed · 219 ms`) — then the round REPORT seat fails:
    `deterministic verification failed — Round report outcome for qt-… cites src/owner.ts, not
    the asked path Read \`src/owner.ts\` first.` `verifyAskPath`
    (`packages/server/src/runtime/round-report-verification.ts:364`) resolves `ComposableAsk.path`
    as a repo path, but a QUOTE-THREAD ask carries the quoted prose there, so every prose-anchored
    ask fails verification and kills the round at depth 1. Rounds two/three and the PR-submit exit
    never execute. Separately, `owner-loop-proof.integration.test.ts` fails earlier and
    environmentally: with `HOME` stubbed to a temp dir, `sh -lc` re-derives PATH from the login
    profile and `npm` resolves to the asdf shim, whose `cd $HOME/.asdf` fails —
    `gate exited with code 1`, stderr `.../asdf/plugins/nodejs/shims/npm: line 14: cd: <tmp>/home/.asdf:
    No such file or directory`. Prepending the test Node's bin dir to PATH does not help (the login
    shell discards it). Unbounded depth is meanwhile proven by executing arbitrary-N machine tests
    on both halves of the loop (8.2/8.3). The COMMITTED positive controls substitute a capped and a
    round-two-special-cased handler at the TEST's dispatch seam (the handler the driver calls) —
    production code is not modified by them. Production was additionally mutated BY HAND during
    development, each mutation reverted and none committed: an ordinal cap in `round.dispatch`, the
    ask drain moved ahead of the worker kick (which reddens the ordered-transition assertion while
    leaving the step SET identical), the staged-ask refusals removed from `publish.compose` and
    `publish.submitPr`, and the ledger's report lookup pinned to round one. Every one reddened the
    assertion it was aimed at.

## 9. Benchmark telemetry

- [ ] 9.1 Define the versioned benchmark record schema on the #725 timing spine; one recorder, durable storage, bound to round/map revision; every STAGE record carries its actually resolved harness and model; run-level mode (dual-model, Claude-only, Codex-only) derived from stages; failed/aborted runs recorded as such
- [ ] 9.2 Instrument project processing: one timing per deterministic Repo Map build stage (resolve, tree, workspace, conventions, symbols, build, verify, store) plus the scout and the end-to-end total — there are no model-backed layers to time since the context-map kill
- [ ] 9.3 Instrument lens drafting: per-lens draft, dual-review, repair/post-process, per-lens total, and whole-process timing
- [ ] 9.4 Instrument the post-round report: classification-turn and report-gate timings bound to the round
- [ ] 9.5 Add the default-on benchmark-recording setting to `client-settings.json` resolution and a Settings toggle; disabled means zero new records, identical pipeline behavior
- [ ] 9.6 Build the Settings benchmarks panel: recorded runs with stage breakdowns split by derived mode, virtualized/responsive on a large history, styled per DESIGN.md
- [ ] 9.7 Build the deterministic developer-run export command aggregating records into committed JSON under `docs/` with provenance (date, machine, revision)
- [ ] 9.8 Build the docs benchmarks page rendering the committed data (stage breakdowns for map, lenses, report, split by derived harness mode); build-time verification fails on missing/corrupt data
- [ ] 9.9 Controls: recording-off writes nothing; panel perf check on large history; export/render round-trip with a control that corrupts the data and fails the build

## 10. Owner-journey proof and close-out

- [ ] 10.1 Guarded launched-desktop tiny-round proof publishing per-phase timings (including time-to-first-core-board against D4's working targets), peak descendant resources, and zero-survivor cleanup
- [ ] 10.2 Export the proof run's benchmark data and land the first committed docs benchmarks dataset
- [ ] 10.3 Full gate (`pnpm check`) green; docs affected by any behavior change updated in the same PRs
- [ ] 10.4 Close #548, #549, #681, #725, #726, #727, #729 with evidence; tick the #615 queue
