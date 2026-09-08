import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { settledTurnUsage } from "@rennet/adapters";
import { expect, it } from "vitest";
import { connectT3, modelSelection, type T3Client } from "./client";
import { type RunningSidecar, resolveSidecarBundle, spawnSidecar, stopSidecar } from "./sidecar";

const bundle = resolveSidecarBundle({});

it.skipIf(!bundle)(
  "counts a recovered Claude runtime separately even when it resumes the same provider session",
  async () => {
    if (!bundle) throw new Error("Sidecar bundle required");
    const root = mkdtempSync(join(tmpdir(), "rennet-claude-usage-"));
    const repo = join(root, "repo");
    const dataDir = join(root, "data");
    const claude = join(root, "claude-fixture.mjs");
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
      writeFileSync(
        claude,
        `#!/usr/bin/env node
import { createInterface } from "node:readline";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
if (process.argv.includes("--version")) { console.log("2.1.0 (Claude Code)"); process.exit(0); }
const marker = ${JSON.stringify(join(root, "runtime-started"))};
let recovered;
let cleared = false;
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
let turns = 0;
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.type === "control_request") {
    send({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response: { commands: [], agents: [], models: [], account: {} } } });
  } else if (message.type === "user") {
    if (recovered === undefined) { recovered = existsSync(marker); cleared = recovered && readFileSync(marker, "utf8") === "cleared-provider-session"; }
    const reset = JSON.stringify(message).includes("/clear");
    if (reset) cleared = true;
    const sessionId = cleared ? "cleared-provider-session" : "same-provider-session";
    writeFileSync(marker, sessionId);
    turns += 1;
    send({ type: "system", subtype: "init", session_id: sessionId, tools: [], model: "claude-sonnet-5" });
    send({ type: "assistant", uuid: randomUUID(), session_id: sessionId, parent_tool_use_id: null, message: { id: randomUUID(), role: "assistant", content: [{ type: "text", text: "Done." }] } });
    const usage = reset ? { input_tokens: 0, output_tokens: 0 } : recovered ? { input_tokens: 56000, output_tokens: 4000 } : cleared ? { input_tokens: 36000, output_tokens: 4000 } : turns === 3 ? { input_tokens: 18000, output_tokens: 2000 } : { input_tokens: turns === 1 ? 9000 : 1000, output_tokens: 1000 };
    const counters = (inputTokens, outputTokens, costUSD) => ({ inputTokens, outputTokens, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD, webSearchRequests: 0, contextWindow: 200000, maxOutputTokens: 64000 });
    const modelUsage = reset ? {} : { sonnet: recovered ? counters(56000, 4000, 6) : cleared ? counters(36000, 4000, 4) : turns === 1 ? counters(9000, 1000, 1) : turns === 2 ? counters(10000, 2000, 1.2) : counters(28000, 4000, 3.2) };
    if (!reset && (recovered || cleared || turns === 3)) modelUsage.haiku = recovered || cleared ? counters(2000, 1000, 0.3) : counters(500, 500, 0.1);
    send({ type: "result", subtype: "success", is_error: false, result: "Done.", session_id: sessionId, uuid: randomUUID(), usage, modelUsage, total_cost_usd: reset ? 0 : recovered ? 6.3 : cleared ? 4.3 : turns === 1 ? 1 : turns === 2 ? 1.2 : 3.3 });
  }
});
`,
        { mode: 0o755 },
      );
      const connect = async () => {
        running = await spawnSidecar({
          dataDir,
          bundlePath: bundle,
          upstreamCommit: "test",
          binaries: { claude },
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
        modelSelection: modelSelection("claudeAgent", "claude-sonnet-5"),
      });
      const first = await client.startTurn({ threadId, text: "first" });
      const firstResult = await client.waitForTurnSettled(threadId, { after: first });
      expect(settledTurnUsage(firstResult)).toMatchObject({ totalTokens: 10_000, reportedUsd: 1 });
      const second = await client.startTurn({ threadId, text: "repair" });
      const secondResult = await client.waitForTurnSettled(threadId, { after: second });
      expect(settledTurnUsage(secondResult)?.totalTokens).toBe(2_000);
      expect(secondResult.usageEpoch).toBe(firstResult.usageEpoch);
      const larger = await client.startTurn({ threadId, text: "larger" });
      const largerResult = await client.waitForTurnSettled(threadId, { after: larger });
      expect(largerResult.usageEpoch).toBe(firstResult.usageEpoch);
      expect(settledTurnUsage(largerResult)?.totalTokens).toBe(21_000);
      expect(settledTurnUsage(largerResult)?.reportedUsd).toBeCloseTo(2.1);
      const clear = await client.startTurn({ threadId, text: "/clear" });
      const clearResult = await client.waitForTurnSettled(threadId, { after: clear });
      expect(clearResult.usageEpoch).not.toBe(largerResult.usageEpoch);
      expect(settledTurnUsage(clearResult)).toMatchObject({ totalTokens: 0, reportedUsd: 0 });
      const afterClear = await client.startTurn({ threadId, text: "after clear" });
      const afterClearResult = await client.waitForTurnSettled(threadId, { after: afterClear });
      expect(afterClearResult.usageEpoch).toBe(clearResult.usageEpoch);
      expect(settledTurnUsage(afterClearResult)).toMatchObject({
        totalTokens: 43_000,
        reportedUsd: 4.3,
      });
      await client.close();
      await stopSidecar(dataDir);
      running?.child?.kill("SIGKILL");
      client = await connect();
      const restored = await client.waitForTurnSettled(threadId, { after: afterClear });
      expect(settledTurnUsage(restored)?.totalTokens).toBe(43_000);
      const recovered = await client.startTurn({ threadId, text: "recovered" });
      const recoveredResult = await client.waitForTurnSettled(threadId, { after: recovered });
      expect(recoveredResult.state).toBe("completed");
      expect(recoveredResult.usageEpoch).toBeTypeOf("string");
      expect(recoveredResult.usageEpoch).not.toBe(afterClearResult.usageEpoch);
      expect(settledTurnUsage(recoveredResult)).toMatchObject({
        totalTokens: 63_000,
        reportedUsd: 6.3,
      });
    } finally {
      await client?.close();
      await stopSidecar(dataDir);
      running?.child?.kill("SIGKILL");
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  },
  90_000,
);
