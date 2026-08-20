import type { AskAnswer, AskMode, AskReviewResult } from "@rennet/types";

// ─────────────────────────────────────────────────────────────────────────────
// review.ask — the surface's pure logic (issue #139).
//
// Two host-free pieces the Ask surface renders from:
//   1. The per-thread memory of the "ask both" split. The chosen mode is
//      remembered for the THREAD it was chosen in and NOWHERE else — a new thread
//      starts at the orchestrator-only default, and there is NO global sticky
//      state (prototype frame 14, designer note 2).
//   2. The ordered, labelled answer cards a result renders as. The shape can hold
//      at most `primary` + `secondOpinion`, so it CANNOT produce a third, merged
//      card — "no synthesis, ever" is structural on the surface too, not merely a
//      rendering choice.
//
// Kept in `@rennet/app-ui` (types + protocol only), so every rule here is unit-testable
// without a DOM (mirroring `canvas/flagged.ts`).
// ─────────────────────────────────────────────────────────────────────────────

export type { AskAnswer, AskMode, AskReviewResult } from "@rennet/types";

/** The default routing: the orchestrator, the one model you converse with. */
export const DEFAULT_ASK_MODE: AskMode = "orchestrator";

/**
 * Per-thread memory of the ask routing. Keyed by threadId; a thread ABSENT from
 * the map is at the default. This map is the WHOLE of that memory — there is no
 * ambient "current mode", so a choice can never leak past the thread it was made
 * in. (An empty map means every thread is at the orchestrator-only default.)
 */
export type AskModeByThread = Readonly<Record<string, AskMode>>;

/** The mode remembered for a thread, or the orchestrator-only default when it has none. */
export function askModeForThread(byThread: AskModeByThread, threadId: string): AskMode {
  return byThread[threadId] ?? DEFAULT_ASK_MODE;
}

/**
 * Remember a routing for ONE thread. Returns a NEW map (never mutates), and touches
 * ONLY the given thread — so choosing "ask both" in thread A cannot change thread B,
 * and nothing becomes globally sticky. Setting a thread back to "orchestrator" keeps
 * it explicit rather than deleting the key; either way `askModeForThread` agrees.
 */
export function rememberAskMode(
  byThread: AskModeByThread,
  threadId: string,
  mode: AskMode,
): AskModeByThread {
  return { ...byThread, [threadId]: mode };
}

/** One labelled answer card, in render order. */
export interface AskCard {
  /** The model/harness label shown on the card header. */
  model: string;
  /** That model's answer text, rendered verbatim. */
  answer: string;
}

/**
 * The ordered cards a result renders as: the orchestrator's `primary` first, then
 * the `secondOpinion` when (and ONLY when) both were asked. NEVER a third, merged
 * card — the shape cannot express one. So a "both" result always yields exactly two
 * cards and an "orchestrator" result exactly one, and the surface renders whatever
 * this returns without ever synthesising.
 */
export function askCards(result: AskReviewResult): AskCard[] {
  const cards: AskCard[] = [{ model: result.primary.model, answer: result.primary.answer }];
  if (result.secondOpinion) {
    cards.push({ model: result.secondOpinion.model, answer: result.secondOpinion.answer });
  }
  return cards;
}

/** Whether a result came from asking BOTH models (i.e. carries a second opinion). */
export function askedBoth(result: AskReviewResult): boolean {
  return result.mode === "both" && result.secondOpinion !== undefined;
}

/** The two routing options the caret menu offers, in display order (frame 14). */
export interface AskOption {
  mode: AskMode;
  /** The menu label ("Ask the orchestrator" / "Ask both models"). */
  label: string;
  /** The trailing hint ("default" / "two answers"). */
  hint: string;
}

export const ASK_OPTIONS: readonly AskOption[] = [
  { mode: "orchestrator", label: "Ask the orchestrator", hint: "default" },
  { mode: "both", label: "Ask both models", hint: "two answers" },
] as const;

/** Type-narrowing guard for a value that may be an `AskAnswer`. */
export function isAskAnswer(value: unknown): value is AskAnswer {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { model?: unknown }).model === "string" &&
    typeof (value as { answer?: unknown }).answer === "string"
  );
}
