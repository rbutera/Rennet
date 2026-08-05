---
categories:
  - "[[Projects]]"
tags:
  - wingman
  - reviews
  - harnesses
  - licensing
created: 2026-08-04
---

# Wingman Claude-adapter conflict — Codex adjudication + protocol critique (2026-08-04)

Independent cross-model adjudication of the conflict between [[Wingman Harness Adapter Protocol]] (linked Agent SDK pointed at discovered binary) and [[Wingman Distribution and Licensing Plan]] (clean-room stdio wrapper). Codex read all three vault files directly and verified Anthropic licence/CLI claims against live sources.

## Verdict

**Plan A wins; Plan B (linked SDK) is retired.** Rennet must not link `@anthropic-ai/claude-agent-sdk` into the AGPL app. The v1 Claude adapter spawns the user's installed `claude` in documented print mode, **process-per-turn with persisted session IDs** (not the less-documented long-lived streaming-input control protocol):

`claude -p --output-format stream-json --include-partial-messages --resume <id> --fork-session --append-system-prompt --json-schema`, restrictive `--allowedTools`/`--permission-mode`, SIGTERM to cancel. Tolerant runtime decoders, preserve unknown frames, small supported-version matrix. Never import the SDK, copy its types, or reproduce its private control protocol.

Licence reasoning sharpened: "all rights reserved" ≠ unusable — Anthropic's commercial terms grant use, but not the redistribute/modify/sublicense/corresponding-source rights an AGPL combination requires. System-library exception: no. Mere aggregation: no for in-process import (FSF: intimate in-process communication = one program; fork/exec + pipes is the stronger separation). §13 does not cure incompatible combinations.

**Second, independent legal issue (needs a WRITTEN Anthropic answer before public release):** Anthropic's credential policy says third-party products may not route Free/Pro/Max credentials on behalf of users. Rennet invokes the user's own installed CLI and never touches credentials, so classification is unclear — but close enough to the prohibited fact pattern to ask. Applies whether SDK or CLI. → P0 bead, Rai-adjacent action.

SDK capability table: the SDK is substantially more than 40 lines (typed parsing, control plane, canUseTool callbacks, hooks). Rennet needs only a subset, all available via public CLI. **Largest real loss: per-tool `canUseTool` callback** — mitigate with static read-only tool policy (allow read/search, deny writes/exec); Rennet's real gate is publish, which it owns. Budget hundreds of lines of tolerant Zod decoders, not 40.

Protocol stability: `claude -p` is public/documented ("the Agent SDK via the CLI"); stream-json OUTPUT documented but moderately stable; stream-json INPUT semi-private — defer; SDK-only control methods — do not reverse-engineer.

## Protocol critique (adopt in synthesis)

1. **Capability flags: three layers, not one boolean** — `implementedByAdapter` / `advertisedByHarness` / `availableInSession`. A CI-proven flag can still fail per-session (org-forced interactive MCP tool with no callback path → UI offers an approval it can't service). Spike: stress `canGateToolCalls` across permission modes, org ask-rule, cancel-while-pending, unsupported binary.
2. **`harness-degenerate` as utility default REJECTED.** 3,000-line PR → 400 labeling calls → 400 CLI processes loading config/hooks/MCP, startup dominating inference, hooks side-effecting 400×, credit burn. Fix: deterministic local code for non-semantic work → batched utility prompts per meaningful unit → optional direct-API port → never process-per-hunk. Hard product budget: <15s to first useful chunk, <5 harness invocations for initial decomposition. Spike: same large diff through per-request / batch-10 / batch-50 / whole-diff.
3. **N=3 disagreement redesigned.** N=3 is a trigger, not a noise floor. Failures: omission ≠ rejection (use `notEmittedBy`, never `rejectedBy`, for silence); claim-matching can merge opposite-polarity claims; 3 forks from one primed session are correlated, not independent. Real pipeline: independent generation → claim canonicalization with explicit polarity → evidence extraction → each harness explicitly adjudicates each contested claim (supported/contradicted/insufficient) → disagreement surfaces only with code evidence on at least one side. Spike: 5 seeded diffs with known ground truth; no UI flares until explicit adjudication beats raw overlap.
4. **codex app-server: right choice, wrong justification.** Generated bindings do NOT kill version skew (initialize succeeds, first real turn hangs on unknown server-initiated request). Treat as volatile vendor protocol: implement only the consumed subset, tolerant structural decoders, fail closed on unknown server requests, approvals bound to thread/turn/request ID and invalidated on interrupt, min/max tested versions, nightly contract tests.
5. **Raw-frame persistence is a confidential-data store** once pairing/backups exist. Redact, size-limit, retention-policy unknown frames; raw capture opt-in.
6. **Ordering**: `receivedAt` + seq orders ingestion, not causality; needs a turn state machine rejecting impossible transitions (e.g. `tool.output` after logical cancellation).
7. **Error taxonomy**: keep `nativeCode`, add origin axis (`adapter`/`harness`/`provider`/`tool`/`transport`).

## Top 3 risks
1. Vendor contract/version drift (credential-terms ambiguity + semi-private input frames + experimental app-server): written Anthropic answer + two ~100-line probe clients with fixtures, rerun per release.
2. Disagreement machinery produces authoritative-looking nonsense: seeded-diff ground-truth spike first.
3. `harness-degenerate` destroys zero-config first-run: batching benchmark before `UtilityPort` semantics are defined.

Codex closing: "The two pieces that need killing are the linked Claude SDK and the claim that N=3 can distinguish 'substantive' from 'stochastic' without explicit evidence-based adjudication."
