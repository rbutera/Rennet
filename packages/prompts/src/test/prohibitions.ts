/**
 * The prohibition detector for the session briefing (`session-thread-briefing` Decision 3:
 * the thread can do everything the reviewer can, so the briefing steers and forbids
 * nothing). Shared by the manifest test, which reads the FILE, and the briefing test, which
 * reads a RENDERED briefing — the requirement is about what the thread is actually told,
 * and the file is only half of that.
 *
 * Whitespace is normalised BEFORE sentences are split, because the prompt files are
 * hard-wrapped at ~75 columns: a first version split on `\n` and could not see
 * "do not\ncommit" at all, so three of its four patterns were dead and the test read as
 * four checks while being one.
 */
export const PROHIBITION_PATTERNS = [
  /\bnever\b/i,
  /\bdo not commit\b/i,
  /\bdo not push\b/i,
  /\bmust not\b/i,
  /\bdon['’]?t\b/i,
] as const;

/** The sentences of `text` that carry a prohibition, named so a failure says which. */
export function prohibitions(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .filter((sentence) => PROHIBITION_PATTERNS.some((pattern) => pattern.test(sentence)));
}
