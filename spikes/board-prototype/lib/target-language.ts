/**
 * The unified review-target vocabulary (CONTEXT.md "Session targets"): every
 * surface — sidebar sessions, New chat rows, session headers — names a target
 * with these terms and no synonyms. Location is the Source (host), carried by
 * the sidebar grouping and host icons, never by these labels.
 */

export type TargetKind = "your-branch" | "your-pr" | "teammate-pr"

export const TARGET_LABEL: Record<TargetKind, string> = {
  "your-branch": "Your branch",
  "your-pr": "Your PR",
  "teammate-pr": "Teammate PR",
}
