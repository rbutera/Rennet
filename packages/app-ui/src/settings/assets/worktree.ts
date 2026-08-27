// ─────────────────────────────────────────────────────────────────────────────
// Worktree naming (C10 §8.3, claims 653–655), ported from the spike's
// `settings-data.ts` (`worktreeTokens` / `previewWorktreeName`) as a real app-ui
// lib. The Projects page's Worktrees section inserts these tokens into the naming
// pattern and shows a live preview of the resolved directory name — branch slashes
// flattened to dashes, the way a real worktree folder is named.
// ─────────────────────────────────────────────────────────────────────────────

/** The client-default worktree location + naming pattern, before a per-project override. */
export const DEFAULT_WORKTREE_ROOT = "~/.rennet/worktrees";
export const DEFAULT_WORKTREE_PATTERN = "{project}-{branch}";

export interface WorktreeToken {
  readonly token: string;
  readonly label: string;
  /** The sample value the preview resolves this token to (`{project}` uses the name). */
  readonly sample: string;
}

/** Tokens the naming pattern understands, with sample values for the preview. */
export const WORKTREE_TOKENS: readonly WorktreeToken[] = [
  { token: "{project}", label: "project", sample: "" }, // sample = the project's name
  { token: "{branch}", label: "branch", sample: "fix/session-scope" },
  { token: "{pr}", label: "PR number", sample: "482" },
  { token: "{user}", label: "user", sample: "rai" },
  { token: "{date}", label: "date", sample: "2026-08-25" },
];

/** Resolve a pattern against sample values; slashes become dashes in dir names. */
export function previewWorktreeName(pattern: string, projectName: string): string {
  let out = pattern;
  for (const t of WORKTREE_TOKENS) {
    out = out.replaceAll(t.token, t.token === "{project}" ? projectName : t.sample);
  }
  return out.replaceAll("/", "-");
}
