import { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { escapePath } from "@rennet/core";
import { execaGit, type GitExec } from "./git-range-diff";
import type { ProjectSnapshotStore, ProjectVisibility } from "./project-snapshot-store";

/**
 * The `projectContext.visibility` switch (#14 / design §1.6, spec A.2). A project's
 * derived, in-repo `.rennet/` data can be kept `local` (git-ignored, the default)
 * or made `git-visible` (so a promoted map is stageable by the user). Switching:
 *
 *   - changes ONLY Rennet-owned exclusion state — a managed block inside
 *     `<repo>/.rennet/.gitignore`. User-authored lines in that file are preserved.
 *   - NEVER runs `git add`, `git rm --cached`, or `git commit`. The only git call
 *     is the read-only `git ls-files`, to DISCLOSE files already tracked under
 *     `.rennet/` (switching to `local` does not un-track them — that would need
 *     `git rm --cached`, which we never do; the honest thing is to report them).
 *
 * The preview shows exactly what the exclusion state would become before anything
 * is written, so the switch is never a silent index mutation.
 */

const MANAGED_START = "# >>> rennet-managed (do not edit) >>>";
const MANAGED_END = "# <<< rennet-managed <<<";

/**
 * The DERIVED-DATA paths (relative to `.rennet/`) whose exclusion is the reviewer's to
 * choose: `local` ignores them, `git-visible` does not, and that is the whole switch.
 */
const DERIVED_ENTRIES = ["map/", "overlays/", "knowledge/"] as const;

/**
 * The paths ignored at EVERY visibility, because they are not derived data the reviewer
 * might want to commit — they are Rennet's own scratch.
 *
 * `context/` is the session context directory (session-context-files): the files a turn
 * reads instead of being sent them inline. It belongs to one session and is purged when
 * that session is archived, so nothing under it is ever the reviewer's to stage.
 */
const ALWAYS_IGNORED = ["context/"] as const;

/** The managed block's entries for a visibility. `git-visible` still hides Rennet's scratch. */
function managedEntriesFor(target: ProjectVisibility): readonly string[] {
  return target === "git-visible"
    ? ALWAYS_IGNORED
    : ([...DERIVED_ENTRIES, ...ALWAYS_IGNORED] as const);
}

function gitignorePath(repoRoot: string): string {
  return join(repoRoot, ".rennet", ".gitignore");
}

/** Read the current `.rennet/.gitignore`, or "" when absent/unreadable (fail-safe). */
function readGitignore(repoRoot: string): string {
  try {
    return readFileSync(gitignorePath(repoRoot), "utf8");
  } catch {
    return "";
  }
}

/** Strip the Rennet-managed block, returning only user-authored lines. */
function stripManagedBlock(content: string): string {
  const lines = content.split("\n");
  const out: string[] = [];
  let inManaged = false;
  for (const line of lines) {
    if (line.trim() === MANAGED_START) {
      inManaged = true;
      continue;
    }
    if (line.trim() === MANAGED_END) {
      inManaged = false;
      continue;
    }
    if (!inManaged) out.push(line);
  }
  return out
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Compose the target `.gitignore` content for a visibility, preserving user lines. */
function composeGitignore(current: string, target: ProjectVisibility): string {
  const userLines = stripManagedBlock(current);
  const managed = [MANAGED_START, ...managedEntriesFor(target), MANAGED_END].join("\n");
  return userLines ? `${userLines}\n\n${managed}\n` : `${managed}\n`;
}

/** Write the `.rennet/.gitignore` atomically (tmp + rename), creating `.rennet/` if needed. */
function writeGitignore(path: string, content: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

/**
 * Ensure the Rennet-managed block exists in `<repoRoot>/.rennet/.gitignore` before Rennet
 * writes session context there — the pre-write half of the never-staged rule
 * (session-context-files).
 *
 * Composes the block through the SAME `composeGitignore` the visibility switch uses, so
 * the block's shape has one definition, and AT THE REPO'S CURRENT VISIBILITY, so it never
 * re-decides one the reviewer already made. That argument is the whole point: composing at
 * a fixed `"local"` re-ignored `map/ overlays/ knowledge/` on a repo set to `git-visible`,
 * silently undoing the switch while the settings store still read git-visible (review
 * finding 1). `context/` is in the block at either visibility, so the guarantee this call
 * exists for holds without touching the reviewer's choice.
 *
 * User-authored lines are preserved, a file that already carries the right block is left
 * byte-identical (returns `false`), and git is never run.
 */
export function ensureManagedIgnoreBlock(
  repoRoot: string,
  visibility: ProjectVisibility = "local",
): boolean {
  const path = gitignorePath(repoRoot);
  const before = readGitignore(repoRoot);
  const after = composeGitignore(before, visibility);
  if (after === before) return false;
  writeGitignore(path, after);
  return true;
}

/**
 * The visibility a repository is RECORDED at, read from the project store the daemon
 * writes. Absent or malformed config ⇒ `local`, the default a project has until the
 * reviewer switches it — the same fail-safe fold `loadConfigOrDefault` uses.
 *
 * This is the answer {@link ensureManagedIgnoreBlock} needs and no path-only caller can
 * know; a repo the store has never heard of is `local`, which is what it would have been.
 */
export function recordedVisibility(
  store: ProjectSnapshotStore,
  repoRoot: string,
): ProjectVisibility {
  try {
    return store.loadConfig(escapePath(realpathSync(repoRoot)))?.visibility ?? "local";
  } catch {
    return "local";
  }
}

/** Files git already tracks under `.rennet/` — disclosed, never restaged. */
async function trackedUnderRennet(repoRoot: string, git: GitExec): Promise<string[]> {
  try {
    const out = await git(repoRoot, ["ls-files", "-z", "--", ".rennet"], { reject: true });
    return out.split("\0").filter(Boolean);
  } catch {
    return [];
  }
}

/** The preview of a visibility switch — what the exclusion state WOULD become. */
export interface VisibilityPreview {
  readonly target: ProjectVisibility;
  readonly gitignorePath: string;
  /** The current file content. */
  readonly before: string;
  /** The content the switch would write. */
  readonly after: string;
  /** Whether applying would change the file. */
  readonly changed: boolean;
  /** Files git already tracks under `.rennet/` (disclosed; never restaged). */
  readonly preTracked: readonly string[];
}

/**
 * Preview a visibility switch: compute the target `.rennet/.gitignore`, and
 * disclose any files git already tracks under `.rennet/`. Pure read — writes
 * nothing, runs no mutating git command.
 */
export async function previewVisibilitySwitch(
  repoRoot: string,
  target: ProjectVisibility,
  git: GitExec = execaGit,
): Promise<VisibilityPreview> {
  const before = readGitignore(repoRoot);
  const after = composeGitignore(before, target);
  return {
    target,
    gitignorePath: gitignorePath(repoRoot),
    before,
    after,
    changed: after !== before,
    preTracked: await trackedUnderRennet(repoRoot, git),
  };
}

/**
 * Apply a visibility switch: write the target `.rennet/.gitignore` (Rennet-owned
 * exclusion state only) and record `visibility` in the local `config.json`. Never
 * stages, un-stages, or commits. Returns the same preview it applied, so the
 * caller can show the pre-tracked disclosure.
 */
export async function applyVisibilitySwitch(
  store: ProjectSnapshotStore,
  repoKey: string,
  repoRoot: string,
  target: ProjectVisibility,
  git: GitExec = execaGit,
): Promise<VisibilityPreview> {
  // Refuse a malformed config BEFORE writing anything (Rule 75): otherwise the
  // `.gitignore` would be written and then `updateConfig` would throw, leaving a
  // half-applied switch. Check first, so neither file is touched.
  if (store.loadConfigState(repoKey).status === "malformed") {
    throw new Error(
      `refusing a visibility switch on a repo with a malformed config (${repoRoot}); fix or remove ${store.paths(repoKey).configPath} first`,
    );
  }
  const preview = await previewVisibilitySwitch(repoRoot, target, git);
  if (preview.changed) writeGitignore(preview.gitignorePath, preview.after);
  store.updateConfig(repoKey, (current) => ({ ...current, visibility: target }));
  return preview;
}
