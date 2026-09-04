import type { Patchset, PatchsetIntent, Review } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import { prPaperContextFile } from "./pr-paper";

const patchset = (intent?: PatchsetIntent): Patchset =>
  ({
    id: "ps-1",
    createdAt: "2026-09-03T00:00:00.000Z",
    repository: {
      id: "repo",
      root: "/repo",
      commonDir: "/repo/.git",
      baseRef: "origin/main",
      baseOid: "base",
      headOid: "head",
    },
    files: [],
    rawDiff: "",
    byteLength: 0,
    truncated: false,
    ...(intent === undefined ? {} : { intent }),
  }) as Patchset;

const review = (intent: PatchsetIntent | undefined, pr: boolean): Review =>
  ({
    id: "r1",
    repositoryRoot: "/repo",
    activePatchsetId: "ps-1",
    patchsets: [patchset(intent)],
    dispositions: [],
    ...(pr
      ? {
          postTarget: {
            repo: { forge: "github", owner: "acme", name: "widget" },
            number: 412,
            forgeRef: "PR_kw",
            headOid: "head",
          },
        }
      : {}),
  }) as unknown as Review;

const PR_INTENT: PatchsetIntent = {
  surface: "github-pr",
  prTitle: "Bind every turn to one workspace root",
  prBody:
    "Implements `openspec/changes/session-bound-workspace`. Rounds now run as turns on the session's bound root.",
};

describe("prPaperContextFile (review finding 6)", () => {
  it("carries the reviewed PR's title and body — the clue the Design seat cannot reach itself", () => {
    const file = prPaperContextFile(review(PR_INTENT, true));

    expect(file?.name).toBe("pr.md");
    // The BODY is the load-bearing half: it is what names the spec, and a PR-snapshot
    // review drafts in a detached worktree where `gh pr view` has no branch to resolve.
    expect(file?.body).toContain("openspec/changes/session-bound-workspace");
    expect(file?.body).toContain("# Bind every turn to one workspace root");
    // Both index lines, or the README entry reads as a file nobody knows when to open.
    expect(file?.holds.length).toBeGreaterThan(0);
    expect(file?.readWhen.length).toBeGreaterThan(0);
  });

  it("falls back to the PR number as a heading when the title is empty but the body is not", () => {
    const file = prPaperContextFile(review({ surface: "github-pr", prBody: "why" }, true));
    expect(file?.body).toBe("# Pull request #412\n\nwhy\n");
  });

  it("writes NOTHING for a working-tree capture — there is no pull request to quote", () => {
    expect(
      prPaperContextFile(review({ surface: "working-tree", commitSubjects: ["wip"] }, false)),
    ).toBeUndefined();
  });

  it("writes NOTHING when the PR recorded no title and no body", () => {
    // The honest absence (`prBodyAbsent`): an empty `pr.md` would read to a seat as "the
    // author said nothing", which is a claim, not an absence.
    expect(
      prPaperContextFile(review({ surface: "github-pr", prBodyAbsent: true }, true)),
    ).toBeUndefined();
    // ...and a whitespace-only body is the same absence wearing a space.
    expect(
      prPaperContextFile(review({ surface: "github-pr", prBody: "   \n" }, true)),
    ).toBeUndefined();
  });
});
