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

/** The derived-data paths (relative to `.rennet/`) that `local` visibility ignores. */
const IGNORED_ENTRIES = ["map/", "overlays/", "knowledge/"] as const;

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
  const preview = await previewVisibilitySwitch(repoRoot, target, git);
  if (preview.changed) {
    const path = preview.gitignorePath;
    mkdirSync(join(path, ".."), { recursive: true });
    const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
    writeFileSync(tmp, preview.after);
    renameSync(tmp, path);
  }
  store.updateConfig(repoKey, (current) => ({ ...current, visibility: target }));
  return preview;
}
