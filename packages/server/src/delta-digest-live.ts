import {
  type CodexExecutor,
  type DeltaDigestPort,
  type DeltaDigestPortResult,
  deltaDigestContextFile,
  draftDeltaDigest,
  type HarnessPort,
  providerHarness,
  resolveAssignment,
} from "@rennet/core";
import type { PromptContextFile } from "@rennet/prompts";
import type {
  CouncilHarnessId,
  DeltaDigestResult,
  Review,
  SuccessorAccount,
} from "@rennet/protocol";

// ─────────────────────────────────────────────────────────────────────────────
// review.deltaDigest — the LIVE producer (issue #73 / M25).
//
// The structural sibling of `draft-pr-body-live.ts`: `packages/core`'s
// `draftDeltaDigest` router owns the whole mapping law (emitted → drafted, the
// empty-text honesty floor) and is unit-proven; this module supplies the ONE real
// turn behind it. Council-routed: `resolveAssignment` picks the model + effort for
// the `delta-rereview-summary` job (the previously-dead catalogue row M25 goes live
// HERE), and the turn runs on WHICHEVER harness the council resolves.
//
// BOTH seats are live, exactly as the PR-body drafter:
//   • Codex — one `codex exec` constrained to the inline `{digest}` schema.
//   • Claude — one light read-only adapter session with the SAME inline schema passed
//     to the SDK's `json_schema` output format.
//
// The digest degrades to an honest `unavailable` when NEITHER seat is installed, and
// to `failed` on any turn that produces no usable text. A failed/unavailable turn
// NEVER fabricates a digest — the panel shows the deterministic facts with no headline,
// never a blank the reviewer reads as "nothing to see". This producer posts NOTHING
// and gates nothing: it returns text into a panel (R33). The turn is fed ONLY the
// structured account (never diff or repo content), so it cannot add a fact the facts
// don't carry.
//
// Electron-free by construction (injected functions as values), so it is unit-testable
// with fakes — no Electron, no real `codex`, no real `claude`.
// ─────────────────────────────────────────────────────────────────────────────

/** The council job id for the delta re-review digest (light tier, M25). */
const DELTA_DIGEST_JOB_ID = "delta-rereview-summary";

/**
 * The tiny structured-output schema the digest turn is constrained to: a single
 * `digest` string (one or two sentences). Strict-safe (required) for OpenAI
 * structured outputs; a null/absent field maps to the core producer's honesty floor
 * (empty ⇒ failed, never a blank headline).
 */
export const DELTA_DIGEST_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    digest: {
      type: "string",
      description:
        "A one- or two-sentence plain-English summary of what the agent addressed, left, and changed beyond the asks. No markdown.",
    },
  },
  required: ["digest"],
  additionalProperties: false,
} as const;

/** Render a thrown value into a turn-failure message. */
function describeThrow(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return String(error);
  } catch {
    return "an uncoercible non-Error value";
  }
}

/**
 * Map a model's structured output to a `DeltaDigestPortResult` — shared by both seats.
 * A `digest` that is not a string rides through as absent, and the core router enforces
 * the empty-text honesty floor over it (never a fabricated digest).
 */
function mapDigestOutput(output: unknown): DeltaDigestPortResult {
  const record = output as { digest?: unknown } | null;
  const text = typeof record?.digest === "string" ? record.digest : undefined;
  return { status: "emitted", ...(text === undefined ? {} : { text }) };
}

/**
 * Build a `DeltaDigestPort` over a Codex executor bound to the council-resolved model +
 * effort. One `codex exec` per digest, constrained to `DELTA_DIGEST_OUTPUT_SCHEMA`. A
 * non-zero exit / no-output / non-JSON throws inside the executor; caught and returned
 * as the honest `failed` outcome the core router passes straight through.
 */
export function codexDeltaDigestPort(
  executor: CodexExecutor,
  model: string,
  effort: string,
  cwd: string,
): DeltaDigestPort {
  return async (prompt) => {
    try {
      const result = await executor({
        model,
        effort,
        prompt,
        cwd,
        outputSchema: DELTA_DIGEST_OUTPUT_SCHEMA,
        label: "delta-digest",
      });
      const mapped = mapDigestOutput(result.output);
      return mapped.status === "emitted" && result.model !== undefined
        ? { ...mapped, model: result.model }
        : mapped;
    } catch (error) {
      return { status: "failed", reason: `the delta-digest turn failed: ${describeThrow(error)}` };
    }
  };
}

/**
 * Build a `DeltaDigestPort` over the Claude harness adapter. One light READ-ONLY
 * session per digest, with `DELTA_DIGEST_OUTPUT_SCHEMA` passed to the SDK's
 * `json_schema` output format. The session never writes or execs; `cwd` is the reviewed
 * repo root. Anything but a completed turn with structured output is an honest failure;
 * the session is always closed.
 */
export function claudeDeltaDigestPort(port: HarnessPort, cwd: string): DeltaDigestPort {
  return async (prompt) => {
    let session: Awaited<ReturnType<HarnessPort["createSession"]>>;
    try {
      session = await port.createSession({
        cwd,
        outputSchema: DELTA_DIGEST_OUTPUT_SCHEMA,
        ephemeral: true,
      });
    } catch (error) {
      return {
        status: "failed",
        reason: `the delta-digest session failed to start: ${describeThrow(error)}`,
      };
    }
    try {
      await session.send({ prompt });
      let actualModel: string | undefined;
      for await (const event of session.events) {
        if (event.kind === "session.started") actualModel = event.model;
        if (event.kind === "error") return { status: "failed", reason: event.error.message };
        if (event.kind === "session.ended") {
          const outcome = event.outcome;
          if (outcome.status === "completed") {
            if (outcome.structuredOutput === undefined) {
              return {
                status: "failed",
                reason: "the delta-digest turn produced no structured output",
              };
            }
            const mapped = mapDigestOutput(outcome.structuredOutput);
            return mapped.status === "emitted" && actualModel !== undefined
              ? { ...mapped, model: actualModel }
              : mapped;
          }
          if (outcome.status === "failed")
            return { status: "failed", reason: outcome.error.message };
          return { status: "failed", reason: "the delta-digest turn was cancelled" };
        }
      }
      return { status: "failed", reason: "the delta-digest turn ended without a terminal frame" };
    } catch (error) {
      return { status: "failed", reason: `the delta-digest turn threw: ${describeThrow(error)}` };
    } finally {
      await session.close();
    }
  };
}

/** The deps the live producer is bound to (all injected so the module stays testable). */
export interface LiveDeltaDigestDeps {
  /** The Claude harness adapter, or null when no `claude` is installed. */
  claudePort(repoRoot: string): Promise<HarnessPort | null>;
  /** The Codex executor resolved to the absolute binary, or null. Receives the
   *  review's repo root (#334) so a WSL project resolves the distro seat. */
  codexExecutor(repoRoot: string): Promise<CodexExecutor | null>;
  /**
   * The ONE session-context writer, bound to the review's session id by the composition
   * root (`writeReviewContext`). Returns the directory it wrote into, relative to the
   * bound root — the prompt names THAT, never a dir re-derived from a review id, so the
   * files a turn is pointed at are the files `session.archive` purges (review finding 1).
   */
  writeContext(review: Review, files: readonly PromptContextFile[]): string;
}

/**
 * Build the LIVE `review.deltaDigest` producer. Derives council availability from the
 * same probes it executes on, resolves the model/effort through the council, and runs
 * the one real turn on WHICHEVER harness the council picked. Degrades to an honest
 * `unavailable` (never a throw, never a fabricated digest) when NEITHER seat backs the
 * resolved harness.
 */
export function createLiveDeltaDigestPort(
  deps: LiveDeltaDigestDeps,
): (input: { review: Review; account: SuccessorAccount }) => Promise<DeltaDigestResult> {
  return async (input) => {
    const [claudePort, executor] = await Promise.all([
      deps.claudePort(input.review.repositoryRoot),
      deps.codexExecutor(input.review.repositoryRoot),
    ]);
    const installed: CouncilHarnessId[] = [];
    if (claudePort !== null) installed.push("claude-code");
    if (executor !== null) installed.push("codex");

    const resolution = resolveAssignment(DELTA_DIGEST_JOB_ID, { availability: { installed } });
    if (resolution.kind !== "model") {
      return { status: "unavailable", reason: "delta-digest resolved to no model seat" };
    }

    const harness = providerHarness(resolution.model);
    let port: DeltaDigestPort | null = null;
    if (harness === "codex" && executor !== null) {
      port = codexDeltaDigestPort(
        executor,
        resolution.model,
        resolution.effort,
        input.review.repositoryRoot,
      );
    } else if (harness === "claude-code" && claudePort !== null) {
      port = claudeDeltaDigestPort(claudePort, input.review.repositoryRoot);
    }
    if (port === null) {
      return { status: "unavailable", reason: "delta-digest has no model seat installed" };
    }
    // The account goes to disk under the repo root the turn runs in, BEFORE the turn
    // (session-context-files); the prompt names it by relative path. The grounding
    // guarantee is unchanged — that file is still the only thing the turn may state.
    const contextDir = deps.writeContext(input.review, [deltaDigestContextFile(input.account)]);
    return draftDeltaDigest(contextDir, port, resolution.model);
  };
}
