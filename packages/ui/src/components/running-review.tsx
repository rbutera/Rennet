import { useEffect, useState } from "react";

/** Elapsed formatter: "3s" under a minute, "1m 04s" beyond. Tabular, so it doesn't jitter. */
export function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}m ${rest.toString().padStart(2, "0")}s`;
}

/**
 * The live "running the AI review" state (critique P1-A). The review runs as a SINGLE
 * `review.canvases` invoke: the engine emits NO per-stage progress and the protocol
 * bridge exposes NO abort path (RennetBridge has neither an `onProgress` wired to this
 * command nor a cancel), so this shows the only two things HONESTLY true while it runs —
 * that it is still working (an indeterminate bar, never a fake percentage or an invented
 * "stage done") and how long it has been running (a live elapsed clock). It replaces the
 * static text card that read identically whether the engine was working or hung. There is
 * deliberately no cancel control: there is nothing to abort, and a fake one would lie.
 *
 * The elapsed clock is marked `aria-hidden` so its per-second tick doesn't spam the
 * `role="status"` live region — the "Running the review…" heading is the announced content.
 */

/** Past this many seconds the run gets one quiet, honest reassurance line. Purely
 * elapsed-based — no stage claim, no heartbeat: a long run stays a long run, this only
 * says large changesets can take a while so the wait doesn't read as a hang. */
const STALLED_AFTER_SECONDS = 120;

export function RunningReview() {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const started = Date.now();
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(id);
  }, []);
  return (
    // `role="status"` already implies an `aria-live="polite"` region (no separate
    // aria-live needed). The heading announces once; the elapsed clock is aria-hidden so
    // its tick doesn't re-announce, and the stalled line below announces once when it appears.
    <section
      className="canvas-primer mx-auto my-[72px] flex max-w-[540px] flex-col items-start gap-2.5 p-7"
      role="status"
    >
      <p className="eyebrow m-0 text-2xs font-bold tracking-widest text-ink-faint">AI REVIEW</p>
      <h2 className="m-0 font-display text-xl font-semibold text-ink">Running the review…</h2>
      <p className="m-0 text-base leading-relaxed text-ink-soft">
        Reading the diff and drafting review angles.
      </p>
      <div
        className="canvas-primer-track relative mt-1 h-0.5 w-full overflow-hidden rounded-micro bg-accent-soft"
        data-testid="running-review-track"
        aria-hidden="true"
      >
        <span className="canvas-primer-track-fill absolute left-0 top-0 h-full w-[35%] animate-[busy_1s_ease-in-out_infinite_alternate] rounded-micro bg-accent motion-reduce:w-full motion-reduce:animate-none motion-reduce:opacity-40" />
      </div>
      <p
        className="canvas-primer-elapsed text-sm tabular-nums text-ink-faint"
        data-testid="running-review-elapsed"
        aria-hidden="true"
      >
        {formatElapsed(elapsed)} elapsed
      </p>
      {elapsed >= STALLED_AFTER_SECONDS ? (
        <p
          className="canvas-primer-stalled text-sm text-ink-faint"
          data-testid="running-review-stalled"
        >
          Still working — large changesets can take several minutes.
        </p>
      ) : null}
    </section>
  );
}
