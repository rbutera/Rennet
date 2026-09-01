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

/**
 * True when a **repository-root-relative** path names app-owned Rennet state rather
 * than the user's project content.
 *
 * Input contract: `repositoryRelativePath` is relative to the repository root, with no
 * leading separator and no `./` prefix — the shape `git` emits and the shape
 * {@link toRepositoryRelativePath} produces. An absolute path is never app-owned;
 * relativize it against the root you already know first.
 */
export function isAppOwnedPath(repositoryRelativePath: string): boolean {
  return APP_OWNED_PATH.test(repositoryRelativePath);
}

/**
 * `path` expressed relative to `repositoryRoot`, or `undefined` when it does not lie
 * beneath that root. The root itself yields `""`.
 *
 * String-level rather than `node:path`: this package is browser-safe, and the paths
 * cross platforms anyway — a host daemon handles `\\wsl.localhost\…` UNC roots whose
 * separators are not the running platform's.
 */
export function toRepositoryRelativePath(repositoryRoot: string, path: string): string | undefined {
  const root = repositoryRoot.replace(/[/\\]+$/, "");
  if (!path.startsWith(root)) return undefined;
  const rest = path.slice(root.length);
  if (rest === "") return "";
  if (!/^[/\\]/.test(rest)) return undefined; // a sibling like `/repo-2`, not a child
  return rest.replace(/^[/\\]+/, "");
}
