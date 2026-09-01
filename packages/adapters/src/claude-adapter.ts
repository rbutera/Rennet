import { randomUUID } from "node:crypto";
import {
  type ApiKeySource,
  buildCapabilities,
  type CapabilityName,
  createSeqCounter,
  type EnvelopeContext,
  type ErrorClass,
  type ErrorOrigin,
  envelope,
  type HarnessDescriptor,
  type HarnessError,
  type HarnessEvent,
  type HarnessHealth,
  type HarnessInProcessTool,
  type HarnessPort,
  type HarnessSession,
  METERED_API_KEY_SOURCES,
  type SessionSpec,
  type ToolKind,
  type TurnInput,
} from "@rennet/core";
import type { CouncilEffort, RspTokenUsage } from "@rennet/protocol";
import { utf8ByteLength } from "@rennet/protocol";
import { compareVersions } from "./harness-discovery";
import { readTestedRange } from "./harness-tested-range";

/**
 * The Claude Code adapter (slice 1).
 *
 * This is an `@anthropic-ai/claude-agent-sdk` integration by contract: it is
 * written against the SDK's `query()` surface (`ClaudeQueryFn`) and consumes the
 * SDK's message frames. The SDK is INJECTED, not imported here, because adopting
 * it as a workspace dependency is an open decision (its licence is not in the
 * MIT-family gate, and it fails the 7-day `minimumReleaseAge` and strict-peer
 * policies). The composition root wires the real `query`; slice 1 keeps the
 * adapter package free of that dependency and fully testable. R2 governs the
 * eventual wiring: pass the user's own `claude` via `pathToClaudeCodeExecutable`
 * so auth stays on their subscription OAuth, and never read a credential.
 */

const HARNESS_ID = "claude-code" as const;
const DISPLAY_NAME = "Claude Code";
const SESSION_ENV_MARKER = "RENNET_HARNESS_SESSION";

// Rennet drives the user's harness CAPABLE BY DEFAULT: every session may read,
// write, and run commands (Bash carries `git`, so it covers the push half of
// Make-PR). There is no read-only posture and no deny list — a session that only
// reads is a prompt outcome, not a capability the adapter withholds to force it
// (Rai, 2026-08-11: capability is not where behaviour is enforced).
const SESSION_ALLOWED_TOOLS: readonly string[] = [
  "Read",
  "Grep",
  "Glob",
  "LS",
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "Bash",
];

/**
 * Version floor and ceiling the adapter has actually been exercised against,
 * DERIVED from the committed conformance artifact (bead 63) — never hand-edited.
 * A real conformance run is the only writer of `harness-tested-range.json`; this
 * reads it. The `?? ` guard is a last-resort default if the artifact ever lacks a
 * claude entry, so construction never throws.
 */
export const CLAUDE_TESTED_RANGE: { readonly min: string; readonly maxTested: string } =
  readTestedRange(HARNESS_ID) ?? { min: "2.0.0", maxTested: "2.1.220" };

/**
 * The subset of `@anthropic-ai/claude-agent-sdk` options the adapter sets. This
 * is the SDK's `query()` option surface, declared locally so the adapter does
 * not depend on the SDK at build time. The real SDK's `Options` is a superset.
 */
export interface ClaudeQueryOptions {
  readonly cwd: string;
  /** The user's own installed binary. R2: keeps auth on their subscription. */
  readonly pathToClaudeCodeExecutable: string;
  /** Arguments prepended by the SDK before its own Claude argv (WSL transport). */
  readonly executableArgs?: readonly string[];
  readonly model?: string;
  readonly effort?: CouncilEffort;
  readonly allowedTools?: readonly string[];
  readonly disallowedTools?: readonly string[];
  /**
   * Always bypass. The harness runs headless and capable by default — there is
   * no read-only gate, and a headless turn has no TTY to answer a permission
   * prompt, so write/exec must run without one.
   */
  readonly permissionMode: "bypassPermissions";
  /** The SDK REPLACES the child env, so this is always the full env, never a patch. */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly abortController?: AbortController;
  /**
   * The raw JSON schema to constrain output. The composition root
   * (`createClaudeQueryFn`) translates this into the SDK's
   * `outputFormat: { type: 'json_schema', schema }`, so the adapter's contract
   * stays stable across SDK versions. The result frame's `structured_output` is
   * read back by `normalizeClaudeFrame`.
   */
  readonly outputSchema?: unknown;
  /** The turn's raw response budget in UTF-8 bytes ({@link SessionSpec.outputByteCap}),
   *  enforced in `normalizeClaudeFrame` before any structured output is surfaced. */
  readonly outputByteCap?: number;
  /**
   * Loopback MCP servers (canvasOps@2) the seat may call, as `name → { url }` —
   * the same contract the Codex and OMP adapters carry. The composition root
   * (`createClaudeQueryFn`) translates each into the SDK's HTTP server config.
   *
   * W5 — a Claude seat has NO way to reach canvasOps at all while the Codex and OMP
   * adapters carry the surface. This closes that asymmetry in the ADAPTER, and it is
   * additive: the user's configured servers stay reachable alongside Rennet's.
   *
   * INERT UNTIL A SERVER EXISTS. Nothing in `packages/server` stands a loopback
   * canvasOps@2 server up, so no composition root supplies this yet and no live seat
   * gains a tool from it today. It is a surface waiting on that server, not a
   * capability already delivered — do not read it as one.
   */
  readonly mcpServers?: Readonly<Record<string, { readonly url: string }>>;
  /** App-owned tools mounted into this turn by the SDK composition root. */
  readonly inProcessTools?: readonly HarnessInProcessTool[];
  readonly appendSystemPrompt?: string;
  /**
   * The harness session id to resume (B09 cursor-resume). The composition root
   * (`createClaudeQueryFn`) maps this to the SDK's `resume` option so the spawned
   * `claude` continues that conversation. Absent ⇒ a fresh session.
   */
  readonly resume?: string;
  /**
   * Ask the SDK for partial-message frames (`stream_event`), the source of every
   * `text.delta` / `thinking.delta` this adapter maps. The SDK emits NONE unless
   * asked, so without this a turn settles in one lump. Absent ⇒ settled frames only.
   */
  readonly includePartialMessages?: boolean;
  /**
   * #585: the session is Rennet's internal one-shot work, not the user's. The
   * composition root maps this to the SDK's `persistSession: false`, so the turn
   * is never written to `~/.claude/projects/`.
   */
  readonly ephemeral?: boolean;
}

export interface ClaudeQueryArgs {
  readonly prompt: string;
  readonly options: ClaudeQueryOptions;
}

/** The injected transport: the SDK's `query()`, narrowed to what we consume. */
export type ClaudeQueryFn = (args: ClaudeQueryArgs) => AsyncIterable<unknown>;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" ? value : null;
}

function resultErrorMessage(record: Record<string, unknown>, subtype: string | null): string {
  const result = stringField(record, "result");
  if (result !== null) return result;
  const errors = record.errors;
  if (Array.isArray(errors)) {
    const first = errors.find((error): error is string => typeof error === "string");
    if (first !== undefined) return first;
  }
  return subtype ?? "result error";
}

/**
 * Render a `tool_result` block's `content` to plain text for a `tool.output` event.
 * The Anthropic tool_result content is a string OR an array of blocks (usually
 * `{ type: "text", text }`); concatenate the text of each, and for a non-text block
 * fall back to a compact JSON so nothing a tool printed is silently lost.
 */
function renderToolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content))
    return content === undefined || content === null ? "" : String(content);
  const parts: string[] = [];
  for (const block of content) {
    const record = asRecord(block);
    if (record && stringField(record, "type") === "text") {
      parts.push(stringField(record, "text") ?? "");
    } else if (typeof block === "string") {
      parts.push(block);
    } else {
      try {
        parts.push(JSON.stringify(block));
      } catch {
        parts.push("");
      }
    }
  }
  return parts.join("\n");
}

const API_KEY_SOURCES: readonly ApiKeySource[] = [
  "none",
  "user",
  "project",
  "org",
  "temporary",
  "oauth",
];

function toApiKeySource(value: string | null): ApiKeySource | null {
  return value !== null && (API_KEY_SOURCES as readonly string[]).includes(value)
    ? (value as ApiKeySource)
    : null;
}

export function classifyToolKind(name: string): ToolKind {
  if (name.startsWith("mcp__")) return "mcp";
  if (name === "Task") return "subagent";
  if (name === "Bash") return "exec";
  if (["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(name)) return "write";
  if (["Read", "NotebookRead"].includes(name)) return "read";
  if (["Grep", "Glob", "LS", "WebFetch", "WebSearch"].includes(name)) return "search";
  return "other";
}

function displayToolName(name: string): string {
  return /^mcp__rennet-app(?:-\d+)?__(app_[a-z0-9_]+)$/iu.exec(name)?.[1] ?? name;
}

/**
 * Map a native Claude error code to the normalized taxonomy, including the
 * origin axis. Claude does not signal retryability, so `retryableSource` is
 * always `inferred` here.
 */
export function mapClaudeError(code: string | null, message: string): HarnessError {
  const table: Record<string, { class: ErrorClass; origin: ErrorOrigin; retryable: boolean }> = {
    authentication_failed: { class: "auth", origin: "provider", retryable: false },
    oauth_org_not_allowed: { class: "auth", origin: "provider", retryable: false },
    rate_limit: { class: "rate-limit", origin: "provider", retryable: true },
    billing_error: { class: "quota-exhausted", origin: "provider", retryable: false },
    error_max_budget_usd: { class: "quota-exhausted", origin: "provider", retryable: false },
    budget_exhausted: { class: "quota-exhausted", origin: "provider", retryable: false },
    prompt_too_long: { class: "context-overflow", origin: "provider", retryable: false },
    overloaded: { class: "overloaded", origin: "provider", retryable: true },
    server_error: { class: "upstream", origin: "provider", retryable: true },
    api_error: { class: "upstream", origin: "provider", retryable: true },
    invalid_request: { class: "invalid-request", origin: "adapter", retryable: false },
    model_not_found: { class: "invalid-request", origin: "adapter", retryable: false },
    aborted_streaming: { class: "cancelled", origin: "adapter", retryable: false },
    aborted_tools: { class: "cancelled", origin: "adapter", retryable: false },
    error_max_turns: { class: "max-turns", origin: "harness", retryable: false },
    // The SDK's terminal execution-error result subtype. A resume against a
    // transcript the CLI no longer has surfaces here (sdk.d.ts: resume is refused
    // with an `error_during_execution` result). Preserved as `nativeCode` so the
    // turn loop's resume-vanished discriminator keys on THIS exact subtype (B09
    // F4) rather than the broad `invalid-request` class — non-retryable, harness-origin.
    error_during_execution: { class: "invalid-request", origin: "harness", retryable: false },
  };
  const mapped = code !== null ? table[code] : undefined;
  if (mapped) {
    return {
      class: mapped.class,
      origin: mapped.origin,
      message,
      retryable: mapped.retryable,
      retryableSource: "inferred",
      nativeCode: code,
    };
  }
  return {
    class: "unknown",
    origin: "harness",
    message,
    retryable: false,
    retryableSource: "inferred",
    nativeCode: code,
  };
}

function readStructuredOutput(record: Record<string, unknown>): unknown {
  if ("structuredOutput" in record) return record.structuredOutput;
  if ("structured_output" in record) return record.structured_output;
  return undefined;
}

function numField(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** A finite number field, or `undefined` when absent — the honest "not reported",
 *  never `numField`'s substituted zero. Used where the harness may omit a figure
 *  (the ask-don't-estimate compaction token counts). */
function optNumField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Extract the token accounting off a Claude `result` frame's `usage` block into
 * the RSP `RspTokenUsage` shape (issue #186). Pure and defensive: every count
 * defaults to 0, and a frame with NO `usage` object returns `undefined` — a turn
 * that reported no usage is not the same as one that used zero tokens, so the
 * absence is preserved rather than substituted with a zero block. `total` sums
 * input + output + cache read + cache creation, the throughput the quota proxy
 * measures. `reasoning` is null (the Claude result frame does not report it
 * separately). Threaded onto the completed `SessionOutcome` so the runner that
 * mints the document stamps real tokens instead of ZERO_TOKENS.
 */
export function extractResultUsage(record: Record<string, unknown>): RspTokenUsage | undefined {
  const usage = asRecord(record.usage);
  if (!usage) return undefined;
  const input = numField(usage, "input_tokens");
  const output = numField(usage, "output_tokens");
  const cacheRead = numField(usage, "cache_read_input_tokens");
  const cacheWrite = numField(usage, "cache_creation_input_tokens");
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    reasoning: null,
    total: input + output + cacheRead + cacheWrite,
  };
}

/**
 * Normalize one native Claude frame into zero or more `HarnessEvent`s. Pure:
 * every event carries its raw frame in `native`, and any frame we do not model
 * becomes a visible `passthrough` rather than being dropped. The frame shape is
 * identical whether it comes from the SDK or the underlying CLI stream-json.
 */
export function normalizeClaudeFrame(
  frame: unknown,
  context: EnvelopeContext,
  outputByteCap?: number,
): HarnessEvent[] {
  const record = asRecord(frame);
  if (!record) {
    return [{ ...envelope(context, frame), kind: "passthrough", nativeKind: "non-object" }];
  }
  const type = stringField(record, "type");
  const subtype = stringField(record, "subtype");

  if (type === "system" && subtype === "init") {
    const apiKeySource = toApiKeySource(stringField(record, "apiKeySource"));
    const tools = Array.isArray(record.tools)
      ? record.tools.filter((tool): tool is string => typeof tool === "string")
      : [];
    const events: HarnessEvent[] = [
      {
        ...envelope(context, frame),
        kind: "session.started",
        model: stringField(record, "model") ?? "",
        cwd: stringField(record, "cwd") ?? "",
        tools,
        apiKeySource,
      },
    ];
    // Money safety: a session that should be on subscription OAuth (or 'none')
    // is on a metered key. Detection, never prevention, per R2. `oauth` and
    // `none` are both free at point of use, so only genuinely metered sources
    // warn; an unknown/absent source cannot be asserted and does not warn.
    if (
      apiKeySource !== null &&
      (METERED_API_KEY_SOURCES as readonly string[]).includes(apiKeySource)
    ) {
      events.push({
        ...envelope(context, frame),
        kind: "auth.metered-key-warning",
        apiKeySource,
        message: `Session is authenticated by a metered key (apiKeySource=${apiKeySource}), not subscription OAuth. This spends money per token.`,
      });
    }
    return events;
  }

  if (type === "system" && subtype === "permission_denied") {
    const toolName = stringField(record, "tool_name") ?? "unknown";
    return [
      {
        ...envelope(context, frame),
        kind: "tool.denied",
        callId: stringField(record, "tool_use_id"),
        toolName: displayToolName(toolName),
        by: "policy",
        reason:
          stringField(record, "reason") ?? stringField(record, "message") ?? "denied by policy",
      },
    ];
  }

  if (type === "system" && subtype === "compact_boundary") {
    // The harness compacted its own context (B09 cluster 3). Surface it honestly:
    // the CLI owns the transcript and its compaction; Rennet maps the SDK's
    // `compact_metadata` verbatim — trigger + its OWN pre/post token counts —
    // carrying each figure only when reported (ask-don't-estimate: never a
    // fabricated budget, never a substituted zero). trigger defaults to "auto":
    // an unsolicited compaction is auto by nature, and the field is categorical,
    // not a number we would be inventing.
    const meta = asRecord(record.compact_metadata);
    const trigger = meta !== null && stringField(meta, "trigger") === "manual" ? "manual" : "auto";
    const preTokens = meta === null ? undefined : optNumField(meta, "pre_tokens");
    const postTokens = meta === null ? undefined : optNumField(meta, "post_tokens");
    return [
      {
        ...envelope(context, frame),
        kind: "compact_boundary",
        trigger,
        ...(preTokens === undefined ? {} : { preTokens }),
        ...(postTokens === undefined ? {} : { postTokens }),
      },
    ];
  }

  if (type === "assistant") {
    const message = asRecord(record.message);
    const content = message && Array.isArray(message.content) ? message.content : [];
    const events: HarnessEvent[] = [];
    for (const block of content) {
      const blockRecord = asRecord(block);
      if (!blockRecord) continue;
      const blockType = stringField(blockRecord, "type");
      if (blockType === "text") {
        events.push({
          ...envelope(context, frame),
          kind: "text.message",
          text: stringField(blockRecord, "text") ?? "",
          parentToolCallId: null,
        });
      } else if (blockType === "thinking") {
        // The model's reasoning block. The SDK carries the text on `thinking` (not
        // `text`); surface it as its own lane so the transcript renders a Thought block
        // distinct from prose (issue-set B; taxonomy per t3code's reasoning split).
        events.push({
          ...envelope(context, frame),
          kind: "thinking.message",
          text: stringField(blockRecord, "thinking") ?? "",
        });
      } else if (blockType === "tool_use") {
        const nativeName = stringField(blockRecord, "name") ?? "unknown";
        events.push({
          ...envelope(context, frame),
          kind: "tool.started",
          call: {
            id: stringField(blockRecord, "id") ?? randomUUID(),
            name: displayToolName(nativeName),
            input: asRecord(blockRecord.input) ?? {},
            parentToolCallId: null,
            kind: classifyToolKind(nativeName),
          },
        });
      }
    }
    return events;
  }

  if (type === "user") {
    // A `user` frame carries the RESULTS of the tools the assistant called: each
    // `tool_result` block echoes a `tool_use_id` back with its output. Slice 1 never
    // parsed these, so `tool.output` — a declared event kind — was never emitted, and
    // a consumer watching what a turn actually RAN (issue #259, verification's executed
    // reproduction) saw the tool start but never its result. Emit one `tool.output` per
    // tool_result; a user frame with no tool_result falls through to passthrough.
    const message = asRecord(record.message);
    const content = message && Array.isArray(message.content) ? message.content : [];
    const events: HarnessEvent[] = [];
    for (const block of content) {
      const blockRecord = asRecord(block);
      if (!blockRecord || stringField(blockRecord, "type") !== "tool_result") continue;
      const callId = stringField(blockRecord, "tool_use_id");
      if (callId === null) continue;
      events.push({
        ...envelope(context, frame),
        kind: "tool.output",
        callId,
        ok: blockRecord.is_error !== true,
        output: blockRecord.content ?? null,
        text: renderToolResultText(blockRecord.content),
      });
    }
    if (events.length > 0) return events;
  }

  if (type === "stream_event") {
    const event = asRecord(record.event);
    const delta = event ? asRecord(event.delta) : null;
    if (event && stringField(event, "type") === "content_block_delta" && delta) {
      const deltaType = stringField(delta, "type");
      if (deltaType === "text_delta") {
        return [
          {
            ...envelope(context, frame),
            kind: "text.delta",
            text: stringField(delta, "text") ?? "",
          },
        ];
      }
      // A reasoning increment. The SDK carries it on `thinking`, not `text`; it was a
      // `passthrough` before B and so never reached the transcript's Thought lane.
      if (deltaType === "thinking_delta") {
        return [
          {
            ...envelope(context, frame),
            kind: "thinking.delta",
            text: stringField(delta, "thinking") ?? "",
          },
        ];
      }
    }
    return [{ ...envelope(context, frame), kind: "passthrough", nativeKind: "stream_event" }];
  }

  if (type === "result") {
    const isError = record.is_error === true || subtype?.startsWith("error") === true;
    if (isError) {
      const error = mapClaudeError(subtype, resultErrorMessage(record, subtype));
      return [
        { ...envelope(context, frame), kind: "error", error },
        {
          ...envelope(context, frame),
          kind: "session.ended",
          outcome: { status: "failed", error },
        },
      ];
    }
    const structuredOutput = readStructuredOutput(record);
    // The turn's token usage (issue #186), when the result frame reported it, so
    // the completed outcome carries real counts through to the runner's provenance.
    const usage = extractResultUsage(record);
    const finalText = stringField(record, "result") ?? "";
    // The raw-size cap (#727). The SDK hands this adapter the model's emission —
    // the assistant text under an output schema IS the JSON — so this is the last
    // point that can see how much arrived. Over the cap the turn FAILS here; it is
    // never decoded, never surfaced, and never retried by the cap itself.
    if (outputByteCap !== undefined) {
      const rawBytes = utf8ByteLength(
        finalText.length > 0 || structuredOutput === undefined
          ? finalText
          : JSON.stringify(structuredOutput),
      );
      if (rawBytes > outputByteCap) {
        const error = mapClaudeError(
          "error_output_too_large",
          `the harness returned ${rawBytes} raw UTF-8 bytes, over this turn's ${outputByteCap}-byte output cap`,
        );
        return [
          { ...envelope(context, frame), kind: "error", error },
          {
            ...envelope(context, frame),
            kind: "session.ended",
            outcome: { status: "failed", error },
          },
        ];
      }
    }
    // Cursor-resume (B09): the SDK stamps every frame — the terminal result
    // included — with its own resumable `session_id`, and this frame's `uuid` is
    // the tail chain-entry (a valid resume anchor). Surface both so the durable
    // session persists them as its `HarnessCursor` and the next turn resumes.
    // Absent from the frame ⇒ omitted, never invented (the cursor stays put).
    const harnessSessionId = stringField(record, "session_id") ?? undefined;
    const lastAssistantMessageAnchor = stringField(record, "uuid") ?? undefined;
    const cursor = {
      ...(harnessSessionId === undefined ? {} : { harnessSessionId }),
      ...(lastAssistantMessageAnchor === undefined ? {} : { lastAssistantMessageAnchor }),
    };
    const outcome =
      structuredOutput === undefined
        ? {
            status: "completed" as const,
            finalText,
            ...(usage === undefined ? {} : { usage }),
            ...cursor,
          }
        : {
            status: "completed" as const,
            finalText,
            structuredOutput,
            ...(usage === undefined ? {} : { usage }),
            ...cursor,
          };
    return [{ ...envelope(context, frame), kind: "session.ended", outcome }];
  }

  return [{ ...envelope(context, frame), kind: "passthrough", nativeKind: type ?? "unknown" }];
}

const IMPLEMENTED_CAPABILITIES: readonly CapabilityName[] = [
  "structuredOutput",
  "toolGating",
  "interrupt",
  "textDeltas",
  // B09: `SessionSpec.resume` maps to the SDK `resume` option and the completed
  // outcome surfaces the harness session id — a real port path for cursor-resume.
  "resume",
];

export interface ClaudeAdapterConfig {
  readonly binaryPath: string;
  readonly executableArgs?: readonly string[];
  /** Host-side cwd used only for spawning the transport process. */
  readonly transportCwd?: string;
  /** Injected SDK transport. The composition root supplies the real `query`. */
  readonly queryFn: ClaudeQueryFn;
  readonly version?: string;
  readonly probeVersion?: (path: string) => Promise<string | null>;
  readonly now?: () => number;
  /** Base environment the child inherits (the SDK replaces the child env wholesale). */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly testedRange?: { readonly min: string; readonly maxTested: string };
  /** Loopback MCP servers applied to every session (W5). No composition root supplies
   *  this yet — see {@link ClaudeQueryOptions.mcpServers}. */
  readonly mcpServers?: Readonly<Record<string, { readonly url: string }>>;
}

class ClaudeSession implements HarnessSession {
  readonly id: string;
  readonly harness = HARNESS_ID;
  readonly #queryFn: ClaudeQueryFn;
  readonly #options: ClaudeQueryOptions;
  readonly #context: EnvelopeContext;
  readonly #abort: AbortController;
  readonly #started: Promise<AsyncIterable<unknown>>;
  #resolveStarted!: (iterable: AsyncIterable<unknown>) => void;
  #sent = false;

  constructor(
    id: string,
    turnId: string,
    queryFn: ClaudeQueryFn,
    options: ClaudeQueryOptions,
    now: () => number,
    abort: AbortController,
  ) {
    this.id = id;
    this.#queryFn = queryFn;
    this.#options = options;
    this.#abort = abort;
    this.#context = {
      harness: HARNESS_ID,
      sessionId: id,
      turnId,
      seq: createSeqCounter(),
      now,
    };
    this.#started = new Promise((resolve) => {
      this.#resolveStarted = resolve;
    });
  }

  get events(): AsyncIterable<HarnessEvent> {
    const started = this.#started;
    const context = this.#context;
    const outputByteCap = this.#options.outputByteCap;
    return {
      async *[Symbol.asyncIterator](): AsyncIterator<HarnessEvent> {
        const iterable = await started;
        for await (const frame of iterable) {
          for (const event of normalizeClaudeFrame(frame, context, outputByteCap)) yield event;
        }
      },
    };
  }

  send(input: TurnInput): Promise<string> {
    if (this.#sent) throw new Error("This session has already run a turn (slice 1 is single-turn)");
    this.#sent = true;
    const iterable = this.#queryFn({ prompt: input.prompt, options: this.#options });
    this.#resolveStarted(iterable);
    return Promise.resolve(this.#context.turnId ?? this.id);
  }

  interrupt(): Promise<void> {
    this.#abort.abort();
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.#abort.abort();
    return Promise.resolve();
  }
}

export class ClaudeAdapter implements HarnessPort {
  readonly descriptor: HarnessDescriptor;
  readonly #config: ClaudeAdapterConfig;
  readonly #now: () => number;
  readonly #range: { readonly min: string; readonly maxTested: string };

  constructor(config: ClaudeAdapterConfig) {
    this.#config = config;
    this.#now = config.now ?? Date.now;
    this.#range = config.testedRange ?? CLAUDE_TESTED_RANGE;
    this.descriptor = {
      id: HARNESS_ID,
      displayName: DISPLAY_NAME,
      version: config.version ?? "unknown",
      binaryPath: config.binaryPath,
      // Only `implementedByAdapter` is populated: it is the one layer with a
      // passing check (the mapping code exists and is tested). `advertised` and
      // `availableInSession` are earned by the conformance suite and a live
      // session respectively, both deferred. Nothing here is declared from docs.
      capabilities: buildCapabilities({ implementedByAdapter: IMPLEMENTED_CAPABILITIES }),
      testedRange: this.#range,
    };
  }

  async health(): Promise<HarnessHealth> {
    const probe = this.#config.probeVersion;
    if (!probe) {
      const version = this.#config.version;
      return version
        ? { state: "ready", version }
        : { state: "unavailable", reason: "spawn-failed", detail: "No version probe configured." };
    }
    const version = await probe(this.#config.binaryPath);
    if (version === null) {
      return {
        state: "unavailable",
        reason: "spawn-failed",
        detail: `Could not execute ${this.#config.binaryPath} --version`,
      };
    }
    return healthForRange(version, this.#range);
  }

  createSession(spec: SessionSpec): Promise<HarnessSession> {
    const abort = new AbortController();
    if (spec.signal) {
      // A signal already aborted at session-creation time must propagate too:
      // addEventListener only fires on a FUTURE abort, so a caller that passes an
      // already-aborted signal would otherwise spawn a live turn that never
      // cancels. Check the current state before attaching the future listener.
      if (spec.signal.aborted) abort.abort();
      else spec.signal.addEventListener("abort", () => abort.abort(), { once: true });
    }
    const sessionId = randomUUID();
    const options = this.#buildOptions(spec, sessionId, abort);
    return Promise.resolve(
      new ClaudeSession(sessionId, randomUUID(), this.#config.queryFn, options, this.#now, abort),
    );
  }

  #buildOptions(spec: SessionSpec, sessionId: string, abort: AbortController): ClaudeQueryOptions {
    const baseEnv = this.#config.env ?? process.env;
    // The SDK replaces the child env wholesale, so spread the base and add only
    // the scoped session marker. We never inject an API key: the assertion path
    // detects a metered key rather than forcing one.
    const env: Record<string, string | undefined> = { ...baseEnv, [SESSION_ENV_MARKER]: sessionId };
    // Capable by default: one session shape with the full toolset. An explicit
    // `spec.allowedTools` still narrows it (configuration, not a gate).
    const allowedTools = spec.allowedTools ?? SESSION_ALLOWED_TOOLS;
    return {
      cwd: this.#config.transportCwd ?? spec.cwd,
      pathToClaudeCodeExecutable: this.#config.binaryPath,
      ...(this.#config.executableArgs === undefined
        ? {}
        : { executableArgs: this.#config.executableArgs }),
      permissionMode: "bypassPermissions",
      env,
      abortController: abort,
      ...(spec.model === undefined ? {} : { model: spec.model }),
      ...(spec.effort === undefined ? {} : { effort: spec.effort }),
      ...(allowedTools === undefined ? {} : { allowedTools }),
      ...(spec.outputSchema === undefined ? {} : { outputSchema: spec.outputSchema }),
      ...(spec.outputByteCap === undefined ? {} : { outputByteCap: spec.outputByteCap }),
      // The MCP surface (W5), configured on the adapter exactly as the Codex adapter
      // carries it, so every session this harness creates would reach it. Nothing
      // configures it today — no loopback canvasOps server is stood up.
      ...(this.#config.mcpServers === undefined ? {} : { mcpServers: this.#config.mcpServers }),
      ...(spec.inProcessTools === undefined ? {} : { inProcessTools: spec.inProcessTools }),
      ...(spec.systemPrompt?.mode === "append"
        ? { appendSystemPrompt: spec.systemPrompt.text }
        : {}),
      // Cursor-resume (B09): re-pass the harness session id every turn so the
      // fresh `claude` process continues the prior conversation (the CLI owns the
      // transcript; Rennet persists only this pointer). Absent ⇒ a fresh session.
      ...(spec.resume === undefined ? {} : { resume: spec.resume.harnessSessionId }),
      // Partial-message streaming (F1): the source of `text.delta`/`thinking.delta`.
      ...(spec.streamPartialText === undefined
        ? {}
        : { includePartialMessages: spec.streamPartialText }),
      ...(spec.ephemeral === undefined ? {} : { ephemeral: spec.ephemeral }),
    };
  }
}

function healthForRange(
  version: string,
  range: { readonly min: string; readonly maxTested: string },
): HarnessHealth {
  if (compareVersions(version, range.min) < 0) {
    return { state: "degraded", version, reason: "below-floor" };
  }
  if (compareVersions(version, range.maxTested) > 0) {
    return { state: "degraded", version, reason: "above-tested" };
  }
  return { state: "ready", version };
}
