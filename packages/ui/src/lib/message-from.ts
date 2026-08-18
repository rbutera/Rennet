/** The one error-to-copy helper: an Error's message, or the stringified value. */
export function messageFrom(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}
