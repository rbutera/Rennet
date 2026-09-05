import type { Review, T3Session } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import type { T3SidecarSupervisor } from "../t3/supervisor";
import { chatHandlers } from "./chat";
import { reviewHandlers } from "./review";
import { createDispatchRuntime, type DispatchDeps } from "./runtime";

// ─────────────────────────────────────────────────────────────────────────────
// #872: WHAT THE DAEMON SAYS WHEN A REVIEW'S CHAT THREAD DOES NOT EXIST.
//
// Two paths bind that thread and BOTH used to lose the answer. `review.capture` binds it
// fire-and-forget and swallowed the rejection (`.catch(() => undefined)`) — no dock state,
// no log line, nothing on disk, so "why did this review never get a thread" had no
// evidence anywhere to answer it from. `chat.t3Session` then re-bound synchronously and
// REJECTED on failure, which threw away the brokered session too: a healthy sidecar with
// one bad workspace surfaced as "T3 Code sidecar unavailable" and the mount never rendered.
//
// The assertions below are on what a CLIENT receives and what a warning SINK receives, not
// on a spy over `threadFor`: the bug was that neither of those two carried the fact.
//
// Hermetic — no vendored bundle. The supervisor is a stub because the thing under test is
// this layer's handling of a rejection, not the sidecar's ability to make a thread (which
// `review-thread-eager.test.ts` drives over the real server).
//
// WHAT THIS CANNOT CATCH: it does not prove the dock renders either arm — that is
// `t3-chat-dock.dom.test.tsx` and `placeholders.test.tsx` — and it cannot prove the reason
// string is intelligible to a reviewer, only that it is carried rather than dropped.
// ─────────────────────────────────────────────────────────────────────────────

const BROKERED = {
  origin: "http://127.0.0.1:43117",
  wsUrl: "ws://127.0.0.1:43117/ws",
  accessToken: "bearer-1",
  environmentId: "env-1",
} satisfies T3Session;

const REPOSITORY_ROOT = "/repos/acme/checkout";

function review(): Review {
  return {
    id: "rev-1",
    repositoryRoot: REPOSITORY_ROOT,
    activePatchsetId: "ps-1",
    dispositions: [],
    status: "current",
    patchsets: [
      {
        id: "ps-1",
        createdAt: new Date().toISOString(),
        repository: {
          id: "repo-1",
          root: REPOSITORY_ROOT,
          commonDir: `${REPOSITORY_ROOT}/.git`,
          baseRef: "main",
          baseOid: "a".repeat(40),
          headOid: "b".repeat(40),
        },
        files: [],
        rawDiff: "",
        byteLength: 0,
        truncated: false,
      },
    ],
  };
}

/** `threadFor` either mints or refuses; everything else on the supervisor is unreachable. */
function fixture(threadFor: T3SidecarSupervisor["threadFor"]) {
  const warnings: string[] = [];
  const captured = review();
  const t3Sidecar = {
    start: () => undefined,
    session: async () => BROKERED,
    threadFor,
  } as unknown as T3SidecarSupervisor;
  const rt = createDispatchRuntime({
    service: {
      reviewById: (id: string) => (id === captured.id ? captured : undefined),
      capture: async () => captured,
    },
    allowedRoots: new Set<string>([REPOSITORY_ROOT]),
    t3Sidecar,
    warn: (message: string) => warnings.push(message),
    setRepositoryDirty: () => undefined,
    startWatching: () => undefined,
  } as unknown as DispatchDeps);
  return { warnings, review$: reviewHandlers(rt), chat$: chatHandlers(rt) };
}

const refuses = (async () => {
  throw new Error("The workspace this session is bound to no longer exists: /gone");
}) as unknown as T3SidecarSupervisor["threadFor"];

const mints = (async () => ({
  kind: "session" as const,
  repositoryRoot: REPOSITORY_ROOT,
  sessionId: "rev-1",
  projectId: "proj-1",
  threadId: "thread-1",
  createdAt: new Date().toISOString(),
})) as unknown as T3SidecarSupervisor["threadFor"];

describe("chat.t3Session reports the thread's state instead of losing it", () => {
  it("hands back the brokered session AND an unavailable arm carrying the reason", async () => {
    const f = fixture(refuses);
    const session = (await f.chat$["chat.t3Session"]({ reviewId: "rev-1" })) as T3Session;
    // The whole read used to reject here, so none of these four fields reached the client.
    expect(session.origin).toBe(BROKERED.origin);
    expect(session.environmentId).toBe("env-1");
    expect(session.thread).toEqual({
      status: "unavailable",
      reason: "The workspace this session is bound to no longer exists: /gone",
    });
  });

  it("hands back a bound arm when the bind works, so the arm above is not the only answer", async () => {
    const f = fixture(mints);
    const session = (await f.chat$["chat.t3Session"]({ reviewId: "rev-1" })) as T3Session;
    expect(session.thread).toEqual({
      status: "bound",
      threadId: "thread-1",
      threadUrl: "http://127.0.0.1:43117/env-1/thread-1",
    });
  });

  it("omits the arm entirely when the caller named no review — a fact about the ASK", async () => {
    const f = fixture(mints);
    const session = (await f.chat$["chat.t3Session"]({})) as T3Session;
    expect(session.thread).toBeUndefined();
    expect(session.accessToken).toBe("bearer-1");
  });

  it("reports an unknown review through the arm rather than as a rejected session read", async () => {
    const f = fixture(mints);
    const session = (await f.chat$["chat.t3Session"]({ reviewId: "nope" })) as T3Session;
    expect(session.thread?.status).toBe("unavailable");
    expect(session.thread).toMatchObject({ reason: expect.stringContaining("Review not found") });
  });
});

describe("the capture-time bind leaves a trace when it fails", () => {
  it("warns with the review id and the reason", async () => {
    const f = fixture(refuses);
    await f.review$["review.capture"]({
      commandId: "11111111-1111-4111-8111-111111111111",
      repoPath: REPOSITORY_ROOT,
    });
    // The bind is fire-and-forget: it settles on a later microtask than the command, which
    // is the whole point — the capture never waits on the sidecar. Await the queue rather
    // than a timer, so this cannot pass by sleeping past a warning that never came.
    await new Promise((resolve) => setImmediate(resolve));
    expect(f.warnings).toHaveLength(1);
    expect(f.warnings[0]).toContain("rev-1");
    expect(f.warnings[0]).toContain("no longer exists: /gone");
  });

  it("says nothing when the bind works, so the warning above is not unconditional", async () => {
    const f = fixture(mints);
    await f.review$["review.capture"]({
      commandId: "11111111-1111-4111-8111-111111111111",
      repoPath: REPOSITORY_ROOT,
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(f.warnings).toEqual([]);
  });
});
