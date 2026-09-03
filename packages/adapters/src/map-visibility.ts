import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
 * The derived-data paths (relative to `.rennet/`) that `local` visibility ignores.
 *
 * `context/` is the session context directory (session-context-files): the files a turn
 * reads instead of being sent them inline. It is Rennet's scratch for one session and is
 * purged when that session is archived, so nothing under it is ever the reviewer's to
 * stage — which is why {@link ensureManagedIgnoreBlock} writes this block before the
 * first context file lands, whatever the project's visibility.
 */
const IGNORED_ENTRIES = ["map/", "overlays/", "knowledge/", "context/"] as const;

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
  if (target === "git-visible") {
    // No Rennet exclusions; keep only whatever the user authored.
    return userLines ? `${userLines}\n` : "";
  }
  const managed = [MANAGED_START, ...IGNORED_ENTRIES, MANAGED_END].join("\n");
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
 * writes derived data there — the pre-write half of the never-staged rule for session
 * context files (session-context-files).
 *
 * Composes the block through the SAME `composeGitignore` the visibility switch uses, so
 * the block's shape has one definition. User-authored lines are preserved, and a file that
 * already carries the block is left byte-identical (returns `false`).
 *
 * Unlike the switch this is not a visibility decision: a repo the reviewer set to
 * `git-visible` gets the block back, because `context/` is Rennet's own purge-on-archive
 * scratch and is never the reviewer's to stage. Never runs git.
 */
export function ensureManagedIgnoreBlock(repoRoot: string): boolean {
  const path = gitignorePath(repoRoot);
  const before = readGitignore(repoRoot);
  const after = composeGitignore(before, "local");
  if (after === before) return false;
  writeGitignore(path, after);
  return true;
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
