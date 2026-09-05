// @vitest-environment happy-dom

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { transferableAbortController } from "node:util";
import {
  GitCaptureAdapter,
  RoundOperationStore,
  SessionStore,
  SqliteReviewStore,
  saveScoutFacts,
  snapshotStoreFor,
} from "@rennet/adapters";
import { memoryHistory, RennetRouterApp } from "@rennet/app-ui";
import { WsRennetBridge } from "@rennet/client";
import { attachReview, escapePath, mintSession, ReviewService } from "@rennet/core";
import { parseCommandOutput } from "@rennet/protocol";
import { createRennetServer, type RennetServer } from "@rennet/server";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const WORKER_FAILURE = "the coding turn was killed by SIGTERM";
const directories: string[] = [];
const servers: RennetServer[] = [];
const bridges: WsRennetBridge[] = [];

function git(root: string, ...arguments_: string[]): string {
  return execFileSync("git", arguments_, { cwd: root, encoding: "utf8" }).trim();
}

function createRepository(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rennet-failed-worker-repo-")));
  directories.push(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "user.name", "Rennet Test");
  writeFileSync(join(root, "reviewed.txt"), "base\n");
  git(root, "add", "reviewed.txt");
  git(root, "commit", "-qm", "base");
  writeFileSync(join(root, "reviewed.txt"), "base\nreviewed change\n");
  return root;
}

function useNodeAbortGlobals(): void {
  // Execa requires Node's EventTarget; happy-dom installs its own incompatible AbortSignal.
  const controller = transferableAbortController();
  vi.stubGlobal("AbortController", controller.constructor);
  vi.stubGlobal("AbortSignal", controller.signal.constructor);
}

afterEach(() => {
  cleanup();
  for (const bridge of bridges.splice(0)) bridge.close();
  for (const server of servers.splice(0).reverse()) server.shutdown();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

// Rennet runs no gate of its own any more (round-worker-thread), so the failure this proves
// a cold reattach over is the WORKER's own — the first step that can fail and the one whose
// receipt a reviewer has to be able to come back to.
describe.skipIf(process.platform === "win32")("a failed production round worker", () => {
  it("survives daemon restart as the failed UI receipt without replaying the worker", async () => {
    useNodeAbortGlobals();
    const repository = createRepository();
    const dataDir = mkdtempSync(join(tmpdir(), "rennet-failed-worker-data-"));
    const home = mkdtempSync(join(tmpdir(), "rennet-failed-worker-home-"));
    directories.push(dataDir, home);
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);

    let workerCalls = 0;
    const runRoundTurn = async ({ repoRoot }: { readonly repoRoot: string }) => {
      workerCalls += 1;
      writeFileSync(join(repoRoot, "worker.txt"), "worker change\n");
      return {
        status: "failed" as const,
        reason: WORKER_FAILURE,
        turnDiff: "diff --git a/worker.txt b/worker.txt\nnew file mode 100644\n+worker change\n",
        filesTouched: ["worker.txt"],
      };
    };
    const env = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      RENNET_DISABLE_HARNESS: "1",
    };

    // Seed only the pre-round persisted identities. The proof begins at production dispatch;
    // unrelated first-board drafting would add model work without strengthening this seam.
    const capture = new GitCaptureAdapter();
    const patchset = await capture.capture(repository);
    const reviewStore = new SqliteReviewStore(join(dataDir, "rennet.sqlite"));
    const reviewService = new ReviewService(capture, reviewStore);
    const review = await reviewService.createReviewFromPatchset(randomUUID(), patchset);
    reviewStore.close();
    // With no stored Project, production keys this ungrouped review by its repo root.
    // Both daemons resolve the same holder without booting unrelated project rehydration.
    const projectId = review.repositoryRoot;
    const session = attachReview(
      {
        ...mintSession(projectId, { id: () => "session-failed-worker", now: () => 1 }),
        repositoryRoot: review.repositoryRoot,
      },
      review.id,
    );
    new SessionStore(join(dataDir, "sessions")).save(session);

    saveScoutFacts(
      snapshotStoreFor(join(dataDir, "projects")),
      escapePath(realpathSync(repository)),
      {
        facts: {
          gateCommand: {
            value: "true",
            provenance: "detected",
            source: "controlled failed-worker integration",
          },
        },
        guidanceSeeded: 0,
        missingConfig: [],
      },
    );

    const first = await createRennetServer({ dataDir, env, runRoundTurn });
    servers.push(first);
    const sessionId = session.id;
    const reviewId = review.id;
    await first.dispatch("ask.stage", {
      sessionId: reviewId,
      ask: {
        id: "kill-gate-ask",
        anchor: "reviewed.txt:2",
        type: "request-change",
        body: "make the controlled worker change",
      },
    });
    const dispatched = parseCommandOutput(
      "round.dispatch",
      await first.dispatch("round.dispatch", { reviewId }),
    );
    expect(dispatched.dispatched).toBe(true);

    await vi.waitFor(
      async () => {
        const events = parseCommandOutput(
          "session.roundEvents",
          await first.dispatch("session.roundEvents", { reviewId }),
        );
        const current = events.events.findLast((event) => event.type === "operation");
        expect(current).toMatchObject({
          type: "operation",
          snapshot: {
            state: {
              phase: "failed",
              failure: {
                at: "worker",
                worker: { status: "failed", reason: WORKER_FAILURE },
              },
            },
          },
        });
      },
      { timeout: 15_000, interval: 25 },
    );
    expect(workerCalls).toBe(1);
    const failedEvents = parseCommandOutput(
      "session.roundEvents",
      await first.dispatch("session.roundEvents", { reviewId }),
    );
    const failedOperation = failedEvents.events.findLast((event) => event.type === "operation");
    if (failedOperation?.type !== "operation") {
      throw new Error("the failed worker did not leave a durable operation receipt");
    }
    // The progress hub publishes only after this session-keyed CAS. Prove the row exists
    // before restart so the cold read cannot inherit success from first-process memory.
    const persistedOperations = new RoundOperationStore(join(dataDir, "round-operations"));
    try {
      expect(persistedOperations.read(sessionId)).toMatchObject({
        operationId: failedOperation.snapshot.operationId,
        state: {
          phase: "failed",
          failure: {
            at: "worker",
            reason: WORKER_FAILURE,
            worker: {
              outcome: "failed",
              termination: { kind: "error", reason: WORKER_FAILURE },
            },
          },
        },
      });
    } finally {
      persistedOperations.close();
    }

    first.shutdown();
    const restarted = await createRennetServer({ dataDir, env, runRoundTurn });
    servers.push(restarted);
    // No Project is persisted, so establish the post-welcome shell before mounting the route.
    await restarted.dispatch("settings.completeWelcome", {});
    const bridge = new WsRennetBridge({
      url: `ws://127.0.0.1:${restarted.wsPort}`,
      initialBackoffMs: 10,
    });
    bridges.push(bridge);
    const caughtUp = parseCommandOutput(
      "session.roundEvents",
      await bridge.invoke("session.roundEvents", { reviewId }),
    );
    // Positive control: serving only the restarted process's in-memory progress hub leaves
    // this empty; the stored operation is the load-bearing cold-reattach source.
    expect(caughtUp.events.findLast((event) => event.type === "operation")).toMatchObject({
      type: "operation",
      snapshot: {
        operationId: failedOperation.snapshot.operationId,
        state: {
          phase: "failed",
          failure: {
            at: "worker",
            worker: { status: "failed", reason: WORKER_FAILURE },
          },
        },
      },
    });
    const invoke = vi.spyOn(bridge, "invoke");
    const route = `/s/${sessionId}/run`;
    const history = memoryHistory(route);
    const view = render(<RennetRouterApp bridge={bridge} history={history} />);

    await waitFor(
      () => {
        expect(
          view.container.querySelector('[data-screen="session-run"]')?.getAttribute("data-phase"),
        ).toBe("failed");
      },
      { timeout: 15_000 },
    );
    // No gate row exists to render any more, and the run says so by not having one.
    expect(view.container.querySelector('[data-row="gate"]')).toBeNull();
    const workerRow = view.container.querySelector('[data-row="worker"]');
    expect(workerRow?.textContent).toContain(WORKER_FAILURE);
    expect(view.getByRole("alert").textContent).toContain(WORKER_FAILURE);
    expect(view.container.querySelector('[data-row="commit"]')).toBeNull();
    expect(view.container.querySelector('[data-row="report"]')).toBeNull();
    expect(history.history).toEqual([route]);
    expect(invoke).toHaveBeenCalledWith("session.roundEvents", { reviewId });
    expect(invoke.mock.calls.some(([command]) => command === "round.dispatch")).toBe(false);
    expect(workerCalls).toBe(1);
  }, 30_000);
});
