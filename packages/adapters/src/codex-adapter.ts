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
import { stripNullDeep } from "./codex-exec";
import { compareVersions } from "./harness-discovery";
import { readTestedRange } from "./harness-tested-range";

/**
 * The Codex adapter (#25): the second harness slot, peer of `ClaudeAdapter`.
 *
 * Transport verdict (design §1): the adapter speaks `codex exec --json` behind an
 * injected `CodexTurnTransport` seam — the mirror of `ClaudeQueryFn`. The
 * app-server JSON-RPC protocol is deferred until steering or thread-resume is
 * actually consumed; this seam is where it would land. The consumers are all
 * single-turn (create → send one prompt → drain → close), which `codex exec`
 * serves exactly, at the capable-by-default posture Rule Zero mandates.
 *
 * The composition root (`createCodexTurnTransport`, `codex-turn-transport.ts`)
 * spawns the discovered `codex` binary; this file is pure over the injected
 * transport and fully testable without a process. It never reads a credential:
 * `codex` authenticates itself on the user's own subscription.
 */

const HARNESS_ID = "codex" as const;
const DISPLAY_NAME = "Codex";

// ── The injected transport seam (mirror of ClaudeQueryFn) ────────────────────

/** One agentic turn's spec. `cwd` is a REAL repo (the review worktree), unlike
 *  the utility port's scratch dir. */
export interface CodexTurnSpec {
  readonly cwd: string;
  readonly prompt: string;
  /** Codex's own default when absent; the council passes e.g. "gpt-5.6-sol". */
  readonly model?: string;
  readonly effort?: string;
  readonly outputSchema?: unknown;
  /** Loopback canvasOps@2 (and future) MCP servers, rendered as `-c` URL overrides. */
  readonly mcpServers?: Readonly<Record<string, { readonly url: string }>>;
  readonly signal?: AbortSignal;
}

/**
 * The transport yields the raw codex `--json` JSONL frames, then EXACTLY ONE
 * synthetic terminal frame `{ rennet: "turn-result", exitCode, lastMessage,
 * aborted?, stderr? }`. The adapter owns normalization, seq, and the terminal
 * outcome — the exit code and `-o` capture only the transport (the process
 * boundary) can know, so they ride the terminal frame.
 */
export type CodexTurnTransport = (spec: CodexTurnSpec) => AsyncIterable<unknown>;

/** The synthetic terminal frame the transport appends. Owned by the seam, not codex. */
export interface CodexTurnResultFrame {
  readonly rennet: "turn-result";
  readonly exitCode: number;
  /** The `-o` captured last agent message (raw text), or null if none. */
  readonly lastMessage: string | null;
  readonly aborted?: boolean;
  readonly stderr?: string;
}

// ── Pure argv assembly (composition-root transport uses this; asserted alone) ──

export interface CodexTurnArgs {
  readonly cwd: string;
  readonly prompt: string;
  readonly model?: string;
  readonly effort?: string;
  readonly schemaPath?: string;
  readonly outPath?: string;
  readonly mcpServers?: Readonly<Record<string, { readonly url: string }>>;
}

/**
 * Assemble the agentic `codex exec` argv. Reuses `codex-exec.ts`'s proven flags
 * (`--json`, `--ignore-user-config`, the full-access posture, `-o` capture) with
 * the agentic deltas: `-C <cwd>` into a REAL repo (so NO `--skip-git-repo-check`,
 * unlike the utility port's scratch cwd), and `-c mcp_servers.<name>.url` for the
 * loopback canvasOps@2 surface. NO approval / sandbox-mode / read-only flag — the
 * `--dangerously-bypass-approvals-and-sandbox` posture IS the Rule Zero acting
 * path (capable by default; Bash carries git, so push works). Pure, so flags are
 * asserted without spawning. The prompt is positional and LAST.
 */
export function buildCodexTurnArgs(spec: CodexTurnArgs): string[] {
  const args = [
    "exec",
    "--json",
    "--dangerously-bypass-approvals-and-sandbox",
    "--ignore-user-config",
    "-C",
    spec.cwd,
  ];
  if (spec.model !== undefined) args.push("-m", spec.model);
  if (spec.effort !== undefined) args.push("-c", `model_reasoning_effort=${spec.effort}`);
  if (spec.schemaPath !== undefined) args.push("--output-schema", spec.schemaPath);
  if (spec.outPath !== undefined) args.push("-o", spec.outPath);
  for (const [name, server] of Object.entries(spec.mcpServers ?? {})) {
    args.push("-c", `mcp_servers.${name}.url=${server.url}`);
  }
  args.push(spec.prompt);
  return args;
}

// ── Frame normalization ──────────────────────────────────────────────────────

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" ? value : null;
}

function numField(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Classify a codex `item_type` into the normalized `ToolKind`. */
export function classifyCodexItemKind(itemType: string): ToolKind {
  switch (itemType) {
    case "command_execution":
      return "exec";
    case "mcp_tool_call":
      return "mcp";
    case "file_change":
    case "patch_apply":
      return "write";
    case "web_search":
      return "search";
    default:
      return "other";
  }
}

/**
 * Extract token usage off a codex `turn.completed` frame's `usage` block into the
 * RSP shape. Codex reports `input_tokens`, `cached_input_tokens`, `output_tokens`,
 * `reasoning_output_tokens` (verified on the 0.146.0 binary). `cacheWrite` is 0
 * (codex has no cache-creation notion); `reasoning` is the informational subset of
 * output; `total` follows Rennet's convention (input + output + cacheRead +
 * cacheWrite) so it reconciles with codex's own `total_tokens`. Absent usage → undefined.
 */
export function extractCodexUsage(frame: Record<string, unknown>): RspTokenUsage | undefined {
  const usage = asRecord(frame.usage);
  if (!usage) return undefined;
  const input = numField(usage, "input_tokens");
  const output = numField(usage, "output_tokens");
  const cacheRead = numField(usage, "cached_input_tokens");
  const reasoningRaw = usage.reasoning_output_tokens;
  const reasoning =
    typeof reasoningRaw === "number" && Number.isFinite(reasoningRaw) ? reasoningRaw : null;
  return { input, output, cacheRead, cacheWrite: 0, reasoning, total: input + output + cacheRead };
}

/**
 * Map a codex failure into the normalized taxonomy. Codex error frames carry a
 * free-text `message`; there is no closed native code, so the class is inferred
 * from the message shape and the origin defaults to `harness`, with connection /
 * stream failures attributed to `transport` and provider throttle strings to
 * `provider`.
 */
export function mapCodexError(message: string, exitCode: number | null): HarnessError {
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
  } else if (/stream disconnected|connection|econn|network|sending request|timeout/.test(lower)) {
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

/**
 * A stateful per-turn normalizer. Codex streaming needs cross-frame state (the
 * last agent message for structured-output parsing, the terminal usage, a seen
 * error), so unlike Claude's pure per-frame map this closes over that state. The
 * terminal outcome is driven by the synthetic `turn-result` frame — the only
 * carrier of exit code and the `-o` capture — enriched by what the stream showed.
 */
function createCodexNormalizer(
  context: EnvelopeContext,
  spec: CodexTurnSpec,
): { normalize: (frame: unknown) => HarnessEvent[]; finalize: () => HarnessEvent[] } {
  const schemaRequested = spec.outputSchema !== undefined;
  let lastMessageText: string | null = null;
  let lastUsage: RspTokenUsage | undefined;
  let seenError: HarnessError | null = null;
  let terminated = false;

  const passthrough = (frame: unknown, nativeKind: string): HarnessEvent[] => [
    { ...envelope(context, frame), kind: "passthrough", nativeKind },
  ];

  function parseStructured(raw: string | null): unknown {
    if (!schemaRequested || raw === null) return undefined;
    try {
      // Reuse the utility port's null-stripping (design: do not fork the
      // schema-nullability logic): a `--output-schema` sanitized to force
      // optionals into required-nullable makes the model emit nulls; stripping
      // them restores the field's absent semantics.
      return stripNullDeep(JSON.parse(raw));
    } catch {
      return undefined;
    }
  }

  function terminal(frame: CodexTurnResultFrame): HarnessEvent[] {
    terminated = true;
    if (frame.aborted) {
      return [
        {
          ...envelope(context, frame),
          kind: "session.ended",
          outcome: { status: "cancelled", partial: lastMessageText !== null },
        },
      ];
    }
    if (frame.exitCode !== 0 || seenError) {
      const error =
        seenError ??
        mapCodexError(frame.stderr?.trim() || `codex exec exited ${frame.exitCode}`, frame.exitCode);
      return [
        { ...envelope(context, frame), kind: "error", error },
        { ...envelope(context, frame), kind: "session.ended", outcome: { status: "failed", error } },
      ];
    }
    const raw = frame.lastMessage ?? lastMessageText;
    const structuredOutput = parseStructured(raw);
    const finalText = raw ?? "";
    const outcome =
      structuredOutput === undefined
        ? { status: "completed" as const, finalText, ...(lastUsage ? { usage: lastUsage } : {}) }
        : {
            status: "completed" as const,
            finalText,
            structuredOutput,
            ...(lastUsage ? { usage: lastUsage } : {}),
          };
    return [{ ...envelope(context, frame), kind: "session.ended", outcome }];
  }

  function normalize(frame: unknown): HarnessEvent[] {
    const record = asRecord(frame);
    if (!record) return passthrough(frame, "non-object");

    // The seam's synthetic terminal frame (owned here, not a codex frame).
    if (record.rennet === "turn-result") {
      return terminal(record as unknown as CodexTurnResultFrame);
    }

    const type = stringField(record, "type");
    switch (type) {
      case "thread.started":
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
      case "item.started":
      case "item.updated":
      case "item.completed": {
        const item = asRecord(record.item);
        const itemType = item ? stringField(item, "item_type") : null;
        if (!item || itemType === null) return passthrough(frame, type);
        if (itemType === "agent_message" || itemType === "assistant_message") {
          const text = stringField(item, "text") ?? stringField(item, "content") ?? "";
          if (type === "item.completed") {
            lastMessageText = text;
            return [
              { ...envelope(context, frame), kind: "text.message", text, parentToolCallId: null },
            ];
          }
          // Streaming update → a text delta (the textDeltas capability).
          return [{ ...envelope(context, frame), kind: "text.delta", text }];
        }
        if (itemType === "reasoning") return passthrough(frame, `item:${itemType}`);
        if (type !== "item.completed") return passthrough(frame, `item:${itemType}`);
        // A completed tool item → one tool.started carrying its ToolKind.
        const name =
          stringField(item, "tool") ??
          stringField(item, "command") ??
          stringField(item, "name") ??
          itemType;
        return [
          {
            ...envelope(context, frame),
            kind: "tool.started",
            call: {
              id: stringField(item, "id") ?? randomUUID(),
              name,
              input: item,
              parentToolCallId: null,
              kind: classifyCodexItemKind(itemType),
            },
          },
        ];
      }
      case "turn.completed":
        lastUsage = extractCodexUsage(record);
        return passthrough(frame, "turn.completed");
      case "turn.failed": {
        const err = asRecord(record.error);
        const message = (err && stringField(err, "message")) ?? "codex turn failed";
        seenError = mapCodexError(message, null);
        return passthrough(frame, "turn.failed");
      }
      case "error": {
        const message = stringField(record, "message") ?? "codex error";
        seenError = mapCodexError(message, null);
        return passthrough(frame, "error");
      }
      default:
        return passthrough(frame, type ?? "unknown");
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

class CodexSession implements HarnessSession {
  readonly id: string;
  readonly harness = HARNESS_ID;
  readonly #transport: CodexTurnTransport;
  readonly #spec: SessionSpec;
  readonly #config: CodexAdapterConfig;
  readonly #context: EnvelopeContext;
  readonly #abort: AbortController;
  readonly #started: Promise<AsyncIterable<unknown>>;
  #resolveStarted!: (iterable: AsyncIterable<unknown>) => void;
  #sent = false;

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
  }

  get events(): AsyncIterable<HarnessEvent> {
    const started = this.#started;
    const { normalize, finalize } = createCodexNormalizer(this.#context, this.#turnSpec());
    return {
      async *[Symbol.asyncIterator](): AsyncIterator<HarnessEvent> {
        const iterable = await started;
        for await (const frame of iterable) {
          for (const event of normalize(frame)) yield event;
        }
        for (const event of finalize()) yield event;
      },
    };
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

  interrupt(): Promise<void> {
    this.#abort.abort();
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.#abort.abort();
    return Promise.resolve();
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
   * (never declared). Default empty → every layer false (a fresh adapter with no
   * evidence advertises nothing). The composition root feeds a hermetic
   * self-conformance run's `implementedByAdapter` evidence.
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
