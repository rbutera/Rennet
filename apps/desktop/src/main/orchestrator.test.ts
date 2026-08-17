import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Query } from "@anthropic-ai/claude-agent-sdk";
import {
  CodexAdapter,
  type CodexTurnSpec,
  type CodexTurnTransport,
  type LoadCanvasOpsSdk,
  type LoadSdkQuery,
} from "@rennet/adapters";
import {
  buildReviewCanvases,
  createInvocationBudget,
  type ReviewPipelineResult,
} from "@rennet/core";
import { sha256Hex } from "@rennet/protocol";
import type { PatchFile, Patchset, Review } from "@rennet/types";
import { afterEach, describe, expect, it } from "vitest";
import { loadDesktopReviewContextManifest } from "./live-review-backend";
import { createOrchestratorTurnRunner } from "./orchestrator";

// ─────────────────────────────────────────────────────────────────────────────
// The desktop orchestrator composition root (issue #13, wave 2). Driven with NO
// model: the runner composes the live backend + primer + turn, and either drives a
// turn on the discovered `claude` or returns a typed `unavailable`. Injected fake
// transports keep the whole thing hermetic — no SDK, no spend.
// ─────────────────────────────────────────────────────────────────────────────

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function write(root: string, path: string, content: string): void {
  const full = join(root, path);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
}

async function liveReview(): Promise<{ review: Review; pipeline: ReviewPipelineResult }> {
  const root = mkdtempSync(join(tmpdir(), "rennet-desktop-orch-"));
  scratch.push(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "rennet@example.test");
  git(root, "config", "user.name", "Rennet Test");
  write(root, "pnpm-workspace.yaml", 'packages:\n  - "packages/*"\n');
  write(root, "packages/a/package.json", JSON.stringify({ name: "@t/a", main: "./src/index.ts" }));
  write(
    root,
    "packages/a/project.json",
    JSON.stringify({ name: "t-a", sourceRoot: "packages/a/src", projectType: "library" }),
  );
  write(root, "packages/a/src/index.ts", "export const a = 1;\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "first");
  const oid = git(root, "rev-parse", "HEAD");
  const patch = `@@ -1,1 +1,2 @@\n export const a = 1;\n+export const b = 2;`;
  const files: PatchFile[] = [
    {
      path: "packages/a/src/index.ts",
      status: "modified",
      additions: 1,
      deletions: 0,
      binary: false,
      patch,
    },
  ];
  const patchset: Patchset = {
    id: `ps-${oid.slice(0, 8)}`,
    createdAt: "2026-08-10T00:00:00.000Z",
    repository: {
      id: "repo",
      root,
      commonDir: join(root, ".git"),
      baseRef: oid,
      baseOid: oid,
      headOid: oid,
    },
    files,
    rawDiff: patch,
    byteLength: patch.length,
    truncated: false,
  };
  const review: Review = {
    id: `review-${oid.slice(0, 8)}`,
    repositoryRoot: root,
    patchsets: [patchset],
    activePatchsetId: patchset.id,
    dispositions: [],
    status: "current",
  };
  const pipeline = await buildReviewCanvases({
    reviewId: review.id,
    patchset,
    dispositions: [],
    budget: createInvocationBudget(12),
  });
  return { review, pipeline };
}

function tempBaseDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "rennet-desktop-projects-"));
  scratch.push(dir);
  return dir;
}

function fakeQuery(frames: readonly unknown[]): { loadQuery: LoadSdkQuery; calls: () => number } {
  let calls = 0;
  const query = (): Query => {
    calls += 1;
    async function* gen(): AsyncGenerator<unknown> {
      for (const frame of frames) yield frame;
    }
    return gen() as unknown as Query;
  };
  return { loadQuery: (() => Promise.resolve(query)) as LoadSdkQuery, calls: () => calls };
}

describe("createOrchestratorTurnRunner — the desktop composition", () => {
  it("delivers a canvas.focus effect to the injected focus sink exactly once", async () => {
    const { review, pipeline } = await liveReview();
    let focusHandler: ((args: Record<string, unknown>) => Promise<unknown>) | undefined;
    const loadSdk = (() =>
      Promise.resolve({
        tool: (
          name: string,
          _description: string,
          _shape: unknown,
          handler: (args: Record<string, unknown>) => Promise<unknown>,
        ) => {
          if (name === "canvas.focus") focusHandler = handler;
          return { name, handler };
        },
        createSdkMcpServer: (config: { name: string }) => ({
          type: "sdk",
          name: config.name,
          instance: {},
        }),
      })) as unknown as LoadCanvasOpsSdk;
    const loadQuery = (() =>
      Promise.resolve((): Query => {
        async function* gen(): AsyncGenerator<unknown> {
          if (!focusHandler) throw new Error("focus tool was not registered");
          await focusHandler({ target: "rennet:hunk/c1-h1#L1@additions" });
          yield { type: "result", subtype: "success", is_error: false, result: "done" };
        }
        return gen() as unknown as Query;
      })) as unknown as LoadSdkQuery;
    const focused: string[] = [];
    const run = createOrchestratorTurnRunner({
      baseDir: tempBaseDir(),
      resolveHarness: () =>
        Promise.resolve({ harness: "claude-code" as const, claudePath: "/fake/claude" }),
      loadQuery,
      loadSdk,
    });

    await run(review, pipeline, "point", undefined, undefined, {
      onFocus: (anchor) => focused.push(anchor),
    });

    expect(focused).toEqual(["rennet:hunk/c1-h1#L1@additions"]);
  });

  it("returns a typed unavailable (spawning no model) when no claude is discovered", async () => {
    const { review, pipeline } = await liveReview();
    const fake = fakeQuery([]);
    const run = createOrchestratorTurnRunner({
      baseDir: tempBaseDir(),
      resolveHarness: () => Promise.resolve(null),
      loadQuery: fake.loadQuery,
    });
    const outcome = await run(review, pipeline, "Map the base.");
    expect(outcome.available).toBe(false);
    if (!outcome.available) expect(outcome.reason).toMatch(/no model harness/i);
    // No claude → the runner returns before any turn: nothing spawned.
    expect(fake.calls()).toBe(0);
  });

  it("composes the live backend + primer + turn and surfaces the tool call", async () => {
    const { review, pipeline } = await liveReview();
    const serverTool = "mcp__rennet-canvas-ops__context.map";
    const fake = fakeQuery([
      {
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "t1", name: serverTool, input: {} }] },
      },
      { type: "result", subtype: "success", is_error: false, result: "current; @t/a" },
    ]);
    const run = createOrchestratorTurnRunner({
      baseDir: tempBaseDir(),
      resolveHarness: () =>
        Promise.resolve({ harness: "claude-code" as const, claudePath: "/fake/claude" }),
      loadQuery: fake.loadQuery,
    });
    const outcome = await run(review, pipeline, "Map the base branch.");
    expect(outcome.available).toBe(true);
    if (!outcome.available) return;
    expect(outcome.result.toolCalls.map((c) => c.op)).toEqual(["context.map"]);
    expect(outcome.result.outcome).toBe("completed");
    expect(fake.calls()).toBe(1);
  });

  it("feeds the verified assembly to the orchestrator and persists its exact send", async () => {
    const { review, pipeline } = await liveReview();
    const baseDir = tempBaseDir();
    let append = "";
    const loadQuery: LoadSdkQuery = (() =>
      Promise.resolve((args: { options?: { systemPrompt?: { append?: string } } }): Query => {
        append = args.options?.systemPrompt?.append ?? "";
        async function* gen(): AsyncGenerator<unknown> {
          yield { type: "result", subtype: "success", is_error: false, result: "ok" };
        }
        return gen() as unknown as Query;
      })) as unknown as LoadSdkQuery;
    const run = createOrchestratorTurnRunner({
      baseDir,
      resolveHarness: () =>
        Promise.resolve({ harness: "claude-code" as const, claudePath: "/fake/claude" }),
      loadQuery,
    });

    await run(review, pipeline, "Map the base.");
    const manifest = await loadDesktopReviewContextManifest(review, { baseDir });

    expect(append).toContain("<<<rennet:layer context>>>\n");
    expect(manifest?.sends).toHaveLength(1);
    expect(manifest?.sends?.[0]).toMatchObject({
      seat: "orchestrator",
      harness: "claude-code",
      channel: "system-append",
      attempt: 0,
      promptDigest: sha256Hex(append),
      contextIncluded: true,
      contextDigest: manifest?.assembledPromptDigest,
    });
  });

  it("threads the AbortController into the SDK options so a live turn is cancellable (#251 criterion 4)", async () => {
    const { review, pipeline } = await liveReview();
    const controller = new AbortController();
    let capturedOptions: { abortController?: AbortController } | undefined;
    // A capturing query records the SDK options the runner assembled. The real
    // `query({ prompt, options })` is what a live claude turn is driven through, so
    // `options.abortController` is the exact seam `before-quit` fires.
    const loadQuery: LoadSdkQuery = (() =>
      Promise.resolve((args: { options?: { abortController?: AbortController } }): Query => {
        capturedOptions = args.options;
        async function* gen(): AsyncGenerator<unknown> {
          yield { type: "result", subtype: "success", is_error: false, result: "ok" };
        }
        return gen() as unknown as Query;
      })) as unknown as LoadSdkQuery;
    const run = createOrchestratorTurnRunner({
      baseDir: tempBaseDir(),
      resolveHarness: () =>
        Promise.resolve({ harness: "claude-code" as const, claudePath: "/fake/claude" }),
      loadQuery,
    });
    await run(review, pipeline, "Map the base.", undefined, controller);
    // The VERY controller passed reaches the SDK — not a copy, not absent. Drop the
    // threading in `createOrchestratorTurnRunner` and this reddens (undefined !== it).
    expect(capturedOptions?.abortController).toBe(controller);
  });

  it("routes a Codex-selected orchestrator through an injected CodexTurnTransport", async () => {
    const { review, pipeline } = await liveReview();
    let captured: CodexTurnSpec | null = null;
    const transport: CodexTurnTransport = (spec) => {
      captured = spec;
      return {
        async *[Symbol.asyncIterator](): AsyncIterator<unknown> {
          yield { type: "thread.started", thread_id: "th_codex" };
          yield {
            type: "item.started",
            item: {
              id: "item_1",
              type: "mcp_tool_call",
              server: "canvasops",
              tool: "canvas.describe",
              arguments: { depth: "counts" },
              result: null,
              error: null,
              status: "in_progress",
            },
          };
          yield {
            type: "item.completed",
            item: {
              id: "item_1",
              type: "mcp_tool_call",
              server: "canvasops",
              tool: "canvas.describe",
              arguments: { depth: "counts" },
              result: { content: [{ type: "text", text: "{}" }] },
              error: null,
              status: "completed",
            },
          };
          yield {
            type: "item.completed",
            item: { id: "item_2", type: "agent_message", text: "codex answer" },
          };
          yield { type: "turn.completed", usage: { input_tokens: 2, output_tokens: 1 } };
          yield { rennet: "turn-result", exitCode: 0, lastMessage: "codex answer" };
        },
      };
    };
    const run = createOrchestratorTurnRunner({
      baseDir: tempBaseDir(),
      resolveHarness: () =>
        Promise.resolve({
          harness: "codex" as const,
          model: "gpt-5.6-terra",
          resolvePort: (mcpServers: Readonly<Record<string, { readonly url: string }>>) =>
            Promise.resolve(
              new CodexAdapter({
                binaryPath: "/fake/codex",
                transport,
                version: "0.146.0",
                mcpServers,
              }),
            ),
        }),
    });

    const outcome = await run(review, pipeline, "Map the base branch.");

    expect(outcome.available).toBe(true);
    if (!outcome.available) return;
    expect(outcome.result.outcome).toBe("completed");
    expect(outcome.result.finalText).toBe("codex answer");
    expect(outcome.result.toolCalls).toEqual([
      { name: "canvas.describe", op: "canvas.describe", input: { depth: "counts" } },
    ]);
    const seen = captured as CodexTurnSpec | null;
    if (seen === null) throw new Error("CodexTurnTransport was not reached");
    expect(seen.model).toBe("gpt-5.6-terra");
    expect(seen.mcpServers?.canvasops?.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    expect(seen.prompt).toContain("Map the base branch.");
  });
});
