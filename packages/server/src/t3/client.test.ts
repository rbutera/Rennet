import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  awaitTurnSettled,
  connectT3,
  modelSelection,
  type OrchestrationThread,
  type OrchestrationThreadStreamItem,
  readTurnSettlement,
  type T3Client,
} from "./client";
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

  it("deletes a thread, and the sidecar stops resolving it", async () => {
    const projectId = await client.ensureProject(repo, "fixture");
    const threadId = await client.createThread({
      projectId,
      title: "doomed thread",
      modelSelection: modelSelection("claudeAgent", "claude-sonnet-5"),
    });
    // It exists first — otherwise "gone after delete" would pass on a thread that never was.
    const before = await readSnapshot(threadId);
    expect(before?.title).toBe("doomed thread");

    await client.deleteThread(threadId);

    // The subscription no longer yields a snapshot for it. `undefined` is either a stream
    // that ended or one that sent a non-snapshot; both mean the sidecar will not resolve it.
    expect(await readSnapshot(threadId)).toBeUndefined();
    // Deleting it again is not an error: archive must tolerate a thread already gone.
    await expect(client.deleteThread(threadId)).resolves.toBeUndefined();
  }, 30_000);

  /** The thread as the sidecar currently projects it, or `undefined` when it has none. */
  async function readSnapshot(threadId: string) {
    const iterator = client.subscribeThread(threadId)[Symbol.asyncIterator]();
    try {
      const item = await iterator.next();
      if (item.done || item.value.kind !== "snapshot") return undefined;
      return item.value.snapshot.thread;
    } catch {
      return undefined;
    } finally {
      await iterator.return?.();
    }
  }
});

// A provider stream that dies before its turn registers (drive 1.6, 2026-09-03). T3 stops
// the session with `lastError` and emits no turn lifecycle, so the settle wait must read
// the session, not just `latestTurn`. This gets its OWN sidecar: on the ubuntu CI runner
// the sidecar's RPC socket closed with 1006 right after the dead stream and every later
// test in the shared suite lost its connection (run 33744230481). On macOS the sidecar
// survives it. Until that Linux behaviour is reproduced and fixed in the vendored server,
// the proof runs on macOS only and says so here rather than pretending to run.
describe.skipIf(!bundle || process.platform !== "darwin")(
  "t3 client: a provider stream that dies before its turn registers",
  () => {
    let root: string;
    let running: RunningSidecar;
    let client: T3Client;
    let dataDir: string;

    beforeAll(async () => {
      root = mkdtempSync(join(tmpdir(), "rennet-t3-dead-provider-"));
      dataDir = join(root, "data");
      const repo = join(root, "repo");
      mkdirSync(repo, { recursive: true });
      execFileSync("git", ["init", "-q", "-b", "main", repo]);
      writeFileSync(join(repo, "README.md"), "repo\n");
      execFileSync("git", ["-C", repo, "add", "."]);
      execFileSync("git", [
        "-C",
        repo,
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@example.com",
        "commit",
        "-q",
        "-m",
        "init",
      ]);
      // A `claude` that idles briefly and then exits 1, so a turn on the Claude provider
      // fails at the stream. Not `/usr/bin/false`: that exits before the sidecar's first
      // stdin write lands, and the resulting EPIPE is an unhandled socket error that
      // kills the sidecar (close 1006) — a race in the fixture, not in the code here.
      const deadClaude = join(root, "dead-claude.sh");
      writeFileSync(deadClaude, "#!/bin/sh\nsleep 0.2\nexit 1\n", { mode: 0o755 });
      running = await spawnSidecar({
        dataDir,
        bundlePath: bundle as string,
        upstreamCommit: "test",
        env: { ...process.env, HOME: join(root, "home") },
        binaries: { claude: deadClaude },
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

    it("settles as a failed turn carrying the session error, instead of waiting forever", async () => {
      const projectId = await client.ensureProject(join(root, "repo"), "fixture");
      const threadId = await client.createThread({
        projectId,
        title: "dead claude",
        modelSelection: modelSelection("claudeAgent", "claude-sonnet-5"),
      });
      const first = await client.startTurn({
        threadId,
        text: "say hi",
        outputSchema: { type: "object" },
      });
      expect(first.previousTurnId).toBeNull();
      const outcome = await client.waitForTurnSettled(threadId, {
        after: first,
        startTimeoutMs: 15_000,
      });
      expect(outcome.state).toBe("error");
      expect(outcome.errorMessage).toMatch(/stream failed|Claude/i);
      // A dead provider registers no turn at all, so the wait names the session, and the
      // failure it names was recorded after this start, not before it.
      expect(outcome.thread.latestTurn).toBeNull();
      expect(Date.parse(outcome.thread.session?.updatedAt ?? "")).toBeGreaterThanOrEqual(
        Date.parse(first.requestedAt),
      );

      // A SECOND turn on the same thread. The thread still carries the first failure, so
      // an unscoped wait could answer with it; scoped to this start, the answer is the
      // session state recorded AFTER the second request. (T3 gives the second start a
      // different message: it refuses the schema against the dead session.)
      const second = await client.startTurn({
        threadId,
        text: "say hi again",
        outputSchema: { type: "object" },
      });
      const again = await client.waitForTurnSettled(threadId, {
        after: second,
        startTimeoutMs: 15_000,
      });
      expect(again.state).toBe("error");
      expect(again.thread.session?.updatedAt).not.toBe(outcome.thread.session?.updatedAt);
      expect(Date.parse(again.thread.session?.updatedAt ?? "")).toBeGreaterThanOrEqual(
        Date.parse(second.requestedAt),
      );
    }, 30_000);
  },
);

describe("modelSelection", () => {
  it("carries effort as the option each provider's adapter reads, and nothing when absent", () => {
    // T3's Claude adapter reads `effort` and its Codex adapter `reasoningEffort`, both off
    // `modelSelection.options`; a selection without the option lets the provider default.
    expect(modelSelection("claudeAgent", "claude-opus-5", { effort: "high" })).toEqual({
      instanceId: "claudeAgent",
      model: "claude-opus-5",
      options: [{ id: "effort", value: "high" }],
    });
    expect(modelSelection("codex", "gpt-5.6-sol", { effort: "xhigh" })).toEqual({
      instanceId: "codex",
      model: "gpt-5.6-sol",
      options: [{ id: "reasoningEffort", value: "xhigh" }],
    });
    expect(modelSelection("claudeAgent", "claude-sonnet-5")).toEqual({
      instanceId: "claudeAgent",
      model: "claude-sonnet-5",
    });
  });
});

describe("readTurnSettlement", () => {
  const activity = (kind: string, turnId: string | null, payload: unknown) => ({
    id: `${kind}:${turnId}:${JSON.stringify(payload)}`,
    tone: "info",
    kind,
    summary: kind,
    payload,
    turnId,
    createdAt: "2026-09-03T10:00:00.000Z",
  });
  const thread = (activities: unknown[]) =>
    ({ activities, messages: [], checkpoints: [] }) as unknown as OrchestrationThread;

  it("carries the turn's own context-window snapshot and the previous settlement's usage", () => {
    const drafting = { input_tokens: 50_000 };
    const t = thread([
      // Codex stamps its snapshots with no turn id; the previous turn's settlement bounds them.
      activity("context-window.updated", null, { usedTokens: 10 }),
      activity("turn.settled", "turn-1", { usage: drafting, totalCostUsd: 1 }),
      activity("context-window.updated", null, { usedTokens: 20 }),
      activity("context-window.updated", null, { usedTokens: 30 }),
      activity("turn.settled", "turn-2", { structuredOutput: {} }),
    ]);
    expect(readTurnSettlement(t, "turn-2")).toEqual({
      structuredOutput: {},
      tokenUsage: { usedTokens: 30 },
      previousUsage: { usage: drafting, totalCostUsd: 1 },
    });
    // The first turn: its own snapshot, and nothing earlier to subtract.
    expect(readTurnSettlement(t, "turn-1")).toEqual({
      usage: drafting,
      totalCostUsd: 1,
      tokenUsage: { usedTokens: 10 },
    });
    expect(readTurnSettlement(t, "turn-9")).toBeUndefined();
  });

  it("skips an earlier settlement that carried no usage and finds the one before it", () => {
    const t = thread([
      activity("turn.settled", "turn-1", { usage: { input_tokens: 5 } }),
      activity("turn.settled", "turn-2", { errorMessage: "interrupted" }),
      activity("turn.settled", "turn-3", { usage: { input_tokens: 9 } }),
    ]);
    expect(readTurnSettlement(t, "turn-3")?.previousUsage).toEqual({
      usage: { input_tokens: 5 },
    });
    expect(readTurnSettlement(t, "turn-3")?.tokenUsage).toBeUndefined();
  });
});

// The settle wait over fakes: the thread projection and the stream are scripted, so the
// cases the real bundle cannot stage without a live model (a repair on a thread that
// already holds a settlement, a stale session error) run deterministically.
describe("awaitTurnSettled", () => {
  type Item = OrchestrationThreadStreamItem;
  const T0 = "2026-09-03T10:00:00.000Z";

  function pushable() {
    const queue: Item[] = [];
    let wake: (() => void) | null = null;
    let ended: { readonly error?: unknown } | undefined;
    const iterable: AsyncIterable<Item> = {
      [Symbol.asyncIterator]: () => ({
        async next() {
          for (;;) {
            const item = queue.shift();
            if (item !== undefined) return { value: item, done: false as const };
            if (ended !== undefined) {
              if (ended.error !== undefined) throw ended.error;
              return { value: undefined, done: true as const };
            }
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
          }
        },
        async return() {
          return { value: undefined, done: true as const };
        },
      }),
    };
    const notify = () => {
      wake?.();
      wake = null;
    };
    return {
      iterable,
      push(item: Item) {
        queue.push(item);
        notify();
      },
      /** The stream ends cleanly, or with the socket's error. */
      end(error?: unknown) {
        ended = error === undefined ? {} : { error };
        notify();
      },
    };
  }

  const fakeThread = (over: Record<string, unknown>): OrchestrationThread =>
    ({
      id: "t",
      latestTurn: null,
      session: null,
      activities: [],
      messages: [],
      checkpoints: [],
      ...over,
    }) as unknown as OrchestrationThread;
  const settledActivity = (turnId: string, payload: unknown) => ({
    id: `a-${turnId}`,
    tone: "info",
    kind: "turn.settled",
    summary: "Turn settled",
    payload,
    turnId,
    createdAt: T0,
  });
  const event = (type: string): Item => ({ kind: "event", event: { type } }) as unknown as Item;
  const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

  /** A projection the test moves forward; every subscription opens on its current state. */
  function projection(initial: OrchestrationThread) {
    let current = initial;
    let stream = pushable();
    return {
      set: (thread: OrchestrationThread) => {
        current = thread;
      },
      push: (item: Item) => stream.push(item),
      end: (error?: unknown) => stream.end(error),
      deps: {
        subscribeThread: () => {
          stream = pushable();
          stream.push({ kind: "snapshot", snapshot: { thread: current } } as unknown as Item);
          return stream.iterable;
        },
        readThread: async () => current,
      },
    };
  }

  it("waits for ITS turn: the settlement already on the thread is the previous turn's", async () => {
    const drafted = fakeThread({
      latestTurn: { turnId: "turn-1", state: "completed" },
      activities: [settledActivity("turn-1", { structuredOutput: { old: true } })],
    });
    const p = projection(drafted);
    // Control: unscoped, the wait answers at once with the drafting turn — the bug.
    await expect(awaitTurnSettled("t", p.deps)).resolves.toMatchObject({
      turnId: "turn-1",
      structuredOutput: { old: true },
    });

    const wait = awaitTurnSettled("t", p.deps, {
      after: { previousTurnId: "turn-1", requestedAt: T0 },
    });
    await tick();
    p.set(fakeThread({ latestTurn: { turnId: "turn-2", state: "running" } }));
    p.push(event("thread.turn.started"));
    await tick();
    p.set(
      fakeThread({
        latestTurn: { turnId: "turn-2", state: "completed" },
        activities: [
          settledActivity("turn-1", { structuredOutput: { old: true } }),
          settledActivity("turn-2", { structuredOutput: { repaired: true } }),
        ],
      }),
    );
    p.push(event("thread.activity-appended"));
    await expect(wait).resolves.toMatchObject({
      turnId: "turn-2",
      structuredOutput: { repaired: true },
    });
  });

  it("ignores a session failure recorded before the turn was requested", async () => {
    const stale = fakeThread({
      session: {
        status: "stopped",
        activeTurnId: null,
        lastError: "old stream failed",
        updatedAt: "2026-09-03T09:59:00.000Z",
      },
    });
    const p = projection(stale);
    // Control: unscoped, the stale error is the answer.
    await expect(awaitTurnSettled("t", p.deps)).resolves.toMatchObject({
      errorMessage: "old stream failed",
    });

    const wait = awaitTurnSettled("t", p.deps, {
      after: { previousTurnId: null, requestedAt: T0 },
      startTimeoutMs: 2_000,
    });
    await tick();
    p.set(
      fakeThread({
        session: {
          status: "error",
          activeTurnId: null,
          lastError: "new stream failed",
          updatedAt: "2026-09-03T10:00:00.050Z",
        },
      }),
    );
    p.push(event("thread.session.updated"));
    await expect(wait).resolves.toMatchObject({
      state: "error",
      errorMessage: "new stream failed",
    });
  });

  it("gives up on a turn that never registers even when the stream stays silent", async () => {
    // Nothing after the opening snapshot: no turn row, session `ready`. The timeout must
    // run on its own clock, because there is no next item to check the clock behind.
    const p = projection(
      fakeThread({
        session: { status: "ready", activeTurnId: null, lastError: null, updatedAt: T0 },
      }),
    );
    await expect(
      awaitTurnSettled("t", p.deps, {
        after: { previousTurnId: null, requestedAt: T0 },
        startTimeoutMs: 50,
      }),
    ).rejects.toThrow(/never started the requested turn within 0 s \(session ready\)/);
  }, 2_000);

  it("does not lose a settle event that lands right after the start timer fired", async () => {
    // The turn registers in the gap between the timer firing and its read; the very next
    // stream item is the settlement. A wait that asked the stream for a fresh read after
    // the timer would let the earlier, orphaned read swallow that item.
    const p = projection(fakeThread({}));
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    // A slow read, so the settle event can land WHILE the timer's read is out.
    const deps = {
      ...p.deps,
      readThread: async (id: string) => {
        // What the thread showed when the read was ISSUED, delivered late.
        const seen = await p.deps.readThread(id);
        await sleep(40);
        return seen;
      },
    };
    const wait = awaitTurnSettled("t", deps, {
      after: { previousTurnId: null, requestedAt: T0 },
      startTimeoutMs: 20,
    });
    await sleep(10);
    // Registered, but no stream item about it: the timer's read is what will see it.
    p.set(fakeThread({ latestTurn: { turnId: "turn-1", state: "running" } }));
    // Timer fires at 20 ms; its read is out until 60 ms. Settle at 35 ms, inside that window.
    await sleep(25);
    p.set(
      fakeThread({
        latestTurn: { turnId: "turn-1", state: "completed" },
        activities: [settledActivity("turn-1", { structuredOutput: { seen: true } })],
      }),
    );
    p.push(event("thread.activity-appended"));
    await expect(wait).resolves.toMatchObject({
      turnId: "turn-1",
      structuredOutput: { seen: true },
    });
  }, 2_000);

  it("keeps waiting past the start timeout once the turn has registered", async () => {
    const p = projection(fakeThread({}));
    const wait = awaitTurnSettled("t", p.deps, {
      after: { previousTurnId: null, requestedAt: T0 },
      startTimeoutMs: 30,
    });
    await tick();
    p.set(fakeThread({ latestTurn: { turnId: "turn-1", state: "running" } }));
    p.push(event("thread.turn.started"));
    await new Promise((resolve) => setTimeout(resolve, 80));
    p.set(
      fakeThread({
        latestTurn: { turnId: "turn-1", state: "completed" },
        activities: [settledActivity("turn-1", { structuredOutput: { late: true } })],
      }),
    );
    p.push(event("thread.activity-appended"));
    await expect(wait).resolves.toMatchObject({
      turnId: "turn-1",
      structuredOutput: { late: true },
    });
  }, 2_000);

  it("answers after the grace even when the stream goes quiet after the lifecycle settled", async () => {
    // The lifecycle landed, the `turn.settled` activity never did, and no further stream
    // item arrives. The grace runs on a timer, not on the next item.
    const p = projection(fakeThread({ latestTurn: { turnId: "turn-1", state: "completed" } }));
    const outcome = await awaitTurnSettled("t", p.deps, { settlementGraceMs: 50 });
    expect(outcome).toMatchObject({ turnId: "turn-1", state: "completed" });
    expect(outcome.structuredOutput).toBeUndefined();
  }, 2_000);

  it("refuses a signal that is already aborted, before it subscribes", async () => {
    const p = projection(fakeThread({}));
    const subscribeThread = vi.fn(p.deps.subscribeThread);
    const controller = new AbortController();
    controller.abort();
    await expect(
      awaitTurnSettled("t", { ...p.deps, subscribeThread }, { signal: controller.signal }),
    ).rejects.toThrow(/aborted/);
    expect(subscribeThread).not.toHaveBeenCalled();
  });

  it("settles from one fresh read when the subscription ends or its socket closes", async () => {
    // The sidecar drops the RPC socket after some stream failures. What the thread shows
    // on a fresh read is still the answer: a settled turn, or a session that failed.
    const failed = fakeThread({
      session: { status: "error", activeTurnId: null, lastError: "stream failed", updatedAt: T0 },
    });
    const closed = projection(fakeThread({ latestTurn: { turnId: "turn-1", state: "running" } }));
    const wait = awaitTurnSettled("t", closed.deps);
    await tick();
    closed.set(failed);
    closed.end(new Error("SocketCloseError: 1006"));
    await expect(wait).resolves.toMatchObject({ state: "error", errorMessage: "stream failed" });

    const ended = projection(fakeThread({ latestTurn: { turnId: "turn-1", state: "running" } }));
    const cleanly = awaitTurnSettled("t", ended.deps);
    await tick();
    ended.set(
      fakeThread({
        latestTurn: { turnId: "turn-1", state: "completed" },
        activities: [settledActivity("turn-1", { structuredOutput: { done: true } })],
      }),
    );
    ended.end();
    await expect(cleanly).resolves.toMatchObject({
      turnId: "turn-1",
      structuredOutput: { done: true },
    });

    // Nothing settled on the fresh read: the wait fails and names the socket's reason.
    const unsettled = projection(
      fakeThread({ latestTurn: { turnId: "turn-1", state: "running" } }),
    );
    const still = awaitTurnSettled("t", unsettled.deps);
    await tick();
    unsettled.end(new Error("SocketCloseError: 1006"));
    await expect(still).rejects.toThrow(/stream ended before the turn settled \(SocketCloseError/);
  });

  it("removes its abort listener once the turn has settled", async () => {
    const p = projection(
      fakeThread({
        latestTurn: { turnId: "turn-1", state: "completed" },
        activities: [settledActivity("turn-1", {})],
      }),
    );
    const controller = new AbortController();
    const added = vi.spyOn(controller.signal, "addEventListener");
    const removed = vi.spyOn(controller.signal, "removeEventListener");
    await awaitTurnSettled("t", p.deps, { signal: controller.signal });
    expect(added).toHaveBeenCalledTimes(1);
    expect(removed).toHaveBeenCalledWith("abort", added.mock.calls[0]?.[1]);
  });
});
