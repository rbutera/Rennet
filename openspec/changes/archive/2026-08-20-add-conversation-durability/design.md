## Context

Today `review.ask` is a single blocking call: `apps/desktop/src/main/review-ask-live.ts` awaits an entire orchestrator/Codex turn and returns a finished `AskAnswer`, which dispatch hands back to the renderer, which appends it via `answerInThread`. Nothing streams, nothing persists, and no harness child PID is tracked. The conversation model (`packages/app-ui/src/canvas/conversation.ts`) is pure and UI-layer; its own comment already promises the durable shape ("live streaming appends completed messages of exactly this shape — the coalesced token deltas are never persisted, only the one durable message on completion") and names the seam (`answerInThread`).

The tree already has the pieces this builds on: a store pattern (`sqlite-review-store.ts`, `file-*-store.ts` in `packages/adapters`), harness spawns behind injected effects (`codex-exec.ts`, the claude turn runners), harness-version discovery (`harness-discovery.ts`), and the app lifecycle hook (`index.ts` `before-quit`). #36 made anchor identity structurally collision-proof (`lineAnchorKey`/`rangeAnchorKey`/`chunkAnchorKey`/`fragmentAnchorKey`); orphan detection keys off that identity rather than inventing a second one.

The governing constraint is that **the whole feature is only observable in the failure case** — a happy-path suite passes against an implementation that leaks processes and loses threads. So the design's first principle is: every OS-level interruption is behind an **injected seam**, so each failure case is unit-provable without a real Electron process or a real harness spawn.

## Goals / Non-Goals

**Goals:**
- Token streaming (main→renderer) coalesced under an injected clock into one live message; two channels stream independently.
- Thread persistence (anchor, messages, `harnessVersionAtCreation`, per-turn status) extending the existing store pattern.
- Live re-attach when main survives a renderer reload; interrupted-turn surface when main was killed.
- Thread-orphan surfacing keyed on #36's structural anchor identity — never a silent drop, never a silent re-anchor.
- Scoped child-PID reaping on quit.
- The #36 privacy law preserved and re-proven at the persistence boundary.

**Non-Goals:**
- Literal re-attachment to a harness OS process that died with main. When main dies the child is reaped or already gone; the honest outcome is an interrupted-turn surface, not a resurrected stream. (Rule Zero: no robustness for robustness' sake — faking a resurrected stream would be exactly that.)
- A new persistence engine. The thread store follows the existing sqlite/file store shape.
- Cross-machine or multi-window shared streams. One main, one in-flight registry.
- Rewriting the #139 ask router or the #36 anchoring facet. This is additive around them.

## Decisions

**1. Streaming contract: delta / done / interrupted, per channel.** `review.ask` becomes a stream in the protocol: `{ threadId, turnId, channel, delta }` token events, then a terminal `{ threadId, turnId, channel, done, finalBody }` OR `{ threadId, turnId, channel, interrupted }`. `turnId` binds every event to the exact turn (so a re-attach or a late delta from a superseded turn cannot cross-contaminate). The renderer coalesces deltas per `(turnId, channel)` into one live message and, on `done`, commits exactly one durable `ThreadMessage` via `answerInThread` — no model shape change. Zod schemas are hand-written in `packages/protocol`; the new fields are optional and therefore NOT build-protected, so each is added deliberately and each has a schema-round-trip test.

**2. The coalescer is pure and clock-injected.** A `StreamCoalescer` in `packages/app-ui` (layer:ui, `@rennet/types` only) folds a delta sequence into a body under an injected `now()`/scheduler, so tests advance the clock by hand and assert byte-identical output. The wall-clock throttle (how often the live body repaints) is a parameter, not a hard-coded interval — it changes repaint cadence, never final content.

**3. Persistence extends the store pattern; only completed messages persist.** A `ThreadStore` (sqlite or file, mirroring `sqlite-review-store.ts`) holds `PersistedThread = { thread, harnessVersionAtCreation, turns: TurnRecord[] }` where `TurnRecord.status ∈ {streaming, complete, interrupted}`. A `streaming` record carries no body. On store open, any record left `streaming` is read as `interrupted` — the crash-recovery rule is a read-time transform, so a process that died cannot leave a `streaming` record that reads as live. The store is injected into dispatch so persistence is unit-tested against an in-memory fake.

**4. Re-attach has two honest branches, decided by whether main lived.** In-flight turns live in a main-side `LiveTurnRegistry` keyed by `turnId`. (a) Renderer reload, main alive → renderer calls a `review.reattach` handler, gets the set of in-flight `turnId`s, and re-subscribes; the same coalesced message resumes (dedup on `turnId`, never on anchor key — same discipline as #36's occurrence-id dedup). (b) Main killed → the registry is empty on restart; the store's `streaming`→`interrupted` transform is the only source of truth, and the thread renders with an interrupted turn. There is no code path that turns a `streaming` record into a `complete` one without a real `done` event.

**5. Two distinct "orphan" concepts, both handled, never conflated.** *Process orphans* = leaked harness children → the `ProcessRegistry` (decision 6). *Thread orphans* = a persisted thread whose anchor no longer resolves → an `AnchorResolver` (injected: given an anchor key + the current diff, does it still resolve?) run on re-attach. An unresolved thread is stamped `orphaned` and surfaced; the resolver is NEVER allowed to substitute a different key. Refusing re-anchor is the same failure class as a wrong disposition carry (a human's words on code they never wrote them about), so the model exposes only "resolves / does not resolve", with no "nearest match" affordance to misuse.

**6. Scoped reaping via a ProcessRegistry.** Every harness spawn (`codex-exec.ts`, the claude runners) registers its `ChildProcess` (or PID) with an injected `ProcessRegistry` at spawn, and deregisters on natural exit. `before-quit` calls `registry.reapAll()`, which signals exactly the tracked, still-live PIDs — no name-based blanket `pkill`. The registry's kill/list effects are injected, so a test registers fake PIDs, quits, and asserts precisely those and no others were signalled (including a negative control: an unregistered same-named process is untouched).

**7. Privacy is re-proven at the persistence boundary.** `threadContentForPublish` stays structurally empty and `promoteMessage` stays the sole egress. The new proof persists a thread with a distinctive canary body, does NOT mount it, triggers a publish, and asserts the canary is absent from both the payload and the paper — the seam the #36 DOM-corpus scan structurally cannot see (an unmounted thread has no DOM). Comparison is against structured payload values, not a serialisation (the #36 lesson: a needle valid on the input is invalid on transformed output).

## Risks / Trade-offs

- **The failure cases are the product, and they are the hard ones to test.** Mitigation: the injected seams (clock, store, ProcessRegistry, AnchorResolver, LiveTurnRegistry) make each failure a deterministic unit test — kill = "clear the registry and reopen the store", crash-mid-stream = "emit deltas, then reopen without a `done`". Each interruption test red-proofs by removing the specific guard (e.g. delete the `streaming`→`interrupted` transform and watch the interrupted-turn test fabricate a completion).
- **A late delta from a superseded turn could cross-write another turn's message.** Mitigation: every event carries `turnId`; the coalescer and the renderer index by `turnId`, so a stray delta with an unknown/closed `turnId` is dropped, not applied.
- **Reaping could over-kill (blanket pkill) or under-kill (miss a grandchild).** Trade-off: we scope to tracked direct children by PID; a harness that forks its own grandchildren is out of scope for v1 and named as such. Over-kill is refused structurally (only registered PIDs are signalled); under-kill of a grandchild is disclosed, not silently claimed covered.
- **Persistence could become a second publish path.** Mitigation: decision 7's unmounted-canary proof is the guard; it lives in the change and red-proofs by routing a persisted body into the payload and watching it fire.
- **Streaming touches `review.ask`, which #139 owns.** Trade-off: the router's law ("orchestrator once, both adds Codex, never a synthesis") is untouched — streaming changes the transport (one response → many events), not the routing. The two-channel independence requirement is the streaming-side restatement of that law.

## Verified during build (2026-08-12) — the three load-bearing substrate facts

These were confirmed against the tree before wiring, so a later reader (or reviewer) does not re-derive them:

- **Streaming is real, not theatre.** `claude-adapter.ts:324` already decodes `content_block_delta`/`text_delta` frames into a `text.delta` event, and `orchestrator-turn.ts` already receives them in its `for await` loop — it just DROPS them (it handles `text.message`/`session.ended`, no `text.delta` case). So streaming is: add an optional `onDelta(text)` hook to `OrchestratorTurnDeps` and emit `text.delta` through it. The tokens already flow; nothing is faked.
- **Reaping is by AbortController, not pkill.** `OrchestratorTurnDeps.abortController` (orchestrator-turn.ts:200) and codex-exec's `run` `cancelSignal` (codex-exec.ts) are BOTH already wired cancellation seams. Scoped reaping is therefore: the `LiveTurnRegistry` holds each in-flight turn's AbortController and aborts them all on `before-quit`. No PID scan, no name-based `pkill`, no over-kill risk. PID tracking (codex, via `execa`'s `.pid`) is a *backstop* only.
- **The claude child PID is NOT reachable through the SDK.** The narrowed `SdkQuery` surface is `(params) => Query` (an async iterable); the agent SDK manages its `claude` child internally and exposes no handle/PID. So the codex child is PID-killable as a backstop but the claude child is only reachable via its AbortController. **A claude child that survives an abort is the one disclosed residual gap** (same family as "harness grandchildren out of scope") — it is named, not silently claimed covered.

## Build status at hand-off (see the report to the orchestrator)

§1 (pure model: turn lifecycle, orphaned flag, clock-injected coalescer) and §2 (protocol: streamed `review.ask` contract, persisted-thread wire shapes, `review.reattach`, `onAskStream`) are IMPLEMENTED, unit-tested, and red-proofed. §3–§8 (persistence store + wiring, streaming live-seat, reaping, renderer surfaces, privacy proof) are the remaining vertical, sequenced in `tasks.md`; the substrate facts above de-risk them.
