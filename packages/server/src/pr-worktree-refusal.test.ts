// THE PULL-REQUEST FRONT DOOR'S PLACEMENT REFUSAL REACHES THE LOG (review finding S3).
//
// `ensurePrWorktree` refuses BY DESIGN when something that is not Rennet's snapshot occupies
// the computed path — which the reviewer can arrange without doing anything strange, because
// the branch pattern and the pull-request pattern are both theirs to set and both resolve
// under one root. That refusal names the path and what occupies it.
//
// It was then swallowed by a bare `catch {}`. The review opened with no checkout, the agent
// could run nothing in it, `review.prWorktree` answered `null`, and the sentence explaining
// why existed for the length of one stack frame. That is the "lie in the UI" family: spend
// and capability the reviewer cannot see, and nothing anywhere to act on.
//
// Driven through the REAL front door — `review.openPr` on a real daemon over a real clone —
// because the claim is about a `catch` in `openPullRequestRef`, and a unit test of the
// message would prove nothing about which handler it is wired into. Only GitHub's own
// GraphQL is faked (through the injectable `httpFetch`); every OID, every worktree and the
// collision itself are real git.

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRennetServer } from "./create-server";
import { createGitHubTokenStore } from "./github-token-store";

const OWNER = "rbutera";
const NAME = "fixture";

const dirs: string[] = [];
const shutdowns: Array<() => void> = [];
afterEach(() => {
  for (const stop of shutdowns.splice(0)) stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  }).trim();
}

/**
 * A clone whose `origin` IDENTIFIES it as `rbutera/fixture`, holding both reviewed OIDs.
 *
 * The URL is never contacted: `GitHubChangesetSource` fetches from the remote only when an
 * OID is missing from the object store, and both are here. So the ONLY egress this test has
 * is the PR query, which is what the fake transport answers.
 */
function clone(): { root: string; baseOid: string; headOid: string } {
  const root = mkdtempSync(join(tmpdir(), "rennet-pr-refusal-repo-"));
  dirs.push(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "remote", "add", "origin", `https://github.com/${OWNER}/${NAME}.git`);
  execFileSync("bash", ["-c", "echo one > a.txt"], { cwd: root });
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "base");
  const baseOid = git(root, "rev-parse", "HEAD");
  git(root, "checkout", "-q", "-b", "feat/x");
  execFileSync("bash", ["-c", "echo two > b.txt"], { cwd: root });
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "head");
  const headOid = git(root, "rev-parse", "HEAD");
  git(root, "checkout", "-q", "main");
  return { root, baseOid, headOid };
}

/** GitHub's GraphQL, and nothing else: any other request is a bug this test wants to see. */
function forgeFetch(baseOid: string, headOid: string): typeof globalThis.fetch {
  return async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const body = url.includes("/graphql")
      ? {
          data: {
            repository: {
              pullRequest: {
                id: "PR_node",
                title: "A change",
                body: "",
                isDraft: false,
                headRefOid: headOid,
                baseRefOid: baseOid,
                baseRefName: "main",
                headRefName: "feat/x",
                changedFiles: 1,
                viewerDidAuthor: true,
              },
            },
          },
        }
      : {};
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

describe("the pull-request front door's placement refusal (review finding S3)", () => {
  it("opens the review WITHOUT a checkout and says why in the daemon log", {
    timeout: 60_000,
  }, async () => {
    const repo = clone();
    const dataDir = mkdtempSync(join(tmpdir(), "rennet-pr-refusal-"));
    dirs.push(dataDir);
    await createGitHubTokenStore(dataDir).setGitHubCredential({ token: "gho_fixture" });

    // THE COLLISION, arranged the way a reviewer arranges it: a worktree ON A BRANCH sitting
    // at the builtin pull-request path. `ensurePrWorktree` refuses to replace it — it is not
    // detached and Rennet's index records no snapshot there — which is the whole point: the
    // reviewer's uncommitted work in that tree used to be `rm -rf`'d by opening a PR.
    const collision = join(dataDir, "worktrees", OWNER, NAME, "pr-1");
    git(repo.root, "worktree", "add", "-q", "-b", "mine", collision, "refs/heads/main");

    const log: string[] = [];
    const server = await createRennetServer({
      dataDir,
      env: {},
      httpFetch: forgeFetch(repo.baseOid, repo.headOid),
      siblingCollectionLog: (message) => void log.push(message),
    });
    shutdowns.push(server.shutdown);
    await server.dispatch("projects.add", {
      commandId: randomUUID(),
      discovery: {
        path: repo.root,
        kind: "repo",
        repos: [{ name: NAME, path: repo.root, branches: 2 }],
        primaryBranch: "main",
      },
      includedRepos: [NAME],
      primaryBranch: "main",
    });

    const opened = (await server.dispatch("review.openPr", {
      commandId: randomUUID(),
      ref: `${OWNER}/${NAME}#1`,
      // The clone, explicitly: without it the front door falls through to a MANAGED clone
      // and this test would reach for github.com. The identity match is the same one the
      // project row makes.
      repoPath: repo.root,
    })) as { review: { id: string } };

    // The review still opens: a diff and a conversation need no checkout, and refusing the
    // review over where its worktree goes would be the gate this is not.
    expect(opened.review.id.length).toBeGreaterThan(0);
    // THE FINDING. One line, carrying `ensurePrWorktree`'s own sentence — the occupied path
    // and the ref on it — so the reviewer can move it or change the layout.
    const line = log.find((message) => message.includes("no pull-request worktree"));
    expect(line).toBeDefined();
    expect(line).toContain(`${OWNER}/${NAME}#1`);
    expect(line).toContain(collision);
    expect(line).toContain("mine");
    // And the collision is untouched, which is the refusal's own reason for existing.
    expect(existsSync(join(collision, "a.txt"))).toBe(true);
    expect(git(collision, "rev-parse", "--abbrev-ref", "HEAD")).toBe("mine");
  });
});
