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
export function RunningReview() {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const started = Date.now();
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <section className="canvas-primer" role="status" aria-live="polite">
      <p className="eyebrow">AI REVIEW</p>
      <h2>Running the review…</h2>
      <p>Reading the diff and drafting review angles.</p>
      <div className="canvas-primer-track" data-testid="running-review-track" aria-hidden="true">
        <span className="canvas-primer-track-fill" />
      </div>
      <p className="canvas-primer-elapsed" data-testid="running-review-elapsed" aria-hidden="true">
        {formatElapsed(elapsed)} elapsed
      </p>
    </section>
  );
}
