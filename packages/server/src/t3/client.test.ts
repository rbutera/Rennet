import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectT3, modelSelection, type T3Client } from "./client";
import { type RunningSidecar, resolveSidecarBundle, spawnSidecar, stopSidecar } from "./sidecar";
import {
  bindThread,
  findBinding,
  type SeatKind,
  seatThreadTitle,
  type ThreadBindingKey,
} from "./threads";

// Drives the REAL vendored bundle over its RPC socket with the bearer the supervisor
// exchanged. No harness turn is started (that would spend the user's subscription); the
// contract proven here is connect, authenticate, project, thread, snapshot, diff lookup.
const bundle = resolveSidecarBundle({});

describe.skipIf(!bundle)("t3 client over the vendored sidecar", () => {
  let root: string;
  let running: RunningSidecar;
  let client: T3Client;
  let repo: string;
  let dataDir: string;

  function initRepo(name: string): string {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    execFileSync("git", ["init", "-q", "-b", "main", dir]);
    writeFileSync(join(dir, "README.md"), `${name}\n`);
    execFileSync("git", ["-C", dir, "add", "."]);
    execFileSync("git", [
      "-C",
      dir,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.com",
      "commit",
      "-q",
      "-m",
      "init",
    ]);
    return dir;
  }

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "rennet-t3-client-"));
    dataDir = join(root, "data");
    repo = initRepo("repo");
    running = await spawnSidecar({
      dataDir,
      bundlePath: bundle as string,
      upstreamCommit: "test",
      env: { ...process.env, HOME: join(root, "home") },
      binaries: {},
      readyTimeoutMs: 30_000,
    });
    client = await connectT3({
      wsUrl: `${running.origin.replace(/^http/, "ws")}/ws`,
      accessToken: running.credentials.accessToken,
    });
  }, 60_000);

  afterAll(async () => {
    await client?.close();
    await stopSidecar(dataDir);
    running?.child?.kill("SIGKILL");
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }, 30_000);

  it("answers an authenticated probe, and refuses a bad bearer", async () => {
    await expect(client.probe()).resolves.toBeUndefined();
    await expect(
      connectT3({
        wsUrl: `${running.origin.replace(/^http/, "ws")}/ws`,
        accessToken: "not-a-token",
        openTimeoutMs: 5_000,
      }).then((c) => c.probe()),
    ).rejects.toThrow();
  }, 20_000);

  it("creates ONE project when six seats ask for the same checkout at once", async () => {
    // Drive 1.6 (2026-09-03): the seats fan out together, and a read-then-create per
    // caller raced into T3's "Active project already exists" invariant. Six concurrent
    // asks must converge on one id and none may throw.
    const ids = await Promise.all(
      Array.from({ length: 6 }, (_, i) => client.ensureProject(repo, `seat ${i}`)),
    );
    expect(new Set(ids).size).toBe(1);
  }, 20_000);

  it("creates one project per checkout, then a full-access thread rooted in it", async () => {
    const projectId = await client.ensureProject(repo, "fixture");
    expect(await client.ensureProject(repo, "fixture again")).toBe(projectId);

    const threadId = await client.createThread({
      projectId,
      title: "review handoff",
      modelSelection: modelSelection("claudeAgent", "claude-sonnet-5"),
    });
    const iterator = client.subscribeThread(threadId)[Symbol.asyncIterator]();
    const first = await iterator.next();
    await iterator.return?.();
    expect(first.done).toBe(false);
    if (first.done) return;
    expect(first.value.kind).toBe("snapshot");
    if (first.value.kind !== "snapshot") return;
    const thread = first.value.snapshot.thread;
    expect(thread.id).toBe(threadId);
    expect(thread.projectId).toBe(projectId);
    expect(thread.runtimeMode).toBe("full-access");
    expect(thread.worktreePath).toBeNull();
    expect(thread.latestTurn).toBeNull();

    await expect(client.readTurnDiff(threadId, "no-such-turn")).rejects.toThrow(/no checkpoint/);
  }, 20_000);

  it("binds one thread per (repository, session): two repos on `main` resolve to two checkouts", async () => {
    const other = initRepo("other");
    // Both repos are on `main`; only the repository root tells them apart.
    const selection = modelSelection("claudeAgent", "claude-sonnet-5");
    const bind = (repositoryRoot: string, key: ThreadBindingKey, title: string) =>
      bindThread({ dataDir, client, repositoryRoot, key, title, modelSelection: selection });
    const s1: ThreadBindingKey = { kind: "session", sessionId: "s1" };
    const first = await bind(repo, s1, "s1");
    const second = await bind(other, s1, "s1");
    expect(second.threadId).not.toBe(first.threadId);
    expect(second.projectId).not.toBe(first.projectId);
    // Re-binding the same key is idempotent; a different session on the same repo is not.
    expect((await bind(other, s1, "x")).threadId).toBe(second.threadId);
    expect((await bind(other, { kind: "session", sessionId: "s2" }, "x")).threadId).not.toBe(
      second.threadId,
    );
    expect(findBinding(dataDir, other, s1)?.threadId).toBe(second.threadId);

    // The second thread's working directory is the SECOND repository's checkout: T3 resolves
    // cwd as worktreePath ?? project.workspaceRoot, and the project was created for `other`.
    const iterator = client.subscribeThread(second.threadId)[Symbol.asyncIterator]();
    const item = await iterator.next();
    await iterator.return?.();
    if (item.done || item.value.kind !== "snapshot") throw new Error("no snapshot");
    expect(item.value.snapshot.thread.projectId).toBe(second.projectId);
    expect(item.value.snapshot.thread.worktreePath).toBeNull();
    const projects = await client.ensureProject(other, "other");
    expect(projects).toBe(second.projectId);
  }, 30_000);

  it("binds one thread per (repository, generation, seat), beside the session bindings", async () => {
    const other = initRepo("seats-other");
    const selection = modelSelection("claudeAgent", "claude-sonnet-5");
    const seatKey = (generationId: string, seat: SeatKind): ThreadBindingKey => ({
      kind: "seat",
      generationId,
      seat,
    });
    const bind = (repositoryRoot: string, key: ThreadBindingKey, title: string) =>
      bindThread({ dataDir, client, repositoryRoot, key, title, modelSelection: selection });

    const design = await bind(repo, seatKey("g1", "design"), seatThreadTitle("feat/x", "design"));
    // Same generation id, same seat, DIFFERENT repository: the workspace maps many repos to
    // one identity, so nothing but the checkout tells these two apart (AGENTS.md).
    const otherDesign = await bind(
      other,
      seatKey("g1", "design"),
      seatThreadTitle("feat/x", "design"),
    );
    expect(otherDesign.threadId).not.toBe(design.threadId);
    expect(otherDesign.projectId).not.toBe(design.projectId);

    // Every axis of the key is load-bearing: seat, generation, and idempotence on re-bind.
    const sequence = await bind(repo, seatKey("g1", "sequence"), "x");
    const nextGeneration = await bind(repo, seatKey("g2", "design"), "x");
    expect(new Set([design, sequence, nextGeneration].map((b) => b.threadId)).size).toBe(3);
    expect((await bind(repo, seatKey("g1", "design"), "x")).threadId).toBe(design.threadId);

    // The pre-existing session binding on the same repo is untouched and still resolves.
    const session: ThreadBindingKey = { kind: "session", sessionId: "s1" };
    expect(findBinding(dataDir, repo, session)).toBeDefined();
    expect(findBinding(dataDir, repo, session)?.threadId).not.toBe(design.threadId);
    // A seat key never matches a session row and vice versa.
    expect(findBinding(dataDir, repo, seatKey("g1", "design"))?.threadId).toBe(design.threadId);
    expect(findBinding(dataDir, repo, seatKey("g9", "design"))).toBeUndefined();

    // The title names the branch and the lens, so the sidecar's own list reads sensibly.
    expect(seatThreadTitle("feat/x", "flagged-codex")).toBe("feat/x — Flagged (Codex)");
    const iterator = client.subscribeThread(design.threadId)[Symbol.asyncIterator]();
    const item = await iterator.next();
    await iterator.return?.();
    if (item.done || item.value.kind !== "snapshot") throw new Error("no snapshot");
    expect(item.value.snapshot.thread.title).toBe("feat/x — Design");
  }, 30_000);
});
