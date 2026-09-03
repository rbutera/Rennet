/**
 * The injected turn: a `HarnessPort` → `runTurn` adapter (issue #54).
 *
 * `runDecompositionAngle` (#8) and `runOrderingPass` (#9) both take an injected
 * `runTurn(prompt, attempt)` so the model wiring is the caller's, keeping those
 * modules pure and testable with a mock. This is the REAL wiring: it drives one
 * turn through a harness session and maps the session outcome into the turn
 * result those modules expect.
 *
 * It depends ONLY on the `HarnessPort` interface (this package), never on
 * `@rennet/adapters`, so `core` never imports `adapters` — the concrete Claude
 * adapter is composed by `apps/desktop` and passed in as a `HarnessPort`. The
 * session is CAPABLE by default (the adapter withholds no tools; issue #259 removed
 * the read-only posture that used to sit on the analysis path) and constrained to the
 * docType's output schema, so a completed turn carries a schema-shaped
 * `structuredOutput` the angle then validates. Anything else (no structured
 * output, a failure, a cancellation, an error frame) is a turn failure, so the
 * angle's always-present deterministic floor stands.
 */

import type { PromptContextFile } from "@rennet/prompts";
import { renderLayer } from "@rennet/prompts";
import type {
  ContextSendRecord,
  RspCapabilitySnapshot,
  RspDocType,
  RspRoute,
  RspTier,
  RspTokenUsage,
} from "@rennet/protocol";
import { bodyJsonSchema, sha256Hex } from "@rennet/protocol";
import type { HarnessPort } from "./harness";

/**
 * The executor facts a turn may report about what actually ran it (issue #88). A
 * Codex utility-port turn fills these from the port's honest provenance (`utility`/
 * `light` + the per-call capability snapshot); a Claude harness turn leaves them
 * absent, so the runner stamps its `agentic`/`heavy` defaults. This lets the runner
 * record the executor that ran, not the seed's default route.
 */
export interface TurnExecutorFacts {
  readonly route: RspRoute;
  readonly tier: RspTier;
  readonly capability: RspCapabilitySnapshot;
}

/** The turn result shape shared by `runDecompositionAngle` and `runOrderingPass`. */
export type HarnessTurnResult =
  | {
      readonly status: "emitted";
      readonly body: unknown;
      readonly tokens?: RspTokenUsage;
      /** Executor provenance facts, when the executor reported them (#88). */
      readonly executor?: TurnExecutorFacts;
      /**
       * What actually ran the turn, when the harness reported it (the knowledge
       * swarm stamps this onto statement provenance instead of null, review P2).
       */
      readonly observed?: {
        readonly model: string | null;
        readonly apiKeySource: string | null;
      };
    }
  | { readonly status: "failed"; readonly message: string };

const CONTEXT_LAYER_PREFIX = "<<<rennet:layer context>>>\n";
const PAYLOAD_LAYER_SEPARATOR = "\n\n<<<rennet:layer payload>>>\n";
const UTF8_ENCODER = new TextEncoder();

function extractContextLayer(sentText: string): string | undefined {
  const prefixed = `\n\n${CONTEXT_LAYER_PREFIX}`;
  const contextStart = sentText.startsWith(CONTEXT_LAYER_PREFIX)
    ? 0
    : sentText.indexOf(prefixed) < 0
      ? -1
      : sentText.indexOf(prefixed) + 2;
  if (contextStart < 0) return undefined;

  const bodyStart = contextStart + CONTEXT_LAYER_PREFIX.length;
  const payloadStart = sentText.indexOf(PAYLOAD_LAYER_SEPARATOR, bodyStart);
  return sentText.slice(bodyStart, payloadStart < 0 ? sentText.length : payloadStart);
}

/**
 * The size at which an interpolated JSON literal stops being an instruction and starts
 * being context (session-context-files 2.3). Two kilobytes is generous: the payloads the
 * rule exists to stop measured 10 KB to 103 KB.
 */
export const INLINE_CONTEXT_MAX_BYTES = 2048;

/**
 * How much context a prompt carries inline, in bytes: every balanced JSON literal and every
 * fenced code block, summed over the whole text — the mechanical reading of "never inline
 * context". Reported only when the total is over {@link INLINE_CONTEXT_MAX_BYTES}, so an
 * instruction that shows a small shape costs nothing, while a manifest of three hundred
 * small rows, or a payload sitting after a stray brace in prose, is measured in full.
 *
 * Pure, and cheap: fenced blocks are lifted first (their bytes count whole, and a literal
 * inside one is not counted twice), then each LINE is scanned once with a stack of open
 * brackets, `JSON.parse` confirming only a balanced span. The stack resets at every newline:
 * a `JSON.stringify(x)` literal never spans lines (the harness rule forbids pretty-printing
 * for a model), and the reset is what stops an unpaired `{` in prose from swallowing the
 * rest of the prompt.
 *
 * ponytail: a stray opener on the SAME line as a literal still hides it (the literal is then
 * nested, never top-level); rescan from the stray if a real prompt ever has that shape.
 */
export function inlineContextViolation(prompt: string): { readonly bytes: number } | undefined {
  let bytes = 0;
  const unfenced = prompt.replace(/```[\s\S]*?```/g, (block) => {
    bytes += UTF8_ENCODER.encode(block).length;
    return "";
  });
  for (const line of unfenced.split("\n")) bytes += jsonLiteralBytes(line);
  return bytes > INLINE_CONTEXT_MAX_BYTES ? { bytes } : undefined;
}

/** The bytes of every balanced top-level JSON literal on one line of prompt. */
function jsonLiteralBytes(line: string): number {
  let bytes = 0;
  const open: string[] = [];
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      // Only inside a candidate literal: an unpaired quote in prose must not desync the scan.
      if (open.length > 0) inString = true;
      continue;
    }
    if (ch === "{" || ch === "[") {
      if (open.length === 0) start = i;
      open.push(ch);
      continue;
    }
    if (ch !== "}" && ch !== "]") continue;
    const opener = open.pop();
    if (opener === undefined) continue; // a stray closer in prose
    if (opener !== (ch === "}" ? "{" : "[")) {
      open.length = 0; // mismatched: this was prose, not a literal
      continue;
    }
    if (open.length > 0) continue;
    const literal = line.slice(start, i + 1);
    try {
      JSON.parse(literal);
    } catch {
      continue; // balanced brackets, but not JSON
    }
    bytes += UTF8_ENCODER.encode(literal).length;
  }
  return bytes;
}

/**
 * Injected (the daemon): write a turn's context files into the session's context
 * directory and return that directory as a path RELATIVE to the turn's cwd, with `/`
 * separators — the turn runs with its cwd at the bound root, so the prompt names
 * `<returned dir>/<file name>` and the session opens it with its own tools.
 *
 * It exists so `core` can point a turn at a file without owning the filesystem: the
 * daemon's `writeSessionContext` is the ONE writer, this is the seam that reaches it.
 */
export type TurnContextWriter = (files: readonly PromptContextFile[]) => string;

export interface ContextSendRecordInput {
  readonly seat: string;
  readonly harness: string;
  readonly channel: ContextSendRecord["channel"];
  readonly attempt: number;
}

export function buildContextSendRecord(
  sentText: string,
  input: ContextSendRecordInput,
  expectedContext?: string,
): ContextSendRecord {
  const context =
    expectedContext === undefined
      ? extractContextLayer(sentText)
      : sentText.includes(renderLayer("context", expectedContext))
        ? expectedContext
        : undefined;
  // Recorded, never enforced (Rule Zero): the send proceeds whatever this says. The tap is
  // the one place every harness path passes through, so it is where a prompt that still
  // carries context inline becomes visible instead of invisible in a diff.
  const inline = inlineContextViolation(sentText);
  return {
    seat: input.seat,
    harness: input.harness,
    channel: input.channel,
    attempt: input.attempt,
    promptBytes: UTF8_ENCODER.encode(sentText).length,
    promptDigest: sha256Hex(sentText),
    contextIncluded: context !== undefined,
    ...(context === undefined ? {} : { contextDigest: sha256Hex(context) }),
    ...(inline === undefined ? {} : { inlineContextBytes: inline.bytes }),
    sentAt: new Date().toISOString(),
  };
}

/**
 * Record the exact prompt handed to a seat before delegating. Compose this inside
 * the throw guard as `guardSeatTurn(recordSeatSend(runTurn, meta, sink))` so a
 * handed-off prompt remains in the transcript even when the turn later throws.
 */
export function recordSeatSend(
  runTurn: (prompt: string, attempt: number) => Promise<HarnessTurnResult>,
  meta: { readonly seat: string; readonly harness: string },
  sink: (record: ContextSendRecord) => void,
  expectedContext?: string,
): (prompt: string, attempt: number) => Promise<HarnessTurnResult> {
  return async function recordedSeatSend(
    prompt: string,
    attempt: number,
  ): Promise<HarnessTurnResult> {
    const record = buildContextSendRecord(
      prompt,
      { ...meta, channel: "prompt", attempt },
      expectedContext,
    );
    try {
      sink(record);
    } catch {
      // Transcript observation must never block or alter the turn.
    }
    return runTurn(prompt, attempt);
  };
}

/** Render a thrown value (Error, string, or anything) into a turn-failure message. */
function describeTurnThrow(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return String(error);
  } catch {
    // A pathological throw value (a null-prototype object, or one whose
    // Symbol.toPrimitive/toString throws) makes String() itself throw. Never let
    // the guard's own error-rendering re-throw and reopen the crash path (#96).
    return "an uncoercible non-Error value";
  }
}

/**
 * Wrap an injected seat turn so a THROWN (rejected) turn is caught and mapped to
 * the returned turn-failure the seat runners already handle (issue #96).
 *
 * `createHarnessRunTurn` (and `createCodexRunTurn`) map EXPECTED failures — a
 * failed/cancelled outcome, an error frame, missing structured output — to
 * `{ status: "failed" }`, which the three seat runners
 * (`runDecompositionAngle`/`runOrderingPass`/`runRollupNarration`) already treat
 * as a turn failure and fall from to their honest never-blank floor. But a
 * CONSTRUCTION exception — e.g. `port.createSession` rejecting on a
 * session/transport error — is raised BEFORE that try/finally, so it escapes the
 * turn as a rejected promise, propagates uncaught through the seat runner and
 * `buildReviewCanvases`, and rejects the IPC handler — crashing the whole run
 * instead of degrading that one seat.
 *
 * This guard closes that hole ONCE for every seat: a thrown turn becomes a
 * `{ status: "failed" }` result, so the seat runner's existing turn-failure path
 * takes over and the seat degrades exactly as it does for a returned failure. The
 * map is PER CALL, so a throw on one attempt still lets the runner's retry loop
 * try the next attempt — identical to a returned failure. Apply it to the runTurn
 * a seat is handed, whichever harness produced it (Claude, Codex, or a mock).
 */
export function guardSeatTurn(
  runTurn: (prompt: string, attempt: number) => Promise<HarnessTurnResult>,
): (prompt: string, attempt: number) => Promise<HarnessTurnResult> {
  return async function guardedSeatTurn(
    prompt: string,
    attempt: number,
  ): Promise<HarnessTurnResult> {
    try {
      return await runTurn(prompt, attempt);
    } catch (error) {
      return {
        status: "failed",
        message: `the seat turn threw before returning a result: ${describeTurnThrow(error)}`,
      };
    }
  };
}

export interface HarnessRunTurnOptions {
  /** The document type the model emits; its schema constrains the session output. */
  readonly docType: RspDocType;
  /** The review's repository root — the read-only session's working directory. */
  readonly cwd: string;
  readonly model?: string;
  readonly signal?: AbortSignal;
}

/**
 * Build the injected `runTurn` for one document type against a harness port.
 * Each call creates a fresh capable session (slice-1 adapters are single-turn),
 * sends the prompt, drains the event stream to the terminal frame, and maps it:
 * a completed outcome with `structuredOutput` becomes an emitted body; everything
 * else becomes a turn failure. The session is always closed.
 */
export function createHarnessRunTurn(
  port: HarnessPort,
  options: HarnessRunTurnOptions,
): (prompt: string, attempt: number) => Promise<HarnessTurnResult> {
  const outputSchema = bodyJsonSchema(options.docType);
  return async function runTurn(prompt: string): Promise<HarnessTurnResult> {
    const session = await port.createSession({
      cwd: options.cwd,
      // #585: Rennet's internal one-shot turn — never the user's session history.
      ephemeral: true,
      ...(outputSchema === null ? {} : { outputSchema }),
      ...(options.model === undefined ? {} : { model: options.model }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    try {
      await session.send({ prompt });
      for await (const event of session.events) {
        if (event.kind === "error") {
          return { status: "failed", message: event.error.message };
        }
        if (event.kind === "session.ended") {
          const outcome = event.outcome;
          if (outcome.status === "completed") {
            if (outcome.structuredOutput === undefined) {
              return {
                status: "failed",
                message: "the harness completed the turn without structured output",
              };
            }
            // Thread the real token usage (issue #186): when the terminal frame
            // carried a `usage` block, the runner stamps THOSE counts into
            // provenance instead of ZERO_TOKENS. Absent usage carries no `tokens`
            // (the runner then stamps its honest zero-usage default).
            return {
              status: "emitted",
              body: outcome.structuredOutput,
              ...(outcome.usage === undefined ? {} : { tokens: outcome.usage }),
            };
          }
          if (outcome.status === "failed") {
            return { status: "failed", message: outcome.error.message };
          }
          return { status: "failed", message: "the harness turn was cancelled" };
        }
      }
      return { status: "failed", message: "the harness stream ended without a terminal frame" };
    } finally {
      await session.close();
    }
  };
}
