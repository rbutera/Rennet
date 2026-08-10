import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Query, Options as SdkOptions } from "@anthropic-ai/claude-agent-sdk";
import { buildReviewCanvases } from "@rennet/core";
import type { PatchFile, Patchset, Review } from "@rennet/types";
import { afterEach, describe, expect, it } from "vitest";
import { CANVAS_OPS_SERVER_NAME } from "./canvas-ops-server";
import { createLiveCanvasOpsBackend } from "./live-review-backend";
import { attachOrchestratorSession } from "./orchestrator-session-server";
import {
  deriveOrchestratorPrimerState,
  type LoadSdkQuery,
  runOrchestratorTurn,
} from "./orchestrator-turn";
import { ProjectSnapshotStore } from "./project-snapshot-store";

// ─────────────────────────────────────────────────────────────────────────────
// The orchestrator-turn wiring proof (issue #13, wave 2), driven with NO model.
//
// The live model turn is the gated proof (`orchestrator-live.real.test.ts`). This
// runs in the normal gate: it derives the primer from a REAL live backend over a
// real git repo, and drives `runOrchestratorTurn` with an INJECTED fake `query()`
// so it asserts the wiring shape — the canvasOps@2 MCP server handed to `query()`
// under the right key, the wired tools auto-approved, the primer appended, and the
// model's canvasOps@2 tool call surfaced — without spending a token.
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

function workspaceRepo(): { root: string; commonDir: string; oid: string } {
  const root = mkdtempSync(join(tmpdir(), "rennet-orch-turn-"));
  scratch.push(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "rennet@example.test");
  git(root, "config", "user.name", "Rennet Test");
  write(root, "pnpm-workspace.yaml", 'packages:\n  - "packages/*"\n');
  write(
    root,
    "packages/a/package.json",
    JSON.stringify({ name: "@t/a", private: true, main: "./src/index.ts" }),
  );
  write(
    root,
    "packages/a/project.json",
    JSON.stringify({ name: "t-a", sourceRoot: "packages/a/src", projectType: "library" }),
  );
  write(root, "packages/a/src/index.ts", "export const a = 1;\nexport function makeA() {}\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "first");
  return { root, commonDir: join(root, ".git"), oid: git(root, "rev-parse", "HEAD") };
}

function patchsetAt(root: string, commonDir: string, baseOid: string): Patchset {
  const patch = `@@ -1,2 +1,4 @@
 export const a = 1;
+export const added = 3;
+export function moreA() {}
 export function makeA() {}`;
  const files: PatchFile[] = [
    {
      path: "packages/a/src/index.ts",
      status: "modified",
      additions: 2,
      deletions: 0,
      binary: false,
      patch,
    },
  ];
  return {
    id: `ps-${baseOid.slice(0, 8)}`,
    createdAt: "2026-08-10T00:00:00.000Z",
    repository: { id: "repo", root, commonDir, baseRef: baseOid, baseOid, headOid: baseOid },
    files,
    rawDiff: patch,
    byteLength: patch.length,
    truncated: false,
  };
}

async function liveReview(maxSnapshotFiles?: number) {
  const repo = workspaceRepo();
  const patchset = patchsetAt(repo.root, repo.commonDir, repo.oid);
  const review: Review = {
    id: `review-${repo.oid.slice(0, 8)}`,
    repositoryRoot: repo.root,
    patchsets: [patchset],
    activePatchsetId: patchset.id,
    dispositions: [],
    status: "current",
  };
  const pipeline = await buildReviewCanvases({ reviewId: review.id, patchset, dispositions: [] });
  const storeDir = mkdtempSync(join(tmpdir(), "rennet-orch-store-"));
  scratch.push(storeDir);
  const composed = await createLiveCanvasOpsBackend(review, pipeline, {
    store: new ProjectSnapshotStore(storeDir),
    ...(maxSnapshotFiles !== undefined ? { maxSnapshotFiles } : {}),
  });
  return { repo, review, pipeline, ...composed };
}

/** A fake `query()` loader: captures the options and yields authored frames. */
function fakeQuery(frames: readonly unknown[]): {
  loadQuery: LoadSdkQuery;
  captured: () => SdkOptions | undefined;
  calls: () => number;
} {
  let options: SdkOptions | undefined;
  let calls = 0;
  const query = (params: { prompt: string; options?: SdkOptions }): Query => {
    calls += 1;
    options = params.options;
    async function* gen(): AsyncGenerator<unknown> {
      for (const frame of frames) yield frame;
    }
    return gen() as unknown as Query;
  };
  return {
    loadQuery: (() => Promise.resolve(query)) as LoadSdkQuery,
    captured: () => options,
    calls: () => calls,
  };
}

const CONTEXT_MAP_TOOL = `mcp__${CANVAS_OPS_SERVER_NAME}__context.map`;

function toolUseFrame(name: string, input: Record<string, unknown>): unknown {
  return { type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name, input }] } };
}

function resultFrame(text: string): unknown {
  return { type: "result", subtype: "success", is_error: false, result: text };
}

describe("deriveOrchestratorPrimerState — honest primer from live state", () => {
  it("reads B1/B2/B3/B6 from the real backend (snapshot served → current)", async () => {
    const { review, pipeline, backend, snapshot } = await liveReview();
    const primer = deriveOrchestratorPrimerState(pipeline, backend, snapshot);

    expect(primer.identity.reviewId).toBe(review.id);
    expect(primer.identity.repo).toBe(review.repositoryRoot);
    expect(primer.identity.patchsetId).toBe(review.activePatchsetId);

    expect(primer.freshness).toHaveLength(1);
    expect(primer.freshness[0]?.repoId).toBe(snapshot.repoKey);
    expect(primer.freshness[0]?.snapshotId).toBe(snapshot.baseOid);
    // The snapshot was generated on open, so context.map serves → verdict current.
    expect(primer.freshness[0]?.verdict).toBe("current");

    // Lean map: `buildReviewCanvases` emits all six angle canvases but a focused
    // change leaves most empty, so B3 carries only the canvases with content (plus
    // the active one) — never all six all-zero lines that would blow the ceiling.
    expect(primer.canvasState.length).toBeGreaterThan(0);
    expect(primer.canvasState.length).toBeLessThan(6);

    // v1 ledger is distinguished-empty — an honest zero, never a fabricated row.
    expect(primer.runLedger).toEqual({ fleetTasks: 0, admitted: 0, rejected: 0 });

    // The derived primer assembles WITHIN the 4 KB ceiling (bootOrchestratorSession
    // throws otherwise), so it is a usable map, not just a shape.
    const { session } = await attachOrchestratorSession(backend, {
      primer,
      harness: "claude",
      fresh: true,
    });
    expect(session.primer.bytes).toBeLessThanOrEqual(4096);
    expect(session.provenance.primerDigest).toHaveLength(64);
  });

  it("reports a FAILED snapshot verdict when generation was skipped (fail-closed)", async () => {
    // A zero file ceiling skips generation → context.map refuses (absent) → the B2
    // verdict is `failed`, never a fabricated `current`.
    const { pipeline, backend, snapshot } = await liveReview(0);
    expect(snapshot.generated).toBe(false);
    const primer = deriveOrchestratorPrimerState(pipeline, backend, snapshot);
    expect(primer.freshness[0]?.verdict).toBe("failed");
  });
});

describe("runOrchestratorTurn — wiring proof (no model)", () => {
  it("hands the canvasOps@2 server to query() and surfaces the tool call", async () => {
    const { review, pipeline, backend, snapshot } = await liveReview();
    const primer = deriveOrchestratorPrimerState(pipeline, backend, snapshot);
    const fake = fakeQuery([
      toolUseFrame(CONTEXT_MAP_TOOL, { scope: "packages/a" }),
      resultFrame("The base map is current; scope @t/a."),
    ]);

    const result = await runOrchestratorTurn(backend, primer, "Map the base branch.", {
      claudePath: "/fake/claude",
      cwd: review.repositoryRoot,
      loadQuery: fake.loadQuery,
    });

    // The model's canvasOps@2 tool call is surfaced, op-decoded from the namespace.
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]?.op).toBe("context.map");
    expect(result.toolCalls[0]?.name).toBe(CONTEXT_MAP_TOOL);
    expect(result.toolCalls[0]?.input).toEqual({ scope: "packages/a" });
    expect(result.outcome).toBe("completed");
    expect(result.finalText).toContain("current");

    // The options handed to query() wire the live surface correctly.
    const options = fake.captured();
    expect(options).toBeDefined();
    const opts = options as unknown as Record<string, unknown>;
    expect(opts.pathToClaudeCodeExecutable).toBe("/fake/claude");
    expect(opts.cwd).toBe(review.repositoryRoot);
    // NEVER a bypass mode — read-only posture, gated solely by canUseTool.
    expect(opts.permissionMode).toBe("default");
    // The in-process canvasOps@2 MCP server is under its own server name.
    const servers = opts.mcpServers as Record<string, unknown>;
    expect(servers[CANVAS_OPS_SERVER_NAME]).toBeDefined();
    // canUseTool is the sole gate: ALLOW any canvasOps@2 tool (dotted OR the
    // harness's sanitized `_` form), DENY everything off-surface.
    type PermFn = (
      name: string,
      input: Record<string, unknown>,
      o: unknown,
    ) => Promise<{ behavior: string }>;
    const canUseTool = opts.canUseTool as PermFn;
    expect((await canUseTool(CONTEXT_MAP_TOOL, {}, {})).behavior).toBe("allow");
    expect((await canUseTool(`mcp__${CANVAS_OPS_SERVER_NAME}__context_map`, {}, {})).behavior).toBe(
      "allow",
    );
    expect((await canUseTool("Read", { file: "x" }, {})).behavior).toBe("deny");
    // The lean primer is appended to Claude Code's own system prompt (never replaced).
    const systemPrompt = opts.systemPrompt as { type?: string; append?: string };
    expect(systemPrompt.type).toBe("preset");
    expect(systemPrompt.append).toContain("B5 tools");
    expect(systemPrompt.append).toContain("context.map");
  });

  it("spawns NO model on session boot — only a live query() runs one", async () => {
    const { review, pipeline, backend, snapshot } = await liveReview();
    const primer = deriveOrchestratorPrimerState(pipeline, backend, snapshot);
    const fake = fakeQuery([resultFrame("done")]);

    // Booting the session + the in-process MCP server touches no query loader.
    const attached = await attachOrchestratorSession(backend, {
      primer,
      harness: "claude",
      fresh: true,
    });
    expect(attached.mcpServer).toBeDefined();
    expect(fake.calls()).toBe(0);

    // Only when a turn actually runs is a query (the model) constructed.
    await runOrchestratorTurn(backend, primer, "Anything.", {
      claudePath: "/fake/claude",
      cwd: review.repositoryRoot,
      loadQuery: fake.loadQuery,
    });
    expect(fake.calls()).toBe(1);
  });

  it("decodes only canvasOps@2 tool calls, ignoring off-surface tool_use", async () => {
    const { review, pipeline, backend, snapshot } = await liveReview();
    const primer = deriveOrchestratorPrimerState(pipeline, backend, snapshot);
    const fake = fakeQuery([
      toolUseFrame("Read", { file: "x" }),
      toolUseFrame(CONTEXT_MAP_TOOL, {}),
      resultFrame("ok"),
    ]);
    const result = await runOrchestratorTurn(backend, primer, "q", {
      claudePath: "/fake/claude",
      cwd: review.repositoryRoot,
      loadQuery: fake.loadQuery,
    });
    // The off-surface `Read` call is not a canvasOps@2 op and is not surfaced.
    expect(result.toolCalls.map((c) => c.op)).toEqual(["context.map"]);
  });
});
