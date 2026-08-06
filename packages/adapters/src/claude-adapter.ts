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
  type HarnessPort,
  type HarnessSession,
  METERED_API_KEY_SOURCES,
  type SessionSpec,
  type ToolKind,
  type TurnInput,
} from "@rennet/core";
import { compareVersions } from "./harness-discovery";

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

/** Read/search tools permitted under the review-default read-only posture. */
const READ_ONLY_ALLOWED_TOOLS: readonly string[] = ["Read", "Grep", "Glob", "LS"];
/** Write/exec tools denied by policy, so an attempt renders as `tool.denied`. */
const WRITE_EXEC_DENIED_TOOLS: readonly string[] = [
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "Bash",
];

/** Version floor and ceiling the adapter has actually been exercised against. */
export const CLAUDE_TESTED_RANGE = { min: "2.0.0", maxTested: "2.1.220" } as const;

/**
 * The subset of `@anthropic-ai/claude-agent-sdk` options the adapter sets. This
 * is the SDK's `query()` option surface, declared locally so the adapter does
 * not depend on the SDK at build time. The real SDK's `Options` is a superset.
 */
export interface ClaudeQueryOptions {
  readonly cwd: string;
  /** The user's own installed binary. R2: keeps auth on their subscription. */
  readonly pathToClaudeCodeExecutable: string;
  readonly model?: string;
  readonly allowedTools?: readonly string[];
  readonly disallowedTools?: readonly string[];
  /** Never a bypass mode; review is read-only. */
  readonly permissionMode: "default";
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
  readonly appendSystemPrompt?: string;
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

/**
 * Normalize one native Claude frame into zero or more `HarnessEvent`s. Pure:
 * every event carries its raw frame in `native`, and any frame we do not model
 * becomes a visible `passthrough` rather than being dropped. The frame shape is
 * identical whether it comes from the SDK or the underlying CLI stream-json.
 */
export function normalizeClaudeFrame(frame: unknown, context: EnvelopeContext): HarnessEvent[] {
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
    return [
      {
        ...envelope(context, frame),
        kind: "tool.denied",
        callId: stringField(record, "tool_use_id"),
        toolName: stringField(record, "tool_name") ?? "unknown",
        by: "policy",
        reason:
          stringField(record, "reason") ?? stringField(record, "message") ?? "denied by policy",
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
      } else if (blockType === "tool_use") {
        const name = stringField(blockRecord, "name") ?? "unknown";
        events.push({
          ...envelope(context, frame),
          kind: "tool.started",
          call: {
            id: stringField(blockRecord, "id") ?? randomUUID(),
            name,
            input: asRecord(blockRecord.input) ?? {},
            parentToolCallId: null,
            kind: classifyToolKind(name),
          },
        });
      }
    }
    return events;
  }

  if (type === "stream_event") {
    const event = asRecord(record.event);
    const delta = event ? asRecord(event.delta) : null;
    if (
      event &&
      stringField(event, "type") === "content_block_delta" &&
      delta &&
      stringField(delta, "type") === "text_delta"
    ) {
      return [
        { ...envelope(context, frame), kind: "text.delta", text: stringField(delta, "text") ?? "" },
      ];
    }
    return [{ ...envelope(context, frame), kind: "passthrough", nativeKind: "stream_event" }];
  }

  if (type === "result") {
    const isError = record.is_error === true || subtype?.startsWith("error") === true;
    if (isError) {
      const error = mapClaudeError(
        subtype,
        stringField(record, "result") ?? subtype ?? "result error",
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
    const structuredOutput = readStructuredOutput(record);
    const outcome =
      structuredOutput === undefined
        ? { status: "completed" as const, finalText: stringField(record, "result") ?? "" }
        : {
            status: "completed" as const,
            finalText: stringField(record, "result") ?? "",
            structuredOutput,
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
];

export interface ClaudeAdapterConfig {
  readonly binaryPath: string;
  /** Injected SDK transport. The composition root supplies the real `query`. */
  readonly queryFn: ClaudeQueryFn;
  readonly version?: string;
  readonly probeVersion?: (path: string) => Promise<string | null>;
  readonly now?: () => number;
  /** Base environment the child inherits (the SDK replaces the child env wholesale). */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly testedRange?: { readonly min: string; readonly maxTested: string };
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
    return {
      async *[Symbol.asyncIterator](): AsyncIterator<HarnessEvent> {
        const iterable = await started;
        for await (const frame of iterable) {
          for (const event of normalizeClaudeFrame(frame, context)) yield event;
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
    const allowedTools = spec.readOnly
      ? (spec.allowedTools ?? READ_ONLY_ALLOWED_TOOLS)
      : spec.allowedTools;
    return {
      cwd: spec.cwd,
      pathToClaudeCodeExecutable: this.#config.binaryPath,
      permissionMode: "default",
      env,
      abortController: abort,
      ...(spec.model === undefined ? {} : { model: spec.model }),
      ...(allowedTools === undefined ? {} : { allowedTools }),
      ...(spec.readOnly ? { disallowedTools: WRITE_EXEC_DENIED_TOOLS } : {}),
      ...(spec.outputSchema === undefined ? {} : { outputSchema: spec.outputSchema }),
      ...(spec.systemPrompt?.mode === "append"
        ? { appendSystemPrompt: spec.systemPrompt.text }
        : {}),
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
