import { cn } from "@rennet/ui";
import { Check, GitBranch, GitMerge, GitPullRequest, GitPullRequestArrow } from "lucide-react";
import { Icon } from "../../components/icon";
import { type SessionTarget, type SessionTargetState, TARGET_LABEL } from "../sidebar-data";

// The unified icon language for review targets (R36), ported from the spike's
// `target-badge.tsx` — JSX only, no state. Branch = your branch, pull-request =
// your PR, incoming pull-request = teammate PR; merged uses the merge glyph,
// reviewed is a green tick, and "needs you" tints the target's OWN icon with the
// primary — never a badge or pill. Colours come from the theme (primary / green /
// muted-foreground), sizes from the ramp; the tooltip carries the words.

const TARGET_ICON: Record<SessionTarget, typeof GitBranch> = {
  "your-branch": GitBranch,
  "your-pr": GitPullRequest,
  "teammate-pr": GitPullRequestArrow,
};

function resolve(kind: SessionTarget, state?: SessionTargetState) {
  if (state === "merged") {
    return { glyph: GitMerge, tone: "text-muted-foreground", label: "Merged" };
  }
  if (state === "reviewed") {
    return { glyph: Check, tone: "text-green", label: "Reviewed" };
  }
  const glyph = TARGET_ICON[kind];
  if (state === "needs-you") {
    return { glyph, tone: "text-primary", label: `${TARGET_LABEL[kind]} — needs you` };
  }
  return { glyph, tone: "text-muted-foreground", label: TARGET_LABEL[kind] };
}

/** The STATE labels: a target that carries a derived state reads by that state, never by
 *  its bare kind — a teammate PR awaiting you says "Needs you", not "Teammate PR". */
const STATE_LABEL: Record<SessionTargetState, string> = {
  "needs-you": "Needs you",
  merged: "Merged",
  reviewed: "Reviewed",
};

/**
 * Icon + text pill — the New Chat list's form of the same vocabulary (ported from the
 * spike's `target-badge.tsx`). Per-kind TREATMENT is the point, and it is what the app
 * lost when every row rendered one uniform bordered chip: the thing wanting your
 * attention is a solid accent pill, your own PR is a gold outline, an ordinary
 * branch/teammate row is a quiet raised fill, and a reviewed target is a green tint.
 *
 * The glyph is the KIND's own (`TARGET_ICON`), including for "needs you" — the spike
 * hardcoded the incoming-PR arrow there because its fixture only ever routed teammate
 * PRs into that state. Rennet's smart list can put your OWN pull request in it, and a
 * your-PR that needs you is still your PR.
 *
 * `text-10` is the ramp's floor and the nearest sanctioned step to the spike's 10.5px;
 * `sm` differs from `md` in padding and glyph size only, since 9.5px is below the ramp.
 */
export function TargetBadge({
  kind,
  state,
  size = "md",
}: {
  readonly kind: SessionTarget;
  readonly state?: SessionTargetState;
  readonly size?: "sm" | "md";
}) {
  const sizing = size === "sm" ? "px-1.5 py-px" : "px-2 py-0.5";
  const glyphSize = size === "sm" ? "size-2.5" : "size-3";
  const glyph = state === "merged" ? GitMerge : state === "reviewed" ? Check : TARGET_ICON[kind];
  const tone =
    state === "needs-you"
      ? "bg-primary font-semibold text-primary-foreground"
      : state === "reviewed"
        ? "border border-green-line bg-green-soft font-medium text-green"
        : state === "merged"
          ? "border border-border font-medium text-muted-foreground"
          : kind === "your-pr"
            ? "border border-primary/50 font-medium text-primary"
            : "border border-border bg-secondary/60 font-medium text-foreground/70";

  return (
    <span
      // `text-10` is appended OUTSIDE `cn`. `cn` is tailwind-merge, whose default config
      // does not know Rennet's custom size steps, so it files `text-10` under text-COLOUR
      // and drops whichever of `text-10` / `text-primary` comes first. Class order in the
      // attribute decides nothing in CSS, so appending is safe and both survive.
      className={`${cn("flex shrink-0 items-center gap-1 rounded-full", sizing, tone)} text-10`}
      data-target-kind={kind}
      {...(state === undefined ? {} : { "data-target-state": state })}
    >
      <Icon icon={glyph} className={cn(glyphSize, "shrink-0")} />
      {state ? STATE_LABEL[state] : TARGET_LABEL[kind]}
    </span>
  );
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
