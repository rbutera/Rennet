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
 * The app-owned board store itself, or anything beneath it, at any position in an
 * absolute or repository-relative path, in either separator flavour (Windows and
 * WSL-UNC paths use backslashes).
 *
 * The trailing `(?:[/\\]|$)` is load-bearing: it keeps `.rennet/boards-extra` — a
 * directory of the user's that merely starts with the same letters — out of the
 * match. Everything else under `.rennet/` (conventions, knowledge) belongs to the
 * user: tracked means intentional, and it captures like any other project file.
 */
const APP_OWNED_PATH = /(?:^|[/\\])\.rennet[/\\]boards(?:[/\\]|$)/;

/** True when `path` names app-owned Rennet state rather than the user's project content. */
export function isAppOwnedPath(path: string): boolean {
  return APP_OWNED_PATH.test(path);
}
