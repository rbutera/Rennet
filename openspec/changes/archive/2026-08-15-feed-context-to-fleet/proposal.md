# Feed the assembled context to the fleet

## Why

`wire-context-knowledge-layer` (#15 + #30, merged c95da3e) built a deterministic, byte-budgeted context assembly (`assembleContext`), a `ContextManifest` that records it (per-doc order/hash/bytes/truncation + `assembledPromptDigest`), R55 persistence, and an inspector panel. The dual review of that change proved the punchline: **the assembly is built and then discarded.** No fleet turn consumes it — the seats get their seat prompts plus whatever the harness reads ambiently, and the byte-budgeted assembly is recorded, not sent. That is why the panel had to be relabelled from "what was sent" to "Context Rennet assembled." This change closes the loop: the assembly becomes what is literally sent, and the manifest becomes the real send-transcript.

## What Changes

- **The feed.** The deterministic assembly is threaded into every fleet turn's actual prompt via the already-existing but never-fed `context` layer of `assemblePrompt` (`packages/instructions`): the pipeline seats (hypothesis, decomposition, ordering, narration via `buildReviewCanvases`), the desktop-composed seats (finding — both dual seats, noise, decisions), and the orchestrator turn (appended after the primer in `systemPrompt.append`). Every seat receives the SAME shared assembly, so the dual-seat reconcile stays apples-to-apples. An absent assembly leaves each prompt byte-identical to today — the feed never gates a turn (Rule Zero).
- **The send-transcript.** Send-time capture at the one wire seam every harness passes through (the `runTurn(prompt, attempt)` boundary, plus the orchestrator's system-append): each send stamps a `ContextSendRecord` — seat, harness, channel, attempt, prompt bytes + digest, and whether/which context block the sent bytes actually contained (extracted from the sent text by Rennet's own deterministic layer framing, never trusted from intent). Records are appended to the persisted `ContextManifest`, making it the transcript of what was sent, per agent, with per-agent variance visible.
- **Assembly text persistence.** The capture-once store gains the assembled TEXT next to the manifest (digest-verified on load against `assembledPromptDigest`), so the send path feeds the exact recorded bytes rather than trusting a re-read of mutable guidance.
- **Honest relabel, precisely scoped.** With ≥1 send record proving the assembly was sent (context digest == `assembledPromptDigest`), the panel may say the context was SENT to those seats — and only for that portion. `exhaustive` stays `false` and `unmanagedSources` keeps disclosing the harness's ambient reads (the spawned `claude` still reads CLAUDE.md itself; the manifest never claims to cover that).
- **Protocol/Zod.** The additive optional `sends` field on `ContextManifest` is declared in `@rennet/protocol`'s `contextManifestSchema` — the strict IPC output would silently strip an undeclared field.

## Capabilities

### New Capabilities

- `fleet-context-feed`: the assembled, byte-budgeted context reaches every fleet agent's real prompt (seat `context` layer / orchestrator system-append), deterministically, shared across seats, never gating a turn.
- `context-send-transcript`: send-time capture of what each agent was handed, per-agent send records persisted on the `ContextManifest`, and the panel's honest "assembled" → "sent" label move scoped to what was provably sent.

### Modified Capabilities

None in `openspec/specs/` — the `wire-context-knowledge-layer` capability spec lives only in the archive, and its requirements ("a ContextManifest is recorded and persisted", "the panel shows the truth") are preserved, not weakened: this change extends the manifest additively and tightens the panel's claim.

## Impact

- **`packages/types`** — additive: `ContextSendRecord`, optional `ContextManifest.sends`.
- **`packages/protocol`** — `contextManifestSchema` gains the `sends` schema (IPC would strip it otherwise).
- **`packages/instructions`** — no structural change: the `context` layer slot already exists in `PROMPT_LAYER_ORDER`; it finally gets fed.
- **`packages/core`** — seat runners (`angle-generation`, `ordering-pass`, `finding-generation`, `noise-generation`, `decision-generation`, `hypothesis-generation`, `rollup-narration`) gain an optional `assembledContext` input mapped to the `context` layer; `pipeline.ts` threads it; a new wire-seam wrapper (sibling of `guardSeatTurn`) records sends.
- **`packages/adapters`** — `ContextManifestStore` persists/verifies the assembly text and appends send records; `live-review-backend.ts` capture path extended; `orchestrator-turn.ts` appends the context block and records its send.
- **`apps/desktop`** — the composition root threads the verified assembly text into all seat call sites and the orchestrator, wires the send sinks, and persists the records.
- **`packages/ui`** — `context-manifest-panel` renders send records and switches its label only on proof.
- **Out of scope (deferred):** per-agent context TAILORING beyond one shared assembly; eliminating the harness's ambient reads / the §7.2 immutable-materialisation deviation (stays disclosed via `unmanagedSources`, unchanged); the isolation probe that could ever set `exhaustive: true`; widening the gather set (`.rennet/`, knowledge docs) beyond what #312 assembles.
