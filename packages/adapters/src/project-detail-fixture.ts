import type { LocalWork, ProjectDetail, PullRequest } from "@rennet/protocol";

/**
 * The project-detail substrate (issue #37), STUBBED for this wave.
 *
 * The unified smart-list surface reaches the host through the real `project.detail`
 * command; behind that typed boundary the live substrate (local worktree/branch
 * detection + the GitHub PR query set + the REST-conditional polling loop) is not
 * wired yet. Rather than invent that integration, this fixture supplies a
 * deterministic set that exercises EVERY state the surface renders — local
 * unpublished work, my own open PR, a teammate PR that has requested my review, a
 * teammate PR with red CI, a merged PR (read-only + clean-up), and the dedupe case
 * (a local branch that already has a PR). The renderer derives ownership, needs-you,
 * dedupe, and sort/filter from this raw shape exactly as it will from live data.
 *
 * Live wiring is the follow-up; the boundary here is real.
 */
const VIEWER_LOGIN = "rai";

/** The raw local worktrees/branches the host detected (private/local, backlight). */
const LOCALS: readonly LocalWork[] = [
  {
    id: "local-glass-tokens",
    branch: "feat/glass-tokens",
    repository: "rennet",
    author: VIEWER_LOGIN,
    dirty: true,
    ahead: 3,
    behind: 0,
    stage: "reviewed",
    lastActivityAt: "2026-08-09T21:40:00.000Z",
  },
  // A local branch that ALREADY has an open PR (#130) — the dedupe case. The
  // renderer must fold this into the PR row as a "checked out locally" annotation,
  // never render it as its own second row.
  {
    id: "local-front-door",
    branch: "feat/front-door",
    repository: "rennet",
    author: VIEWER_LOGIN,
    dirty: false,
    ahead: 0,
    behind: 1,
    stage: "prd",
    lastActivityAt: "2026-08-09T20:10:00.000Z",
  },
  // A local branch whose PR (#124) has MERGED — the clean-up target: read-only PR
  // row with a worktree still on disk to sweep away.
  {
    id: "local-publish-egress",
    branch: "feat/publish-egress",
    repository: "rennet",
    author: VIEWER_LOGIN,
    dirty: false,
    ahead: 0,
    behind: 4,
    stage: "prd",
    lastActivityAt: "2026-08-08T18:00:00.000Z",
  },
];

/** The pull requests on the project (public/what-exists, ink). Own + teammates'. */
const PRS: readonly PullRequest[] = [
  {
    id: "pr-131",
    number: 131,
    title: "Span disposition re-anchor over a truncated patch",
    branch: "fix/span-anchor",
    repository: "rennet",
    author: "emma",
    state: "open",
    reviewRequestedFromViewer: true, // needs me → floats up under HOT
    ci: "passing",
    additions: 214,
    deletions: 38,
    changedFiles: 9,
    lastActivityAt: "2026-08-09T19:55:00.000Z",
  },
  {
    id: "pr-129",
    number: 129,
    title: "Lossy-patch carry fail-closed",
    branch: "fix/lossy-carry",
    repository: "rennet",
    author: "florence",
    state: "open",
    reviewRequestedFromViewer: false,
    ci: "failing",
    additions: 96,
    deletions: 12,
    changedFiles: 4,
    lastActivityAt: "2026-08-09T22:05:00.000Z",
  },
  {
    id: "pr-130",
    number: 130,
    title: "The front-door shell (projects list + add-a-project)",
    branch: "feat/front-door", // dedupe: local-front-door folds into this row
    repository: "rennet",
    author: VIEWER_LOGIN,
    state: "open",
    reviewRequestedFromViewer: false,
    ci: "passing",
    additions: 1320,
    deletions: 210,
    changedFiles: 41,
    lastActivityAt: "2026-08-09T20:15:00.000Z",
  },
  {
    id: "pr-128",
    number: 128,
    title: "Money-circuit budget consumed each turn",
    branch: "fix/budget",
    repository: "rennet",
    author: VIEWER_LOGIN,
    state: "open",
    reviewRequestedFromViewer: false,
    ci: "pending",
    additions: 44,
    deletions: 6,
    changedFiles: 2,
    lastActivityAt: "2026-08-09T17:20:00.000Z",
  },
  {
    id: "pr-124",
    number: 124,
    title: "Publish egress — the first real GitHub post",
    branch: "feat/publish-egress", // dedupe: local-publish-egress folds into this row
    repository: "rennet",
    author: VIEWER_LOGIN,
    state: "merged",
    reviewRequestedFromViewer: false,
    ci: "passing",
    additions: 680,
    deletions: 74,
    changedFiles: 18,
    lastActivityAt: "2026-08-08T18:05:00.000Z",
  },
];

/**
 * The stubbed project-detail substrate. The live command is keyed by `projectId`
 * (kept on the `DispatchDeps.projectDetail` boundary); this stub returns the same
 * deterministic set for any project this wave, so it takes no argument.
 */
export function projectDetailFixture(): ProjectDetail {
  return {
    viewer: { login: VIEWER_LOGIN },
    locals: [...LOCALS],
    prs: [...PRS],
    truncated: false,
  };
}

/**
 * The clean-up handler, STUBBED. A merged PR's local worktree deletion is a real
 * destructive act; this wave acknowledges the request (so the surface behaves) but
 * removes nothing from disk. Real `git worktree remove` + branch deletion (keyed by
 * the `{ projectId, branch }` the `DispatchDeps.cleanupWorktree` boundary carries) is
 * the follow-up.
 */
export function cleanupWorktreeFixture(): { ok: boolean } {
  return { ok: true };
}
