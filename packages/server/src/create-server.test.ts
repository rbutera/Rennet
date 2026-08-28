import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRennetServer } from "./create-server";

// Pins design D4 (no module-level singletons — two servers in one process do not
// share mutable state) and D5 (shutdown is idempotent). The handle is {dispatch,
// shutdown}; the observable per-instance state we can reach without Electron is the
// dataDir-scoped store, so distinct dataDirs must yield distinct SQLite files.
describe("createRennetServer — instance isolation + shutdown (#377)", () => {
  const dirs: string[] = [];
  const make = () => {
    const dataDir = mkdtempSync(join(tmpdir(), "rennet-server-"));
    dirs.push(dataDir);
    return createRennetServer({ dataDir, env: {} });
  };
  // `createRennetServer` is async (#378: it resolves after the WS listener is
  // listening), so every construction below awaits the handle.
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("two instances own separate dataDir-scoped stores", async () => {
    const a = await make();
    const b = await make();
    // A shared module-level store would have opened ONE sqlite; each instance opening
    // its own file under its own dataDir is the visible proof the store is instance state.
    expect(existsSync(join(dirs[0] ?? "", "rennet.sqlite"))).toBe(true);
    expect(existsSync(join(dirs[1] ?? "", "rennet.sqlite"))).toBe(true);
    expect(a.dispatch).not.toBe(b.dispatch);
    expect(a.shutdown).not.toBe(b.shutdown);
    a.shutdown();
    b.shutdown();
  });

  it("shutdown is idempotent and instance-scoped", async () => {
    const a = await make();
    const b = await make();
    // Second shutdown of the same instance is a no-op (D5), and shutting a down never
    // reaches into b — each closes only its own watcher, rehydration, and store.
    expect(() => {
      a.shutdown();
      a.shutdown();
    }).not.toThrow();
    expect(() => b.shutdown()).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The round dispatch's session, executed through the REAL server.
//
// `dispatchRound` is a closure in the composition root, so nothing had ever run its
// call site — which is why it silently lost the review id and the repository. This
// drives it end to end over a real git repo: add a project, start Current Checkout,
// stage an ask, dispatch. The round's coding turn fails for want of a harness, and
// that is fine — the session derivation runs first and is what is asserted.
// ─────────────────────────────────────────────────────────────────────────────
describe("round.dispatch mints onto the session the reads answer (the call site, run)", () => {
  const dirs: string[] = [];
  const shutdowns: (() => void)[] = [];
  afterEach(() => {
    for (const shutdown of shutdowns.splice(0)) shutdown();
    vi.unstubAllEnvs();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("takes the Current Checkout session rather than minting a second row beside it", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "rennet-round-site-"));
    // `create-server` builds its SessionStore with NO dataDir, so it defaults to
    // `~/.rennet/sessions` — a REAL user directory. Point HOME at a temp dir for the
    // duration, or this test reads and writes the machine's own sessions.
    const home = mkdtempSync(join(tmpdir(), "rennet-round-home-"));
    vi.stubEnv("HOME", home);
    // `realpathSync`, because the review's root comes from `git rev-parse --show-toplevel`
    // and macOS resolves `/var/folders` to `/private/var/folders`. A project stored under
    // the unresolved path never matches that root, and the round's session lands ungrouped.
    const repo = realpathSync(mkdtempSync(join(tmpdir(), "rennet-round-repo-")));
    dirs.push(dataDir, home, repo);
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo });
    git("init", "-b", "main");
    writeFileSync(join(repo, "a.txt"), "one\n");
    git("add", "a.txt");
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "x");
    // An uncommitted edit, so the working-tree capture has a real range to review.
    writeFileSync(join(repo, "a.txt"), "one\ntwo\n");

    const server = await createRennetServer({ dataDir, env: {} });
    shutdowns.push(server.shutdown);
    const added = (await server.dispatch("projects.add", {
      commandId: randomUUID(),
      discovery: {
        path: repo,
        kind: "repo",
        repos: [{ name: "repo", path: repo, branches: 1 }],
        primaryBranch: "main",
      },
      includedRepos: ["repo"],
      primaryBranch: "main",
    })) as { project: { id: string } };

    // The Current Checkout front door: no branch ⇒ a claim-LESS session, root-stamped,
    // holding the review. The only arm that can ever find it again is the holder arm.
    const minted = (await server.dispatch("session.mint", {
      projectId: added.project.id,
      commandId: randomUUID(),
    })) as { session: { id: string; reviewId?: string } | null };
    expect(minted.session).not.toBeNull();
    const checkoutId = minted.session?.id ?? "";
    const reviewId = minted.session?.reviewId ?? "";
    expect(reviewId).not.toBe(""); // the front door captured and ATTACHED
    expect(checkoutId).not.toBe(reviewId); // a randomUUID id, never the review's id

    // One addressed ask, so the bundle is non-empty and the round really dispatches.
    await server.dispatch("ask.stage", {
      sessionId: reviewId,
      ask: { id: randomUUID(), anchor: "the round", type: "request-change", body: "do the thing" },
    });
    const dispatched = (await server.dispatch("round.dispatch", { reviewId })) as {
      dispatched: boolean;
    };
    expect(dispatched.dispatched).toBe(true);

    // The kick runs BEHIND the command, so wait on a point that is downstream of the
    // session derivation: `dispatchRound` emits its first progress event only after
    // `enterRoundSession` has resolved. Waiting on a SEQUENCE, not a sleep.
    await vi.waitFor(
      async () => {
        const events = (await server.dispatch("session.roundEvents", { reviewId })) as {
          events: unknown[];
        };
        expect(events.events.length).toBeGreaterThan(0);
      },
      { timeout: 15_000, interval: 50 },
    );

    // The assertion: the store holds ONE session, and it is the one the click made.
    // A call site that drops the review id mints a second row here.
    const listed = (await server.dispatch("session.list", {})) as { sessions: { id: string }[] };
    expect(listed.sessions.map((s) => s.id)).toEqual([checkoutId]);
  }, 30_000);
});
