---
tags: [rennet, architecture, evidence]
categories: [project]
status: active
created: 2026-08-05
updated: 2026-08-05
related: ["[[Rennet Contracts and Rulings]]", "[[Rennet Architecture Contracts]]"]
source: codex
---

# Rennet Spike: Event Store and Publish Failure Injection

## Verdict

**Pass for the architectural pattern.** The minimal `node:sqlite` harness proved the required event-fold and remote-publication failure semantics. Reuse its scenarios as the seed for production property and integration tests; the spike is not production store code.

Seven tests passed:

1. Replay from zero equals incremental fold.
2. A golden v1 event chains through v2 to v3.
3. Inserting, deleting, or reordering private events produces byte-identical outbound JSON.
4. A duplicate local command returns its recorded result without emitting another event.
5. Failure before remote acceptance enters `outcome: unknown`, then retries to exactly one review.
6. Failure after remote acceptance queries by deterministic marker before retry and reconciles to exactly one review without a second submission.
7. An unknown event type fails closed instead of producing a plausible partial projection.

```text
tests 7
pass 7
fail 0
duration 45.64 ms
```

Harness: [spike.test.mjs](../spikes/event-store-publish-failure/spike.test.mjs).

## Consequence

Keep the prepare, sign, unknown, query, and reconcile publication state machine. Record command receipts atomically with local events. Never retry an ambiguous remote mutation until marker-based read-back proves absence. Unknown event types preserve their bytes but block projection, completion, and publication for that review.
