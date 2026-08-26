import type { ComposedHandoffBundle, HandoffRunResult } from "@rennet/protocol";
import { handoffPreview } from "../canvas/publish";

// The STAGE-6 HANDOFF PAPER (issue #72): the reviewer SEES the composed work order
// before the write session runs it. It renders `handoffPreview(bundle)` — the SAME
// ordered tasks the run executes (`bundle.prompt` is the verbatim render of these
// tasks in this order), so "what you see is what leaves" (R33) holds by construction.
//
// ⭐ HONEST about authoring: a mechanical-floor bundle (`composed:false`) renders as
// an "un-composed" list, never dressed as authored prose. The model's `title` shows
// as PREVIEW-ONLY metadata, visibly separate from the executable heading — it reaches
// the human's eyes here but never the coding agent's work order.
//
// The RUN is one action from the preview (Rule Zero — no consent ceremony): the paper
// takes `onRun` + `runState` as PROPS and stays presentational (`@rennet/protocol` only,
// no IPC). The `runState` is the `review.handoff.run` discriminated outcome, surfaced
// verbatim — a refusal renders as a refusal, a failure as an error, and no non-success
// outcome is ever dressed as success. When `onRun` is absent the paper is preview-only.

/**
 * The run lifecycle the paper renders. `idle`/`pending` are the pre-outcome states;
 * the rest mirror `review.handoff.run`'s discriminated outcome VERBATIM (the union is
 * expressed from `@rennet/protocol` alone so the paper keeps its `layer:ui` import rule).
 */
export type HandoffRunState =
  | { readonly status: "idle" }
  | { readonly status: "pending" }
  | { readonly status: "ran"; readonly result: HandoffRunResult }
  | { readonly status: "refused"; readonly reason: string }
  | { readonly status: "unavailable"; readonly reason: string }
  | {
      readonly status: "failed";
      readonly reason: string;
      readonly filesTouched: readonly string[];
    };

function RunOutcome({ state }: { state: HandoffRunState }) {
  switch (state.status) {
    case "idle":
      return null;
    case "pending":
      return (
        <p
          className="handoff-run-pending m-0 text-sm text-sheet-soft"
          role="status"
          data-run-status="pending"
        >
          Running the write session…
        </p>
      );
    case "ran": {
      const { result } = state;
      return (
        <div
          className="handoff-run-outcome flex flex-col gap-1"
          role="status"
          data-run-status="ran"
        >
          <p className="handoff-run-success m-0 text-base font-semibold text-sheet-ink">
            Handoff ran — {result.filesTouched.length} file
            {result.filesTouched.length === 1 ? "" : "s"} changed.
          </p>
          <p className="handoff-run-carry m-0 text-sm text-sheet-soft">
            {result.carriedForward} carried forward · {result.orphaned} reopened for re-review.
          </p>
        </div>
      );
    }
    case "refused":
      return (
        <p
          className="handoff-run-refused m-0 text-base font-semibold leading-snug text-sheet-ink"
          role="alert"
          data-run-status="refused"
        >
          Refused: {state.reason}
        </p>
      );
    case "unavailable":
      return (
        <p
          className="handoff-run-unavailable m-0 text-base font-semibold leading-snug text-sheet-ink"
          role="alert"
          data-run-status="unavailable"
        >
          No coding harness is available: {state.reason}
        </p>
      );
    case "failed":
      return (
        <div
          className="handoff-run-outcome flex flex-col gap-1"
          role="alert"
          data-run-status="failed"
        >
          <p className="handoff-run-failed m-0 text-base font-semibold leading-snug text-sheet-ink">
            The write session failed: {state.reason}
          </p>
          {state.filesTouched.length === 0 ? null : (
            // A failed agent can still have MUTATED files before it failed. The
            // protocol carries `filesTouched` on failure precisely so the human is
            // never told "it failed" while a partial write sits unmentioned — surface
            // exactly what changed on disk.
            <p className="handoff-run-touched m-0 text-sm leading-snug text-sheet-soft">
              {state.filesTouched.length} file
              {state.filesTouched.length === 1 ? "" : "s"} changed before it failed:{" "}
              {state.filesTouched.join(", ")}
            </p>
          )}
        </div>
      );
  }
}

export function HandoffPaper({
  bundle,
  onRun,
  runState = { status: "idle" },
  onBack,
}: {
  bundle: ComposedHandoffBundle;
  /** Run the previewed bundle (issue #72). Absent ⇒ the paper is preview-only. */
  onRun?: () => void;
  /** The `review.handoff.run` lifecycle, surfaced verbatim. Defaults to idle. */
  runState?: HandoffRunState;
  /** Return to the surface the handoff paper was opened from. */
  onBack?: () => void;
}) {
  const preview = handoffPreview(bundle);
  const running = runState.status === "pending";
  // The run is a one-shot from a given preview. Once it reaches ANY terminal outcome
  // (ran / refused / unavailable / failed) the button stays disabled — re-clicking it
  // would re-run the SAME bundle against a tree the last run may have mutated. The
  // path to run again is a fresh compose, which an invalidation (a disposition change)
  // arms by resetting the run to idle. So `idle` is the only runnable state.
  const runnable = runState.status === "idle";
  return (
    <section
      className="handoff-paper flex flex-col w-[min(760px,100%)] max-h-[calc(100vh-64px)] gap-5 mx-auto px-8 py-7 rounded-window border border-sheet-line bg-sheet text-sheet-ink"
      aria-label="Handoff preview"
      data-composed={preview.composed}
    >
      <header className="handoff-paper-header flex flex-wrap items-baseline gap-3 pb-3.5 border-b border-sheet-line">
        {onBack ? (
          <button
            type="button"
            className="handoff-paper-back flex-none rounded-control border border-sheet-line bg-transparent px-2.5 py-1 text-xs font-semibold text-sheet-soft hover:text-sheet-ink"
            onClick={() => onBack()}
          >
            Back
          </button>
        ) : null}
        <span className="handoff-paper-title font-display text-2xl font-medium tracking-tight">
          Handoff
        </span>
        <span className="handoff-paper-authoring text-2xs font-bold uppercase tracking-wide text-sheet-soft">
          {preview.composed ? "Composed" : "Un-composed (mechanical order)"}
        </span>
        <span className="handoff-paper-count ml-auto text-sm text-sheet-soft">
          {preview.taskCount} task{preview.taskCount === 1 ? "" : "s"} · {preview.askCount} note
          {preview.askCount === 1 ? "" : "s"}
        </span>
      </header>
      {preview.taskCount === 0 ? (
        <p className="handoff-paper-empty m-0 italic text-sheet-soft">Nothing to hand off.</p>
      ) : (
        <ol className="handoff-paper-tasks min-h-0 list-none m-0 p-0 flex flex-col gap-5 overflow-y-auto">
          {preview.tasks.map((task) => (
            <li
              className="handoff-paper-task flex flex-col gap-2"
              data-order={task.order}
              key={task.order}
            >
              <div className="handoff-paper-task-head flex flex-wrap items-baseline gap-2.5">
                <span
                  className={`handoff-paper-task-heading text-lg ${
                    preview.composed
                      ? "font-semibold text-sheet-ink"
                      : "font-medium text-sheet-soft"
                  }`}
                >
                  {task.order}. {task.heading}
                </span>
                {task.title === "" ? null : (
                  <span
                    className="handoff-paper-task-title inline-flex items-baseline gap-1.5 text-base italic text-sheet-soft"
                    data-preview-only="true"
                  >
                    <span className="handoff-paper-preview-badge not-italic text-2xs font-bold uppercase tracking-wide text-sheet-soft border border-sheet-line rounded-full px-2 py-px">
                      preview only
                    </span>{" "}
                    {task.title}
                  </span>
                )}
              </div>
              <ul
                className={`handoff-paper-asks list-none m-0 py-0 pr-0 pl-4 flex flex-col gap-2.5 border-l ${
                  preview.composed ? "border-sheet-line" : "border-transparent"
                }`}
              >
                {task.asks.map((ask) => (
                  <li
                    className="handoff-paper-ask flex flex-col gap-1"
                    data-path={ask.path}
                    key={`${ask.path}:${ask.anchor}`}
                  >
                    <span className="handoff-paper-ask-anchor font-mono text-2xs font-semibold text-sheet-soft">
                      {ask.typeLabel} — {ask.path} ({ask.anchor})
                    </span>
                    <p className="handoff-paper-ask-body m-0 text-base font-serif leading-relaxed text-sheet-ink">
                      {ask.body}
                    </p>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ol>
      )}
      {onRun ? (
        <footer className="handoff-paper-foot flex flex-col gap-2.5 pt-4 border-t border-sheet-line">
          <button
            type="button"
            className="handoff-paper-run self-start rounded-control bg-accent-fill text-accent-ink px-4 py-2 text-sm font-semibold disabled:opacity-50 disabled:cursor-default"
            disabled={!runnable || preview.taskCount === 0}
            onClick={() => onRun()}
          >
            {running ? "Running…" : "Run the handoff"}
          </button>
          <RunOutcome state={runState} />
        </footer>
      ) : null}
    </section>
  );
}
