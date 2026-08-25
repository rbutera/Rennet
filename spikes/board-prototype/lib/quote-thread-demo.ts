/**
 * Canned orchestrator replies for quote threads. Demo furniture, same as the
 * chat's scripted follow-up exchanges: the user's side of a thread is real
 * interaction; the orchestrator's side is staged until the real session wires
 * in. Replies rotate so repeated demos don't repeat text.
 */
const REPLIES = [
  "Short answer: it holds, but only because the transport sits in front. If a caller ever bypasses publishHttp, this assumption goes with it — worth pinning in a test if that worries you.",
  "There is no counter for it today. The nearest signal is the daemon.log sequence itself; the field-proof task (6.1) is where a real-world number would first show up.",
  "The change keeps that behavior deliberately — design.md defers the alternative as an open question. If you want it revisited, I can stage it as an ask on the draft.",
  "Yes, and the test at github-auth.test.ts pins exactly that: records land in order, and the refresh exchange runs once. If the ordering ever regresses, that assertion is the tripwire.",
]

let cursor = 0

export function nextCannedReply(): string {
  const reply = REPLIES[cursor % REPLIES.length]
  cursor += 1
  return reply
}

export const EXPLAIN_OPENER = "Explain this."
