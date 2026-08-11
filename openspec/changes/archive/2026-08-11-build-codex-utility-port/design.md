# Design — CodexUtilityPort (#66)

## The seat boundary (why core + adapters, mirroring the Claude path)

The council (`packages/core/src/model-council.ts`) is pure data + pure functions and NAMES a seat via `providerHarness(model) → "codex"`. The Claude path already demonstrates the split this slice copies:

- **Orchestration in `core`, node-free, executor injected.** `runDecompositionAngle` (angle-generation.ts) takes an injected `runTurn` and owns the trustworthy work: assemble prompt, stamp the RSP envelope (mint `docId`, compute `inputDigest`), validate, retry with the report fed back. `CodexUtilityPort` is the same shape for the utility tier: it takes an injected `CodexExecutor` and owns envelope-stamp + validate + retry.
- **The real spawn in `adapters`, node-ful.** `claude-query.ts` is the one place that imports the SDK and produces the real transport. `codex-exec.ts` is the one place that spawns `codex exec` and produces the real `CodexExecutor`.

This keeps `core` importable by a mobile/third-party client (no `node:child_process` at module scope) and keeps the follow-on pipeline wiring (`workspace-sglle`) a pure composition change: resolve a Codex seat → hand this port a request.

## The executor seam

```ts
interface CodexExecRequest { model: string; effort: string; prompt: string; outputSchema?: unknown; signal?: AbortSignal }
interface CodexExecResult  { output: unknown; tokens?: RspTokenUsage; harnessVersion?: string }
type CodexExecutor = (req: CodexExecRequest) => Promise<CodexExecResult>
```

The executor is deliberately dumb: it receives an already-assembled prompt and an already-derived JSON schema, spawns one `codex exec`, and returns the parsed final structured message. All RSP knowledge (docType → schema, envelope, validation, retry) lives in the port so the executor is a thin, fakeable process boundary.

## The four load-bearing gotchas (from the spike — each one or a 2-minute hang)

1. `--ignore-user-config` — without it, `codex exec` loads the heavy `~/.codex` config (plugins/MCP/hooks) and STALLS. Also correct by design: a one-shot utility call must not inherit the user's full agent config.
2. **stdin closed** (`stdin: "ignore"`, the execa equivalent of `< /dev/null`) — else it waits on stdin and hangs.
3. `--skip-git-repo-check` — utility calls run in a scratch (non-repo) cwd.
4. `-o <file>` — capture the final structured message cleanly instead of parsing the JSONL stream.

`buildCodexExecArgs` is a pure function so the argv (and thus all four flags) is asserted in a unit test without spawning anything.

## Envelope + admission (identical trust model to the agentic path)

The executor emits ONLY the body, schema-constrained. The port builds the trustworthy envelope around it — `docId` minted by the port, `provenance` stamped, `inputDigest = computeInputDigest(patchset, manifest)` — so "agents never mint identity" is a structural property. Provenance for the codex seat: `harness: "codex"`, `tier: "light"`, `route: "utility"`, `modelReportedBy: "config"` (we set `-m`; `-o` carries only the final message, not the model), `reportedUsd`/`derivedUsd` `null` (Codex exposes no per-call USD on subscription). The capability snapshot carries `structuredOutput` and `perCallModelSelection` (V003 requires both), each earned by the exec call itself: the output is constrained via `--output-schema`, the model selected via `-m`.

`validateDocument` is the admission authority. On rejection the machine-readable report is rendered back into the next attempt's prompt (≤2 retries). The terminal states are a discriminated union so "never admits blind" is structural: `status: "admitted"` is only ever constructed inside `if (report.admitted)`; otherwise `status: "rejected"` (a real rejection report exists) or `status: "exec-failed"` (the executor never produced a document).

## Defaults

`gpt-5.6-luna` / effort `low` — Table 1's light-tier formatting default. Overridable per request (the council resolver passes the resolved model/effort in the follow-on).
