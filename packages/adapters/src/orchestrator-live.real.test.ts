import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildReviewCanvases,
  type CanvasOpsBackend,
  type NoveltyResult,
  type ProjectMapResult,
} from "@rennet/core";
import type { PatchFile, Patchset, Review } from "@rennet/types";
import { afterEach, describe, expect, it } from "vitest";
import { createClaudeHarness } from "./claude-query";
import { createLiveCanvasOpsBackend } from "./live-review-backend";
import { deriveOrchestratorPrimerState, runOrchestratorTurn } from "./orchestrator-turn";
import { ProjectSnapshotStore } from "./project-snapshot-store";

// ─────────────────────────────────────────────────────────────────────────────
// Gated real-turn proof (issue #13, wave 2) — the "built is not loaded" check
// (Rule 80a) for the orchestrator half.
//
// It composes the PRODUCTION backend over a REAL git repo (snapshot generated on
// open), boots the orchestrator session + the in-process canvasOps@2 MCP server,
// and drives ONE real turn on the user's own `claude`. It then proves the model
// reached the LIVE surface AND that the surface served REAL snapshot-derived data:
// a `context.map`/`context.novelty` tool call was made, and the backend the MCP
// handler executed returned a served map/ledger pinned to the review's real base
// OID with a real freshness verdict — never a fixture.
//
// It runs on the user's subscription OAuth (R2), so it spends NO metered tokens,
// but it spends subscription quota and needs a discoverable `claude`, so it is
// SKIPPED unless `RENNET_LIVE_HARNESS=1` and NEVER runs in the normal gate:
//
//   RENNET_LIVE_HARNESS=1 pnpm exec vitest run packages/adapters/src/orchestrator-live.real.test.ts
// ─────────────────────────────────────────────────────────────────────────────

const LIVE = process.env.RENNET_LIVE_HARNESS === "1";

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
  const root = mkdtempSync(join(tmpdir(), "rennet-orch-live-"));
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

/** Wrap a backend so the actual map/novelty results served during the turn are recorded. */
function recording(backend: CanvasOpsBackend): {
  backend: CanvasOpsBackend;
  maps: ProjectMapResult[];
  novelties: NoveltyResult[];
} {
  const maps: ProjectMapResult[] = [];
  const novelties: NoveltyResult[] = [];
  const wrapped: CanvasOpsBackend = {
    ...backend,
    projectMap: (scope) => {
      const result = backend.projectMap(scope);
      maps.push(result);
      return result;
    },
    novelty: () => {
      const result = backend.novelty();
      novelties.push(result);
      return result;
    },
  };
  return { backend: wrapped, maps, novelties };
}

describe("orchestrator turn — real harness against the live backend (gated)", () => {
  it.skipIf(!LIVE)(
    "drives a real turn whose context tool call serves REAL snapshot-derived data",
    async () => {
      const { adapter, discovery } = await createClaudeHarness({ env: process.env });
      const claudePath = discovery.chosen?.path;
      expect(
        claudePath,
        `no claude binary discovered: ${JSON.stringify(discovery.health)}`,
      ).toBeTruthy();
      expect(adapter).not.toBeNull();
      if (!claudePath) return;

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
      const pipeline = await buildReviewCanvases({
        reviewId: review.id,
        patchset,
        dispositions: [],
      });
      const storeDir = mkdtempSync(join(tmpdir(), "rennet-orch-live-store-"));
      scratch.push(storeDir);
      const composed = await createLiveCanvasOpsBackend(review, pipeline, {
        store: new ProjectSnapshotStore(storeDir),
      });
      expect(composed.snapshot.generated).toBe(true);

      const rec = recording(composed.backend);
      const primer = deriveOrchestratorPrimerState(pipeline, rec.backend, composed.snapshot);

      const question = [
        "Do exactly this, using ONLY your canvasOps tools:",
        "1. Call context.map for this review.",
        "2. Call context.novelty for this review.",
        "Then tell me, in one line, the freshness verdict you saw and the workspace scope names.",
      ].join("\n");

      const result = await runOrchestratorTurn(rec.backend, primer, question, {
        claudePath,
        cwd: review.repositoryRoot,
        env: process.env,
      });

      // The model reached the LIVE canvasOps@2 surface (never a fixture path).
      const ops = result.toolCalls.map((c) => c.op);
      expect(
        ops.some((op) => op === "context.map" || op === "context.novelty"),
        `no context tool call made; ops=${JSON.stringify(ops)}, outcome=${result.outcome}, err=${JSON.stringify(result.error)}`,
      ).toBe(true);

      // The surface the MCP handler executed served REAL snapshot-derived data,
      // pinned to the review's real base OID — the "built is not loaded" proof.
      const servedMap = rec.maps.find((m) => m.ok);
      const servedNovelty = rec.novelties.find((n) => n.ok);
      expect(
        servedMap !== undefined || servedNovelty !== undefined,
        "no served map/novelty was recorded during the turn",
      ).toBe(true);

      if (servedMap?.ok) {
        expect(servedMap.map.baseOid).toBe(repo.oid);
        expect(servedMap.map.scopes.map((s) => s.name)).toContain("@t/a");
      }
      if (servedNovelty?.ok) {
        expect(servedNovelty.ledger.baseOid).toBe(repo.oid);
        expect(servedNovelty.ledger.entries.length).toBeGreaterThan(0);
      }

      // The turn ran on subscription OAuth to a clean terminal result.
      expect(result.outcome).toBe("completed");
    },
    240_000,
  );
});
