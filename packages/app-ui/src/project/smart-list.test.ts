import type { LocalWork, ProjectDetail, PullRequest } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import {
  buildSmartRows,
  filterSmartRows,
  type SmartRow,
  smartListCounts,
  sortSmartRows,
} from "./smart-list";

const GITHUB_WIDGET = { forge: "github", owner: "acme", name: "widget" } as const;
const GITLAB_WIDGET = { forge: "gitlab", owner: "acme", name: "widget" } as const;

// A substrate covering every state: my local unpublished work, my open PR (with a
// local checkout → dedupe), a teammate PR that requested my review (needs-you), a
// teammate PR with red CI, my own open PR with red CI (needs-you), and a merged PR
// with a local worktree still on disk (read-only + clean-up target).
function local(over: Partial<LocalWork> & Pick<LocalWork, "branch">): LocalWork {
  return {
    id: `local-${over.branch}`,
    repository: "repo",
    author: "rai",
    dirty: false,
    ahead: 0,
    behind: 0,
    stage: "reviewed",
    lastActivityAt: "2026-08-09T10:00:00.000Z",
    ...over,
  };
}

function pr(over: Partial<PullRequest> & Pick<PullRequest, "number" | "branch">): PullRequest {
  return {
    id: `pr-${over.number}`,
    title: `PR ${over.number}`,
    repository: "repo",
    author: "rai",
    state: "open",
    reviewRequestedFromViewer: false,
    ci: "passing",
    additions: 10,
    deletions: 2,
    changedFiles: 1,
    lastActivityAt: "2026-08-09T10:00:00.000Z",
    ...over,
  };
}

const detail: ProjectDetail = {
  viewer: { login: "rai" },
  truncated: false,
  locals: [
    local({ branch: "feat/unpublished", lastActivityAt: "2026-08-09T09:00:00.000Z" }),
    local({ branch: "feat/has-pr", dirty: true }), // dedupes into pr #130
    local({ branch: "feat/merged" }), // dedupes into merged pr #124
  ],
  prs: [
    pr({
      number: 131,
      branch: "fix/review-me",
      author: "emma",
      reviewRequestedFromViewer: true,
      lastActivityAt: "2026-08-09T08:00:00.000Z",
    }),
    pr({ number: 129, branch: "fix/red", author: "florence", ci: "failing" }),
    pr({ number: 130, branch: "feat/has-pr", lastActivityAt: "2026-08-09T11:00:00.000Z" }),
    pr({ number: 124, branch: "feat/merged", state: "merged" }),
  ],
};

function byId(rows: readonly SmartRow[], id: string): SmartRow {
  const row = rows.find((r) => r.id === id);
  if (!row) throw new Error(`row ${id} not found`);
  return row;
}

describe("buildSmartRows — dedupe + ownership + state", () => {
  it("folds a local branch that has a PR into the PR row as an annotation (dedupe)", () => {
    const rows = buildSmartRows(detail);
    // The local "feat/has-pr" does NOT appear as its own row.
    expect(rows.some((r) => r.kind === "local" && r.branch === "feat/has-pr")).toBe(false);
    // The PR #130 row carries the checked-out-locally annotation instead — with the
    // worktree id (the clean-up target) and the composite (repository, branch).
    const prRow = byId(rows, "pr-130");
    expect(prRow.checkedOutLocally).toEqual({
      id: "local-feat/has-pr",
      repository: "repo",
      branch: "feat/has-pr",
      dirty: true,
    });
    // Exactly one row references that branch (one item, one row).
    expect(rows.filter((r) => r.branch === "feat/has-pr")).toHaveLength(1);
  });

  it("keeps a local branch with no PR as its own local row", () => {
    const rows = buildSmartRows(detail);
    const localRow = rows.find((r) => r.kind === "local" && r.branch === "feat/unpublished");
    expect(localRow).toBeDefined();
    expect(localRow?.state).toBe("local");
    expect(localRow?.mine).toBe(true);
  });

  it("tags ownership from the viewer, without gating (mine is appearance, not a wall)", () => {
    const rows = buildSmartRows(detail);
    expect(byId(rows, "pr-130").mine).toBe(true); // authored by the viewer
    expect(byId(rows, "pr-131").mine).toBe(false); // emma's
  });

  it("marks a merged PR read-only", () => {
    const rows = buildSmartRows(detail);
    const merged = byId(rows, "pr-124");
    expect(merged.readOnly).toBe(true);
    expect(merged.state).toBe("merged");
    // The merged PR still carries its local checkout (the clean-up target).
    expect(merged.checkedOutLocally?.branch).toBe("feat/merged");
  });

  it("does NOT dedupe across repositories that share a branch name (composite key)", () => {
    // A workspace with two repos, each carrying `feat/x`. The PR is on repo-a; the
    // local worktree is on repo-b. Bare-branch dedupe would swallow the repo-b local
    // into the repo-a PR; the composite (repository, branch) key must keep them apart.
    const rows = buildSmartRows({
      viewer: { login: "rai" },
      truncated: false,
      locals: [local({ branch: "feat/x", repository: "repo-b", id: "local-b" })],
      prs: [pr({ number: 300, branch: "feat/x", repository: "repo-a" })],
    });
    // The repo-b local keeps its own row (never swallowed).
    expect(rows.some((r) => r.kind === "local" && r.id === "local-b")).toBe(true);
    // The repo-a PR carries NO checkout annotation (different repository).
    expect(byId(rows, "pr-300").checkedOutLocally).toBeUndefined();
  });

  it("does NOT dedupe the same repository, branch, and PR number across forges", () => {
    const crossForge = buildSmartRows({
      viewer: { login: "rai" },
      truncated: false,
      locals: [
        local({
          id: "local-github-widget",
          branch: "main",
          repository: "acme/widget",
          forgeRepository: GITHUB_WIDGET,
        }),
      ],
      prs: [
        pr({
          id: "pr-gitlab-widget-7",
          number: 7,
          branch: "main",
          repository: "acme/widget",
          forgeRepository: GITLAB_WIDGET,
        }),
      ],
    });

    expect(crossForge.map((row) => row.id).sort()).toEqual([
      "local-github-widget",
      "pr-gitlab-widget-7",
    ]);
    expect(byId(crossForge, "pr-gitlab-widget-7").checkedOutLocally).toBeUndefined();

    const sameForge = buildSmartRows({
      viewer: { login: "rai" },
      truncated: false,
      locals: [
        local({
          id: "local-github-widget",
          branch: "main",
          repository: "acme/widget",
          forgeRepository: GITHUB_WIDGET,
        }),
      ],
      prs: [
        pr({
          id: "pr-github-widget-7",
          number: 7,
          branch: "main",
          repository: "acme/widget",
          forgeRepository: GITHUB_WIDGET,
        }),
      ],
    });
    expect(sameForge.map((row) => row.id)).toEqual(["pr-github-widget-7"]);
    expect(byId(sameForge, "pr-github-widget-7").checkedOutLocally?.id).toBe("local-github-widget");

    const legacyPr = buildSmartRows({
      viewer: { login: "rai" },
      truncated: false,
      locals: [
        local({
          id: "local-github-widget",
          branch: "main",
          repository: "acme/widget",
          forgeRepository: GITHUB_WIDGET,
        }),
      ],
      prs: [
        pr({
          id: "legacy-widget-7",
          number: 7,
          branch: "main",
          repository: "acme/widget",
        }),
      ],
    });
    expect(legacyPr.map((row) => row.id)).toEqual(["legacy-widget-7"]);
    expect(byId(legacyPr, "legacy-widget-7").checkedOutLocally?.id).toBe("local-github-widget");
  });

  it("annotates only the MOST RECENT PR when a branch is reused across historical PRs", () => {
    // One live worktree for `feat/reuse`; two PRs reused the branch (an older, merged
    // one and a newer, open one). The single worktree must annotate exactly ONE — the
    // most recently engaged — not both.
    const rows = buildSmartRows({
      viewer: { login: "rai" },
      truncated: false,
      locals: [local({ branch: "feat/reuse", id: "local-reuse" })],
      prs: [
        pr({
          number: 401,
          branch: "feat/reuse",
          state: "merged",
          lastActivityAt: "2026-08-01T10:00:00.000Z",
        }),
        pr({ number: 402, branch: "feat/reuse", lastActivityAt: "2026-08-09T10:00:00.000Z" }),
      ],
    });
    // The newest PR (#402) gets the annotation; the historical one (#401) does not.
    expect(byId(rows, "pr-402").checkedOutLocally?.id).toBe("local-reuse");
    expect(byId(rows, "pr-401").checkedOutLocally).toBeUndefined();
    // The single worktree is consumed once — no stray local row.
    expect(rows.some((r) => r.kind === "local")).toBe(false);
  });

  it("uses the LATER of PR and checkout activity for the merged row's HOT timestamp", () => {
    // A checked-out PR branch edited AFTER its last remote activity is real engagement;
    // the row must not go stale on the older PR timestamp.
    const rows = buildSmartRows({
      viewer: { login: "rai" },
      truncated: false,
      locals: [
        local({
          branch: "feat/fresh",
          id: "local-fresh",
          lastActivityAt: "2026-08-09T23:00:00.000Z", // newer than the PR
        }),
      ],
      prs: [pr({ number: 500, branch: "feat/fresh", lastActivityAt: "2026-08-05T10:00:00.000Z" })],
    });
    // The row inherits the newer local checkout timestamp, not the stale PR one.
    expect(byId(rows, "pr-500").lastActivityAt).toBe("2026-08-09T23:00:00.000Z");
    // And it therefore leads a HOT sort against a PR that is newer than the raw PR ts
    // but older than the checkout.
    const withOther = buildSmartRows({
      viewer: { login: "rai" },
      truncated: false,
      locals: [
        local({
          branch: "feat/fresh",
          id: "local-fresh",
          lastActivityAt: "2026-08-09T23:00:00.000Z",
        }),
      ],
      prs: [
        pr({ number: 500, branch: "feat/fresh", lastActivityAt: "2026-08-05T10:00:00.000Z" }),
        pr({ number: 600, branch: "other", lastActivityAt: "2026-08-09T12:00:00.000Z" }),
      ],
    });
    expect(sortSmartRows(withOther, "recent")[0]?.id).toBe("pr-500");
  });

  it("flags needs-you for a requested review and for my own red-CI open PR", () => {
    const rows = buildSmartRows(detail);
    expect(byId(rows, "pr-131").needsYou).toBe(true); // review requested
    // My own open PR with failing CI needs me.
    const mineRed = buildSmartRows({
      ...detail,
      locals: [],
      prs: [pr({ number: 200, branch: "b", author: "rai", ci: "failing" })],
    });
    expect(byId(mineRed, "pr-200").needsYou).toBe(true);
    // A teammate's red CI is not my problem.
    expect(byId(rows, "pr-129").needsYou).toBe(false);
  });
});

describe("sortSmartRows — HOT default with a relevance boost", () => {
  it("floats needs-you rows to the top, then orders by recency (HOT)", () => {
    const rows = sortSmartRows(buildSmartRows(detail), "hot");
    // pr-131 needs review → it leads despite being older than pr-130.
    expect(rows[0]?.id).toBe("pr-131");
    // Among the rest, the most recently engaged comes first.
    const rest = rows.slice(1);
    for (let i = 1; i < rest.length; i++) {
      const prev = rest[i - 1];
      const cur = rest[i];
      if (!prev || !cur) continue;
      expect(prev.lastActivityAt >= cur.lastActivityAt).toBe(true);
    }
  });

  it("orders purely by recency under 'recent' (no boost)", () => {
    const rows = sortSmartRows(buildSmartRows(detail), "recent");
    expect(rows[0]?.id).toBe("pr-130"); // 11:00, the newest
  });

  it("groups by author under 'author'", () => {
    const rows = sortSmartRows(buildSmartRows(detail), "author");
    expect(rows[0]?.author).toBe("emma");
    expect(rows.at(-1)?.author).toBe("rai");
  });

  it("ranks attention → live → done under 'status'", () => {
    const rows = sortSmartRows(buildSmartRows(detail), "status");
    // Merged (done) sinks to the bottom.
    expect(rows.at(-1)?.state).toBe("merged");
    expect(rows[0]?.state).toBe("open");
  });
});

describe("filterSmartRows + counts", () => {
  it("filters by ownership, kind, and attention", () => {
    const rows = buildSmartRows(detail);
    expect(filterSmartRows(rows, "all")).toHaveLength(rows.length);
    expect(filterSmartRows(rows, "needs-you").map((r) => r.id)).toEqual(["pr-131"]);
    expect(filterSmartRows(rows, "prs").every((r) => r.kind === "pr")).toBe(true);
    expect(filterSmartRows(rows, "local").every((r) => r.kind === "local")).toBe(true);
    expect(filterSmartRows(rows, "mine").every((r) => r.mine)).toBe(true);
  });

  it("reports per-filter counts for the chip labels", () => {
    const counts = smartListCounts(buildSmartRows(detail));
    // 4 PRs + 1 undeduped local = 5 rows.
    expect(counts.all).toBe(5);
    expect(counts.prs).toBe(4);
    expect(counts.local).toBe(1);
    expect(counts["needs-you"]).toBe(1);
    // 2 own PRs (130, 124) + 1 own local (feat/unpublished); emma + florence excluded.
    expect(counts.mine).toBe(3);
  });
});
