import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CreateThreadInput, ModelSelection, T3Client } from "./client";
import {
  bindThread,
  findBinding,
  findBindingsForSessions,
  PENDING_DELETION_MAX_ATTEMPTS,
  readBindings,
  readPendingDeletions,
  removeBindings,
  type SeatKind,
  sweepThreads,
  type ThreadBindingKey,
} from "./threads";

// The bindings file is the daemon's own record of which thread belongs to what. These drive
// it over a temp data dir with a counting stub client; the wire is proven by client.test.ts.

const SELECTION: ModelSelection = { instanceId: "claudeAgent", model: "x" } as ModelSelection;

// TWO repositories, because a workspace maps many repos to one identity: a session's own
// thread is rooted at the review's checkout while its seat threads are rooted at the
// drafting worktree, and a second review lives in a sibling repo on the same branch name.
const REPO_A = "/repos/alpha";
const WORKTREE_A = "/repos/alpha/.rennet/wt-1";
const REPO_B = "/repos/beta";
const WORKTREE_B = "/repos/beta/.rennet/wt-1";

describe("thread bindings", () => {
  let dataDir: string;
  let created: number;
  let client: T3Client;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "rennet-bindings-"));
    created = 0;
    client = {
      ensureProject: async (workspaceRoot: string) => `project:${workspaceRoot}`,
      createThread: async () => `thread-${++created}`,
    } as unknown as T3Client;
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  const bind = (
    repositoryRoot: string,
    key: ThreadBindingKey,
    sessionId?: string,
  ): ReturnType<typeof bindThread> =>
    bindThread({
      dataDir,
      client,
      repositoryRoot,
      key,
      title: "t",
      modelSelection: SELECTION,
      ...(sessionId === undefined ? {} : { sessionId }),
    });

  const seat = (generationId: string, kind: SeatKind): ThreadBindingKey => ({
    kind: "seat",
    generationId,
    seat: kind,
  });

  /** One review per repo: a session thread on the checkout, seat threads on the worktree. */
  async function twoReviews() {
    const a = {
      review: "review-a",
      session: "session-a",
      thread: await bind(REPO_A, { kind: "session", sessionId: "review-a" }),
      design: await bind(WORKTREE_A, seat("gen-a", "design"), "session-a"),
      noise: await bind(WORKTREE_A, seat("gen-a", "noise"), "session-a"),
    };
    const b = {
      review: "review-b",
      session: "session-b",
      thread: await bind(REPO_B, { kind: "session", sessionId: "review-b" }),
      design: await bind(WORKTREE_B, seat("gen-b", "design"), "session-b"),
    };
    return { a, b };
  }

  // A ROUND has its own thread (round-worker-thread), keyed on (session, operation) — and
  // it has to be swept with the session, or every archived session leaves one orphan
  // transcript per round behind it.
  it("gives each round its own thread and sweeps them with the session", async () => {
    const round = (operationId: string): ThreadBindingKey => ({
      kind: "round",
      sessionId: "session-a",
      operationId,
    });
    const chat = await bind(REPO_A, { kind: "session", sessionId: "review-a" });
    const one = await bind(REPO_A, round("op-1"));
    const two = await bind(REPO_A, round("op-2"));
    // Two rounds, two threads — and neither is the session's chat thread. Key the round on
    // the session instead of the operation and the second round reuses the first's thread.
    expect(new Set([chat.threadId, one.threadId, two.threadId]).size).toBe(3);
    // Idempotent per key, so a resumed round rebinds to its OWN thread, not a third one.
    expect((await bind(REPO_A, round("op-1"))).threadId).toBe(one.threadId);

    const owned = findBindingsForSessions(dataDir, ["session-a", "review-a"]);
    expect(owned.map((row) => row.threadId).sort()).toEqual(
      [chat.threadId, one.threadId, two.threadId].sort(),
    );
    expect(owned.filter((row) => row.kind === "round")).toHaveLength(2);
  });

  it("finds every binding a session owns, across both kinds and both checkouts", async () => {
    const { a, b } = await twoReviews();
    const found = findBindingsForSessions(dataDir, [a.session, a.review]);
    // The session thread AND both seat threads — the seat rows live under a DIFFERENT
    // repository root (the drafting worktree), which is why the lookup is not root-scoped.
    expect(found.map((row) => row.threadId).sort()).toEqual(
      [a.thread.threadId, a.design.threadId, a.noise.threadId].sort(),
    );
    expect(found.map((row) => row.kind).sort()).toEqual(["seat", "seat", "session"]);
    // Nothing of the sibling repo's review comes along.
    expect(found.map((row) => row.threadId)).not.toContain(b.thread.threadId);
    expect(found.map((row) => row.threadId)).not.toContain(b.design.threadId);
  });

  it("removes only the archived session's bindings and leaves the sibling review intact", async () => {
    const { a, b } = await twoReviews();
    expect(readBindings(dataDir)).toHaveLength(5);

    const doomed = findBindingsForSessions(dataDir, [a.session, a.review]);
    removeBindings(
      dataDir,
      doomed.map((row) => row.threadId),
    );

    expect(
      readBindings(dataDir)
        .map((row) => row.threadId)
        .sort(),
    ).toEqual([b.thread.threadId, b.design.threadId].sort());
    // The archived review's keys resolve to nothing; the sibling's still resolve.
    expect(findBinding(dataDir, REPO_A, { kind: "session", sessionId: a.review })).toBeUndefined();
    expect(findBinding(dataDir, WORKTREE_A, seat("gen-a", "design"))).toBeUndefined();
    expect(findBinding(dataDir, REPO_B, { kind: "session", sessionId: b.review })?.threadId).toBe(
      b.thread.threadId,
    );
    expect(findBinding(dataDir, WORKTREE_B, seat("gen-b", "design"))?.threadId).toBe(
      b.design.threadId,
    );
  });

  it("single-flights concurrent asks for one key: one thread, one binding", async () => {
    // The seats fan out together, and a check-then-create per caller made two threads
    // with one binding surviving; the loser's thread ran unbound. Identical concurrent
    // asks share one creation, while a different key at the same moment is still its own.
    const key = seat("gen-a", "design");
    const [first, second, other] = await Promise.all([
      bind(WORKTREE_A, key, "session-a"),
      bind(WORKTREE_A, key, "session-a"),
      bind(WORKTREE_A, seat("gen-a", "noise"), "session-a"),
    ]);
    expect(second.threadId).toBe(first.threadId);
    expect(other.threadId).not.toBe(first.threadId);
    expect(created).toBe(2);
    expect(readBindings(dataDir)).toHaveLength(2);
    // Once landed, the next ask reads the binding rather than a stale in-flight promise.
    expect((await bind(WORKTREE_A, key, "session-a")).threadId).toBe(first.threadId);
    expect(created).toBe(2);
  });

  it("creates a NEW thread for the same key after its binding was removed", async () => {
    const first = await bind(REPO_A, { kind: "session", sessionId: "review-a" });
    removeBindings(dataDir, [first.threadId]);
    const second = await bind(REPO_A, { kind: "session", sessionId: "review-a" });
    // Un-archiving restores nothing: the next use is a fresh thread, not the deleted one.
    expect(second.threadId).not.toBe(first.threadId);
    expect(created).toBe(2);
  });

  it("matches on the id, never on silence: a seat row with no owner is not swept", async () => {
    // Seat rows written before the owner field existed carry no `sessionId`. Sweeping them
    // on an id lookup would delete another session's threads.
    const orphan = await bind(WORKTREE_A, seat("gen-old", "sequence"));
    expect(orphan.sessionId).toBeUndefined();
    expect(findBindingsForSessions(dataDir, ["session-a", "review-a"])).toEqual([]);
    expect(findBindingsForSessions(dataDir, [])).toEqual([]);
  });

  it("removing is idempotent and tolerates a thread id it does not hold", async () => {
    const { a } = await twoReviews();
    removeBindings(dataDir, [a.thread.threadId, "thread-never-existed"]);
    removeBindings(dataDir, [a.thread.threadId]);
    expect(readBindings(dataDir).map((row) => row.threadId)).not.toContain(a.thread.threadId);
  });

  // ── A failed delete keeps its handle (review finding 2) ───────────────────
  //
  // Two things have to hold at once: the archived session must not keep a live binding
  // (an un-archive would rebind to a thread nobody can reach), and a transcript that
  // still exists must not lose the only handle that could delete it. The row moves to
  // `pendingDeletions` — invisible to `findBinding` — and the next sweep retries it.

  describe("sweepThreads", () => {
    it("defers a failed delete to pendingDeletions and clears it on the next sweep", async () => {
      const { a, b } = await twoReviews();
      let refuse = true;
      const attempted: string[] = [];
      const deleteThread = async (threadId: string): Promise<void> => {
        attempted.push(threadId);
        if (refuse && threadId === a.design.threadId) throw new Error("sidecar said no");
      };

      const firstPass = await sweepThreads({
        dataDir,
        ids: [a.session, a.review],
        deleteThread,
        warn: () => undefined,
      });
      expect(firstPass).toBe(2);

      // The live bindings are gone whatever the sidecar said…
      expect(findBindingsForSessions(dataDir, [a.session, a.review])).toEqual([]);
      expect(findBinding(dataDir, WORKTREE_A, seat("gen-a", "design"))).toBeUndefined();
      // …so the SAME key mints a fresh thread rather than resolving to the undeleted one.
      const rebound = await bind(WORKTREE_A, seat("gen-a", "design"), a.session);
      expect(rebound.threadId).not.toBe(a.design.threadId);
      // …and the handle to the thread that still exists survives here.
      expect(readPendingDeletions(dataDir).map((row) => row.threadId)).toEqual([a.design.threadId]);
      expect(readPendingDeletions(dataDir)[0]?.attempts).toBe(1);

      // The retry: `ids: []` is the sweep the supervisor runs when the sidecar comes back.
      refuse = false;
      attempted.length = 0;
      expect(await sweepThreads({ dataDir, ids: [], deleteThread, warn: () => undefined })).toBe(1);
      expect(attempted).toEqual([a.design.threadId]);
      expect(readPendingDeletions(dataDir)).toEqual([]);
      // The sibling review was never touched by any of this.
      expect(findBinding(dataDir, REPO_B, { kind: "session", sessionId: b.review })?.threadId).toBe(
        b.thread.threadId,
      );
    });

    it("gives up after the attempt cap so a thread the sidecar lost cannot pin the list", async () => {
      const a = await bind(REPO_A, { kind: "session", sessionId: "review-a" }, "review-a");
      const deleteThread = async (): Promise<void> => {
        throw new Error("no such thread");
      };
      // First sweep retires the binding; every later one only retries the pending row.
      for (let attempt = 1; attempt <= PENDING_DELETION_MAX_ATTEMPTS; attempt += 1) {
        const swept = await sweepThreads({
          dataDir,
          ids: attempt === 1 ? ["review-a"] : [],
          deleteThread,
          warn: () => undefined,
        });
        expect(swept).toBe(0);
        expect(readPendingDeletions(dataDir).map((row) => row.attempts)).toEqual(
          attempt === PENDING_DELETION_MAX_ATTEMPTS ? [] : [attempt],
        );
      }
      expect(readBindings(dataDir).map((row) => row.threadId)).not.toContain(a.threadId);
      // Nothing left to retry: a later sweep is a no-op, not a fresh attempt.
      expect(await sweepThreads({ dataDir, ids: [], deleteThread, warn: () => undefined })).toBe(0);
    });

    it("sweeps nothing when neither the ids nor the pending list name anything", async () => {
      let called = 0;
      const swept = await sweepThreads({
        dataDir,
        ids: ["nobody"],
        deleteThread: async () => {
          called += 1;
        },
        warn: () => undefined,
      });
      expect(swept).toBe(0);
      expect(called).toBe(0);
    });
  });
});

// ── The session's bound workspace on the thread (session-bound-workspace 5.2) ────────────
//
// T3 resolves a turn's cwd as `worktreePath ?? project.workspaceRoot`, so a thread created
// with a null worktree runs every one of its turns in the project root. These assert the
// exact `createThread` input the binding produces, because that input IS the cwd.
describe("bindThread carries the session's bound workspace", () => {
  let dataDir: string;
  let inputs: CreateThreadInput[];
  let client: T3Client;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "rennet-bound-"));
    inputs = [];
    client = {
      ensureProject: async (workspaceRoot: string) => `project:${workspaceRoot}`,
      createThread: async (input: CreateThreadInput) => {
        inputs.push(input);
        return `thread-${inputs.length}`;
      },
    } as unknown as T3Client;
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("dispatches thread.create with the bound worktree, and the PROJECT at the repository", async () => {
    // A real directory, because an absent bound workspace is refused (see below).
    const workspace = mkdtempSync(join(tmpdir(), "rennet-bound-wt-"));
    const repositoryRoot = mkdtempSync(join(tmpdir(), "rennet-bound-repo-"));
    try {
      await bindThread({
        dataDir,
        client,
        repositoryRoot,
        worktreePath: workspace,
        branch: "feat/x",
        key: { kind: "seat", generationId: "gen-1", seat: "design" },
        title: "feat/x — Design",
        modelSelection: SELECTION,
        sessionId: "session-1",
      });
      expect(inputs).toHaveLength(1);
      // One T3 project per REPOSITORY, however many worktrees of it exist; the WORKTREE is
      // what varies per session. Both halves matter: swap them and the seat's cwd is the
      // repository root while the sidecar grows a project per review worktree.
      expect(inputs[0]?.projectId).toBe(`project:${repositoryRoot}`);
      expect(inputs[0]?.worktreePath).toBe(workspace);
      expect(inputs[0]?.branch).toBe("feat/x");
    } finally {
      rmSync(workspace, { recursive: true, force: true });
      rmSync(repositoryRoot, { recursive: true, force: true });
    }
  });

  it("refuses to create a thread whose bound workspace is gone, and names the path", async () => {
    const missing = join(tmpdir(), "rennet-bound-missing-does-not-exist");
    await expect(
      bindThread({
        dataDir,
        client,
        repositoryRoot: REPO_A,
        worktreePath: missing,
        key: { kind: "session", sessionId: "s-gone" },
        title: "t",
        modelSelection: SELECTION,
      }),
    ).rejects.toThrow(missing);
    // Nothing was created and nothing was bound: a thread on a vanished workspace would run
    // every turn in the project root, which is a DIFFERENT tree, and draft from it happily.
    expect(inputs).toHaveLength(0);
    expect(findBinding(dataDir, REPO_A, { kind: "session", sessionId: "s-gone" })).toBeUndefined();
  });

  it("leaves the worktree null when no workspace is bound", async () => {
    await bindThread({
      dataDir,
      client,
      repositoryRoot: REPO_A,
      key: { kind: "session", sessionId: "s-unbound" },
      title: "t",
      modelSelection: SELECTION,
    });
    expect(inputs[0]?.worktreePath).toBeUndefined();
  });

  it("gives a legacy project-root binding a FRESH thread once the session binds a workspace", async () => {
    // The pre-wave case, and the one this whole wave exists to fix: a thread's cwd is fixed
    // when it is created, so a row written before the binding existed is a thread rooted at
    // the project. Reusing it would leave the chat and the handoff in the project root while
    // every seat of the same session ran in the bound worktree.
    const workspace = mkdtempSync(join(tmpdir(), "rennet-bound-legacy-wt-"));
    const repositoryRoot = mkdtempSync(join(tmpdir(), "rennet-bound-legacy-repo-"));
    try {
      const key = { kind: "session", sessionId: "s-legacy" } as const;
      const legacy = await bindThread({
        dataDir,
        client,
        repositoryRoot,
        key,
        title: "t",
        modelSelection: SELECTION,
      });
      expect(inputs[0]?.worktreePath).toBeUndefined();

      const rebound = await bindThread({
        dataDir,
        client,
        repositoryRoot,
        worktreePath: workspace,
        key,
        title: "t",
        modelSelection: SELECTION,
      });
      expect(rebound.threadId).not.toBe(legacy.threadId);
      expect(inputs[1]?.worktreePath).toBe(workspace);
      // The binding keys on the WORKSPACE now, which is what makes the chat thread, the
      // handoff thread and the round's turn land on ONE thread: the round reaches this seam
      // with the bound root, so a repository-keyed row would give them two.
      const found = findBinding(dataDir, workspace, key);
      expect(found?.threadId).toBe(rebound.threadId);
      expect(found?.worktreePath).toBe(workspace);
      // Asking the way the round does — the bound root as the repository root, no separate
      // workspace — resolves to that same thread rather than minting a second one.
      const asRound = await bindThread({
        dataDir,
        client,
        repositoryRoot: workspace,
        key,
        title: "t",
        modelSelection: SELECTION,
      });
      expect(asRound.threadId).toBe(rebound.threadId);
      // And the legacy row is gone from the live bindings, so nothing can find its way back
      // to the project root — but its thread is QUEUED FOR DELETION, not merely forgotten.
      // Dropping the row alone leaves an orphan transcript in the sidecar with no handle.
      expect(findBinding(dataDir, repositoryRoot, key)).toBeUndefined();
      expect(readPendingDeletions(dataDir).map((row) => row.threadId)).toEqual([legacy.threadId]);

      // And an ask for the SAME workspace reuses the thread — this is not "always recreate".
      const again = await bindThread({
        dataDir,
        client,
        repositoryRoot,
        worktreePath: workspace,
        key,
        title: "t",
        modelSelection: SELECTION,
      });
      expect(again.threadId).toBe(rebound.threadId);
      expect(inputs).toHaveLength(2);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
      rmSync(repositoryRoot, { recursive: true, force: true });
    }
  });

  it("retires a row bound to the CLONE, not only one with no workspace at all", async () => {
    // The narrow predicate (`worktreePath === undefined`) missed this: a session whose first
    // use read the binding before anything had bound one wrote a row with `worktreePath` SET
    // to the clone root. It is defined, so it survived the check, and the session ended up
    // with two threads — chat on the clone, handoff and round on the worktree.
    const workspace = mkdtempSync(join(tmpdir(), "rennet-bound-clone-wt-"));
    const repositoryRoot = mkdtempSync(join(tmpdir(), "rennet-bound-clone-repo-"));
    try {
      const key = { kind: "session", sessionId: "s-clone" } as const;
      const onClone = await bindThread({
        dataDir,
        client,
        repositoryRoot,
        worktreePath: repositoryRoot, // defined, and wrong
        key,
        title: "t",
        modelSelection: SELECTION,
      });
      const rebound = await bindThread({
        dataDir,
        client,
        repositoryRoot,
        worktreePath: workspace,
        key,
        title: "t",
        modelSelection: SELECTION,
      });
      expect(rebound.threadId).not.toBe(onClone.threadId);
      expect(findBinding(dataDir, repositoryRoot, key)).toBeUndefined();
      expect(readPendingDeletions(dataDir).map((row) => row.threadId)).toEqual([onClone.threadId]);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
      rmSync(repositoryRoot, { recursive: true, force: true });
    }
  });
});
