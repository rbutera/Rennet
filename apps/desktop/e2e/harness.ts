import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { type ElectronApplication, _electron as electron } from "@playwright/test";

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
 * This is NOT fully hermetic: harness discovery also probes the ABSOLUTE
 * `/opt/homebrew/bin` and `/usr/local/bin`, so a brew-installed model binary is
 * still found. The specs therefore assert MODEL-AGNOSTIC structure (the surfaces
 * render, navigation wires up, the model-free OpenSpec parse), never model output —
 * so they are correct whether the floor or a live turn produced the canvases. A
 * fully hermetic canvas e2e wants a test-only harness-disable hook in main (a
 * documented follow-up), not more environment surgery here.
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
  return {
    ...process.env,
    HOME: homeDir,
    SHELL: "/usr/bin/true",
    PATH: systemPath,
  };
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
}): Promise<LaunchedRennet> {
  const application = await electron.launch({
    executablePath: electronExecutable,
    args: [resolve("apps/desktop")],
    env: {
      ...modelFreeEnv(options.home),
      RENNET_TEST_REPO: options.repository,
      RENNET_USER_DATA: options.userData,
    },
  });
  return { application };
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

/**
 * Seed a repo whose feature branch ADDS a complete OpenSpec change plus a code edit,
 * so a working-tree review both parses the structured Spec viewer (model-free) and
 * has real code for the symbol inspector. The change artifacts follow the repo's own
 * OpenSpec conventions (proposal / tasks / a spec delta with a requirement + scenario).
 */
export function seedOpenSpecRepo(prefix: string): { repository: string; changeName: string } {
  const repository = makeTempDir(prefix);
  const changeName = "add-widget-counter";
  initRepo(repository);
  writeRepoFile(repository, "src/counter.ts", "export function counter() {\n  return 0;\n}\n");
  git(repository, "add", "src/counter.ts");
  git(repository, "commit", "-qm", "initial");
  git(repository, "branch", "other-work");
  git(repository, "checkout", "-qb", "feature/counter");

  // The code edit under review (drives the diff + the symbol inspector).
  writeRepoFile(
    repository,
    "src/counter.ts",
    "export function counter(step: number) {\n  return step + 1;\n}\n",
  );

  // The OpenSpec change the Spec angle reads on open (model-free parse).
  const changeDir = `openspec/changes/${changeName}`;
  writeRepoFile(
    repository,
    `${changeDir}/proposal.md`,
    [
      "## Why",
      "",
      "The counter should advance by a caller-supplied step instead of a fixed one.",
      "",
      "## What Changes",
      "",
      "- Take a `step` argument and return `step + 1`.",
      "",
      "## Capabilities",
      "",
      "### New Capabilities",
      "",
      "- `widget-counter`: A counter that advances by a caller-supplied step.",
      "",
      "## Impact",
      "",
      "- Touches `src/counter.ts`.",
      "",
    ].join("\n"),
  );
  writeRepoFile(
    repository,
    `${changeDir}/tasks.md`,
    [
      "## 1. Counter",
      "",
      "- [x] 1.1 Accept a `step` argument",
      "- [ ] 1.2 Document the new signature",
      "",
    ].join("\n"),
  );
  writeRepoFile(
    repository,
    `${changeDir}/specs/widget-counter/spec.md`,
    [
      "## ADDED Requirements",
      "",
      "### Requirement: The counter advances by the caller's step",
      "The counter SHALL return the supplied step incremented by one.",
      "",
      "#### Scenario: A step advances the counter",
      "- **WHEN** the counter is called with a step of 4",
      "- **THEN** it returns 5",
      "",
    ].join("\n"),
  );
  git(repository, "add", "src");
  git(repository, "add", "openspec");
  git(repository, "commit", "-qm", "add widget counter change");
  return { repository, changeName };
}
