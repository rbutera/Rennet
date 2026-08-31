import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GenerationStore, GitCaptureAdapter, SqliteReviewStore } from "@rennet/adapters";
import { WsRennetBridge } from "@rennet/client";
import { ReviewService } from "@rennet/core";
import type { CommandOutput } from "@rennet/protocol";
import { generationIdForPatchset } from "@rennet/protocol";
import { createRennetServer, type RennetServer } from "@rennet/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const directories: string[] = [];
const servers: RennetServer[] = [];
const bridges: WsRennetBridge[] = [];

function git(root: string, ...arguments_: string[]): string {
  return execFileSync("git", arguments_, { cwd: root, encoding: "utf8" }).trim();
}

function json(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...headers },
  });
}

afterEach(() => {
  for (const bridge of bridges.splice(0)) bridge.close();
  for (const server of servers.splice(0).reverse()) server.shutdown();
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe.skipIf(process.platform === "win32")(
  "durable review publication over the real bridge",
  () => {
    it("composes and posts once, then hydrates and reuses the receipt after daemon restart", async () => {
      const repository = realpathSync(mkdtempSync(join(tmpdir(), "rennet-publish-repo-")));
      const dataDir = mkdtempSync(join(tmpdir(), "rennet-publish-data-"));
      directories.push(repository, dataDir);
      git(repository, "init", "-q", "-b", "main");
      git(repository, "config", "user.email", "test@example.invalid");
      git(repository, "config", "user.name", "Rennet Test");
      writeFileSync(join(repository, "reviewed.txt"), "base\n");
      git(repository, "add", "reviewed.txt");
      git(repository, "commit", "-qm", "base");
      writeFileSync(join(repository, "reviewed.txt"), "base\nreviewed change\n");

      const capture = new GitCaptureAdapter();
      const patchset = await capture.capture(repository);
      const reviewStore = new SqliteReviewStore(join(dataDir, "rennet.sqlite"));
      const review = await new ReviewService(capture, reviewStore).createReviewFromPatchset(
        randomUUID(),
        patchset,
        {
          postTarget: {
            repo: { forge: "github", owner: "rennet", name: "receipt-proof" },
            number: 7,
            forgeRef: "PR_receipt_proof",
            headOid: patchset.repository.headOid,
          },
        },
      );
      reviewStore.close();
      new GenerationStore(join(dataDir, "generations")).save({
        id: generationIdForPatchset(patchset.id),
        patchsetId: patchset.id,
        lensBoards: {},
        status: "live",
      });

      let mutations = 0;
      let reviewQueries = 0;
      const httpFetch: typeof globalThis.fetch = async (input, init) => {
        const url = String(input instanceof Request ? input.url : input);
        const path = new URL(url).pathname;
        if (path === "/rate_limit") {
          return json({ resources: {} }, { "X-OAuth-Scopes": "repo", "X-RateLimit-Limit": "5000" });
        }
        if (path === "/user") return json({ login: "rennet-test" });
        if (path === "/graphql") {
          const request = JSON.parse(String(init?.body ?? "{}")) as {
            query: string;
            variables?: { input?: { body?: string } };
          };
          if (request.query.includes("addPullRequestReview")) {
            mutations += 1;
            return json({
              data: {
                addPullRequestReview: {
                  pullRequestReview: {
                    id: "PRR_receipt_proof",
                    url: "https://github.com/rennet/receipt-proof/pull/7#pullrequestreview-1",
                  },
                },
              },
            });
          }
          if (request.query.includes("reviews(first")) {
            reviewQueries += 1;
            return json({
              data: {
                repository: {
                  pullRequest: {
                    headRefOid: patchset.repository.headOid,
                    reviews: {
                      pageInfo: { hasNextPage: false, endCursor: null },
                      nodes: [],
                    },
                  },
                },
              },
            });
          }
        }
        return new Response("not found", { status: 404 });
      };
      const serverOptions = {
        dataDir,
        env: { RENNET_DISABLE_HARNESS: "1" },
        httpFetch,
        githubCliToken: async () => ({ kind: "token" as const, token: "gho_receipt_proof" }),
        draftReviewOpener: async () => ({
          status: "drafted" as const,
          opener: "This review checks the durable publication path.",
          model: "controlled-test-drafter",
        }),
      };

      const first = await createRennetServer(serverOptions);
      servers.push(first);
      const firstBridge = new WsRennetBridge({
        url: `ws://127.0.0.1:${first.wsPort}`,
        initialBackoffMs: 10,
      });
      bridges.push(firstBridge);
      const composed = (await firstBridge.invoke("publish.compose", {
        commandId: randomUUID(),
        reviewId: review.id,
        mode: "review",
      })) as CommandOutput<"publish.compose">;
      if (composed.status !== "review" || composed.marker === undefined) {
        throw new Error("the real server did not compose a receipt-addressable review");
      }
      const publishInput = {
        commandId: randomUUID(),
        reviewId: review.id,
        artifact: composed.artifact,
        post: composed.post,
        payload: composed.payload,
        compositionId: composed.compositionId,
        dryRun: false,
      };
      const posted = await firstBridge.invoke("publish.review", publishInput);
      expect(posted.outcome).toEqual({
        reviewRef: "PRR_receipt_proof",
        url: "https://github.com/rennet/receipt-proof/pull/7#pullrequestreview-1",
        reused: false,
      });
      expect({ mutations, reviewQueries }).toEqual({ mutations: 1, reviewQueries: 1 });

      firstBridge.close();
      first.shutdown();
      const restarted = await createRennetServer(serverOptions);
      servers.push(restarted);
      const restartedBridge = new WsRennetBridge({
        url: `ws://127.0.0.1:${restarted.wsPort}`,
        initialBackoffMs: 10,
      });
      bridges.push(restartedBridge);
      await expect(
        restartedBridge.invoke("publish.receipt", {
          reviewId: review.id,
          marker: composed.marker,
        }),
      ).resolves.toEqual({
        status: "posted",
        receipt: {
          marker: composed.marker,
          verdict: "APPROVE",
          lineCommentCount: 0,
          reviewRef: "PRR_receipt_proof",
          url: "https://github.com/rennet/receipt-proof/pull/7#pullrequestreview-1",
        },
      });
      const replayed = await restartedBridge.invoke("publish.review", {
        ...publishInput,
        commandId: randomUUID(),
      });
      expect(replayed.outcome).toEqual({
        reviewRef: "PRR_receipt_proof",
        url: "https://github.com/rennet/receipt-proof/pull/7#pullrequestreview-1",
        reused: true,
      });
      expect({ mutations, reviewQueries }).toEqual({ mutations: 1, reviewQueries: 1 });
    });
  },
);
