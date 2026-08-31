import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import {
  type ElectronApplication,
  _electron as electron,
  expect,
  type Page,
} from "@playwright/test";
import { WsRennetBridge } from "@rennet/client";

const require = createRequire(import.meta.url);
const electronExecutable = require("electron") as string;

/**
 * A throwaway bin dir exposing ONLY `node` (a symlink to this process's real node
 * binary — `process.execPath`, not a version-manager shim), so the launched app can
 * still spawn its node subprocesses while the model binaries that live ALONGSIDE
 * node in a version-manager's shim dir (e.g. `~/.asdf/shims/codex`) stay hidden.
 * Created once and reused; it lives under the OS temp root.
 */
let nodeBinDirCache: string | undefined;
function nodeOnlyBinDir(): string {
  if (nodeBinDirCache) return nodeBinDirCache;
  const dir = mkdtempSync(join(tmpdir(), "rennet-e2e-node-"));
  symlinkSync(process.execPath, join(dir, "node"));
  nodeBinDirCache = dir;
  return dir;
}

/** Run a git verb in `root`, inheriting the caller's environment. Output is discarded. */
export function git(root: string, ...arguments_: string[]): void {
  execFileSync("git", arguments_, { cwd: root, stdio: "ignore" });
}

/** Make a fresh temp directory under the OS temp root with the given prefix. */
export function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Write a repo-relative file, creating any parent directories first. */
export function writeRepoFile(root: string, relativePath: string, contents: string): void {
  const target = join(root, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

/** Initialise a git repo on `main` with a deterministic committer identity. */
export function initRepo(root: string): void {
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "rennet@example.test");
  git(root, "config", "user.name", "Rennet Test");
  // Isolate the fixture from the developer's GLOBAL gitignore (e.g. a machine that
  // ignores `openspec/`), so `git add` and the app's `--exclude-standard` capture
  // behave identically everywhere.
  git(root, "config", "core.excludesFile", "/dev/null");
}

/**
 * The first PATH directory that actually holds an executable `git`, so the
 * neutralised environment below can keep git working while dropping the
 * user-profile directories that harness discovery probes for `claude`/`codex`.
 */
function resolveGitDir(): string {
  if (existsSync("/usr/bin/git")) return "/usr/bin";
  for (const entry of (process.env.PATH ?? "").split(delimiter)) {
    if (entry.length > 0 && existsSync(join(entry, "git"))) return entry;
  }
  return "/usr/bin";
}

/**
 * A best-effort MODEL-FREE environment for the launched app.
 *
 * Rennet's whole job is to run a model, so opening the Canvases surface fires the
 * real review pipeline whenever a `claude`/`codex` binary is discoverable. For a
 * deterministic, zero-spend e2e we bias discovery toward finding NOTHING — so the
 * app renders its deterministic mechanical outline instead of a live model turn:
 *   • HOME → a throwaway dir, so the HOME-relative known locations
 *     (`~/.local/bin`, `~/.claude/local`, `~/.bun/bin`, …) and the login-shell rc
 *     (which is where a user PATH picks those up) resolve to nothing.
 *   • SHELL → `/usr/bin/true`, so the login-shell PATH harvest returns empty.
 *   • PATH → a node-only bin dir + git's dir + the system dirs only, dropping the
 *     user-profile entries a `claude`/`codex` install lives on (while still giving
 *     the app the `node` it needs to spawn its own subprocesses).
 *
 * Hermeticity is guaranteed by RENNET_DISABLE_HARNESS=1 (the test-only discovery
 * hook, #386) — the env surgery above is defence in depth, and the specs still
 * assert MODEL-AGNOSTIC structure (the surfaces render, navigation wires up, the
 * model-free OpenSpec parse), never model output.
 */
export function modelFreeEnv(homeDir: string): NodeJS.ProcessEnv {
  const systemPath = [
    nodeOnlyBinDir(),
    resolveGitDir(),
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ].join(delimiter);
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: homeDir,
    SHELL: "/usr/bin/true",
    PATH: systemPath,
    // The decisive switch (#386): discovery also probes ABSOLUTE locations
    // (/opt/homebrew/bin, /usr/local/bin) that the env surgery above cannot
    // scrub — on a machine with a brew-installed model binary the app would
    // fire a REAL, timeoutless model turn against this unauthenticated HOME
    // and the canvases would never load. The hook forces the deterministic
    // floor everywhere; the env surgery stays as defence in depth.
    RENNET_DISABLE_HARNESS: "1",
  };
  // Inherited ELECTRON_RUN_AS_NODE=1 turns EVERY Electron launch into a bare Node
  // run, so Playwright's `--remote-debugging-port=0` hits Node's option parser and
  // the launch dies with `Electron: bad option: --remote-debugging-port=0` before a
  // line of app code runs (#569). Any shell whose parent is itself an Electron app
  // — a coding agent's terminal, VS Code's — exports it. Rennet's own daemon spawn
  // sets it explicitly (`supervise.ts`), so dropping it here costs nothing.
  delete environment.ELECTRON_RUN_AS_NODE;
  return environment;
}

/**
 * Settle the first-run welcome through the app's OWN command, then reload onto the shell.
 *
 * C21 put the welcome wizard in front of a first run and, deliberately, UNMOUNTED the shell
 * beneath it (`routes/app.tsx`: a hidden-but-mounted underlay still registers coach anchors,
 * and a coachmark portals to `document.body` over the wizard). So on a throwaway data dir with
 * no projects there is no sidebar, no corner slot and no front door until the welcome is done —
 * which is why every journey spec below opens with this call.
 *
 * It is `settings.completeWelcome`, the same command the wizard's own Ready step runs, invoked
 * over the app's own WS bridge — not a seeded config file, so the specs never encode the
 * settings serialization. The wizard ITSELF is driven, not skipped, by `first-run-welcome.spec.ts`;
 * this is the other specs' way past a surface that is not their subject.
 *
 * `wsPort` is for the browser shell, whose tab has no `window.rennet` — the spec already knows
 * the served daemon's port. Electron omits it and the preload bridge answers.
 */
export async function completeWelcome(page: Page, wsPort?: number): Promise<void> {
  const port =
    wsPort ??
    (await page.evaluate(
      () => (window as unknown as { rennet: { wsPort: number } }).rennet.wsPort,
    ));
  const bridge = new WsRennetBridge({ url: `ws://127.0.0.1:${port}`, autoReconnect: false });
  try {
    await bridge.invoke("settings.completeWelcome", {});
  } finally {
    bridge.close();
  }
  await page.reload();
}

/**
 * The real add-a-project journey, ending on the indexing screen.
 *
 * The dialog has no kind picker and no confirm step any more (C12 §10.1): a source, the in-app
 * directory browser's path bar, and one `Add`. Typing the fixture path and pressing Enter is how
 * a user navigates the browser there; the breadcrumb button carrying the repo's own directory
 * name is the proof the browser actually resolved it.
 */
export async function addProject(page: Page, repository: string): Promise<void> {
  await page.getByRole("button", { name: "Add Project" }).first().click();
  const pathBar = page.getByRole("textbox", { name: "Directory path" });
  await pathBar.fill(repository);
  await pathBar.press("Enter");
  await expect(page.getByRole("button", { name: basename(repository), exact: true })).toBeVisible();
  const add = page.getByRole("button", { name: "Add", exact: true });
  await expect(add).toBeEnabled();
  await add.click();
  await expect(page.locator('[data-screen="project-indexing"]')).toBeVisible({ timeout: 60_000 });
}

/**
 * From the indexing screen to a review of the project's WORKING TREE: "Start a Review" opens
 * New Chat, and the pinned Current Checkout row mints a session and captures the tree into it.
 *
 * This replaced the direct repo/PR door the older specs used ("Review directly" → "Choose a
 * repository"): that pair only ever existed in `command/commands.ts`, which the shipping palette
 * (`shell/command-menu-entries.ts`) does not read, so the door is unreachable. New Chat is the
 * front door now.
 */
export async function openWorkingTreeReview(page: Page): Promise<void> {
  const startReview = page.getByRole("button", { name: "Start a Review" });
  await expect(startReview).toBeVisible({ timeout: 180_000 });
  await startReview.click();
  await expect(page.locator('[data-screen="new-chat"]')).toBeVisible();
  await page
    .locator('[data-row="target"]', { hasText: /Current Checkout/ })
    .first()
    .click();
  // The board itself is the landmark. It was the `REVIEW · <repo>` eyebrow, which the board
  // no longer carries — the board opens on the board.
  await expect(page.locator('[data-kind="lens-board-view"]')).toBeVisible({ timeout: 180_000 });
}

/** The review workspace's Diff view — the raw patchset, behind the top bar's session-view pill. */
export async function openDiffView(page: Page): Promise<void> {
  await page
    .locator('[data-slot="toggle-group"]')
    .getByRole("button", { name: "Diff", exact: true })
    .click();
  await expect(page.getByText(/files changed$/)).toBeVisible({ timeout: 30_000 });
}

export interface LaunchedRennet {
  application: ElectronApplication;
}

/**
 * Launch the desktop app under Playwright's Electron driver, pointed at `repository`
 * (the `RENNET_TEST_REPO` the repository picker returns) with an isolated app-data
 * dir and the model-free environment above. Mirrors the launch the original
 * `local-review` spec established.
 */
export async function launchRennet(options: {
  repository: string;
  userData: string;
  home: string;
  /**
   * The default harness launches the detached daemon and therefore owns stopping it.
   * A spec that has already claimed `daemon.json` with an injected in-process server
   * keeps ownership itself; signalling that claim's pid would terminate Playwright.
   */
  ownsDaemon?: boolean;
  /**
   * Override the model-free environment. The deterministic specs take the default;
   * the LIVE spec (F1 6.2) needs the reviewer's real `claude` on PATH and their real
   * HOME, because the whole point of it is to drive an actual harness turn.
   */
  env?: NodeJS.ProcessEnv;
}): Promise<LaunchedRennet> {
  const application = await electron.launch({
    executablePath: electronExecutable,
    args: [resolve("apps/desktop")],
    env: {
      ...(options.env ?? modelFreeEnv(options.home)),
      RENNET_TEST_REPO: options.repository,
      RENNET_USER_DATA: options.userData,
    },
  });
  // Daemon teardown (#379, design D9): the server is now a DETACHED daemon that SURVIVES
  // app quit — the whole feature. So closing the window no longer stops it, and each test's
  // isolated daemon would orphan under its throwaway data dir. Wrap `close` (harness-only;
  // the specs stay untouched) so every `application.close()` also stops the daemon it
  // spawned, before the spec removes the data dir.
  if (options.ownsDaemon !== false) {
    const nativeClose = application.close.bind(application);
    application.close = async (...args: Parameters<ElectronApplication["close"]>) => {
      const result = await nativeClose(...args);
      await stopDaemon(options.userData);
      return result;
    };
  }
  return { application };
}

/** Read the test's daemon.json, SIGTERM its pid, and wait (bounded) for the claim to clear. */
async function stopDaemon(userData: string): Promise<void> {
  const claimPath = join(userData, "daemon.json");
  let pid: number | undefined;
  try {
    pid = JSON.parse(readFileSync(claimPath, "utf8")).pid;
  } catch {
    return; // no daemon (or already gone) — nothing to stop.
  }
  if (typeof pid !== "number") return;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return; // already dead
  }
  const deadline = Date.now() + 3_000;
  while (existsSync(claimPath) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
}

/**
 * Seed a git repo whose WORKING TREE has a reviewable change: `main` holds the base
 * file, a second branch exists so project-detail lists at least one local row, and
 * the checked-out feature branch carries an uncommitted edit (the capture diff).
 * Returns the repo path. Mirrors the shape the original local-review spec proved.
 */
export function seedReviewRepo(prefix: string): string {
  const repository = makeTempDir(prefix);
  initRepo(repository);
  writeRepoFile(repository, "src/widget.ts", "export const widget = 1;\n");
  git(repository, "add", "src/widget.ts");
  git(repository, "commit", "-qm", "initial");
  // A second branch so project-detail's smart list has a non-primary local row.
  git(repository, "branch", "other-work");
  git(repository, "checkout", "-qb", "feature/widget");
  // An uncommitted edit is the working-tree change the review captures.
  writeRepoFile(repository, "src/widget.ts", "export const widget = 2;\n");
  return repository;
}
