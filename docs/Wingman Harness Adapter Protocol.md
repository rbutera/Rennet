---
tags: [rennet, architecture, harnesses]
categories: [project]
status: active
created: 2026-08-04
updated: 2026-08-05
---

# Rennet Harness Adapter Protocol

> [!IMPORTANT] Current implementation authority, 2026-08-06
> ⛔ **SUPERSEDED 2026-08-06: the Claude Agent SDK is now ADOPTED, not banned — see Master Plan R2.** The Claude adapter is an SDK integration, not the clean-room process-per-turn CLI wrapper §0.2 mandates below. The *non-SDK* guidance elsewhere in this file still stands regardless of that reversal: discover harnesses via login-shell PATH harvest (never `which`), earn capability flags through a conformance suite, keep a read-only sandbox posture, and never read or persist a harness credential.
> This note preserves the 2026-08-04 protocol research, but [[Rennet Master Plan]] and [[Rennet Architecture Contracts]] override its transport recipes. Build **Rennet**. ~~Never import or bundle the proprietary Claude Agent SDK; drive the user's installed `claude` CLI through a clean-room process-per-turn adapter.~~ (superseded, see note above — SDK adopted). Never read or persist harness credentials. Deterministic work stays local; semantic utility work is batched by meaningful unit, never process-per-hunk or per item. Capability flags start false and are earned by conformance.

The normalized event protocol and adapter layer for [[Code Review Harness App]]. The product name is Rennet; the filename is retained only to preserve existing Obsidian links.

This is the design for the `~800 lines` line item in [[References/Desktop and Mobile Stack 2026]] section 7. It turned out to be the wrong number and the wrong shape in two places; both are called out in Decisions.

**Everything below is verified against artifacts pulled on 2026-08-04.** Where something could not be verified it says UNVERIFIED in bold, and the design routes around it rather than through it.

## Verification ledger

| Claim source | What was actually read | Where |
|---|---|---|
| Claude Agent SDK | `@anthropic-ai/claude-agent-sdk@0.3.221` tarball, SHA-verified against registry `dist.shasum` (`82d3aa4a…`). `sdk.d.ts` 7,187 lines, `sdk-tools.d.ts` 3,807 lines, plus `sdk.mjs` runtime | `scratchpad/sdkverify/package/` |
| Codex protocol | Generated **from the installed binary**: `codex app-server generate-ts --out ts --experimental` → 94 root + 576 v2 `.ts` files; plus `generate-json-schema` | `scratchpad/codexverify/ts/` |
| Codex handshake | A real `initialize` round trip executed against `codex app-server --stdio` | live probe |
| Codex prose docs | `codex-rs/app-server/README.md`, 2,490 lines, via `gh api`. **`docs/app-server-protocol.md` does not exist**, it 404s | `scratchpad/codexverify/app-server-README.md` |
| Codex SDK | `@openai/codex-sdk@0.146.0` tarball, `dist/index.d.ts` 278 lines + `dist/index.js` | `scratchpad/codexverify/package/` |
| Pi / omp | npm metadata for three packages, repo metadata via `gh repo view`, installed `--help` and `.d.ts` | `scratchpad/pi-install/`, `omp-install/` |
| Local harnesses | `claude` 2.1.220, `codex-cli` 0.144.1, `~/.claude/`, `~/.codex/`, login-shell PATH probes | this machine |

Calibration notes, because a clean check that could not have failed has not passed:

- The published docs page for the Agent SDK is **stale and must not be designed against**. It lists four `PermissionMode` values (the real type has six), and names three message types (`SDKToolUseMessage`, `SDKToolResultMessage`, `SDKControlMessage`) that have **zero occurrences** in `sdk.d.ts`, against a positive control of `SDKResultMessage` → 3. `sdk.d.ts` is the only authority.
- "Codex exposes no monetary cost" is a calibrated negative: `grep -rEiwc "usd|cost|price"` across all 670 generated protocol files returns **0**, while the positive control `totalTokens` returns non-zero on the same locator. The zero is real, not a broken search. A naive case-insensitive `usd` search returns false hits inside `McpServerSt**a**tusD**etail**; word boundaries matter.
- `newConversation`, `sendUserMessage`, `interruptConversation` are **retired v1 names with 0 hits** in `ClientRequest.ts`, against `thread/start`, `turn/start`, `turn/interrupt`, `turn/steer`, `thread/resume` which all hit. Anything written against the older names is out of date.

---

## 0. The three corrections that change the plan

Read these before the types; they move real money.

### 0.1 The codex SDK is the wrong interface. Use `codex app-server`.

`@openai/codex-sdk@0.146.0` is a subprocess-per-turn wrapper that shells out to a **hidden** flag:

```js
// package/dist/index.js:174
const commandArgs = ["exec", "--experimental-json"];
```

`--experimental-json` does not appear in `codex exec --help`. The SDK spawns one child process per turn, writes the prompt to stdin, closes it, and parses JSONL off stdout.

It structurally cannot do three things Rennet needs:

1. **Approval arbitration.** There is no approval channel at all: `ThreadEvent` has no approval variant, `TurnOptions` has exactly two fields (`outputSchema`, `signal`), and there is no callback anywhere in `index.d.ts`. `codex exec` is non-interactive by construction. The human-is-the-gate trust model cannot be implemented on it at any price.
2. **Machine-readable errors.** `run()` does `throw new Error(turnFailure.message)`, flattening the structured `codexErrorInfo` union to a bare string, and dropping `willRetry` entirely. The adapter would be reduced to substring-matching English.
3. **Context-window telemetry.** `totalTokens` and `modelContextWindow` exist on app-server's `ThreadTokenUsage` and are absent from the SDK's `Usage`.

app-server is one long-lived process: JSON-RPC 2.0 over newline-delimited stdio, 125 client methods, 69 server notifications, 11 server-initiated requests. Its bindings are **generatable from whatever binary is installed**, which kills the version-skew bug class outright.

This revises the stack note's "use the official SDK rather than hand-rolling a JSON-RPC client". The SDK is not a client for this protocol; it is a client for a different, poorer one.

### 0.2 AMENDED: ship no harness binaries or proprietary harness SDKs

⛔ **SUPERSEDED 2026-08-06: this whole subsection is reversed.** The Claude Agent SDK is adopted (Master Plan R2). Rennet DOES link the SDK for the Claude adapter; it spawns the user's own installed `claude` binary and authenticates on their subscription, so the "must not link" premise below no longer holds, and the "zero compiled artifacts" framing is retired — the SDK's prebuilt per-platform binary is an accepted, budgeted packaging cost (see [[References/Desktop and Mobile Stack 2026]]).

The historical SDK audit below established why the binary must not be bundled. The later licensing adjudication goes further: **do not link the SDK at all**. Invoke the user's installed `claude` executable directly through its documented CLI surface.

The premise of the product is that the user already has these harnesses installed. Discover the installed binary and spawn it with `shell: false`; the clean-room runtime decoder owns the JSONL boundary.

That deletes the 270 MB, the asarUnpack requirement, the nested-binary notarization trap, and the last compiled artifact from the stack note's native-dependency register in one move. The whole desktop stack becomes zero compiled artifacts.

Cost: no fallback for a user with no harness installed. That is the correct trade for a BYOK product; the answer to "no harness found" is an install prompt, not a 270 MB payload every other user pays for.

The old external-binary SDK spike is retired. The relevant spike is direct CLI fidelity: `-p --resume --fork-session --json-schema`, partial-message streaming, cancellation, prompt-cache behaviour, and context isolation.

### 0.3 The oh-my-pi named in the brief is an abandoned namesake.

Two different projects share the name.

| | npm `oh-my-pi` | npm `@oh-my-pi/pi-coding-agent` |
|---|---|---|
| Repo | `acidsugarx/oh-my-pi` (**404s**; positive control `earendil-works/pi` resolves) | `can1357/oh-my-pi` |
| Version | 0.2.0, three releases inside 85 minutes on 2026-06-23, untouched since | 17.2.8, 575 versions, pushed today |
| Binary | `oh-my-pi` (**throws `SyntaxError` on every invocation**: a `.js` file containing TypeScript annotations, importing `src/` files excluded from the `files` allowlist) | `omp` |
| What it is | A **Pi in-process extension**: `peerDependencies: {"@earendil-works/pi-coding-agent": ">=0.74.0"}`, default export `(pi: ExtensionAPI) => Promise<void>`. It replaces Pi's system prompt. Never spawns anything | A fork of Pi. A real harness |

The first is not a harness and cannot be adapted, because there is nothing to drive: it has no I/O, no agentic loop, and its only executable entry point does not parse. Driving it means driving `pi`, at which point oh-my-pi silently changes the system prompt underneath.

The underlying agent is **Pi**, `@earendil-works/pi-coding-agent` (bin `pi`, MIT, maintainers `badlogic` / `mitsuhiko` / `rwachtler`), which is the badlogic/pi-mono lineage under a new org.

So the third adapter slot targets **`omp`**, with `pi` as a compatible subset. Both expose `--mode rpc` NDJSON with a typed `RpcClient`; omp adds `rpc-ui`, ACP, MCP, and approval modes that Pi lacks (Pi has **no MCP**: calibrated 0 hits for `mcpServers|modelcontextprotocol|McpServer` over Pi's own `dist/`, positive control `sessionId` → 132).

**This needs ratification.** It changes which project the third slot means.

---

## 1. The normalized protocol

Lives in `core/protocol` (per the stack note's shared-core rules: no `node:*` at module scope, so the phone can import it).

### 1.1 Identity and capability flags

```ts
export type HarnessId = 'claude-code' | 'codex' | 'omp';

/** What the harness will tell us about spend. Asymmetric across harnesses; do not paper over it. */
export type CostVisibility =
  | 'usd'     // reports monetary cost directly
  | 'tokens'  // tokens only; USD is ours to derive from our own price table
  | 'none';

export type SystemPromptSupport = 'replace' | 'append' | 'none';
export type StructuredOutputSupport = 'inline-schema' | 'schema-file' | 'prompt-only' | 'none';
export type TurnModel = 'live-session' | 'process-per-turn';

export interface HarnessCapabilities {
  /** Reattach to a prior session by id after app restart. */
  readonly canResume: boolean;
  /** Branch a new session from an existing one without mutating it. Load-bearing for §5. */
  readonly canFork: boolean;
  /** Cancel an in-flight turn while keeping the session alive. */
  readonly canInterrupt: boolean;
  /** Inject a correction into a RUNNING turn. Rare; only omp/pi have it. */
  readonly canSteer: boolean;
  /** Can WE arbitrate each tool call before it runs? False collapses the trust model to all-or-nothing. */
  readonly canGateToolCalls: boolean;
  readonly supportsSystemPrompt: SystemPromptSupport;
  readonly supportsStructuredOutput: StructuredOutputSupport;
  readonly costVisibility: CostVisibility;
  /** Token-level streaming, not just whole messages. */
  readonly supportsTextDeltas: boolean;
  /** Reasoning/thinking text is separable from answer text. */
  readonly supportsReasoningDeltas: boolean;
  readonly supportsMcp: boolean;
  /** We can choose the session id up front instead of learning it after the fact. */
  readonly canPreassignSessionId: boolean;
  /** Emits remaining context window, so we can show context pressure. */
  readonly reportsContextWindow: boolean;
  readonly turnModel: TurnModel;
  /** Retryability is signalled by the harness rather than guessed by us. */
  readonly signalsRetryable: boolean;
}

export interface HarnessDescriptor {
  readonly id: HarnessId;
  readonly displayName: string;
  readonly version: string;          // as reported by the installed binary
  readonly binaryPath: string;
  readonly capabilities: HarnessCapabilities;
  /** Version floor we have actually tested. Below this, health is 'degraded'. */
  readonly testedRange: { min: string; maxTested: string };
}
```

The UI reads `capabilities` and nothing else. No `if (harness === 'codex')` anywhere above the adapter boundary; that rule is what makes harness plurality a positioning claim rather than a maintenance tax.

### 1.2 Event envelope

```ts
/**
 * Sequence is assigned by the ADAPTER, not the harness.
 * The Claude SDK's own type says of its timestamp field:
 * "do not order messages by this field" (sdk.d.ts:2906). Trust nobody's clock.
 */
export interface EventEnvelope {
  readonly seq: number;              // monotonic per session, adapter-assigned
  readonly harness: HarnessId;
  readonly sessionId: SessionId;
  readonly turnId: TurnId | null;    // null for session-scoped events
  readonly receivedAt: number;       // OUR wall clock at ingest
  /**
   * The raw native frame, verbatim. The protocol is lossy by design but never
   * loses data: anything we failed to model is still here, and the transcript
   * writer persists this, not the normalized view.
   */
  readonly native: unknown;
}

export type WingmanEvent = EventEnvelope & (
  | { kind: 'session.started';   model: string; cwd: string; tools: readonly string[];
      mcpServers: readonly { name: string; status: string }[] }
  | { kind: 'session.ended';     outcome: SessionOutcome }
  | { kind: 'text.delta';        text: string }
  | { kind: 'text.message';      text: string; parentToolCallId: ToolCallId | null }
  | { kind: 'reasoning.delta';   text: string; summary: boolean }
  | { kind: 'tool.started';      call: ToolCall }
  | { kind: 'tool.progress';     callId: ToolCallId; elapsedMs: number; chunk?: string }
  | { kind: 'tool.output';       callId: ToolCallId; ok: boolean;
      /** Structured payload where the harness gives one; text is the fallback, never the primary. */
      output: unknown; text: string }
  | { kind: 'tool.denied';       callId: ToolCallId; toolName: string;
      by: 'user' | 'policy' | 'classifier'; reason: string }
  | { kind: 'approval.requested'; request: ApprovalRequest }
  | { kind: 'accounting';        usage: Accounting; final: boolean }
  | { kind: 'context.pressure';  usedTokens: number; windowTokens: number | null }
  | { kind: 'compaction';        trigger: 'auto' | 'manual'; preTokens: number; postTokens: number | null }
  | { kind: 'error';             error: HarnessError }
  /** Modelled explicitly so unknown frames are visible in the UI rather than swallowed. */
  | { kind: 'passthrough';       nativeKind: string }
);

export interface ToolCall {
  readonly id: ToolCallId;
  readonly name: string;
  readonly input: Record<string, unknown>;
  /** Ties subagent traffic to the parent call. All three harnesses nest. */
  readonly parentToolCallId: ToolCallId | null;
  readonly kind: 'read' | 'write' | 'exec' | 'search' | 'mcp' | 'subagent' | 'other';
}

export type SessionOutcome =
  | { status: 'completed'; finalText: string; structuredOutput?: unknown }
  | { status: 'cancelled'; partial: boolean }
  | { status: 'failed'; error: HarnessError };
```

`tool.output` carries `output: unknown` **and** `text: string` deliberately. The Claude SDK exposes `SDKUserMessage.tool_use_result` (`sdk.d.ts:4613`), documented as "the tool's full Output object, not the string content sent to the model … render from it instead of parsing the tool_result text", with per-tool types in `sdk-tools.d.ts` (3,807 lines). Codex gives structured `ThreadItem` payloads. Parsing model-facing prose when a typed object is available is the bug the field pair exists to prevent.

### 1.3 Accounting

```ts
export interface TokenCounts {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly reasoning: number | null;  // codex/omp report it; Claude folds it into output
  readonly total: number | null;
}

export interface Accounting {
  readonly tokens: TokenCounts;
  /**
   * null when costVisibility !== 'usd'. NEVER silently substitute a derived
   * figure here; a derived number goes in `derivedUsd` so the UI can label it.
   */
  readonly reportedUsd: number | null;
  readonly derivedUsd: number | null;
  readonly perModel: ReadonlyMap<string, TokenCounts & { reportedUsd: number | null }>;
  readonly contextWindow: number | null;
  readonly durationMs: number;
  readonly apiDurationMs: number | null;
}
```

The asymmetry is the point. Claude reports `total_cost_usd` and per-model `costUSD` directly (`sdk.d.ts:1265`). Codex reports **no monetary figure anywhere in its protocol** (calibrated above). If the UI shows one number for both, it is lying about one of them. Show reported cost as cost and derived cost as an estimate, visibly.

Naming trap worth a comment in the code: the Claude SDK mixes conventions inside one result object. `modelUsage` is camelCase (`inputTokens`, `cacheReadInputTokens`) while `usage` is the Anthropic `BetaUsage` shape and therefore snake_case (`input_tokens`, `cache_read_input_tokens`). Codex is snake_case on the SDK wire (`thread_id`, `aggregated_output`) and camelCase on app-server (`threadId`). Four conventions, three harnesses. One normalizer per adapter, never shared.

### 1.4 Error taxonomy

Normalize to a closed set. The mapping is derived from the two richest native taxonomies: Claude's `TerminalReason` (19 values, `sdk.d.ts:6947`) plus `SDKAssistantMessageError` (10 values, `:2923`), and codex's `CodexErrorInfo`.

```ts
export type ErrorClass =
  | 'auth'                 // creds absent, expired, or org-disallowed
  | 'rate-limit'           // slow down and retry
  | 'quota-exhausted'      // budget/credits/usage cap; retry will not help
  | 'context-overflow'     // prompt too long
  | 'overloaded'           // upstream capacity, retryable
  | 'upstream'             // 5xx / stream disconnect
  | 'invalid-request'      // our fault: bad model id, malformed options
  | 'policy'               // org policy or content policy refusal
  | 'sandbox'              // harness sandbox refused the operation
  | 'cancelled'            // user or budget-guard abort
  | 'max-turns'            // loop bound hit
  | 'harness-unavailable'  // binary missing, spawn failed, version below floor
  | 'protocol'             // handshake failure, unparseable frame, unknown schema
  | 'unknown';

export interface HarnessError {
  readonly class: ErrorClass;
  readonly message: string;
  /** Harness-signalled where possible, inferred from `class` only where not. */
  readonly retryable: boolean;
  readonly retryableSource: 'harness' | 'inferred';
  readonly nativeCode: string | null;
  readonly detail?: string;
}
```

`retryableSource` exists because codex signals it and Claude does not. `ErrorNotification.willRetry` is a first-class boolean on app-server; on Claude the nearest equivalent is observing `SDKAPIRetryMessage` (`sdk.d.ts:2864`) go past. Recording which one you had beats pretending they are the same signal.

### 1.5 The adapter interface

```ts
export interface HarnessAdapter {
  readonly descriptor: HarnessDescriptor;

  /** Cheap liveness + version check. Must actually execute the binary (see §3.3). */
  health(): Promise<HarnessHealth>;

  /** Start a session. Does not run a turn. */
  createSession(spec: SessionSpec): Promise<HarnessSession>;

  /** Reattach after app restart. Rejects with 'harness-unavailable' if the id is gone. */
  resumeSession(id: SessionId, spec: SessionSpec): Promise<HarnessSession>;

  /** Branch without mutating the parent. Guarded by capabilities.canFork. */
  forkSession(id: SessionId, spec: SessionSpec): Promise<HarnessSession>;
}

export interface HarnessSession {
  readonly id: SessionId;
  readonly harness: HarnessId;

  /** Send a turn. Events for the whole session arrive on `events`, not here. */
  send(input: TurnInput): Promise<TurnId>;

  /** One stream for the session's whole life, so the UI subscribes once. */
  readonly events: AsyncIterable<WingmanEvent>;

  /** Cancel the current turn, keep the session. Guarded by canInterrupt. */
  interrupt(): Promise<void>;

  /** Correct a RUNNING turn. Guarded by canSteer. */
  steer(text: string): Promise<void>;

  /** Tear down the child process. Always available. */
  close(): Promise<void>;
}

export interface SessionSpec {
  readonly cwd: string;
  readonly model?: string;
  readonly systemPrompt?: { mode: 'replace' | 'append'; text: string };
  readonly readOnly: boolean;      // §3.4: the default for review
  readonly allowedTools?: readonly string[];
  readonly outputSchema?: unknown;
  readonly budgetUsd?: number;
  readonly onApproval: (req: ApprovalRequest) => Promise<ApprovalDecision>;
  readonly signal?: AbortSignal;
}

export type ApprovalDecision =
  | { decision: 'allow'; updatedInput?: Record<string, unknown>; forSession?: boolean }
  | { decision: 'deny'; message: string };
```

> [!WARNING] Historical SDK approval finding
> ⛔ **SUPERSEDED 2026-08-06: the SDK is no longer "retired" — it is adopted (Master Plan R2).** The shipping Claude adapter is expected to be SDK-based, so `onApproval`/`CanUseTool` are back in scope rather than forbidden; re-derive the approval-arbitration design against the adopted SDK rather than against this CLI-only note.
> The `onApproval` rule below applied only to the retired Claude Agent SDK. The shipping CLI adapter has no SDK callback: it launches with an explicit read-only tool allowlist, refuses bypass modes, and treats any unexpected write/exec request as a denied turn. Do not implement `CanUseTool` or import SDK types.

---

## 2. Per-harness mapping

### 2.1 Claude Code (v1)

> [!DANGER] The SDK mapping below is research, not an implementation recipe
> ⛔ **SUPERSEDED 2026-08-06: this whole "clean-room CLI, never import SDK types" posture is reversed — the Claude Agent SDK is adopted, see Master Plan R2.** The credential/context-disclosure discipline (never persist a harness credential, disclose inherited project context) still applies to the SDK integration.
> Current transport is a fresh `claude -p --output-format stream-json --include-partial-messages --resume <id> --fork-session --json-schema ...` child process for each turn. Decode the CLI JSONL with tolerant runtime schemas and preserve unknown native frames for diagnostics. Rennet owns the logical thread and normalized transcript; the harness owns authentication and its native session. Never import SDK types, never set/read credentials, and never inherit unbounded project hooks/MCP/tool context without explicit disclosure.

Historical transport studied here: `@anthropic-ai/claude-agent-sdk`. ~~It is superseded by the clean-room CLI wrapper above.~~ ⛔ SUPERSEDED 2026-08-06 (reversal of the reversal): the SDK is adopted; it is no longer "historical", it is the current design.

The streaming-input SDK prescription is retired. Continuity is implemented by CLI resume/fork identifiers plus Rennet's own transcript. Cancellation kills the owned turn process; regeneration starts a new turn against immutable inputs.

| Normalized | Native | Source |
|---|---|---|
| `session.started` | `{type:'system', subtype:'init'}` → `session_id`, `model`, `tools`, `mcp_servers`, `permissionMode`, `slash_commands`, `apiKeySource`, `capabilities` | `sdk.d.ts:4434` |
| `text.delta` | `{type:'stream_event'}`, `.event` is the **raw Anthropic `BetaRawMessageStreamEvent`** verbatim; take `content_block_delta`. Requires `includePartialMessages: true` | `:4172`, `:1631` |
| `text.message` | `SDKAssistantMessage.message.content` text blocks (`message: BetaMessage`) | `:2876` |
| `tool.started` | `tool_use` **content block inside** `SDKAssistantMessage.message.content`. There is no dedicated tool message type | `:2876` |
| `tool.progress` | `SDKToolProgressMessage` → `tool_use_id`, `tool_name`, `elapsed_time_seconds`, `heartbeat` | `:4575` |
| `tool.output` | `tool_result` block in `SDKUserMessage.message.content` (correlate on `tool_use_id`), **plus** `SDKUserMessage.tool_use_result` for the typed payload | `:4605`, `:4613` |
| `tool.denied` | `SDKPermissionDeniedMessage` `{type:'system', subtype:'permission_denied'}` for auto-denials; `result.permission_denials[]` for the terminal list | `:4190`, `:4181` |
| `approval.requested` | **Not a stream event.** The `canUseTool` callback, invoked out of band with `{toolUseID, requestId, title, displayName, suggestions, signal}` | `:206` |
| `accounting` | `SDKResultMessage` → `total_cost_usd`, `usage: NonNullableUsage`, `modelUsage: Record<string, ModelUsage>` | `:4312`, `:1265` |
| `context.pressure` | `getContextUsage()` control request, polled; not pushed | `:2430`, `:3085` |
| `compaction` | `{type:'system', subtype:'compact_boundary'}` → `trigger`, `pre_tokens`, `post_tokens` | `:2965` |
| `session.ended` | `SDKResultSuccess` / `SDKResultError`, refined by `terminal_reason` | `:4291`, `:6947` |
| `error` | `SDKResultError.errors[]`, `SDKAssistantMessage.error`, thrown `AbortError` | `:4314`, `:2923`, `:17` |

Error class mapping: `authentication_failed | oauth_org_not_allowed` → `auth`; `rate_limit | blocking_limit | rapid_refill_breaker` → `rate-limit`; `billing_error`, subtype `error_max_budget_usd`, `budget_exhausted` → `quota-exhausted`; `prompt_too_long` → `context-overflow`; `overloaded` → `overloaded`; `server_error | api_error` → `upstream`; `invalid_request | model_not_found` → `invalid-request`; `aborted_streaming | aborted_tools` and `AbortError` → `cancelled`; subtype `error_max_turns` → `max-turns`. The exported prefix arrays `USAGE_LIMIT_ERROR_PREFIXES`, `ORG_POLICY_LIMIT_PREFIXES` (`:7063`, `:2063`) let us classify limit errors without inventing our own string matching.

Capabilities:

```ts
{ canResume: true, canFork: true, canInterrupt: true, canSteer: false,
  canGateToolCalls: true, supportsSystemPrompt: 'append', supportsStructuredOutput: 'inline-schema',
  costVisibility: 'usd', supportsTextDeltas: true, supportsReasoningDeltas: true,
  supportsMcp: true, canPreassignSessionId: true, reportsContextWindow: true,
  turnModel: 'live-session', signalsRetryable: false }
```

Options that matter and are easy to get wrong:

- **`env` REPLACES the child environment entirely** (`:1438`), it is not merged with `process.env`. Forget to spread and you lose `PATH` and `HOME`, and the failure looks like a broken binary.
- `settingSources` (`:1910`): omit and every source loads like the CLI; `[]` isolates. **`'project'` must be present for `CLAUDE.md` to load**, which is exactly what the parent note's per-repo reviewer-context feature needs.
- `systemPrompt` as a bare string is a **full replacement**; use `{type:'preset', preset:'claude_code', append}` to extend. Replacing wholesale throws away the harness's own tool discipline.
- `bypassPermissions` additionally requires `allowDangerouslySkipPermissions: true` (`:1748`). This is historical SDK evidence; Rennet never sets either. See §3.4.
- `CLAUDE_AGENT_SDK_CLIENT_APP` is an SDK-only user-agent field. Rennet does not set it because Rennet does not use the SDK.
- `maxBudgetUsd` (`:1683`) is real budget enforcement, surfacing as result subtype `error_max_budget_usd`. Use it for §5 rather than counting tokens ourselves.
- Historical SDK peer dependencies were `@anthropic-ai/sdk`, `@modelcontextprotocol/sdk`, and `zod`. Rennet supplies none of them for the Claude CLI adapter.
- `startup()` → `WarmQuery` (`:6795`, `:7156`) pre-warms a process; `query()` on it may be called **once**. Worth measuring for perceived latency on "ask about this hunk", where the delay is felt directly.

### 2.2 Codex (v2)

Transport: `codex app-server --stdio`, JSON-RPC 2.0 newline-delimited, **with `"jsonrpc":"2.0"` omitted on the wire**. Confirmed by live handshake: sending `initialize` + `initialized` returned `{"id":0,"result":{"userAgent":"…/0.144.1 (Mac OS 26.5.2; arm64)…","codexHome":"/Users/rai/.codex","platformFamily":"unix","platformOs":"macos"}}`, no `jsonrpc` key.

Handshake: exactly one `initialize` per connection before anything else, then the `initialized` notification (the only client notification that exists). Earlier requests get `"Not initialized"`; a second one gets `"Already initialized"`. Set `capabilities.experimentalApi: true`, negotiated once for process lifetime.

| Normalized | Native | Notes |
|---|---|---|
| `session.started` | `thread/start` (or `thread/resume`, `thread/fork`) → `thread/started` notification | ids are UUIDv7 |
| turn dispatch | `turn/start` | not `sendUserMessage`, which is retired |
| `text.delta` | `item/agentMessage/delta` | |
| `reasoning.delta` | `item/reasoning/textDelta`, `item/reasoning/summaryTextDelta`, `item/reasoning/summaryPartAdded` | |
| `tool.started` | `item/started` with item type `commandExecution` \| `fileChange` \| `mcpToolCall` | documented invariant: `item/started` → deltas → `item/completed` |
| `tool.progress` | `item/commandExecution/outputDelta`, `item/fileChange/outputDelta`, `item/commandExecution/terminalInteraction` | |
| `tool.output` | `item/completed`; aggregate diff via `turn/diff/updated`, patch state via `item/fileChange/patchUpdated` | |
| `approval.requested` | **Server→client JSON-RPC request**: `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `item/permissions/requestApproval`, `item/tool/requestUserInput` | 11 server-initiated requests exist |
| approval answer | plain JSON-RPC result `{decision}`; then `serverRequest/resolved` | |
| `tool.denied` | answer `"decline"` → `item/completed` with `status: "declined"` | |
| `accounting` | `thread/tokenUsage/updated` → `ThreadTokenUsage {total, last, modelContextWindow}` | **streamed continuously**, unlike Claude's terminal-only totals |
| `context.pressure` | same notification, `modelContextWindow` | |
| `session.ended` | `turn/completed`, `TurnStatus = "completed" \| "interrupted" \| "failed" \| "inProgress"` | **there is no separate abort notification**; interruption is a status |
| `error` | `error` notification → `ErrorNotification {error: TurnError, willRetry, threadId, turnId}` | |
| interrupt | `turn/interrupt` | |
| steer | `turn/steer` exists, but see the caveat below | |

Approval decisions are richer than a boolean:

```ts
export type CommandExecutionApprovalDecision = "accept" | "acceptForSession"
  | { "acceptWithExecpolicyAmendment": {…} } | { "applyNetworkPolicyAmendment": {…} }
  | "decline" | "cancel";
export type FileChangeApprovalDecision = "accept" | "acceptForSession" | "decline" | "cancel";
```

Note the legacy v1 vocabulary (`ReviewDecision`: `approved` / `denied` / `abort`) uses different words for the same concepts and still exists on `applyPatchApproval` / `execCommandApproval`. Do not mix the vocabularies.

Error class mapping from `CodexErrorInfo`: `unauthorized` → `auth`; `usageLimitExceeded` → `rate-limit`; `sessionBudgetExceeded` → `quota-exhausted`; `contextWindowExceeded` → `context-overflow`; `serverOverloaded` and JSON-RPC `-32001` ("Server overloaded; retry later.") → `overloaded`; `httpConnectionFailed | responseStreamConnectionFailed | responseStreamDisconnected | responseTooManyFailedAttempts | internalServerError` → `upstream`; `badRequest` → `invalid-request`; `cyberPolicy` → `policy`; `sandboxError` → `sandbox`; `threadRollbackFailed | activeTurnNotSteerable` → `protocol`; `other` → `unknown`. `willRetry` populates `retryable` with `retryableSource: 'harness'`.

Sandbox and approval enums, verbatim from the generated bindings:

```ts
export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type AskForApproval = "untrusted" | "on-request"
  | { "granular": { sandbox_approval, rules, skill_approval, request_permissions, mcp_elicitations } }
  | "never";
```

**`"on-failure"` is not in the protocol enum and not in `codex --help`, yet the SDK still declares it** (`index.d.ts:237`) and passes it through as `--config approval_policy="on-failure"`. Almost certainly dead. Do not offer it. (Its exact failure mode is **UNVERIFIED**; no turn was executed.)

Capabilities:

```ts
{ canResume: true, canFork: true, canInterrupt: true, canSteer: true,
  canGateToolCalls: true, supportsSystemPrompt: 'append', supportsStructuredOutput: 'inline-schema',
  costVisibility: 'tokens', supportsTextDeltas: true, supportsReasoningDeltas: true,
  supportsMcp: true, canPreassignSessionId: false, reportsContextWindow: true,
  turnModel: 'live-session', signalsRetryable: true }
```

`canSteer: true` is marked **UNVERIFIED in practice**: `turn/steer` exists as a method and `activeTurnNotSteerable` exists as an error, so refusal is clearly a modelled outcome. Whether it is reliable enough to expose in the UI needs a live test before the flag is trusted.

Build step, not a runtime concern: `codex app-server generate-ts --out DIR --experimental` emits bindings that match the binary exactly. Because we do **not** bundle the binary (§0.2), generation happens against a pinned reference version in CI and version skew becomes a runtime health concern instead (§3.3).

Two more things to plan around. `thread/rollback` is marked deprecated ("will be removed soon"). And the README notes `clientInfo.name` "is used to identify the client for the OpenAI Compliance Logs Platform", with an expectation that new integrations register with OpenAI. That is a distribution question, not a technical one, but it belongs in the open-source-release checklist.

### 2.3 omp / Pi (v3)

**The whole of this section is design-from-generic-shape.** No turn was executed against either binary; every claim below comes from `--help` output, installed `.d.ts` files, and READMEs, not from observed wire bytes. The adapter slot is specified so the shape is right; the mapping table is deliberately not written, because writing it would mean inventing it.

What is verified:

- `omp` = `@oh-my-pi/pi-coding-agent@17.2.8`, MIT, `can1357/oh-my-pi`, bin `omp`. `pi` = `@earendil-works/pi-coding-agent@0.83.0`, MIT, `earendil-works/pi`, bin `pi`.
- `--mode text|json|rpc` on Pi, plus `rpc-ui` on omp. `modes/rpc/jsonl.d.ts` documents strict LF-only JSONL framing. An exported `RpcClient` class exists.
- Session flags: `--continue`, `--resume`, `--session`, `--session-id`, `--fork`, `--session-dir`, `--no-session`.
- 34 RPC command types including `prompt`, `steer`, `follow_up`, `abort`, `compact`, `fork`, `clone`, `switch_session`, `get_entries`, `get_tree`, `get_session_stats`.
- `SessionStats` carries `tokens {input, output, cacheRead, cacheWrite, total}` **and `cost: number`**, so `costVisibility: 'usd'` is likely, pending confirmation of the unit.
- omp has MCP (calibrated: `mcpServers` 156 hits, dedicated `dist/types/mcp/types.d.ts`); **Pi does not** (calibrated 0, positive control 132). It also has `omp acp`, an Agent Client Protocol entry point with `session/request_permission` gating writes, which may be a cleaner adapter target than raw RPC.
- Approval surface: `--approval-mode=always-ask|write|yolo`, `--auto-approve`.

Constraint: omp declares `engines.bun >= 1.3.14` and `main: ./src/index.ts`. It is Bun-first. Spawning it needs Bun present, which is a real discovery and health-check concern that Claude and codex do not have.

Refinement hook. The adapter ships as `OmpAdapter` implementing `HarnessAdapter` with every capability flag defaulting to `false` except the ones proven by a `docs/harness-conformance` test run. The conformance suite is the artefact that upgrades flags:

```ts
// One suite, run against every adapter. Flags are earned, not declared.
describe.each(adapters)('conformance: %s', (adapter) => {
  it('emits session.started with a stable id before any text', …);
  it('emits tool.started before tool.output for the same callId', …);
  it('surfaces a denial as tool.denied, not as a silent no-op', …);
  it('resumes and replays a prior session id', …);           // gates canResume
  it('forks without mutating the parent transcript', …);      // gates canFork
  it('interrupt() stops the turn and keeps the session alive', …); // gates canInterrupt
  it('reports non-zero token counts on a trivial turn', …);
});
```

That suite is worth building for its own sake in v1 against Claude alone, because it is what makes the v2 and v3 adapters cheap rather than speculative.

---

## 3. Discovery

Zero-config is the North Star, so discovery is not a settings screen; it is a subsystem. It runs on app start, on window focus, and on demand.

### 3.1 The PATH trap, measured on this machine

This is the finding that matters most and it is easy to miss, because it does not reproduce in a terminal.

```
$ env -i HOME="$HOME" /bin/sh -lc 'echo $PATH; command -v claude; command -v codex'
PATH=/usr/local/bin:/System/Cryptexes/App/usr/bin:/usr/bin:/bin:/usr/sbin:/sbin:…:/opt/homebrew/bin
(no output for either)
```

A login shell without the user's interactive rc files, which is approximately what an Electron app launched from Finder inherits from launchd, **finds neither harness**. The real locations here are `/Users/rai/.local/bin/claude` and `/Users/rai/.asdf/shims/codex`, and neither directory is on that PATH.

Second trap, same machine: in the interactive shell, `claude` and `codex` are both **shell functions**, not binaries. `command -v claude` prints a function body. Any discovery that shells out to `which` or `command -v` and treats the result as a path will produce garbage that looks like success.

So the algorithm is:

```
1. Harvest, don't ask. Run the user's login shell ONCE, requesting only PATH:
     $SHELL -ilc 'printf %s "$PATH"'
   Never ask it to resolve a binary name; aliases and functions poison that answer.
   Cache the result; refresh on app start and when it fails.
2. Union that PATH with process.env.PATH and a known-locations list:
     ~/.local/bin, ~/.claude/local, /opt/homebrew/bin, /usr/local/bin,
     ~/.bun/bin, ~/.asdf/shims, ~/.volta/bin, ~/.nvm (all versions), `npm root -g`/.bin,
     ~/.cargo/bin, /Applications/*.app/Contents/MacOS
3. Resolve candidates OURSELVES: a plain readdir + X_OK check per directory.
   No shell involved, so no alias, function, or rc-file surprise.
4. Health-check each candidate by EXECUTING it (§3.3). Version strings are the
   only proof that a file called `claude` is Claude Code.
5. Rank: exact known-location match > highest version > first on PATH.
```

Step 3 is the honest answer to why a GUI app that "obviously" should see your tools does not. Step 4 is why an asdf shim, which is a shell script rather than a Mach-O, still passes: we never sniff the file, we run it.

### 3.2 What we look for

| Harness | Binary | Verified real path here | Config dir |
|---|---|---|---|
| Claude Code | `claude` | `/Users/rai/.local/bin/claude` | `~/.claude/` (override: `CLAUDE_CONFIG_DIR`) |
| Codex | `codex` | `/Users/rai/.asdf/shims/codex` → `…/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex` | `~/.codex/` (override: `CODEX_HOME`) |
| omp | `omp` | not installed here | **UNVERIFIED**; also requires Bun on PATH |
| GitHub | `gh` | `/opt/homebrew/bin/gh` | `gh auth token` |

Config-dir presence is corroboration, not proof: `~/.claude/` existing means the CLI has run at some point, which is a useful signal for "this user is a Claude Code user" even when PATH resolution fails, and it is what lets the app say "found your Claude Code config but not the binary" instead of "no harness found".

### 3.3 Health check

Health is a three-state, not a boolean, because BYOK means facing N versions of each harness:

```ts
export type HarnessHealth =
  | { state: 'ready'; version: string }
  | { state: 'degraded'; version: string; reason: 'below-floor' | 'above-tested' | 'unauthenticated' }
  | { state: 'unavailable'; reason: 'not-found' | 'spawn-failed' | 'handshake-failed'; detail: string };
```

- Claude: spawn `claude --version`, parse, compare against `testedRange`. Confirm readiness by running the smallest real CLI turn through the same tolerant JSONL decoder used in production; accept only a valid init/result sequence. Never probe credentials and never import `SDKSystemMessage`.
- Codex: spawn `codex app-server --stdio`, complete the `initialize` handshake, read `userAgent` for the version, close. That is a genuine protocol-level check, not a version-string guess, and it is the strongest health signal any of the three offers.
- omp: `omp --version`, plus a `bun --version` probe.

`above-tested` matters as much as `below-floor`. Claude Code CLI and the codex protocol can both change faster than Rennet's conformance fixtures; a harness newer than anything tested is a real risk, and saying so beats silently emitting `passthrough` events for frames we do not understand.

### 3.4 Sandbox posture: read-only by default

Rennet is a review tool. It reads an immutable patchset and answers questions about it. It has no business writing to the working tree, and a review tool that edits your code while you read is a trust catastrophe.

- Codex: `sandboxMode: "read-only"`, `approvalPolicy: "untrusted"`.
- Claude: invoke the CLI with an explicit allowlist restricted to read/search capabilities, explicitly deny mutation/exec capabilities, and never use a bypass-permissions mode. An unexpected write/exec request fails the turn closed and produces a denial the UI can render.
- omp: `--approval-mode=always-ask`, never `yolo`.

This also makes `tool.denied` a normal, expected event rather than an error path, which is why it is a first-class event kind in §1.2.

### 3.5 Auth: we never read a credential

The strongest possible reading of "read-in-place only" is available here, and it is also the most practical: **the adapter never reads a credential at all.** It spawns a process that already knows how to authenticate itself.

What the credentials actually are, verified:

- **Claude Code on macOS, historical audit evidence only**: the retired SDK revealed `<CLAUDE_CONFIG_DIR ?? ~/.claude>/.credentials.json` and a Keychain fallback. Rennet does not depend on that storage shape; the installed `claude` process owns authentication, and Rennet observes only whether a real CLI turn succeeds.
- **Codex**: `~/.codex/auth.json`, keys `["OPENAI_API_KEY", "auth_mode", "last_refresh", "tokens"]` with `tokens: ["access_token","account_id","id_token","refresh_token"]`. Here `OPENAI_API_KEY` is `null` and `auth_mode` is ChatGPT OAuth.

Three hard rules follow.

1. **Never copy, move, or persist a credential.** Obvious, and non-negotiable.
2. **Never read the Keychain item ourselves.** A packaged, signed Electron app is a different binary from the CLI that created the item, so the read triggers a macOS Keychain ACL prompt: a scary "Rennet wants to access Claude Code-credentials" dialog at first launch, on a tool selling trust. Let the spawned `claude` binary read its own item in its own process, where the ACL already allows it.
3. **Never parse `~/.codex/auth.json`.** Those OAuth tokens are auto-refreshed by the CLI, and `last_refresh` proves the rotation is live. Reading them directly gets us a token that expires; worse, a naive write-back would corrupt a rotating credential. Use `getAuthStatus` and `account/read` if we need auth state, which handle refresh; use nothing at all if we do not.

Corollary for §4: the utility tier must not assume an API key exists. On this machine, neither harness has one. Both authenticate by subscription OAuth.

Historical codex-SDK note: it injected `CODEX_API_KEY`, not `OPENAI_API_KEY`. Rennet does not use that SDK and never injects either credential. Any context-isolation strategy must preserve the installed CLI's own authentication and be proved by the conformance spike, not by copying or redirecting credential stores.

---

## 4. Two-tier LLM usage

> [!IMPORTANT] Budget correction
> The useful distinction remains, but the old “hundreds to thousands” utility-call shape is rejected. Route deterministic work to local code, batch semantic utility work per meaningful unit, use an optional direct-API port only when explicitly configured, and never spawn per hunk/item. Initial decomposition is mechanically capped below five harness invocations and must surface a useful first chunk within 15 seconds.

Two genuinely different workloads:

| | Tier 1: agentic review | Tier 2: utility |
|---|---|---|
| Examples | decomposition into chunks, blast-radius analysis, diff chat, claims-and-evidence mapping | chunk summaries, claim extraction, one-line hunk labels, dedupe/severity scoring of findings |
| Needs the repo on disk | yes, that is the entire structural advantage | no, the input is already-extracted text |
| Needs tools | yes | no |
| Needs approval arbitration | yes | no |
| Shape | long-lived session, many turns, streamed | one shot, schema-constrained, batched, parallel |
| Volume | a few meaningful turns | a few batched calls |
| Latency tolerance | seconds, visibly streaming | must be cheap and parallel |

**Utility calls do not route through `HarnessAdapter`.** Everything the adapter provides (process supervision, session lifecycle, permission arbitration, tool-event normalization) is dead weight for "summarize these forty lines as one sentence", and the per-call process cost is real. They go through a separate, much smaller port:

```ts
export interface UtilityPort {
  readonly id: string;
  readonly kind: 'direct-api' | 'harness-degenerate';
  complete<T>(req: {
    system?: string;
    user: string;
    schema: ZodType<T>;      // structured output is mandatory, not optional
    maxTokens?: number;
    signal?: AbortSignal;
  }): Promise<{ value: T; tokens: TokenCounts; usd: number | null }>;
  readonly concurrency: number;
}
```

### 4.1 The zero-config inversion

The stack note assumed tier two runs against "any OpenAI-compatible endpoint (openai-json slot, local models)". That assumption breaks against the North Star, and the evidence is on this very machine: **neither harness here has an API key.** Claude Code authenticates by OAuth in the Keychain; codex `auth.json` has `OPENAI_API_KEY: null` and `auth_mode: chatgpt`. A subscription user has no key to give us, and demanding one is exactly the "API-key ceremony" the North Star forbids.

So the default and the power path swap places:

- **Default:** deterministic local code where semantics are unnecessary; otherwise one schema-constrained, tool-disabled, isolated harness turn per batch. On Claude this is the direct CLI, not SDK `query()`.
- **Power path: `direct-api`.** If the user has `ANTHROPIC_API_KEY`, an OpenAI-compatible endpoint, or a local model, use `@anthropic-ai/sdk` or a plain fetch client. Much faster, much cheaper, higher concurrency. This is where the `openai-json` lift fits: single-turn, structured, no session state, which the parent note already established is all it does.

The router picks per call:

```
if (user configured a direct endpoint)      → direct-api
else if (an env API key is present)          → direct-api
else                                          → harness-degenerate (default)
```

Concurrency differs by an order of magnitude between them (a process spawn per call versus HTTP), so `UtilityPort.concurrency` is part of the interface and the batch scheduler reads it. Anything issuing hundreds of utility calls must also be cancellable as a unit, because switching PRs mid-decomposition is a normal action, not an edge case.

### 4.2 What this costs

Making the zero-config path the default means the first-run experience of decomposing a large PR is slow. Two mitigations, in order: batch aggressively so one degenerate call covers many chunks (fewer, bigger prompts), and surface the direct-api upgrade in context ("this took 40s; adding a key makes it ~3s") rather than in a settings screen nobody opens.

---

## 5. Disagreement machinery

Ratified for v1, with the stochasticity caveat: divergence-because-ambiguous must be separated from divergence-because-stochastic, or the flare is noise. That separation is the whole design.

### 5.1 The two axes

Two independent runs of the same prompt disagree for two different reasons, and they need different UI. So we measure both:

- **Within-harness variance (N=3 self-consistency).** Same harness, same prompt, same input, three runs. Divergence here is *stochastic*: it is the harness's own noise floor. This is a **calibration**, not a finding.
- **Between-harness divergence.** Claude versus codex versus omp on the same input. Divergence here is a *candidate* finding, and it only earns a flare if it exceeds the noise floor established by the first axis.

This is what turns "the models disagreed" into a claim that survives the obvious objection. A disagreement smaller than a harness's own run-to-run variance is not evidence of anything.

```ts
export interface ConsistencyRun {
  readonly harness: HarnessId;
  readonly runs: readonly ReviewOutput[];   // N=3
  /** Fraction of claims present in all N runs. The noise floor for this harness+prompt. */
  readonly selfAgreement: number;
  readonly stableClaims: readonly Claim[];   // in all N
  readonly volatileClaims: readonly Claim[]; // in some, not all
}

export type DivergenceVerdict =
  | { kind: 'consensus'; claim: Claim; harnesses: readonly HarnessId[] }
  | { kind: 'stochastic'; claim: Claim; note: 'within the harness noise floor' }
  | { kind: 'substantive'; claim: Claim; heldBy: readonly HarnessId[];
      rejectedBy: readonly HarnessId[]; margin: number };
```

Only `substantive` reaches the UI as a flare. `stochastic` is suppressed or shown only in a diagnostic view. `consensus` "collapses away", per the parent note. The copy the design system already specifies, "substantive, not stochastic", is literally this verdict field, which is a good sign the vocabulary and the machinery agree.

### 5.2 Claim identity is the hard part

Agreement is a set operation, so everything depends on deciding when two differently-worded findings are the same claim. Concretely: a claim is `(anchor, assertion)` where `anchor` resolves to an immutable occurrence and `assertion` is normalized text. Matching is exact occurrence/lineage evidence first, then a batched semantic match on the assertion. Similarity never manufactures identity or carries state.

That is a genuine dependency: **disagreement cannot ship before the anchoring engine and the utility tier.** Worth stating plainly rather than discovering in week six.

### 5.3 Cost control

N=3 per harness across three harnesses is nine agentic runs per changeset. That is the expensive feature in the product, and Claude reports USD while codex reports only tokens, so the budget guard cannot be uniform.

Controls, cheapest first:

1. **Fork, do not re-run.** All three harnesses can fork a session. Prime one session with the changeset context, then fork it N times for the sampled turn. On Claude this also means the shared prefix is a cache read (`cacheReadInputTokens`), which is the difference between three full-price runs and one. **UNVERIFIED**: that forked sessions actually hit the prompt cache. It is the single highest-value measurement in this whole section, because it decides whether N=3 is cheap or is the product's dominant cost.
2. **Self-consistency on demand, not by default.** Run a single pass per harness by default; N=3 fires when between-harness divergence is detected, to decide whether that divergence is real. This inverts the naive order and cuts the common case from 9 runs to 3.
3. **Sample the claim, not the changeset.** Once claims exist, re-ask only about the contested one, with just its hunk and reach as context. Two orders of magnitude cheaper than re-running a decomposition.
4. **Hard budget.** Claude has real enforcement via `maxBudgetUsd`, surfacing as `error_max_budget_usd`. Codex has `sessionBudgetExceeded` as an error class but no USD input, so its guard is token-based against our own price table, and it is an estimate. Say so in the UI.
5. **Scope.** Disagreement runs on the decisions and claims-and-evidence angles, where a wrong call costs the reviewer real time. Not on the sequence, where two orderings are both fine and divergence is meaningless.

Control 2 has a consequence worth naming: it means the *baseline* is one run per harness, and self-consistency is a **verification instrument**, not a permanent tax. That is also the honest framing for the UI.

---

## 6. Session persistence

### 6.1 Two stores, one owner

Harnesses may persist their own transcripts, in their own formats, in their own directories. Rennet neither reads nor writes those stores and does not rely on their shape.

| | Location | Format | Notes |
|---|---|---|---|
| Claude | `~/.claude/projects/<cwd with non-alphanumerics → dashes>/<session-uuid>.jsonl` | JSONL | Historical location evidence. Rennet neither configures nor reads this store and does not depend on its path or format. |
| Codex | `~/.codex/sessions/YYYY/MM/DD/rollout-<ISO8601-dashed>-<uuid>.jsonl` | JSONL | UUIDv7 session ids; line types `session_meta`, `event_msg`, `response_item`, `world_state`, `turn_context`. Also `~/.codex/session_index.jsonl` and a `state_*.sqlite` |
| omp / pi | `--session-dir` | **UNVERIFIED** | |

Rennet keeps its own append-only event log (the `~400 lines` event store from the stack note) and treats the harness transcripts as **foreign, read-only, and optional**. Ours is the source of truth; theirs is a diagnostic we can link to.

### 6.2 What survives restart

```ts
export interface PersistedThread {
  readonly threadId: ThreadId;            // OURS, stable forever
  readonly changesetId: ChangesetId;      // repo identity + refs, never a path
  readonly anchor: HunkAnchor | null;     // content-derived, survives force-push
  readonly harness: HarnessId;
  readonly harnessSessionId: string | null;
  readonly harnessVersionAtCreation: string;
  readonly messages: readonly PersistedMessage[];  // full normalized transcript
  readonly accounting: Accounting;
  readonly state: 'live' | 'detached' | 'orphaned';
}
```

The key move: **a thread's content is ours, and the harness session is a detachable execution context.** After a restart, every thread renders in full from our own log with zero harness involvement. Re-attachment happens lazily, only when the user sends another message into that thread.

```
send() into a persisted thread:
  1. harnessSessionId is null            → create a new session, replay context as a primed prefix
  2. resumeSession(id) succeeds          → 'live', continue
  3. resume fails, or the harness version moved outside testedRange
                                          → 'orphaned': create a fresh session,
                                            replay our transcript as context,
                                            and TELL THE USER the thread was rebuilt
```

Branch 3 is the one that must not be silent. A thread that looks continuous but has quietly lost the model's memory of it is worse than an honest "this conversation was restored from our own record".

`harnessVersionAtCreation` is stored because BYOK means the user updates their harness under us. A resume across a major version change is a plausible-looking failure, which is the worst kind.

### 6.3 The force-push case

Review state keys on immutable occurrences and explicit lineage. Exact, unambiguous lineage may preserve unaffected thread context; changed, similar, or ambiguous lineage is marked stale and reopened. A detached thread remains visible against its last-known occurrence and is never silently attached to new line numbers.

### 6.4 Crash and orphan cleanup

⛔ **SUPERSEDED 2026-08-06 (partial): Claude's process is now the adopted SDK's, not a bare `claude -p` process-per-turn child (Master Plan R2) — apply the "own only what you spawned" discipline to the SDK's process instead.** Adapters own every process they start. Record owned child identity at spawn, reap only processes Rennet can prove it created, and never inspect or kill an unrelated harness process. Claude's process-per-turn child should normally exit with the turn; Codex app-server needs explicit lifecycle supervision.

---

## 7. v1 cut

| | Harness | Interface | Status |
|---|---|---|---|
| **v1** | Claude Code | clean-room `claude -p` process-per-turn CLI wrapper ⛔ SUPERSEDED 2026-08-06: SDK adopted, not a clean-room CLI wrapper — see Master Plan R2 | Dogfood daily-driver; direct CLI fidelity/isolation spike gates it |
| **v2** | Codex | `codex app-server --stdio`, JSON-RPC, bindings generated in CI | Fully specified above; needs a live turn to confirm steer and approval round trips |
| **v3** | omp (+ pi subset) | `omp --mode rpc` NDJSON, or `omp acp` | Slot only. Capability flags start `false` and are earned by the conformance suite |

Also in v1, because the v1 adapter is not usable without them:

- The normalized protocol types in Apache `packages/protocol`, with shared domain types in `packages/types`. ⛔ SUPERSEDED 2026-08-06: `packages/protocol` is MIT, not Apache-2.0.
- Discovery with the login-shell PATH harvest (§3.1). Without it, zero-config fails on exactly the machines it must work on.
- The conformance suite (§2.3), built against Claude alone. It is what makes v2 and v3 cheap.
- The utility tier with `harness-degenerate` as default (§4.1).

Explicitly **not** in v1: disagreement across harnesses (needs two adapters, so it is v2 by construction), and within-harness N=3 self-consistency, which needs the anchoring engine and the utility tier first. Disagreement "ships in v1" as ratified refers to the product's first release, not to the first adapter; the machinery is specified now so nothing built before it has to be undone.

Line-count reality check against the stack note's ~800: protocol types ~250, Claude adapter ~450, discovery ~300, utility tier ~200, conformance suite ~300, codex adapter ~600 (JSON-RPC client, 11 server-request handlers, generated-binding glue), omp adapter ~400. Call it **~1,500 for v1** and ~2,500 across all three. The 800 was for three thin adapters over one shape; the shape turned out not to be one shape.

---

## 8. Decisions and alternatives

| # | Decision | Alternative rejected | Why |
|---|---|---|---|
| D1 | Codex adapter targets `app-server`, not `@openai/codex-sdk` | Official SDK (the stack note's recommendation) | The SDK has no approval channel at all, flattens `codexErrorInfo` to a string, drops `willRetry`, and omits `totalTokens`/`modelContextWindow`. It is a wrapper around a hidden `codex exec --experimental-json` flag |
| D2 | Ship no harness binaries; discover the user's ⛔ SUPERSEDED 2026-08-06: the Claude Agent SDK's platform binary IS now bundled/adopted, see Master Plan R2 | Bundle the Agent SDK's platform binary | 270 MB, asarUnpack, nested-binary hardened-runtime signing, notarization. BYOK means the user has it already. Deletes the last compiled artifact from the stack |
| D3 | Third slot targets `omp`, not npm `oh-my-pi` | The package named in the brief | That package is an abandoned namesake: repo 404s, bin throws `SyntaxError`, and it is a Pi *extension* with no drivable surface. **Needs ratification** |
| D4 | **Superseded:** Claude uses a clean-room process-per-turn CLI wrapper ⛔ SUPERSEDED AGAIN 2026-08-06: this ruling is reversed — the "alternative rejected" (linked Agent SDK) is now the adopted design, see Master Plan R2 | Linked Agent SDK streaming mode | Proprietary SDK linkage is incompatible with the licence and unnecessary for CLI resume/fork continuity |
| D5 | Utility tier defaults to `harness-degenerate`, not direct API | Direct OpenAI-compatible endpoint as default (the stack note's assumption) | Neither harness on this machine has an API key; both are subscription OAuth. A key requirement violates the zero-config North Star |
| D6 | The adapter never reads a credential | Read `~/.codex/auth.json` and the Claude Keychain item in place | Reading the Keychain item from a differently-signed binary triggers an ACL prompt on first launch; parsing codex's `auth.json` yields a token that expires under live rotation. Spawning a process that authenticates itself is both safer and easier |
| D7 | Read-only sandbox posture by default across all harnesses | Inherit each harness's default | A review tool must not write to the tree. Makes `tool.denied` a normal event, not an error |
| D8 | Every event carries its raw native frame; unknown frames become `passthrough` | Drop unmodelled events | BYOK means facing harness versions newer than anything tested. Silent loss is the failure mode; visible passthrough is recoverable |
| D9 | Adapter-assigned monotonic `seq`, not harness timestamps | Order by the harness's own clock | The Claude SDK's own type says "do not order messages by this field" |
| D10 | Self-consistency runs on demand, not by default | N=3 always | 9 agentic runs per changeset by default is the product's dominant cost. Baseline 1 per harness; N=3 fires only to adjudicate an observed divergence |
| D11 | Capability flags start `false` and are earned by a conformance suite | Declare capabilities from docs | Docs were wrong twice in this exercise (Claude's `PermissionMode`, codex's dead `on-failure`). A flag nobody tested is a claim, not a capability |
| D12 | Three-state health (`ready`/`degraded`/`unavailable`), with `above-tested` as a distinct degradation | Boolean available/unavailable | BYOK means N versions per harness; installed CLI/protocol versions can move beyond the conformance range |

---

## 9. Open questions and refinement hooks

**Blocking, cheap, do these first**

1. **Direct Claude CLI fidelity and isolation.** ⛔ SUPERSEDED 2026-08-06: the SDK is adopted, not retired (Master Plan R2) — this spike's premise (CLI-only, no SDK) needs re-deriving against the SDK. Verify resume/fork, schema output, partial frames, cancellation, prompt-cache behaviour, and whether inherited project context can be excluded and disclosed. This replaces the retired Agent SDK packaging spike.
2. **Do forked Claude sessions hit the prompt cache?** Measure `cacheReadInputTokens` across a fork. Decides whether N=3 self-consistency (§5.3) is cheap or is the product's dominant cost line.
3. **Live codex turn**: confirm the approval round trip (`item/commandExecution/requestApproval` → `{decision}` → `serverRequest/resolved` → `item/completed`) and whether `turn/steer` is reliable enough to expose. `canSteer` stays `false` until then.

**Design questions**

4. Utility tier: is `harness-degenerate` fast enough that batched chunk summarization over a 3,000-line PR is tolerable on first run? If not, the first-run experience needs a different shape, not a faster prompt.
5. Claim identity (§5.2): does semantic matching of assertions need a model call at all, or does anchor equality plus a cheap lexical measure get close enough? Cheaper answer preferred; it is on the hot path for every disagreement.
6. Does a per-message harness switch inside one thread reuse one session per harness, or one session per thread with context replayed on switch? Affects cost, latency, and whether "second opinion" reads as a fresh perspective or a primed one. Leaning: fresh session per harness per thread, because a primed second opinion is not independent, which is the entire point of asking.
7. `@modelcontextprotocol/sdk` is **not** a Claude-adapter dependency. Consider it only if Rennet later exposes app-owned review state as an MCP server, in a separate package and threat model.
8. Does the phone need `HarnessCapabilities` in `core/protocol`? It renders harness names and switchers, so probably yes, which means capabilities must stay free of Node types. Currently they are; keep it that way.

**Refinement hooks (deliberately unspecified)**

9. **omp/Pi mapping table.** Not written, because writing it would mean inventing it. The hook is the conformance suite: each passing test flips one capability flag from `false`. Until a test passes, the UI treats that capability as absent, which degrades gracefully rather than lying.
10. **A fourth harness.** The interface is `HarnessAdapter` plus a conformance run. Nothing above the adapter boundary branches on `HarnessId`; if it starts to, that is the bug.
11. **Version-skew envelope.** `testedRange` is currently a hand-maintained constant, which is a Brita-filter violation waiting to happen. It should be derived from whatever versions CI actually ran the conformance suite against.

**Could not verify**

- omp/pi wire format empirically. All claims are from `--help`, `.d.ts`, and READMEs; no turn was executed. Structured output support on Pi is unconfirmed either way.
- Whether codex's `CreditsSnapshot.balance` and `SpendControlLimitSnapshot.{limit,used}` are monetary. They are opaque strings with no unit declared anywhere in the schema, and they are account-wide, so they cannot attribute spend to a run regardless.
- Whether `ApprovalMode: "on-failure"` fails loudly or silently in the codex SDK. It is absent from the protocol enum and from `codex --help`; treated as unusable.
- The fate of an already-executing tool process on Claude `interrupt()`/abort. The `.d.ts` marks the *message* as `aborted` and distinguishes `aborted_streaming` from `aborted_tools`, but says nothing about the OS process.
- `DirectConnectTransport` / `DirectConnectError` / `parseDirectConnectUrl` are exported at runtime by the Agent SDK with **zero type declarations**. Undocumented; do not use.
- Deltas between codex CLI 0.144.1 (the protocol dumped here) and 0.146.0 (what the SDK pins).

**Historical verification note only:** ⛔ SUPERSEDED 2026-08-06: there is no "prohibition" any more — the SDK is adopted, see Master Plan R2. the SDK tarball was fetched directly during the licence audit because the npm client had a date cutoff. It is evidence for the prohibition above, not a dependency-install instruction.

---

## 10. Bead candidates

> [!DANGER] Use [[Rennet Navi Handoff]] instead
> Rows below that mention the Agent SDK, SDK streaming mode, SDK peer dependencies, or unbatched `harness-degenerate` calls are retired. ⛔ **SUPERSEDED 2026-08-06: re-check this "retired" judgment for anything Agent-SDK-specific — the SDK is adopted (Master Plan R2), so an SDK-related row may now be MORE relevant, not less. The clean-room CLI wrapper rows (e.g. B6 below) are the ones actually superseded.**

| # | Title | Description | Priority | Depends on |
|---|---|---|---|---|
| B1 | Spike: direct Claude CLI fidelity and isolation | Verify `-p`, resume/fork, structured output, partial frames, cancellation, prompt-cache behaviour, and inherited-context isolation/disclosure | P0 | none |
| B2 | Spike: prompt-cache behaviour across a forked Claude session | Measure `cacheReadInputTokens` on N forks of a primed session. Decides whether N=3 self-consistency is affordable | P0 | none |
| B3 | Spike: live codex app-server turn, approvals and steer | Execute a real turn; confirm the approval round trip and whether `turn/steer` is reliable. Sets `canSteer` and `canGateToolCalls` for codex | P0 | none |
| B4 | Implement `core/protocol`: normalized event types + capability flags | §1 verbatim, zero `node:*` imports so the phone can import it | P0 | none |
| B5 | Implement harness discovery with login-shell PATH harvest | §3.1-3.3. Login-shell PATH, known locations, our own resolution, execute-to-health-check, three-state health. Test against this machine, where a bare login shell finds neither harness | P0 | B4 |
| B6 | Implement the Claude Code adapter | Clean-room process-per-turn CLI wrapper, tolerant decoders, read-only posture, explicit isolation disclosure. ⛔ SUPERSEDED 2026-08-06: SDK-based adapter, not a clean-room CLI wrapper — see Master Plan R2. | P0 | B1, B4, B5 |
| B7 | Build the harness conformance suite | One suite run against every adapter; each passing test earns one capability flag. Built against Claude first | P1 | B6 |
| B8 | Implement the utility tier with `harness-degenerate` default | `UtilityPort`, both implementations, the router, batch scheduling, unit cancellation | P1 | B4, B5 |
| B9 | Ratify the oh-my-pi correction | The package named in the brief is an abandoned namesake; the real target is `omp` (`can1357/oh-my-pi`), with `pi` as a subset. Confirm the third slot's meaning before any code | P1 | none |
| B10 | Implement the codex app-server adapter | JSON-RPC client, initialize handshake, 11 server-request handlers, bindings generated in CI from a pinned reference version | P1 | B3, B4, B7 |
| B11 | Session persistence and re-attach | Own event log, three-state thread lifecycle, non-silent orphan rebuild, `harnessVersionAtCreation`, orphan-process reaping | P1 | B4, B6 |
| B12 | Disagreement machinery | Two-axis design: within-harness noise floor, between-harness divergence, `substantive` verdict only reaches the UI. On-demand N=3 | P2 | B2, B10, anchoring engine |
| B13 | Claim identity and matching | `(anchor, assertion)` with anchor equality then semantic match as a batched utility call. On the hot path for every disagreement | P2 | B8, anchoring engine |
| B14 | omp adapter slot | Capability flags all `false`; earned by B7. Includes the Bun-presence health check | P3 | B7, B9 |
| B15 | Derive `testedRange` from CI instead of hand-maintaining it | Currently a hand-maintained constant, which is a Brita-filter violation: it will silently go stale | P3 | B7 |

---

## Related

- [[Code Review Harness App]]: parent note, product shape, feature inventory, decisions
- [[References/Desktop and Mobile Stack 2026]]: library choices. Section 7 (LLM and harness) and section 11 (native-dependency register) are both revised by D1 and D2 here
