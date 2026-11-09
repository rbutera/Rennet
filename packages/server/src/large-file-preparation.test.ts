import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type DetectedSourceControlTool,
  LargeFileSkipIndex,
  largeFileSkipIndexPath,
  SessionStore,
  withLargeFileSkipIndex,
} from "@rennet/adapters";
import type { SidebarSession } from "@rennet/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRennetServer } from "./create-server";
import { createGitHubTokenStore } from "./github-token-store";

/**
 * The workspace stage of a pull-request review in a repository that uses Git LFS
 * (review-preparation-reliability 2.3, 2.4, 2.5 and the skip-mode environment).
 *
 * The repository's own config stands in for the sighting's global one: the LFS filter is
 * REQUIRED and its command prints exactly what a shell prints when `git-lfs` is not installed
 * (`git-lfs: command not found`), so the fixture behaves the same on a machine that has
 * Git LFS and on one that does not. Repository config beats the user's global config, and
 * Rennet's per-call `-c` overrides beat both — the order the real arrangement has.
 */

const POINTER = [
  "version https://git-lfs.github.com/spec/v1",
  "oid sha256:4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393",
  "size 12345",
  "",
].join("\n");

/** The filter command: counts each run in `attempts`, then fails as a missing git-lfs does. */
const missingGitLfs = (attempts: string) =>
  `echo run >> '${attempts}'; echo "git-lfs: command not found" >&2; exit 127`;

const dirs: string[] = [];
const shutdowns: (() => void)[] = [];
afterEach(() => {
  for (const shutdown of shutdowns.splice(0)) shutdown();
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

type Session = SidebarSession;

function lfsRepository() {
  const dataDir = realpathSync(mkdtempSync(join(tmpdir(), "rennet-lfs-prep-data-")));
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "rennet-lfs-prep-repo-")));
  dirs.push(dataDir, repo);
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.email", "rennet@example.test");
  git("config", "user.name", "Rennet Test");
  // Committed with the filter switched OFF, so the pointer is stored verbatim, exactly as
  // git-lfs itself would have stored it.
  for (const key of ["process", "smudge", "clean"]) git("config", `filter.lfs.${key}`, "");
  git("config", "filter.lfs.required", "false");
  writeFileSync(join(repo, "README.md"), "acme widget\n");
  git("add", "README.md");
  git("commit", "-q", "-m", "base");
  const baseOid = git("rev-parse", "HEAD");
  git("checkout", "-q", "-b", "feature");
  writeFileSync(join(repo, ".gitattributes"), "*.bin filter=lfs diff=lfs merge=lfs -text\n");
  mkdirSync(join(repo, "assets"));
  writeFileSync(join(repo, "assets", "model.bin"), POINTER);
  git("add", "-A");
  git("commit", "-q", "-m", "add a large widget model");
  const headOid = git("rev-parse", "HEAD");
  // Back on main, so the reviewer's own checkout holds no LFS file at all.
  git("checkout", "-q", "main");
  git("remote", "add", "origin", "git@github.com:acme/widget.git");
  // NOW the filter is required and Git LFS is "missing". Every checkout that runs it leaves
  // one line in `attempts`.
  const attempts = join(dataDir, "filter-attempts.log");
  git("config", "filter.lfs.process", missingGitLfs(attempts));
  git("config", "filter.lfs.smudge", missingGitLfs(attempts));
  const filterRuns = () => {
    try {
      return readFileSync(attempts, "utf8").split("\n").filter(Boolean).length;
    } catch {
      return 0;
    }
  };
  git("config", "filter.lfs.required", "true");
  /** Stand-in for Install for me: Git LFS now answers, so the filter is ordinary again. */
  const installGitLfs = () => {
    for (const key of ["process", "smudge", "clean"]) git("config", `filter.lfs.${key}`, "");
    git("config", "filter.lfs.required", "false");
  };
  return { dataDir, repo, git, baseOid, headOid, installGitLfs, filterRuns };
}

/** GitHub's three answers for pull request #7 of acme/widget, from its pinned OIDs. */
function gitHub(baseOid: string, headOid: string) {
  const json = (body: unknown, headers: Record<string, string> = {}) =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json", ...headers },
      }),
    );
  return vi.fn<typeof globalThis.fetch>((input) => {
    const path = new URL(String(input instanceof Request ? input.url : input)).pathname;
    if (path === "/rate_limit") {
      return json(
        { resources: {} },
        { "X-OAuth-Scopes": "repo, workflow", "X-RateLimit-Limit": "5000" },
      );
    }
    if (path === "/user") return json({ login: "rai" });
    if (path === "/graphql") {
      return json({
        data: {
          repository: {
            pullRequest: {
              number: 7,
              title: "Add a large widget model",
              body: "",
              isDraft: false,
              headRefOid: headOid,
              baseRefOid: baseOid,
              baseRefName: "main",
              headRefName: "feature",
              changedFiles: 2,
              id: "PR_widget_7",
              viewerDidAuthor: false,
            },
          },
        },
      });
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  });
}

const gitRow: DetectedSourceControlTool = {
  id: "git",
  version: "2.53.0",
  status: "available",
  path: "/usr/bin/git",
  detail: "Git 2.53.0.",
};
const missingLfsRow: DetectedSourceControlTool = {
  id: "git-lfs",
  version: null,
  status: "not-installed",
  path: null,
  detail: "Git LFS isn't installed.",
};

async function serverFor(fixture: ReturnType<typeof lfsRepository>) {
  await createGitHubTokenStore(fixture.dataDir).setGitHubCredential({ token: "gho_acme_widget" });
  const server = await createRennetServer({
    dataDir: fixture.dataDir,
    // Hold drafting once the workspace is bound: these tests are about the stage before it.
    env: { RENNET_TEST_BOARD_PREPARATION_DELAY_MS: "60000" },
    httpFetch: gitHub(fixture.baseOid, fixture.headOid),
    // What this machine has installed must not decide the answer.
    sourceControl: { detect: async () => [gitRow, missingLfsRow] },
  });
  shutdowns.push(server.shutdown);
  const added = (await server.dispatch("projects.add", {
    commandId: randomUUID(),
    discovery: {
      path: fixture.repo,
      kind: "repo",
      repos: [{ name: "widget", path: fixture.repo, branches: 2 }],
      primaryBranch: "main",
    },
    includedRepos: ["widget"],
    primaryBranch: "main",
  })) as { project: { id: string } };
  const listed = async (sessionId: string): Promise<Session | undefined> => {
    const { sessions } = (await server.dispatch("session.list", {})) as { sessions: Session[] };
    return sessions.find((session) => session.id === sessionId);
  };
  const waitFor = async (sessionId: string, check: (session: Session | undefined) => void) => {
    let seen: Session | undefined;
    await vi.waitFor(
      async () => {
        seen = await listed(sessionId);
        check(seen);
      },
      { timeout: 20_000, interval: 25 },
    );
    return seen as Session;
  };
  const mint = async () => {
    const minted = (await server.dispatch("session.mint", {
      projectId: added.project.id,
      commandId: randomUUID(),
      branch: "feature",
      prNumber: 7,
      repository: "acme/widget",
    })) as { session: Session | null };
    return minted.session?.id ?? "";
  };
  return { server, projectId: added.project.id, mint, waitFor };
}

/** What a daemon child's git reads in `cwd`, under the daemon's skip-mode environment. */
function lfsRequiredUnderDaemonEnv(dataDir: string, cwd: string): string {
  return execFileSync("git", ["config", "--get", "filter.lfs.required"], {
    cwd,
    env: withLargeFileSkipIndex({ ...process.env }, largeFileSkipIndexPath(dataDir)),
    encoding: "utf8",
  }).trim();
}

describe("the workspace stage of a Git LFS pull request (review-preparation-reliability)", () => {
  it("asks once, waits, and binds under the answer after session.chooseLargeFileMode", async () => {
    const fixture = lfsRepository();
    const { server, mint, waitFor } = await serverFor(fixture);
    const sessionId = await mint();

    // 2.3: the repository uses Git LFS and the project never answered, so preparation stops
    // BEFORE checking anything out, and says whether Git LFS answered.
    const asked = await waitFor(sessionId, (session) =>
      expect(session?.preparation?.status).toBe("awaiting"),
    );
    expect(asked.preparation).toEqual({
      status: "awaiting",
      kind: "large-file-choice",
      lfsAvailable: false,
      reviewId: asked.reviewId,
    });
    const store = new SessionStore(join(fixture.dataDir, "sessions"));
    expect(store.load(sessionId)?.boundRoot).toBeUndefined();

    // 2.4: the answer resumes preparation, which binds under it.
    const answered = (await server.dispatch("session.chooseLargeFileMode", {
      sessionId,
      mode: "skip",
    })) as { session: Session | null };
    expect(answered.session?.preparation?.status).not.toBe("awaiting");
    await vi.waitFor(() => expect(store.load(sessionId)?.boundRoot).toBeDefined(), {
      timeout: 20_000,
      interval: 25,
    });
    const boundRoot = store.load(sessionId)?.boundRoot ?? "";
    expect(boundRoot).not.toBe(fixture.repo);
    // Skipped: the checkout landed with the pointer file, though the filter is required and
    // "missing".
    expect(readFileSync(join(boundRoot, "assets", "model.bin"), "utf8")).toBe(POINTER);
    const drafting = await waitFor(sessionId, (session) =>
      expect(session?.preparation?.status).toBe("drafting"),
    );
    expect(drafting.reviewId).toBe(asked.reviewId);

    // The answer is the PROJECT's: recorded on its repo rung, so nothing asks again.
    const view = (await server.dispatch("settings.get", {})) as {
      projects: { prefs?: { largeFiles?: { value: string; layer: string } } }[];
    };
    expect(view.projects[0]?.prefs?.largeFiles).toEqual({ value: "skip", layer: "repo" });

    // Every later git command a daemon child runs in that checkout is skip mode too — and
    // only there: the reviewer's own checkout still runs the filter as configured.
    expect(lfsRequiredUnderDaemonEnv(fixture.dataDir, boundRoot)).toBe("false");
    expect(lfsRequiredUnderDaemonEnv(fixture.dataDir, fixture.repo)).toBe("true");

    await server.dispatch("session.cancelPreparation", { sessionId });
  }, 60_000);

  it("a front door that fails for missing Git LFS fails the session classified, then Retry binds after the install", async () => {
    const fixture = lfsRepository();
    const { server, projectId, mint, waitFor } = await serverFor(fixture);
    // The project already chose to download large files, so nothing asks: the front door
    // checks the pull request out at once — and Git LFS is missing.
    await server.dispatch("settings.setProjectValue", {
      projectId,
      repoPath: fixture.repo,
      key: "largeFiles",
      value: "download",
    });
    const sessionId = await mint();

    // 2.5: the front door's failure reaches the session, classified, at the workspace stage.
    const failed = await waitFor(sessionId, (session) =>
      expect(session?.preparation?.status).toBe("failed"),
    );
    const preparation = failed.preparation;
    if (preparation?.status !== "failed") throw new Error("preparation did not fail");
    expect(preparation).toMatchObject({
      stage: "workspace",
      kind: "tool-missing",
      tool: "git-lfs",
      action: "install",
      reviewId: failed.reviewId,
    });
    // The reason is a plain sentence; git's own words are only the detail.
    expect(preparation.reason).toBe(
      "Git LFS isn't installed, so this pull request's large files can't be checked out.",
    );
    expect(preparation.reason).not.toMatch(/command not found|fatal|worktree/);
    expect(preparation.detail).toMatch(/git-lfs: command not found/);
    // …and the bind did not repeat the checkout the front door had just failed: the filter
    // ran once, for the front door's attempt, and the bind reported that outcome.
    expect(fixture.filterRuns()).toBe(1);

    // Retry after Git LFS is installed binds for real, in download mode.
    fixture.installGitLfs();
    await server.dispatch("session.retryPreparation", { sessionId, commandId: randomUUID() });
    const store = new SessionStore(join(fixture.dataDir, "sessions"));
    await vi.waitFor(() => expect(store.load(sessionId)?.boundRoot).toBeDefined(), {
      timeout: 20_000,
      interval: 25,
    });
    const boundRoot = store.load(sessionId)?.boundRoot ?? "";
    await waitFor(sessionId, (session) => expect(session?.preparation?.status).toBe("drafting"));
    // A download-mode checkout is NOT a skip-mode one: nothing is registered for it, and git
    // there reads the repository's own filter config.
    expect(new LargeFileSkipIndex(largeFileSkipIndexPath(fixture.dataDir)).gitDirs()).toEqual([]);
    expect(lfsRequiredUnderDaemonEnv(fixture.dataDir, boundRoot)).toBe("false");
    fixture.git("config", "filter.lfs.required", "true");
    expect(lfsRequiredUnderDaemonEnv(fixture.dataDir, boundRoot)).toBe("true");

    await server.dispatch("session.cancelPreparation", { sessionId });
  }, 60_000);

  it("a skip-mode front-door checkout whose Git LFS hook refused keeps its note on the session", async () => {
    const fixture = lfsRepository();
    // The hook `git lfs install` writes, in the repository with no git-lfs to run: it exits 2
    // after the checkout has landed, printing its stock line.
    const hooks = join(fixture.repo, ".git", "hooks");
    mkdirSync(hooks, { recursive: true });
    writeFileSync(
      join(hooks, "post-checkout"),
      "#!/bin/sh\necho >&2 \"\\nThis repository is configured for Git LFS but 'git-lfs' was not found on your path. If you no longer wish to use Git LFS, remove this hook by deleting the 'post-checkout' file in the hooks directory (set by 'core.hookspath'; usually '.git/hooks').\\n\"; exit 2\n",
      { mode: 0o755 },
    );
    const { server, projectId, mint, waitFor } = await serverFor(fixture);
    await server.dispatch("settings.setProjectValue", {
      projectId,
      repoPath: fixture.repo,
      key: "largeFiles",
      value: "skip",
    });
    const sessionId = await mint();
    const drafting = await waitFor(sessionId, (session) =>
      expect(session?.preparation?.status).toBe("drafting"),
    );
    // The warning came back only from the front door's creating call; the bind found the
    // checkout already there, and the note still reached the session.
    expect(drafting.workspaceNotes).toEqual([
      "Large files were left as placeholders. This repository's Git LFS hook needs Git LFS, which isn't installed, so the hook was skipped.",
    ]);
    await server.dispatch("session.cancelPreparation", { sessionId });
  }, 60_000);
});
