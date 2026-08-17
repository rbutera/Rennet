---
title: Delivery order
description: The current build sequence, the live gaps that matter most, and the definition of done for work on Rennet.
---

Read this before choosing product work. It outranks the ordering implied by
issue numbers, priority labels, and historical plans. Re-check the linked issues
before acting: this page is orientation, while GitHub is the live queue.

Last checked against `main` and GitHub on 2026-08-16.

## Rule Zero

**No consent gates. No capability gates. No robustness for its own sake.**

Ask one question: does the change help Rennet digest a diff and help a person
finish a review, or does it mainly make the capable product harder to use?

Historical plans may argue persuasively for restrictions. Rule Zero wins. A
human signing something that will appear under their name is a product action;
blocking the coding agent from running tests or pushing its branch is not.

## What works now

Both current GitHub destinations are wired end to end:

- A team pull request can be ingested, decomposed, reviewed through the lens
  set, refined, previewed, signed, and posted as one real GitHub review.
- A review of your own branch can produce a drafted title and body, sign, push
  the named branch, and create the pull request. The create path is idempotent by
  head branch and surfaces the resulting URL.
- The coding-agent handoff backend and exact-evidence delta carry have landed,
  and the renderer now wires the loop end to end. Per #72, `review.handoff.run`
  executes the exact composed bundle `review.handoff.compose` produced
  (digest-bound, refusing a tampered or stale bundle); a pure stage-6 preview
  view-model plus paper component render that composed bundle before it runs; and
  the own-branch destination offers a "Hand off to agent" path that composes on
  surface entry, previews, and runs the exact previewed bundle from one action,
  surfacing the outcome truthfully. The run's successor patchset now feeds a
  HUNK-GRAIN delta re-review (#73): the deterministic account names the exact
  hunks the agent changed beyond the asks — including an unrequested hunk inside
  an asked file, which path grain cannot see — and consumes the composed bundle's
  `traceMap` to attribute each ask to the task that ran it. The fuzzy sub-file
  matcher exists but is DELIBERATELY not connected to disposition carry (a
  confident fuzzy `move` can point a human's approval at code they never read —
  issues #16/#254/#266 own that seam); the delta carry stays the byte-verified
  one. When the acting path is
  called, the agent is allowed to edit and test with the full harness tool surface.
- Blast radius, the project knowledge lifecycle, IPC field-fidelity fixes,
  shell-enabled verification turns, and honest invocation-budget behavior have
  all landed since the previous delivery-order snapshot.

That closes the most obvious “review buddy cannot finish the review” holes. Do
not rebuild them from old issue prose.

## What matters next: the wave order

The build sequence is a numbered wave list (Rai's decision, 2026-08-16). Work
proceeds wave by wave; at most two waves run in parallel, and only when they
touch disjoint files. Each wave is one OpenSpec change (trivial sweeps excepted),
implemented against its tasks and dual-reviewed before merge, and closes its
issues in the same motion.

1. ~~Wire the handoff renderer loop~~ — **done** (#72 closed; #323 + #325 on `main`).
2. ~~[#309 — blockingStates disclosure](https://github.com/rbutera/rennet/issues/309)~~ — **delivered**: the flagged runner now stamps the decomposition floor's `blockingStates` (R18) onto its `FlaggedReview` result (ok and failed alike); the Flagged lens replaces the unqualified "ran clean" copy with a qualified all-clear plus a per-blocker disclosure when ingestion was blocked, and the PublishSheet discloses the same blockers before the sign control. The disclosure is render-only honest copy — it never feeds `ledgerBlocksSign`/`resolveSign` or adds any acknowledgement (Rule Zero), proven by a DOM test that a sufficient hold still signs with the disclosure present.
3. ~~[#73 — hunk-grain beyond-asks](https://github.com/rbutera/rennet/issues/73)~~ — **delivered**: the delta re-review consumes the handoff run's `traceMap` and the decomposition floor's structured hunks so the deterministic, model-free account narrates the exact hunks the agent changed beyond the asks — the loud unasked-file bucket AND the quiet asked-file bucket (an unrequested hunk inside an asked file, which path grain structurally misses) — and attributes each ask to the composed task that ran it. Content-identity over changed-line bytes (pure line drift is not change), per-file truncation degrades honestly to path grain, all fields additive-optional (legacy snapshots validate and render unchanged), and the account gates nothing (Rule Zero). The fuzzy sub-file matcher stays deliberately unconnected to disposition carry (#16/#254/#266). Completes the agent loop.
4. ~~[#324 — `review.load` by id](https://github.com/rbutera/rennet/issues/324) plus the final [#297](https://github.com/rbutera/rennet/issues/297) follow-up~~ — **delivered**: a new `review.load` protocol command reopens any persisted review by id as a pure read (no event appended; the review folds exactly as persisted), returning `{ review, repositoryPresent }`. Dispatch drops the globally-latest pin — `requireLatestReview` became `requireReviewById` over the store — so every id-addressed command (canvases, flagged, ask, reattach, handoff, delta digest) resolves the exact review it names, and an older reopened review works everywhere. When the review's recorded repository root no longer exists, the load still returns the full review with `repositoryPresent: false`; the renderer shows a plain worktree-gone status, skips the working-tree freshness watcher, and lets the live canvases report their honest unavailable state — no confirmation, no gate (Rule Zero). The navigation stack now persists to a versioned (`v3`) local blob — recents plus the full back/forward stack — restored on boot by a single landing rehydrator that loads whatever the current surface needs (`review.load` for review-family surfaces, `project.detail` for project surfaces) and floors honestly to the nearest restorable ancestor when an entry can no longer load (the Projects root always restores). An unreadable or older (`v2`) blob degrades to recents-only with no migration prompt, and a rehydrating surface never renders another surface's content under its crumb (the #305 regression class). Closes #324 and #297.
5. ~~Product-debt sweep, one branch: [#158](https://github.com/rbutera/rennet/issues/158) remainder, [#71](https://github.com/rbutera/rennet/issues/71) verify-or-close, [#239](https://github.com/rbutera/rennet/issues/239) raw-markdown keystroke, [#88](https://github.com/rbutera/rennet/issues/88) provenance re-stamping (four sites), and [#221](https://github.com/rbutera/rennet/issues/221) — drop the Claims lens~~ — **delivered**: the Claims lens is gone (#221) — removed from `CanvasAngle`/`ChunkAngle`/`CANVAS_ANGLES`, the `claim` doc type, the V104 closed set, the canvas-set schema, and the switcher; the validator rejects a newly declared `claims` angle, while legacy unknown angles are inert at the current projection boundaries. Provenance now reflects the executor that actually ran (#88): the four runner sites prefer the turn's executor facts, so a Codex utility-port turn stamps `utility`/`light` with its per-call capability instead of the seat's `agentic`/`heavy` default, threaded back through an additive optional field on the turn result. The Spec viewer offers raw markdown one keystroke away (#239): `OpenSpecChange` carries the verbatim artifact text alongside the parsed model, and `r` flips the structured view to the on-disk markdown and back (structured stays the default). The flagged-spend comment now tells the truth and records the eager settle (#158 — the auto-run on review open stays, budget-ceilinged, not withheld behind a ritual). #71 closes on evidence: feed-line anchors landed in #321, one narration organ with no near-copies, MVP honest-pending holds — no code needed.
6. Windows support, phase 1: the WSL interop spike on the lancelot test bed (`wsl.exe` stdio + the Claude SDK launcher shim). A gate for the whole `add-windows-support` change: it can invalidate the design, so nothing later in that change starts before it reports. May run in parallel with waves 2–5 (disjoint files).
7. Windows support, phases 2–6: locus seam and path translation, per-locus discovery, harness turns in WSL, the native Windows surface, then verification on lancelot in both modes. Files the Windows release-engineering follow-up (signing/installer/updater) as its own issue, mirroring #298.
8. [#28 — settings v1 remainder](https://github.com/rbutera/rennet/issues/28): the schema registry, the honest resolution ladder, and the per-repo Explain/Reset/Pin surface. Every consumed setting is declared once (validator reused from the protocol schema, builtin default, permitted layers, merge strategy, provenance renderer) in one `SETTINGS_REGISTRY` in `@rennet/core`; a single registry-driven `resolve` folds offers in the exported `LAYER_ORDER`. The ladder is `builtin < detected < global < repo` — the four layers with a live producer today, not eight. `detected` is the new rung: environment-derived offers (execution-locus auto-detection) enter the ladder as ordinary contributions, so locus resolves *through* the resolver with true provenance (`locusProvenance`) instead of the old `config?.locus ?? detectLocus(...)` side-channel. The surface gains Explain (the resolver's own contributions on every row, locus included), Reset-to-inherit (drop the repo-layer entry; visibility also re-applies the gitignore switch toward the newly effective value), Pin-at-repo (write the current effective value explicitly — chiefly to freeze a detected locus), and a global Reset on the appearance scheme. All plain config writes, zero confirmation ceremony (Rule Zero); the Rule-75 malformed-config refusals are unchanged. **Deliberately cut** (each argued in the change's proposal, to ship with its first real producer, not now): the retired plan's workspace / repo-shared / changeset layers (no committed settings file is read by anything), the `union` / `deepMerge` / `append` merge strategies (every consumed key is `replace`), and the persisted uuidv7 record/provenance table (provenance is computed fresh per read — a persisted copy could go stale and lie). "Eight-layer resolver" and "records" are no longer the standing description. After Windows, which reshapes what settings must express (per-locus values).
9. [#44 — command registry v1: conflicts, overrides, menu bar](https://github.com/rbutera/rennet/issues/44) — **delivered**: the shipped `buildCommands` registry now reads every stable command's title, group, and default chord from one exported `COMMAND_CATALOGUE` (its full id/title/group/keybinding matrix is pinned across contexts), and the palette, key dispatch, the settings Keyboard section, and the application menu all derive from it. **Persistent user overrides** ride an additive-optional `keybindings: Record<commandId, chord|null>` on the shipped `GlobalConfig` (`~/.rennet/config.json`), written through the same malformed-refusing `updateGlobal` path `setAppearance` uses via `settings.setKeybinding` (string sets, `null` unbinds, omitted resets). Successful writes lift immediately into app state, so dispatch, palette conflicts, and the menu re-derive without restart; every catalogue command can receive a first binding, while stale unknown ids remain visible and resettable. Invalid stored chords are disclosed raw and fall back to the default instead of reaching dispatch or the menu. **Conflicts are disclosure, never a block** (Rule Zero): `findConflicts` reports every chord claimed by more than one command; the palette and settings rows name the collision; the write still lands, and first registry match wins. The app-wide dispatcher matches bare and modified chords, guards bare keys in editing controls, and requires the platform-primary modifier (`Meta` on macOS, `Ctrl` elsewhere); the recorder refuses unsupported Shift/Alt combinations inline rather than losing modifiers. Canvas aliases yield to effective bindings and explicit unbinds, and a workspace-handled chord stops propagation so it fires once. The **application menu** is projected by the renderer and validated through the protocol-owned runtime schema before MAIN replaces the standing menu; out-of-context commands are disabled, clicks route through the same handlers, Windows/Linux use `registerAccelerator: false`, and macOS carries inert shortcut text with no accelerator field, leaving the renderer as the sole dispatcher. On the override store: the field lives on the shipped `GlobalConfig`; the settings ladder registers it as the global-layer key with no migration. **Deliberately not built** (no live consumer): cmdk/tinykeys adoption, key sequences, macros, per-repo keybinding layers.
10. Deferred tier, in dependency order as appetite allows: ~~[#25](https://github.com/rbutera/rennet/issues/25) Codex adapter~~ — **delivered**: `CodexAdapter implements HarnessPort`, the second real harness slot and peer of the Claude adapter. Transport verdict (the one deliberate divergence from the issue's letter, argued in the change's design): the adapter speaks `codex exec --json` behind an injected `CodexTurnTransport` seam — the mirror of `ClaudeQueryFn` — NOT the `codex app-server` JSON-RPC protocol. Evidence: every live `HarnessPort` consumer is single-turn (create → send → drain → close), the installed `codex` 0.146.0 labels `app-server` `[experimental]` and its shape has already drifted, and the Rule Zero amendment struck the approval apparatus that was app-server's main structural requirement. `codex exec` covers everything the acceptance criteria still need at exactly the capable-by-default posture (`--dangerously-bypass-approvals-and-sandbox`, real repo cwd, no gating). The app-server transport lands behind the same seam when steering or thread-resume is actually consumed. The desktop now resolves the `orchestrator-chat` council seat across both adapters: a Codex-selected turn reaches the injected transport and the same live canvasOps backend over loopback. Shipped with it: the **cross-adapter conformance suite** (`@rennet/core`, pure over `HarnessPort`) — one catalogue whose passing checks derive each capability flag through `buildCapabilities`, hermetic-by-default with a per-check refuting control and gated `.real` runs earning the outer layers only on a full expected pass/fail match; **testedRange** derived from a committed artifact (Claude keeps the permitted migration seed; Codex remains absent until its first genuine full-match real run); and **canvasOps@2 as an external loopback streamable-HTTP transport** so a codex session reaches the identical descriptors with no `if (harness === X)` branching. Codex token usage does not certify context-window size, which remains false. Struck approval scope is honored — no consent apparatus, not built, not tested for. Host locus only (WSL codex is #334's seam). This unblocks → [#41](https://github.com/rbutera/rennet/issues/41) cross-harness adjudication with seeded ground truth → [#26](https://github.com/rbutera/rennet/issues/26) omp slot; [#183](https://github.com/rbutera/rennet/issues/183) verify-ui independently.
11. ~~Polish sweep ([#316](https://github.com/rbutera/rennet/issues/316), [#65](https://github.com/rbutera/rennet/issues/65), [#89](https://github.com/rbutera/rennet/issues/89), [#92](https://github.com/rbutera/rennet/issues/92), [#75](https://github.com/rbutera/rennet/issues/75), [#223](https://github.com/rbutera/rennet/issues/223))~~ — **delivered** (four fixes, two evidence closes): a turn-aware **intelligence session** in MAIN now gives each review turn ONE required `InvocationBudget` and ONE hypothesis promise. The paired canvas and flagged dispatches share that exact object across hypothesis, Decisions, canvas, finding, verification, refinement, and narration work; re-entering either flow at the same review/patchset starts fresh, so canvas retries and Quick↔Dual toggles cannot inherit depleted spend or a stale failed hypothesis. Both routes carry the same explicit mode, so arrival order cannot choose a 6-vs-12 ceiling (#316). The orchestrator **primer bounds B2/B3** at exactly 4,096 bytes: per-repo and compact per-canvas lines are capped, then deterministic exact rollups (`… +N more repos — X current / Y not current`, where updating/failed are truthfully not current; `… +N more canvases — E elements, D/P dispositioned, U unread`) keep the 10-repo / 20-canvas fixture inside the ceiling and remain identical under shuffled input, with rolled-up rows still reachable via the tool surface (#65). The council **harness is no longer overridable** — after defaults, availability degradation, and every model/effort override resolve, `harness` derives exactly once from the final model's provider, so even contradictory degraded defaults cannot emit an incoherent pair (#89). The owned tokenizer gains a **per-grammar comment word boundary** (shell/yaml `#` needs a boundary, python does not), treats a diff row's `+`/`-` marker as outside the source grammar so column-zero comments retain highlighting, and enforces **radix-correct separators strictly between digits**; malformed candidates such as `0x_`, `0X_FF`, `0o_7`, `0b10_`, and `1e10_` fail closed to plain (#92, items 1–2). The symbol-inspector **miss copy names the committed review range**, so a symbol living only in uncommitted local edits reads as outside the reviewed range, not nonexistent (#223). **Closed with evidence, no code:** #75 (`documentRejected` has zero producers/ledger/consumers — the instrument would precede its signal) and #223's working-tree overlay (committed range is the right review scope; no demand). **Deliberately not built:** #92 item 3 (JS/TS regex literals — a line-local `/` divide-vs-literal guess would mis-highlight division, a worse lie than the current one). Then [#85](https://github.com/rbutera/rennet/issues/85) — the full design and usability pass — remains the open closing milestone. The accumulated `styles.css` design-system debt belongs there.

After wave 5 (plus the human-only #298 setup), Rennet is feature-complete as
specced: both doors, the full loop including the agent handoff, honest UI.
Waves 6+ are expansion, not completion.

### Release when the external pieces are ready

[Issue #298](https://github.com/rbutera/rennet/issues/298) owns public macOS
signing, GitHub release publishing, and updates. It is blocked on Rai's
human-only checklist (Apple enrolment, certificates, repository visibility,
CI secrets), not on another in-product ceremony. It unblocks the moment the
checklist comment lands, independent of every wave above. [#225](https://github.com/rbutera/rennet/issues/225)
stays parked behind remote-PR sourcing.

## How to read an issue

Some older issues carry a Rule Zero amendment with struck scope. Struck scope is
not work. Also check whether the issue is already closed and whether its shipped
commit is on `main`; several old documents described completed features as
missing.

Use this order of evidence:

1. Current live code and the real call path.
2. Current issue state and its closing note.
3. Promoted OpenSpec requirements.
4. Historical plans and archived changes.

## What counts as a bug

Always worth fixing:

- The diff does not show what changed.
- A crash.
- A UI state that claims work succeeded, content exists, or a mark was placed
  when the live path says otherwise.
- A transport that silently strips a field.
- A test that stays green when its claimed guard or integration is deleted.
- An agent that cannot run the test or push the branch needed to finish its job.

Not a product bug by itself:

- A theoretical bypass with no demonstrated product failure.
- Precision hardening whose payoff is showing the user less.
- A proposal whose fix is an approval ceremony, consent token, sandbox, or
  capability denial.

## Definition of done

Run the full repository gate:

```sh
pnpm check
```

The gate includes a positive control that must be capable of failing. Use the
Nx cache when its declared inputs match; do not add `--skip-nx-cache` to make a
result look fresher. Update the affected docs in the same change, push, and
verify the remote ref matches local `HEAD`.
