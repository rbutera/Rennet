import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Review } from "@rennet/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveSidecarBundle } from "../t3/sidecar";
import { createT3SidecarSupervisor } from "../t3/supervisor";
import { findBinding } from "../t3/threads";
import { chatHandlers } from "./chat";
import { reviewHandlers } from "./review";
import { createDispatchRuntime, type DispatchDeps } from "./runtime";

// ─────────────────────────────────────────────────────────────────────────────
// A review binds its chat thread WHEN IT IS CAPTURED, not when the dock first looks (#849).
//
// Driven over the REAL vendored T3 server, because the thing being proved is a durable
// artifact on the other side of an RPC: `bindThread` calls `ensureProject` + `createThread`
// over the sidecar's websocket, and no fake in this repo speaks that protocol. The bundle
// is built by `pnpm check`'s own `build` target, so this runs in the gate; it skips only in
// a tree where the vendored server was never built.
//
// The proof is the persisted binding row plus the thread id the dock is later handed —
// never a spy on `threadFor`. `chat.t3Session` is dispatched exactly once, at the end,
// AFTER the assertion that the binding already exists.
//
// WHAT THIS CANNOT CATCH: it does not prove the eager bind is FASTER for a reviewer. It
// proves the ordering (bound at capture, reused at the dock); the latency it buys was
// measured separately and is not something an assertion here would see.
// ─────────────────────────────────────────────────────────────────────────────

const realBundle = resolveSidecarBundle({});

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

describe.skipIf(!realBundle)("review.capture binds the chat thread ahead of the dock", () => {
  function fixture() {
    const root = mkdtempSync(join(tmpdir(), "rennet-849-bind-"));
    cleanups.push(() =>
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
    );
    const dataDir = join(root, "data");
    // The "repository" the review is captured from. Only its path matters here: the sidecar
    // hangs a project off it, and the binding key is (that root, the review id).
    const repositoryRoot = join(root, "repo");
    mkdirSync(repositoryRoot, { recursive: true });

    // A minimal review that the command's own output schema accepts, so the handler runs
    // end to end rather than throwing at the wire boundary before the bind is reached.
    const review: Review = {
      id: "rev-1",
      repositoryRoot,
      activePatchsetId: "ps-1",
      dispositions: [],
      status: "current",
      patchsets: [
        {
          id: "ps-1",
          createdAt: new Date().toISOString(),
          repository: {
            id: "repo-1",
            root: repositoryRoot,
            commonDir: join(repositoryRoot, ".git"),
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
    const t3Sidecar = createT3SidecarSupervisor({
      dataDir,
      env: { ...process.env, HOME: join(root, "home") },
      bundlePath: realBundle as string,
      resolveBinaries: async () => ({}),
      warn: () => undefined,
    });
    cleanups.push(() => t3Sidecar.stopSync());

    let captures = 0;
    const rt = createDispatchRuntime({
      service: {
        reviewById: (id: string) => (id === review.id ? review : undefined),
        capture: async () => {
          captures += 1;
          return review;
        },
      },
      allowedRoots: new Set<string>([repositoryRoot]),
      t3Sidecar,
      setRepositoryDirty: () => undefined,
      startWatching: () => undefined,
    } as unknown as DispatchDeps);

    return {
      review,
      dataDir,
      repositoryRoot,
      t3Sidecar,
      review$: reviewHandlers(rt),
      chat$: chatHandlers(rt),
      captureCount: () => captures,
    };
  }

  it("has the thread on disk before any chat.t3Session, and hands the dock that same one", async () => {
    const f = fixture();
    // The daemon's own eager start (#849) — the same call `createRennetServer` makes.
    f.t3Sidecar.start();

    await f.review$["review.capture"]({
      commandId: "11111111-1111-4111-8111-111111111111",
      repoPath: f.repositoryRoot,
    });
    expect(f.captureCount()).toBe(1);

    // The capture's thread bind is fire-and-forget, so it lands shortly after the command
    // returns rather than inside it — that is the point: the reviewer's capture never waits
    // on the sidecar. Poll the DURABLE bindings file, which nothing but a real bind writes.
    let bound: { threadId: string } | undefined;
    await vi.waitFor(
      () => {
        bound = findBinding(f.dataDir, f.repositoryRoot, {
          kind: "session",
          sessionId: f.review.id,
        });
        expect(bound?.threadId).toBeTruthy();
      },
      { timeout: 40_000, interval: 50 },
    );

    // Only NOW does the dock ask. It must be handed the thread that already exists, not a
    // second one: a caller that assembled the binding input differently would mint another
    // and split the review's transcript across two threads.
    const session = (await f.chat$["chat.t3Session"]({ reviewId: f.review.id })) as {
      thread?: { status: string; threadId?: string; threadUrl?: string };
    };
    expect(session.thread?.status).toBe("bound");
    expect(session.thread?.threadId).toBe(bound?.threadId);
    expect(session.thread?.threadUrl).toContain(bound?.threadId as string);
  }, 90_000);
});
