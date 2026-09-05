// Naming the real cause when a child process could not be started (#850).
//
// The failure a user saw was "T3 sidecar unavailable: spawn EBADF", on all five lens
// lanes at once. It sent the reader to the sidecar, which was fine: the daemon had run
// out of file descriptors, so EVERY `spawn` was failing, and the sidecar was simply the
// first thing that needed one. The evidence was 16,751 EMFILE lines in `~/.rennet/
// daemon.log`, which nothing in the UI pointed at.
//
// A message naming the wrong subsystem is a lie in the UI. This turns the errno into the
// sentence that is actually true, wherever a spawn failure reaches a reader.

/**
 * The errnos a process hands back when the descriptor budget is gone.
 *
 * `EMFILE` is this process at its own limit and `ENFILE` is the whole machine at the
 * system limit. `EBADF` is the one that reads as a different bug entirely — it is what
 * `spawn` reports once the pipes for a child's stdio could not be made — and guessing at
 * a double-close in the spawn helpers is exactly where #821 went for a week.
 */
const EXHAUSTED = /\b(EMFILE|ENFILE|EBADF)\b/;

/**
 * `detail` with the real cause named, when it is a descriptor exhaustion; `detail`
 * unchanged otherwise.
 *
 * The original text is kept rather than replaced — it is what a reader greps the log for
 * — and the explanation is appended to it.
 */
export function describeSpawnFailure(detail: string): string {
  if (!EXHAUSTED.test(detail)) return detail;
  return `${detail} — this machine's file-descriptor budget is exhausted, so every process Rennet starts is failing, not just this one. Check ~/.rennet/daemon.log for EMFILE, and for a directory being watched that should not be.`;
}
