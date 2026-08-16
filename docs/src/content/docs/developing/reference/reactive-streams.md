---
title: Why Rennet does not use RxJS
description: The streaming primitives Rennet uses, why RxJS is deliberately absent, and what would justify revisiting that decision.
---

Rennet has plenty of live data, but it does not use RxJS. Durable events remain
the source of truth and harness output uses `AsyncIterable`. A small post-commit
invalidation feed is the chosen future shape, not live wiring today.

## The short version

An observable graph would create a second, in-memory account of what happened.
That is a poor fit for a review system whose important state must survive a
restart, replay deterministically, and cross Electron or protocol boundaries.

```mermaid
flowchart LR
  harness[Harness process] -->|AsyncIterable| adapter[Harness adapter]
  adapter --> command[Command handler]
  command -->|one transaction| store[(Event store)]
  store -. future .-> feed[Change feed]
  feed -. future .-> ipc[Renderer IPC]
  feed -. future .-> tools[Orchestrator tools]
  ipc --> query[TanStack Query cache]
```

When implemented, the change feed is only an invalidation hint. The event store
remains truth, and a consumer that misses a notification re-reads current state.

## Which primitive goes where

| Situation | Primitive | Why |
|---|---|---|
| Harness output | `AsyncIterable<HarnessEvent>` | Pull-based backpressure, one consumer, and a direct match for the harness SDKs. |
| Cancellation | `AbortSignal` | One cancellation path from the command down to the subprocess. |
| Durable review changes | Commands and append-only events | Replayable, transactional, and inspectable after a crash. |
| Future live UI refresh | A typed post-commit change feed | Small notifications cross IPC cleanly; consumers re-query truth. |
| Short bursts such as token deltas | A tiny coalescer under an injected clock | Keeps timing local and testable without introducing another dataflow runtime. |
| Bounded concurrent jobs | `p-queue` | Concurrency stays explicit and close to the work being scheduled. |

## The discipline Rennet does keep

The decision is not “streams are bad.” Every push seam still needs four things:

1. One owner and an explicit disposal point.
2. A named backpressure or coalescing policy.
3. Source-assigned ordering rather than arrival-time guesses.
4. One fan-out point per process instead of listener soup.

That gives Rennet the useful parts of reactive design without hiding durable
review state inside operator closures.

## The progress-narration seam

The `rennet:progress` push (main to renderer, keyed by `commandId`, typed as
`ProjectProcessEvent`) is one such live seam, and it obeys the four-point
discipline above: dispatch owns the terminal event so the stream and the
command's resolved value always agree, and the renderer folds the stream into UI
state that a re-read of durable truth can always reconstruct.

The processing slot renders through the shared narration organ (`ProgressFeed`
plus the pure `deriveProgressView` fold in `@rennet/ui`). Main deduplicates a
live `project.process` run by its stable project UUID and keeps a bounded replay
prefix, so remounting the processing consumer reattaches instead of starting a
second concurrent snapshot build. A successful repo line carries the processed
project artifact through the real consumer and opens that project; an
anchorless line stays inert.

The rest of issue #71 is not live yet. The protocol reserves strict structured
capture, deterministic-floor, and per-angle events, but the capture/review
pipeline does not emit them and its busy surface does not consume
`ProgressFeed`. The proactive-rehydration broadcast also has no renderer
listener or project-card indicator. A run epoch, completed-summary return path,
and an integration proof that runs every narrated slot with the model utility
port stubbed are still unchecked OpenSpec tasks. The pure processing fold needs
no model input, but that fact alone is not the cross-pipeline zero-model proof.

## When to revisit it

Reopen the decision if Rennet needs several non-trivial time or combination
operators on the same side of a process boundary, or if a future offline client
must merge and replay multiple live streams locally. A debounce or a second
subscriber is not enough by itself.

## Where to go next

- [Architecture overview](/developing/concepts/architecture-overview/) shows the whole runtime.
- [Architecture contracts](/developing/concepts/architecture-contracts/) defines durable state and process boundaries.
- [Harness adapters](/developing/concepts/harness-adapters/) explains the `AsyncIterable` seam.
