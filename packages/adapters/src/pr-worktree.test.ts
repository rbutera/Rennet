import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { escapePath } from "@rennet/core";
import { afterEach, describe, expect, it } from "vitest";
import { execaGit } from "./git-range-diff";
import {
  assertWorktreePattern,
  branchTokens,
  branchWorktreePath,
  defaultWorktreePlacement,
  ensureBranchWorktree,
  ensurePrWorktree,
  ensureSiblingWorktree,
  expandWorktreeRootForWrite,
  LOCAL_OWNER,
  prTokens,
  prWorktreePath,
  readSetupLogTail,
  readSetupStatus,
  renderWorktreePattern,
  repoKeyForRoot,
  resolveWorktreeRoot,
  runPrWorktreeSetup,
  WORKTREE_PLACEHOLDERS,
} from "./pr-worktree";

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0))
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

/** A repo with two commits; returns both OIDs (the "old head" and "new head"). */
function repo(): { root: string; dataDir: string; firstOid: string; secondOid: string } {
  const root = mkdtempSync(join(tmpdir(), "rennet-prwt-"));
  const dataDir = mkdtempSync(join(tmpdir(), "rennet-prwt-data-"));
  scratch.push(root, dataDir);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "rennet@example.test");
  git(root, "config", "user.name", "Rennet Test");
  writeFileSync(join(root, "a.txt"), "one\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "one");
  const firstOid = git(root, "rev-parse", "HEAD");
  writeFileSync(join(root, "a.txt"), "two\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "two");
  const secondOid = git(root, "rev-parse", "HEAD");
  return { root, dataDir, firstOid, secondOid };
}

/** The path the builtin pull-request pattern computes for PR 7 of this fixture. */
function prPath(dataDir: string, root: string): string {
  const placement = defaultWorktreePlacement(dataDir);
  return prWorktreePath(
    placement.root,
    placement.prPattern,
    { repoKey: "-repo", repoRoot: root, owner: "acme", remoteName: "widget" },
    7,
  );
}

/** What a worktree IS, as one string: its head, its branch, and its working tree's state.
 *  Any of the three moving is what "it was replaced" would look like. */
function fingerprint(root: string, path: string): string {
  const head = git(path, "rev-parse", "HEAD");
  // A detached HEAD exits 1 here, which is an ANSWER ("no branch"), not a failure.
  const branch = ((): string => {
    try {
      return execFileSync("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], {
        cwd: path,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      return "(detached)";
    }
  })();
  const porcelain = git(path, "status", "--porcelain=v1");
  const registered = git(root, "worktree", "list", "--porcelain");
  return [head, branch, porcelain, registered].join("\n");
}

describe("ensurePrWorktree", () => {
  it("creates a detached worktree at the head OID, and a re-open reuses it", async () => {
    const { root, dataDir, firstOid } = repo();
    const path = prPath(dataDir, root);
    const first = await ensurePrWorktree(execaGit, root, path, firstOid);
    expect(first).toEqual({ path, created: true });
    expect(readFileSync(join(path, "a.txt"), "utf8")).toBe("one\n");
    const again = await ensurePrWorktree(execaGit, root, path, firstOid);
    expect(again.created).toBe(false); // setup will not re-run on a plain re-open
  });

  it("replaces the checkout when the reviewed head is superseded", async () => {
    const { root, dataDir, firstOid, secondOid } = repo();
    const path = prPath(dataDir, root);
    await ensurePrWorktree(execaGit, root, path, firstOid);
    // Rennet's index records this path — the successor case this replacement exists for.
    const replaced = await ensurePrWorktree(execaGit, root, path, secondOid, {
      recordedSnapshot: true,
    });
    expect(replaced.created).toBe(true);
    expect(readFileSync(join(path, "a.txt"), "utf8")).toBe("two\n");
  });

  // ── It will not force-replace a worktree it did not place (review finding B3) ──────────
  //
  // `worktreePattern` and `prWorktreePattern` are BOTH the reviewer's to set and both
  // resolve under one root. Set them to shapes that collide — `{name}` and `{name}`, or any
  // pattern with no `{number}` — and a pull request's computed path IS a session's branch
  // worktree. This used to run `worktree remove --force` plus `rm -rf` on whatever sat
  // there whose HEAD was not the reviewed head, so opening a PR deleted a reviewer's
  // uncommitted edits. Both halves of the identification are pinned below, separately.

  it("THROWS rather than replacing a BRANCH worktree that occupies the PR's path", async () => {
    const { root, dataDir, firstOid, secondOid } = repo();
    const path = prPath(dataDir, root);
    // A branch worktree of this repository at exactly the path the PR pattern computes,
    // with work in progress in it.
    git(root, "worktree", "add", "-q", "-b", "mine", path, firstOid);
    writeFileSync(join(path, "wip.txt"), "half-written\n");
    const before = fingerprint(root, path);

    await expect(
      ensurePrWorktree(execaGit, root, path, secondOid, { recordedSnapshot: true }),
    ).rejects.toThrow(/is a worktree of this repository on mine/);

    // Nothing moved: same HEAD, same branch, same porcelain, and the edits are still there.
    expect(fingerprint(root, path)).toBe(before);
    expect(readFileSync(join(path, "wip.txt"), "utf8")).toBe("half-written\n");
    expect(readFileSync(join(path, "a.txt"), "utf8")).toBe("one\n");
  });

  it("THROWS on a DETACHED worktree Rennet's index does not record", async () => {
    // The second half. Detached alone is not evidence Rennet placed it — a reviewer's own
    // `git worktree add --detach` is detached too — so the index has to say so.
    const { root, dataDir, firstOid, secondOid } = repo();
    const path = prPath(dataDir, root);
    git(root, "worktree", "add", "-q", "--detach", path, firstOid);
    const before = fingerprint(root, path);

    await expect(ensurePrWorktree(execaGit, root, path, secondOid)).rejects.toThrow(
      /not Rennet's snapshot of this pull request/,
    );

    expect(fingerprint(root, path)).toBe(before);
  });
});

describe("runPrWorktreeSetup", () => {
  function worktreeWithSetup(lines: string): string {
    const dir = mkdtempSync(join(tmpdir(), "rennet-setup-"));
    scratch.push(dir);
    mkdirSync(join(dir, ".rennet"), { recursive: true });
    writeFileSync(join(dir, ".rennet", "setup"), lines);
    return dir;
  }

  it("reports `none` (and runs nothing) when there is no setup file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rennet-setup-"));
    scratch.push(dir);
    expect(await runPrWorktreeSetup(dir)).toEqual({ status: "none" });
    expect(readSetupStatus(dir)).toEqual({ status: "none" });
  });

  it("runs commands sequentially in the worktree, records ok + the log", async () => {
    const dir = worktreeWithSetup("# bootstrap\necho hello > out.txt\necho done\n");
    const status = await runPrWorktreeSetup(dir);
    expect(status).toEqual({ status: "ok" });
    expect(readSetupStatus(dir)).toEqual({ status: "ok" });
    expect(readFileSync(join(dir, "out.txt"), "utf8")).toBe("hello\n");
    expect(readSetupLogTail(dir)).toContain("done");
  });

  it("records the failing command + exit code and stops (setup never throws)", async () => {
    const dir = worktreeWithSetup("exit 3\necho never > never.txt\n");
    const status = await runPrWorktreeSetup(dir);
    expect(status).toEqual({ status: "failed", command: "exit 3", exitCode: 3 });
    expect(readSetupStatus(dir)).toEqual({ status: "failed", command: "exit 3", exitCode: 3 });
    expect(existsSync(join(dir, "never.txt"))).toBe(false); // later commands did not run
  });
});

describe("worktree placement (workspace-settings D1/D2)", () => {
  const dataDir = "/data";
  const placement = defaultWorktreePlacement(dataDir);
  /** One repository, as every placement addresses it: a store key, its own directory,
   *  and whatever git could say about its remote. */
  const orbital = {
    repoKey: "-Users-rai-orbital",
    repoRoot: "/Users/rai/orbital",
    owner: "acme",
    remoteName: "orbital",
  };

  it("the two builtin patterns reproduce the previous release's paths BYTE-FOR-BYTE", () => {
    // The expected paths are LITERALS — the shapes the old signatures hardcoded,
    // `join(dataDir, "worktrees", repoKey, ...branch.split("/"))` and
    // `join(dataDir, "worktrees", owner, name, `pr-${n}`)` — so an install that has never
    // touched a rung places nothing differently. The patterns on the left do come from
    // `defaultWorktreePlacement`, so what this pins is the pair: those builtins, rendered,
    // are those paths. It does not independently check what the builtins say.
    expect(branchWorktreePath(placement.root, placement.pattern, orbital, "feat/thing")).toBe(
      join(dataDir, "worktrees", "-Users-rai-orbital", "feat", "thing"),
    );
    expect(
      prWorktreePath(
        placement.root,
        placement.prPattern,
        { repoKey: "-k", repoRoot: "/w/widget", owner: "acme", remoteName: "widget" },
        7,
      ),
    ).toBe(join(dataDir, "worktrees", "acme", "widget", "pr-7"));
    // The branch keeps its slashes as SEPARATORS, so `feat/a-b` and `feat-a-b` stay two
    // directories — the mapping is injective, exactly as before.
    expect(
      branchWorktreePath(
        placement.root,
        placement.pattern,
        { repoKey: "k", repoRoot: "/w/k" },
        "feat-a-b",
      ),
    ).toBe(join(dataDir, "worktrees", "k", "feat-a-b"));
  });

  it("a custom pattern places by its own tokens", () => {
    expect(branchWorktreePath("/trees", "{owner}/{name}/{branch}", orbital, "feat/x")).toBe(
      join("/trees", "acme", "orbital", "feat", "x"),
    );
    expect(
      prWorktreePath("/trees", "{repo}/pr-{number}", { repoKey: "-r", repoRoot: "/w/o" }, 12),
    ).toBe(join("/trees", "-r", "pr-12"));
  });

  it("the token set the WRITE blesses is the token set every BIND SITE supplies", () => {
    // The bug this pins: `PLACEHOLDERS` validated a branch pattern against
    // `{repo,name,owner,branch}` while the bind site handed over `{repo,name,branch}`, so
    // a stored `{owner}/{branch}` previewed fine and threw the moment a session bound.
    // Two declarations, one assertion — the grammar and the builders cannot drift apart
    // without this reddening.
    expect(Object.keys(branchTokens(orbital, "feat/x")).sort()).toEqual(
      Object.keys(WORKTREE_PLACEHOLDERS.branch).sort(),
    );
    expect(Object.keys(prTokens(orbital, 1)).sort()).toEqual(
      Object.keys(WORKTREE_PLACEHOLDERS["pull-request"]).sort(),
    );
    // …and every blessed token therefore HAS a value: a pattern using all of them renders.
    for (const [kind, pattern] of [
      ["branch", "{repo}/{name}/{owner}/{branch}"],
      ["pull-request", "{owner}/{name}/{repo}/{number}"],
    ] as const) {
      expect(() => assertWorktreePattern(kind, pattern)).not.toThrow();
    }
    expect(branchWorktreePath("/trees", "{repo}/{name}/{owner}/{branch}", orbital, "x")).toBe(
      join("/trees", "-Users-rai-orbital", "orbital", "acme", "x"),
    );
    expect(prWorktreePath("/trees", "{owner}/{name}/{repo}/{number}", orbital, 3)).toBe(
      join("/trees", "acme", "orbital", "-Users-rai-orbital", "3"),
    );
  });

  it("`{name}` is the REMOTE's repository name, and the folder's basename only when none resolves", () => {
    // Cloning `acme/widget` into `/work/widget-local`: the PR bind fills `{name}` from the
    // forge identity, so a `{name}` that meant the basename made the preview promise
    // `acme/widget-local/pr-1` while the bind created `acme/widget/pr-1`.
    const cloned = {
      repoKey: "-work-widget-local",
      repoRoot: "/work/widget-local",
      owner: "acme",
      remoteName: "widget",
    };
    expect(prWorktreePath("/trees", "{owner}/{name}/pr-{number}", cloned, 1)).toBe(
      join("/trees", "acme", "widget", "pr-1"),
    );
    expect(branchWorktreePath("/trees", "{owner}/{name}/{branch}", cloned, "feat/x")).toBe(
      join("/trees", "acme", "widget", "feat", "x"),
    );
    // No remote resolved: the folder answers for itself, and `{owner}` is `local`.
    const bare = { repoKey: "-work-widget-local", repoRoot: "/work/widget-local" };
    expect(branchWorktreePath("/trees", "{owner}/{name}/{branch}", bare, "feat/x")).toBe(
      join("/trees", LOCAL_OWNER, "widget-local", "feat", "x"),
    );
  });

  it("REFUSES an escape, an unknown token and an absolute pattern, each with its reason", () => {
    const tokens = { repo: "k", name: "orbital", owner: "acme", branch: "feat/x" };
    expect(() => renderWorktreePattern("/trees", "../{branch}", tokens)).toThrow(
      /outside the worktree root/,
    );
    // An escape that only shows up after normalisation is refused on the RENDERED path.
    expect(() => renderWorktreePattern("/trees", "{repo}/../../{branch}", tokens)).toThrow(
      /outside the worktree root/,
    );
    expect(() => renderWorktreePattern("/trees", "{nope}/{branch}", tokens)).toThrow(
      /unknown token \{nope\}/,
    );
    expect(() => renderWorktreePattern("/trees", "/abs/{branch}", tokens)).toThrow(/absolute/);
    expect(() => renderWorktreePattern("/trees", "   ", tokens)).toThrow(/names no path/);
  });

  it("a name INHERITED from Object.prototype is not a token", () => {
    // `name in tokens` walked the prototype chain, so `{constructor}` rendered a function
    // into a path and `{__proto__}`/`{toString}` were "known" too.
    const tokens = { repo: "k", name: "orbital", owner: "acme", branch: "feat/x" };
    for (const inherited of ["constructor", "toString", "hasOwnProperty", "valueOf"]) {
      expect(() => renderWorktreePattern("/trees", `{${inherited}}/{branch}`, tokens)).toThrow(
        new RegExp(`unknown token \\{${inherited}\\}`),
      );
    }
    expect(() => assertWorktreePattern("branch", "{constructor}/{branch}")).toThrow(
      /unknown token \{constructor\}/,
    );
  });

  it("separates 'renders to the root itself' from 'escapes the root', and a root of `/` still works", () => {
    const tokens = { repo: "k", name: "orbital", owner: "acme", branch: "feat/x" };
    // The root ITSELF is not a worktree path: a pattern that renders to nothing under it
    // would put every repository's checkout in one directory. That is a DIFFERENT mistake
    // from escaping, and the message the reviewer reads says which one they made.
    expect(() => renderWorktreePattern("/trees", ".", tokens)).toThrow(
      /renders to the worktree root itself/,
    );
    expect(() => renderWorktreePattern("/trees", "{repo}/..", tokens)).toThrow(
      /renders to the worktree root itself/,
    );
    // A root that IS a separator refused every legal descendant, because containment was
    // a `base + sep` prefix test and `/` + `/` is `//`.
    expect(renderWorktreePattern("/", "{repo}/{branch}", tokens)).toBe(join("/", "k", "feat", "x"));
    // `/` has no parent, so a `..` there normalises back INTO the root rather than out of
    // it — the escape refusal is still exercised on a root that has an outside, above.
    expect(renderWorktreePattern("/", "../{branch}", tokens)).toBe(join("/", "feat", "x"));
    expect(() => renderWorktreePattern("/", ".", tokens)).toThrow(
      /renders to the worktree root itself/,
    );
  });

  it("assertWorktreePattern validates a pattern before it is stored, per grammar", () => {
    expect(() => assertWorktreePattern("branch", "{repo}/{branch}")).not.toThrow();
    expect(() => assertWorktreePattern("pull-request", "{owner}/{name}/pr-{number}")).not.toThrow();
    // The two grammars are distinct: a branch pattern may not ask for a number, and a
    // pull-request pattern may not ask for a branch.
    expect(() => assertWorktreePattern("branch", "{repo}/pr-{number}")).toThrow(/unknown token/);
    expect(() => assertWorktreePattern("pull-request", "{branch}")).toThrow(/unknown token/);
    expect(() => assertWorktreePattern("branch", "../{branch}")).toThrow(/outside/);
  });

  it("resolves the root: unset ⇒ the data dir, `~` expands, relative resolves against it", () => {
    expect(resolveWorktreeRoot(dataDir, undefined)).toBe(join(dataDir, "worktrees"));
    expect(resolveWorktreeRoot(dataDir, "  ")).toBe(join(dataDir, "worktrees"));
    expect(resolveWorktreeRoot(dataDir, "/elsewhere/trees")).toBe("/elsewhere/trees");
    expect(resolveWorktreeRoot(dataDir, "~/trees")).toBe(join(homedir(), "trees"));
    // A relative value resolves against the DATA DIR, never the daemon's cwd.
    expect(resolveWorktreeRoot("/data", "trees")).toBe(join("/data", "trees"));
    // Tolerant at the READ, for a file someone edited by hand: a literal `~user` stays a
    // literal `~user` directory rather than throwing the whole settings read away.
    expect(resolveWorktreeRoot("/data", "~someone/trees")).toBe(join("/data", "~someone", "trees"));
  });

  it("EXPANDS a written root at the write, and refuses another user's home", () => {
    expect(expandWorktreeRootForWrite(dataDir, "~/trees")).toBe(join(homedir(), "trees"));
    expect(expandWorktreeRootForWrite(dataDir, "  trees  ")).toBe(join(dataDir, "trees"));
    expect(expandWorktreeRootForWrite(dataDir, "/elsewhere")).toBe("/elsewhere");
    // An empty write is a reset; dropping the entry is the caller's job.
    expect(expandWorktreeRootForWrite(dataDir, "   ")).toBe("");
    // `~someone` needs a passwd lookup this process does not do. Refused with its reason,
    // rather than persisted as a literal `~someone` directory the daemon would create.
    expect(() => expandWorktreeRootForWrite(dataDir, "~someone/trees")).toThrow(
      /another user's home/,
    );
  });

  it("repoKeyForRoot spells `{repo}` through the realpath, as the binding does", () => {
    const dir = mkdtempSync(join(tmpdir(), "rennet-key-"));
    scratch.push(dir);
    // On macOS `/var` is a symlink to `/private/var`, so an unresolved tmpdir path and its
    // realpath are two different keys — the preview and the bind must pick the same one.
    expect(repoKeyForRoot(dir)).toBe(escapePath(realpathSync(dir)));
    // An unresolvable path keeps its literal spelling rather than throwing.
    expect(repoKeyForRoot("/nope/does-not-exist")).toBe(escapePath("/nope/does-not-exist"));
  });
});

// ── NEITHER BIND PRUNES A REGISTRATION (review finding B4, and P1 one arm over) ────────
//
// `git worktree prune` drops every registration whose gitdir points somewhere git cannot
// reach RIGHT NOW. "Unreachable" is not "gone": an unmounted volume, a network share that
// is down, a distro that is not running all read the same to git. `ensureSiblingWorktree`
// ran it first, under a comment claiming prune "touches nothing that exists" — so a
// temporarily unavailable sibling lost its registration and the very next lines re-forked
// or recreated it, and the staged-only work waiting in that directory belonged to no
// worktree when the volume came back.
//
// `ensureBranchWorktree` HAD THE SAME DEFECT AND SURVIVED THAT FIX, because it wore a
// different disguise: it tested `existsSync(<worktree>/.git)` rather than reading the
// registrations, and `existsSync` is FALSE for exactly the directory that is present but
// unreachable from this side. So the unmounted-volume case fell straight through to
// `worktree prune` and then `worktree add` OVER THE MOUNT POINT. Both arms now read.
//
// A FAKE git, deliberately: the claim is about the ARGV these functions issue, and a real
// git cannot be made to report an unreachable directory without unmounting something.

/** `git worktree list --porcelain -z` output, NUL-delimited (a blank line ends a record). */
function listing(lines: readonly string[]): string {
  return `${lines.join("\0")}\0\0`;
}

/**
 * A git that answers the registration read with `listed` and records every argv.
 *
 * `failFrom` is the set of cwds whose commands REJECT — which is how the reachability probe
 * (`rev-parse --show-toplevel`, run at the record's own path) is made to fail without
 * unmounting anything.
 *
 * The DEFAULTS model a HEALTHY repository, so that a test which says nothing about the
 * identity probes is testing the arm it names rather than accidentally testing F2: every
 * `rev-parse --show-toplevel` answers with its own cwd, and every `--git-common-dir` answers
 * with `<clone>/.git`. A test that wants a foreign or unreadable answer overrides it through
 * `answersAt`, which is keyed BY CWD because the whole point of these probes is that the
 * same argv asked in two directories must be allowed to disagree.
 */
function fakeGit(
  listed: string,
  options: {
    /** cwds whose commands REJECT — how the probe is failed without unmounting anything. */
    readonly failFrom?: readonly string[];
    /** Canned stdout per `argv.join(" ")`, for the reads whose ANSWER decides a branch. */
    readonly answers?: Readonly<Record<string, string>>;
    /** Canned stdout per cwd, then per `argv.join(" ")` — the identity probes' seam. */
    readonly answersAt?: Readonly<Record<string, Readonly<Record<string, string>>>>;
    /** The clone this fake's worktrees all belong to. */
    readonly cloneRoot?: string;
  } = {},
) {
  const calls: string[][] = [];
  const cloneRoot = options.cloneRoot ?? "/repo";
  const git = async (cwd: string, args: string[]): Promise<string> => {
    calls.push([...args]);
    if (options.failFrom?.includes(cwd) === true)
      throw new Error(`cd to '${cwd}' failed: No such file or directory`);
    if (args[0] === "worktree" && args[1] === "list") return listed;
    const argv = args.join(" ");
    const at = options.answersAt?.[cwd]?.[argv];
    if (at !== undefined) return at;
    const canned = options.answers?.[argv];
    if (canned !== undefined) return canned;
    // A healthy worktree: it answers for ITSELF, out of the clone's object store.
    if (argv === "rev-parse --show-toplevel") return `${cwd}\n`;
    if (argv === "rev-parse --path-format=absolute --git-common-dir") return `${cloneRoot}/.git\n`;
    return "";
  };
  return { git, calls };
}

/** The two identity probes every reachable registration now issues, in order — spelled once
 *  so an argv assertion below reads as "the reads, and then the arm's own". */
const IDENTITY_PROBES = [
  ["rev-parse", "--show-toplevel"],
  ["rev-parse", "--path-format=absolute", "--git-common-dir"],
  ["rev-parse", "--path-format=absolute", "--git-common-dir"],
];

describe("ensureSiblingWorktree and an unreachable registration (B4)", () => {
  it("THROWS, and issues no prune, no add and no branch write", async () => {
    const { git, calls } = fakeGit(
      listing([
        "worktree /volumes/scratch/rennet/feat/x",
        "HEAD 1111111111111111111111111111111111111111",
        "branch refs/heads/rennet/feat/x",
        "prunable gitdir file points to non-existent location",
      ]),
    );

    await expect(
      ensureSiblingWorktree(git, "/repo", "/data/worktrees/rennet/feat/x", "feat/x"),
    ).rejects.toThrow(
      /worktree for rennet\/feat\/x is registered at \/volumes\/scratch\/rennet\/feat\/x but that directory is not reachable/,
    );

    // Executed, not reasoned: the whole argv trace is one read.
    expect(calls).toEqual([["worktree", "list", "--porcelain", "-z"]]);
    expect(calls.some((argv) => argv.includes("prune"))).toBe(false);
    expect(calls.some((argv) => argv[0] === "worktree" && argv[1] === "add")).toBe(false);
    expect(calls.some((argv) => argv[0] === "branch")).toBe(false);
  });

  it("binds a REACHABLE registration as it stands, wherever git says it is", async () => {
    // The pair: the same read, with git making no prunable claim AND the probe succeeding,
    // still takes arm 1 — and still writes nothing. Without this the throw above passes for
    // a function that refuses every sibling.
    const { git, calls } = fakeGit(
      listing([
        "worktree /volumes/scratch/rennet/feat/x",
        "HEAD 1111111111111111111111111111111111111111",
        "branch refs/heads/rennet/feat/x",
      ]),
    );

    expect(
      await ensureSiblingWorktree(git, "/repo", "/data/worktrees/rennet/feat/x", "feat/x"),
    ).toEqual({
      path: "/volumes/scratch/rennet/feat/x",
      created: false,
      workBranch: "rennet/feat/x",
    });
    // The read, then the probes, and nothing else. Every one of them is a read.
    expect(calls).toEqual([["worktree", "list", "--porcelain", "-z"], ...IDENTITY_PROBES]);
  });

  it("treats an UNANNOTATED registration whose probe fails as unreachable (S1)", async () => {
    // `prunable` landed in GIT 2.36. An older git prints no annotation for a registration it
    // would happily prune, and reading that silence as "reachable" is how arm 1 records a
    // DEAD DIRECTORY as this session's `boundRoot` for its whole life — a worse outcome than
    // either honest answer, and invisible to every fixture that pastes a `prunable` line in.
    //
    // The probe runs AT THE RECORD'S OWN PATH, which is what makes it locus-aware: it asks
    // the git that owns the directory, unlike an `existsSync` on the daemon's side (the WSL
    // arrangement where `/home/u/…` is perfectly present and `existsSync` says otherwise).
    const { git, calls } = fakeGit(
      listing([
        "worktree /volumes/scratch/rennet/feat/x",
        "HEAD 1111111111111111111111111111111111111111",
        "branch refs/heads/rennet/feat/x",
      ]),
      { failFrom: ["/volumes/scratch/rennet/feat/x"] },
    );

    await expect(
      ensureSiblingWorktree(git, "/repo", "/data/worktrees/rennet/feat/x", "feat/x"),
    ).rejects.toThrow(
      /worktree for rennet\/feat\/x is registered at \/volumes\/scratch\/rennet\/feat\/x but that directory is not reachable/,
    );
    // The probe FAILED, so the identity comparisons that follow it never ran.
    expect(calls).toEqual([
      ["worktree", "list", "--porcelain", "-z"],
      ["rev-parse", "--show-toplevel"],
    ]);
  });
});

// ── P1: the branch bind, which is where the same defect was still live ─────────────────
describe("ensureBranchWorktree and an unreachable registration (P1)", () => {
  const WORKTREE = "/data/worktrees/repo/feat/x";

  it("THROWS on a registered-but-unreachable path, and issues no prune and no add", async () => {
    // THE UNMOUNTED-VOLUME CASE, which is precisely where `existsSync(<worktree>/.git)`
    // answered false: the old body pruned the registration and then checked a second copy
    // of the branch out over the mount point.
    const { git, calls } = fakeGit(
      listing([
        `worktree ${WORKTREE}`,
        "HEAD 1111111111111111111111111111111111111111",
        "branch refs/heads/feat/x",
        "prunable gitdir file points to non-existent location",
      ]),
    );

    await expect(ensureBranchWorktree(git, "/repo", WORKTREE, "feat/x")).rejects.toThrow(
      /worktree for feat\/x is registered at \/data\/worktrees\/repo\/feat\/x but that directory is not reachable/,
    );

    // Executed, not reasoned: the whole argv trace is one read.
    expect(calls).toEqual([["worktree", "list", "--porcelain", "-z"]]);
    expect(calls.some((argv) => argv.includes("prune"))).toBe(false);
    expect(calls.some((argv) => argv[0] === "worktree" && argv[1] === "add")).toBe(false);
    expect(calls.some((argv) => argv[0] === "checkout")).toBe(false);
  });

  it("uses a REACHABLE registration that is on the branch, writing nothing in it", async () => {
    // THE PAIR for every refusal in this file. Without it the throws all pass for a function
    // that refuses every branch worktree.
    const onBranch = fakeGit(
      listing([
        `worktree ${WORKTREE}`,
        "HEAD 1111111111111111111111111111111111111111",
        "branch refs/heads/feat/x",
      ]),
      { answers: { "rev-parse --abbrev-ref HEAD": "feat/x\n" } },
    );

    expect(await ensureBranchWorktree(onBranch.git, "/repo", WORKTREE, "feat/x")).toEqual({
      path: WORKTREE,
      created: false,
    });
    // Reads, and only reads. Nothing is written in the directory a session is already using.
    expect(onBranch.calls).toEqual([
      ["worktree", "list", "--porcelain", "-z"],
      ...IDENTITY_PROBES,
      ["rev-parse", "--abbrev-ref", "HEAD"],
    ]);
  });

  it("THROWS on the REVIEWER'S OWN CHECKOUT sitting at the computed path (F1)", async () => {
    // THE SIGHTED BUG. `git worktree list` includes the MAIN worktree, and a branch pattern
    // that carries no `{branch}` — `{name}` is one the write blesses — computes a path that
    // CAN be the clone root. The registration matched by path alone, the old body read HEAD,
    // saw `main`, and ran `git checkout feat/x` IN THE REVIEWER'S TREE.
    //
    // Reviewing a branch nothing has out is exactly when this arm runs, so nothing upstream
    // rules the clone out: `worktreeForBranch` found no worktree on `feat/x`, which is why we
    // are here at all.
    const { git, calls } = fakeGit(
      listing([
        "worktree /repo",
        "HEAD 1111111111111111111111111111111111111111",
        "branch refs/heads/main",
      ]),
      { answers: { "rev-parse --abbrev-ref HEAD": "main\n" } },
    );

    await expect(ensureBranchWorktree(git, "/repo", "/repo", "feat/x")).rejects.toThrow(
      /\/repo is this repository's own checkout, not a worktree Rennet placed/,
    );

    // Executed, not reasoned: the whole argv trace is reads.
    expect(calls.some((argv) => argv[0] === "checkout")).toBe(false);
    expect(calls.some((argv) => argv[0] === "worktree" && argv[1] === "add")).toBe(false);
    expect(calls.some((argv) => argv.includes("prune"))).toBe(false);
  });

  it("THROWS on another ref when NO CLAIM ORACLE IS SUPPLIED (the conservative default)", async () => {
    // The default is `() => true` — "assume a live session is working there" — because a
    // caller that cannot answer the question must not have the repair chosen on its behalf.
    // This pins the default itself: the very same fixture with an oracle that says "nobody"
    // is repaired two tests down, so the difference between them is the argument and
    // nothing else.
    const { git, calls } = fakeGit(
      listing([
        `worktree ${WORKTREE}`,
        "HEAD 1111111111111111111111111111111111111111",
        "branch refs/heads/some/other",
      ]),
      { answers: { "rev-parse --abbrev-ref HEAD": "some/other\n" } },
    );

    await expect(ensureBranchWorktree(git, "/repo", WORKTREE, "feat/x")).rejects.toThrow(
      /is already a worktree of this repository on some\/other, so Rennet will not check feat\/x out in it/,
    );
    expect(calls.some((argv) => argv[0] === "checkout")).toBe(false);
    expect(calls.some((argv) => argv[0] === "worktree" && argv[1] === "add")).toBe(false);
  });

  it("ADDS when nothing is registered at the path, with no prune first", async () => {
    // The third answer, and the one the prune was nominally there for. `worktree add`
    // refuses a path a stale admin entry still claims — which is now a THROW above rather
    // than a repo-wide prune issued blind from a bind.
    //
    // A real scratch path, because this arm `mkdir`s the parent for real before it adds.
    const scratchRoot = mkdtempSync(join(tmpdir(), "rennet-branch-bind-"));
    scratch.push(scratchRoot);
    const target = join(scratchRoot, "worktrees", "repo", "feat", "x");
    const { git, calls } = fakeGit(listing(["worktree /repo", "branch refs/heads/main"]));

    expect(await ensureBranchWorktree(git, "/repo", target, "feat/x")).toEqual({
      path: target,
      created: true,
    });
    expect(calls).toEqual([
      ["worktree", "list", "--porcelain", "-z"],
      ["worktree", "add", target, "feat/x"],
    ]);
  });
});

// ── THE DRIFTED WORKTREE: THE CLAIM DECIDES, NOT THE PLACEMENT ROOT ───────────────────
//
// Refusing every worktree on another ref was right for one of the two directories it caught
// and a permanent lockout for the other, and git cannot tell them apart — both are ordinary
// worktrees of this repository on some ref:
//
//   • A live session is bound there. Under a `{branch}`-less pattern every branch computes
//     ONE directory, so checking the wanted branch out moves that session's workspace onto
//     another branch, silently. Only Rennet knows this; it must refuse.
//   • NOBODY is bound there. A round's own agent ran `git checkout other` inside a worktree
//     Rennet placed, and every later bind on that branch threw forever, naming a setting
//     change that would not have helped.
//
// So these four tests are one fixture and four oracles.
describe("ensureBranchWorktree and a worktree that has drifted onto another ref", () => {
  const WORKTREE = "/data/worktrees/repo/feat/x";
  /** Rennet's own worktree at the computed path, checked out on something else. */
  const drifted = (ref = "some/other") =>
    fakeGit(
      listing([
        `worktree ${WORKTREE}`,
        "HEAD 1111111111111111111111111111111111111111",
        `branch refs/heads/${ref}`,
      ]),
      { answers: { "rev-parse --abbrev-ref HEAD": `${ref}\n` } },
    );

  it("CHECKS THE BRANCH OUT when no live session claims it, and adds and prunes nothing", async () => {
    const { git, calls } = drifted();

    expect(
      await ensureBranchWorktree(git, "/repo", WORKTREE, "feat/x", { claimed: () => false }),
    ).toEqual({ path: WORKTREE, created: false, repaired: true });

    // Executed, not reasoned: the argv trace is the reads, then ONE plain checkout. Not
    // `--force`, not a `reset`, not a `worktree add` over the top — git's own refusal on a
    // conflicting dirty tree is the safety, and it only exists if the checkout is plain.
    expect(calls).toEqual([
      ["worktree", "list", "--porcelain", "-z"],
      ...IDENTITY_PROBES,
      ["rev-parse", "--abbrev-ref", "HEAD"],
      ["checkout", "feat/x"],
    ]);
  });

  it("THROWS naming the path, the ref AND THE SESSION when one claims it", async () => {
    const { git, calls } = drifted();

    await expect(
      ensureBranchWorktree(git, "/repo", WORKTREE, "feat/x", {
        claimed: () => ({ sessionId: "sess-7" }),
      }),
    ).rejects.toThrow(
      /\/data\/worktrees\/repo\/feat\/x is already a worktree of this repository on some\/other, so Rennet will not check feat\/x out in it\. Session sess-7 is working there\./,
    );
    expect(calls.some((argv) => argv[0] === "checkout")).toBe(false);
    expect(calls.some((argv) => argv[0] === "worktree" && argv[1] === "add")).toBe(false);
  });

  it("names the ONE-COMMAND REMEDY, not a settings change that would not help", async () => {
    // The refusal used to say "Move it, or change this repository's worktree location or
    // layout" — advice that does nothing about a directory sitting on the wrong ref. What
    // fixes it is one command in that directory.
    const { git } = drifted();

    await expect(
      ensureBranchWorktree(git, "/repo", WORKTREE, "feat/x", { claimed: () => true }),
    ).rejects.toThrow(
      /Run `git checkout feat\/x` in that directory once nothing is working in it, or remove that worktree from this repository's Worktrees card\./,
    );
  });

  it("says A DETACHED HEAD rather than `on HEAD` for a detached occupant", async () => {
    // `rev-parse --abbrev-ref HEAD` prints the literal string `HEAD` when the worktree is
    // detached — a pull-request snapshot at a colliding computed path is exactly that — and
    // read back verbatim the refusal said "is already a worktree of this repository on HEAD",
    // a sentence with no referent.
    const { git } = fakeGit(
      listing([
        `worktree ${WORKTREE}`,
        "HEAD 1111111111111111111111111111111111111111",
        "detached",
      ]),
      { answers: { "rev-parse --abbrev-ref HEAD": "HEAD\n" } },
    );

    await expect(
      ensureBranchWorktree(git, "/repo", WORKTREE, "feat/x", { claimed: () => true }),
    ).rejects.toThrow(/is already a worktree of this repository on a detached HEAD/);
  });

  it("REFUSES THE CLONE ROOT even when the oracle says nobody claims it", async () => {
    // The control for the discriminator: the clone root is never Rennet's to check anything
    // out in, whatever the sessions say, so the oracle that unlocks the repair one test up
    // changes nothing here. Without this, "unclaimed ⇒ repair" would read as the whole rule
    // and the F1 bug — `git checkout feat/x` in the reviewer's own tree — would be back the
    // first time a reviewer had no live sessions.
    const { git, calls } = fakeGit(
      listing([
        "worktree /repo",
        "HEAD 1111111111111111111111111111111111111111",
        "branch refs/heads/main",
      ]),
      { answers: { "rev-parse --abbrev-ref HEAD": "main\n" } },
    );

    await expect(
      ensureBranchWorktree(git, "/repo", "/repo", "feat/x", { claimed: () => false }),
    ).rejects.toThrow(/\/repo is this repository's own checkout, not a worktree Rennet placed/);
    expect(calls.some((argv) => argv[0] === "checkout")).toBe(false);
  });

  it("still binds a worktree ALREADY ON THE BRANCH without asking the oracle at all", async () => {
    // The pair for all five refusals, and it proves the claim is asked only where it decides
    // something: a worktree on the branch under review is the session's workspace whoever
    // else is in it, so an oracle that claims everything must not turn that into a throw.
    const onBranch = fakeGit(
      listing([
        `worktree ${WORKTREE}`,
        "HEAD 1111111111111111111111111111111111111111",
        "branch refs/heads/feat/x",
      ]),
      { answers: { "rev-parse --abbrev-ref HEAD": "feat/x\n" } },
    );
    let asked = 0;

    expect(
      await ensureBranchWorktree(onBranch.git, "/repo", WORKTREE, "feat/x", {
        claimed: () => {
          asked += 1;
          return { sessionId: "sess-9" };
        },
      }),
    ).toEqual({ path: WORKTREE, created: false });
    expect(asked).toBe(0);
    expect(onBranch.calls.some((argv) => argv[0] === "checkout")).toBe(false);
  });
});

// ── F4: MATCHING A REGISTRATION UNDER A SYMLINKED ROOT ────────────────────────────────
//
// git prints the RESOLVED spelling of every worktree it lists; a computed placement carries
// whatever the settings ladder produced, which on macOS is `/var/…` wherever git says
// `/private/var/…` — every default `TMPDIR`, and any worktree root under one.
//
// Both binds used to match with a plain `realpath`-or-literal, which REFUSES a path that is
// missing — and the registration this question matters most about is precisely the missing
// one. So an unreachable registration under a symlinked root matched nothing, the bind fell
// through to `worktree add`, and the reviewer got git's own `fatal: … is missing but already
// registered worktree` instead of the designed sentence that names the path, gives git's
// reason, and says nothing was changed. Same comparison as the daemon's sweep now, one
// helper, one answer.
describe("a registration git spells through a resolved root (F4)", () => {
  /** A real symlink to a real directory, and a worktree path under BOTH spellings of it. */
  function symlinkedRoot(): { resolved: string; linked: string } {
    const real = realpathSync(mkdtempSync(join(tmpdir(), "rennet-symlinked-root-")));
    scratch.push(real);
    const link = join(dirname(real), `${basename(real)}-link`);
    symlinkSync(real, link);
    scratch.push(link);
    // The leaf itself never exists: an unreachable registration is a directory that is gone,
    // which is the only state this comparison is ever asked about.
    return {
      resolved: join(real, "worktrees", "repo", "feat", "x"),
      linked: join(link, "worktrees", "repo", "feat", "x"),
    };
  }

  it("the BRANCH bind throws its own designed refusal, not git's", async () => {
    const { resolved, linked } = symlinkedRoot();
    const { git, calls } = fakeGit(
      listing([
        `worktree ${resolved}`,
        "branch refs/heads/feat/x",
        "prunable gitdir file points to non-existent location",
      ]),
    );

    await expect(ensureBranchWorktree(git, "/repo", linked, "feat/x")).rejects.toThrow(
      /the worktree for feat\/x is registered at .* but that directory is not reachable/,
    );
    expect(calls).toEqual([["worktree", "list", "--porcelain", "-z"]]);
  });

  it("the SIBLING bind's occupant check sees the same registration", async () => {
    // Arm 2, the other `comparablePath` call site: a DETACHED worktree (a pull-request
    // snapshot) sitting at the computed sibling path, registered under the resolved spelling
    // and gone from disk. It has no branch, so arm 1 cannot find it — only the path match can.
    const { resolved, linked } = symlinkedRoot();
    const { git, calls } = fakeGit(
      listing([
        `worktree ${resolved}`,
        "HEAD 1111111111111111111111111111111111111111",
        "detached",
        "prunable gitdir file points to non-existent location",
      ]),
    );

    await expect(ensureSiblingWorktree(git, "/repo", linked, "feat/x")).rejects.toThrow(
      /is registered as a worktree of this repository on .* but that directory is not reachable/,
    );
    expect(calls.some((argv) => argv[0] === "worktree" && argv[1] === "add")).toBe(false);
  });
});

// ── F2: A PROBE THAT SUCCEEDS IS NOT A PROBE THAT FOUND THIS WORKTREE ──────────────────
//
// `git -C <path> rev-parse` SEARCHES UPWARDS. A registration whose own `.git` file is gone,
// sitting anywhere beneath another repository — a worktree root under the reviewer's home
// that is itself a checkout, a nested clone — answers through that PARENT. The probe
// returns 0, `unreachableReason` said "reachable", and on a git too old to print `prunable`
// (< 2.36, the entire reason the probe exists) the bind then recorded a FOREIGN repository
// as this session's workspace for its whole life. That is the wrong-repository-under-the-
// right-label failure, and it is silent.
//
// So the probe's ANSWER is compared, not just its exit code — `--show-toplevel` against the
// record's own path, and `--git-common-dir` against the clone's. Both binds ask through the
// same helper, so both refuse.
describe("a registration whose git answers for ANOTHER repository (F2)", () => {
  const WORKTREE = "/data/worktrees/repo/feat/x";
  const STALE = ["worktree /data/worktrees/repo/feat/x", "branch refs/heads/feat/x"];

  it("is UNREACHABLE to the branch bind when the toplevel is a parent repository", async () => {
    const { git, calls } = fakeGit(listing(STALE), {
      // No `prunable` — a git older than 2.36, which is the only git that reaches the probe.
      answersAt: { [WORKTREE]: { "rev-parse --show-toplevel": "/data/worktrees\n" } },
    });

    await expect(ensureBranchWorktree(git, "/repo", WORKTREE, "feat/x")).rejects.toThrow(
      /is registered at \/data\/worktrees\/repo\/feat\/x but that directory is not reachable \(git: the git there answers for \/data\/worktrees, not for this registration\)/,
    );
    expect(calls.some((argv) => argv[0] === "checkout")).toBe(false);
    expect(calls.some((argv) => argv[0] === "worktree" && argv[1] === "add")).toBe(false);
  });

  it("is UNREACHABLE to the sibling bind's arm 1 for the same reason", async () => {
    const sibling = "/data/worktrees/repo/rennet/feat/x";
    const { git, calls } = fakeGit(
      listing([`worktree ${sibling}`, "branch refs/heads/rennet/feat/x"]),
      { answersAt: { [sibling]: { "rev-parse --show-toplevel": "/data/worktrees\n" } } },
    );

    await expect(ensureSiblingWorktree(git, "/repo", sibling, "feat/x")).rejects.toThrow(
      /the git there answers for \/data\/worktrees, not for this registration/,
    );
    expect(calls.some((argv) => argv[0] === "worktree" && argv[1] === "add")).toBe(false);
    expect(calls.some((argv) => argv[0] === "branch")).toBe(false);
  });

  it("is FOREIGN when the toplevel matches but the object store is another clone's", async () => {
    // The narrower case the toplevel comparison cannot see: a whole different repository
    // cloned EXACTLY at the registered path. `--show-toplevel` answers with the path itself
    // and only the common `.git` says they are strangers.
    const { git } = fakeGit(listing(STALE), {
      answersAt: {
        [WORKTREE]: {
          "rev-parse --path-format=absolute --git-common-dir": "/elsewhere/other-repo/.git\n",
        },
      },
    });

    await expect(ensureBranchWorktree(git, "/repo", WORKTREE, "feat/x")).rejects.toThrow(
      /it belongs to another repository \(\/elsewhere\/other-repo\/\.git\), not to this one/,
    );
  });

  it("says NOTHING about identity when this git will not print an absolute common dir", async () => {
    // The honest degradation, and its control. `--path-format=absolute` needs git ≥ 2.31, and
    // joining a relative `.git` on THIS side would resolve it in the daemon's spelling against
    // a path in git's — the WSL arrangement, where every registration would then read foreign.
    // So a relative or missing answer drops the comparison instead of inventing a verdict; the
    // toplevel half above has already run and is what caught the sighted case.
    const { git } = fakeGit(listing(STALE), {
      answersAt: {
        [WORKTREE]: { "rev-parse --path-format=absolute --git-common-dir": ".git\n" },
        "/repo": { "rev-parse --path-format=absolute --git-common-dir": ".git\n" },
      },
      answers: { "rev-parse --abbrev-ref HEAD": "feat/x\n" },
    });

    expect(await ensureBranchWorktree(git, "/repo", WORKTREE, "feat/x")).toEqual({
      path: WORKTREE,
      created: false,
    });
  });
});
