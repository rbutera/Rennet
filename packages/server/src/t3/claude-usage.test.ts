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
import { existsSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
if (process.argv.includes("--version")) { console.log("2.1.0 (Claude Code)"); process.exit(0); }
const marker = ${JSON.stringify(join(root, "runtime-started"))};
let recovered;
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
let turns = 0;
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.type === "control_request") {
    send({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response: { commands: [], agents: [], models: [], account: {} } } });
  } else if (message.type === "user") {
    if (recovered === undefined) { recovered = existsSync(marker); writeFileSync(marker, "started"); }
    turns += 1;
    send({ type: "system", subtype: "init", session_id: "same-provider-session", tools: [], model: "claude-sonnet-5" });
    send({ type: "assistant", uuid: randomUUID(), session_id: "same-provider-session", parent_tool_use_id: null, message: { id: randomUUID(), role: "assistant", content: [{ type: "text", text: "Done." }] } });
    const usage = recovered ? { input_tokens: 18000, output_tokens: 2000 } : { input_tokens: turns === 1 ? 9000 : 11000, output_tokens: 1000 };
    send({ type: "result", subtype: "success", is_error: false, result: "Done.", session_id: "same-provider-session", uuid: randomUUID(), usage, total_cost_usd: recovered ? 2 : turns === 1 ? 1 : 1.2 });
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
      await client.close();
      await stopSidecar(dataDir);
      running?.child?.kill("SIGKILL");
      client = await connect();
      const restored = await client.waitForTurnSettled(threadId, { after: second });
      expect(settledTurnUsage(restored)?.totalTokens).toBe(2_000);
      const recovered = await client.startTurn({ threadId, text: "recovered" });
      const recoveredResult = await client.waitForTurnSettled(threadId, { after: recovered });
      expect(recoveredResult.state).toBe("completed");
      expect(recoveredResult.usageEpoch).toBeTypeOf("string");
      expect(recoveredResult.usageEpoch).not.toBe(secondResult.usageEpoch);
      expect(settledTurnUsage(recoveredResult)).toMatchObject({
        totalTokens: 20_000,
        reportedUsd: 2,
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
