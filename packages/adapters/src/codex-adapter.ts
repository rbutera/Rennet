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
import type { RspTokenUsage } from "@rennet/protocol";
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

/**
 * Generous default ceiling on the events buffered-but-not-yet-consumed by a slow
 * consumer. A finite turn drains near-instantly, so this is never hit in normal
 * use; it exists so a HUNG command streaming forever fails LOUDLY (an honest failed
 * outcome naming the ceiling) instead of growing the buffer until the app OOMs. Not
 * a gate — a real turn never approaches it. Overridable via `CodexAdapterConfig`.
 */
const DEFAULT_MAX_BUFFERED_EVENTS = 200_000;
const DEFAULT_MAX_BUFFERED_BYTES = 128 * 1024 * 1024; // 128 MiB of retained content

/** Approximate the retained size of one event (chars ≈ bytes for the JSON content). */
function eventSize(event: HarnessEvent): number {
  try {
    return JSON.stringify(event).length;
  } catch {
    return 0; // codex frames are plain JSON, so this is defensive only
  }
}

/**
 * A bounded async queue: the pump pushes, the consumer's async iterator reads. An
 * INDEX CURSOR (not `Array.shift`) drains in O(1) — no quadratic cost on a large
 * backlog. It tracks the currently-buffered (unread) event count and byte total and
 * raises `overflowed` when either exceeds the ceiling; the pump reads that flag and
 * fails the turn (the queue itself never drops an event below the ceiling — the
 * never-dropped contract holds).
 */
function createEventQueue(
  maxEvents: number,
  maxBytes: number,
): {
  /** Accept the event within the ceiling; returns false (and flags overflow) if the PROJECTED size would cross it. */
  push: (event: HarnessEvent) => boolean;
  /** Ceiling-exempt push for the exactly-once settlement path (a terminal or teardown evidence must always land). */
  forcePush: (event: HarnessEvent) => void;
  readonly overflowed: boolean;
  close: () => void;
  iterable: AsyncIterable<HarnessEvent>;
} {
  // Compact the drained prefix once it reaches this many slots, so a long-lived
  // stream with a keeping-up consumer cannot grow the backing array forever.
  const COMPACT_AT = 1024;
  const buffer: ({ event: HarnessEvent; size: number } | undefined)[] = [];
  let head = 0;
  let bufferedBytes = 0;
  let done = false;
  let overflowed = false;
  let wake: (() => void) | null = null;
  const ping = (): void => {
    wake?.();
    wake = null;
  };
  const accept = (event: HarnessEvent, size: number): void => {
    buffer.push({ event, size });
    bufferedBytes += size;
    ping();
  };
  return {
    push: (event) => {
      const size = eventSize(event);
      // Check the PROJECTED occupancy BEFORE accepting, so even a legitimate
      // terminal cannot slip past the ceiling (the pump replaces a rejected
      // terminal with the single failed-at-ceiling terminal).
      if (buffer.length - head + 1 > maxEvents || bufferedBytes + size > maxBytes) {
        overflowed = true;
        return false;
      }
      accept(event, size);
      return true;
    },
    forcePush: (event) => {
      accept(event, eventSize(event));
    },
    get overflowed() {
      return overflowed;
    },
    close: () => {
      done = true;
      ping();
    },
    iterable: {
      async *[Symbol.asyncIterator](): AsyncIterator<HarnessEvent> {
        while (true) {
          if (head < buffer.length) {
            const entry = buffer[head] as { event: HarnessEvent; size: number };
            buffer[head] = undefined; // release the reference for GC
            head += 1;
            bufferedBytes -= entry.size;
            if (head >= COMPACT_AT) {
              buffer.splice(0, head); // drop the drained prefix's backing slots
              head = 0;
            }
            yield entry.event;
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
  readonly #maxEvents: number;
  readonly #maxBytes: number;
  readonly #queue: ReturnType<typeof createEventQueue>;
  readonly #completion: Promise<void>;
  #resolveCompletion!: () => void;
  #sent = false;
  #closed = false;
  #eventsTaken = false;

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
    this.#maxEvents = config.bufferCeiling?.maxEvents ?? DEFAULT_MAX_BUFFERED_EVENTS;
    this.#maxBytes = config.bufferCeiling?.maxBytes ?? DEFAULT_MAX_BUFFERED_BYTES;
    this.#queue = createEventQueue(this.#maxEvents, this.#maxBytes);
    this.#completion = new Promise((resolve) => {
      this.#resolveCompletion = resolve;
    });
  }

  get events(): AsyncIterable<HarnessEvent> {
    if (this.#eventsTaken) {
      throw new Error("Codex session events may only be subscribed to once");
    }
    this.#eventsTaken = true;
    return this.#queue.iterable;
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

  #failedTerminal(error: HarnessError): HarnessEvent[] {
    return [
      { ...envelope(this.#context, {}), kind: "error", error },
      {
        ...envelope(this.#context, {}),
        kind: "session.ended",
        outcome: { status: "failed", error },
      },
    ];
  }

  /**
   * Drive the transport with an INDEPENDENT pump: eagerly consume every transport
   * frame into the queue, so run completion tracks the transport/process finishing —
   * NOT consumer drainage. This is what lets a caller await `interrupt()`/`close()`
   * from INSIDE its own `for await` body without deadlocking. Started once, from
   * `send()`. A single settlement guard (`ended`) guarantees EXACTLY ONE terminal
   * outcome: a pre-terminal throw or a buffer overflow produces one failed
   * `session.ended`; a post-terminal teardown throw is surfaced as non-terminal
   * evidence, never a second `session.ended`.
   */
  #startPump(iterable: AsyncIterable<unknown>): void {
    const { normalize, finalize } = createCodexNormalizer(this.#context, this.#turnSpec());
    const queue = this.#queue;
    let ended = false;
    let overflowTerminated = false;
    const settleFailed = (error: HarnessError): void => {
      if (ended) return;
      ended = true;
      // forcePush: the exactly-once settlement must land even at the ceiling.
      for (const event of this.#failedTerminal(error)) queue.forcePush(event);
    };
    const enqueue = (event: HarnessEvent): void => {
      // Once settled, the terminal is the LAST event — drop any remaining events
      // of the same doomed normalized batch instead of enqueuing them after it.
      if (ended) return;
      if (queue.push(event)) {
        if (event.kind === "session.ended") ended = true;
        return;
      }
      // Rejected at the PROJECTED ceiling — even a legitimate terminal is replaced
      // by the single failed-at-ceiling terminal (never a silent drop, never two).
      overflowTerminated = true;
      settleFailed({
        class: "protocol",
        origin: "transport",
        message: `codex streamed past the session buffer ceiling (${this.#maxEvents} events / ${this.#maxBytes} bytes) without completing; failing the turn to avoid unbounded memory`,
        retryable: false,
        retryableSource: "inferred",
        nativeCode: null,
      });
    };
    void (async () => {
      try {
        for await (const frame of iterable) {
          for (const event of normalize(frame)) {
            enqueue(event);
            if (overflowTerminated) break; // settlement replaced the rest of this batch
          }
          if (overflowTerminated) break; // stop consuming; the transport's finally kills the child
        }
        if (!ended) for (const event of finalize()) enqueue(event);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (ended) {
          // A terminal already went out (e.g. the transport threw during teardown
          // AFTER yielding its terminal): surface the throw as evidence only.
          // forcePush — evidence must land even if the ceiling was reached.
          queue.forcePush({
            ...envelope(this.#context, { message }),
            kind: "passthrough",
            nativeKind: "transport-teardown-error",
          });
        } else {
          // The transport threw BEFORE a terminal (e.g. an untranslatable WSL repo
          // path): one honest failed outcome, never a hang or unhandled rejection.
          settleFailed({
            class: "protocol",
            origin: "harness",
            message,
            retryable: false,
            retryableSource: "inferred",
            nativeCode: null,
          });
        }
      } finally {
        queue.close();
        this.#resolveCompletion();
      }
    })();
  }

  send(input: TurnInput): Promise<string> {
    if (this.#closed)
      throw new Error("This session is closed (close() or interrupt() already settled it)");
    if (this.#sent) throw new Error("This session has already run a turn (slice 1 is single-turn)");
    this.#sent = true;
    this.#startPump(this.#transport({ ...this.#turnSpec(), prompt: input.prompt }));
    return Promise.resolve(this.#context.turnId ?? this.id);
  }

  #shutdown(): Promise<void> {
    this.#closed = true; // a settled session rejects any later send()
    this.#abort.abort();
    if (this.#sent) {
      // A turn is running: abort makes the transport finish; await the pump (process
      // completion), NOT consumer drainage — safe to call from inside a for-await body.
      return this.#completion;
    }
    // No turn was ever sent: settle directly so close()/interrupt() is ALWAYS
    // available (port contract) and any subscribed-but-idle consumer unblocks.
    this.#queue.close();
    this.#resolveCompletion();
    return Promise.resolve();
  }

  interrupt(): Promise<void> {
    return this.#shutdown();
  }

  close(): Promise<void> {
    return this.#shutdown();
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
  /** Override the per-session events-buffer ceiling (defaults are generous; a real
   *  turn never approaches them). Exists so a hung, forever-streaming command fails
   *  loudly instead of OOMing — and so tests can exercise the overflow path. */
  readonly bufferCeiling?: { readonly maxEvents: number; readonly maxBytes: number };
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
