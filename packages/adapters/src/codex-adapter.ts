import { randomUUID } from "node:crypto";
import {
  buildCapabilities,
  type CapabilityEvidence,
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
  type SessionSpec,
  type ToolKind,
  type TurnInput,
} from "@rennet/core";
import type { RspTokenUsage } from "@rennet/types";
import {
  type CodexTurnError,
  type CodexTurnResultFrame,
  mapTokenUsageBreakdown,
} from "./codex-app-server";
import { stripNullDeep } from "./codex-exec";
import { compareVersions } from "./harness-discovery";
import { readTestedRange } from "./harness-tested-range";

/**
 * The Codex adapter (#25): the second harness slot, peer of `ClaudeAdapter`.
 *
 * Transport verdict (adopt-codex-app-server): the adapter speaks the `codex
 * app-server` JSON-RPC protocol behind an injected `CodexTurnTransport` seam — the
 * mirror of `ClaudeQueryFn`. The transport yields the app-server notification
 * stream (`item/agentMessage/delta`, `item/started`, `item/completed`,
 * `thread/tokenUsage/updated`, `turn/completed`, …) followed by ONE synthetic
 * `turn-result` terminal frame. This file is pure over that stream and fully
 * testable without a process; the composition root (`codex-turn-transport.ts`)
 * supplies the real spawn. It never reads a credential — `codex` authenticates
 * itself on the user's own subscription.
 *
 * The consumers are all single-turn (create → send one prompt → drain → close),
 * which one app-server turn serves exactly, at the capable-by-default posture Rule
 * Zero mandates (full-access sandbox + never-ask approvals composed on the turn).
 */

const HARNESS_ID = "codex" as const;
const DISPLAY_NAME = "Codex";

// ── The injected transport seam (mirror of ClaudeQueryFn) ────────────────────

/** One agentic turn's spec. `cwd` is a REAL repo (the review worktree). */
export interface CodexTurnSpec {
  readonly cwd: string;
  readonly prompt: string;
  /** Codex's own default when absent; the council passes e.g. "gpt-5.6-sol". */
  readonly model?: string;
  readonly outputSchema?: unknown;
  /** Loopback canvasOps@2 (and future) MCP servers; ride spawn-time `-c` overrides. */
  readonly mcpServers?: Readonly<Record<string, { readonly url: string }>>;
  readonly signal?: AbortSignal;
}

/**
 * The transport yields the raw `codex app-server` notification objects
 * (`{ method, params }`), then EXACTLY ONE synthetic terminal frame
 * `{ rennet: "turn-result", status, finalMessage, usage?, model?, error? }`. The
 * adapter owns normalization, seq, and the terminal outcome; the terminal frame is
 * the only carrier of the final status the session boundary determined.
 */
export type CodexTurnTransport = (spec: CodexTurnSpec) => AsyncIterable<unknown>;

export type { CodexTurnResultFrame };

// ── Frame normalization ──────────────────────────────────────────────────────

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" ? value : null;
}

/** Classify an app-server ThreadItem `type` into the normalized `ToolKind`. */
export function classifyCodexItemKind(itemType: string): ToolKind {
  switch (itemType) {
    case "commandExecution":
      return "exec";
    case "mcpToolCall":
    case "dynamicToolCall":
      return "mcp";
    case "fileChange":
      return "write";
    case "webSearch":
      return "search";
    default:
      return "other";
  }
}

function toolName(item: Record<string, unknown>, itemType: string): string {
  return stringField(item, "tool") ?? stringField(item, "command") ?? itemType;
}

function toolInput(item: Record<string, unknown>): Record<string, unknown> {
  const args = asRecord(item.arguments);
  return args ?? item;
}

function toolOutput(
  context: EnvelopeContext,
  frame: unknown,
  item: Record<string, unknown>,
  itemType: string,
): HarnessEvent {
  const status = stringField(item, "status");
  const error = asRecord(item.error);
  let output: unknown;
  let text: string;
  if (itemType === "commandExecution") {
    output = stringField(item, "aggregatedOutput") ?? "";
    text = String(output);
  } else if (itemType === "mcpToolCall" || itemType === "dynamicToolCall") {
    output = item.result ?? item.error ?? null;
    text = error
      ? (stringField(error, "message") ?? JSON.stringify(output))
      : JSON.stringify(output);
  } else {
    output = item.changes ?? item;
    text = JSON.stringify(output);
  }
  return {
    ...envelope(context, frame),
    kind: "tool.output",
    callId: stringField(item, "id") ?? `${itemType}:unknown`,
    ok: (status === "completed" || status === null) && error === null,
    output,
    text,
  };
}

/**
 * Precise classification from a `TurnError.codexErrorInfo` (a string enum or a
 * connection-failure object), the authoritative native signal. Returns null when
 * the info is absent/unrecognized so the caller falls back to message inference.
 */
function classifyCodexErrorInfo(
  info: unknown,
): { class: ErrorClass; origin: ErrorOrigin; retryable: boolean } | null {
  if (typeof info === "string") {
    switch (info) {
      case "contextWindowExceeded":
        return { class: "context-overflow", origin: "provider", retryable: false };
      case "sessionBudgetExceeded":
      case "usageLimitExceeded":
        return { class: "quota-exhausted", origin: "provider", retryable: false };
      case "serverOverloaded":
        return { class: "overloaded", origin: "provider", retryable: true };
      case "internalServerError":
        return { class: "upstream", origin: "provider", retryable: true };
      case "unauthorized":
        return { class: "auth", origin: "provider", retryable: false };
      case "badRequest":
        return { class: "invalid-request", origin: "provider", retryable: false };
      case "cyberPolicy":
        return { class: "policy", origin: "provider", retryable: false };
      case "sandboxError":
        return { class: "sandbox", origin: "harness", retryable: false };
      default:
        return null;
    }
  }
  // Object variants are all connection/stream failures → retryable transport.
  if (asRecord(info) !== null) {
    return { class: "upstream", origin: "transport", retryable: true };
  }
  return null;
}

/** Message-shape inference, the fallback when there is no `codexErrorInfo`. */
function inferFromMessage(message: string): {
  class: ErrorClass;
  origin: ErrorOrigin;
  retryable: boolean;
} {
  const lower = message.toLowerCase();
  if (/rate.?limit|429|too many requests/.test(lower)) {
    return { class: "rate-limit", origin: "provider", retryable: true };
  }
  if (/quota|insufficient|billing|budget/.test(lower)) {
    return { class: "quota-exhausted", origin: "provider", retryable: false };
  }
  if (/unauthor|forbidden|401|403|auth|expired/.test(lower)) {
    return { class: "auth", origin: "provider", retryable: false };
  }
  if (/context length|too long|maximum context/.test(lower)) {
    return { class: "context-overflow", origin: "provider", retryable: false };
  }
  if (/overloaded|503|unavailable/.test(lower)) {
    return { class: "overloaded", origin: "provider", retryable: true };
  }
  if (/stream disconnected|connection|econn|network|sending request|timeout/.test(lower)) {
    return { class: "upstream", origin: "transport", retryable: true };
  }
  return { class: "unknown", origin: "harness", retryable: false };
}

/**
 * Map a Codex turn/transport failure into the normalized taxonomy. Precedence:
 * the native `codexErrorInfo` (authoritative), then the JSON-RPC error code, then
 * the failure `source`, then message-shape inference. The native `message` is
 * preserved verbatim (auth expiry included) — never summarized away.
 */
export function mapCodexError(err: CodexTurnError): HarnessError {
  const message = err.message;
  let classified = classifyCodexErrorInfo(err.codexErrorInfo);
  if (classified === null && err.source === "jsonrpc" && err.code !== undefined) {
    // -32001 = "Server overloaded; retry later"; -32601 = method not found.
    classified =
      err.code === -32001
        ? { class: "overloaded", origin: "transport", retryable: true }
        : { class: "protocol", origin: "transport", retryable: false };
  }
  if (
    classified === null &&
    (err.source === "exit" || err.source === "spawn" || err.source === "parse")
  ) {
    classified =
      err.source === "spawn"
        ? { class: "harness-unavailable", origin: "harness", retryable: false }
        : { class: "protocol", origin: "transport", retryable: false };
  }
  const resolved = classified ?? inferFromMessage(message);
  return {
    class: resolved.class,
    origin: resolved.origin,
    message,
    retryable: resolved.retryable,
    retryableSource: "inferred",
    nativeCode:
      err.code !== undefined
        ? String(err.code)
        : err.exitCode != null
          ? String(err.exitCode)
          : null,
  };
}

/**
 * A stateful per-turn normalizer over the app-server notification stream. Codex
 * streaming needs cross-frame state (the last agent message for structured-output
 * parsing, the terminal usage, a seen error), so unlike Claude's pure per-frame
 * map this closes over it. The terminal outcome is driven by the synthetic
 * `turn-result` frame — the authoritative carrier of the final status, message,
 * and usage — with the streamed state as a fallback.
 */
function createCodexNormalizer(
  context: EnvelopeContext,
  spec: CodexTurnSpec,
): { normalize: (frame: unknown) => HarnessEvent[]; finalize: () => HarnessEvent[] } {
  const schemaRequested = spec.outputSchema !== undefined;
  let lastMessageText: string | null = null;
  let lastUsage: RspTokenUsage | undefined;
  let seenError: CodexTurnError | null = null;
  let sessionStarted = false;
  let terminated = false;

  const passthrough = (frame: unknown, nativeKind: string): HarnessEvent[] => [
    { ...envelope(context, frame), kind: "passthrough", nativeKind },
  ];

  function parseStructured(raw: string | null): unknown {
    if (!schemaRequested || raw === null) return undefined;
    try {
      // Reuse the utility port's null-stripping: a sanitized outputSchema forces
      // optionals to required-nullable, so the model emits nulls; stripping them
      // restores the field's absent semantics for the on-disk validator.
      return stripNullDeep(JSON.parse(raw));
    } catch {
      return undefined;
    }
  }

  function terminal(frame: CodexTurnResultFrame): HarnessEvent[] {
    terminated = true;
    const finalRaw = frame.finalMessage ?? lastMessageText;
    if (frame.status === "cancelled") {
      return [
        {
          ...envelope(context, frame),
          kind: "session.ended",
          outcome: { status: "cancelled", partial: finalRaw !== null },
        },
      ];
    }
    if (frame.status === "failed") {
      const error = mapCodexError(
        frame.error ?? seenError ?? { source: "exit", message: "codex turn failed" },
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
    const usage = frame.usage ?? lastUsage;
    const structuredOutput = parseStructured(finalRaw);
    const finalText = finalRaw ?? "";
    const outcome =
      structuredOutput === undefined
        ? { status: "completed" as const, finalText, ...(usage ? { usage } : {}) }
        : {
            status: "completed" as const,
            finalText,
            structuredOutput,
            ...(usage ? { usage } : {}),
          };
    return [{ ...envelope(context, frame), kind: "session.ended", outcome }];
  }

  function normalize(frame: unknown): HarnessEvent[] {
    const record = asRecord(frame);
    if (!record) return passthrough(frame, "non-object");

    // The seam's synthetic terminal frame (owned here, not a codex notification).
    if (record.rennet === "turn-result") {
      return terminal(record as unknown as CodexTurnResultFrame);
    }

    // A foreign-thread/turn notification the runner has already judged NOT ours:
    // surface it (never dropped) but never let it touch our text/usage or outcome.
    if (record.rennet === "foreign") {
      return passthrough(record.native, "foreign");
    }

    const method = stringField(record, "method");
    if (method === null) return passthrough(frame, "unknown");
    const params = asRecord(record.params) ?? {};

    switch (method) {
      case "turn/started": {
        if (sessionStarted) return passthrough(frame, method);
        sessionStarted = true;
        return [
          {
            ...envelope(context, frame),
            kind: "session.started",
            model: spec.model ?? "",
            cwd: spec.cwd,
            tools: [],
            apiKeySource: null,
          },
        ];
      }
      case "item/agentMessage/delta": {
        const delta = stringField(params, "delta") ?? "";
        return [{ ...envelope(context, frame), kind: "text.delta", text: delta }];
      }
      case "item/started":
      case "item/completed": {
        const item = asRecord(params.item);
        const itemType = item ? stringField(item, "type") : null;
        if (!item || itemType === null) return passthrough(frame, method);
        if (itemType === "agentMessage") {
          const text = stringField(item, "text") ?? "";
          if (method === "item/completed") {
            lastMessageText = text;
            return [
              { ...envelope(context, frame), kind: "text.message", text, parentToolCallId: null },
            ];
          }
          return passthrough(frame, `item:${itemType}`);
        }
        const normalizedKind = classifyCodexItemKind(itemType);
        if (normalizedKind === "other") return passthrough(frame, `item:${itemType}`);
        const started: HarnessEvent = {
          ...envelope(context, frame),
          kind: "tool.started",
          call: {
            id: stringField(item, "id") ?? randomUUID(),
            name: toolName(item, itemType),
            input: toolInput(item),
            parentToolCallId: null,
            kind: normalizedKind,
          },
        };
        if (method === "item/started") return [started];
        const completed = toolOutput(context, frame, item, itemType);
        // Codex emits file changes only as completed items, so synthesize the
        // matching start immediately before their output. Command/MCP items have a
        // real `item/started` frame, so their completed maps only to output.
        return itemType === "fileChange" ? [started, completed] : [completed];
      }
      case "thread/tokenUsage/updated": {
        const tu = asRecord(params.tokenUsage);
        lastUsage = mapTokenUsageBreakdown(asRecord(tu?.total) ?? asRecord(tu?.last)) ?? lastUsage;
        return passthrough(frame, method);
      }
      case "error": {
        // An ErrorNotification (mid-turn provider error). The authoritative failure
        // still arrives on the terminal frame; capture this as a fallback.
        const err = asRecord(params.error);
        seenError = {
          source: "turn",
          message: (err && stringField(err, "message")) ?? "codex error",
          ...(err?.codexErrorInfo === undefined ? {} : { codexErrorInfo: err.codexErrorInfo }),
        };
        return passthrough(frame, method);
      }
      default:
        return passthrough(frame, method);
    }
  }

  /** If the stream ended without a terminal frame, close with a protocol failure
   *  rather than hanging the session open. */
  function finalize(): HarnessEvent[] {
    if (terminated) return [];
    const error: HarnessError = {
      class: "protocol",
      origin: "transport",
      message: "codex transport ended without a terminal turn-result frame",
      retryable: false,
      retryableSource: "inferred",
      nativeCode: null,
    };
    return [
      { ...envelope(context, {}), kind: "error", error },
      { ...envelope(context, {}), kind: "session.ended", outcome: { status: "failed", error } },
    ];
  }

  return { normalize, finalize };
}

// ── The session + adapter ────────────────────────────────────────────────────

/** A minimal unbounded async queue: the pump pushes, the consumer's async iterator
 *  reads. Unbounded is correct here — one codex turn is a FINITE frame stream, so the
 *  buffer cannot grow without end; a bounded ring would risk dropping frames (the
 *  never-dropped contract). ponytail: unbounded queue, revisit only if a turn ever
 *  streams unboundedly (it does not). */
function createEventQueue(): {
  push: (event: HarnessEvent) => void;
  close: () => void;
  iterable: AsyncIterable<HarnessEvent>;
} {
  const buffer: HarnessEvent[] = [];
  let done = false;
  let wake: (() => void) | null = null;
  const ping = (): void => {
    wake?.();
    wake = null;
  };
  return {
    push: (event) => {
      buffer.push(event);
      ping();
    },
    close: () => {
      done = true;
      ping();
    },
    iterable: {
      async *[Symbol.asyncIterator](): AsyncIterator<HarnessEvent> {
        while (true) {
          if (buffer.length > 0) {
            yield buffer.shift() as HarnessEvent;
            continue;
          }
          if (done) return;
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
      },
    },
  };
}

class CodexSession implements HarnessSession {
  readonly id: string;
  readonly harness = HARNESS_ID;
  readonly #transport: CodexTurnTransport;
  readonly #spec: SessionSpec;
  readonly #config: CodexAdapterConfig;
  readonly #context: EnvelopeContext;
  readonly #abort: AbortController;
  readonly #started: Promise<AsyncIterable<unknown>>;
  readonly #queue = createEventQueue();
  readonly #completion: Promise<void>;
  #resolveCompletion!: () => void;
  #resolveStarted!: (iterable: AsyncIterable<unknown>) => void;
  #sent = false;
  #eventsTaken = false;
  #pumpStarted = false;

  constructor(
    id: string,
    turnId: string,
    transport: CodexTurnTransport,
    spec: SessionSpec,
    config: CodexAdapterConfig,
    now: () => number,
    abort: AbortController,
  ) {
    this.id = id;
    this.#transport = transport;
    this.#spec = spec;
    this.#config = config;
    this.#abort = abort;
    this.#context = { harness: HARNESS_ID, sessionId: id, turnId, seq: createSeqCounter(), now };
    this.#started = new Promise((resolve) => {
      this.#resolveStarted = resolve;
    });
    this.#completion = new Promise((resolve) => {
      this.#resolveCompletion = resolve;
    });
  }

  get events(): AsyncIterable<HarnessEvent> {
    if (this.#eventsTaken) {
      throw new Error("Codex session events may only be subscribed to once");
    }
    this.#eventsTaken = true;
    this.#startPump();
    return this.#queue.iterable;
  }

  /**
   * Drive the transport with an INDEPENDENT pump: eagerly consume every transport
   * frame into the queue, so run completion tracks the transport/process finishing —
   * NOT consumer drainage. This is what lets a caller await `interrupt()`/`close()`
   * from INSIDE its own `for await` body without deadlocking (the consumer parked at
   * a yield no longer gates completion). Started once, when events is subscribed.
   */
  #startPump(): void {
    if (this.#pumpStarted) return;
    this.#pumpStarted = true;
    const { normalize, finalize } = createCodexNormalizer(this.#context, this.#turnSpec());
    const queue = this.#queue;
    const context = this.#context;
    void (async () => {
      try {
        const iterable = await this.#started;
        for await (const frame of iterable) {
          for (const event of normalize(frame)) queue.push(event);
        }
        for (const event of finalize()) queue.push(event);
      } catch (error) {
        // The transport threw before a terminal frame (e.g. an untranslatable WSL
        // repo path). Surface it as an honest failed outcome rather than an unhandled
        // rejection or a hung session.
        const message = error instanceof Error ? error.message : String(error);
        const harnessError: HarnessError = {
          class: "protocol",
          origin: "harness",
          message,
          retryable: false,
          retryableSource: "inferred",
          nativeCode: null,
        };
        queue.push({ ...envelope(context, {}), kind: "error", error: harnessError });
        queue.push({
          ...envelope(context, {}),
          kind: "session.ended",
          outcome: { status: "failed", error: harnessError },
        });
      } finally {
        queue.close();
        this.#resolveCompletion();
      }
    })();
  }

  #turnSpec(): CodexTurnSpec {
    return {
      cwd: this.#spec.cwd,
      prompt: "",
      ...(this.#spec.model === undefined ? {} : { model: this.#spec.model }),
      ...(this.#spec.outputSchema === undefined ? {} : { outputSchema: this.#spec.outputSchema }),
      ...(this.#config.mcpServers === undefined ? {} : { mcpServers: this.#config.mcpServers }),
      signal: this.#abort.signal,
    };
  }

  send(input: TurnInput): Promise<string> {
    if (this.#sent) throw new Error("This session has already run a turn (slice 1 is single-turn)");
    this.#sent = true;
    const iterable = this.#transport({ ...this.#turnSpec(), prompt: input.prompt });
    this.#resolveStarted(iterable);
    return Promise.resolve(this.#context.turnId ?? this.id);
  }

  async interrupt(): Promise<void> {
    this.#abort.abort();
    // Await the independent pump (transport/process completion), NOT consumer
    // drainage — so this resolves even when called from inside the caller's own
    // `for await` body. If no turn is running (no pump), aborting is all there is.
    if (this.#pumpStarted) await this.#completion;
  }

  async close(): Promise<void> {
    this.#abort.abort();
    if (this.#pumpStarted) await this.#completion;
  }
}

export interface CodexAdapterConfig {
  readonly binaryPath: string;
  /** The injected turn transport. The composition root supplies the real spawn. */
  readonly transport: CodexTurnTransport;
  readonly version?: string;
  readonly probeVersion?: (path: string) => Promise<string | null>;
  readonly now?: () => number;
  /**
   * The descriptor's capability flags, DERIVED from passing conformance checks
   * (never declared). Default empty → every layer false. The composition root
   * feeds a hermetic self-conformance run's `implementedByAdapter` evidence.
   */
  readonly capabilityEvidence?: CapabilityEvidence;
  /** Loopback MCP servers (canvasOps@2) applied to every session's turn spec. */
  readonly mcpServers?: Readonly<Record<string, { readonly url: string }>>;
}

export class CodexAdapter implements HarnessPort {
  readonly descriptor: HarnessDescriptor;
  readonly #config: CodexAdapterConfig;
  readonly #now: () => number;
  readonly #range: { readonly min: string; readonly maxTested: string };

  constructor(config: CodexAdapterConfig) {
    this.#config = config;
    this.#now = config.now ?? Date.now;
    this.#range = readTestedRange(HARNESS_ID) ?? { min: "0.0.0", maxTested: "0.0.0" };
    this.descriptor = {
      id: HARNESS_ID,
      displayName: DISPLAY_NAME,
      version: config.version ?? "unknown",
      binaryPath: config.binaryPath,
      capabilities: buildCapabilities(config.capabilityEvidence ?? {}),
      testedRange: this.#range,
    };
  }

  async health(): Promise<HarnessHealth> {
    const probe = this.#config.probeVersion;
    if (!probe) {
      const version = this.#config.version;
      return version
        ? healthForRange(version, this.#range)
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
      if (spec.signal.aborted) abort.abort();
      else spec.signal.addEventListener("abort", () => abort.abort(), { once: true });
    }
    const sessionId = randomUUID();
    return Promise.resolve(
      new CodexSession(
        sessionId,
        randomUUID(),
        this.#config.transport,
        spec,
        this.#config,
        this.#now,
        abort,
      ),
    );
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
