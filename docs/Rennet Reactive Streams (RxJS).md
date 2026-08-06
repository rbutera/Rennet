---
tags: [rennet, architecture, streams, dataflow]
categories: [project]
status: active
created: 2026-08-06
updated: 2026-08-06
related: ["[[Rennet Contracts and Rulings]]", "[[Rennet Dependency Standard]]", "[[Rennet Canvas Paradigm]]", "[[Rennet Orchestrator Context Access]]", "[[Rennet Architecture Contracts]]"]
---

# Rennet Reactive Streams (RxJS)

*Design analysis, 2026-08-06. Responds to Rai's dispatch: think hard about the RxJS / reactive-streams model and figure out IF and WHERE it should slot into Rennet — possibly fundamentally, in a lot of places — then adjust issues, plans, and docs. Analysed against the live code on `main` (foldReview, the harness port, the Claude adapter/composition root) and the adopted designs (canvas paradigm, orchestrator context access, comment-refinement loop). Ruling recorded as R35 in [[Rennet Contracts and Rulings]]; the dependency verdict is mirrored in [[Rennet Dependency Standard]] §5/§8.*

---

## Verdict up front

**RxJS does not enter Rennet — not as a spine, not as a utility. No candidate site survives the analysis.** This is not "RxJS is bad"; it is that Rennet's architecture already contains a deliberate, contract-backed answer to every problem RxJS solves, and each answer is *stronger in the property Rennet actually needs* than an Observable graph would be:

| Problem RxJS solves | Rennet's ratified answer | Why it beats an Observable graph here |
|---|---|---|
| Deriving state from a sequence of events over time (`scan`) | **The event-sourced core**: `foldReview` + append-only store + disposable projections (R17) | The fold IS `scan`, made **durable and replayable**. An Rx pipeline is ephemeral runtime dataflow — state living in operator closures cannot be rebuilt from the log, audited, or upcast. |
| Consuming an async producer with cancellation | **`AsyncIterable` at the harness port** (`HarnessSession.events`) + AbortController | Pull-based, so backpressure is intrinsic (the consumer's `for await` IS the demand signal); native to the Claude SDK's `query()`; zero-dependency at the node-free protocol seam. Rx is push-based — backpressure has to be re-added by hand. |
| Fan-out of live state to many observers | **The post-commit change feed** (§4 below) → typed IPC subscriptions carrying **recipient-specific projections** (R19) | Every fan-out consumer sits across a process or protocol boundary (renderer IPC, orchestrator context stream, future mobile). Observables do not cross boundaries; the discrete, seq-ordered event is the wire format regardless, so the in-process Observable layer would be pure overhead. |
| Time-based coalescing (debounce, buffer, throttle) | **Small hand-rolled batchers with injected clocks** (chokidar debounce; the ~16ms delta coalescer in #36; the deixis batcher in #13) | Each instance is ~20–30 lines, deterministic under `ClockPort` fakes, and testable with the same idiom as everything else. A dependency + a second testing idiom (marble tests) to replace three tiny functions is a bad trade. |
| Concurrency limiting and task orchestration | **`p-queue`** (ratified MUST) + `RoutePlan` budget gate (R10) | Fleet work is task-shaped (assemble → drive → validate → retry), not stream-shaped. Budgets are a product contract with a CI test, not an operator chain. |

**What Rennet DOES adopt from the reactive model is the discipline, as named principles (§3): explicit subscription lifecycle, a stated backpressure/coalescing policy at every push seam, seq-ordered single-source delivery, and one named change feed instead of ad-hoc listener soup.** The library is refused; the rigor it institutionalises is kept and written into the contracts.

---

## 1. Site-by-site analysis

Each candidate site Rai named, plus two he didn't, with a verdict and the reason. "Adopt / don't / defer" — all six are **don't**, for six *different* reasons, which is itself the finding: there is no common stream-shaped spine hiding in Rennet waiting for a framework.

### 1.1 The event-sourced core (`foldReview` over the disposition event log) — **NO, categorically**

This is the site where "fundamentally, in a lot of places" would live if it lived anywhere, so it gets the full argument.

`foldReview` (packages/core/src/index.ts) is literally the reactive `scan` operator: `(Review | null, ReviewEvent) → Review`. What the event-sourced architecture adds over Rx's `scan` is exactly the set of properties the frozen contracts demand:

- **Durability + replay** (R17, issue #31): replay-from-zero must equal incremental fold, property-tested. An Rx pipeline's accumulated state lives in operator closures and dies with the process; there is nothing to replay, upcast, or golden-stream.
- **Determinism**: same events → same state, byte-identical, under injected `ClockPort`/`RandomPort`. Rx schedulers are a second clock the replay harness would have to fake.
- **Auditability**: the store is the truth; projections are disposable. An Observable graph between the store and its consumers would be a **second, non-replayable dataflow truth** — precisely the failure class the Dependency Standard already bans in other costumes ("AVOID generic event-sourcing frameworks, XState, Immer… they duplicate or obscure the event log, projections, idempotency").
- **Single-writer transactionality** (R17, #31): projections fold forward **inside the append transaction**. Rx is fire-and-forget push; a subscriber erroring or lagging mid-transaction has no defined meaning.

Wrapping the fold in Observables would re-express working code in a vocabulary that surrenders its strongest properties. T3 Code's independently-converged spine (command → receipt → pure decider → one SQL transaction → projector, [[T3 Code Integration Research]]) is corroborating evidence: a production event-sourced TypeScript app at 100k users, and no Rx anywhere in that loop either.

### 1.2 The harness / Claude SDK query stream (`packages/adapters`) — **NO; `AsyncIterable` is codified as the port primitive**

`HarnessSession.events: AsyncIterable<HarnessEvent>` is already the right primitive, for four reasons that are properties of the seam, not taste:

1. **Backpressure is intrinsic.** The consumer's `for await` loop is the demand signal; the SDK subprocess's stdout pipe blocks upstream naturally. Rx is push: a slow consumer means unbounded buffering unless backpressure machinery is added back by hand — machinery `AsyncIterable` gets for free.
2. **Single consumer by contract.** The port says "one stream for the session's whole life; subscribe once." Multicast — the one thing Observables add over async iterators — is explicitly not wanted at this seam. Fan-out of harness activity to the UI happens *after* normalization, through the change feed (§4), as discrete events.
3. **The seam is node-free and dependency-free by design** (`packages/core/src/harness.ts` — "no `node:*`, no filesystem, no process", so a mobile or third-party client can import it). `AsyncIterable` is a language feature; `Observable` is a library type. Putting `rxjs` into the one protocol surface third parties import would be the most expensive possible placement.
4. **It is SDK-native.** `query()` returns an async iterable; the adapter's normalization (`normalizeClaudeFrame`) is a pure function mapped over it. Codex and omp adapters (#25, #26) follow the same shape. Conformance tests iterate; no scheduler involved.

Cancellation is `AbortController`, threaded end-to-end already (session → SDK → subprocess kill). Rx's unsubscribe adds nothing the abort signal doesn't do.

### 1.3 Canvas live state + canvasOps — **NO to Rx; the real need is the change feed (§4)**

This is the strongest steelman site: canvases are live, multiple parties observe them (renderer, orchestrator, future mobile), and the context-update stream (Canvas Paradigm §3.2) is even *called* a stream. But look at where every observer sits:

- The **renderer** is across the Electron IPC boundary (R19/R20: `ui` imports `protocol` + `types` only; the renderer reaches the engine exclusively through the IPC command map).
- The **orchestrator** is across the MCP tool/notification boundary (in-process server, but a protocol surface with versioned schemas — `canvasOps@2`).
- The **mobile client** is across a transport-neutral wire protocol with "recipient-specific projections, never raw `EventEnvelope`s" (R19).

**Observables do not cross any of these boundaries.** Every stream leaving `core` is chopped into discrete, ordered, schema-validated events at the boundary regardless. So an in-process Observable layer would exist only between the event store and the boundary emitters — a distance of one function call. What that gap actually needs is a *named subscription contract* (what changed, in what order, coalesced how), which is §4. The canvas state itself stays what the paradigm doc says it is: an event-sourced projection, rebuildable from the store, governed by R17/R28/R29/R8.

### 1.4 Angle generation / the fleet (`packages/core/src/angle-generation.ts`, `route-plan.ts`) — **NO; task-shaped, not stream-shaped**

`runDecompositionAngle` is assemble-prompt → drive model → validate → retry ≤2 → fallback-to-floor. That is a task with a lifecycle, not a stream: it has a beginning, a budget, and exactly one admitted-or-refused outcome. The concurrency story is bounded queues (`p-queue`, ratified) and the `RoutePlan` Brita filter (≤5 invocations, refuses before any model runs — R10). Expressing this as `mergeMap` with a concurrency argument would trade a CI-tested product budget for an operator parameter. The fleet's *outputs* are RSP documents admitted by the validator — the admission event then flows through the same change feed as everything else.

### 1.5 Live review state → UI — **NO; the ratified renderer stack already occupies this ground**

The renderer stack is React 19 + TanStack Query ("IPC query lifecycle and invalidation") + zustand ("ephemeral view state") + `useSyncExternalStore` for push-subscription — all ratified MUST rows in [[Rennet Dependency Standard]] §8. The wiring for live updates is: change feed event arrives over IPC → targeted TanStack invalidation (or direct cache write for hot paths like text deltas) → React renders. Rx-in-React is a known impedance mismatch (subscription lifecycles fighting hooks, tearing under concurrent rendering unless bridged through `useSyncExternalStore` anyway — at which point the Observable was scaffolding around the thing React actually consumes). Adding Rx here would fight the ratified stack without displacing any of it.

The one genuinely streaming UI element — token deltas into the diff chat — is already correctly specified in #36: **coalesce ~16ms straight to the renderer, never persisted; one `thread.messageAdded` event on completion; mid-stream crash loses only the partial answer.** That is a rAF-ish batcher, ~20 lines, deterministic under a fake clock.

### 1.6 The comment-refinement loop — **NO; it is a lifecycle, and lifecycles are events + projections here**

The refinement design ([[Rennet Comment Refinement Loop]]) is a state machine on the disposition (raw → refining → refined / needs-clarification → adjudicated → published), with the refiner as a background light-tier fleet task and adjudication as a user act. Every transition is a domain event the store must remember (the publish sheet and the degradation ledger depend on that history); the "background, non-blocking, always-on" property is queue scheduling, not stream plumbing. Modelling the lifecycle as an Observable chain would put review-state truth into runtime operator state — the §1.1 failure again, at the exact spot where user sovereignty (L2) makes a lost or duplicated transition most expensive.

### 1.7 (Unprompted) Filesystem watching and freshness — **NO**

`chokidar` (debounced recapture hints; "Git decides patchset truth") and freshness verdicts (R30: evaluated at use time, stale never consumed silently) are both *poll-at-the-authority* designs, deliberately. A reactive freshness graph (`combineLatest` of member-repo snapshot states → workspace freshness) would compute liveness the contracts define as a **read-time conjunction** — the freshness verdict belongs to the moment of use, not to a hot signal that can itself go stale.

---

## 2. The steelman, taken seriously

Because the dispatch said "possibly fundamentally," the strongest pro-RxJS argument deserves a fair hearing before the refusal:

**"Rennet is a soft-realtime cockpit: fleet activity, harness output, user acts, staleness, and orchestrator annotations all flow concurrently into one UI. That is the textbook Rx application."** True as a description; wrong as a prescription, because of one architectural fact: **in Rennet, every one of those flows must pass through the event store or a process boundary to reach its consumers.** The store is where flows become durable and replayable; the boundaries are where they become discrete schema-validated events. Rx earns its keep in systems where the operator graph IS the architecture — where merging, windowing, and switching happen in one process, in memory, with nothing needing to be replayed later. Rennet deliberately has no such place: the middle of the system is a transaction log, not a dataflow graph. What remains for Rx are the *edges* (a debounce here, a coalescer there) — and three 20-line functions do not justify a paradigm, a bundle, and a second testing idiom.

**"But switchMap-style cancellation would clean up recompute/refresh races."** Cancellation-of-the-superseded is genuinely needed (recapture during regeneration, `canvas.recompute` racing an edit) — and it is already contract-shaped, not operator-shaped: R28 (a new patchset never rewrites the active one), R29 (invalidation marks, regeneration explicit), and command receipts/idempotency handle supersession *in the durable state*, where it must live to survive a crash mid-race. `AbortController` handles the in-flight subprocess. An Rx `switchMap` would cancel the *subscription* while leaving the durable race exactly as it is.

**"Effect's Stream / T3's spine?"** Settled separately: own core, mine T3's parts (Contracts and Rulings §2.2). Adopting a streams runtime as a side effect of a library choice would be the T3 X-axis decision smuggled in through the dependency door.

---

## 3. What Rennet adopts FROM the reactive model (the discipline, not the library)

These four principles are the true content of "reactive streams," and Rennet takes them as **contract language**:

1. **Explicit subscription lifecycle.** Every push subscription (IPC channel, MCP notification stream, `useSyncExternalStore` binding) has a stated owner, a disposal point (unmount, session end, review close), and a leak test. No fire-and-forget listeners.
2. **A named backpressure/coalescing policy at every push seam.** Pull (`AsyncIterable`) wherever there is one consumer; where push is unavoidable (change feed → renderer, context-update stream → orchestrator), the seam states its policy: bounded buffer + **coalesce-by-key** (later event for the same key replaces earlier) or **conflate-to-latest**, never unbounded queueing, and *never drop-silently* — a coalesced delivery still says what range it covers (the never-silent-caps doctrine of canvasOps@2, applied to the push direction).
3. **Ordered, single-source delivery.** One monotonic order per feed (the store's commit order; the adapter's `seq`), assigned at the source, never inferred from arrival time. Consumers may coalesce but never reorder.
4. **One change feed, not listener soup.** Fan-out happens at exactly one named object per process (§4), so "who observes review state, and with what projection" is enumerable — the same structural-enforcement instinct as the four-actor canvas contract.

---

## 4. The one new named object: the review change feed

The analysis surfaced exactly one genuinely missing stream-shaped object, and it should be built **without RxJS**: the **post-commit change feed** — the single multicast point where committed events become notifications for live consumers.

```
store.commit(events) succeeds
  → changeFeed.publish({ reviewId, patchsetId, seq range, changed: [{kind, key}...] })
      → IPC subscription: recipient-specific projection deltas → renderer
          (drives targeted TanStack invalidation / direct cache writes)
      → orchestrator context-update stream (Canvas Paradigm §3.2):
          {selected}/{disposed}/{proposal-adjudicated}/{viewing}, deixis batched
      → (LATER) mobile subscription over the transport-neutral protocol (R19)
```

Contract sketch (the build detail rides issues #31 and #10; this is the shape):

- **Emission point:** after the append transaction commits, in the engine utility process — the "post-commit read-model swap" moment #31 already owns. Never mid-transaction.
- **Payload:** change *summaries* keyed by `(reviewId, canvasId, elementKey)` with the covering seq range — recipient-specific projections at the boundary, never raw `EventEnvelope`s and never `private`-flagged rows (the R17 telemetry split applies to the feed by construction).
- **Ordering:** store commit order; the seq range makes gaps detectable, so a reconnecting subscriber knows to re-query rather than trust continuity (liveness by change, not presence).
- **Coalescing:** per-key conflation allowed under load; a conflated notification carries the seq range it covers. Unbounded buffering forbidden.
- **Delivery is a hint, truth is the store.** A consumer that misses notifications re-queries projections and is merely stale-then-corrected, never wrong. This is what makes the feed safe to keep simple: it is an invalidation channel, not a state channel.
- **Implementation:** a typed emitter + per-subscriber bounded buffers, in `core`, behind a port. ~100 lines with tests. No dependency.

---

## 5. Risks this ruling avoids (recorded so the refusal stays legible)

- **A second truth.** The event store's replay/upcast/audit guarantees hold only while it is the *only* stateful dataflow. Operator-graph state is invisible to the replay harness (#31's "recorded session replays to identical projections byte-for-byte" cannot see inside a closure).
- **Boundary chop.** Electron main/renderer, MCP, and the mobile protocol all force discrete serialized events; an Observable spine would be repeatedly cut and re-materialized at every boundary, keeping the ergonomic cost and losing the compositional benefit.
- **Testing idiom split.** The suite is deterministic folds + injected clocks + fast-check properties. Marble testing is a parallel idiom with its own scheduler semantics; two idioms means every seam between them is undertested.
- **React fit.** Rx-in-React ends up bridged through `useSyncExternalStore` anyway; the bridge is then the real interface and the Observables are scaffolding.
- **Dependency-standard coherence.** The standard's sharpest teeth ("AVOID XState/Immer/event-sourcing frameworks — they duplicate or obscure the event log") apply verbatim to a reactive layer over the same log. Refusing those while admitting RxJS would be the same hazard under a different name.

## 6. What would reopen this ruling

Honest triggers, so this is a falsifiable position rather than a taste:

1. A measured case where ≥3 *nontrivial* time/combination operators (windowed joins, switch-on-supersede across many concurrent sources, dynamic operator graphs) are needed **in one process on the same side of a boundary** — not counting debounce/coalesce singletons.
2. The mobile client's live-subscription layer growing genuine client-side stream composition needs (offline buffering + merge + replay on its side of the wire).
3. A ratified renderer-stack change away from TanStack Query/zustand (not expected; R34-family decisions).

Absent those, the answer stands: **the reactive model's discipline is adopted into the contracts; the library is not.**

---

*Analysis: Navi (design agent), 2026-08-06, per Rai's dispatch. Code read on `main` at `03ba363`. Ruling R35 in [[Rennet Contracts and Rulings]]; dependency rows in [[Rennet Dependency Standard]] §5/§8; issue adjustments: #10, #11, #13, #31, #36.*
