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
import { compareVersions } from "./harness-discovery";
import { readTestedRange, type TestedRange } from "./harness-tested-range";

/**
 * The omp adapter (#26): the THIRD harness slot (R23), peer of `ClaudeAdapter`
 * and `CodexAdapter`. It drives the user's own installed `omp`
 * (`@oh-my-pi/pi-coding-agent`, bin `omp` — NEVER the abandoned npm namesake
 * `oh-my-pi`) through the normalized `HarnessPort`.
 *
 * Transport verdict (design §1): the adapter speaks `omp --mode rpc` line-delimited
 * JSON behind an injected `OmpTurnTransport` seam — the third instance of the
 * `ClaudeQueryFn` / `CodexTurnTransport` pattern. `omp acp` is NOT the transport:
 * ACP's distinguishing machinery is `session/request_permission` write-gating, which
 * is approval apparatus Rennet does not build (Rule Zero). The wire mapping restricts
 * itself to the RPC subset shared with `pi` (R23's compatible subset).
 *
 * The one honesty constraint that shapes this file: NO turn has ever been executed
 * against `omp`. Every wire shape here comes from the installed `.d.ts` files, not an
 * observed byte stream. So the decoders are tolerant and passthrough-by-default (a
 * wrong guess surfaces as `passthrough`, never a dropped or misclaimed frame), and
 * every descriptor flag is evidence-derived — a fresh adapter with no conformance
 * evidence advertises nothing. The composition root (`omp-turn-transport.ts`) owns
 * the real spawn; this file is pure over the injected transport. It never reads a
 * credential: `omp` authenticates itself on the user's own configuration.
 */

const HARNESS_ID = "omp" as const;
const DISPLAY_NAME = "Oh My Pi";

// ── The injected transport seam (mirror of CodexTurnTransport) ───────────────

/** One agentic turn's spec. `cwd` is a REAL repo (the review worktree). */
export interface OmpTurnSpec {
  readonly cwd: string;
  readonly prompt: string;
  /** omp's own default when absent; the composition passes e.g. "opus" / "gpt-5.2". */
  readonly model?: string;
  readonly outputSchema?: unknown;
  /** Loopback canvasOps@2 (and future) MCP servers, rendered into scratch `mcp.json`. */
  readonly mcpServers?: Readonly<Record<string, { readonly url: string }>>;
  readonly signal?: AbortSignal;
}

/**
 * The transport yields the raw `omp --mode rpc` JSONL frames, then EXACTLY ONE
 * synthetic terminal frame `{ rennet: "turn-result", ... }`. The adapter owns
 * normalization, seq, and the terminal outcome — the exit code and final captured
 * text ride the terminal frame.
 */
export type OmpTurnTransport = (spec: OmpTurnSpec) => AsyncIterable<unknown>;

/** The synthetic terminal frame the transport appends. Owned by the seam, not omp. */
export interface OmpTurnResultFrame {
  readonly rennet: "turn-result";
  readonly exitCode: number;
  /** The final assistant text the transport observed, or null when it saw none. */
  readonly finalText: string | null;
  readonly aborted?: boolean;
  readonly stderr?: string;
  /** Original construction/iteration failure retained as native terminal evidence. */
  readonly failure?: unknown;
}

// ── Pure argv assembly (composition-root transport uses this; asserted alone) ──

export interface OmpTurnArgs {
  readonly cwd: string;
  readonly model?: string;
  /** Scratch extension root carrying omp's supported `mcp.json` discovery source. */
  readonly extensionPath?: string;
}

/**
 * Assemble the `omp --mode rpc` argv for a single capable-by-default turn. Pinned
 * against the installed binary's `--help` (omp 17.1.3):
 *
 * - `--mode rpc` — the line-delimited JSON RPC transport (the `pi`-compatible surface;
 *   NOT `acp`, whose center of gravity is a permission-request protocol).
 * - `--auto-approve` — the Rule Zero acting path: full capability, no approval prompts,
 *   the mirror of the Codex `--dangerously-bypass-approvals-and-sandbox` posture. NEVER
 *   `--approval-mode always-ask` (the write-gating posture Rennet refuses to build).
 * - `--no-session` — ephemeral, fresh per turn: nothing accumulates in `~/.omp` session
 *   dirs (the single-turn contract every live `HarnessPort` consumer holds).
 * - `--cwd <cwd>` — the session's REAL repo.
 * - `--model <model>` — only when the council named one.
 * - `--extension <path>` — a scratch extension root containing `mcp.json`, only when
 *   the spec carries servers. `--config` is a settings overlay and is not an MCP source.
 *
 * The prompt is NOT positional: in RPC mode it is sent as a `{ type: "prompt" }` command
 * on stdin (the transport's job). Pure, so flags are asserted without spawning.
 */
export function buildOmpTurnArgs(spec: OmpTurnArgs): string[] {
  const args = ["--mode", "rpc", "--auto-approve", "--no-session", "--cwd", spec.cwd];
  if (spec.model !== undefined) args.push("--model", spec.model);
  if (spec.extensionPath !== undefined) args.push("--extension", spec.extensionPath);
  return args;
}

/** The `{ type: "prompt" }` RPC command the transport writes to stdin, as one JSONL line. */
export function encodeOmpPromptFrame(prompt: string): string {
  return `${JSON.stringify({ type: "prompt", message: prompt })}\n`;
}

// ── Frame normalization ──────────────────────────────────────────────────────

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" ? value : null;
}

/** Classify an omp tool name into the normalized `ToolKind`. Heuristic over the name
 *  (omp reports a tool name, not a typed item kind); tolerant, corrected on a real run. */
export function classifyOmpToolKind(name: string): ToolKind {
  const n = name.toLowerCase();
  if (n.includes("mcp") || n.includes("__")) return "mcp";
  if (/(^|[_.])(bash|exec|shell|run|pty|command)/.test(n)) return "exec";
  if (/(^|[_.])(write|edit|apply|patch|create|multiedit)/.test(n)) return "write";
  if (/(^|[_.])(read|cat|view|open)/.test(n)) return "read";
  if (/(^|[_.])(grep|search|web|find|glob|ls)/.test(n)) return "search";
  if (/(^|[_.])(task|agent|subagent)/.test(n)) return "subagent";
  return "other";
}

/**
 * Map an omp failure into the normalized taxonomy. omp error frames carry free-text,
 * so the class is inferred from the message shape (mirror of `mapCodexError`), origin
 * defaults to `harness`, with connection failures attributed to `transport` and
 * provider throttle strings to `provider`.
 */
export function mapOmpError(message: string, exitCode: number | null): HarnessError {
  const lower = message.toLowerCase();
  let cls: ErrorClass = "unknown";
  let origin: ErrorOrigin = "harness";
  let retryable = false;
  if (/rate.?limit|429|too many requests/.test(lower)) {
    cls = "rate-limit";
    origin = "provider";
    retryable = true;
  } else if (/quota|insufficient|billing|budget/.test(lower)) {
    cls = "quota-exhausted";
    origin = "provider";
  } else if (/unauthor|forbidden|401|403|auth/.test(lower)) {
    cls = "auth";
    origin = "provider";
  } else if (/context length|too long|maximum context/.test(lower)) {
    cls = "context-overflow";
    origin = "provider";
  } else if (/overloaded|503|unavailable/.test(lower)) {
    cls = "overloaded";
    origin = "provider";
    retryable = true;
  } else if (/disconnect|connection|econn|network|socket|timeout/.test(lower)) {
    cls = "upstream";
    origin = "transport";
    retryable = true;
  }
  return {
    class: cls,
    origin,
    message,
    retryable,
    retryableSource: "inferred",
    nativeCode: exitCode === null ? null : String(exitCode),
  };
}

/** The final assistant text off an omp message frame's `content: [{type:"text",text}]`. */
function assistantText(message: unknown): string | null {
  const record = asRecord(message);
  if (!record) return null;
  const content = record.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return stringField(record, "text");
  const parts: string[] = [];
  for (const part of content) {
    const p = asRecord(part);
    if (p && p.type === "text" && typeof p.text === "string") parts.push(p.text);
  }
  return parts.length > 0 ? parts.join("") : null;
}

/**
 * A stateful per-turn normalizer. Like codex, omp streaming needs cross-frame state
 * (the last assistant text and a seen error); the terminal outcome is
 * driven by the synthetic `turn-result` frame — the only carrier of exit code and
 * captured text — enriched by what the stream showed.
 */
function createOmpNormalizer(
  context: EnvelopeContext,
  spec: OmpTurnSpec,
): {
  normalize: (frame: unknown) => HarnessEvent[];
  fail: (error: unknown) => HarnessEvent[];
  finalize: () => HarnessEvent[];
} {
  let started = false;
  let lastText: string | null = null;
  let seenError: HarnessError | null = null;
  let seenErrorEmitted = false;
  let terminated = false;

  const passthrough = (frame: unknown, nativeKind: string): HarnessEvent[] => [
    { ...envelope(context, frame), kind: "passthrough", nativeKind },
  ];

  function errorMessage(value: unknown, fallback: string): string {
    if (value instanceof Error) return value.message;
    if (typeof value === "string") return value;
    try {
      return JSON.stringify(value);
    } catch {
      return fallback;
    }
  }

  function recordError(frame: unknown, error: HarnessError): HarnessEvent[] {
    if (seenError === null) seenError = error;
    seenErrorEmitted = true;
    return [{ ...envelope(context, frame), kind: "error", error }];
  }

  function sessionStarted(frame: unknown): HarnessEvent[] {
    started = true;
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

  function terminal(frame: OmpTurnResultFrame): HarnessEvent[] {
    if (terminated) return [];
    terminated = true;
    if (frame.aborted) {
      return [
        {
          ...envelope(context, frame),
          kind: "session.ended",
          outcome: { status: "cancelled", partial: lastText !== null },
        },
      ];
    }
    if (frame.exitCode !== 0 || seenError) {
      const error =
        seenError ??
        mapOmpError(frame.stderr?.trim() || `omp exited ${frame.exitCode}`, frame.exitCode);
      return [
        ...(seenErrorEmitted
          ? []
          : [{ ...envelope(context, frame), kind: "error" as const, error }]),
        {
          ...envelope(context, frame),
          kind: "session.ended",
          outcome: { status: "failed", error },
        },
      ];
    }
    const raw = frame.finalText ?? lastText;
    const finalText = raw ?? "";
    return [
      {
        ...envelope(context, frame),
        kind: "session.ended",
        outcome: { status: "completed", finalText },
      },
    ];
  }

  function normalize(frame: unknown): HarnessEvent[] {
    const record = asRecord(frame);
    if (!record) return passthrough(frame, "non-object");

    // The seam's synthetic terminal frame (owned here, not an omp frame).
    if (record.rennet === "turn-result") {
      return terminal(record as unknown as OmpTurnResultFrame);
    }
    if (record.rennet === "protocol-failure") {
      const message = stringField(record, "message") ?? "omp emitted an invalid RPC frame";
      return recordError(frame, {
        class: "protocol",
        origin: "transport",
        message,
        retryable: false,
        retryableSource: "inferred",
        nativeCode: stringField(record, "reason"),
      });
    }

    const type = stringField(record, "type");
    switch (type) {
      case "ready":
      case "agent_start":
        return started ? passthrough(frame, type) : sessionStarted(frame);
      case "message_update": {
        const event = asRecord(record.assistantMessageEvent);
        if (event && event.type === "text_delta" && typeof event.delta === "string") {
          return [
            {
              ...envelope(context, frame),
              kind: "text.delta",
              text: event.delta,
            },
          ];
        }
        return passthrough(frame, "message_update");
      }
      case "message_end":
      case "turn_end": {
        const text = assistantText(record.message);
        if (text !== null) {
          lastText = text;
          return [
            {
              ...envelope(context, frame),
              kind: "text.message",
              text,
              parentToolCallId: null,
            },
          ];
        }
        return passthrough(frame, type);
      }
      case "agent_end": {
        // The final `messages` array may carry the terminal assistant text.
        const messages = record.messages;
        if (Array.isArray(messages)) {
          for (let i = messages.length - 1; i >= 0; i -= 1) {
            const text = assistantText(messages[i]);
            if (text !== null) {
              lastText = text;
              break;
            }
          }
        }
        return passthrough(frame, "agent_end");
      }
      case "tool_execution_start": {
        const id = stringField(record, "toolCallId") ?? randomUUID();
        const name = stringField(record, "toolName") ?? "tool";
        const input = asRecord(record.args) ?? {};
        return [
          {
            ...envelope(context, frame),
            kind: "tool.started",
            call: {
              id,
              name,
              input,
              parentToolCallId: null,
              kind: classifyOmpToolKind(name),
            },
          },
        ];
      }
      case "tool_execution_end": {
        const id = stringField(record, "toolCallId") ?? "unknown";
        const isError = record.isError === true;
        const output = record.result ?? null;
        return [
          {
            ...envelope(context, frame),
            kind: "tool.output",
            callId: id,
            ok: !isError,
            output,
            text: typeof output === "string" ? output : JSON.stringify(output),
          },
        ];
      }
      case "response": {
        if (record.success === false) {
          const message = errorMessage(record.error, "omp RPC command failed");
          return recordError(frame, mapOmpError(message, null));
        }
        return passthrough(frame, `response:${stringField(record, "command") ?? "unknown"}`);
      }
      case "error": {
        const message =
          stringField(record, "message") ?? stringField(record, "error") ?? "omp error";
        return recordError(frame, mapOmpError(message, null));
      }
      default:
        return passthrough(frame, type ?? "unknown");
    }
  }

  function fail(value: unknown): HarnessEvent[] {
    if (terminated) return [];
    const message = errorMessage(value, "omp transport failed");
    return terminal({
      rennet: "turn-result",
      exitCode: 1,
      finalText: null,
      stderr: message,
      failure: value,
    });
  }

  /** If the stream ended without a terminal frame, close with a protocol failure
   *  rather than hanging the session open (mirror of codex). */
  function finalize(): HarnessEvent[] {
    if (terminated) return [];
    const error: HarnessError = {
      class: "protocol",
      origin: "transport",
      message: "omp transport ended without a terminal turn-result frame",
      retryable: false,
      retryableSource: "inferred",
      nativeCode: null,
    };
    return [
      { ...envelope(context, {}), kind: "error", error },
      {
        ...envelope(context, {}),
        kind: "session.ended",
        outcome: { status: "failed", error },
      },
    ];
  }

  return { normalize, fail, finalize };
}

// ── The session + adapter (mirror of CodexSession/CodexAdapter) ──────────────

class OmpSession implements HarnessSession {
  readonly id: string;
  readonly harness = HARNESS_ID;
  readonly #transport: OmpTurnTransport;
  readonly #spec: SessionSpec;
  readonly #config: OmpAdapterConfig;
  readonly #context: EnvelopeContext;
  readonly #abort: AbortController;
  readonly #started: Promise<AsyncIterable<unknown>>;
  #resolveStarted!: (iterable: AsyncIterable<unknown>) => void;
  #rejectStarted!: (error: unknown) => void;
  #sent = false;
  #eventsTaken = false;
  #draining = false;
  #completion: Promise<void> = Promise.resolve();
  #resolveCompletion: (() => void) | null = null;

  constructor(
    id: string,
    turnId: string,
    transport: OmpTurnTransport,
    spec: SessionSpec,
    config: OmpAdapterConfig,
    now: () => number,
    abort: AbortController,
  ) {
    this.id = id;
    this.#transport = transport;
    this.#spec = spec;
    this.#config = config;
    this.#abort = abort;
    this.#context = {
      harness: HARNESS_ID,
      sessionId: id,
      turnId,
      seq: createSeqCounter(),
      now,
    };
    this.#started = new Promise((resolve, reject) => {
      this.#resolveStarted = resolve;
      this.#rejectStarted = reject;
    });
    void this.#started.catch(() => undefined);
  }

  get events(): AsyncIterable<HarnessEvent> {
    return {
      [Symbol.asyncIterator]: (): AsyncIterator<HarnessEvent> => {
        if (this.#eventsTaken) {
          throw new Error("omp session events may only be subscribed to once");
        }
        this.#eventsTaken = true;
        return this.#drainEvents();
      },
    };
  }

  async *#drainEvents(): AsyncIterator<HarnessEvent> {
    const started = this.#started;
    const { normalize, fail, finalize } = createOmpNormalizer(this.#context, this.#turnSpec());
    this.#completion = new Promise((resolve) => {
      this.#resolveCompletion = resolve;
    });
    this.#draining = true;
    try {
      const iterable = await started;
      for await (const frame of iterable) {
        for (const event of normalize(frame)) yield event;
      }
      for (const event of finalize()) yield event;
    } catch (error) {
      for (const event of fail(error)) yield event;
    } finally {
      this.#draining = false;
      this.#resolveCompletion?.();
      this.#resolveCompletion = null;
    }
  }

  #turnSpec(): OmpTurnSpec {
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
    try {
      const iterable = this.#transport({
        ...this.#turnSpec(),
        prompt: input.prompt,
      });
      this.#resolveStarted(iterable);
      return Promise.resolve(this.#context.turnId ?? this.id);
    } catch (error) {
      this.#rejectStarted(error);
      return Promise.reject(error);
    }
  }

  async interrupt(): Promise<void> {
    this.#abort.abort();
    if (this.#draining) await this.#completion;
  }

  async close(): Promise<void> {
    this.#abort.abort();
    if (this.#draining) await this.#completion;
  }
}

export interface OmpAdapterConfig {
  readonly binaryPath: string;
  /** The injected turn transport. The composition root supplies the real spawn. */
  readonly transport: OmpTurnTransport;
  readonly version?: string;
  readonly probeVersion?: (path: string) => Promise<string | null>;
  readonly now?: () => number;
  /**
   * The descriptor's capability flags, DERIVED from passing conformance checks (never
   * declared). Default empty → every layer false. The composition root feeds a
   * hermetic self-conformance run's `implementedByAdapter` evidence.
   */
  readonly capabilityEvidence?: CapabilityEvidence;
  /** Loopback MCP servers (canvasOps@2) applied to every session's turn spec. */
  readonly mcpServers?: Readonly<Record<string, { readonly url: string }>>;
}

export class OmpAdapter implements HarnessPort {
  readonly descriptor: HarnessDescriptor;
  readonly #config: OmpAdapterConfig;
  readonly #now: () => number;
  readonly #range: TestedRange | null;

  constructor(config: OmpAdapterConfig) {
    this.#config = config;
    this.#now = config.now ?? Date.now;
    // No omp entry in the committed tested-range artifact until the first genuine
    // full-match real run (the Codex precedent) — so this is honest-absent by default.
    this.#range = readTestedRange(HARNESS_ID);
    this.descriptor = {
      id: HARNESS_ID,
      displayName: DISPLAY_NAME,
      version: config.version ?? "unknown",
      binaryPath: config.binaryPath,
      capabilities: buildCapabilities(config.capabilityEvidence ?? {}),
      ...(this.#range === null ? {} : { testedRange: this.#range }),
    };
  }

  async health(): Promise<HarnessHealth> {
    const probe = this.#config.probeVersion;
    if (!probe) {
      const version = this.#config.version;
      return version
        ? healthForRange(version, this.#range)
        : {
            state: "unavailable",
            reason: "spawn-failed",
            detail: "No version probe configured.",
          };
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
      else
        spec.signal.addEventListener("abort", () => abort.abort(), {
          once: true,
        });
    }
    const sessionId = randomUUID();
    return Promise.resolve(
      new OmpSession(
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

function healthForRange(version: string, range: TestedRange | null): HarnessHealth {
  if (range === null) return { state: "degraded", version, reason: "untested" };
  if (compareVersions(version, range.min) < 0) {
    return { state: "degraded", version, reason: "below-floor" };
  }
  if (compareVersions(version, range.maxTested) > 0) {
    return { state: "degraded", version, reason: "above-tested" };
  }
  return { state: "ready", version };
}
