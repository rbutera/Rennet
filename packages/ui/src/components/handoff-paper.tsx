import type { ComposedHandoffBundle } from "@rennet/types";
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

export function HandoffPaper({ bundle }: { bundle: ComposedHandoffBundle }) {
  const preview = handoffPreview(bundle);
  return (
    <section
      className="handoff-paper"
      aria-label="Handoff preview"
      data-composed={preview.composed}
    >
      <header className="handoff-paper-header">
        <span className="handoff-paper-title">Handoff</span>
        <span className="handoff-paper-authoring">
          {preview.composed ? "Composed" : "Un-composed (mechanical order)"}
        </span>
        <span className="handoff-paper-count">
          {preview.taskCount} task{preview.taskCount === 1 ? "" : "s"} · {preview.askCount} note
          {preview.askCount === 1 ? "" : "s"}
        </span>
      </header>
      {preview.taskCount === 0 ? (
        <p className="handoff-paper-empty">Nothing to hand off.</p>
      ) : (
        <ol className="handoff-paper-tasks">
          {preview.tasks.map((task) => (
            <li className="handoff-paper-task" data-order={task.order} key={task.order}>
              <div className="handoff-paper-task-head">
                <span className="handoff-paper-task-heading">
                  {task.order}. {task.heading}
                </span>
                {task.title === "" ? null : (
                  <span className="handoff-paper-task-title" data-preview-only="true">
                    <span className="handoff-paper-preview-badge">preview only</span> {task.title}
                  </span>
                )}
              </div>
              <ul className="handoff-paper-asks">
                {task.asks.map((ask) => (
                  <li
                    className="handoff-paper-ask"
                    data-path={ask.path}
                    key={`${ask.path}:${ask.anchor}`}
                  >
                    <span className="handoff-paper-ask-anchor">
                      {ask.typeLabel} — {ask.path} ({ask.anchor})
                    </span>
                    <p className="handoff-paper-ask-body">{ask.body}</p>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
