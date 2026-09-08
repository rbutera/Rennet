import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { settledTurnUsage } from "@rennet/adapters";
import { expect, it } from "vitest";
import { connectT3, modelSelection, type T3Client } from "./client";
import {
  type RunningSidecar,
  resolveSidecarBundle,
  sidecarBaseDir,
  spawnSidecar,
  stopSidecar,
} from "./sidecar";

const bundle = resolveSidecarBundle({});

it.skipIf(!bundle)(
  "persists Codex usage through the real provider projection and a sidecar restart",
  async () => {
    if (!bundle) throw new Error("Sidecar bundle required");
    const root = mkdtempSync(join(tmpdir(), "rennet-codex-usage-"));
    const repo = join(root, "repo");
    const dataDir = join(root, "data");
    const codex = join(root, "codex-fixture");
    let client: T3Client | undefined;
    let running: RunningSidecar | undefined;
    try {
      mkdirSync(repo);
      execFileSync("git", ["init", "-q", "-b", "main", repo]);
      execFileSync("git", [
        "-C",
        repo,
        "-c",
        "user.name=test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "--allow-empty",
        "-qm",
        "fixture",
      ]);
      // Only the provider process is replaced. Its RPC notifications pass through the
      // actual Codex adapter, ingestion, SQLite projection and Rennet settlement client.
      writeFileSync(
        codex,
        `#!/usr/bin/env node
const { createInterface } = require('node:readline');
const { DatabaseSync } = require('node:sqlite');
if (process.argv.includes('--version')) { console.log('codex-cli 0.147.0'); process.exit(0); }
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
const thread = { id: 'provider-thread', sessionId: 'provider-thread', cliVersion: '0.147.0', createdAt: 0, updatedAt: 0, cwd: ${JSON.stringify(repo)}, ephemeral: false, modelProvider: 'openai', preview: '', source: 'appServer', status: { type: 'idle' }, turns: [] };
let count = 0;
const tokens = (inputTokens, cachedInputTokens, outputTokens) => ({ inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens: 100, totalTokens: inputTokens + outputTokens });
createInterface({ input: process.stdin }).on('line', (line) => {
  const { id, method } = JSON.parse(line);
  if (id === undefined) return;
  let result;
  if (method === 'initialize') result = { userAgent: 'fixture', platformFamily: 'unix', platformOs: 'macos', codexHome: ${JSON.stringify(root)} };
  else if (method === 'thread/start' || method === 'thread/resume') result = { thread, cwd: thread.cwd, model: 'gpt-5.6-sol', modelProvider: 'openai', approvalPolicy: 'never', approvalsReviewer: 'user', sandbox: { type: 'dangerFullAccess' } };
  else if (method === 'thread/read') result = { thread };
  else if (method === 'turn/start') {
    count += 1;
    const turn = { id: 'turn-' + count, items: [], status: 'inProgress', error: null };
    send({ id, result: { turn } });
    send({ method: 'turn/started', params: { threadId: thread.id, turn } });
    const total = count === 1 ? tokens(10000, 3000, 2000) : tokens(11000, 3300, 2200);
    const usage = { method: 'thread/tokenUsage/updated', params: { threadId: thread.id, turnId: turn.id, tokenUsage: { total, last: tokens(1000, 300, 200), modelContextWindow: 200000 } } };
    const database = new DatabaseSync(${JSON.stringify(join(sidecarBaseDir(dataDir), "userdata", "state.sqlite"))}, { readOnly: true });
    const ready = setInterval(() => {
      const baseline = database.prepare("SELECT created_at FROM projection_thread_activities WHERE kind = 'turn.usage-baseline' AND turn_id = ?").get(turn.id);
      if (!baseline || Date.now() <= Date.parse(baseline.created_at)) return;
      clearInterval(ready);
      database.close();
      for (let index = 0; index < (count === 1 ? 505 : 2); index += 1) send(usage);
    setTimeout(() => {
    send({ ...usage, params: { ...usage.params, tokenUsage: { ...usage.params.tokenUsage, total: count === 1 ? tokens(8000, 2000, 1000) : tokens(10500, 3100, 2100) } } });
    turn.status = 'completed'; thread.turns.push(turn);
    send({ method: 'turn/completed', params: { threadId: thread.id, turn } });
    }, 25);
    }, 1);
    return;
  } else if (method === 'model/list' || method === 'mcpServerStatus/list') result = { data: [], nextCursor: null };
  else if (method === 'account/read') result = { account: null, requiresOpenaiAuth: false };
  else { send({ id, error: { code: -32601, message: method } }); return; }
  send({ id, result });
});
`,
        { mode: 0o755 },
      );
      const connect = async () => {
        running = await spawnSidecar({
          dataDir,
          bundlePath: bundle,
          upstreamCommit: "test",
          binaries: { codex },
          env: { ...process.env, HOME: join(root, "home") },
          readyTimeoutMs: 30_000,
        });
        return connectT3({
          wsUrl: `${running.origin.replace(/^http/, "ws")}/ws`,
          accessToken: running.credentials.accessToken,
        });
      };
      client = await connect();
      const projectId = await client.ensureProject(repo, "usage fixture");
      const threadId = await client.createThread({
        projectId,
        title: "usage",
        modelSelection: modelSelection("codex", "gpt-5.6-sol"),
      });
      const results = [];
      for (let turn = 0; turn < 2; turn += 1) {
        if (turn === 1) {
          // A queued old runtime event lands after the replacement provider settled.
          // Seed the persisted activity because the new runtime filters foreign wire events.
          const database = new DatabaseSync(
            join(sidecarBaseDir(dataDir), "userdata", "state.sqlite"),
          );
          try {
            database
              .prepare(`INSERT INTO projection_thread_activities
              (activity_id, thread_id, turn_id, tone, kind, summary, payload_json, created_at, sequence)
              VALUES (?, ?, ?, 'info', 'context-window.updated', 'Context window updated', ?, ?,
                (SELECT COALESCE(MAX(sequence), 0) + 1 FROM projection_thread_activities))`)
              .run(
                "late-old-provider",
                threadId,
                "old-turn",
                JSON.stringify({
                  usedTokens: 1_200,
                  codexCumulativeUsage: {
                    providerThreadId: "old-provider",
                    inputTokens: 9_000,
                    cachedInputTokens: 2_000,
                    outputTokens: 1_000,
                    reasoningOutputTokens: 100,
                    totalTokens: 10_000,
                  },
                }),
                new Date().toISOString(),
              );
          } finally {
            database.close();
          }
        }
        const start = await client.startTurn({ threadId, text: "fixture" });
        results.push(
          await client.waitForTurnSettled(threadId, { after: start, startTimeoutMs: 15_000 }),
        );
      }
      expect(results.map((result) => result.state)).toEqual(["completed", "completed"]);
      expect(results.map((result) => settledTurnUsage(result)?.totalTokens)).toEqual([
        12_000, 1_200,
      ]);
      expect(results[0]?.tokenUsage).toMatchObject({ usedTokens: 1_200 });
      // Prove overflow by persisted ordering, not by how many notifications were sent.
      const database = new DatabaseSync(join(sidecarBaseDir(dataDir), "userdata", "state.sqlite"), {
        readOnly: true,
      });
      try {
        const overflow = database
          .prepare(`
          SELECT COUNT(*) AS count FROM projection_thread_activities AS usage
          JOIN projection_thread_activities AS baseline ON baseline.turn_id = usage.turn_id
          WHERE baseline.kind = 'turn.usage-baseline' AND baseline.turn_id = 'turn-1'
            AND usage.kind = 'context-window.updated' AND usage.created_at > baseline.created_at
        `)
          .get();
        expect(overflow?.count).toBeGreaterThan(500);
      } finally {
        database.close();
      }
      expect(
        results[0]?.thread.activities.some((activity) => activity.kind === "turn.usage-baseline"),
      ).toBe(false);
      await client.close();
      await stopSidecar(dataDir);
      running?.child?.kill("SIGKILL");
      client = await connect();
      const restored = await client.waitForTurnSettled(threadId, {});
      expect(settledTurnUsage(restored)?.totalTokens).toBe(1_200);
    } finally {
      await client?.close();
      await stopSidecar(dataDir);
      running?.child?.kill("SIGKILL");
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  },
  90_000,
);
