import {
  type AskAnswer,
  type CodexExecutor,
  DEFAULT_CODEX_UTILITY_EFFORT,
  DEFAULT_CODEX_UTILITY_MODEL,
  type ReviewPipelineResult,
} from "@rennet/core";
import type { Patchset, Review } from "@rennet/types";
import type { OrchestratorTurnRunner } from "./orchestrator";

// ─────────────────────────────────────────────────────────────────────────────
// review.ask — the LIVE ports (issue #139, bead workspace-alqow).
//
// `packages/core`'s `askReview` router owns the whole routing law (orchestrator
// once, "both" adds Codex, NEVER a synthesis) and is unit-proven. What was
// deferred was the LIVE invocation behind the two ports: `reviewAskFixturePorts()`
// returned canned answers. This module replaces that fixture with the real thing —
//
//   • `askOrchestrator` drives the live `claude` turn over the in-process
//     canvasOps@2 MCP server (`orchestratorTurn`, the runner index.ts already
//     composes) so the orchestrator can use context.map / context.file /
//     context.novelty to reason about the review, then returns its final text.
//   • `askCodex` shells one `codex exec` (the same executor the pipeline's Codex
//     seat uses) over the review's diff + the question, returning a plain answer.
//
// Neither port touches the router's law: this module only supplies the two ports
// the router already calls, so "no synthesis, ever" stays exactly where it was
// proven. Both ports fail HONESTLY (a typed unavailable/failed answer, never a
// crash and never a fabricated success), mirroring the pipeline's degradation.
//
// Electron-free by construction (it takes injected functions as values), so it is
// unit-testable with fakes — no Electron, no real `claude`, no real `codex`.
// ─────────────────────────────────────────────────────────────────────────────

/** The label on the orchestrator's card (matches the fixture + prototype frame 14). */
export const ORCHESTRATOR_ASK_LABEL = "Orchestrator · Claude";
/** The label on Codex's second-opinion card. */
export const CODEX_ASK_LABEL = "codex";

/** How much of the raw diff is inlined into the one-shot Codex prompt (bounded so a
 *  huge changeset cannot blow the prompt; the orchestrator, by contrast, reads the
 *  diff through the canvasOps@2 tools rather than inline). */
export const CODEX_ASK_DIFF_CEILING = 40_000;

/** The active patchset a review's diff is read from (the same finder the app uses). */
function activePatchsetOf(review: Review): Patchset {
  const patchset = review.patchsets.find((candidate) => candidate.id === review.activePatchsetId);
  if (!patchset) throw new Error("The active patchset is missing");
  return patchset;
}

/** The deps the live ports are bound to (all injected so the module stays testable). */
export interface LiveReviewAskDeps {
  /**
   * Resolve + freshness-check the addressed review, throwing when the id is not the
   * currently open review (mirrors dispatch's `requireLatestReview`). The ports bind
   * to the LIVE review object so a re-capture is reflected on the next ask.
   */
  resolveReview(reviewId: string): Review;
  /**
   * Build the review's pipeline for the orchestrator turn. The app injects a
   * deterministic-floor build (`buildReviewCanvases` with no lens/model turns): the
   * ask's model spend is the ONE orchestrator turn, not a fresh lens review, and the
   * canvasOps@2 surface serves real decomposition + diffs off the floor pipeline.
   */
  buildPipeline(review: Review): Promise<ReviewPipelineResult>;
  /** The live orchestrator turn runner (claude over the canvasOps@2 MCP server). */
  orchestratorTurn: OrchestratorTurnRunner;
  /**
   * The live Codex second-opinion port. ABSENT when `codex` is not installed, in
   * which case `askCodex` returns an honest "unavailable" answer rather than
   * crashing the "both" ask (the router awaits it, so a throw would sink the whole
   * question — the orchestrator's answer already exists and must survive).
   */
  askCodex?(input: { review: Review; question: string }): Promise<AskAnswer>;
}

/** The dispatch-dep-shaped ports (`{ reviewId, question } → AskAnswer`). */
export interface LiveReviewAskPorts {
  askOrchestrator(input: { reviewId: string; question: string }): Promise<AskAnswer>;
  askCodex(input: { reviewId: string; question: string }): Promise<AskAnswer>;
}

/**
 * Build the LIVE review.ask ports. Drop-in for `reviewAskFixturePorts()`: same
 * `{ reviewId, question } → AskAnswer` shape, so the desktop composition root swaps
 * one for the other and the dispatch path (which runs the real `askReview` router)
 * is unchanged. The negative guarantee — orchestrator-only never calls Codex — lives
 * in that router, not here.
 */
export function createLiveReviewAskPorts(deps: LiveReviewAskDeps): LiveReviewAskPorts {
  return {
    async askOrchestrator({ reviewId, question }) {
      const review = deps.resolveReview(reviewId);
      const pipeline = await deps.buildPipeline(review);
      const outcome = await deps.orchestratorTurn(review, pipeline, question);
      if (!outcome.available) {
        // Fail-closed, honest: no `claude` on the machine → an answer that SAYS so,
        // never a fabricated one. (The primary answer is always produced, in every
        // mode, so this replaces silence with a legible reason.)
        return {
          model: ORCHESTRATOR_ASK_LABEL,
          answer: `The orchestrator is unavailable: ${outcome.reason}`,
        };
      }
      const { result } = outcome;
      if (result.outcome === "failed") {
        const detail = result.error?.message ?? "the turn did not complete";
        return {
          model: ORCHESTRATOR_ASK_LABEL,
          answer: `The orchestrator turn failed: ${detail}`,
        };
      }
      const finalText = result.finalText.trim();
      return {
        model: ORCHESTRATOR_ASK_LABEL,
        answer:
          finalText.length > 0
            ? result.finalText
            : "The orchestrator completed the turn without a final answer.",
      };
    },
    async askCodex({ reviewId, question }) {
      const review = deps.resolveReview(reviewId);
      if (!deps.askCodex) {
        return {
          model: CODEX_ASK_LABEL,
          answer: "Codex is not installed, so no second opinion is available.",
        };
      }
      return deps.askCodex({ review, question });
    },
  };
}

/** The tiny structured-output schema the Codex ask is constrained to — one string
 *  field. Constraining the emission to JSON keeps the exec on the well-trodden
 *  `-o <file>` + `JSON.parse` path (the executor rejects non-JSON), and maps
 *  cleanly onto the `AskAnswer` the router expects. */
export const CODEX_ASK_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    answer: { type: "string", description: "Your answer to the reviewer's question." },
  },
  required: ["answer"],
  additionalProperties: false,
} as const;

/** Assemble the one-shot Codex prompt: a terse instruction, the (bounded) diff of
 *  the review, and the reviewer's question. Codex has no MCP tools this call — it is
 *  a single exec — so the diff is inlined as its whole context. */
export function buildCodexAskPrompt(diff: string, question: string): string {
  const bounded =
    diff.length > CODEX_ASK_DIFF_CEILING
      ? `${diff.slice(0, CODEX_ASK_DIFF_CEILING)}\n… (diff truncated at ${CODEX_ASK_DIFF_CEILING} bytes)`
      : diff;
  return [
    "You are a second-opinion code reviewer answering ONE question about a code change.",
    "Answer only the question, concisely and concretely. Do not restate the diff.",
    "",
    "The change under review (unified diff):",
    "```diff",
    bounded,
    "```",
    "",
    `The reviewer's question: ${question}`,
  ].join("\n");
}

/** Deps for the live Codex ask (the executor + optional model/effort overrides). */
export interface LiveCodexAskDeps {
  /** The real `codex exec` executor (`createCodexExecutor()`); injectable for tests. */
  executor: CodexExecutor;
  /** Codex model; defaults to the pipeline's light-tier utility model. */
  readonly model?: string;
  /** Reasoning effort; defaults to the pipeline's light-tier effort. */
  readonly effort?: string;
}

/**
 * Build the live Codex second-opinion port. One `codex exec` over the review's diff
 * + the question, constrained to `{ answer }` JSON. A non-zero exit / no-output /
 * non-JSON is a throw INSIDE the executor; we catch it and return an honest
 * "unavailable" answer so a "both" ask degrades to one real answer rather than
 * sinking the whole question (the orchestrator's `primary` already exists).
 */
export function createLiveCodexAsk(
  deps: LiveCodexAskDeps,
): (input: { review: Review; question: string }) => Promise<AskAnswer> {
  return async ({ review, question }) => {
    const patchset = activePatchsetOf(review);
    const prompt = buildCodexAskPrompt(patchset.rawDiff, question);
    try {
      const result = await deps.executor({
        model: deps.model ?? DEFAULT_CODEX_UTILITY_MODEL,
        effort: deps.effort ?? DEFAULT_CODEX_UTILITY_EFFORT,
        prompt,
        outputSchema: CODEX_ASK_OUTPUT_SCHEMA,
      });
      const output = result.output as { answer?: unknown } | null;
      const answer = typeof output?.answer === "string" ? output.answer.trim() : "";
      return {
        model: CODEX_ASK_LABEL,
        answer: answer.length > 0 ? answer : "Codex returned no answer.",
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return { model: CODEX_ASK_LABEL, answer: `Codex could not answer: ${detail}` };
    }
  };
}
