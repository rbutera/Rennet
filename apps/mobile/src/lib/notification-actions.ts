// Shade answer actions (issue #382 M2, task 3.2). The pure mapping between an ask-pending
// attention's answer chips and the OS notification's category/actions, and back from a tapped
// action to the reply the app sends. Kept pure (no expo-notifications import) so the round-trip
// unit-tests; the RN/Expo glue (register categories, post the reply) lives in the runtime.
//
// The contract that makes the shade answer trustworthy: the notification action's identifier IS
// the chip's `id`, and the app resolves it back to the chip `label`, then composes the SAME
// `review.ask` reply the in-app card would (via `composeAskReply`) — so answering from the shade
// and answering in the app send identical bytes. Exactly-once is the daemon's: the reply carries
// the review id and the daemon's superseded-turn refusal dedups a late/duplicate answer.

import type { AttentionAction } from "@rennet/protocol";

/** A notification action as the OS layer registers it (id ⇒ button label). */
export interface ShadeAction {
  readonly identifier: string;
  readonly buttonTitle: string;
  /** Answering opens the app only on the fallback path; a background-capable action stays closed. */
  readonly opensAppToForeground: boolean;
}

/** The category id for an ask push — one per review so its actions are scoped to that ask. */
export function askCategoryId(reviewId: string): string {
  return `ask:${reviewId}`;
}

/**
 * Build the OS notification actions for an ask push's answer chips. `background` (the platform
 * allows a headless response) keeps the app closed; otherwise the action opens the app pre-filled
 * (still one tap). A push with no chips yields no actions — the ask is then answered in-app by
 * free text, never a fabricated chip.
 */
export function shadeActionsFor(
  actions: readonly AttentionAction[] | undefined,
  background: boolean,
): ShadeAction[] {
  return (actions ?? []).map((action) => ({
    identifier: action.id,
    buttonTitle: action.label,
    opensAppToForeground: !background,
  }));
}

/**
 * Resolve a tapped action identifier back to its chip label, given the push's chips. Returns
 * undefined when the identifier matches no chip (a stale category from a superseded ask) — the
 * caller then deep-links into the ask rather than sending a guessed answer.
 */
export function chipLabelForAction(
  actions: readonly AttentionAction[] | undefined,
  identifier: string,
): string | undefined {
  return (actions ?? []).find((a) => a.id === identifier)?.label;
}
