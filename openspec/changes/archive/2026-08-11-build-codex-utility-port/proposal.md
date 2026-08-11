## Why

The Model Council (#69) NAMES a Codex seat — `providerHarness(model)` maps every `gpt-5.6-*` model to the `codex` harness — but nothing executes it. With both harnesses installed, Table 1 routes the whole light tier (chunk titles, claim extraction, noise narration, publish prose, disposition triage, inferred test mapping, dedupe, …) onto Luna/Terra, which on a subscription account is `$0` metered. Today that routing resolves to a seat with no body: the light-tier volume has nowhere to go but the heavy Claude review path, spending Opus/Sonnet quota on "summarise these forty lines as one sentence".

A go/no-go spike on 2026-08-07 proved the seat is real: a `gpt-5.6-luna` structured-output `codex exec` call produced a schema-valid RSP `ordering` body that PASSED the real `validateDocument` on the first try — 4.6s, `$0` metered (ChatGPT subscription). schema-out → validator-in → admitted, round-trip proven end to end. This slice productionises that behind the seat boundary the council left clean.

## What Changes

- Add `packages/core/src/codex-utility-port.ts`: the `CodexUtilityPort` — a node-free orchestration that takes an injected `CodexExecutor` (the seat boundary), derives the output JSON schema from the docType (`bodyJsonSchema`), stamps a trustworthy RSP envelope around the executor's body (`tier: "light"`, `route: "utility"`, the resolved `model`, a real `computeInputDigest`, `modelReportedBy: "config"`, a capability snapshot carrying `structuredOutput` + `perCallModelSelection`), runs the deterministic `validateDocument`, and on rejection retries with the machine-readable report fed back (≤2 retries, three attempts total). A rejected document is NEVER admitted blind: the port returns `status: "admitted"` only inside the `report.admitted` branch, else `status: "rejected"` (fail closed) or `status: "exec-failed"`.
- Add `packages/adapters/src/codex-exec.ts`: the real `CodexExecutor` that shells `codex exec` with structured output, plus `buildCodexExecArgs` (pure, unit-tested argv assembly) and `createCodexUtilityAdapter` (composition root wiring the real executor into the core port). All four load-bearing gotchas from the spike are baked in: `--ignore-user-config` (skip the heavy `~/.codex` config that otherwise stalls), stdin closed (`stdin: "ignore"` — else it waits on stdin and hangs), `--skip-git-repo-check` (utility calls run in a scratch cwd), and `-o <file>` (capture the final structured message cleanly instead of parsing the JSONL stream).
- Add a GATED real-turn proof (`packages/adapters/src/codex-utility-port.real.test.ts`, `it.skipIf(!RENNET_LIVE_CODEX)`) that drives ONE real `gpt-5.6-luna` `codex exec` to a validator-admitted `ordering` document on the user's subscription — no metered spend, skipped in the normal gate.

## Capabilities

### New Capabilities

- `codex-utility-port`: the first alternate model seat. Routes light-tier RSP document emission onto cheap Codex models (`gpt-5.6-luna` low by default) at `$0` metered, behind a clean executor boundary; stamps `tier: light` / `route: utility` provenance and admits only validator-passed documents, retrying then failing closed on rejection.

## Impact

- Adds `packages/core/src/codex-utility-port.ts` (re-exported, colocated-tested) and `packages/adapters/src/codex-exec.ts` (re-exported, colocated-tested) + one gated real-turn test. No change to existing modules' behaviour.
- No new external dependency: the real executor uses the existing `execa` (already an `@rennet/adapters` dep) and `node:fs`/`node:os`/`node:path`. The architecture and licenses gates are untouched (core stays node-free — the spawn lives in adapters, injected; `@rennet/adapters` already depends on `@rennet/core`/`@rennet/protocol`/`@rennet/types`).
- Out of scope (the follow-on `workspace-sglle`): rewiring the live pipeline resolver so a resolved Codex seat actually executes through this port. This slice delivers the PORT + its gated real proof; the council resolver already NAMES the seat, so the follow-on attaches without a core change here.
