import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "@rennet/adapters";
import type { SessionModel } from "@rennet/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  configureSessionContext,
  createSessionContextPurger,
  purgeSessionContext,
  type SessionContextFile,
  sessionContextDir,
  sweepOrphanedSessionContext,
  writeRunScopedContext,
  writeSessionContext,
} from "./context-files";
import { createDispatchRuntime, type DispatchDeps } from "./dispatch/runtime";
import { sessionHandlers } from "./dispatch/session";
import { sweepIfArchived } from "./t3/threads";

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0))
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

/** This suite's daemon identity: what lands in every `.owner` unless a test says otherwise. */
const THIS_DAEMON = "/data/this-daemon";
beforeEach(() => {
  configureSessionContext({ owner: THIS_DAEMON, visibilityOf: () => "local" });
});

/** Overwrite a directory's `.owner` stamp, to stand in for another daemon's write. */
function stampOwner(root: string, sessionId: string, stamp: string): void {
  writeFileSync(join(sessionContextDir(root, sessionId), ".owner"), `${stamp}\n`);
}

function scratchDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

const files: readonly SessionContextFile[] = [
  {
    name: "round.json",
    body: JSON.stringify({ asks: ["ask-1"], reportBoard: "report-1" }),
    holds: "the asks this round dispatched and the frozen report board.",
    readWhen: "before drafting a regeneration.",
  },
  {
    name: "boards/design.json",
    body: JSON.stringify({ lens: "design", claims: [] }),
    holds: "the Design board as it was drafted.",
    readWhen: "when composing the review.",
  },
];

describe("writeSessionContext (session-context-files 2.2)", () => {
  it("writes the files and a README index naming each one, what it holds and when to read it", () => {
    const root = scratchDir("rennet-ctx-write-");

    const dir = writeSessionContext(root, "sess-1", files);

    expect(dir).toBe(sessionContextDir(root, "sess-1"));
    expect(JSON.parse(readFileSync(join(dir, "round.json"), "utf8"))).toEqual({
      asks: ["ask-1"],
      reportBoard: "report-1",
    });
    // A nested name creates its directory rather than throwing.
    expect(existsSync(join(dir, "boards", "design.json"))).toBe(true);

    const index = readFileSync(join(dir, "README.md"), "utf8");
    // One line per file, carrying all three facts the spec requires.
    for (const file of files) {
      const line = index.split("\n").find((row) => row.includes(file.name));
      expect(line).toBeDefined();
      expect(line).toContain(file.holds);
      expect(line).toContain(file.readWhen);
    }
  });

  it("carries earlier entries forward, so a later turn's write cannot orphan them", () => {
    // Several turn kinds write into ONE session directory at different moments (a seat's
    // context, then a verification turn's pointers). Each write re-renders the index; a
    // re-render that only listed its own files would leave a directory listing that lies
    // about its own directory, while the earlier prompts still name those files.
    const root = scratchDir("rennet-ctx-merge-");
    writeSessionContext(root, "sess-1", files);
    const dir = writeSessionContext(root, "sess-1", [
      {
        name: "verification/F1.json",
        body: JSON.stringify({ turn: "finding-verification" }),
        holds: "where one finding's code is.",
        readWhen: "before verifying that finding.",
      },
    ]);

    const index = readFileSync(join(dir, "README.md"), "utf8");
    expect(index).toContain("`round.json`");
    expect(index).toContain("`boards/design.json`");
    expect(index).toContain("`verification/F1.json`");
    // And a re-write of an existing name replaces its entry rather than doubling it.
    writeSessionContext(
      root,
      "sess-1",
      files.slice(0, 1).map((file) => ({ ...file, holds: "the asks, restated." })),
    );
    const rewritten = readFileSync(join(dir, "README.md"), "utf8");
    expect(rewritten.split("\n").filter((row) => row.includes("`round.json`"))).toHaveLength(1);
    expect(rewritten).toContain("the asks, restated.");
    expect(rewritten).toContain("`verification/F1.json`");
  });

  it("ensures the managed ignore block BEFORE the first file lands", () => {
    const root = scratchDir("rennet-ctx-ignore-");

    writeSessionContext(root, "sess-1", files);

    const ignore = readFileSync(join(root, ".rennet", ".gitignore"), "utf8");
    expect(ignore).toContain("context/");
    expect(ignore).toContain("rennet-managed");
  });
});

describe("purgeSessionContext (session-context-files 2.2)", () => {
  it("removes the directory, and is a no-op for a session that never had one", () => {
    const root = scratchDir("rennet-ctx-purge-");
    writeSessionContext(root, "sess-1", files);
    writeSessionContext(root, "sess-2", files);

    expect(purgeSessionContext(root, "sess-1")).toBe(true);
    expect(existsSync(sessionContextDir(root, "sess-1"))).toBe(false);
    // The sibling session's files are untouched — the purge is per session, not per root.
    expect(existsSync(sessionContextDir(root, "sess-2"))).toBe(true);

    // Absent directory: answers false, never throws (an archive may not fail on scratch).
    expect(() => purgeSessionContext(root, "never-existed")).not.toThrow();
    expect(purgeSessionContext(root, "never-existed")).toBe(false);
    expect(() => purgeSessionContext(join(root, "no-such-root"), "sess-1")).not.toThrow();
  });
});

describe("archive purges the session's context (session-context-files 2.2)", () => {
  /** The `session.archive` handler over a stub store, with the purge dep the host wires. */
  function archiveDispatch(root: string) {
    const purged: string[] = [];
    const rt = createDispatchRuntime({
      service: { reviewById: () => undefined },
      sessions: {
        list: () => [],
        setArchived: (id: string, archived: boolean) => ({
          id,
          projectId: "p1",
          title: "t",
          target: "your-branch" as const,
          createdAt: 1,
          ...(archived ? { archived: true } : {}),
        }),
      },
      purgeSessionContext: (sessionId: string) => {
        purged.push(sessionId);
        purgeSessionContext(root, sessionId);
      },
    } as unknown as DispatchDeps);
    return { handlers: sessionHandlers(rt), purged };
  }

  it("purges on archive, and leaves the files alone on un-archive (control)", async () => {
    const root = scratchDir("rennet-ctx-archive-");
    writeSessionContext(root, "sess-1", files);
    const { handlers, purged } = archiveDispatch(root);

    // The control first: un-archiving is NOT the deletion boundary, so nothing is purged.
    await handlers["session.archive"]({ sessionId: "sess-1", archived: false });
    expect(purged).toEqual([]);
    expect(existsSync(sessionContextDir(root, "sess-1"))).toBe(true);

    await handlers["session.archive"]({ sessionId: "sess-1", archived: true });
    expect(purged).toEqual(["sess-1"]);
    expect(existsSync(sessionContextDir(root, "sess-1"))).toBe(false);
  });

  it("the round's re-sweep purges a session archived under it, and skips a live one (control)", async () => {
    const root = scratchDir("rennet-ctx-resweep-");
    writeSessionContext(root, "live", files);
    writeSessionContext(root, "archived", files);
    const forget = async () => 0;
    const purge = (sessionId: string) => void purgeSessionContext(root, sessionId);

    // A round that outlived an archive wrote its context AFTER `session.archive` purged.
    await sweepIfArchived({ id: "archived", archivedAt: 42 }, forget, purge);
    expect(existsSync(sessionContextDir(root, "archived"))).toBe(false);

    // Control: the ordinary live session keeps every file its next turn will read.
    await sweepIfArchived({ id: "live" }, forget, purge);
    expect(existsSync(sessionContextDir(root, "live"))).toBe(true);
  });
});

describe("sweepOrphanedSessionContext (session-context-files 2.2)", () => {
  /** The sweep input the composition root builds, from the same two sets it uses. */
  const store = (persisted: readonly string[], archived: readonly string[] = []) => ({
    persistedIds: new Set(persisted),
    archivedIds: new Set(archived),
  });

  it("removes a crashed session's directory at start, keeps a live one, and logs the count", () => {
    const rootA = scratchDir("rennet-ctx-sweepa-");
    const rootB = scratchDir("rennet-ctx-sweepb-");
    writeSessionContext(rootA, "gone", files);
    writeSessionContext(rootA, "alive", files);
    // The second repo of a workspace: `openPath` names only the first, so a sweep that
    // looked at project roots alone would leave this one behind forever.
    writeSessionContext(rootB, "also-gone", files);
    const logged: string[] = [];

    const removed = sweepOrphanedSessionContext([rootA, rootB], store(["alive"]), (message) =>
      logged.push(message),
    );

    expect(removed).toBe(2);
    expect(existsSync(sessionContextDir(rootA, "gone"))).toBe(false);
    expect(existsSync(sessionContextDir(rootB, "also-gone"))).toBe(false);
    // Control: matching is on a POSITIVE contradiction (the id is absent from the store),
    // so a session the store still holds keeps its files.
    expect(existsSync(sessionContextDir(rootA, "alive"))).toBe(true);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain("2");
  });

  it("says nothing and removes nothing when every directory belongs to a live session", () => {
    const root = scratchDir("rennet-ctx-sweepc-");
    writeSessionContext(root, "alive", files);
    const logged: string[] = [];

    expect(sweepOrphanedSessionContext([root], store(["alive"]), (m) => logged.push(m))).toBe(0);
    expect(logged).toEqual([]);
    // A root with no context directory at all is skipped, not a throw.
    expect(sweepOrphanedSessionContext([join(root, "nope")], store([]))).toBe(0);
  });

  it("LEAVES a directory another daemon wrote, and says so, while removing its own orphan", () => {
    const root = scratchDir("rennet-ctx-sweepowner-");
    // The other daemon — a dev daemon beside the packaged app, its own data dir and its
    // own session store, in which `theirs` is a LIVE session it is mid-turn on.
    configureSessionContext({ owner: "/data/other-daemon", visibilityOf: () => "local" });
    writeSessionContext(root, "theirs", files);
    configureSessionContext({ owner: THIS_DAEMON, visibilityOf: () => "local" });
    writeSessionContext(root, "mine-gone", files);
    const logged: string[] = [];

    // This daemon's store knows neither id: theirs it has never heard of, mine crashed.
    const removed = sweepOrphanedSessionContext([root], store([]), (m) => logged.push(m));

    expect(removed).toBe(1);
    // The load-bearing assertion: the other daemon's live session survives this start.
    expect(existsSync(sessionContextDir(root, "theirs"))).toBe(true);
    // Control: identical shape, identical absence from the store — only the owner differs,
    // and this one goes. Without the stamp both would have been deleted.
    expect(existsSync(sessionContextDir(root, "mine-gone"))).toBe(false);
    expect(logged.some((line) => line.includes("does not own"))).toBe(true);
  });

  it("LEAVES a directory a LIVE daemon sharing this data dir wrote (review finding 3)", () => {
    const root = scratchDir("rennet-ctx-sweepincarnation-");
    // The case the data-dir stamp could not see: a second daemon over the same repo AND
    // the same data dir — a dev run pointed at the packaged app's `~/.rennet`. Its stamp
    // matched ours exactly, so each read the other's live directories as its own crash
    // orphans and deleted them mid-turn.
    //
    // `process.pid` is the one pid this test can prove is alive: it is this process.
    // `startedAt` differs from ours, so this is a DIFFERENT incarnation of the same data
    // dir that is nonetheless running.
    writeSessionContext(root, "live-sibling", files);
    stampOwner(root, "live-sibling", `${THIS_DAEMON}\t${process.pid}\t1`);
    // ...and a dead one of the same data dir, which IS ours to reclaim. Pid 1 is init and
    // always alive, so the dead pid has to be one nothing can be running under: a pid
    // above the platform maximum never resolves.
    writeSessionContext(root, "dead-sibling", files);
    stampOwner(root, "dead-sibling", `${THIS_DAEMON}\t4194305\t1`);
    const logged: string[] = [];

    // Neither id is in this daemon's store — the "orphan" contradiction fires for both,
    // so ONLY the liveness check separates them.
    const removed = sweepOrphanedSessionContext([root], store([]), (m) => logged.push(m));

    expect(removed).toBe(1);
    // The load-bearing assertion: a live sibling's directory survives the sweep.
    expect(existsSync(sessionContextDir(root, "live-sibling"))).toBe(true);
    // Control: identical data dir, identical absence from the store — only the pid's
    // liveness differs, and this one goes. Before the incarnation stamp BOTH went.
    expect(existsSync(sessionContextDir(root, "dead-sibling"))).toBe(false);
    expect(logged.some((line) => line.includes("live sibling"))).toBe(true);
  });

  it("LEAVES a directory whose stamp predates the incarnation format", () => {
    const root = scratchDir("rennet-ctx-sweeplegacy-");
    writeSessionContext(root, "legacy", files);
    stampOwner(root, "legacy", THIS_DAEMON); // the old bare-data-dir stamp

    // An unreadable stamp cannot say whose the directory is, and "I cannot tell" is not a
    // positive contradiction. The next write by whoever owns it re-stamps and reclaims it.
    expect(sweepOrphanedSessionContext([root], store([]), () => undefined)).toBe(0);
    expect(existsSync(sessionContextDir(root, "legacy"))).toBe(true);
  });

  it("LEAVES a directory whose store record is MALFORMED — raw ids, not the parsed list", () => {
    const root = scratchDir("rennet-ctx-sweepmalformed-");
    const storeDir = scratchDir("rennet-ctx-sweepmalformed-store-");
    const sessions = new SessionStore(storeDir);
    const record = (id: string): SessionModel => ({
      id,
      projectId: "p1",
      threads: [],
      createdAt: 1,
    });
    sessions.save(record("intact"));
    sessions.save(record("corrupt"));
    // A half-written file, a truncated write, a hand-edit: the record is on disk and the
    // session is alive; only its JSON will not parse.
    writeFileSync(join(storeDir, "corrupt.json"), '{"id": "corr');
    writeSessionContext(root, "intact", files);
    writeSessionContext(root, "corrupt", files);

    // Exactly what the composition root passes: RAW ids, plus the parsed archived set.
    expect(sessions.list().map((session) => session.id)).toEqual(["intact"]); // `list()` drops it
    expect(sessions.persistedIds().sort()).toEqual(["corrupt", "intact"]); // the file is there
    const removed = sweepOrphanedSessionContext(
      [root],
      { persistedIds: new Set(sessions.persistedIds()), archivedIds: new Set() },
      () => undefined,
    );

    expect(removed).toBe(0);
    expect(existsSync(sessionContextDir(root, "corrupt"))).toBe(true);
    // CONTROL: the same sweep fed `list()` — which is what the sweep used to be given —
    // deletes the live session's files, and its silence reads as proof it was gone.
    expect(
      sweepOrphanedSessionContext(
        [root],
        { persistedIds: new Set(sessions.list().map((s) => s.id)), archivedIds: new Set() },
        () => undefined,
      ),
    ).toBe(1);
    expect(existsSync(sessionContextDir(root, "corrupt"))).toBe(false);
    expect(existsSync(sessionContextDir(root, "intact"))).toBe(true);
  });

  it("purges a directory the store marks ARCHIVED — the crash between setArchived and purge", () => {
    const root = scratchDir("rennet-ctx-sweeparchived-");
    writeSessionContext(root, "archived", files);
    writeSessionContext(root, "live", files);

    // Both ids are persisted, so the "id is gone" contradiction does not fire for either;
    // only the archive mark separates them. Without it the archived directory survives
    // every start forever, because nothing will ever run `session.archive` again.
    const removed = sweepOrphanedSessionContext(
      [root],
      store(["archived", "live"], ["archived"]),
      () => undefined,
    );

    expect(removed).toBe(1);
    expect(existsSync(sessionContextDir(root, "archived"))).toBe(false);
    expect(existsSync(sessionContextDir(root, "live"))).toBe(true); // control
  });
});

// ── The purge and ANY turn still reading (review findings 2 and 4) ───────────

describe("createSessionContextPurger", () => {
  it("DEFERS the archive purge while a round is in flight, and the round's settle performs it", () => {
    const root = scratchDir("rennet-ctx-inflight-");
    writeSessionContext(root, "sess-1", files);
    const purger = createSessionContextPurger(() => root);

    // Order A — archive lands DURING a round. `session.archive` awaits the session's
    // preparation, but nothing tracks a round, so purging now deletes the directory the
    // round's very next turn reads.
    const settle = purger.turnInFlight("sess-1");
    expect(purger.purge("sess-1")).toBe(false);
    expect(existsSync(sessionContextDir(root, "sess-1"))).toBe(true);

    // The RELEASE performs the deferred purge — not a later `purge` call. The utility
    // turns have no `sweepIfArchived` leg to run one, so a lease that merely refused and
    // forgot would leave an archived session's files in the reviewer's checkout until a
    // daemon restart (review finding 2).
    settle();
    expect(existsSync(sessionContextDir(root, "sess-1"))).toBe(false);
  });

  it("purges IMMEDIATELY when no turn is in flight (order B: turn finished, then archive)", () => {
    const root = scratchDir("rennet-ctx-inflight2-");
    writeSessionContext(root, "sess-1", files);
    const purger = createSessionContextPurger(() => root);

    purger.turnInFlight("sess-1")();

    expect(purger.purge("sess-1")).toBe(true);
    expect(existsSync(sessionContextDir(root, "sess-1"))).toBe(false);
  });

  it("counts overlapping turns: the first to settle does not free the second's files", () => {
    const root = scratchDir("rennet-ctx-inflight3-");
    writeSessionContext(root, "sess-1", files);
    const purger = createSessionContextPurger(() => root);

    // A round and a refine on one session, or two verification legs — the shape the
    // counter exists for.
    const first = purger.turnInFlight("sess-1");
    const second = purger.turnInFlight("sess-1");
    first();
    first(); // idempotent: a release called twice must not free the turn still running
    expect(purger.purge("sess-1")).toBe(false);
    expect(existsSync(sessionContextDir(root, "sess-1"))).toBe(true);

    // Still held by `second`, so nothing has been deleted yet...
    second();
    // ...and the LAST release is what performs it.
    expect(existsSync(sessionContextDir(root, "sess-1"))).toBe(false);
  });

  it("releases a lease with no archive behind it WITHOUT purging — a live session keeps its files", () => {
    const root = scratchDir("rennet-ctx-inflight4-");
    writeSessionContext(root, "sess-1", files);
    const purger = createSessionContextPurger(() => root);

    // The control for the test above: the release only purges when an archive ASKED. A
    // release that purged unconditionally would delete a live session's context between
    // two of its own turns.
    purger.turnInFlight("sess-1")();
    expect(existsSync(sessionContextDir(root, "sess-1"))).toBe(true);
  });
});

// ── Run-scoped context (review finding 3) ─────────────────────────────────────

describe("writeRunScopedContext", () => {
  it("writes under the session directory, stays out of the index, and discards on demand", () => {
    const root = scratchDir("rennet-ctx-runscoped-");
    writeSessionContext(root, "sess-1", files);

    const written = writeRunScopedContext(root, "sess-1", "candidates-abc.json", "[]\n");

    // Under the SESSION's directory, so the archive purge covers it even if the turn that
    // reads it never returns — and named RELATIVE to the bound root with `/` separators,
    // because that string goes into a prompt verbatim and the seat's cwd IS that root. An
    // absolute path is the daemon's own locus, unopenable from a WSL distro seat
    // (review finding 4).
    expect(written.path).toBe(".rennet/context/sess-1/candidates-abc.json");
    expect(written.path.startsWith(root)).toBe(false);
    expect(written.path).not.toContain("\\");
    expect(readFileSync(join(root, written.path), "utf8")).toBe("[]\n");
    // Not in the index: the index tells a turn what it will find, and this file is gone
    // the moment the turn it was written for returns.
    expect(
      readFileSync(join(sessionContextDir(root, "sess-1"), "README.md"), "utf8"),
    ).not.toContain("candidates-abc.json");

    written.discard();
    expect(existsSync(join(root, written.path))).toBe(false);
    expect(() => written.discard()).not.toThrow(); // idempotent
    // The session's own files are untouched — discard removes one file, not the directory.
    expect(existsSync(join(sessionContextDir(root, "sess-1"), "round.json"))).toBe(true);
  });

  it("is purged with the session when the turn never returns to discard it", () => {
    const root = scratchDir("rennet-ctx-runscoped2-");
    const written = writeRunScopedContext(root, "sess-1", "candidates-abc.json", "[]\n");

    expect(purgeSessionContext(root, "sess-1")).toBe(true);
    expect(existsSync(join(root, written.path))).toBe(false);
  });
});

// ── Never staged (session-context-files, "Context is never staged") ───────────
//
// The assertion that matters runs a REAL `git add -A` in a REAL repository, because the
// claim is about what git's index does, not about what a string contains. The control is
// the same repository with the `context/` line taken back out of the managed block: the
// file IS staged then, which is what proves the entry is load-bearing rather than the
// `.rennet/` prefix or some ambient ignore doing the work.

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" });
}

function initRepo(prefix: string): string {
  const repo = scratchDir(prefix);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test");
  writeFileSync(join(repo, "README.md"), "a repo\n");
  return repo;
}

const stagedPaths = (repo: string): string[] =>
  git(repo, "diff", "--cached", "--name-only").split("\n").filter(Boolean);

describe("a context file is never staged", () => {
  it("survives `git add -A` unstaged", () => {
    const repo = initRepo("rennet-ctx-git-");

    writeSessionContext(repo, "sess-1", files);
    git(repo, "add", "-A");

    const staged = stagedPaths(repo);
    expect(staged).toContain("README.md"); // the add really ran
    expect(staged.some((path) => path.startsWith(".rennet/context/"))).toBe(false);
  });

  it("on a `git-visible` repo the map stays stageable and only `context/` is ignored", () => {
    const repo = initRepo("rennet-ctx-git-visible-");
    // The reviewer's choice: derived data is theirs to commit. This is the state the
    // visibility switch leaves on disk.
    mkdirSync(join(repo, ".rennet", "map"), { recursive: true });
    writeFileSync(join(repo, ".rennet", "map", "manifest.json"), "{}\n");
    configureSessionContext({ owner: THIS_DAEMON, visibilityOf: () => "git-visible" });

    writeSessionContext(repo, "sess-1", files);

    // `git status --porcelain --untracked-files=all` is git's own answer to "what would an
    // add pick up", so this is the reviewer's real view, not a string in a file.
    const status = git(repo, "status", "--porcelain", "--untracked-files=all")
      .split("\n")
      .filter(Boolean);
    // The regression: writing session context must not re-ignore the map on a repo the
    // reviewer set to git-visible, while the settings store still says git-visible.
    expect(status.some((line) => line.endsWith(".rennet/map/manifest.json"))).toBe(true);
    expect(status.some((line) => line.includes(".rennet/context/"))).toBe(false);
    // And git agrees about which one is excluded, by name.
    expect(git(repo, "check-ignore", "-v", ".rennet/context/sess-1/round.json")).toContain(
      "context/",
    );
  });

  it("CONTROL: with the `context/` entry removed, the same add DOES stage it", () => {
    const repo = initRepo("rennet-ctx-git-control-");

    writeSessionContext(repo, "sess-1", files);
    // Exactly the one line under test, taken back out. Everything else is identical.
    const ignorePath = join(repo, ".rennet", ".gitignore");
    const withoutEntry = readFileSync(ignorePath, "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "context/")
      .join("\n");
    mkdirSync(join(repo, ".rennet"), { recursive: true });
    writeFileSync(ignorePath, withoutEntry);
    git(repo, "add", "-A");

    expect(stagedPaths(repo)).toContain(".rennet/context/sess-1/round.json");
  });
});
