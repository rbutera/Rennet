---
title: Delivery order
description: The current build sequence, the live gaps that matter most, and the definition of done for work on Rennet.
---

Read this before choosing product work. It outranks the ordering implied by
issue numbers, priority labels, and historical plans. Re-check the linked issues
before acting: this page is orientation, while GitHub is the live queue.

Last checked against `main` and GitHub on 2026-08-17.

## Rule Zero

**No consent gates. No capability gates. No robustness for its own sake.**

Ask one question: does the change help Rennet digest a diff and help a person
finish a review, or does it mainly make the capable product harder to use?

Historical plans may argue persuasively for restrictions. Rule Zero wins. A
human publishing something that will appear under their name is a product action;
blocking the coding agent from running tests or pushing its branch is not.

## What works now

Both current GitHub destinations are wired end to end:

- A team pull request can be ingested, decomposed, reviewed through the lens
  set, refined, previewed, and posted as one real GitHub review.
- A review of your own branch can produce a drafted title and body, publish, push
  the named branch, and create the pull request. The create path is idempotent by
  head branch and surfaces the resulting URL.
- The coding-agent handoff backend and exact-evidence delta carry have landed,
  and the renderer now wires the loop end to end. Per #72, `review.handoff.run`
  executes the exact composed bundle `review.handoff.compose` produced
  (digest-bound, refusing a tampered or stale bundle); a pure stage-6 preview
  view-model plus preview component render that composed bundle before it runs; and
  the own-branch destination offers a "Hand off to agent" path that composes on
  surface entry, previews, and runs the exact previewed bundle from one action,
  surfacing the outcome truthfully.
- The run's successor patchset now feeds a
  HUNK-GRAIN delta re-review (#73): the deterministic account names the exact
  hunks the agent changed beyond the asks — including an unrequested hunk inside
  an asked file, which path grain cannot see — and consumes the composed bundle's
  `traceMap` to attribute each ask to the task that ran it. The fuzzy sub-file
  matcher exists but is DELIBERATELY not connected to disposition carry (a
  confident fuzzy `move` can point a human's approval at code they never read —
  issues #16/#254/#266 own that seam); the delta carry stays the byte-verified
  one.
- When the acting path is called, the agent is allowed to edit and test with the full harness tool surface.
- Blast radius, the project knowledge lifecycle, IPC field-fidelity fixes,
  shell-enabled verification turns, and honest invocation-budget behavior have
  all landed since the previous delivery-order snapshot.

That closes the most obvious “review buddy cannot finish the review” holes. Do
not rebuild them from old issue prose.

## The wave order (all delivered)

Every wave below is delivered; for live work jump to [What is genuinely open
now](#what-is-genuinely-open-now).

The build sequence is a numbered wave list (Rai's decision, 2026-08-16). Work
proceeds wave by wave; at most two waves run in parallel, and only when they
touch disjoint files. Each wave is one OpenSpec change (trivial sweeps excepted),
implemented against its tasks and dual-reviewed before merge, and closes its
issues in the same motion.

1. **Handoff renderer loop wired end to end: done (#72 closed).**

   ~~Wire the handoff renderer loop~~ — **done** (#72 closed; #323 + #325 on `main`).
2. **#309 blockingStates disclosure: the flagged runner stamps ingestion blockers onto its result, and the Flagged lens and PublishSheet disclose them as render-only copy that never gates the post.**

   ~~[#309 — blockingStates disclosure](https://github.com/rbutera/rennet/issues/309)~~ — **delivered**: the flagged runner now stamps the decomposition floor's `blockingStates` (R18) onto its `FlaggedReview` result (ok and failed alike); the Flagged lens replaces the unqualified "ran clean" copy with a qualified all-clear plus a per-blocker disclosure when ingestion was blocked, and the PublishSheet discloses the same blockers before the publish control. The disclosure is render-only honest copy — it never feeds `ledgerBlocksSign`/`resolveSign` or adds any acknowledgement (Rule Zero), proven by a DOM test that a sufficient hold still posts with the disclosure present.
3. **#73 hunk-grain beyond-asks: the delta re-review names the exact hunks the agent changed beyond the asks, both the unasked-file and the quiet asked-file buckets, and gates nothing.**

   ~~[#73 — hunk-grain beyond-asks](https://github.com/rbutera/rennet/issues/73)~~ — **delivered**: the delta re-review consumes the handoff run's `traceMap` and the decomposition floor's structured hunks so the deterministic, model-free account narrates the exact hunks the agent changed beyond the asks — the loud unasked-file bucket AND the quiet asked-file bucket (an unrequested hunk inside an asked file, which path grain structurally misses) — and attributes each ask to the composed task that ran it. Content-identity over changed-line bytes (pure line drift is not change), per-file truncation degrades honestly to path grain, all fields additive-optional (legacy snapshots validate and render unchanged), and the account gates nothing (Rule Zero). The fuzzy sub-file matcher stays deliberately unconnected to disposition carry (#16/#254/#266). Completes the agent loop.
4. **#324 `review.load` by id plus #297: a new command reopens any persisted review by id as a pure read, every id-addressed command resolves the exact review it names, and the versioned navigation stack restores on boot.**

   ~~[#324 — `review.load` by id](https://github.com/rbutera/rennet/issues/324) plus the final [#297](https://github.com/rbutera/rennet/issues/297) follow-up~~ — **delivered**: a new `review.load` protocol command reopens any persisted review by id as a pure read (no event appended; the review folds exactly as persisted), returning `{ review, repositoryPresent }`. Dispatch drops the globally-latest pin — `requireLatestReview` became `requireReviewById` over the store — so every id-addressed command (canvases, flagged, ask, reattach, handoff, delta digest) resolves the exact review it names, and an older reopened review works everywhere. When the review's recorded repository root no longer exists, the load still returns the full review with `repositoryPresent: false`; the renderer shows a plain worktree-gone status, skips the working-tree freshness watcher, and lets the live canvases report their honest unavailable state — no confirmation, no gate (Rule Zero). The navigation stack now persists to a versioned (`v3`) local blob — recents plus the full back/forward stack — restored on boot by a single landing rehydrator that loads whatever the current surface needs (`review.load` for review-family surfaces, `project.detail` for project surfaces) and floors honestly to the nearest restorable ancestor when an entry can no longer load (the Projects root always restores). An unreadable or older (`v2`) blob degrades to recents-only with no migration prompt, and a rehydrating surface never renders another surface's content under its crumb (the #305 regression class). Closes #324 and #297.
5. **Product-debt sweep: drop the Claims lens (#221), stamp provenance from the executor that actually ran (#88), a raw-markdown keystroke in the Spec viewer (#239), honest flagged-spend copy (#158), and #71 closed on evidence.**

   ~~Product-debt sweep, one branch: [#158](https://github.com/rbutera/rennet/issues/158) remainder, [#71](https://github.com/rbutera/rennet/issues/71) verify-or-close, [#239](https://github.com/rbutera/rennet/issues/239) raw-markdown keystroke, [#88](https://github.com/rbutera/rennet/issues/88) provenance re-stamping (four sites), and [#221](https://github.com/rbutera/rennet/issues/221) — drop the Claims lens~~ — **delivered**: the Claims lens is gone (#221) — removed from `CanvasAngle`/`ChunkAngle`/`CANVAS_ANGLES`, the `claim` doc type, the V104 closed set, the canvas-set schema, and the switcher; the validator rejects a newly declared `claims` angle, while legacy unknown angles are inert at the current projection boundaries. Provenance now reflects the executor that actually ran (#88): the four runner sites prefer the turn's executor facts, so a Codex utility-port turn stamps `utility`/`light` with its per-call capability instead of the seat's `agentic`/`heavy` default, threaded back through an additive optional field on the turn result. The Spec viewer offers raw markdown one keystroke away (#239): `OpenSpecChange` carries the verbatim artifact text alongside the parsed model, and `r` flips the structured view to the on-disk markdown and back (structured stays the default). The flagged-spend comment now tells the truth and records the eager settle (#158 — the auto-run on review open stays, budget-ceilinged, not withheld behind a ritual). #71 closes on evidence: feed-line anchors landed in #321, one narration organ with no near-copies, MVP honest-pending holds — no code needed.
6. **Windows support phase 1: the WSL interop spike on lancelot delivered as the gate for the whole change, run in parallel with waves 2 to 5.**

   ~~Windows support, phase 1: the WSL interop spike on the lancelot test bed (`wsl.exe` stdio + the Claude SDK launcher shim)~~ — **delivered** (`add-windows-support` archived at 3839a3d). A gate for the whole `add-windows-support` change: it could invalidate the design, so nothing later in that change started before it reported. Ran in parallel with waves 2–5 (disjoint files); its verdict held and unblocked phases 2–6.
7. **Windows support phases 2 to 6: locus seam, path translation, per-locus discovery, WSL harness turns, and the native Windows surface delivered; only the live win32 verification matrix on lancelot is still pending.**

   ~~Windows support, phases 2–6: locus seam and path translation, per-locus discovery, harness turns in WSL, the native Windows surface~~ — **delivered** (`add-windows-support` archived at 3839a3d; the [#334](https://github.com/rbutera/rennet/issues/334) `wsl-remainder` promoted at 9faccce over feat 74f23e1). The Windows release-engineering follow-up (signing/installer/updater) is filed as its own issue, mirroring #298. The `wsl-remainder` closed the two deferred seams: codex-in-WSL (locus-aware transport + executor, distro-native argv, distro-reachable canvasOps with honest failure; its exec-era distro-side scratch was later removed by `adopt-codex-app-server` — the turn path is stdio-only now) and read-pipeline locus threading (every review-pipeline model turn resolves the project's locus; `resolveKnowledgePort` gains a repo-root parameter). Implemented and hermetically tested. **Still pending:** the live win32 verification matrix on lancelot in both modes — the one open sub-item, to be recorded once it runs.
8. **#28 settings v1 remainder: one `SETTINGS_REGISTRY` declares every consumed setting, a registry-driven resolver folds the builtin/detected/global/repo ladder with true provenance, and the per-repo surface gains Explain, Reset-to-inherit, and Pin, all plain config writes with no confirmation ceremony.**

   ~~[#28 — settings v1 remainder](https://github.com/rbutera/rennet/issues/28)~~ — **delivered**: the schema registry, the honest resolution ladder, and the per-repo Explain/Reset/Pin surface. Every consumed setting is declared once (validator reused from the protocol schema, builtin default, permitted layers, merge strategy, provenance renderer) in one `SETTINGS_REGISTRY` in `@rennet/core`; a single registry-driven `resolve` folds offers in the exported `LAYER_ORDER`. The ladder is `builtin < detected < global < repo` — the four layers with a live producer today, not eight. `detected` is the new rung: environment-derived offers (execution-locus auto-detection) enter the ladder as ordinary contributions, so locus resolves *through* the resolver with true provenance (`locusProvenance`) instead of the old `config?.locus ?? detectLocus(...)` side-channel. The surface gains Explain (the resolver's own contributions on every row, locus included), Reset-to-inherit (drop the repo-layer entry; visibility also re-applies the gitignore switch toward the newly effective value), Pin-at-repo (write the current effective value explicitly — chiefly to freeze a detected locus), and a global Reset on the appearance scheme. All plain config writes, zero confirmation ceremony (Rule Zero); the Rule-75 malformed-config refusals are unchanged. **Deliberately cut** (each argued in the change's proposal, to ship with its first real producer, not now): the retired plan's workspace / repo-shared / changeset layers (no committed settings file is read by anything), the `union` / `deepMerge` / `append` merge strategies (every consumed key is `replace`), and the persisted uuidv7 record/provenance table (provenance is computed fresh per read — a persisted copy could go stale and lie). "Eight-layer resolver" and "records" are no longer the standing description. After Windows, which reshapes what settings must express (per-locus values).
9. **#44 command registry v1: one `COMMAND_CATALOGUE` drives the palette, key dispatch, the Keyboard settings, and the application menu; persistent user overrides ride the global config; and chord conflicts are disclosure that never blocks the write.**

   ~~[#44 — command registry v1: conflicts, overrides, menu bar](https://github.com/rbutera/rennet/issues/44)~~ — **delivered**: the shipped `buildCommands` registry now reads every stable command's title, group, and default chord from one exported `COMMAND_CATALOGUE` (its full id/title/group/keybinding matrix is pinned across contexts), and the palette, key dispatch, the settings Keyboard section, and the application menu all derive from it. **Persistent user overrides** ride an additive-optional `keybindings: Record<commandId, chord|null>` on the shipped `GlobalConfig` (`~/.rennet/config.json`), written through the same malformed-refusing `updateGlobal` path `setAppearance` uses via `settings.setKeybinding` (string sets, `null` unbinds, omitted resets). Successful writes lift immediately into app state, so dispatch, palette conflicts, and the menu re-derive without restart; every catalogue command can receive a first binding, while stale unknown ids remain visible and resettable. Invalid stored chords are disclosed raw and fall back to the default instead of reaching dispatch or the menu. **Conflicts are disclosure, never a block** (Rule Zero): `findConflicts` reports every chord claimed by more than one command; the palette and settings rows name the collision; the write still lands, and first registry match wins. The app-wide dispatcher matches bare and modified chords, guards bare keys in editing controls, and requires the platform-primary modifier (`Meta` on macOS, `Ctrl` elsewhere); the recorder refuses unsupported Shift/Alt combinations inline rather than losing modifiers. Canvas aliases yield to effective bindings and explicit unbinds, and a workspace-handled chord stops propagation so it fires once. The **application menu** is projected by the renderer and validated through the protocol-owned runtime schema before MAIN replaces the standing menu; out-of-context commands are disabled, clicks route through the same handlers, Windows/Linux use `registerAccelerator: false`, and macOS carries inert shortcut text with no accelerator field, leaving the renderer as the sole dispatcher. On the override store: the field lives on the shipped `GlobalConfig`; the settings ladder registers it as the global-layer key with no migration. **Deliberately not built** (no live consumer): cmdk/tinykeys adoption, key sequences, macros, per-repo keybinding layers.
10. **Deferred tier: the Codex adapter (#25) and omp slot (#26) as the second and third real `HarnessPort` slots, cross-harness adjudication when the two seats disagree (#41), and the verify-ui pass that mounts the rendered surface (#183).**

    Deferred tier, in dependency order as appetite allows: ~~[#25](https://github.com/rbutera/rennet/issues/25) Codex adapter~~ — **delivered**: `CodexAdapter implements HarnessPort`, the second real harness slot and peer of the Claude adapter. Transport verdict at delivery time (the one deliberate divergence from the issue's letter, argued in the change's design): the adapter spoke `codex exec --json` behind an injected `CodexTurnTransport` seam — the mirror of `ClaudeQueryFn` — NOT the `codex app-server` JSON-RPC protocol. Evidence: every live `HarnessPort` consumer is single-turn (create → send → drain → close), the installed `codex` 0.146.0 labels `app-server` `[experimental]` and its shape has already drifted, and the Rule Zero amendment struck the approval apparatus that was app-server's main structural requirement. `codex exec` covered everything the acceptance criteria then needed at exactly the capable-by-default posture (`--dangerously-bypass-approvals-and-sandbox`, real repo cwd, no gating), with the app-server transport slated to land behind the same seam when a consumer demanded it. **[SUPERSEDED by `adopt-codex-app-server`, below]** — the transport has since moved to `codex app-server` JSON-RPC (not for steering/resume, but for first-class structured output, in-protocol usage, and the ChatGPT-desktop bundle as a zero-install Codex seat); the `codex exec --json` verdict and its `distro-side scratch` detail in this entry are historical. The desktop now resolves the `orchestrator-chat` council seat across both adapters: a Codex-selected turn reaches the injected transport and the same live canvasOps backend over loopback. Shipped with it: the **cross-adapter conformance suite** (`@rennet/core`, pure over `HarnessPort`) — one catalogue whose passing checks derive each capability flag through `buildCapabilities`, hermetic-by-default with a per-check refuting control and gated `.real` runs earning the outer layers only on a full expected pass/fail match; **testedRange** derived from a committed artifact (Claude keeps the permitted migration seed; Codex remains absent until its first genuine full-match real run); and **canvasOps@2 as an external loopback streamable-HTTP transport** so a codex session reaches the identical descriptors with no `if (harness === X)` branching. Codex token usage does not certify context-window size, which remains false. Struck approval scope is honored — no consent apparatus, not built, not tested for. The host-locus-only limit was later closed by [#334](https://github.com/rbutera/rennet/issues/334): both Codex spawn sites became locus-aware (distro-native argv, distro-reachable canvasOps; the exec-era distro-side scratch has since been removed by the app-server transport), so a WSL review runs the distro's own Codex. This unblocks → [#41](https://github.com/rbutera/rennet/issues/41) cross-harness adjudication with seeded ground truth → [#26](https://github.com/rbutera/rennet/issues/26) omp slot; [#183](https://github.com/rbutera/rennet/issues/183) verify-ui independently. **[#41 — cross-harness adjudication](https://github.com/rbutera/rennet/issues/41) — delivered**: the Model Council's `adjudication` seat, carried consumer-less since #89, finally runs. When the two harness seats DISAGREE, a new pure-core pass (`finding-adjudication.ts`, model I/O injected like verification) takes each reconciled `disagree` row — divergence is the only trigger — and runs one fresh turn on the resolved adjudication seat, handed BOTH labelled answers with explicit polarity plus the real code window, returning `supported | contradicted | insufficient` plus one line of evidence. The verdict is additive-optional on the disagree arm and INFORMS, never gates: the row always renders with both verbatim answers, an adjudicated flare shows which side the code backs, and a failed/capped/budget-exhausted turn is an honest `insufficient` with its reason — never a drop, never a fabricated verdict, no render or publish path waits on it (Rule Zero). It draws from the ONE shared review budget and is capped at `DEFAULT_MAX_ADJUDICATIONS = 4`. A seeded ground-truth corpus (~10 Rennet-authored SYNTHETIC diffs — planted bugs and clean controls across off-by-one / null-deref / resource-leak / mechanical-nit / clean-control classes, NEVER client data) plus a pure scorer measure whether explicit adjudication beats raw overlap; the default gate exercises pass + scorer against fake in-process seats at ZERO model spend, and a gated `RENNET_LIVE_ADJUDICATION` `.real` run records the committed per-class calibration table (`adjudication-calibration.json`, real-run-only, empty honest shape until a genuine run lands — informational, nothing gates on it). **Deliberately cut** (each Rule Zero / no live path): N=3 same-model self-consistency (no single-provider divergence source exists — dual review under one provider degrades to a single seat, so the trigger never fires), the struck ship gate (calibration is measured and disclosed, never "adjudication must beat overlap before a flare renders"), and any new claim schema beyond the shipped anchor canonicalisation.

    ~~[#26](https://github.com/rbutera/rennet/issues/26) omp slot~~ — **delivered**: `OmpAdapter implements HarnessPort`, the third real slot (R23), using capable-by-default `omp --mode rpc` behind an injected transport, never ACP. Discovery resolves Bun first, enforces `>=1.3.14`, probes and launches the omp script through that exact runtime, demotes asdf omp shims behind real installs, and consumes locus `PATHEXT` on Windows. The loopback canvasOps declaration is a supported scratch-extension `mcp.json` (`type: "http"`), not a `--config` settings overlay; exact placement/schema/invocation are hermetically covered, while live MCP discovery remains unclaimed. RPC stdout frames and stderr are byte-bounded; corrupt, oversized, rejected, construction-failed, and iteration-failed turns settle one failed outcome. `structuredOutput`, usage, and cost remain absent rather than inferred from JSON text or fake-only stats. The hermetic conformance run proves only `interrupt` and `textDeltas` at `implementedByAdapter`; every outer layer stays false, `testedRange` is absent, and health is explicitly `untested` until `RENNET_LIVE_OMP=1` completes a full expected-matrix real run. No live omp turn has run. The orchestrator selects omp only when neither Claude nor Codex is installed. Deliberate cuts remain: no `pi` slot, council-table extension, ACP, sandbox/read-only posture, steer/resume/fork consumers, or picker UI.

    **[#183 — verify-ui](https://github.com/rbutera/rennet/issues/183) — delivered**: the fourth verse of the review-intelligence song (after hypothesis #178, dual-model #41, per-finding verification #179) — the pass that *mounts the rendered surface* the blind-dogfood analysis named as the review loop's biggest gap. A deterministic, versioned UI-surface classifier (`classifyUiSurface`, `UI_SURFACE_CLASSIFIER_VERSION = 1`: extensions `.tsx .jsx .vue .svelte .html .css .scss .less`, plus `.ts`/`.js` under a `renderer/`/`components/`/`ui/` path segment — zero model spend) gates the pass; a backend-only changeset records the distinct `not-ui` status (not applicable, never an all-clear). A UI-touching deep review gets ONE required-shared-budget turn (`uiVerification.maxTurns = 1`) — the exact `createExecObservingTurn` fresh-capable-session pattern shared with verification, full shell, exec calls observed as proof-of-run — directed to mount the change with whatever the *reviewed project* affords (its tests → storybook → dev server + installed automation → labelled static review), screenshot into its isolated evidence run, run an a11y check, and compare against the captured design intent (`patchsetIntentToReviewIntent`; nothing new ingested). Rennet bundles no browser/axe. A mount/reproduced claim requires agreement among the structured method, a successful mount-relevant observed exec, and an actually present confined screenshot; mismatches stay static/inconclusive. Observations are restricted to classified UI files and anchor to the containing or nearest reported-line hunk, then `applyUiVerification` folds them into ordinary `FindingElement`s flowing through the SAME lens/disposition/publish/delta-carry machinery. The honest additive `UiVerification` status (`pending` / `ran` + screenshot refs / `not-ui` / `unavailable`, with classifier version) rides the successful (`ok`) `FlaggedReview` branch with IPC field-fidelity guards; failed results carry no findings and are outside verify-ui's surface. Desktop MAIN signals every scheduled late enrichment, so all-concur and zero-row renderers poll too; pending/unavailable empty states never claim a full all-clear. Screenshot files live in review/patchset/run namespaces under `<userData>/ui-evidence`, same-patchset superseded runs are removed, old patchsets are bounded, and `review.uiEvidence` applies one canonical-realpath confinement check to a regular file, stats before read, caps screenshots at 8 MiB and the run at 12 references. `FlaggedReview` remains deliberately transient with eager rerun-on-open (#158), matching CI signal and `blockingStates`; reopening recomputes status and current references, with no divergent verify-ui persistence layer. NEVER a gate — the real publish paths ignore every verify-ui state (Rule Zero, behavioral red-first control).
11. **Polish sweep: a shared per-review intelligence session and budget (#316), bounded orchestrator primer rollups (#65), a non-overridable council harness (#89), tokenizer comment and separator fixes (#92), and honest symbol-inspector range copy (#223).**

    ~~Polish sweep ([#316](https://github.com/rbutera/rennet/issues/316), [#65](https://github.com/rbutera/rennet/issues/65), [#89](https://github.com/rbutera/rennet/issues/89), [#92](https://github.com/rbutera/rennet/issues/92), [#75](https://github.com/rbutera/rennet/issues/75), [#223](https://github.com/rbutera/rennet/issues/223))~~ — **delivered** (four fixes, two evidence closes): a turn-aware **intelligence session** in MAIN now gives each review turn ONE required `InvocationBudget` and ONE hypothesis promise. The paired canvas and flagged dispatches share that exact object across hypothesis, Decisions, canvas, finding, verification, refinement, and narration work; re-entering either flow at the same review/patchset starts fresh, so canvas retries and Quick↔Dual toggles cannot inherit depleted spend or a stale failed hypothesis. Both routes carry the same explicit mode, so arrival order cannot choose a 6-vs-12 ceiling (#316). The orchestrator **primer bounds B2/B3** at exactly 4,096 bytes: per-repo and compact per-canvas lines are capped, then deterministic exact rollups (`… +N more repos — X current / Y not current`, where updating/failed are truthfully not current; `… +N more canvases — E elements, D/P dispositioned, U unread`) keep the 10-repo / 20-canvas fixture inside the ceiling and remain identical under shuffled input, with rolled-up rows still reachable via the tool surface (#65). The council **harness is no longer overridable** — after defaults, availability degradation, and every model/effort override resolve, `harness` derives exactly once from the final model's provider, so even contradictory degraded defaults cannot emit an incoherent pair (#89). The owned tokenizer gains a **per-grammar comment word boundary** (shell/yaml `#` needs a boundary, python does not), treats a diff row's `+`/`-` marker as outside the source grammar so column-zero comments retain highlighting, and enforces **radix-correct separators strictly between digits**; malformed candidates such as `0x_`, `0X_FF`, `0o_7`, `0b10_`, and `1e10_` fail closed to plain (#92, items 1–2). The symbol-inspector **miss copy names the committed review range**, so a symbol living only in uncommitted local edits reads as outside the reviewed range, not nonexistent (#223). **Closed with evidence, no code:** #75 (`documentRejected` has zero producers/ledger/consumers — the instrument would precede its signal) and #223's working-tree overlay (committed range is the right review scope; no demand). **Deliberately not built:** #92 item 3 (JS/TS regex literals — a line-local `/` divide-vs-literal guess would mis-highlight division, a worse lie than the current one). Then [#85](https://github.com/rbutera/rennet/issues/85) — the full design and usability pass — was the last open milestone; it is now **delivered** (item 12). The accumulated `styles.css` design-system debt was resolved there.
12. **#85 design and usability pass: an enforced type and radius ramp, the styled verify-ui strip and handoff preview, the real split-disc wordmark, and the aligned conversation margin rail (#356); the closing milestone, with every wave now delivered.**

    ~~[#85 — the full design and usability pass](https://github.com/rbutera/rennet/issues/85)~~ — **delivered**, the closing milestone of the expansion arc; with it, every numbered wave in this delivery order is delivered. The desktop type and radius **ramp becomes documented, enforced truth**: an enumerated desktop scale (type `10/11/12/13/14/16/19/22px` + the front-door display clamp; radius `4/6/8/12/16px` + pill/circle geometry exemptions) is recorded in `DESIGN.md` and the machine-readable `packages/ui/DESIGN.md`. The design detector reads that package-local source and reports zero off-ramp `font-size` longhand and `border-radius` findings; an owned UI Vitest reads the same frontmatter and additionally scans `font:` shorthand plus radius-bearing tokens, so inserting an off-ramp literal reddens the ordinary UI test target. Every audited off-ramp literal migrates onto its documented neighbour. The two **unstyled surfaces get their design**: the verify-ui evidence strip (#352) joins the chrome-verdict chip language (unavailable reads honest, not amber), and the stage-6 handoff preview (#72) becomes the warm opaque `--sheet-*` sheet material with its un-composed mechanical-floor state kept visibly a plain list and viewport-bounded task scrolling. The wordmark decision lands: `RennetMark` swaps its placeholder mono "R" for the real token-driven split-disc glyph (#43). The alignment component ships behind the honest stacked fallback: `ConversationMargin` computes each visible row's offset from that panel's natural normal-flow position when supplied a diff ref, covered by non-zero multi-panel DOM geometry. At #85 the review heart did not yet thread a diff ref from CodeView through `ConversationPanel`/`ConversationHost`; [#356](https://github.com/rbutera/rennet/issues/356) owned that app-level rail-architecture adoption and is now **delivered** — CodeView content rows carry the `data-anchor-key` identity the rail queries (chunk key on the chunk container), CodeView exposes its scroll container upward, and the review heart threads one live diff ref into both the diff column and the conversation column, which now renders the aligned margin path (per-anchor panels, aligned when the anchor row is on-window, stacked otherwise) in place of the retired flat `PanelSurface` stream. Every conversational affordance the flat stream carried is preserved on the rail: per-anchor threads keep ask/promote/sub-thread/pending/error, and the anchorless "ask the orchestrator" affordance is restored as a stacked `GeneralAskPanel` pinned at the rail's end (both-model routing, the reviewer's typed question kept on a failed turn) — the design's named remedy for anchorless content, "keep it in the margin rail as a stacked panel rather than resurrecting the flat stream". **Partially-styled surfaces align** to the shared palette (chord conflicts and the orphaned-thread warning move to the semantic `--amber`; the recorder focus border to `--accent`; two dangling undefined tokens removed). The pre-existing `canvas.css` `noDescendingSpecificity` warning is fixed. **Deliberately not built** (each recorded in the change's design): frame 18's nav restructure (the spine is already live; this aligned presentation only), an execution-mode glyph backed by a mode capability the product does not have, and fabricated positions for off-screen anchor rows.

After wave 5 (plus the human-only #298 setup), Rennet is feature-complete as
specced: both doors, the full loop including the agent handoff, honest UI.
Waves 6–12 were expansion on top of that base, and all of them have landed.

### What is genuinely open now

Every numbered wave above is delivered, so the live queue is elsewhere. The
in-flight OpenSpec changes are where new work starts — check `openspec/changes/`
for their current tasks rather than treating any wave as still open:

- `add-conversation-durability`
- `add-narrated-progress`
- `fix-rest-parser-hunk-metadata`
- `rennet-docsite`
- `adopt-codex-app-server` — swaps the Codex adapter's transport from
  `codex exec --json` to the `codex app-server` JSON-RPC protocol behind the same
  injected seam, **superseding the exec-transport verdict recorded in the #25
  entry above** (that verdict deferred app-server until steering/resume was
  consumed; this change adopts it now for its own reasons — structured output as
  a first-class `turn/start` parameter with no scratch files, in-protocol token
  usage, and a Mac with ChatGPT desktop becoming a working Codex seat with no
  extra install via the bundled binary and shared `~/.codex` auth). Windows still
  rides the codex CLI: the Store-packaged desktop binary is ACL-locked against
  out-of-package execution. Covered by the wave-1 hermetic gate, and the live
  matrix is now green: a real app-server turn through the mac ChatGPT-bundled
  binary (structured output round-tripped, in-protocol usage recorded), a real
  WSL-locus codex turn on lancelot, and the full throttled native win32 gate. See
  the [Codex app-server integration reference](/developing/reference/codex-app-server/).

The one carried-over sub-item from the wave list is wave 7's live win32
verification matrix on lancelot (hermetic tests pass; the on-hardware run is
pending). Release engineering still waits on the human-only checklist below.

### The app server wave (approved 2026-08-17; phases 0–5 shipped 2026-08-18, v0.2.0)

Rai approved a second wave list: refactor Rennet around a local app server /
daemon so the desktop app, a full-fat browser client, a CLI, and later a
native mobile app are all clients of one protocol. The
[app server plan](/developing/reference/app-server-plan/) is the authority for
this wave; the [research digest](/developing/reference/app-server-research/)
is its evidence base. **Phases 0–5 are delivered** (PRs #385, #387, #388,
#390, #391, #392; minor release v0.2.0 marks the wave); each phase's OpenSpec
change is archived. What remains is the mobile arc: the design pass
([#382](https://github.com/rbutera/rennet/issues/382)) gates phase 6
([#383](https://github.com/rbutera/rennet/issues/383)). Known follow-ups:
[#386](https://github.com/rbutera/rennet/issues/386) (pre-existing e2e
failures on main) and
[#389](https://github.com/rbutera/rennet/issues/389) (live ask-stream rebind
after a mid-turn reconnect).

0. [#376 — protocol handshake, envelope, and versioning
   discipline](https://github.com/rbutera/rennet/issues/376)
1. [#377 — extract `packages/server`](https://github.com/rbutera/rennet/issues/377)
2. [#378 — WebSocket transport + `WsRennetBridge`; renderer becomes client
   #1](https://github.com/rbutera/rennet/issues/378)
3. [#379 — detached daemon, reviews survive app quit, `rennet`
   CLI](https://github.com/rbutera/rennet/issues/379)
4. [#380 — remote surface: R19 projection, pairing,
   Tailscale-first](https://github.com/rbutera/rennet/issues/380)
5. [#381 — Browser Rennet: one UI, two shells, local or remote
   daemon](https://github.com/rbutera/rennet/issues/381)
6. [#383 — native mobile app](https://github.com/rbutera/rennet/issues/383),
   **gated on [#382](https://github.com/rbutera/rennet/issues/382)** (the
   mobile design pass: ideation doc, wireframes, impeccable planning pass,
   Rai's sign-off).

Wave conventions apply: one OpenSpec change per phase, dual review, docs
updated in the same change, issues closed in the same motion.

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
