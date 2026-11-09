// The detached daemon entry (issue #379). `createRennetServer` composed the runtime in
// phase 1 and put it behind a WS wire in phase 2; here it becomes a process with a
// lifetime of its own. `runDaemon` starts the server, publishes the `daemon.json` claim,
// and shuts down cleanly on SIGTERM/SIGINT (removing the claim). The desktop shell spawns
// this detached (via `ELECTRON_RUN_AS_NODE`) and `rennet serve` runs it in the foreground
// — the CLI is just the second client. This module has NO import side effects; the actual
// process entry is `daemon-main.ts`, so tests and the CLI can drive `runDaemon` directly.

import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  defaultForgeDetectionDeps,
  hydrateProcessPath,
  largeFileSkipIndexPath,
  resolveGitHubCliToken,
  withLargeFileSkipIndex,
} from "@rennet/adapters";
import { PROTOCOL_VERSION } from "@rennet/protocol";
import { createRennetServer } from "./create-server";
import { type DaemonInfo, removeDaemonFile, writeDaemonFile } from "./daemon-file";

/**
 * Rennet's data directory: `~/.rennet`, one root on every platform.
 *
 * It used to mirror Electron's `app.getPath("userData")` layout, which produced a path
 * (`~/Library/Application Support/Rennet` on macOS) that never held anything — because
 * only three of the twelve stores honoured `dataDir` and the other nine went straight to
 * `~/.rennet`. The app was split across two roots, and the nine could find the user's home
 * directory from anywhere, including a test harness that believed it was hermetic.
 *
 * `~/.rennet` is the root the stores already used, so unifying here moves no data. It is
 * also the root a user can `ls`, which is the point of a local-first product's state.
 */
export function defaultDataDir(): string {
  return join(homedir(), ".rennet");
}

export interface DaemonConfig {
  readonly dataDir: string;
  readonly serverVersion: string;
  readonly env: NodeJS.ProcessEnv;
  /** Directory of a built browser UI to serve (issue #381). Absent ⇒ headless. */
  readonly uiDist?: string;
  /** This daemon's own server bundle — what a WSL daemon UPDATE delivers into the distro
   *  (C17, #534). `spawnDaemon` passes the entry it launched; absent ⇒ no bundle to deliver. */
  readonly hostBundlePath?: string;
  /** The vendored T3 Code server bundle the sidecar runs (t3code-sidecar-chat). Absent ⇒ the
   *  chat engine reports `degraded` naming the missing bundle. */
  readonly t3BundlePath?: string;
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
  const { values } = parseArgs({
    args: [...argv],
    allowPositionals: false,
    strict: true,
    options: {
      "data-dir": { type: "string" },
      "server-version": { type: "string" },
      "ui-dist": { type: "string" },
      "host-bundle": { type: "string" },
      "t3-bundle": { type: "string" },
    },
  });
  const dataDir = values["data-dir"] ?? env.RENNET_USER_DATA ?? defaultDataDir();
  return {
    dataDir,
    serverVersion: values["server-version"] ?? env.RENNET_SERVER_VERSION ?? "0.0.0-dev",
    env,
    uiDist: values["ui-dist"],
    hostBundlePath: values["host-bundle"],
    t3BundlePath: values["t3-bundle"],
  };
}

export interface RunningDaemon {
  readonly info: DaemonInfo;
  /**
   * Shut the server down, then remove the claim. Idempotent. Settles once every installer
   * the server was running has ended (or `STOP_WAIT_MS` has passed), so a caller that exits
   * the process after it leaves no Homebrew run behind; the claim goes at that same moment.
   */
  readonly stop: () => Promise<void>;
}

/** How long a stopping daemon waits for its installers to end before it exits anyway. An
 *  aborted installer gets SIGTERM, then SIGKILL two seconds later, so this is the backstop. */
export const STOP_WAIT_MS = 5_000;

/**
 * The daemon's one `stop`: shut the server down, and remove the `daemon.json` claim only once
 * that shutdown has SETTLED (or the `waitMs` backstop has passed). The claim's disappearance is
 * what `rennet stop` and the desktop launcher wait for, so removing it first told them the
 * daemon was gone while it was still ending its installers — and a launcher that then
 * replaced the bundle or started a new daemon raced the old one. Idempotent.
 */
export function createDaemonStop(input: {
  readonly dataDir: string;
  readonly pid: number;
  /** Late-bound: `null` while the server is still being created. */
  readonly shutdown: () => Promise<void> | null;
  readonly waitMs?: number;
}): () => Promise<void> {
  let stopping: Promise<void> | null = null;
  return (): Promise<void> => {
    if (stopping !== null) return stopping;
    const settled = input.shutdown() ?? Promise.resolve();
    stopping = new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(backstop);
        removeDaemonFile(input.dataDir, input.pid);
        resolve();
      };
      const backstop = setTimeout(done, input.waitMs ?? STOP_WAIT_MS);
      backstop.unref?.();
      void settled.catch(() => undefined).finally(done);
    });
    return stopping;
  };
}

/**
 * Start the server, publish the claim, and (unless `installSignalHandlers` is false) shut
 * down cleanly on SIGTERM/SIGINT or on `POST /shutdown` — one `stop`, three ways in (#820).
 * Resolves once the listener is up and `daemon.json` is written. The daemon runs headless: no repository dialog (a windowed client forwards an
 * explicit `path` per #379) and no OS `openPath` fallback — the editor launch still works
 * through the resolved executables.
 */
export async function runDaemon(
  config: DaemonConfig,
  options: { installSignalHandlers?: boolean } = {},
): Promise<RunningDaemon> {
  const forgeDetectionDeps = defaultForgeDetectionDeps();
  // `stop` closes the server, so it has to exist before the listener can serve `/shutdown` —
  // and the listener starts inside `createRennetServer`. The shutdown is therefore late-bound
  // through this holder, which is assigned in the same synchronous run as the claim write.
  let shutdownServer: (() => Promise<void>) | null = null;
  const stop = createDaemonStop({
    dataDir: config.dataDir,
    pid: process.pid,
    shutdown: () => shutdownServer?.() ?? null,
  });
  /** Stop, then end the process once the stop has settled. */
  const stopAndExit = (): void => {
    void stop().finally(() => process.exit(0));
  };
  // A shutdown REQUEST ends the process, exactly as SIGTERM does: the launcher is waiting on
  // this pid to exit so the installer can replace the bundle it runs from. A daemon driven
  // in-process by a test (`installSignalHandlers: false`) owns no process to end, so it
  // quiesces and returns — the same asymmetry the signal handlers already have.
  const exitOnShutdownRequest = options.installSignalHandlers !== false;

  const server = await createRennetServer({
    dataDir: config.dataDir,
    env: config.env,
    serverVersion: config.serverVersion,
    // The GitHub egress transport for a daemon: Node's global `fetch` (no Electron `net`).
    httpFetch: fetch,
    // Production reads the live `gh` credential on every operation. Direct server
    // construction has no CLI source unless a test or alternate shell supplies one.
    githubCliToken: () => resolveGitHubCliToken(forgeDetectionDeps),
    uiDist: config.uiDist,
    hostBundlePath: config.hostBundlePath,
    t3BundlePath: config.t3BundlePath,
    onShutdownRequest: () => {
      if (exitOnShutdownRequest) stopAndExit();
      else void stop();
    },
  });
  shutdownServer = () => server.shutdown();

  const info: DaemonInfo = {
    pid: process.pid,
    wsPort: server.wsPort,
    host: server.wsHost,
    protocolVersion: PROTOCOL_VERSION,
    version: config.serverVersion,
    startedAt: new Date().toISOString(),
  };
  writeDaemonFile(config.dataDir, info);

  if (options.installSignalHandlers !== false) {
    const onSignal = (): void => stopAndExit();
    process.once("SIGTERM", onSignal);
    process.once("SIGINT", onSignal);
  }

  return { info, stop };
}

/** Write PATH-resolution fall-throughs to stderr, which the desktop shell sends to daemon.log. */
function hydrateDaemonPath(env: NodeJS.ProcessEnv): Promise<string> {
  return hydrateProcessPath(env, {
    warn: (message) => process.stderr.write(`rennet daemon: PATH: ${message}\n`),
  });
}

export interface StartDaemonDeps {
  /** The environment every child inherits: `process.env` in a real process. */
  readonly env: NodeJS.ProcessEnv;
  /** Resolve the user's tool PATH into `env.PATH` (daemon-process-environment). */
  readonly hydratePath: (env: NodeJS.ProcessEnv) => Promise<unknown>;
  readonly run: typeof runDaemon;
}

/**
 * The process entries' start (`daemon-main.ts` and `rennet serve`): hydrate PATH, THEN run.
 *
 * A Dock-launched app hands its detached daemon launchd's bare PATH, and every git child
 * (and the LFS filter, hooks and credential helpers git runs) inherits it — so a required
 * `git-lfs` in `/opt/homebrew/bin` was "command not found" for the daemon's whole life.
 * Assigning the resolved PATH to `process.env` before `runDaemon` means every execa call
 * inherits it with no per-call-site change, and the order is load-bearing: `runDaemon`
 * snapshots `process.env.PATH` into its forge detection deps the moment it starts.
 * Resolution never throws and never blocks past its own timeouts, so the daemon still starts
 * when every step fails.
 */
export async function startDaemon(
  config: DaemonConfig,
  deps: StartDaemonDeps = { env: process.env, hydratePath: hydrateDaemonPath, run: runDaemon },
): Promise<RunningDaemon> {
  await deps.hydratePath(deps.env);
  includeLargeFileSkipIndex(deps.env, config.dataDir);
  return deps.run(config);
}

/**
 * Point every child of this daemon at its skip-mode index (review-preparation-reliability,
 * large-file-checkout): one `include.path` entry in `GIT_CONFIG_*`, appended after any the
 * environment already carries. The index names the checkouts whose project skips Git LFS
 * content, so every later git command a daemon child runs in one of them — the T3 sidecar's
 * seat, chat and round threads, the cold utility turns, Rennet's own git — leaves large files
 * as placeholders there, and runs exactly as the user's config says everywhere else. Set
 * BEFORE `runDaemon`, for the same reason PATH is: the sidecar copies this environment the
 * moment it spawns, and it lives as long as the daemon.
 */
export function includeLargeFileSkipIndex(env: NodeJS.ProcessEnv, dataDir: string): void {
  Object.assign(env, withLargeFileSkipIndex(env, largeFileSkipIndexPath(dataDir)));
}
