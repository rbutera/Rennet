import {
  type CodexExecutor,
  providerHarness,
  type RefinePort,
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
// row goes live here), and the turn runs on the resolved Codex seat — the same
// `codex exec` executor `review.ask`'s Codex leg uses.
//
// Slice A runs the refiner on the Codex seat only. A machine with no Codex
// installed (the council then resolves a Claude model) has no refiner in this
// slice: the port returns an HONEST `unavailable`, and the renderer keeps showing
// the user's raw note — the loop failing is worse prose, never lost work, never a
// silent rewrite. Wiring a Claude structured seat (a `comment-refinement` RSP
// docType) is the documented follow-up.
//
// Electron-free by construction (injected functions as values), so it is
// unit-testable with fakes — no Electron, no real `codex`.
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
      const output = result.output as { verdict?: unknown; refinedBody?: unknown } | null;
      const verdict = output?.verdict;
      if (verdict !== "refined" && verdict !== "no-change") {
        return { status: "failed", reason: "the refiner returned an unrecognised verdict" };
      }
      const refinedBody = typeof output?.refinedBody === "string" ? output.refinedBody : undefined;
      return { status: "emitted", verdict, ...(refinedBody === undefined ? {} : { refinedBody }) };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return { status: "failed", reason: `the refine turn failed: ${detail}` };
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
  /** Whether the Claude adapter is installed — one half of the council availability. */
  claudeInstalled(): Promise<boolean>;
  /**
   * The Codex executor, resolved to the absolute binary (bead workspace-6qp15),
   * or null when no `codex` is installed. Null is BOTH the "Codex not installed"
   * half of the council availability AND the "no seat to run" signal — the port
   * returns an honest `unavailable` rather than shelling a bad `codex`.
   */
  codexExecutor(): Promise<CodexExecutor | null>;
}

/**
 * Build the LIVE `review.refine` port. Derives the council availability from the
 * same probes it executes on (claude adapter + codex executor), resolves the
 * model/effort through the council, runs the one real Codex turn on the resolved
 * seat, and returns the router's honest result. Degrades to `unavailable` (never a
 * throw, never a fabricated refine) when the Codex seat is not resolvable.
 */
export function createLiveRefinePort(
  deps: LiveRefineDeps,
): (input: LiveRefineInput) => Promise<RefinementResult> {
  return async (input) => {
    // Probe both seats once; the Codex probe is both the availability signal and
    // the executor. (Refinement resolves to the Codex seat whenever Codex is
    // installed — Table 1 and Table 3 both assign it to Terra — so a Claude-only
    // machine is the only `unavailable` case; the claude probe keeps the trace honest.)
    const [claude, executor] = await Promise.all([deps.claudeInstalled(), deps.codexExecutor()]);
    const installed: CouncilHarnessId[] = [];
    if (claude) installed.push("claude-code");
    if (executor !== null) installed.push("codex");

    const resolution = resolveAssignment(REFINE_JOB_ID, { availability: { installed } });
    if (resolution.kind !== "model") {
      return { status: "unavailable", reason: "comment refinement resolved to no model seat" };
    }
    if (executor === null || providerHarness(resolution.model) !== "codex") {
      // No Codex seat resolvable in this slice: either `codex` is not installed, or
      // the council resolved a Claude seat (a Claude-only machine, or a pin). Slice
      // A has no Claude refiner; say so plainly rather than fake or crash.
      return {
        status: "unavailable",
        reason: "comment refinement needs the Codex seat, which is not installed",
      };
    }
    const context = input.path
      ? extractFileDiff(activePatchsetOf(input.review).rawDiff, input.path, REFINE_DIFF_CEILING)
      : "";
    const port = codexRefinePort(executor, resolution.model, resolution.effort);
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
