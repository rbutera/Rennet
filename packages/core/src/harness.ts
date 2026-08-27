/**
 * The normalized harness adapter protocol (slice 1).
 *
 * This is the seam between Rennet and any agentic harness (Claude Code, Codex,
 * omp). It is deliberately node-free at module scope so a mobile or third-party
 * client can import it: no `node:*`, no filesystem, no process. The adapter that
 * spawns a real harness lives in `@rennet/adapters` and depends on this.
 *
 * Scope note: this is the consumed subset of the full Wingman Harness Adapter
 * Protocol. Disagreement / N=3 self-consistency machinery, session persistence,
 * fork, the utility tier, and the cross-adapter conformance runner are
 * deliberately out of this slice; cursor-resume (`SessionSpec.resume`) is wired
 * in B09, the consuming turn of the frozen `HarnessCursor`.
 */

import type { RspTokenUsage } from "@rennet/protocol";

export type HarnessId = "claude-code" | "codex" | "omp";

/** Opaque identifiers. Kept as plain strings for slice 1 (no branding). */
export type SessionId = string;
export type TurnId = string;
export type ToolCallId = string;

/**
 * Which credential answered for a session, as reported by the harness on its
 * init frame. The safe sources are `'oauth'` (subscription) and `'none'` (no
 * API key present, so the login/subscription is paying) — both free at point of
 * use. A metered source (`'user' | 'project' | 'org' | 'temporary'`) means a
 * key is paying, which the adapter surfaces as a visible warning (detection,
 * never prevention).
 *
 * `'none'` is not in the SDK's published type but IS what the installed CLI
 * reports for a subscription session (verified live, 2026-08-06); the artifact
 * beats the doc.
 */
export type ApiKeySource = "none" | "user" | "project" | "org" | "temporary" | "oauth";

/** Sources that spend money per token. `'oauth'` and `'none'` are NOT metered. */
export const METERED_API_KEY_SOURCES: readonly ApiKeySource[] = [
  "user",
  "project",
  "org",
  "temporary",
];

/**
 * A capability is earned across three independent layers, each starting
 * `false`. A flag is only ever set from a passing check, never declared:
 * - `implementedByAdapter`: this adapter has code that maps the capability.
 * - `advertisedByHarness`: the installed harness/version claims to support it.
 * - `availableInSession`: it was actually exercised in a live session.
 */
export interface CapabilityLayers {
  readonly implementedByAdapter: boolean;
  readonly advertisedByHarness: boolean;
  readonly availableInSession: boolean;
}

export type CapabilityName =
  | "resume"
  | "fork"
  | "interrupt"
  | "toolGating"
  | "structuredOutput"
  | "textDeltas"
  | "reportsContextWindow"
  | "costUsd";

export const CAPABILITY_NAMES: readonly CapabilityName[] = [
  "resume",
  "fork",
  "interrupt",
  "toolGating",
  "structuredOutput",
  "textDeltas",
  "reportsContextWindow",
  "costUsd",
];

export type HarnessCapabilities = Readonly<Record<CapabilityName, CapabilityLayers>>;

/** The evidence sets that earn each capability layer. Absent means "no passing check". */
export interface CapabilityEvidence {
  readonly implementedByAdapter?: readonly CapabilityName[];
  readonly advertisedByHarness?: readonly CapabilityName[];
  readonly availableInSession?: readonly CapabilityName[];
}

/**
 * Build a capability set from passing checks. Every layer of every capability
 * defaults to `false`; a layer is only `true` when its evidence set names it.
 * This is the mechanism behind "flags are derived from passing checks, not
 * declared": nothing here can produce a `true` a caller did not observe.
 */
export function buildCapabilities(evidence: CapabilityEvidence = {}): HarnessCapabilities {
  const implemented = new Set(evidence.implementedByAdapter ?? []);
  const advertised = new Set(evidence.advertisedByHarness ?? []);
  const available = new Set(evidence.availableInSession ?? []);
  const entries = CAPABILITY_NAMES.map((name): [CapabilityName, CapabilityLayers] => [
    name,
    {
      implementedByAdapter: implemented.has(name),
      advertisedByHarness: advertised.has(name),
      availableInSession: available.has(name),
    },
  ]);
  return Object.fromEntries(entries) as HarnessCapabilities;
}

export interface HarnessDescriptor {
  readonly id: HarnessId;
  readonly displayName: string;
  /** As reported by the installed binary. */
  readonly version: string;
  readonly binaryPath: string;
  readonly capabilities: HarnessCapabilities;
  /** Version floor and ceiling we have actually tested against; absent until a real run earns it. */
  readonly testedRange?: { readonly min: string; readonly maxTested: string };
}

export type HarnessHealth =
  | { readonly state: "ready"; readonly version: string }
  | {
      readonly state: "degraded";
      readonly version: string;
      readonly reason: "below-floor" | "above-tested" | "unauthenticated" | "untested";
    }
  | {
      readonly state: "unavailable";
      readonly reason: "not-found" | "spawn-failed" | "handshake-failed";
      readonly detail: string;
    };

/**
 * The normalized error taxonomy. `class` says what went wrong; `origin` says
 * which layer it came from, so the UI can distinguish our bug from the
 * harness's from the provider's from the wire.
 */
export type ErrorClass =
  | "auth"
  | "rate-limit"
  | "quota-exhausted"
  | "context-overflow"
  | "overloaded"
  | "upstream"
  | "invalid-request"
  | "policy"
  | "sandbox"
  | "cancelled"
  | "max-turns"
  | "harness-unavailable"
  | "protocol"
  | "unknown";

export type ErrorOrigin = "adapter" | "harness" | "provider" | "transport";

export interface HarnessError {
  readonly class: ErrorClass;
  readonly origin: ErrorOrigin;
  readonly message: string;
  readonly retryable: boolean;
  /** Whether `retryable` came from the harness or was inferred from `class`. */
  readonly retryableSource: "harness" | "inferred";
  readonly nativeCode: string | null;
  readonly detail?: string;
}

export type ToolKind = "read" | "write" | "exec" | "search" | "mcp" | "subagent" | "other";

export interface ToolCall {
  readonly id: ToolCallId;
  readonly name: string;
  readonly input: Record<string, unknown>;
  readonly parentToolCallId: ToolCallId | null;
  readonly kind: ToolKind;
}

export type SessionOutcome =
  | {
      readonly status: "completed";
      readonly finalText: string;
      readonly structuredOutput?: unknown;
      /** Actual model context-window capacity, when the normalized adapter reports it. */
      readonly contextWindowTokens?: number;
      /**
       * The turn's token accounting, when the harness reported it on its terminal
       * frame (issue #186). Threaded through so the runner that mints the RSP
       * document stamps REAL token counts into provenance instead of ZERO_TOKENS.
       * Absent when the harness reported no usage (a genuine null, never a
       * substituted zero — a turn that carried no usage is not one that used none).
       */
      readonly usage?: RspTokenUsage;
      /**
       * The harness's own resumable session id and the anchor of the turn's last
       * message (B09 cursor-resume, #466 res. 3), when the harness reported them on
       * its terminal frame. The durable session persists these as its
       * `HarnessCursor` so the NEXT turn resumes this conversation (the CLI owns the
       * transcript; Rennet re-passes only this pointer). Absent when the harness
       * reported no resumable id — the cursor is then NOT advanced, an honest "no
       * durable resume point" rather than a fabricated id.
       */
      readonly harnessSessionId?: string;
      readonly lastAssistantMessageAnchor?: string;
    }
  | { readonly status: "cancelled"; readonly partial: boolean }
  | { readonly status: "failed"; readonly error: HarnessError };

/**
 * The envelope stamped on every event. `seq` is assigned by the ADAPTER, never
 * taken from the harness clock (the Claude SDK's own type says "do not order
 * messages by this field"). `native` carries the raw frame verbatim so nothing
 * we failed to model is lost.
 */
export interface HarnessEventBase {
  readonly seq: number;
  readonly harness: HarnessId;
  readonly sessionId: SessionId;
  readonly turnId: TurnId | null;
  readonly receivedAt: number;
  readonly native: unknown;
}

export type HarnessEvent = HarnessEventBase &
  (
    | {
        readonly kind: "session.started";
        readonly model: string;
        readonly cwd: string;
        readonly tools: readonly string[];
        readonly apiKeySource: ApiKeySource | null;
      }
    | { readonly kind: "session.ended"; readonly outcome: SessionOutcome }
    | { readonly kind: "text.delta"; readonly text: string }
    | {
        readonly kind: "text.message";
        readonly text: string;
        readonly parentToolCallId: ToolCallId | null;
      }
    | { readonly kind: "tool.started"; readonly call: ToolCall }
    | {
        readonly kind: "tool.output";
        readonly callId: ToolCallId;
        readonly ok: boolean;
        readonly output: unknown;
        readonly text: string;
      }
    | {
        readonly kind: "tool.denied";
        readonly callId: ToolCallId | null;
        readonly toolName: string;
        readonly by: "user" | "policy" | "classifier";
        readonly reason: string;
      }
    /** Money safety: a metered key took over a session that should be on subscription OAuth. */
    | {
        readonly kind: "auth.metered-key-warning";
        readonly apiKeySource: ApiKeySource;
        readonly message: string;
      }
    | { readonly kind: "error"; readonly error: HarnessError }
    /** An unmodelled native frame, surfaced rather than swallowed. */
    | { readonly kind: "passthrough"; readonly nativeKind: string }
  );

/** A monotonic per-session sequence source. The first `next()` returns `start + 1`. */
export interface SeqCounter {
  next(): number;
}

export function createSeqCounter(start = 0): SeqCounter {
  let value = start;
  return {
    next(): number {
      value += 1;
      return value;
    },
  };
}

export interface EnvelopeContext {
  readonly harness: HarnessId;
  readonly sessionId: SessionId;
  readonly turnId: TurnId | null;
  readonly seq: SeqCounter;
  readonly now: () => number;
}

/** Stamp the shared envelope onto an event body. Assigns the next `seq` as a side effect. */
export function envelope(context: EnvelopeContext, native: unknown): HarnessEventBase {
  return {
    seq: context.seq.next(),
    harness: context.harness,
    sessionId: context.sessionId,
    turnId: context.turnId,
    receivedAt: context.now(),
    native,
  };
}

export interface SessionSpec {
  readonly cwd: string;
  readonly model?: string;
  readonly systemPrompt?: { readonly mode: "replace" | "append"; readonly text: string };
  readonly allowedTools?: readonly string[];
  readonly outputSchema?: unknown;
  readonly signal?: AbortSignal;
  /**
   * Resume a prior harness conversation (B09 cursor-resume, #466 res. 3). When
   * present, `createSession` continues the harness session named by
   * `harnessSessionId` (the SDK `resume` param) instead of starting fresh — the
   * CLI owns the transcript, Rennet re-passes only this pointer each turn. Absent
   * ⇒ a fresh conversation. Only an adapter advertising the `resume` capability
   * honours it; one that does not starts fresh (honest — never a silent
   * half-resume). The persisted shape is the frozen `HarnessCursor`.
   */
  readonly resume?: { readonly harnessSessionId: string };
}

export interface TurnInput {
  readonly prompt: string;
}

/**
 * The port an adapter implements: descriptor + health + session creation. A
 * session may resume a prior harness conversation (`SessionSpec.resume`, B09
 * cursor-resume) when the adapter advertises the `resume` capability; `fork` is
 * still a later slice and is absent by design rather than stubbed.
 */
export interface HarnessPort {
  readonly descriptor: HarnessDescriptor;
  health(): Promise<HarnessHealth>;
  createSession(spec: SessionSpec): Promise<HarnessSession>;
}

export interface HarnessSession {
  readonly id: SessionId;
  readonly harness: HarnessId;
  /** One stream for the session's whole life; subscribe once. */
  readonly events: AsyncIterable<HarnessEvent>;
  /** Start a turn. Events arrive on `events`, not here. */
  send(input: TurnInput): Promise<TurnId>;
  /** Cancel the in-flight turn. In slice 1 this kills the harness subprocess. */
  interrupt(): Promise<void>;
  /** Tear down the session and its subprocess. Always available. */
  close(): Promise<void>;
}
