import { PROTOCOL_VERSION } from "@rennet/protocol";
import { createRennetServer } from "../../../packages/server/src/create-server";
import { removeDaemonFile, writeDaemonFile } from "../../../packages/server/src/daemon-file";
import { loadScriptedHarnessPlan } from "../../../packages/server/src/scripted-harness-plan";

async function main(): Promise<void> {
  const dataDir = process.env.RENNET_USER_DATA;
  const planPath = process.env.RENNET_OWNER_LOOP_PLAN;
  if (dataDir === undefined || planPath === undefined) {
    throw new Error("owner-loop test daemon requires RENNET_USER_DATA and RENNET_OWNER_LOOP_PLAN");
  }
  const serverVersion = process.env.RENNET_SERVER_VERSION ?? "0.0.0-dev";

  const testHarnessPort = loadScriptedHarnessPlan(planPath);
  const server = await createRennetServer({
    dataDir,
    env: process.env,
    serverVersion,
    testHarnessPort,
  });
  writeDaemonFile(dataDir, {
    pid: process.pid,
    wsPort: server.wsPort,
    host: server.wsHost,
    protocolVersion: PROTOCOL_VERSION,
    version: serverVersion,
    startedAt: new Date().toISOString(),
  });

  let stopped = false;
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    server.shutdown();
    removeDaemonFile(dataDir, process.pid);
  };
  process.once("SIGTERM", () => {
    stop();
    process.exit(0);
  });
  process.once("SIGINT", () => {
    stop();
    process.exit(0);
  });
  process.once("disconnect", stop);
  process.send?.({ kind: "ready" });
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
