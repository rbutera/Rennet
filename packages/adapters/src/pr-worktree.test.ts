import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { escapePath } from "@rennet/core";
import { afterEach, describe, expect, it } from "vitest";
import { execaGit } from "./git-range-diff";
import {
  assertWorktreePattern,
  branchTokens,
  branchWorktreePath,
  defaultWorktreePlacement,
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

// ── The bind never prunes a registration (review finding B4) ──────────────────────────
//
// `git worktree prune` drops every registration whose gitdir points somewhere git cannot
// reach RIGHT NOW. "Unreachable" is not "gone": an unmounted volume, a network share that
// is down, a distro that is not running all read the same to git. `ensureSiblingWorktree`
// ran it first, under a comment claiming prune "touches nothing that exists" — so a
// temporarily unavailable sibling lost its registration and the very next lines re-forked
// or recreated it, and the staged-only work waiting in that directory belonged to no
// worktree when the volume came back.
//
// A FAKE git, deliberately: the claim is about the ARGV this function issues, and a real
// git cannot be made to report an unreachable directory without unmounting something.
describe("ensureSiblingWorktree and an unreachable registration (B4)", () => {
  /** `git worktree list --porcelain -z` output for one record, NUL-delimited. */
  function listing(lines: readonly string[]): string {
    return `${lines.join("\0")}\0\0`;
  }

  function fakeGit(listed: string) {
    const calls: string[][] = [];
    const git = async (_cwd: string, args: string[]): Promise<string> => {
      calls.push([...args]);
      return args[0] === "worktree" && args[1] === "list" ? listed : "";
    };
    return { git, calls };
  }

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
    // The pair: the same read, with git making no prunable claim, still takes arm 1 — and
    // still writes nothing. Without this the throw above passes for a function that refuses
    // every sibling.
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
    expect(calls).toEqual([["worktree", "list", "--porcelain", "-z"]]);
  });
});
