import type { AskAnswer, AskPort } from "@rennet/core";

/**
 * The review.ask ports, FIXTURED for this wave (issue #139).
 *
 * The routing law — orchestrator once, "both" adds Codex, never a synthesis —
 * lives in `@rennet/core`'s `askReview` and is real. What is deferred is the LIVE
 * orchestrator/Codex invocation: rather than boot a real session and spend a real
 * model turn, these ports return deterministic canned answers behind the SAME
 * typed port boundary the live sessions will sit behind (mirroring #138's
 * fixture-behind-boundary). The dispatch path calls the real `askReview` with these
 * ports, so the whole command — routing included — comes alive now; only the two
 * answers are canned.
 *
 * The canned content mirrors prototype frame 14 (the retry-after question), so the
 * surface renders a real disagreement the reviewer can read and reconcile: the
 * orchestrator and Codex reach the same conclusion by different routes.
 */

/**
 * The orchestrator port as a bare `AskPort` (question in, labelled answer out) —
 * the shape `askReview` calls. The one model the reviewer converses with; always
 * asked. Exported for direct use / testing behind the core router.
 */
export const orchestratorAskFixture: AskPort = async (): Promise<AskAnswer> => ({
  model: "Orchestrator · Claude",
  answer:
    "The header carries milliseconds here. The spec text says seconds, so the field name is " +
    "misleading even though the value is internally consistent. Worth a rename, not a behaviour change.",
});

/**
 * The Codex port as a bare `AskPort` — the second opinion, asked ONLY when the
 * reviewer opts into "both". Exported for direct use / testing behind the router.
 */
export const codexAskFixture: AskPort = async (): Promise<AskAnswer> => ({
  model: "codex",
  answer:
    "Milliseconds. The client wrapper divides by 1000 on read, so end to end it is correct. " +
    "I would only add a doc comment naming the unit.",
});

/**
 * The dispatch-dep-shaped ports: each takes `{ reviewId, question }` (the natural
 * "a question ABOUT a review" shape the live ports will need to bind to the review's
 * view). The fixture ignores `reviewId` — it has no live session to bind to — and
 * delegates to the bare `AskPort` fixtures above. This is exactly the shape
 * `DispatchDeps.reviewAsk` expects, so the desktop main wires it straight in.
 */
export function reviewAskFixturePorts(): {
  askOrchestrator(input: { reviewId: string; question: string }): Promise<AskAnswer>;
  askCodex(input: { reviewId: string; question: string }): Promise<AskAnswer>;
} {
  return {
    askOrchestrator: ({ question }) => orchestratorAskFixture(question),
    askCodex: ({ question }) => codexAskFixture(question),
  };
}
