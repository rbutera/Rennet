import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  type DetectedSourceControlTool,
  LARGE_FILES_COMMITTED_WITHOUT_LFS_NOTE,
  LargeFileSkipIndex,
  largeFileSkipIndexPath,
  SessionStore,
  withLargeFileSkipIndex,
} from "@rennet/adapters";
import type { SidebarSession } from "@rennet/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRennetServer } from "./create-server";
import { includeLargeFileSkipIndex } from "./daemon";
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

function lfsRepository(
  options: {
    readonly rootOn?: "main" | "feature";
    /** `false`: the repository declares no LFS filter at all. */
    readonly lfs?: boolean;
  } = {},
) {
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
  if (options.lfs !== false) {
    writeFileSync(join(repo, ".gitattributes"), "*.bin filter=lfs diff=lfs merge=lfs -text\n");
  }
  mkdirSync(join(repo, "assets"));
  writeFileSync(join(repo, "assets", "model.bin"), POINTER);
  git("add", "-A");
  git("commit", "-q", "-m", "add a large widget model");
  const headOid = git("rev-parse", "HEAD");
  // Back on main, so the reviewer's own checkout holds no LFS file at all — unless the test
  // reviews the branch the reviewer has out.
  git("checkout", "-q", options.rootOn ?? "main");
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

/** The real `git-lfs` on this machine, or "" when there is none (the tests that need it skip). */
const realGitLfs = (() => {
  try {
    return execFileSync(
      "sh",
      ["-c", 'PATH="$PATH:/opt/homebrew/bin:/usr/local/bin" command -v git-lfs'],
      { encoding: "utf8" },
    ).trim();
  } catch {
    return "";
  }
})();

const LARGE = "a large widget model, stored by Git LFS\n";

/** Undo every `process.env` change a real-LFS test made, after the server has shut down. */
const envRestores: (() => void)[] = [];
afterEach(() => {
  for (const restore of envRestores.splice(0).reverse()) restore();
});

/**
 * A pull request whose large file is REALLY stored by Git LFS: the repository's own config
 * runs the real `git-lfs` filter, the feature commit's blob is a pointer, and the content is
 * in the repository's LFS store — so a checkout that downloads gets the content back, and one
 * that skips gets the pointer. Every worktree of the repository shares that store.
 *
 * The daemon's environment comes with it, exactly as `startDaemon` builds it: `git-lfs` on
 * the PATH and the skip-mode index included through `GIT_CONFIG_*`, in THIS process's
 * environment, which every git the in-process server runs inherits. Restored after the test.
 */
function realLfsRepository() {
  const dataDir = realpathSync(mkdtempSync(join(tmpdir(), "rennet-reallfs-data-")));
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "rennet-reallfs-repo-")));
  dirs.push(dataDir, repo);
  const before = { ...process.env };
  envRestores.push(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in before)) delete process.env[key];
    }
    Object.assign(process.env, before);
  });
  process.env.PATH = `${dirname(realGitLfs)}:${process.env.PATH ?? ""}`;
  includeLargeFileSkipIndex(process.env, dataDir);
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.email", "rennet@example.test");
  git("config", "user.name", "Rennet Test");
  // The config `git lfs install` writes, in the repository so the user's own is not needed.
  git("config", "filter.lfs.clean", "git-lfs clean -- %f");
  git("config", "filter.lfs.smudge", "git-lfs smudge -- %f");
  git("config", "filter.lfs.process", "git-lfs filter-process");
  git("config", "filter.lfs.required", "true");
  writeFileSync(join(repo, "README.md"), "acme widget\n");
  git("add", "README.md");
  git("commit", "-q", "-m", "base");
  const baseOid = git("rev-parse", "HEAD");
  git("checkout", "-q", "-b", "feature");
  writeFileSync(join(repo, ".gitattributes"), "*.bin filter=lfs diff=lfs merge=lfs -text\n");
  mkdirSync(join(repo, "assets"));
  writeFileSync(join(repo, "assets", "model.bin"), LARGE);
  git("add", "-A");
  git("commit", "-q", "-m", "add a large widget model");
  expect(git("cat-file", "-p", "HEAD:assets/model.bin")).toMatch(/^version https:/);
  const headOid = git("rev-parse", "HEAD");
  git("checkout", "-q", "main");
  git("remote", "add", "origin", "git@github.com:acme/widget.git");
  return {
    dataDir,
    repo,
    git,
    baseOid,
    headOid,
    installGitLfs: () => undefined,
    filterRuns: () => 0,
  };
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

async function serverFor(
  fixture: ReturnType<typeof lfsRepository>,
  serverOptions: {
    /** A directory holding stub `brew` and `git` for Install for me; Git LFS then answers
     *  once the stub brew has left `installed` there. */
    readonly brewBin?: string;
    /** Extra test environment for the server. */
    readonly env?: Record<string, string>;
    /** A project this data directory already has (a restarted daemon): not added again. */
    readonly projectId?: string;
    /** Git LFS answers on this host from the start. */
    readonly lfsInstalled?: boolean;
  } = {},
) {
  await createGitHubTokenStore(fixture.dataDir).setGitHubCredential({ token: "gho_acme_widget" });
  const brewBin = serverOptions.brewBin;
  const server = await createRennetServer({
    dataDir: fixture.dataDir,
    // Hold drafting once the workspace is bound: these tests are about the stage before it.
    env: { RENNET_TEST_BOARD_PREPARATION_DELAY_MS: "60000", ...serverOptions.env },
    httpFetch: gitHub(fixture.baseOid, fixture.headOid),
    // What this machine has installed must not decide the answer.
    sourceControl: {
      detect: async () =>
        serverOptions.lfsInstalled === true ||
        (brewBin !== undefined && existsSync(join(brewBin, "installed")))
          ? [gitRow, { ...missingLfsRow, version: "3.7.1", status: "available" as const }]
          : [gitRow, missingLfsRow],
      ...(brewBin === undefined
        ? {}
        : { installPlanDeps: { platform: "darwin", envPath: "", brewDirectories: [brewBin] } }),
    },
  });
  shutdowns.push(server.shutdown);
  const added =
    serverOptions.projectId !== undefined
      ? { project: { id: serverOptions.projectId } }
      : ((await server.dispatch("projects.add", {
          commandId: randomUUID(),
          discovery: {
            path: fixture.repo,
            kind: "repo",
            repos: [{ name: "widget", path: fixture.repo, branches: 2 }],
            primaryBranch: "main",
          },
          includedRepos: ["widget"],
          primaryBranch: "main",
        })) as { project: { id: string } });
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
  const mint = async (
    mintOptions: {
      readonly pr?: boolean;
      readonly commandId?: string;
      readonly largeFiles?: "download" | "skip";
    } = {},
  ) => {
    const minted = (await server.dispatch("session.mint", {
      projectId: added.project.id,
      commandId: mintOptions.commandId ?? randomUUID(),
      ...(mintOptions.largeFiles === undefined ? {} : { largeFiles: mintOptions.largeFiles }),
      branch: "feature",
      ...(mintOptions.pr === false ? {} : { prNumber: 7 }),
      repository: "acme/widget",
    })) as { session: Session | null };
    return minted.session?.id ?? "";
  };
  const setMode = (mode: "download" | "skip") =>
    server.dispatch("settings.setProjectValue", {
      projectId: added.project.id,
      repoPath: fixture.repo,
      key: "largeFiles",
      value: mode,
    });
  return { server, projectId: added.project.id, mint, waitFor, setMode };
}

/** The git dir `includeIf "gitdir:"` matches for the checkout at `cwd`. */
function gitDirOf(cwd: string): string {
  return execFileSync("git", ["rev-parse", "--absolute-git-dir"], { cwd, encoding: "utf8" }).trim();
}

/** The git dirs the daemon's skip-mode index names right now. */
function registered(dataDir: string): string[] {
  return new LargeFileSkipIndex(largeFileSkipIndexPath(dataDir)).gitDirs();
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

  it("while the question is open, a transcript read or a chat thread checks nothing out", async () => {
    const fixture = lfsRepository();
    const { server, mint, waitFor } = await serverFor(fixture);
    const sessionId = await mint();
    const asked = await waitFor(sessionId, (session) =>
      expect(session?.preparation?.status).toBe("awaiting"),
    );
    const reviewId = asked.reviewId ?? "";
    // A filter that runs: a lazy bind that ignored the open question would now check the
    // pull request out, reading `ask` as download.
    fixture.installGitLfs();

    // The transcript read answers, on the repository, and binds nothing.
    const transcript = (await server.dispatch("session.transcript", { reviewId })) as {
      rows: unknown[];
    };
    expect(transcript.rows).toEqual([]);
    // Creating the review's chat thread is refused, in plain words (asserted below).
    const sent = (await server.dispatch("chat.t3Send", { reviewId, text: "What changed?" })) as {
      status: string;
      reason?: string;
    };

    const store = new SessionStore(join(fixture.dataDir, "sessions"));
    expect(store.load(sessionId)?.boundRoot).toBeUndefined();
    // No checkout exists anywhere: the repository has only the reviewer's own worktree.
    const worktrees = fixture
      .git("worktree", "list", "--porcelain")
      .split("\n")
      .filter((line) => line.startsWith("worktree "));
    expect(worktrees).toEqual([`worktree ${fixture.repo}`]);
    expect(sent).toEqual({
      status: "unavailable",
      reason: "This review is waiting for you to choose whether to download or skip large files.",
    });
    const still = await waitFor(sessionId, (session) =>
      expect(session?.preparation?.status).toBe("awaiting"),
    );
    expect(still.preparation).toMatchObject({ status: "awaiting", reviewId });
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

  it("a later front door that succeeds replaces an earlier failure, so no bind reports it", async () => {
    const fixture = lfsRepository();
    // The session's preparation holds between its capture (and so its front door) and its
    // bind, which is the gap a second front door for the same review can land in.
    const { server, mint, setMode } = await serverFor(fixture, {
      env: { RENNET_TEST_CAPTURE_SETTLEMENT_DELAY_MS: "60000" },
    });
    await setMode("download");
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const commandId = randomUUID();
    const sessionId = await mint({ commandId });
    // Front door one: Git LFS is missing, and its failure is recorded for the bind.
    await vi.waitFor(() => expect(fixture.filterRuns()).toBe(1), { timeout: 20_000 });
    // Git LFS is installed by hand and the same pull request is opened again — the same
    // review, by its command id. Front door two checks it out.
    fixture.installGitLfs();
    const opened = (await server.dispatch("review.openPr", {
      commandId,
      ref: "acme/widget#7",
      repoPath: fixture.repo,
    })) as { review: { id: string } };
    // Opening it warms the review's chat thread, whose bind is the first to read what the
    // front door left. It must bind the checkout front door two made, not report the
    // failure front door one left behind it.
    await vi.waitFor(
      () =>
        expect(warnings.mock.calls.flat().join("\n")).toMatch(
          new RegExp(`review ${opened.review.id} did not get a chat thread`),
        ),
      { timeout: 20_000, interval: 25 },
    );
    const said = warnings.mock.calls.flat().join("\n");
    warnings.mockRestore();
    expect(said).not.toContain("Git LFS isn't installed");
    // What stopped the thread is the chat itself (no sidecar in this test), past the bind.
    expect(said).toMatch(/couldn't start chat/);
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
      LARGE_FILES_COMMITTED_WITHOUT_LFS_NOTE,
    ]);
    // The FRONT DOOR created the checkout, so the front door registered it: the bind found
    // it already there and kept the mode it was created with.
    const store = new SessionStore(join(fixture.dataDir, "sessions"));
    const boundRoot = store.load(sessionId)?.boundRoot ?? "";
    expect(registered(fixture.dataDir)).toEqual([gitDirOf(boundRoot)]);
    await server.dispatch("session.cancelPreparation", { sessionId });
  }, 60_000);
});

/**
 * Skip mode is the mode a checkout was CREATED under, recorded only for a checkout Rennet
 * placed (review finding 1). The index every daemon child's git reads must never name the
 * reviewer's own checkout, must follow a re-pin that replaces a checkout, must not be
 * rewritten for a checkout that is merely reused, and must lose a removed checkout.
 */
describe("skip-mode registration follows the checkout Rennet created", () => {
  /**
   * Make the next use of the binding REPLACE the snapshot: move the checkout off the reviewed
   * head, the way a round's agent committing in the detached checkout does, then use the
   * binding. The re-pin puts Rennet's own snapshot back at the reviewed head by removing it
   * and checking it out again at the same path, which git registers under the same git dir.
   */
  async function moveOffHeadAndRepin(
    fixture: Pick<ReturnType<typeof lfsRepository>, "baseOid" | "headOid">,
    server: Awaited<ReturnType<typeof serverFor>>["server"],
    reviewId: string,
    boundRoot: string,
    options: { readonly realLfs?: boolean } = {},
  ) {
    // With the real Git LFS, the checkout's own filter runs: blanking it would make a
    // downloaded file read as modified, and git would refuse to move.
    const blank = [
      "-c",
      "filter.lfs.process=",
      "-c",
      "filter.lfs.smudge=",
      "-c",
      "filter.lfs.required=false",
    ];
    execFileSync(
      "git",
      [...(options.realLfs === true ? [] : blank), "checkout", "-q", "--detach", fixture.baseOid],
      { cwd: boundRoot },
    );
    // Any use of the binding re-pins it; the transcript read is the cheapest.
    await server.dispatch("session.transcript", { reviewId });
    expect(
      execFileSync("git", ["rev-parse", "HEAD"], { cwd: boundRoot, encoding: "utf8" }).trim(),
    ).toBe(fixture.headOid);
  }

  it("a share-mode branch review of the reviewer's own checkout never registers it", async () => {
    const fixture = lfsRepository({ rootOn: "feature" });
    const { mint, waitFor, setMode, server } = await serverFor(fixture);
    await setMode("skip");
    const sessionId = await mint({ pr: false });
    await waitFor(sessionId, (session) => expect(session?.preparation?.status).toBe("drafting"));
    const store = new SessionStore(join(fixture.dataDir, "sessions"));
    // `share` bound the session to the checkout the reviewer has the branch out in…
    expect(store.load(sessionId)?.boundRoot).toBe(fixture.repo);
    // …which Rennet did not place, so its git config is exactly the reviewer's.
    expect(registered(fixture.dataDir)).toEqual([]);
    expect(lfsRequiredUnderDaemonEnv(fixture.dataDir, fixture.repo)).toBe("true");
    await server.dispatch("session.cancelPreparation", { sessionId });
  }, 60_000);

  it("download, then skip, then a re-pin replaces the checkout: the new checkout is skip mode", async () => {
    const fixture = lfsRepository();
    fixture.installGitLfs();
    const { server, mint, waitFor, setMode } = await serverFor(fixture);
    await setMode("download");
    const sessionId = await mint();
    const drafting = await waitFor(sessionId, (session) =>
      expect(session?.preparation?.status).toBe("drafting"),
    );
    const store = new SessionStore(join(fixture.dataDir, "sessions"));
    const boundRoot = store.load(sessionId)?.boundRoot ?? "";
    expect(registered(fixture.dataDir)).toEqual([]);

    await setMode("skip");
    await moveOffHeadAndRepin(fixture, server, drafting.reviewId ?? "", boundRoot);
    // The re-pin REPLACED the checkout at the same path, under the mode now set…
    expect(readFileSync(join(boundRoot, "assets", "model.bin"), "utf8")).toBe(POINTER);
    expect(registered(fixture.dataDir)).toEqual([gitDirOf(boundRoot)]);
    // …so a later git command there runs as skip mode, whatever the repository's config says.
    fixture.git("config", "filter.lfs.required", "true");
    expect(lfsRequiredUnderDaemonEnv(fixture.dataDir, boundRoot)).toBe("false");
    await server.dispatch("session.cancelPreparation", { sessionId });
  }, 60_000);

  it("skip, then download, then a re-pin replaces the checkout: the new checkout loses skip mode", async () => {
    const fixture = lfsRepository();
    const { server, mint, waitFor, setMode } = await serverFor(fixture);
    await setMode("skip");
    const sessionId = await mint();
    const drafting = await waitFor(sessionId, (session) =>
      expect(session?.preparation?.status).toBe("drafting"),
    );
    const store = new SessionStore(join(fixture.dataDir, "sessions"));
    const boundRoot = store.load(sessionId)?.boundRoot ?? "";
    expect(registered(fixture.dataDir)).toEqual([gitDirOf(boundRoot)]);

    // Download needs a filter that runs.
    fixture.installGitLfs();
    await setMode("download");
    await moveOffHeadAndRepin(fixture, server, drafting.reviewId ?? "", boundRoot);
    expect(registered(fixture.dataDir)).toEqual([]);
    fixture.git("config", "filter.lfs.required", "true");
    expect(lfsRequiredUnderDaemonEnv(fixture.dataDir, boundRoot)).toBe("true");
    await server.dispatch("session.cancelPreparation", { sessionId });
  }, 60_000);

  it.skipIf(realGitLfs === "")(
    "skip, then download, under real Git LFS and the daemon's environment: the replacement downloads the large file",
    async () => {
      const fixture = realLfsRepository();
      const { server, mint, waitFor, setMode } = await serverFor(fixture, { lfsInstalled: true });
      await setMode("skip");
      const sessionId = await mint();
      const drafting = await waitFor(sessionId, (session) =>
        expect(session?.preparation?.status).toBe("drafting"),
      );
      const store = new SessionStore(join(fixture.dataDir, "sessions"));
      const boundRoot = store.load(sessionId)?.boundRoot ?? "";
      const model = join(boundRoot, "assets", "model.bin");
      expect(readFileSync(model, "utf8")).toMatch(/^version https:\/\/git-lfs\.github\.com/);
      expect(registered(fixture.dataDir)).toEqual([gitDirOf(boundRoot)]);

      await setMode("download");
      await moveOffHeadAndRepin(fixture, server, drafting.reviewId ?? "", boundRoot, {
        realLfs: true,
      });
      // The replacement got the SAME git dir. Had its skip-mode entry still been in the index
      // while git checked the files out, every daemon child's git — the checkout's own
      // included — would have run LFS's skip filter, and this would be the pointer again.
      expect(readFileSync(model, "utf8")).toBe(LARGE);
      expect(registered(fixture.dataDir)).toEqual([]);
      await server.dispatch("session.cancelPreparation", { sessionId });
    },
    60_000,
  );

  it.skipIf(realGitLfs === "")(
    "download, then skip, under real Git LFS: the replacement is skip mode from its first command",
    async () => {
      const fixture = realLfsRepository();
      // What the checkout's own later commands see: a hook that drops git's per-call `-c`
      // config (which its parent's skip flags would hand it) and reads the filter the way an
      // agent's shell in the checkout would — through the daemon's environment.
      const seen = join(fixture.dataDir, "post-checkout.log");
      const hooks = join(fixture.repo, ".git", "hooks");
      mkdirSync(hooks, { recursive: true });
      writeFileSync(
        join(hooks, "post-checkout"),
        `#!/bin/sh\nenv -u GIT_CONFIG_PARAMETERS git config --get filter.lfs.process >> '${seen}'\n`,
        { mode: 0o755 },
      );
      const { server, mint, waitFor, setMode } = await serverFor(fixture, { lfsInstalled: true });
      await setMode("download");
      const sessionId = await mint();
      const drafting = await waitFor(sessionId, (session) =>
        expect(session?.preparation?.status).toBe("drafting"),
      );
      const store = new SessionStore(join(fixture.dataDir, "sessions"));
      const boundRoot = store.load(sessionId)?.boundRoot ?? "";
      const model = join(boundRoot, "assets", "model.bin");
      expect(readFileSync(model, "utf8")).toBe(LARGE);
      expect(registered(fixture.dataDir)).toEqual([]);

      await setMode("skip");
      await moveOffHeadAndRepin(fixture, server, drafting.reviewId ?? "", boundRoot, {
        realLfs: true,
      });
      expect(readFileSync(model, "utf8")).toMatch(/^version https:\/\/git-lfs\.github\.com/);
      expect(registered(fixture.dataDir)).toEqual([gitDirOf(boundRoot)]);
      // The replacement's own post-checkout hook already ran as skip mode: the checkout was
      // registered BEFORE git checked it out, not after.
      const lines = readFileSync(seen, "utf8").trim().split("\n");
      expect(lines.at(-1)).toBe("git-lfs filter-process --skip");
      await server.dispatch("session.cancelPreparation", { sessionId });
    },
    60_000,
  );

  it("a later session that reuses the checkout keeps the mode it was created with", async () => {
    const fixture = lfsRepository();
    const { server, mint, waitFor, setMode } = await serverFor(fixture);
    await setMode("skip");
    const first = await mint();
    await waitFor(first, (session) => expect(session?.preparation?.status).toBe("drafting"));
    const store = new SessionStore(join(fixture.dataDir, "sessions"));
    const boundRoot = store.load(first)?.boundRoot ?? "";
    expect(registered(fixture.dataDir)).toEqual([gitDirOf(boundRoot)]);

    // The project's mode changes, and a second session of the same pull request binds to the
    // SAME checkout, which already holds the reviewed head: nothing is checked out again.
    fixture.installGitLfs();
    await setMode("download");
    await server.dispatch("session.cancelPreparation", { sessionId: first });
    await server.dispatch("session.archive", { sessionId: first, archived: true });
    const second = await mint();
    expect(second).not.toBe(first);
    await waitFor(second, (session) => expect(session?.preparation?.status).toBe("drafting"));
    expect(store.load(second)?.boundRoot).toBe(boundRoot);
    // The checkout's files are still placeholders, so it stays skip mode: the setting
    // applies to the NEXT checkout.
    expect(readFileSync(join(boundRoot, "assets", "model.bin"), "utf8")).toBe(POINTER);
    expect(registered(fixture.dataDir)).toEqual([gitDirOf(boundRoot)]);
    await server.dispatch("session.cancelPreparation", { sessionId: second });
  }, 60_000);

  it("removing the checkout drops its entry, so a worktree added there later is not skip mode", async () => {
    const fixture = lfsRepository();
    const { server, projectId, mint, waitFor, setMode } = await serverFor(fixture);
    await setMode("skip");
    const sessionId = await mint();
    await waitFor(sessionId, (session) => expect(session?.preparation?.status).toBe("drafting"));
    const store = new SessionStore(join(fixture.dataDir, "sessions"));
    const boundRoot = store.load(sessionId)?.boundRoot ?? "";
    const gitDir = gitDirOf(boundRoot);
    expect(registered(fixture.dataDir)).toEqual([gitDir]);
    await server.dispatch("session.cancelPreparation", { sessionId });

    // `git worktree remove` asks git status there, which runs the filter: give it one that
    // runs (the in-process server's own git does not carry the daemon's index include).
    fixture.installGitLfs();
    const removed = (await server.dispatch("project.cleanupWorktree", {
      commandId: randomUUID(),
      projectId,
      worktreeId: boundRoot,
    })) as { ok: boolean };
    expect(removed.ok).toBe(true);
    expect(registered(fixture.dataDir)).toEqual([]);
    // git hands the same name to the next worktree added at that path, and that one is the
    // reviewer's: it runs the filter exactly as their config says.
    fixture.git("worktree", "add", "-q", "--detach", boundRoot, "main");
    expect(gitDirOf(boundRoot)).toBe(gitDir);
    fixture.git("config", "filter.lfs.required", "true");
    expect(lfsRequiredUnderDaemonEnv(fixture.dataDir, boundRoot)).toBe("true");
  }, 60_000);
});

describe("Install for me while a skip-mode checkout runs without Git LFS", () => {
  it.skipIf(process.platform === "win32")(
    "rewrites the overrides to Git LFS's own skip filter and drops the session's note",
    async () => {
      const fixture = lfsRepository();
      const brewBin = realpathSync(mkdtempSync(join(tmpdir(), "rennet-lfs-prep-brew-")));
      dirs.push(brewBin);
      for (const [name, body] of [
        ["brew", 'touch "$(dirname "$0")/installed"'],
        ["git", "exit 0"],
      ] as const) {
        writeFileSync(join(brewBin, name), `#!/bin/sh\n${body}\n`);
        chmodSync(join(brewBin, name), 0o755);
      }
      const { server, mint, waitFor, setMode } = await serverFor(fixture, { brewBin });
      await setMode("skip");
      const sessionId = await mint();
      const drafting = await waitFor(sessionId, (session) =>
        expect(session?.preparation?.status).toBe("drafting"),
      );
      // Without Git LFS, skip mode blanks the filter, and the session says what that costs.
      expect(drafting.workspaceNotes).toEqual([LARGE_FILES_COMMITTED_WITHOUT_LFS_NOTE]);
      const overrides = join(
        dirname(largeFileSkipIndexPath(fixture.dataDir)),
        "skip-overrides.gitconfig",
      );
      expect(readFileSync(overrides, "utf8")).toContain("\tprocess =\n");

      const { result } = (await server.dispatch("tools.install", {
        tool: "git-lfs",
        locus: { kind: "host" },
        commandId: randomUUID(),
      })) as { result: { status: string } };
      expect(result.status).toBe("installed");
      // Every registered checkout now cleans large files on add again…
      expect(readFileSync(overrides, "utf8")).toContain(
        "\tprocess = git-lfs filter-process --skip\n",
      );
      // …and the note that said otherwise is gone.
      const after = await waitFor(sessionId, (session) =>
        expect(session?.workspaceNotes).toBeUndefined(),
      );
      expect(after.preparation?.status).toBe("drafting");
      await server.dispatch("session.cancelPreparation", { sessionId });
    },
    60_000,
  );
});

/**
 * Cancelling and answering around the workspace stage (review finding 8): a cancel records
 * the stage that was actually cancelled, and two answers in quick succession run ONE
 * preparation, neither waiting on the other's drafting nor overwriting it.
 */
describe("cancel and answer around the workspace stage", () => {
  it("cancelling while the question is open records the workspace stage", async () => {
    const fixture = lfsRepository();
    const { server, mint, waitFor } = await serverFor(fixture);
    const sessionId = await mint();
    const asked = await waitFor(sessionId, (session) =>
      expect(session?.preparation?.status).toBe("awaiting"),
    );
    const cancelled = (await server.dispatch("session.cancelPreparation", { sessionId })) as {
      session: Session | null;
    };
    expect(cancelled.session?.preparation).toEqual({
      status: "cancelled",
      stage: "workspace",
      reviewId: asked.reviewId,
    });
  }, 60_000);

  it("cancelling while the checkout is being created records the workspace stage", async () => {
    const fixture = lfsRepository();
    // A filter that runs, slowly: the checkout the answer starts takes a few seconds.
    fixture.git("config", "--unset", "filter.lfs.process");
    fixture.git("config", "filter.lfs.smudge", "sleep 3; cat");
    const { server, mint, waitFor } = await serverFor(fixture);
    const sessionId = await mint();
    const asked = await waitFor(sessionId, (session) =>
      expect(session?.preparation?.status).toBe("awaiting"),
    );
    // The answer resumes preparation, which binds — creating the checkout under the filter.
    await server.dispatch("session.chooseLargeFileMode", { sessionId, mode: "download" });
    const worktreeAdded = () =>
      fixture
        .git("worktree", "list", "--porcelain")
        .split("\n")
        .filter((line) => line.startsWith("worktree ")).length > 1;
    await vi.waitFor(() => expect(worktreeAdded()).toBe(true), { timeout: 20_000, interval: 25 });
    const cancelled = (await server.dispatch("session.cancelPreparation", { sessionId })) as {
      session: Session | null;
    };
    expect(cancelled.session?.preparation).toEqual({
      status: "cancelled",
      stage: "workspace",
      reviewId: asked.reviewId,
    });
    // The cancelled run winds down when its checkout finishes, and leaves the record alone.
    await new Promise((resolve) => setTimeout(resolve, 4_000));
    const after = await waitFor(sessionId, (session) =>
      expect(session?.preparation?.status).toBe("cancelled"),
    );
    expect(after.preparation).toEqual(cancelled.session?.preparation);
  }, 60_000);

  it("two quick answers run one preparation, and neither waits on its drafting", async () => {
    const fixture = lfsRepository();
    const { server, mint, waitFor } = await serverFor(fixture);
    const sessionId = await mint();
    await waitFor(sessionId, (session) => expect(session?.preparation?.status).toBe("awaiting"));
    const answer = () =>
      server.dispatch("session.chooseLargeFileMode", {
        sessionId,
        mode: "skip",
      }) as Promise<{ session: Session | null }>;
    // Drafting is held for a minute (the fixture's board delay). Both answers must come back
    // long before that: the second one sees the first one's run and leaves it alone.
    const both = await Promise.race([
      Promise.all([answer(), answer()]),
      new Promise<"stuck">((resolve) => setTimeout(() => resolve("stuck"), 15_000)),
    ]);
    expect(both).not.toBe("stuck");
    // One run, bound once: the checkout the answer created, and drafting held after it.
    const store = new SessionStore(join(fixture.dataDir, "sessions"));
    await vi.waitFor(() => expect(store.load(sessionId)?.boundRoot).toBeDefined(), {
      timeout: 20_000,
      interval: 25,
    });
    const drafting = await waitFor(sessionId, (session) =>
      expect(session?.preparation?.status).toBe("drafting"),
    );
    expect(drafting.preparation?.status).toBe("drafting");
    await server.dispatch("session.cancelPreparation", { sessionId });
  }, 60_000);
});

/**
 * A session can be told its own large-file mode, leaving its project's choice alone — the
 * headless `rennet review --large-files`, or an answer given with `remember: false`.
 */
describe("a session's own large-file mode", () => {
  const projectChoice = async (server: Awaited<ReturnType<typeof serverFor>>["server"]) => {
    const view = (await server.dispatch("settings.get", {})) as {
      projects: { prefs?: { largeFiles?: { value: string; layer: string } } }[];
    };
    return view.projects[0]?.prefs?.largeFiles;
  };

  it("a mint told to skip never asks, checks out placeholders, and records nothing on the project", async () => {
    const fixture = lfsRepository();
    const { server, mint, waitFor } = await serverFor(fixture);
    const sessionId = await mint({ largeFiles: "skip" });
    const store = new SessionStore(join(fixture.dataDir, "sessions"));
    await vi.waitFor(() => expect(store.load(sessionId)?.boundRoot).toBeDefined(), {
      timeout: 20_000,
      interval: 25,
    });
    const drafting = await waitFor(sessionId, (session) =>
      expect(session?.preparation?.status).toBe("drafting"),
    );
    expect(drafting.preparation?.status).toBe("drafting");
    const boundRoot = store.load(sessionId)?.boundRoot ?? "";
    // Skipped, though the project never chose and Git LFS is "missing".
    expect(readFileSync(join(boundRoot, "assets", "model.bin"), "utf8")).toBe(POINTER);
    expect(registered(fixture.dataDir)).toEqual([gitDirOf(boundRoot)]);
    expect(await projectChoice(server)).toEqual({ value: "ask", layer: "builtin" });
    await server.dispatch("session.cancelPreparation", { sessionId });
  }, 60_000);

  it("an answer not remembered binds this session under it, and the project still asks", async () => {
    const fixture = lfsRepository();
    const { server, mint, waitFor } = await serverFor(fixture);
    const sessionId = await mint();
    await waitFor(sessionId, (session) => expect(session?.preparation?.status).toBe("awaiting"));
    await server.dispatch("session.chooseLargeFileMode", {
      sessionId,
      mode: "skip",
      remember: false,
    });
    const store = new SessionStore(join(fixture.dataDir, "sessions"));
    await vi.waitFor(() => expect(store.load(sessionId)?.boundRoot).toBeDefined(), {
      timeout: 20_000,
      interval: 25,
    });
    const boundRoot = store.load(sessionId)?.boundRoot ?? "";
    expect(readFileSync(join(boundRoot, "assets", "model.bin"), "utf8")).toBe(POINTER);
    expect(store.load(sessionId)?.largeFiles).toBe("skip");
    expect(await projectChoice(server)).toEqual({ value: "ask", layer: "builtin" });
    await server.dispatch("session.cancelPreparation", { sessionId });
  }, 60_000);
});

/** The large-file-checkout spec's own scenarios, end to end through the daemon (finding 11). */
describe("large-file-checkout scenarios", () => {
  it("a repository without LFS never asks: the checkout proceeds", async () => {
    const fixture = lfsRepository({ lfs: false });
    const { server, mint, waitFor } = await serverFor(fixture);
    const statuses = new Set<string>();
    const sessionId = await mint();
    const store = new SessionStore(join(fixture.dataDir, "sessions"));
    await vi.waitFor(
      async () => {
        const session = await waitFor(sessionId, () => undefined);
        if (session.preparation !== undefined) statuses.add(session.preparation.status);
        expect(store.load(sessionId)?.boundRoot).toBeDefined();
      },
      { timeout: 20_000, interval: 10 },
    );
    const drafting = await waitFor(sessionId, (session) =>
      expect(session?.preparation?.status).toBe("drafting"),
    );
    expect(drafting.preparation?.status).toBe("drafting");
    expect(statuses.has("awaiting")).toBe(false);
    expect(store.load(sessionId)?.boundRoot).not.toBe(fixture.repo);
    await server.dispatch("session.cancelPreparation", { sessionId });
  }, 60_000);

  it("a daemon restart while the question is open keeps it open, and the answer resumes it", async () => {
    const fixture = lfsRepository();
    const first = await serverFor(fixture);
    const sessionId = await first.mint();
    const asked = await first.waitFor(sessionId, (session) =>
      expect(session?.preparation?.status).toBe("awaiting"),
    );
    await first.server.shutdown();

    // A new daemon over the same data: the question survives, as asked.
    const second = await serverFor(fixture, { projectId: first.projectId });
    const after = await second.waitFor(sessionId, (session) =>
      expect(session?.preparation?.status).toBe("awaiting"),
    );
    expect(after.preparation).toEqual(asked.preparation);
    await second.server.dispatch("session.chooseLargeFileMode", { sessionId, mode: "skip" });
    const store = new SessionStore(join(fixture.dataDir, "sessions"));
    await vi.waitFor(() => expect(store.load(sessionId)?.boundRoot).toBeDefined(), {
      timeout: 20_000,
      interval: 25,
    });
    const boundRoot = store.load(sessionId)?.boundRoot ?? "";
    expect(readFileSync(join(boundRoot, "assets", "model.bin"), "utf8")).toBe(POINTER);
    await second.waitFor(sessionId, (session) =>
      expect(session?.preparation).toMatchObject({ status: "drafting", reviewId: asked.reviewId }),
    );
    await second.server.dispatch("session.cancelPreparation", { sessionId });
  }, 60_000);

  it("an answer while preparation is running is recorded and does not restart it", async () => {
    const fixture = lfsRepository();
    // Download works here (a filter that runs), and preparation is held after its capture.
    fixture.installGitLfs();
    const { server, mint, waitFor, setMode } = await serverFor(fixture, {
      env: { RENNET_TEST_CAPTURE_SETTLEMENT_DELAY_MS: "60000" },
    });
    await setMode("download");
    const sessionId = await mint();
    const running = await waitFor(sessionId, (session) =>
      expect(session?.preparation).toEqual({ status: "capturing", step: "capturing-change" }),
    );
    const answered = (await server.dispatch("session.chooseLargeFileMode", {
      sessionId,
      mode: "skip",
    })) as { session: Session | null };
    // Not resumed: a restart would begin again from resolving the repository.
    expect(answered.session?.preparation).toEqual(running.preparation);
    const view = (await server.dispatch("settings.get", {})) as {
      projects: { prefs?: { largeFiles?: { value: string } } }[];
    };
    expect(view.projects[0]?.prefs?.largeFiles?.value).toBe("skip");
    const still = await waitFor(sessionId, (session) =>
      expect(session?.preparation?.status).toBe("capturing"),
    );
    expect(still.preparation).toEqual({ status: "capturing", step: "capturing-change" });
    await server.dispatch("session.cancelPreparation", { sessionId });
  }, 60_000);

  it("choosing a mode is the recovery a large-file failure offers, and it binds", async () => {
    const fixture = lfsRepository();
    // Git LFS answers, but cannot produce the file: a required filter whose process is set
    // blank fails the smudge, which git reports as `smudge filter lfs failed`.
    fixture.git("config", "filter.lfs.process", "");
    fixture.git("config", "filter.lfs.smudge", "cat");
    const { server, mint, waitFor, setMode } = await serverFor(fixture);
    await setMode("download");
    const sessionId = await mint();
    const failed = await waitFor(sessionId, (session) =>
      expect(session?.preparation?.status).toBe("failed"),
    );
    expect(failed.preparation).toMatchObject({
      status: "failed",
      stage: "workspace",
      kind: "large-file",
      action: "choose-large-files",
    });

    await server.dispatch("session.chooseLargeFileMode", { sessionId, mode: "skip" });
    const store = new SessionStore(join(fixture.dataDir, "sessions"));
    await vi.waitFor(() => expect(store.load(sessionId)?.boundRoot).toBeDefined(), {
      timeout: 20_000,
      interval: 25,
    });
    const boundRoot = store.load(sessionId)?.boundRoot ?? "";
    expect(readFileSync(join(boundRoot, "assets", "model.bin"), "utf8")).toBe(POINTER);
    expect(registered(fixture.dataDir)).toEqual([gitDirOf(boundRoot)]);
    await waitFor(sessionId, (session) =>
      expect(session?.preparation).toMatchObject({ status: "drafting", reviewId: failed.reviewId }),
    );
    await server.dispatch("session.cancelPreparation", { sessionId });
  }, 60_000);
});
