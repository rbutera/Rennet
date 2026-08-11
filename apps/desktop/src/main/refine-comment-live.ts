import {
  type CodexExecutor,
  type HarnessPort,
  providerHarness,
  type RefinePort,
  type RefinePortResult,
  refineComment,
  resolveAssignment,
} from "@rennet/core";
import type {
  CouncilHarnessId,
  DispositionType,
  Patchset,
  RefinementResult,
  Review,
} from "@rennet/types";

// ─────────────────────────────────────────────────────────────────────────────
// review.refine — the LIVE producer (issue #19).
//
// The structural sibling of `review-ask-live.ts`: `packages/core`'s
// `refineComment` router owns the whole mapping law (verdict → result, the
// empty/byte-identical honesty floor) and is unit-proven; this module supplies
// the ONE real turn behind it. Council-routed: `resolveAssignment` picks the
// model + effort for the `comment-refinement` job (the previously-dead catalogue
// row goes live here), and the turn runs on WHICHEVER harness the council resolves.
//
// BOTH seats are live:
//   • Codex — one `codex exec` constrained to the inline `{verdict, refinedBody}`
//     schema (the executor `review.ask`'s Codex leg uses). The council's
//     refinement assignment whenever Codex is installed (Terra).
//   • Claude — one light read-only adapter session with the SAME inline schema
//     passed straight through to the SDK's `json_schema` output format. This is
//     the exact structured-output mechanism every pipeline lens seat already uses
//     live — it needs NO `comment-refinement` RSP docType. It carries a
//     Claude-only machine (the council resolves Sonnet there).
//
// A refine only degrades to an honest `unavailable` when NEITHER seat is
// installed. A failed/unavailable turn NEVER returns the raw dressed as refined —
// the renderer keeps the user's note as the effective body.
//
// Electron-free by construction (injected functions as values), so it is
// unit-testable with fakes — no Electron, no real `codex`, no real `claude`.
// ─────────────────────────────────────────────────────────────────────────────

/** The council job id for comment refinement (light tier, §2.2 row 14). */
const REFINE_JOB_ID = "comment-refinement";

/** How much of the anchored file's diff is inlined for grounding (bounded so a
 *  huge file cannot blow the prompt; the note usually carries the intent, the diff
 *  makes the cleanup "investigated" rather than blind). */
export const REFINE_DIFF_CEILING = 8_000;

/**
 * The tiny structured-output schema the refine turn is constrained to. `verdict`
 * decides refined-vs-no-change; `refinedBody` carries the cleaned comment on a
 * refined verdict. `refinedBody` is optional here — the executor's
 * `sanitizeSchemaForCodex` makes it strict-safe (required + nullable) for OpenAI
 * structured outputs, and a null/absent body maps to the core producer's
 * honesty floor (a refined verdict with no body is a failure, never a blank post).
 */
export const REFINE_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    verdict: {
      type: "string",
      enum: ["refined", "no-change"],
      description:
        "Whether you improved the wording (refined) or it was already clear (no-change).",
    },
    refinedBody: {
      type: "string",
      description:
        "The cleaned comment, in the reviewer's first person. Required when verdict is refined.",
    },
  },
  required: ["verdict"],
  additionalProperties: false,
} as const;

/** The active patchset a review's diff is read from (the same finder the app uses). */
function activePatchsetOf(review: Review): Patchset {
  const patchset = review.patchsets.find((candidate) => candidate.id === review.activePatchsetId);
  if (!patchset) throw new Error("The active patchset is missing");
  return patchset;
}

/**
 * Extract the section of a unified diff for one file, bounded to `maxBytes`. A
 * unified diff opens each file with `diff --git a/<path> b/<path>`; this returns
 * from that header to the next `diff --git` (or EOF). Returns "" when the path is
 * not in the diff (a path-grained note with no single hunk, or an unmatched path)
 * — the refiner then cleans from the note alone, which is honest and still the
 * whole "messy in, clean out" promise. Pure and string-only (testable).
 */
export function extractFileDiff(rawDiff: string, path: string, maxBytes: number): string {
  const lines = rawDiff.split("\n");
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line?.startsWith("diff --git ") && line.includes(` b/${path}`)) {
      start = i;
      break;
    }
  }
  if (start === -1) return "";
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i]?.startsWith("diff --git ")) {
      end = i;
      break;
    }
  }
  const section = lines.slice(start, end).join("\n");
  if (section.length <= maxBytes) return section;
  return `${section.slice(0, maxBytes)}\n… (diff truncated at ${maxBytes} bytes)`;
}

/** Render a thrown value into a turn-failure message (mirrors harness-run-turn). */
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
 * Map a model's structured output to a `RefinePortResult` — shared by both seats,
 * so Codex and Claude produce byte-identical results for the core router. An
 * unrecognised verdict is a failure (never a fabricated refine); a `no-change`
 * with an absent body is honest; a `refined` verdict's body (if any) rides
 * through and the core router enforces the empty/byte-identical floor over it.
 */
function mapRefineOutput(output: unknown): RefinePortResult {
  const record = output as { verdict?: unknown; refinedBody?: unknown } | null;
  const verdict = record?.verdict;
  if (verdict !== "refined" && verdict !== "no-change") {
    return { status: "failed", reason: "the refiner returned an unrecognised verdict" };
  }
  const refinedBody = typeof record?.refinedBody === "string" ? record.refinedBody : undefined;
  return { status: "emitted", verdict, ...(refinedBody === undefined ? {} : { refinedBody }) };
}

/**
 * Build a `RefinePort` over a Codex executor bound to the council-resolved model +
 * effort. One `codex exec` per refine, constrained to `REFINE_OUTPUT_SCHEMA`. A
 * non-zero exit / no-output / non-JSON throws INSIDE the executor; we catch it and
 * return the honest `failed` outcome the core router passes straight through — the
 * raw note stays the effective body, never a fabricated refinement.
 */
export function codexRefinePort(
  executor: CodexExecutor,
  model: string,
  effort: string,
): RefinePort {
  return async (prompt) => {
    try {
      const result = await executor({ model, effort, prompt, outputSchema: REFINE_OUTPUT_SCHEMA });
      return mapRefineOutput(result.output);
    } catch (error) {
      return { status: "failed", reason: `the refine turn failed: ${describeThrow(error)}` };
    }
  };
}

/**
 * Build a `RefinePort` over the Claude harness adapter. One light READ-ONLY
 * session per refine, with `REFINE_OUTPUT_SCHEMA` passed straight to the SDK's
 * `json_schema` output format — the SAME structured-output mechanism every
 * pipeline lens seat uses, so no `comment-refinement` docType is needed. The drain
 * mirrors `createHarnessRunTurn`: a completed turn with structured output emits;
 * everything else (a construction throw, an error frame, a failed/cancelled
 * outcome, no structured output) is an honest turn failure. The session is always
 * closed. `cwd` is the reviewed repo root; the session never writes or execs.
 */
export function claudeRefinePort(port: HarnessPort, cwd: string, model?: string): RefinePort {
  return async (prompt) => {
    let session: Awaited<ReturnType<HarnessPort["createSession"]>>;
    try {
      session = await port.createSession({
        cwd,
        readOnly: true,
        outputSchema: REFINE_OUTPUT_SCHEMA,
        ...(model === undefined ? {} : { model }),
      });
    } catch (error) {
      return {
        status: "failed",
        reason: `the refine session failed to start: ${describeThrow(error)}`,
      };
    }
    try {
      await session.send({ prompt });
      for await (const event of session.events) {
        if (event.kind === "error") return { status: "failed", reason: event.error.message };
        if (event.kind === "session.ended") {
          const outcome = event.outcome;
          if (outcome.status === "completed") {
            if (outcome.structuredOutput === undefined) {
              return { status: "failed", reason: "the refine turn produced no structured output" };
            }
            return mapRefineOutput(outcome.structuredOutput);
          }
          if (outcome.status === "failed")
            return { status: "failed", reason: outcome.error.message };
          return { status: "failed", reason: "the refine turn was cancelled" };
        }
      }
      return { status: "failed", reason: "the refine turn ended without a terminal frame" };
    } catch (error) {
      return { status: "failed", reason: `the refine turn threw: ${describeThrow(error)}` };
    } finally {
      await session.close();
    }
  };
}

/** The input the dispatch route hands the live port (the already-resolved review). */
export interface LiveRefineInput {
  readonly review: Review;
  readonly type: DispositionType;
  readonly raw: string;
  readonly lens?: string;
  readonly path?: string;
}

/** The deps the live port is bound to (all injected so the module stays testable). */
export interface LiveRefineDeps {
  /**
   * The Claude harness adapter, or null when no `claude` is installed. Null is both
   * the "Claude not installed" half of the council availability and the "no Claude
   * seat to run" signal.
   */
  claudePort(): Promise<HarnessPort | null>;
  /**
   * The Codex executor, resolved to the absolute binary (bead workspace-6qp15),
   * or null when no `codex` is installed. Null is both the "Codex not installed"
   * half of the council availability and the "no Codex seat to run" signal — the
   * port returns an honest `unavailable` rather than shelling a bad `codex`.
   */
  codexExecutor(): Promise<CodexExecutor | null>;
}

/**
 * Build the LIVE `review.refine` port. Derives the council availability from the
 * same probes it executes on (claude adapter + codex executor), resolves the
 * model/effort through the council, and runs the one real turn on WHICHEVER
 * harness the council picked. Degrades to an honest `unavailable` (never a throw,
 * never a fabricated refine) only when NEITHER seat backs the resolved harness.
 */
export function createLiveRefinePort(
  deps: LiveRefineDeps,
): (input: LiveRefineInput) => Promise<RefinementResult> {
  return async (input) => {
    // Probe both seats once; each probe is both an availability signal and the
    // executable. The council resolves comment-refinement to Codex (Terra) whenever
    // Codex is installed (Table 1 + Table 3), and to Claude (Sonnet) on a
    // Claude-only machine (Table 2); both are now live.
    const [claudePort, executor] = await Promise.all([deps.claudePort(), deps.codexExecutor()]);
    const installed: CouncilHarnessId[] = [];
    if (claudePort !== null) installed.push("claude-code");
    if (executor !== null) installed.push("codex");

    const resolution = resolveAssignment(REFINE_JOB_ID, { availability: { installed } });
    if (resolution.kind !== "model") {
      return { status: "unavailable", reason: "comment refinement resolved to no model seat" };
    }

    const harness = providerHarness(resolution.model);
    let port: RefinePort | null = null;
    if (harness === "codex" && executor !== null) {
      port = codexRefinePort(executor, resolution.model, resolution.effort);
    } else if (harness === "claude-code" && claudePort !== null) {
      // Follow the pipeline's Claude-seat convention: the council model rides the
      // result as provenance, but the session runs on the adapter's own default
      // model (the pipeline does not re-model its Claude seats either).
      port = claudeRefinePort(claudePort, input.review.repositoryRoot);
    }
    if (port === null) {
      // Neither seat backs the resolved harness — no model to refine with.
      return {
        status: "unavailable",
        reason: "comment refinement has no model seat installed",
      };
    }

    const context = input.path
      ? extractFileDiff(activePatchsetOf(input.review).rawDiff, input.path, REFINE_DIFF_CEILING)
      : "";
    return refineComment(
      {
        raw: input.raw,
        type: input.type,
        ...(input.lens === undefined ? {} : { lens: input.lens }),
        ...(input.path === undefined ? {} : { path: input.path }),
        ...(context === "" ? {} : { context }),
      },
      port,
      resolution.model,
    );
  };
}
