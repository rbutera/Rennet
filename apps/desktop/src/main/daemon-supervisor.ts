// The desktop shell as a supervisor + client (#379, design D3/D6). The shell no longer
// embeds the server: it finds a healthy daemon or spawns one, then connects the renderer
// to it over the same WS wire phase 2 established. Quitting the app leaves the daemon (and
// any running review turn) alive — that is the whole feature. On incompatible protocol skew
// the shell restarts the daemon with no dialog (Rule Zero; a personal product updates the
// daemon with the app); in-flight turns from the old daemon fold to `interrupted` via the
// existing lazy crash recovery.

import { join, resolve } from "node:path";
import {
  type DaemonInfo,
  type DaemonVerdict,
  findHealthyDaemon,
  readDaemonFile,
  type SpawnDaemonOptions,
  spawnDaemon,
  waitForHealthy,
} from "@rennet/server";
import { app } from "electron";

/**
 * The bundled daemon entry to spawn. Packaged: the un-asar'd copy (forge `asarUnpack`), so
 * a plain Node process can load it from a real path. Dev: the sibling of the running main
 * bundle (`dist/main` → `dist/server`).
 */
export function resolveServerBundle(): string {
  if (app.isPackaged) {
    return join(`${app.getAppPath()}.unpacked`, "dist", "server", "index.cjs");
  }
  return resolve(__dirname, "../server/index.cjs");
}

/** Wait (bounded) for the signalled daemon to stop owning the claim after SIGTERM. */
async function waitForClaimGone(
  dataDir: string,
  expectedPid: number,
  readClaim: (dataDir: string) => DaemonInfo | null,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (readClaim(dataDir)?.pid === expectedPid && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
  }
}

export interface DaemonSupervisorDeps {
  readonly probe: (dataDir: string) => Promise<DaemonVerdict>;
  readonly spawn: (options: SpawnDaemonOptions) => unknown;
  readonly waitForHealthy: typeof waitForHealthy;
  readonly kill: (pid: number, signal: "SIGTERM") => void;
  readonly readClaim: (dataDir: string) => DaemonInfo | null;
  readonly execPath: string;
  readonly entryPath: string;
  readonly serverVersion: string;
  readonly env: NodeJS.ProcessEnv;
  readonly warn: (message: string) => void;
}

/**
 * Return the WS port of a healthy daemon for `dataDir`, spawning or skew-restarting one as
 * needed. The spawn runs the Electron binary as Node (`ELECTRON_RUN_AS_NODE`, detached,
 * logging to `<dataDir>/daemon.log`) so the packaged app needs no system Node.
 */
export async function ensureDaemon(
  dataDir: string,
  overrides: Partial<DaemonSupervisorDeps> = {},
): Promise<number> {
  const deps: DaemonSupervisorDeps = {
    probe: findHealthyDaemon,
    spawn: spawnDaemon,
    waitForHealthy,
    kill: (pid, signal) => {
      process.kill(pid, signal);
    },
    readClaim: readDaemonFile,
    execPath: process.execPath,
    entryPath: resolveServerBundle(),
    serverVersion: app.getVersion(),
    env: process.env,
    warn: console.warn,
    ...overrides,
  };
  const verdict = await deps.probe(dataDir);
  if (verdict.kind === "healthy") {
    if (verdict.identity.version === deps.serverVersion) return verdict.identity.wsPort;
    // The daemon updates WITH the app (the header doctrine) — but the protocol-only
    // check let a healthy OLDER daemon serve a freshly updated shell forever.
    // Field bug, lancelot 2026-08-19: a 0.2.14 daemon kept serving a 0.2.18 app,
    // so none of the shipped egress fixes were live and every project.detail
    // waited undici's 300s headers timeout ("5 minutes plus"). Same posture as
    // protocol skew: restart with no ceremony. In-flight turns fold to
    // `interrupted` via lazy crash recovery; reviews persist in sqlite.
    deps.warn(
      `rennet: daemon runs server ${verdict.identity.version} but the app ships ${deps.serverVersion}; restarting the bundled daemon`,
    );
    try {
      deps.kill(verdict.claim.pid, "SIGTERM");
    } catch {
      // Already gone — the next spawn overwrites the stale claim.
    }
    await waitForClaimGone(dataDir, verdict.claim.pid, deps.readClaim);
  }

  if (verdict.kind === "incompatible") {
    // D3/D10: the shell owns the newer bundle, so it restarts — no ceremony, just a log.
    deps.warn(
      `rennet: daemon protocol ${verdict.identity.protocolVersion} is incompatible (${verdict.reason}); restarting the bundled daemon`,
    );
    try {
      deps.kill(verdict.claim.pid, "SIGTERM");
    } catch {
      // Already gone — the next spawn overwrites the stale claim.
    }
    await waitForClaimGone(dataDir, verdict.claim.pid, deps.readClaim);
  }

  const spawnEnv: NodeJS.ProcessEnv = { ...deps.env };
  // The daemon resolves its own data dir from `--data-dir` (spawnDaemon passes it), so the
  // shell's RENNET_USER_DATA override must not double-apply from the inherited env.
  delete spawnEnv.RENNET_USER_DATA;
  deps.spawn({
    dataDir,
    execPath: deps.execPath,
    entryPath: deps.entryPath,
    serverVersion: deps.serverVersion,
    env: spawnEnv,
  });
  const healthy = await deps.waitForHealthy(dataDir);
  return healthy.identity.wsPort;
}
