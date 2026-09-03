import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ModelSelection, T3Client } from "./client";
import {
  bindThread,
  findBinding,
  findBindingsForSessions,
  readBindings,
  removeBindings,
  type SeatKind,
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
});
