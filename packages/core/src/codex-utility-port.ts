/**
 * The CodexUtilityPort (issue #66) — the first alternate model seat.
 *
 * The Model Council (#69) NAMES a Codex seat via `providerHarness(model)`; this
 * module EXECUTES it for the light tier. It routes RSP document emission onto
 * cheap Codex models (gpt-5.6-luna low by default) at $0 metered on a
 * subscription account, behind a clean injected `CodexExecutor` boundary — so
 * `core` stays node-free (no `node:child_process` at module scope) and the real
 * `codex exec` spawn lives in `@rennet/adapters`.
 *
 * The trust model is identical to the agentic path (`runDecompositionAngle`): the
 * executor emits ONLY the body, schema-constrained; this port builds the
 * trustworthy envelope around it — minting the `docId`, stamping `provenance`
 * including a real `inputDigest` — so "agents never mint identity" is a
 * structural property, not an instruction. The deterministic `validateDocument`
 * is the admission authority; on rejection the machine-readable report is fed
 * back into the next attempt (≤2 retries). "Never admits blind" is structural:
 * `status: "admitted"` is only ever constructed inside `if (report.admitted)`.
 */

import { bodyJsonSchema, computeInputDigest, validateDocument } from "@rennet/protocol";
import type {
  OfferedManifest,
  PatchsetRef,
  RspCapabilitySnapshot,
  RspDocType,
  RspEnvelope,
  RspProvenance,
  RspTokenUsage,
  ValidationReport,
} from "@rennet/types";

// ── The executor seam (implemented by @rennet/adapters as a real `codex exec`) ─

/** One structured-output `codex exec` invocation. The prompt and schema are
 *  already assembled/derived by the port; the executor is a thin process seam. */
export interface CodexExecRequest {
  /** The Codex model, e.g. "gpt-5.6-luna". Passed to `codex exec -m`. */
  readonly model: string;
  /** The reasoning effort, e.g. "low". Passed to `-c model_reasoning_effort=`. */
  readonly effort: string;
  /** The fully-assembled prompt (system + user + any fed-back rejection report). */
  readonly prompt: string;
  /** The JSON schema constraining the output (`--output-schema`); omitted when the
   *  docType has no body schema in this slice. */
  readonly outputSchema?: unknown;
  readonly signal?: AbortSignal;
}

/** The result of one `codex exec` call: the parsed final structured message. */
export interface CodexExecResult {
  /** The parsed body captured from `-o <file>` (the final structured message). */
  readonly output: unknown;
  /** Best-effort token usage; Codex exposes little/none per call on subscription. */
  readonly tokens?: RspTokenUsage;
  /** The `codex` binary version, when the composition root discovered it. */
  readonly harnessVersion?: string;
}

export type CodexExecutor = (req: CodexExecRequest) => Promise<CodexExecResult>;

// ── The port surface ──────────────────────────────────────────────────────────

/** Provenance the caller knows before the run; the rest is stamped per attempt. */
export interface CodexUtilitySeed {
  /** Defaults to "codex". */
  readonly harness?: string;
  /** Defaults to the executor-reported version, else "unknown". */
  readonly harnessVersion?: string;
  /** Defaults to `CODEX_ADAPTER_VERSION`. */
  readonly adapterVersion?: string;
}

export interface CodexUtilityCompleteRequest {
  /** The document type to emit; determines the output schema and validation. */
  readonly docType: RspDocType;
  /** The task prompt. */
  readonly prompt: string;
  /** An optional system preamble, prepended to the prompt (codex exec has no
   *  separate system flag). */
  readonly system?: string;
  /** Defaults to `DEFAULT_CODEX_UTILITY_MODEL`. */
  readonly model?: string;
  /** Defaults to `DEFAULT_CODEX_UTILITY_EFFORT`. */
  readonly effort?: string;
  /** The immutable patchset the document binds to (for `inputDigest`/validation). */
  readonly patchset: PatchsetRef;
  /** The offered manifest the validator resolves anchors against. */
  readonly manifest: OfferedManifest;
  /** Retries after the first attempt. Default 2 (three attempts total). */
  readonly maxRetries?: number;
  readonly signal?: AbortSignal;
}

export interface CodexUtilityAttempt {
  readonly attempt: number;
  readonly outcome: "admitted" | "rejected" | "exec-failed";
  /** The validation report for an attempt that produced a body. */
  readonly report?: ValidationReport;
  /** The executor error message on an exec failure. */
  readonly execError?: string;
}

/**
 * The terminal result. Fail-closed by construction: `admitted` is only ever
 * returned when `report.admitted` is true; `rejected` carries a real rejection
 * report; `exec-failed` means the executor never produced a document.
 */
export type CodexUtilityResult =
  | {
      readonly status: "admitted";
      readonly document: RspEnvelope;
      readonly report: ValidationReport;
      readonly tokens: RspTokenUsage;
      readonly attempts: readonly CodexUtilityAttempt[];
    }
  | {
      readonly status: "rejected";
      readonly report: ValidationReport;
      readonly attempts: readonly CodexUtilityAttempt[];
    }
  | {
      readonly status: "exec-failed";
      readonly message: string;
      readonly attempts: readonly CodexUtilityAttempt[];
    };

export interface CodexUtilityPort {
  complete(req: CodexUtilityCompleteRequest): Promise<CodexUtilityResult>;
}

export interface CreateCodexUtilityPortDeps {
  readonly executor: CodexExecutor;
  readonly seed?: CodexUtilitySeed;
  readonly mintDocId?: () => string;
  readonly newRunId?: () => string;
}

// ── Defaults ──────────────────────────────────────────────────────────────────

/** Table 1's light-tier formatting default (Model Council §3). */
export const DEFAULT_CODEX_UTILITY_MODEL = "gpt-5.6-luna";
export const DEFAULT_CODEX_UTILITY_EFFORT = "low";
export const CODEX_ADAPTER_VERSION = "0.1.0";

/**
 * The capability snapshot a codex-exec utility call earns, stamped HONESTLY per
 * call. V003 requires both `structuredOutput` and `perCallModelSelection`, each
 * with three layers. The adapter implements `--output-schema` and codex advertises
 * it (static facts, always true), and the model is always selected via `-m` (so
 * `perCallModelSelection` is always available). But structured output is only
 * `availableInSession` when THIS call actually passed a schema: a docType with no
 * body schema (`bodyJsonSchema` → null) constrains nothing, so claiming it was
 * available would be dishonest provenance. This is exactly the three-layer
 * doctrine (`RspCapabilityLayers`): a CI-proven flag can still be unavailable in a
 * given session, and a document produced under a degraded capability is labelled
 * rather than silently trusted.
 */
function codexUtilityCapability(structuredOutputExercised: boolean): RspCapabilitySnapshot {
  return {
    structuredOutput: {
      implementedByAdapter: true,
      advertisedByHarness: true,
      availableInSession: structuredOutputExercised,
    },
    perCallModelSelection: {
      implementedByAdapter: true,
      advertisedByHarness: true,
      availableInSession: true,
    },
  };
}

const ZERO_TOKENS: RspTokenUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: null,
  total: 0,
};

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A 26-char Crockford base32 id (ULID-shaped), the port's minted identity. */
function defaultMintDocId(): string {
  let out = "";
  for (let index = 0; index < 26; index += 1) {
    out += CROCKFORD.charAt(Math.floor(Math.random() * CROCKFORD.length));
  }
  return out;
}

function defaultRunId(): string {
  return `run_${Math.floor(Math.random() * 1e9).toString(36)}`;
}

/** Fold the optional system preamble, the user prompt, and any fed-back rejection
 *  report into the single positional prompt `codex exec` accepts. */
function assemblePrompt(
  system: string | undefined,
  user: string,
  retryReport: string | undefined,
): string {
  const parts: string[] = [];
  if (system !== undefined && system.length > 0) parts.push(system);
  parts.push(user);
  if (retryReport !== undefined) parts.push(retryReport);
  return parts.join("\n\n");
}

/** Format a validation report into the machine-readable text fed back on retry. */
function renderReport(report: ValidationReport): string {
  const lines = report.errors.map(
    (error) => `- ${error.code} at ${error.pointer}: ${error.message}`,
  );
  const rejected = report.rejectedItems.flatMap((item) =>
    item.errors.map((error) => `- ${error.code} at ${error.pointer}: ${error.message}`),
  );
  const all = [...lines, ...rejected];
  return `The previous document was REJECTED. Fix every error and re-emit:\n${all.join("\n")}`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function buildProvenance(args: {
  seed: CodexUtilitySeed | undefined;
  model: string;
  effort: string;
  inputDigest: string;
  runId: string;
  tokens: RspTokenUsage;
  harnessVersion: string | undefined;
  /** Whether this call actually passed an `--output-schema` (honest capability). */
  structuredOutputExercised: boolean;
}): RspProvenance {
  return {
    harness: args.seed?.harness ?? "codex",
    // Live executor-reported version wins over a static seed, then "unknown".
    harnessVersion: args.harnessVersion ?? args.seed?.harnessVersion ?? "unknown",
    adapterVersion: args.seed?.adapterVersion ?? CODEX_ADAPTER_VERSION,
    model: args.model,
    // We set the model via `-m`; `codex exec -o` carries only the final message,
    // never the model, so the model was learned from config, not the harness.
    modelReportedBy: "config",
    tier: "light",
    route: "utility",
    runId: args.runId,
    inputDigest: args.inputDigest,
    capability: codexUtilityCapability(args.structuredOutputExercised),
    tokens: args.tokens,
    // Codex exposes no per-call USD (moot on subscription); never substituted.
    reportedUsd: null,
    derivedUsd: null,
    effort: args.effort,
  };
}

/**
 * Build the CodexUtilityPort over an injected executor. `complete` derives the
 * output schema from the docType, computes the input digest, and loops:
 * assemble → execute → stamp envelope → validate → (admit | feed the report
 * back). It fails closed — a rejected document is never admitted.
 */
export function createCodexUtilityPort(deps: CreateCodexUtilityPortDeps): CodexUtilityPort {
  const mintDocId = deps.mintDocId ?? defaultMintDocId;
  const newRunId = deps.newRunId ?? defaultRunId;

  return {
    async complete(req: CodexUtilityCompleteRequest): Promise<CodexUtilityResult> {
      const model = req.model ?? DEFAULT_CODEX_UTILITY_MODEL;
      const effort = req.effort ?? DEFAULT_CODEX_UTILITY_EFFORT;
      const maxRetries = req.maxRetries ?? 2;
      const outputSchema = bodyJsonSchema(req.docType);
      const inputDigest = computeInputDigest(req.patchset, req.manifest);

      const attempts: CodexUtilityAttempt[] = [];
      let lastReportText: string | undefined;

      for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        // Fail fast on cancellation: never spend a (subscription-quota) executor
        // call for a request that has already been aborted, and never retry one.
        // This covers both a pre-aborted signal (0 calls) and an abort mid-flight
        // (the rejected call lands in the catch, then this guard stops the retry).
        if (req.signal?.aborted) break;
        const prompt = assemblePrompt(req.system, req.prompt, lastReportText);

        let exec: CodexExecResult;
        try {
          exec = await deps.executor({
            model,
            effort,
            prompt,
            ...(outputSchema === null ? {} : { outputSchema }),
            ...(req.signal === undefined ? {} : { signal: req.signal }),
          });
        } catch (error) {
          attempts.push({ attempt, outcome: "exec-failed", execError: messageOf(error) });
          // An exec failure produced no document, so there is nothing to feed back.
          lastReportText = undefined;
          continue;
        }

        const tokens = exec.tokens ?? ZERO_TOKENS;
        const provenance = buildProvenance({
          seed: deps.seed,
          model,
          effort,
          inputDigest,
          runId: newRunId(),
          tokens,
          harnessVersion: exec.harnessVersion,
          structuredOutputExercised: outputSchema !== null,
        });
        const document: RspEnvelope = {
          rsp: 1,
          docType: req.docType,
          schemaVersion: 1,
          docId: mintDocId(),
          patchsetId: req.patchset.id,
          provenance,
          body: exec.output,
          x: {},
        };
        const report = validateDocument({
          document,
          patchset: req.patchset,
          manifest: req.manifest,
        });

        if (report.admitted) {
          attempts.push({ attempt, outcome: "admitted", report });
          return { status: "admitted", document, report, tokens, attempts };
        }
        attempts.push({ attempt, outcome: "rejected", report });
        lastReportText = renderReport(report);
      }

      // Terminal: never admitted. Prefer the more-informative rejection (the last
      // attempt that produced a report) over a bare exec failure.
      const lastRejection = [...attempts]
        .reverse()
        .find(
          (entry): entry is CodexUtilityAttempt & { report: ValidationReport } =>
            entry.outcome === "rejected" && entry.report !== undefined,
        );
      if (lastRejection !== undefined) {
        return { status: "rejected", report: lastRejection.report, attempts };
      }
      // A cancelled request that never produced a rejection is distinguishable
      // from an ordinary executor crash: the caller can tell "cancelled" apart.
      if (req.signal?.aborted) {
        return {
          status: "exec-failed",
          message: "codex utility port aborted before completion",
          attempts,
        };
      }
      const lastError =
        [...attempts].reverse().find((entry) => entry.outcome === "exec-failed")?.execError ??
        "the codex utility port produced no document";
      return { status: "exec-failed", message: lastError, attempts };
    },
  };
}
