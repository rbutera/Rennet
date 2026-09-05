import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { HOST_LOCUS, type Locus } from "@rennet/core";
import {
  isAppOwnedPath,
  type RepositoryPathOptions,
  toRepositoryRelativePath,
} from "@rennet/protocol";
import { type FSWatcher, watch } from "chokidar";

/** True for a `\\wsl.localhost\…` / `\\wsl$\…` UNC view of a WSL filesystem. */
export function isWslUncPath(path: string): boolean {
  return /^\\\\wsl(\$|\.localhost)\\/i.test(path);
}

/**
 * The floor under the repository's own ignore rules: segments never worth watching
 * for review freshness whatever git says. VCS state (`.git`) — which git never
 * reports as ignored because it is not part of the worktree at all — the build-tool
 * cache (`.nx`), and the dependency tree (`node_modules`).
 *
 * This list used to be the WHOLE filter, and that was #850: a hardcoded list is a
 * guess about one repository, and a checkout with anything else large and gitignored
 * in it — `.claude/worktrees/`, `.venv`, `target/`, `vendor/bundle` — was walked and
 * watched in full. chokidar's Node backend arms one `fs.watch` per FILE, so the
 * entry count IS the descriptor count: 13,438 of the daemon's 19,896 open descriptors
 * were files under `.claude/worktrees/`, which `.gitignore` excludes as `.claude/*`.
 * The budget ran out in about fifteen seconds and every `spawn` after that failed
 * `EBADF`, which killed the T3 sidecar and took all five lens lanes with it. The
 * repository's real answer now comes from {@link readGitIgnoredEntries}; this list
 * survives as the answer when there is no git to ask.
 *
 * `.rennet` used to sit in this list and does not any more (#729, D6). It is not
 * gitignored in every repository — that assumption is exactly what made this list
 * wrong — and only `.rennet/boards/` is Rennet's. The app-owned prefix is pruned
 * by the shared authority in `isIgnoredPath` below; the rest of `.rennet` is the
 * user's project content, and a tracked `.rennet/conventions.json` edit has to
 * invalidate a review like any other file.
 *
 * On a WSL-UNC (9P) root the watcher POLLS, so descending `node_modules` meant
 * stat-ing tens of thousands of files every interval, and the pnpm `.bin`
 * symlinks even throw spurious EISDIR over the 9P bridge — a flood that both
 * spammed the log and starved the daemon's libuv thread pool (the same pool
 * undici uses for GitHub connects; field bug, lancelot 2026-08-20).
 *
 * `.nx` was measured on this repository, twice each way, on a checkout that had
 * been worked in for a while — 4,877 entries and 2.0 GB of build cache:
 *
 *   without `.nx` pruned   ready 61,959ms / 63,128ms   4,186 / 4,314 EMFILE errors
 *   with    `.nx` pruned   ready    834ms /    893ms       0 EMFILE errors
 *
 * Seventy times faster, and the descriptor exhaustion disappears. Note WHY that
 * matters more than the ratio: the cost is a function of accumulated cache, not
 * of the project. A fresh worktree's `.nx` is 15 entries and the difference there
 * is ~200ms vs ~136ms — nothing. So this degrades the longer a repository is used,
 * which is exactly the shape that is invisible in testing and bites in the field.
 * `.nx` also churns on every `nx` run, which marked the repo dirty for nothing and
 * forced a real diff on the next freshness ask.
 *
 * Matches the segment itself or its contents, in either separator flavour
 * (backslashes on Windows/UNC).
 */
const IGNORED_SEGMENT = /[/\\](?:\.git|\.nx|node_modules)(?:[/\\]|$)/;

/**
 * The repository's own ignore rules, as a set of root-relative comparison keys.
 * A key ending in `/` is a whole directory the walk must not enter; a key without
 * one is a single ignored file.
 */
export type GitIgnoredEntries = ReadonlySet<string>;

/**
 * The ceiling on the watcher's descriptor budget, whatever the process's own limit is.
 *
 * chokidar's Node backend calls `fs.watch` once per directory AND once per file, and each
 * of those is one descriptor — measured with `process.getActiveResourcesInfo()` on a
 * 640-file fixture: 643 `FSEventWrap` handles for 643 entries. So the entry count IS the
 * descriptor count, and #850 is what happens with no bound on it: this repository wants
 * 36,142 watches without its ignore rules and 6,436 with them.
 *
 * 32,768 is above any repository Rennet is asked to review and below the point where the
 * bookkeeping itself is the problem. It is the ceiling, not the answer — {@link watchBudget}
 * is the answer, and on a process with a small descriptor limit it is far lower.
 */
export const MAX_WATCHED_ENTRIES = 32_768;

/** Node's diagnostic report, narrowed to the one field this module reads. */
interface ReportWithUserLimits {
  readonly userLimits?: { readonly open_files?: { readonly soft?: number | string } };
}

let cachedWatchBudget: number | undefined;

/**
 * How many entries this process may watch: **half its own descriptor limit**, capped at
 * {@link MAX_WATCHED_ENTRIES}.
 *
 * Derived rather than guessed, because the number that matters is not a property of the
 * repository — it is `RLIMIT_NOFILE` for whatever process the daemon happens to be, and
 * that varies by an order of magnitude between a shell (1,048,576 here) and an app
 * launched from Finder, which inherits launchd's. A fixed constant is right for one of
 * those and wrong for the other; #850 was the wrong half. Node's diagnostic report
 * carries the real value (`userLimits.open_files.soft`), so it is read once per process
 * — the report costs ~11ms to build, which is why it is memoised — and halved.
 *
 * Half is generous to the daemon on purpose: what the daemon needs descriptors FOR is a
 * handful of things — the T3 sidecar, `git` children, HTTP sockets, the log — dozens, not
 * thousands. The failure being prevented is not the watcher taking slightly too many, it
 * is the watcher taking ALL of them and every subsequent `spawn` returning `EBADF`.
 *
 * A platform with no such limit to report (Windows) gets the ceiling.
 */
export function watchBudget(): number {
  if (cachedWatchBudget !== undefined) return cachedWatchBudget;
  let half = MAX_WATCHED_ENTRIES;
  try {
    const soft = (process.report?.getReport() as ReportWithUserLimits | undefined)?.userLimits
      ?.open_files?.soft;
    if (typeof soft === "number" && Number.isFinite(soft) && soft > 0) half = Math.floor(soft / 2);
  } catch {
    // No report, no limit to honour: the ceiling stands and the truncation notice tells
    // the reader what happened.
  }
  cachedWatchBudget = Math.max(1, Math.min(MAX_WATCHED_ENTRIES, half));
  return cachedWatchBudget;
}

/** How long `git ls-files` may take before the watcher gives up and falls back. */
const GIT_IGNORE_TIMEOUT_MS = 5_000;
/** Output cap for the same call: ~8 MB of paths is far past any healthy answer. */
const GIT_IGNORE_MAX_BUFFER = 8 * 1024 * 1024;

/**
 * Ask **git** which entries under `repositoryRoot` its own ignore rules exclude, or
 * `undefined` when there is no git answer to be had (not a repository, no `git` on
 * PATH, a UNC root git cannot address, an answer that took too long or came back
 * absurdly large).
 *
 * Asking git rather than matching patterns here is the whole point of the fix. Ignore
 * semantics are not a regex: nested `.gitignore` files, negations, `.git/info/exclude`,
 * the user's global excludesFile and `core.excludesFile` all decide the answer, and a
 * hand-rolled matcher is a second implementation that will disagree with the first one
 * somewhere the user cannot see. It also has to agree with capture, which already asks
 * git — a path the watcher reports but capture excludes is #729 all over again.
 *
 * `--directory` is what makes this cheap and what makes it a *pruning* answer rather
 * than a file list: git collapses a wholly-ignored directory to its own name with a
 * trailing slash and does not descend into it. On this repository the whole call is
 * 46 entries and 1,276 bytes in 42ms, and `.claude/worktrees/` — the 13,438 files of
 * #850 — is one of those entries.
 *
 * Synchronous because {@link RepoWatcher.start} is, and `start` is synchronous because
 * it must install the watcher in the same tick the caller asked for it (#601: anything
 * that lands before the watch is armed is lost, permanently).
 */
export function readGitIgnoredEntries(
  repositoryRoot: string,
  options?: RepositoryPathOptions,
): GitIgnoredEntries | undefined {
  let stdout: string;
  try {
    stdout = execFileSync(
      "git",
      [
        "-C",
        repositoryRoot,
        "ls-files",
        "-z",
        "--others",
        "--ignored",
        "--exclude-standard",
        "--directory",
        "--no-empty-directory",
      ],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: GIT_IGNORE_TIMEOUT_MS,
        maxBuffer: GIT_IGNORE_MAX_BUFFER,
      },
    );
  } catch {
    return undefined;
  }
  const entries = new Set<string>();
  for (const entry of stdout.split("\0")) {
    if (entry === "") continue;
    entries.add(options?.ignoreCase ? entry.toLowerCase() : entry);
  }
  return entries;
}

/**
 * True when `relativePath` is the ignored entry itself or lives under an ignored
 * directory. Walks the path's own separators rather than every rule, so the cost is
 * the path's depth (a handful of Set lookups), not the size of the rule set — the
 * predicate runs for every entry chokidar meets.
 */
function matchesGitIgnored(entries: GitIgnoredEntries, relativePath: string): boolean {
  if (relativePath === "") return false;
  if (entries.has(relativePath) || entries.has(`${relativePath}/`)) return true;
  for (let index = relativePath.indexOf("/"); index !== -1; ) {
    if (entries.has(relativePath.slice(0, index + 1))) return true;
    index = relativePath.indexOf("/", index + 1);
  }
  return false;
}

/**
 * True when a watched path is app-owned Rennet state, ignored by the repository's own
 * rules, or inside an ignored segment.
 *
 * `repositoryRoot` is the root the watcher was started on, and it is required rather
 * than inferred: ownership is root-relative (#729, D6). The board store is exactly
 * `<repositoryRoot>/.rennet/boards/`, so chokidar's absolute path has to be relativized
 * against that root before the shared authority can answer — otherwise a checkout living
 * under some ancestor `.rennet/boards` would report every one of its files as app-owned.
 *
 * A path outside the root is not the watcher's to own; the segment check still applies
 * to it. That check no longer covers `.rennet` at all: the app-owned prefix is answered
 * here, from the same authority capture uses, so the watcher and capture agree about
 * every path. What capture excludes cannot mark the tree dirty, and what capture keeps
 * — a tracked `.rennet/conventions.json` — invalidates like any other project file.
 *
 * `gitIgnored` is the repository's own answer from {@link readGitIgnoredEntries}. Absent
 * ⇒ only the app-owned prefix and the {@link IGNORED_SEGMENT} floor apply, which is the
 * behaviour for a directory that is not a git repository at all.
 */
export function isIgnoredPath(
  repositoryRoot: string,
  path: string,
  options?: RepositoryPathOptions,
  gitIgnored?: GitIgnoredEntries,
): boolean {
  const relative = toRepositoryRelativePath(repositoryRoot, path, options);
  if (relative !== undefined && isAppOwnedPath(relative, options)) return true;
  if (IGNORED_SEGMENT.test(path)) return true;
  if (gitIgnored === undefined || relative === undefined) return false;
  // git speaks forward slashes whatever the platform; chokidar reports the platform's.
  const unified = relative.replace(/\\/g, "/");
  return matchesGitIgnored(gitIgnored, options?.ignoreCase ? unified.toLowerCase() : unified);
}

/**
 * Whether `root` sits on a filesystem that folds case — the same property git records as
 * `core.ignoreCase`, probed the same way git probes it: ask the filesystem whether one
 * directory answers to two spellings.
 *
 * The watcher must ask separately rather than read git's answer, because it addresses a
 * different filesystem than git does for a WSL project (a `\\wsl.localhost\…` UNC view
 * from Windows versus ext4 inside the distro) — and because `start` is synchronous, so
 * there is no place to await a `git config`. One `stat` pair per watched root.
 *
 * A root with no ASCII letter (nothing to flip) reads as case-sensitive, which errs
 * toward watching a path rather than silently dropping it.
 */
export function filesystemIgnoresCase(root: string): boolean {
  const flipped = root.replace(/[a-z]/i, (letter) =>
    letter === letter.toLowerCase() ? letter.toUpperCase() : letter.toLowerCase(),
  );
  if (flipped === root) return false;
  try {
    const original = statSync(root, { bigint: true });
    const alias = statSync(flipped, { bigint: true });
    return original.ino === alias.ino && original.dev === alias.dev;
  } catch {
    return false;
  }
}

export class RepoWatcher {
  private watcher: FSWatcher | null = null;
  /** The root the live watcher is on, so a repeat `start` for it is recognised as a no-op. */
  private root: string | null = null;
  /**
   * False until chokidar has finished its initial walk of the tree. Nothing that
   * lands before that walk arms a watch is ever reported — see `setDirty`.
   */
  private settled = false;
  /**
   * Has the repository changed since the last trustworthy clear? The watcher owns
   * this rather than the daemon because the watcher is the only thing that knows
   * whether its own silence means anything (#601).
   */
  private dirty = true;
  /**
   * Did this root spend its {@link watchBudget}? Once true the watcher is only looking
   * at part of the tree, so it can never again vouch for the whole of it —
   * `setDirty(false)` stops sticking and every freshness ask runs a real diff.
   */
  private truncated = false;
  /**
   * Which `start` the live watcher belongs to. A chokidar instance being torn down
   * still runs its `ignored` predicate for a while, and its budget is not the new
   * watcher's — so the predicate carries the generation it was built for and a stale
   * one can neither spend the budget nor report it spent.
   */
  private generation = 0;
  /** This watcher's descriptor budget. Production always takes the default. */
  private readonly maxWatchedEntries: number;

  /**
   * `maxWatchedEntries` exists so the budget can be exercised at a size a test can
   * build. The daemon constructs a `RepoWatcher()` with no argument and gets
   * {@link watchBudget}; nothing in production passes this.
   */
  constructor(options?: { readonly maxWatchedEntries?: number }) {
    this.maxWatchedEntries = options?.maxWatchedEntries ?? watchBudget();
  }

  /**
   * Watch a repo root for changes. For a WSL-locus project the root is a
   * `\\wsl.localhost\<distro>\…` UNC view, where inotify events do NOT propagate
   * across the 9P/UNC boundary (design decision 7) — so the WSL locus watches by
   * POLLING. Host projects keep native (event-driven) watching.
   *
   * What is NOT watched is the repository's own answer: `git ls-files --others
   * --ignored --directory` once per root (#850), plus the app-owned `.rennet/boards/`
   * and the `.git`/`.nx`/`node_modules` floor. Both separator flavours match
   * (backslashes on Windows/UNC); pruning `node_modules` is also what keeps the WSL
   * poll from stat-storming the 9P bridge.
   *
   * And whatever the rules say, no root gets more than its {@link watchBudget}
   * watches. The ignore rules are what makes the tree the right size; the budget is
   * what makes a wrong answer survivable, because one `fs.watch` per file means an
   * unexpected tree does not degrade freshness, it takes the daemon's descriptors and
   * every `spawn` after that fails.
   */
  start(repositoryRoot: string, locus: Locus = HOST_LOCUS): void {
    // Re-`start` on the root already being watched is a NO-OP, and that is a correctness fix,
    // not an optimisation. Tearing the watcher down and re-walking the tree opens a window in
    // which `ignoreInitial: true` means every edit that lands is never reported — a review that
    // went stale and never says so, the exact failure freshness exists to prevent. `review.load`
    // calls `startWatching` on every open, so any client that re-reads a review (the #576
    // freshness ask does, on every window focus) would otherwise rebuild the chokidar tree on
    // each alt-tab. Same root ⇒ keep the live watcher, its armed watches and its accumulated
    // dirty flag; a repeat start on a settled root must NOT re-open the warm-up window below.
    if (this.watcher && this.root === repositoryRoot) return;
    void this.close();
    this.root = repositoryRoot;
    // Polling for the WSL locus AND for any `\\wsl.localhost\…` / `\\wsl$\…` UNC root
    // regardless of the recorded locus: the 9P bridge both drops inotify events and
    // returns spurious lstat errors (EISDIR on plain files, observed live on the
    // lancelot test bed 2026-08-19), so native watching over it is wrong twice.
    const wslUncRoot = isWslUncPath(repositoryRoot);
    // Probed once per root, not per event: `ignored` runs for every entry in the walk.
    const pathOptions: RepositoryPathOptions = {
      ignoreCase: filesystemIgnoresCase(repositoryRoot),
    };
    // One `git` process per root, not per entry. `git check-ignore` per path would be
    // correct and unaffordable — the predicate below runs tens of thousands of times.
    const gitIgnored = readGitIgnoredEntries(repositoryRoot, pathOptions);
    if (gitIgnored === undefined) {
      console.warn(
        `[repo-watcher] git could not report the ignore rules for ${repositoryRoot}; watching everything except .git/.nx/node_modules, up to ${this.maxWatchedEntries} entries`,
      );
    }
    // Distinct paths admitted past the ignore rules, so the budget counts ENTRIES and
    // not predicate calls: chokidar asks about the same path more than once (once bare,
    // once with stats, once through readdirp's filter).
    const admitted = new Set<string>();
    this.generation += 1;
    const generation = this.generation;
    this.watcher = watch(repositoryRoot, {
      ignoreInitial: true,
      ignored: (path) => {
        if (isIgnoredPath(repositoryRoot, path, pathOptions, gitIgnored)) return true;
        const key = path.replace(/\\/g, "/").replace(/\/+$/, "");
        if (admitted.has(key)) return false;
        if (admitted.size >= this.maxWatchedEntries) {
          this.noteBudgetSpent(repositoryRoot, generation);
          return true;
        }
        admitted.add(key);
        return false;
      },
      ...(locus.kind === "wsl" || wslUncRoot ? { usePolling: true, interval: 500 } : {}),
    });
    this.watcher.on("ready", () => {
      this.settled = true;
    });
    // Recorded synchronously, with no debounce. The flag is read by a freshness ask
    // that can arrive at any moment, and a 250ms coalescing window was simply 250ms
    // in which an edit that HAD been seen still answered "current".
    this.watcher.on("all", () => {
      this.dirty = true;
    });
    // A watcher error MUST NOT kill the daemon: chokidar's FSWatcher is an
    // EventEmitter, and an unhandled "error" event is a process crash — which is
    // exactly what took the daemon down in a loop when lstat over the WSL UNC
    // bridge failed. Freshness degrades to missed events; the daemon lives.
    this.watcher.on("error", (error) => {
      console.error(
        "[repo-watcher] watcher error (freshness may miss changes):",
        error instanceof Error ? error.message : error,
      );
    });
  }

  /**
   * Said ONCE per root, the first time the budget runs out, and it names the count —
   * because the failure this replaces was 16,751 identical `EMFILE` lines in one daemon
   * lifetime, which told the reader nothing except that something was very wrong
   * somewhere else. This line says which root, how many, and what it costs.
   */
  private noteBudgetSpent(repositoryRoot: string, generation: number): void {
    if (this.truncated || generation !== this.generation) return;
    this.truncated = true;
    console.warn(
      `[repo-watcher] watch budget spent: ${this.maxWatchedEntries} entries under ${repositoryRoot}, and the tree is bigger than that. The rest is unwatched, so freshness stops trusting this watcher and runs a real diff on every ask. Check what large directory is NOT gitignored here.`,
    );
  }

  /** Has the repository changed since the last trustworthy clear? */
  isDirty(): boolean {
    return this.dirty;
  }

  /**
   * Whether this root spent its {@link watchBudget} and is only partly watched.
   * Diagnostic, and the thing a test asserts about honest degradation.
   */
  isTruncated(): boolean {
    return this.truncated;
  }

  /**
   * Every path the live watcher currently holds a watch on — one `fs.watch`, and so one
   * descriptor, each. This is chokidar's own bookkeeping (`getWatched`), which is what
   * makes it the resource measurement rather than a restatement of the predicate.
   */
  watchedPaths(): readonly string[] {
    const watched = this.watcher?.getWatched() ?? {};
    const paths: string[] = [];
    for (const [directory, entries] of Object.entries(watched)) {
      paths.push(directory);
      for (const entry of entries) paths.push(`${directory}/${entry}`);
    }
    return paths;
  }

  /**
   * Record, or clear, "the tree has moved since the review was pinned".
   *
   * Clearing only STICKS once the initial walk has finished (#601). chokidar arms
   * its watches file by file as it walks, and `ignoreInitial: true` suppresses
   * everything it finds on the way — so a save that lands before the walk reaches
   * that file is not late, it is *lost*, permanently. Measured on this repo: a
   * write issued in the same tick as `start()` on a 400-file tree was never
   * reported in 20 of 20 runs, while the walk itself finished in ~14ms. A real
   * repository is far larger, which is why the daemon was seen answering "current"
   * nine seconds after an edit.
   *
   * So while the walk is in flight the watcher refuses to vouch for the tree, and
   * the caller falls through to a real diff instead of trusting a silence that
   * means nothing yet.
   *
   * What that costs, measured on this repository rather than guessed: with `.nx`
   * pruned the walk finishes in 834–893ms, so it is a diff or two. Before `.nx` was
   * pruned the same walk took 62–63 seconds, and the cost stayed bounded anyway only
   * because the walk blocks the event loop, which prevents an ask storm rather than
   * absorbing one. That is not a property to rely on: this stays cheap only while
   * the ignore list above stays honest about what is not worth walking.
   *
   * What it does NOT promise: that every later change is reported. `ready` fires
   * when chokidar has finished walking, which is not the same as every watch being
   * armed — measured on this repository before `.nx` was pruned, it fired after
   * 4,186–4,314 EMFILE failures, and chokidar does not retry a nested failure. So
   * the guarantee here is exactly "chokidar says it has finished looking", and no
   * more. That closes the first-save window, which is the defect.
   *
   * Descriptor exhaustion was the other half, and this is its answer (#850): a root
   * that spent its {@link watchBudget} is only watching part of its tree, so a
   * clear can never stick for it either. Silence from a partial watcher means nothing,
   * exactly as silence from an unfinished walk means nothing, and the caller falls
   * through to a real diff for as long as the watcher is on that root.
   */
  setDirty(value: boolean): void {
    this.dirty = value || !this.settled || this.truncated;
  }

  async close(): Promise<void> {
    // Release the fields BEFORE awaiting. `start` calls `close` without awaiting and
    // then synchronously installs the new watcher; nulling after the await would land
    // in a later microtask and wipe that new watcher out, orphaning a live chokidar
    // instance and defeating the same-root no-op above — which re-walks the tree on
    // the next `review.load` and re-opens the very window `setDirty` exists to close.
    const watcher = this.watcher;
    this.watcher = null;
    this.root = null;
    this.settled = false;
    this.dirty = true;
    this.truncated = false;
    await watcher?.close();
  }
}
