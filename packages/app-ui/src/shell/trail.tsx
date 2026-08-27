import { TargetIcon } from "./sidebar/target-icon";
import { type SessionTarget, type SessionTargetState, TARGET_LABEL } from "./sidebar-data";

// ─────────────────────────────────────────────────────────────────────────────
// The session trail (C03 §4.1, R51/R52). Two lines: the session TITLE over a
// target-icon + `project › target` in WORDS, with "· needs you" as words beside
// the accent icon — never a pill (R52). Presentational and prop-driven so C7's
// chat-pane header renders the SAME component. When there is no session projection
// yet (reconciliation 2), the caller passes just a title and the second line is
// omitted — an honest, minimal trail rather than a fabricated target.
// ─────────────────────────────────────────────────────────────────────────────

export interface TrailProps {
  readonly title: string;
  /** The project the session belongs to; omitted ⇒ no second line (interim). */
  readonly projectName?: string;
  readonly target?: SessionTarget;
  readonly targetState?: SessionTargetState;
}

export function Trail({ title, projectName, target, targetState }: TrailProps) {
  const needsYou = targetState === "needs-you";
  return (
    <div className="flex min-w-0 flex-col justify-center">
      <span className="truncate font-display text-sm font-medium leading-tight text-ink">
        {title}
      </span>
      {projectName && target ? (
        <span className="flex items-center gap-1.5 text-2xs leading-tight text-ink-faint">
          <TargetIcon kind={target} state={targetState} className="size-3" />
          <span className="truncate">
            {projectName} › {TARGET_LABEL[target]}
            {needsYou ? <span className="text-accent"> · needs you</span> : null}
          </span>
        </span>
      ) : null}
    </div>
  );
}
