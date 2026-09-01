import { PROTOCOL_VERSION } from "@rennet/protocol";
import { createRennetServer, removeDaemonFile, writeDaemonFile } from "@rennet/server";
import { loadScriptedCodexExecutor, loadScriptedHarnessPlan } from "@rennet/server/testing";

async function main(): Promise<void> {
  const dataDir = process.env.RENNET_USER_DATA;
  const planPath = process.env.RENNET_OWNER_LOOP_PLAN;
  if (dataDir === undefined || planPath === undefined) {
    throw new Error("owner-loop test daemon requires RENNET_USER_DATA and RENNET_OWNER_LOOP_PLAN");
  }
  const serverVersion = process.env.RENNET_SERVER_VERSION ?? "0.0.0-dev";

  // The plan declares which provider it presents as. A `codex` plan gets BOTH seats it
  // would really have on a Codex-only host — the agentic port for the coding round and
  // the utility executor the council's Codex seats run on — and no Claude seat at all.
  const testHarnessPort = loadScriptedHarnessPlan(planPath);
  const server = await createRennetServer({
    dataDir,
    env: process.env,
    serverVersion,
    testHarnessPort,
    ...(testHarnessPort.descriptor.id === "codex"
      ? { testCodexExecutor: loadScriptedCodexExecutor(planPath) }
      : {}),
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
