import { cn } from "@rennet/ui";
import { Check, GitBranch, GitMerge, GitPullRequest, GitPullRequestArrow } from "lucide-react";
import { Icon } from "../../components/icon";
import { type SessionTarget, type SessionTargetState, TARGET_LABEL } from "../sidebar-data";

// The unified icon language for review targets (R36), ported from the spike's
// `target-badge.tsx` — JSX only, no state. Branch = your branch, pull-request =
// your PR, incoming pull-request = teammate PR; merged uses the merge glyph,
// reviewed is a green tick, and "needs you" tints the target's OWN icon accent —
// never a badge or pill. Colours come from the theme (accent / green / ink-faint),
// sizes from the ramp; the tooltip carries the words.

const TARGET_ICON: Record<SessionTarget, typeof GitBranch> = {
  "your-branch": GitBranch,
  "your-pr": GitPullRequest,
  "teammate-pr": GitPullRequestArrow,
};

function resolve(kind: SessionTarget, state?: SessionTargetState) {
  if (state === "merged") {
    return { glyph: GitMerge, tone: "text-ink-faint", label: "Merged" };
  }
  if (state === "reviewed") {
    return { glyph: Check, tone: "text-green", label: "Reviewed" };
  }
  const glyph = TARGET_ICON[kind];
  if (state === "needs-you") {
    return { glyph, tone: "text-accent", label: `${TARGET_LABEL[kind]} — needs you` };
  }
  return { glyph, tone: "text-ink-faint", label: TARGET_LABEL[kind] };
}

/** Icon-only rendering — the sidebar's compact form. */
export function TargetIcon({
  kind,
  state,
  className,
}: {
  readonly kind: SessionTarget;
  readonly state?: SessionTargetState;
  readonly className?: string;
}) {
  const { glyph, tone, label } = resolve(kind, state);
  return (
    <span title={label} className="flex shrink-0 items-center">
      <Icon
        icon={glyph}
        aria-label={label}
        aria-hidden={false}
        className={cn("size-3.5", tone, className)}
      />
    </span>
  );
}
