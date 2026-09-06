import { execFileSync } from "node:child_process";
import { type FSWatcher as NodeFsWatcher, statSync, watch as watchRecursive } from "node:fs";
import { join } from "node:path";
import { HOST_LOCUS, type Locus } from "@rennet/core";
import {
  isAppOwnedPath,
  type RepositoryPathOptions,
  toRepositoryRelativePath,
} from "@rennet/protocol";
import { type FSWatcher as ChokidarWatcher, watch as watchByEntry } from "chokidar";

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
 * ## Why there is no descriptor budget here any more (#892)
 *
 * There used to be a `watchBudget()` in this file: half of `process.report.getReport()
 * .userLimits.open_files.soft`, capped at a 32,768 ceiling. It was derived rather than
 * guessed, which is why it read as principled — and it was inert, because the number it
 * derived from is not the number that binds. Measured on Node 24.20 / macOS 15, 2026-09-06:
 *
 *     soft limit `process.report` reports    1,048,575
 *     files the process could actually open     92,149   (= `kern.maxfilesperproc`)
 *
 * Node raises `RLIMIT_NOFILE` towards the hard limit during startup, and macOS's default
 * hard limit is `unlimited`, so the soft limit it reports afterwards is 1,048,575 on every
 * Mac — while the kernel goes on enforcing `kern.maxfilesperproc` regardless. Half of
 * 1,048,575 is over the ceiling, so `watchBudget()` returned 32,768 on every Mac, always.
 * The derivation never ran. A repository would have to want more than 32,768 watches before
 * the bound existed at all, and this one wants about 6,000.
 *
 * The field evidence says precisely that, and it is what makes this a measurement rather
 * than an argument. On the installed 0.9.1 daemon (pid 91325, 59 minutes up) `~/.rennet/
 * daemon.log` held **41,887** `EMFILE: too many open files, watch` lines in a 42,697-line
 * file — and **zero** `watch budget spent` lines. The bound never fired while the daemon
 * drowned. `lsof` on that daemon: 5,147 descriptors, 5,125 of them `REG` files under the
 * checkout. So the real ceiling for that process was somewhere near 5,100 — a number that
 * neither 1,048,575 nor 92,149 predicts, because an Electron child's true limit is set by
 * machinery that reports nothing to the process it constrains.
 *
 * That is the general shape, and it is why a tuning nudge was never going to work: **the
 * safe size of a per-file watcher depends on a limit no API in the process can tell you.**
 * Every value is a guess, every guess is wrong on some machine, and the failure mode of
 * guessing high is that the daemon loses every descriptor and cannot spawn `git`, cannot
 * start the T3 sidecar, and cannot answer a chat turn — which is the bug the user reported
 * as "explain no longer works".
 *
 * So the fix is not a better number. It is a backend whose cost does not depend on the size
 * of the tree: see {@link RepoWatcher.start}.
 */

/**
 * The cap on the PER-ENTRY backends' watched entries — Linux native watching, and WSL polling.
 *
 * This bounds CPU, not descriptors, and the distinction is the whole point. `fs.watchFile`
 * — what chokidar arms when `usePolling` is set — is a libuv `uv_fs_poll_t` and holds no
 * descriptor at all; what it costs is one `stat` per entry per interval, which over the 9P
 * bridge is the storm that starved the daemon's libuv thread pool (lancelot, 2026-08-20).
 * So this is a flat number and it is allowed to be generous: exceeding it degrades speed,
 * never the daemon's ability to spawn.
 *
 * The native backend has no matching constant because it has nothing to bound: one
 * `fs.watch(root, { recursive: true })` is ONE handle for the whole tree, at any size.
 */
export const MAX_WATCHED_ENTRIES = 32_768;

/**
 * True where one `fs.watch(root, { recursive: true })` really is one watch for the tree.
 *
 * macOS answers recursive watching with FSEvents and Windows with a recursive
 * `ReadDirectoryChangesW`: one kernel subscription, one handle, one descriptor, at any tree
 * size. **Linux has no recursive watch in the kernel**, so Node ships a userland one that
 * walks the tree and arms an `fs.watch` on every entry it finds. Measured in CI on a
 * 1,200-file fixture in three directories: **1,204 handles** — the files plus the
 * directories. Per entry, not per directory.
 *
 * That is not a smaller version of the same win, it is the absence of it, plus a loss: the
 * userland walk is Node's, so it does not consult this module's ignore rules and would arm
 * watches inside `node_modules` that the per-entry backend prunes. Descriptors survive that
 * — libuv keeps ONE inotify instance per loop and adds watches to it, which is why the
 * descriptor assertion passes on Linux under either backend — but
 * `fs.inotify.max_user_watches` does not, and exhausting it is the same class of failure
 * wearing a different errno.
 *
 * There is a second reason, and it is the sharper one. The recursive backend marks itself
 * settled the instant it is created, which is only safe because a failure to arm THROWS. On
 * Linux the userland watcher defers its walk and returns a watcher object for a root that
 * does not exist — CI caught exactly that. A backend that cannot detect its own failure to
 * arm and vouches anyway is a freshness lie, which is worse than the descriptor bug this
 * change fixes.
 *
 * So Linux keeps the pruning per-entry backend it always had, where `settled` waits on
 * chokidar's `ready` and provides that net. Nothing is lost: the descriptor exhaustion is a
 * macOS property, because macOS is where libuv falls back to kqueue and a real `open()` for
 * every non-directory. Rennet ships no Linux desktop — this platform is the in-WSL daemon
 * and CI.
 */
function hasKernelRecursiveWatch(): boolean {
  return process.platform === "darwin" || process.platform === "win32";
}

/**
 * The decade a repeated log line is worth restating at: 1, 10, 100, 1,000, 10,000 …
 *
 * See {@link RepeatCollapsingLog}. Chosen over a time window because a count threshold is
 * deterministic, so the test for it does not need fake timers to be honest.
 */
function isDecade(count: number): boolean {
  if (count < 10) return false;
  let decade = 10;
  while (decade < count) decade *= 10;
  return decade === count;
}

/**
 * A log channel that says a repeated message once, then at each decade, then the exact final
 * total — so 41,887 identical lines become six and the reader loses nothing.
 *
 * This is its own defect, not decoration. The 0.9.1 daemon log was 42,697 lines of which
 * 41,887 were the same `EMFILE` sentence: 98% of the file, and Rai reads that file to
 * diagnose. Two real daemon crashes and a dead T3 sidecar were in there, buried. A log that
 * repeats itself into unreadability hides the evidence as effectively as not logging at all.
 *
 * The count is never dropped. {@link flush} — called when the message changes and on close —
 * emits the final total if the last emitted line did not already name it, so the reader
 * always learns how many there were, not merely that there were "lots".
 */
export class RepeatCollapsingLog {
  private last: string | undefined;
  private count = 0;
  private emitted = 0;

  constructor(private readonly emit: (line: string) => void) {}

  /** Record one occurrence, emitting only at the first, at each decade, and on change. */
  record(message: string): void {
    if (message !== this.last) {
      this.flush();
      this.last = message;
      this.count = 0;
      this.emitted = 0;
    }
    this.count += 1;
    if (this.count === 1) {
      this.emit(message);
      this.emitted = 1;
      return;
    }
    if (isDecade(this.count)) {
      this.emit(`${message} (repeated ${this.count} times)`);
      this.emitted = this.count;
    }
  }

  /** Emit the final total for the current message unless the last line already named it. */
  flush(): void {
    if (this.last === undefined || this.count <= this.emitted) return;
    this.emit(`${this.last} (repeated ${this.count} times)`);
    this.emitted = this.count;
  }
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
  /**
   * The live watcher. A `node:fs` recursive watcher on the native path, a chokidar
   * per-entry poller on the WSL/9P path; both are EventEmitters and both `close()`.
   */
  private watcher: NodeFsWatcher | ChokidarWatcher | null = null;
  /** The root the live watcher is on, so a repeat `start` for it is recognised as a no-op. */
  private root: string | null = null;
  /**
   * Has the watcher finished arming? The recursive backend arms synchronously and sets this
   * in the same tick (measured: 20 of 20 same-tick writes reported); the polling backend
   * walks the tree first, and nothing landing before that walk arms a watch is ever
   * reported — see `setDirty`.
   */
  private settled = false;
  /**
   * Has the repository changed since the last trustworthy clear? The watcher owns
   * this rather than the daemon because the watcher is the only thing that knows
   * whether its own silence means anything (#601).
   */
  private dirty = true;
  /**
   * Is this root only PARTLY watched? Once true the watcher can never again vouch for the
   * whole tree — `setDirty(false)` stops sticking and every freshness ask runs a real diff.
   *
   * Two ways to get here, both honest degradation rather than silent loss: the polling
   * backend spent {@link MAX_WATCHED_ENTRIES}, or the recursive backend could not arm at all
   * and there is no watcher on this root.
   */
  private truncated = false;
  /**
   * Which `start` the live watcher belongs to. A chokidar instance being torn down
   * still runs its `ignored` predicate for a while, and its budget is not the new
   * watcher's — so the predicate carries the generation it was built for and a stale
   * one can neither spend the budget nor report it spent.
   */
  private generation = 0;
  /**
   * Which backend is live. Recorded rather than re-derived from the root, because the
   * choice is made from the LOCUS as well as the path: a `wsl` locus on a path that is not
   * a UNC view still polls, and nothing about that path says so.
   */
  private mode: "recursive" | "per-entry" | "polling" | "none" = "none";
  /** The per-entry backends' cap. Production always takes the default. */
  private readonly maxWatchedEntries: number;
  /**
   * The watcher's error channel, collapsed. An `EMFILE` storm produced 41,887 identical
   * lines in one daemon lifetime and made the log useless; this says the first, each
   * decade, and the exact total.
   */
  private readonly errors = new RepeatCollapsingLog((line) => {
    console.error("[repo-watcher] watcher error (freshness may miss changes):", line);
  });

  /**
   * `maxWatchedEntries` exists so the polling cap can be exercised at a size a test can
   * build. The daemon constructs a `RepoWatcher()` with no argument and gets
   * {@link MAX_WATCHED_ENTRIES}; nothing in production passes this.
   */
  constructor(options?: { readonly maxWatchedEntries?: number }) {
    this.maxWatchedEntries = options?.maxWatchedEntries ?? MAX_WATCHED_ENTRIES;
  }

  /**
   * Watch a repo root for changes.
   *
   * **The native path is one `fs.watch(root, { recursive: true })` — one handle, one
   * descriptor, for a tree of any size.** That is the fix for #892 and it is a change of
   * cost model, not of tuning. chokidar's Node backend arms one `fs.watch` per FILE, and on
   * macOS libuv falls back to kqueue for a non-directory (`uv_fs_event_start`: "FSEvents
   * works only with directories"), which is `open()` — so the entry count IS the descriptor
   * count. Measured here: watching 20,000 files cost 20,000 descriptors, and under a
   * 256-descriptor limit exactly 245 watches and 245 plain `open`s succeeded before EMFILE.
   * Recursive `fs.watch` on the same 6,000-file checkout cost **1** descriptor and **1**
   * `FSEventWrap`, because macOS answers it with FSEvents on the directory tree, Windows
   * with a recursive `ReadDirectoryChangesW`, and Linux with per-directory inotify watches
   * on the loop's single shared inotify descriptor. No budget can be right when the cost is
   * per file; no budget is needed once it is not.
   *
   * It is also *faster to trust*. The recursive watcher arms in the tick it is created:
   * a write issued in the same tick as `start()` was reported in **20 of 20** runs, against
   * **0 of 20** for the chokidar walk the same test was written for (#601). So `settled` is
   * true immediately and the first freshness ask after a capture can be answered from the
   * watcher instead of a diff.
   *
   * Arming is not delivery, and the distinction matters for what may be believed. Being
   * armed means no write is *lost*: every one that lands after `start()` will be reported.
   * When it is reported is FSEvents' business, and on a loaded machine that has been
   * measured at seconds — the watcher suite's own same-tick test needed more than five of
   * them during a full `pnpm check`. So a freshness ask arriving inside that gap still
   * answers "unchanged" for a tree that has moved. That is a property of every event-driven
   * watcher rather than something this backend introduced (the walk it replaces lost the
   * write outright), and it is why `dirty` starts true and a clear has to be earned.
   *
   * What the ignore rules do here has changed with it, and this is the trade to understand:
   * they can no longer PRUNE, because the kernel watches the subtree whole. They are applied
   * to each EVENT instead — the same `git ls-files --others --ignored --directory` answer
   * (#850), the same app-owned `.rennet/boards/` prefix, the same `.git`/`.nx`/`node_modules`
   * floor, through the same {@link isIgnoredPath}. So `.nx` churn still does not mark the
   * tree dirty. The cost moves from tens of thousands of descriptors to a handful of Set
   * lookups per event, and once the tree is already dirty even that is skipped.
   *
   * Two things the recursive backend genuinely does not do, written down rather than
   * discovered later: it does not follow symlinks out of the tree (chokidar did), so a
   * repository whose source is a symlink to somewhere else reports nothing for it; and
   * FSEvents coalesces, so events arrive collapsed. The second costs nothing here — this
   * watcher's whole output is one boolean — and the first is a real, narrow regression.
   *
   * **The WSL/9P path still polls**, for the reasons it always did (design decision 7:
   * inotify events do not cross the 9P/UNC boundary, and the bridge returns spurious lstat
   * errors). Polling holds no descriptors — `fs.watchFile` is a libuv poll timer — so the
   * cap there is {@link MAX_WATCHED_ENTRIES}, and it is about `stat` storms, not exhaustion.
   */
  start(repositoryRoot: string, locus: Locus = HOST_LOCUS): void {
    // Re-`start` on the root already being watched is a NO-OP, and that is a correctness fix,
    // not an optimisation. Tearing the watcher down and rebuilding opens a window in which
    // anything that lands is never reported — a review that went stale and never says so,
    // the exact failure freshness exists to prevent. `review.load` calls `startWatching` on
    // every open, and the #576 freshness ask does it on every window focus.
    if (this.watcher && this.root === repositoryRoot) return;
    void this.close();
    this.root = repositoryRoot;
    // Polling for the WSL locus AND for any `\\wsl.localhost\…` / `\\wsl$\…` UNC root
    // regardless of the recorded locus: the 9P bridge both drops inotify events and
    // returns spurious lstat errors (EISDIR on plain files, observed live on the
    // lancelot test bed 2026-08-19), so native watching over it is wrong twice.
    const wslUncRoot = isWslUncPath(repositoryRoot);
    // Probed once per root, not per event: the predicate below runs for every event.
    const pathOptions: RepositoryPathOptions = {
      ignoreCase: filesystemIgnoresCase(repositoryRoot),
    };
    // One `git` process per root, not per entry. `git check-ignore` per path would be
    // correct and unaffordable.
    const gitIgnored = readGitIgnoredEntries(repositoryRoot, pathOptions);
    if (gitIgnored === undefined) {
      console.warn(
        `[repo-watcher] git could not report the ignore rules for ${repositoryRoot}; watching everything except .git/.nx/node_modules`,
      );
    }
    this.generation += 1;
    if (locus.kind === "wsl" || wslUncRoot) {
      this.startByEntry(repositoryRoot, pathOptions, gitIgnored, true);
      return;
    }
    if (hasKernelRecursiveWatch()) {
      this.startRecursive(repositoryRoot, pathOptions, gitIgnored);
      return;
    }
    // Linux: no kernel recursive watch worth having, so the pruning per-entry backend stays.
    this.startByEntry(repositoryRoot, pathOptions, gitIgnored, false);
  }

  /**
   * The native backend: ONE recursive watch for the whole tree.
   *
   * A throw here means this platform or filesystem cannot answer a recursive watch. The
   * answer is not to fall back to a per-entry watcher — that is the failure this change
   * exists to remove — it is to say so once and stop vouching, so every freshness ask runs
   * a real diff. Slower, and correct; a watcher that quietly saw nothing would be the lie.
   */
  private startRecursive(
    repositoryRoot: string,
    pathOptions: RepositoryPathOptions,
    gitIgnored: GitIgnoredEntries | undefined,
  ): void {
    let watcher: NodeFsWatcher;
    try {
      watcher = watchRecursive(repositoryRoot, { recursive: true, persistent: true });
    } catch (error) {
      this.truncated = true;
      console.warn(
        `[repo-watcher] no recursive watch available for ${repositoryRoot} (${error instanceof Error ? error.message : String(error)}). Freshness cannot trust a watcher here, so every ask runs a real diff.`,
      );
      return;
    }
    this.watcher = watcher;
    this.mode = "recursive";
    // Armed in this tick. Unlike the chokidar walk this replaces, there is no window between
    // `start` returning and events being delivered: measured at 20 of 20 same-tick writes
    // reported, against 0 of 20 for the walk (#601). So a clear may stick straight away.
    this.settled = true;
    watcher.on("change", (_eventType, filename) => {
      // Already dirty ⇒ nothing an event can tell us changes the answer, so the ignore rules
      // are not consulted at all. This is what keeps a `pnpm install` or an `nx` run — which
      // is thousands of events under directories we ignore — free rather than merely cheap.
      if (this.dirty) return;
      // A platform that cannot name the path leaves us unable to apply the ignore rules, and
      // the safe direction is to report a change that might be ignorable rather than to miss
      // one that is not.
      if (filename === null || filename === undefined) {
        this.dirty = true;
        return;
      }
      const relative = typeof filename === "string" ? filename : filename.toString("utf8");
      if (isIgnoredPath(repositoryRoot, join(repositoryRoot, relative), pathOptions, gitIgnored)) {
        return;
      }
      this.dirty = true;
    });
    // A watcher error MUST NOT kill the daemon: an unhandled "error" event on an
    // EventEmitter is a process crash, which is what took the daemon down in a loop when
    // lstat over the WSL UNC bridge failed. Freshness degrades to missed events; the daemon
    // lives — and the message is collapsed so a storm cannot bury the log.
    watcher.on("error", (error) => {
      this.errors.record(error instanceof Error ? error.message : String(error));
    });
  }

  /**
   * The WSL/9P backend: chokidar, polling, pruned by the ignore rules and capped.
   *
   * Polling costs `stat` calls rather than descriptors, so the cap here is about the libuv
   * thread pool and the 9P bridge, not about exhaustion. Pruning still happens at the walk,
   * because the walk is exactly what costs something in this mode.
   */
  private startByEntry(
    repositoryRoot: string,
    pathOptions: RepositoryPathOptions,
    gitIgnored: GitIgnoredEntries | undefined,
    polling: boolean,
  ): void {
    // Distinct paths admitted past the ignore rules, so the cap counts ENTRIES and
    // not predicate calls: chokidar asks about the same path more than once.
    const admitted = new Set<string>();
    const generation = this.generation;
    const watcher = watchByEntry(repositoryRoot, {
      ignoreInitial: true,
      ...(polling ? { usePolling: true, interval: 500 } : {}),
      ignored: (path) => {
        if (isIgnoredPath(repositoryRoot, path, pathOptions, gitIgnored)) return true;
        const key = path.replace(/\\/g, "/").replace(/\/+$/, "");
        if (admitted.has(key)) return false;
        if (admitted.size >= this.maxWatchedEntries) {
          this.noteCapSpent(repositoryRoot, generation);
          return true;
        }
        admitted.add(key);
        return false;
      },
    });
    this.watcher = watcher;
    this.mode = polling ? "polling" : "per-entry";
    watcher.on("ready", () => {
      this.settled = true;
    });
    // Recorded synchronously, with no debounce. The flag is read by a freshness ask
    // that can arrive at any moment, and a 250ms coalescing window was simply 250ms
    // in which an edit that HAD been seen still answered "current".
    watcher.on("all", () => {
      this.dirty = true;
    });
    watcher.on("error", (error) => {
      this.errors.record(error instanceof Error ? error.message : String(error));
    });
  }

  /**
   * Said ONCE per root, the first time the per-entry cap runs out, and it names the count.
   */
  private noteCapSpent(repositoryRoot: string, generation: number): void {
    if (this.truncated || generation !== this.generation) return;
    this.truncated = true;
    console.warn(
      `[repo-watcher] watch cap spent: ${this.maxWatchedEntries} entries under ${repositoryRoot}, and the tree is bigger than that. The rest is unwatched, so freshness stops trusting this watcher and runs a real diff on every ask. Check what large directory is NOT gitignored here.`,
    );
  }

  /** Has the repository changed since the last trustworthy clear? */
  isDirty(): boolean {
    return this.dirty;
  }

  /**
   * Whether this root is only partly watched — the polling cap was spent, or no watcher
   * could be armed at all. Diagnostic, and the thing a test asserts about honest degradation.
   */
  isTruncated(): boolean {
    return this.truncated;
  }

  /**
   * Which backend the live watcher is, so a test can assert the cheap one was chosen rather
   * than infer it from a resource count that a broken watcher would also satisfy.
   */
  backend(): "recursive" | "per-entry" | "polling" | "none" {
    return this.watcher === null ? "none" : this.mode;
  }

  /**
   * Every path the live watcher holds a watch on.
   *
   * For the recursive backend that is the root, and only the root: one `fs.watch` covers the
   * subtree, so this list has length 1 no matter how large the repository is. That is not a
   * simplification of the answer, it IS the answer, and it is the whole of #892. For the
   * polling backend it is chokidar's own bookkeeping (`getWatched`).
   */
  watchedPaths(): readonly string[] {
    if (this.watcher === null) return [];
    if (this.mode === "recursive") return this.root === null ? [] : [this.root];
    const watched = (this.watcher as ChokidarWatcher).getWatched();
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
   * Clearing only STICKS once the watcher has armed. For the recursive backend that is
   * immediate — it arms in the tick `start` runs, measured at 20 of 20 same-tick writes
   * reported — so the first freshness ask after a capture can be answered from the watcher
   * rather than from a diff. That is the #601 window closed rather than merely survived:
   * chokidar armed its watches file by file as it walked, `ignoreInitial: true` suppressed
   * everything it met on the way, and a save landing before the walk reached that file was
   * not late but *lost*. Measured on a 400-file tree: 0 of 20 reported, while the walk
   * itself finished in ~14ms; on a real repository the walk was 834–893ms, which is how the
   * daemon came to answer "current" nine seconds after an edit.
   *
   * For the polling backend the walk is still real and `ready` still gates the clear.
   *
   * And a partly-watched root can never clear at all. Silence from a watcher that is only
   * looking at some of the tree means nothing, exactly as silence from an unfinished walk
   * means nothing, so the caller falls through to a real diff for as long as the watcher is
   * on that root — whether it ran out of poll cap or could not arm in the first place.
   */
  setDirty(value: boolean): void {
    this.dirty = value || !this.settled || this.truncated;
  }

  async close(): Promise<void> {
    // Release the fields BEFORE awaiting. `start` calls `close` without awaiting and
    // then synchronously installs the new watcher; nulling after the await would land
    // in a later microtask and wipe that new watcher out, orphaning a live watcher
    // and defeating the same-root no-op above.
    const watcher = this.watcher;
    this.watcher = null;
    this.mode = "none";
    this.root = null;
    this.settled = false;
    this.dirty = true;
    this.truncated = false;
    // Whatever the storm reached, the reader gets the exact total rather than the last
    // decade — a count that stops short is the same defect as a log that repeats forever.
    this.errors.flush();
    await watcher?.close();
  }
}
