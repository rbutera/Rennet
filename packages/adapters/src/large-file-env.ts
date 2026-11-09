import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { GitExec } from "./git-range-diff";

/**
 * Skip mode for every LATER git command in a skip-mode checkout (review-preparation-
 * reliability, large-file-checkout spec).
 *
 * `largeFileGitInvocation` covers the checkout Rennet itself runs. Every later process a
 * session spawns in that checkout — a lens seat's or the chat thread's shell, the round
 * worker, a cold utility turn, and Rennet's own git reads — runs git under the user's
 * global config, and when that config marks the LFS filter as required and `git-lfs` is not
 * installed, every one of them fails on the first file the filter touches.
 *
 * The overrides travel through the ENVIRONMENT, never through the user's config: git reads
 * `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_<n>` / `GIT_CONFIG_VALUE_<n>` as command-line config.
 *
 * ⚠️ WHY AN INCLUDE AND NOT THE OVERRIDES THEMSELVES. Most of a session's processes are not
 * spawned per session: the lens seats, the chat thread and the round worker run as threads of
 * ONE long-lived sidecar process, whose environment is fixed when it starts, before any
 * checkout exists, and which serves skip-mode and download-mode projects alike. Putting
 * `filter.lfs.process=` in that environment would leave every download-mode checkout with
 * placeholders. So the environment carries ONE entry, `include.path=<index>`, and the index
 * file holds one `includeIf "gitdir:<checkout's git dir>"` section per skip-mode checkout,
 * pointing at the overrides. Git reads the file on every invocation, so a checkout registered
 * after the sidecar started is covered at once, and a download-mode checkout matches nothing.
 *
 * `GIT_LFS_SKIP_SMUDGE=1` cannot be scoped to a directory, so it is NOT set here: with both
 * filter commands blanked git never starts `git-lfs` to smudge, which is what that variable
 * would have stopped. It stays on Rennet's own skip-mode checkout call, where it is per call.
 */

/** The three filter overrides skip mode applies, as `key=value` config entries. */
export const LARGE_FILE_SKIP_CONFIG: readonly (readonly [string, string])[] = [
  ["filter.lfs.process", ""],
  ["filter.lfs.smudge", ""],
  ["filter.lfs.required", "false"],
];

/**
 * `env` with `entries` appended as command-line git config, after any the environment
 * already carries. An existing `GIT_CONFIG_COUNT` is kept and extended, never replaced: the
 * user (or a wrapper) may have set entries of their own, and they keep their numbers. A
 * count that is not a non-negative integer is treated as git treats it — git refuses to run
 * with one — so it is left exactly as it was and nothing is added.
 */
export function withGitConfigEnv<T extends Record<string, string | undefined>>(
  env: T,
  entries: readonly (readonly [string, string])[],
): T & Record<string, string | undefined> {
  const raw = env.GIT_CONFIG_COUNT;
  const existing = raw === undefined || raw === "" ? 0 : Number(raw);
  if (!Number.isInteger(existing) || existing < 0) return { ...env };
  const next: Record<string, string | undefined> = { ...env };
  entries.forEach(([key, value], index) => {
    next[`GIT_CONFIG_KEY_${existing + index}`] = key;
    next[`GIT_CONFIG_VALUE_${existing + index}`] = value;
  });
  next.GIT_CONFIG_COUNT = String(existing + entries.length);
  return next as T & Record<string, string | undefined>;
}

/**
 * The environment a process needs for skip mode in ONE known checkout: the three filter
 * overrides plus `GIT_LFS_SKIP_SMUDGE=1`. For a process spawned for exactly one skip-mode
 * checkout; a process shared across checkouts takes {@link withLargeFileSkipIndex} instead.
 */
export function largeFileSkipEnv<T extends Record<string, string | undefined>>(
  env: T,
): T & Record<string, string | undefined> {
  return { ...withGitConfigEnv(env, LARGE_FILE_SKIP_CONFIG), GIT_LFS_SKIP_SMUDGE: "1" };
}

/** Where the daemon keeps the skip-mode index for `dataDir`. */
export function largeFileSkipIndexPath(dataDir: string): string {
  return join(dataDir, "large-files", "skip-checkouts.gitconfig");
}

/** The overrides file the index's sections include, beside the index. */
function overridesPathFor(indexPath: string): string {
  return join(dirname(indexPath), "skip-overrides.gitconfig");
}

/**
 * `env` carrying the skip-mode index: one `include.path` entry, appended after any
 * command-line config the environment already has. The daemon applies it once, at startup,
 * to its own environment, so every process it spawns inherits it.
 */
export function withLargeFileSkipIndex<T extends Record<string, string | undefined>>(
  env: T,
  indexPath: string,
): T & Record<string, string | undefined> {
  // Idempotent: a daemon environment that already carries this include gets no second one.
  const count = Number(env.GIT_CONFIG_COUNT ?? 0);
  if (Number.isInteger(count)) {
    for (let index = 0; index < count; index += 1) {
      if (
        env[`GIT_CONFIG_KEY_${index}`] === "include.path" &&
        env[`GIT_CONFIG_VALUE_${index}`] === indexPath
      ) {
        return { ...env };
      }
    }
  }
  return withGitConfigEnv(env, [["include.path", indexPath]]);
}

/** A config subsection name quoted the way git reads it back: `\` and `"` escaped. */
function quoteSubsection(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** A path as a `gitdir:` glob that matches exactly that directory: wildcards escaped, and no
 *  trailing slash, which git would widen to everything beneath it (a repository's `.git`
 *  would then match every one of its linked worktrees). */
function exactGitdirPattern(gitDir: string): string {
  return gitDir.replace(/\/+$/, "").replace(/([*?[\]\\])/g, "\\$1");
}

const INDEX_HEADER =
  "# Written by Rennet. Review checkouts whose project skips Git LFS content: git commands\n" +
  "# Rennet's processes run in them leave large files as placeholders. Not your git config;\n" +
  "# Rennet's own processes read it through GIT_CONFIG_* in their environment.\n";

/** The text of the overrides file every index section includes. */
export function largeFileSkipOverridesText(): string {
  return `${INDEX_HEADER}[filter "lfs"]\n\tprocess =\n\tsmudge =\n\trequired = false\n`;
}

/** The text of an index naming `gitDirs`, each including `overridesPath`. */
export function largeFileSkipIndexText(gitDirs: readonly string[], overridesPath: string): string {
  const sections = gitDirs.map(
    (gitDir) =>
      // The value is quoted too: an unquoted `#` or `;` in a path would start a comment.
      `[includeIf "${quoteSubsection(`gitdir:${exactGitdirPattern(gitDir)}`)}"]\n\tpath = "${quoteSubsection(overridesPath)}"\n`,
  );
  return `${INDEX_HEADER}${sections.join("")}`;
}

/** The git dirs a written index names, read back from its own sections. */
function parseIndexGitDirs(text: string): string[] {
  const dirs: string[] = [];
  for (const match of text.matchAll(/^\[includeIf "gitdir:((?:[^"\\]|\\.)*)"\]$/gm)) {
    const quoted = match[1] ?? "";
    // Undo the subsection quoting, then the glob escaping.
    dirs.push(quoted.replace(/\\(.)/g, "$1").replace(/\\(.)/g, "$1"));
  }
  return dirs;
}

/** Write `text` to `path` through a sibling temp file, so a reader never sees half of it. */
function writeAtomically(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, text);
  renameSync(temp, path);
}

/**
 * The daemon's register of skip-mode checkouts, kept as the index file git includes.
 *
 * The file IS the store: it survives a daemon restart, so a checkout registered before the
 * restart stays covered with nothing to rebuild. Registering is idempotent, and only a
 * project's mode change (or the checkout's removal) unregisters.
 */
export class LargeFileSkipIndex {
  readonly #indexPath: string;
  readonly #overridesPath: string;

  constructor(indexPath: string) {
    this.#indexPath = indexPath;
    this.#overridesPath = overridesPathFor(indexPath);
  }

  get indexPath(): string {
    return this.#indexPath;
  }

  /** The git dirs registered now, read from the file. */
  gitDirs(): string[] {
    try {
      return parseIndexGitDirs(readFileSync(this.#indexPath, "utf8"));
    } catch {
      return [];
    }
  }

  has(gitDir: string): boolean {
    return this.gitDirs().includes(gitDir);
  }

  /** Register a checkout's git dir. Writes the overrides file too, so the include resolves. */
  add(gitDir: string): void {
    const current = this.gitDirs();
    writeAtomically(this.#overridesPath, largeFileSkipOverridesText());
    if (current.includes(gitDir)) return;
    writeAtomically(
      this.#indexPath,
      largeFileSkipIndexText([...current, gitDir], this.#overridesPath),
    );
  }

  /** Unregister every git dir `drop` selects. */
  remove(drop: (gitDir: string) => boolean): void {
    const current = this.gitDirs();
    const kept = current.filter((gitDir) => !drop(gitDir));
    if (kept.length === current.length) return;
    writeAtomically(this.#indexPath, largeFileSkipIndexText(kept, this.#overridesPath));
  }
}

/**
 * The absolute git dir of the checkout at `root` — what `includeIf "gitdir:"` matches. For a
 * linked worktree that is `<repo>/.git/worktrees/<name>`, not `<root>/.git`.
 */
export async function absoluteGitDir(git: GitExec, root: string): Promise<string> {
  return (await git(root, ["rev-parse", "--absolute-git-dir"])).trim();
}
