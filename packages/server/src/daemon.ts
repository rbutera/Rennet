// The detached daemon entry (issue #379). `createRennetServer` composed the runtime in
// phase 1 and put it behind a WS wire in phase 2; here it becomes a process with a
// lifetime of its own. `runDaemon` starts the server, publishes the `daemon.json` claim,
// and shuts down cleanly on SIGTERM/SIGINT (removing the claim). The desktop shell spawns
// this detached (via `ELECTRON_RUN_AS_NODE`) and `rennet serve` runs it in the foreground
// — the CLI is just the second client. This module has NO import side effects; the actual
// process entry is `daemon-main.ts`, so tests and the CLI can drive `runDaemon` directly.

import { homedir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_VERSION } from "@rennet/protocol";
import { createRennetServer } from "./create-server";
import { type DaemonInfo, removeDaemonFile, writeDaemonFile } from "./daemon-file";

/** Electron's `app.getPath("userData")` layout, replicated for a daemon running as plain Node. */
export function defaultDataDir(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "Rennet");
  }
  if (platform === "win32") {
    return join(env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "Rennet");
  }
  return join(env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "Rennet");
}

export interface DaemonConfig {
  readonly dataDir: string;
  readonly serverVersion: string;
  readonly env: NodeJS.ProcessEnv;
}

/**
 * Resolve the daemon's config from argv + env: `--data-dir` wins, then `RENNET_USER_DATA`
 * (the same override the shell honors), then the platform default. `--server-version`
 * (the shell passes `app.getVersion()`) names the identity `rennet status` prints.
 */
export function resolveDaemonConfig(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): DaemonConfig {
  const dataDirArg = readFlag(argv, "--data-dir");
  const versionArg = readFlag(argv, "--server-version");
  const dataDir = dataDirArg ?? env.RENNET_USER_DATA ?? defaultDataDir(process.platform, env);
  return {
    dataDir,
    serverVersion: versionArg ?? env.RENNET_SERVER_VERSION ?? "0.0.0-dev",
    env,
  };
}

/** Read `--flag value` or `--flag=value` from argv; undefined if absent. */
function readFlag(argv: readonly string[], flag: string): string | undefined {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === flag) return argv[i + 1];
    if (arg?.startsWith(`${flag}=`)) return arg.slice(flag.length + 1);
  }
  return undefined;
}

/** The GitHub egress transport for a daemon: Node's global `fetch` (no Electron `net`). */
function nodeHttpFetch(
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
): Promise<{
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}> {
  return fetch(url, init).then((res) => ({
    status: res.status,
    headers: res.headers,
    text: () => res.text(),
  }));
}

export interface RunningDaemon {
  readonly info: DaemonInfo;
  /** Shut the server down and remove the claim. Idempotent. */
  readonly stop: () => void;
}

/**
 * Start the server, publish the claim, and (unless `installSignalHandlers` is false) shut
 * down cleanly on SIGTERM/SIGINT. Resolves once the listener is up and `daemon.json` is
 * written. The daemon runs headless: no repository dialog (a windowed client forwards an
 * explicit `path` per #379) and no OS `openPath` fallback — the editor launch still works
 * through the resolved executables.
 */
export async function runDaemon(
  config: DaemonConfig,
  options: { installSignalHandlers?: boolean } = {},
): Promise<RunningDaemon> {
  const server = await createRennetServer({
    dataDir: config.dataDir,
    env: config.env,
    serverVersion: config.serverVersion,
    httpFetch: nodeHttpFetch,
  });

  const info: DaemonInfo = {
    pid: process.pid,
    wsPort: server.wsPort,
    protocolVersion: PROTOCOL_VERSION,
    version: config.serverVersion,
    startedAt: new Date().toISOString(),
  };
  writeDaemonFile(config.dataDir, info);

  let stopped = false;
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    server.shutdown();
    removeDaemonFile(config.dataDir);
  };

  if (options.installSignalHandlers !== false) {
    const onSignal = (): void => {
      stop();
      process.exit(0);
    };
    process.once("SIGTERM", onSignal);
    process.once("SIGINT", onSignal);
  }

  return { info, stop };
}
