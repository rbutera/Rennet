// The ask-reply composer (issue #382 M2, task 2.1 / decision 2). An ask is answered with a
// decision (a chip) AND/OR a direction (free text), and both travel as ONE `review.ask` reply
// string: the chip label, a newline, then the direction. A chip alone, text alone, or both
// together all compose — the "asks are never binary" rule (wireframe 22). Pure and framework-
// free (the composer + validity are unit-tested; the screen and the shade handler both build
// their reply through here so the in-app tap and the notification action send identical bytes).

/** The parts an answer is composed from — a chosen chip label and/or a free-text direction. */
export interface AskReplyParts {
  /** The tapped answer chip's label, if one was chosen. */
  readonly chipLabel?: string;
  /** The free-text direction, if any was typed. */
  readonly direction?: string;
}

/**
 * Compose the single `review.ask` reply string from a chip and/or a direction. Chip label first,
 * then the direction on its own line (matching how the desktop composes a decision with context).
 * The direction is trimmed; an empty/whitespace direction contributes nothing. Returns "" when
 * neither part is present (an empty answer — `canSend` is false and the screen keeps Send disabled).
 */
export function composeAskReply(parts: AskReplyParts): string {
  const chip = parts.chipLabel?.trim() ?? "";
  const direction = parts.direction?.trim() ?? "";
  if (chip && direction) return `${chip}\n${direction}`;
  return chip || direction;
}

/** Whether these parts compose a sendable reply (at least one of chip / direction is present). */
export function canSendAskReply(parts: AskReplyParts): boolean {
  return composeAskReply(parts).length > 0;
}
