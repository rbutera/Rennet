import { ChevronRight } from "lucide-react";
import { Icon } from "../components/icon";
import { TargetIcon } from "./sidebar/target-icon";
import { type SessionTarget, type SessionTargetState, TARGET_LABEL } from "./sidebar-data";

// ─────────────────────────────────────────────────────────────────────────────
// The session trail (C03 §4.1, R51/R52). Two lines: the session TITLE over a
// target-icon + `project › target` in WORDS, with "· needs you" as words in the
// same muted voice as the rest of the line, beside the primary-tinted target icon
// that is already carrying the signal — never a pill (R52), and never a second
// coloured shout. Presentational and prop-driven so C7's
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
  /**
   * The workspace the session is bound to (session-bound-workspace): the checkout every one
   * of its turns runs in, which for an off-branch or pull-request review is a worktree rather
   * than the reviewer's own tree. Shown beside the branch because "which tree did the seat
   * read" is otherwise invisible. Omitted ⇒ nothing has bound one, and the line says nothing.
   */
  readonly workspace?: string;
}

export function Trail({ title, projectName, target, targetState, workspace }: TrailProps) {
  const needsYou = targetState === "needs-you";
  return (
    <div data-slot="trail" className="flex min-w-0 flex-col justify-center gap-0.5">
      <span className="truncate text-13 font-medium leading-tight text-ink">{title}</span>
      {projectName && target ? (
        <span className="flex min-w-0 items-center gap-1 text-2xs leading-tight text-muted-foreground">
          <TargetIcon kind={target} state={targetState} className="size-3" />
          <span className="shrink-0">{projectName}</span>
          <Icon icon={ChevronRight} className="size-2.5 shrink-0 text-muted-foreground/50" />
          <span className="truncate">
            {TARGET_LABEL[target]}
            {needsYou ? " · needs you" : ""}
          </span>
          {workspace ? (
            <>
              <Icon icon={ChevronRight} className="size-2.5 shrink-0 text-muted-foreground/50" />
              <span data-slot="trail-workspace" className="truncate" title={workspace}>
                {workspace}
              </span>
            </>
          ) : null}
        </span>
      ) : null}
    </div>
  );
}
