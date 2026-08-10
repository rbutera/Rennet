import type { AskAnswer, AskMode, AskReviewResult } from "@rennet/types";

// ─────────────────────────────────────────────────────────────────────────────
// review.ask — ask the AI a question, one model or both (issue #139).
//
// This module holds the WHOLE routing law, and it is deliberately tiny. The
// reviewer's question goes to the ORCHESTRATOR — the one model they converse with
// — by default; opting into "both" ADDITIONALLY asks Codex. The two answers come
// back labelled, side by side, and the reviewer reconciles any disagreement
// themselves.
//
// The load-bearing invariant (Rai, #139): there is NO synthesis block, NO
// auto-merge, EVER, and nothing fires to a second model behind the reviewer's
// back. Both halves are STRUCTURAL here:
//   • "orchestrator" mode never reaches the Codex port — a single read of this
//     function shows the `askCodex` call sits behind `mode === "both"`;
//   • there is no seam that combines `primary` and `secondOpinion` — the router
//     returns each port's answer verbatim, and `AskReviewResult` has no field a
//     merged answer could occupy.
//
// The live orchestrator/Codex invocation is DEFERRED (#139 scope): the ports are
// injected, so a fixture can stand behind this real, typed boundary while the
// wiring to the live sessions lands. The routing proven here does not change when
// the ports become real — it is a pure function of `mode` and the two ports.
// ─────────────────────────────────────────────────────────────────────────────

export type { AskAnswer, AskMode, AskReviewResult } from "@rennet/types";

/**
 * A port that produces ONE labelled answer to the reviewer's question. The port
 * owns its own label (which model/harness answered), so the router stays
 * label-agnostic: it never invents a label and never rewrites an answer.
 */
export type AskPort = (question: string) => Promise<AskAnswer>;

/**
 * The two ports the router calls. `askOrchestrator` is the one model the reviewer
 * converses with; `askCodex` is the second opinion, reached ONLY when the reviewer
 * opts into "both". There is deliberately NO third port and NO combiner: the
 * router cannot manufacture a merged answer because there is no seam through which
 * one could be produced.
 */
export interface ReviewAskPorts {
  /** Always called, exactly once, in every mode. Produces `primary`. */
  askOrchestrator: AskPort;
  /** Called ONLY in "both" mode, exactly once. Produces `secondOpinion`. */
  askCodex: AskPort;
}

/**
 * Route one review question to one model or both. Pure and deterministic given its
 * ports: it neither reads global state nor times anything; the mode alone decides
 * whether Codex is asked.
 *
 *   - the ORCHESTRATOR is ALWAYS asked, exactly once (every mode);
 *   - CODEX is asked ONLY in "both" mode, exactly once, and NEVER in "orchestrator";
 *   - the two answers are returned SIDE BY SIDE, labelled, and are NEVER merged.
 *
 * The orchestrator is asked FIRST so that its `primary` answer is available even if
 * a "both" ask's Codex port later rejects (the caller decides how to surface that);
 * and because the orchestrator is the model the reviewer actually converses with,
 * it is the answer that always exists.
 */
export async function askReview(
  mode: AskMode,
  question: string,
  ports: ReviewAskPorts,
): Promise<AskReviewResult> {
  // The orchestrator is asked in EVERY mode, exactly once. This is the only call
  // "orchestrator" mode ever makes.
  const primary = await ports.askOrchestrator(question);
  if (mode === "orchestrator") {
    // The second port is never touched: no Codex spend, no second answer, and — by
    // the shape of the returned object — no merged answer either.
    return { mode, primary };
  }
  // "both" mode, and ONLY "both" mode, additionally asks Codex, exactly once. The
  // two answers are returned side by side; neither is rewritten and no third,
  // synthesized answer is produced.
  const secondOpinion = await ports.askCodex(question);
  return { mode, primary, secondOpinion };
}
