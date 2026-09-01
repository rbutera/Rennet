// The one authority for "which paths inside a user's repository does Rennet own"
// (#729, design D6). Declared here, in the package every reader and the writer can
// import, so capture, the repo watcher, freshness evaluation and the board-store
// writer can never disagree about it.

/**
 * The board store's location under a project root, as segments to join.
 *
 * `createBoardsRuntime` joins exactly these segments to place the store, so the
 * storage root cannot silently move out from under the exclusion that names it.
 */
export const APP_OWNED_BOARD_SEGMENTS = [".rennet", "boards"] as const;

/**
 * The app-owned board store, anchored at the repository root, in either separator
 * flavour (Windows and WSL-UNC paths use backslashes).
 *
 * The leading `^` is load-bearing: the store is exactly `<repositoryRoot>/.rennet/boards/`
 * and nowhere else. A `.rennet/boards` directory nested inside the repo (say
 * `packages/thing/.rennet/boards`) is the user's, because the app never writes there —
 * and a checkout that itself lives beneath some ancestor directory called `.rennet/boards`
 * must not have its every file claimed.
 *
 * The trailing `(?:[/\\]|$)` is load-bearing too: it keeps `.rennet/boards-extra` — a
 * directory of the user's that merely starts with the same letters — out of the match.
 * Everything else under `.rennet/` (conventions, knowledge) belongs to the user: tracked
 * means intentional, and it captures like any other project file.
 */
const APP_OWNED_PATH = /^\.rennet[/\\]boards(?:[/\\]|$)/;
const APP_OWNED_PATH_IGNORING_CASE = /^\.rennet[/\\]boards(?:[/\\]|$)/i;

/**
 * How much of a path's spelling carries meaning in the repository being asked about.
 *
 * `ignoreCase` mirrors git's own `core.ignoreCase`, which git sets at init/clone by
 * probing the filesystem — true on the macOS and Windows defaults. It is a per-repository
 * fact, not a per-process one: a WSL project's git answers for ext4 while the daemon
 * watching its UNC view runs on Windows, so each caller asks the filesystem it is
 * actually addressing and passes the answer here.
 *
 * It matters because `.Rennet/Boards/` and `.rennet/boards/` are ONE directory on a
 * case-insensitive filesystem. If such an alias already exists, the board writer's
 * lowercase join lands inside it and git records the on-disk spelling — so a
 * case-sensitive comparison sees the user's content where Rennet's own state is
 * (confirmed on macOS: git indexes `.Rennet/Boards/b.jsonl`, and `:(top).rennet/boards`
 * does not match it). Where the filesystem does distinguish the two spellings they are
 * genuinely different directories, and the second one is the user's.
 */
export interface RepositoryPathOptions {
  readonly ignoreCase?: boolean;
}

/**
 * True when a **repository-root-relative** path names app-owned Rennet state rather
 * than the user's project content.
 *
 * Input contract: `repositoryRelativePath` is relative to the repository root, with no
 * leading separator and no `./` prefix — the shape `git` emits and the shape
 * {@link toRepositoryRelativePath} produces. An absolute path is never app-owned;
 * relativize it against the root you already know first.
 */
export function isAppOwnedPath(
  repositoryRelativePath: string,
  options?: RepositoryPathOptions,
): boolean {
  const pattern = options?.ignoreCase ? APP_OWNED_PATH_IGNORING_CASE : APP_OWNED_PATH;
  return pattern.test(repositoryRelativePath);
}

/**
 * The comparison key for one path: separators unified, and case folded when the
 * repository's filesystem does not distinguish it.
 *
 * Replacing separators one character for one preserves length, which is what lets the
 * caller slice the ORIGINAL text at an offset measured here and keep its own spelling.
 * `toLowerCase` is not length-preserving for every codepoint (`İ` grows); a root
 * containing one degrades to "not beneath the root" via the separator check below,
 * which is the safe direction — a watched path reported rather than silently dropped.
 */
function comparisonKey(value: string, options?: RepositoryPathOptions): string {
  const unified = value.replace(/\\/g, "/");
  return options?.ignoreCase ? unified.toLowerCase() : unified;
}

/**
 * `path` expressed relative to `repositoryRoot`, or `undefined` when it does not lie
 * beneath that root. The root itself yields `""`. The returned text keeps `path`'s own
 * separators, because callers render it back to the user.
 *
 * The root and the candidate are compared separator-insensitively: they routinely
 * disagree about spelling for one directory. On native Windows the daemon holds a root
 * like `C:/dev/repo` while chokidar reports `C:\dev\repo\…`, and a byte-for-byte prefix
 * test made every such event look like it came from outside the repository — so
 * app-owned board writes marked the tree dirty and forced a needless recapture.
 *
 * String-level rather than `node:path`: this package is browser-safe, and the paths
 * cross platforms anyway — a host daemon handles `\\wsl.localhost\…` UNC roots whose
 * separators are not the running platform's.
 */
export function toRepositoryRelativePath(
  repositoryRoot: string,
  path: string,
  options?: RepositoryPathOptions,
): string | undefined {
  const root = repositoryRoot.replace(/[/\\]+$/, "");
  if (!comparisonKey(path, options).startsWith(comparisonKey(root, options))) return undefined;
  const rest = path.slice(root.length);
  if (rest === "") return "";
  if (!/^[/\\]/.test(rest)) return undefined; // a sibling like `/repo-2`, not a child
  return rest.replace(/^[/\\]+/, "");
}
