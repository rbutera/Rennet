// The desktop shell as a supervisor + client (#379, design D3/D6). The shell no longer
// embeds the server: it finds a healthy daemon or spawns one, then connects the renderer
// to it over the same WS wire phase 2 established. Quitting the app leaves the daemon (and
// any running review turn) alive — that is the whole feature. On incompatible protocol skew
// the shell restarts the daemon with no dialog (Rule Zero; a personal product updates the
// daemon with the app); in-flight turns from the old daemon fold to `interrupted` via the
// existing lazy crash recovery.

import { join, resolve } from "node:path";
import { findHealthyDaemon, readDaemonFile, spawnDaemon, waitForHealthy } from "@rennet/server";
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

/** Wait (bounded) for a daemon at `dataDir` to stop publishing its claim after a SIGTERM. */
async function waitForClaimGone(dataDir: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (readDaemonFile(dataDir) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
  }
}

/**
 * Return the WS port of a healthy daemon for `dataDir`, spawning or skew-restarting one as
 * needed. The spawn runs the Electron binary as Node (`ELECTRON_RUN_AS_NODE`, detached,
 * logging to `<dataDir>/daemon.log`) so the packaged app needs no system Node.
 */
export async function ensureDaemon(dataDir: string): Promise<number> {
  const verdict = await findHealthyDaemon(dataDir);
  if (verdict.kind === "healthy") return verdict.identity.wsPort;

  if (verdict.kind === "incompatible") {
    // D3/D10: the shell owns the newer bundle, so it restarts — no ceremony, just a log.
    console.warn(
      `rennet: daemon protocol ${verdict.identity.protocolVersion} is incompatible (${verdict.reason}); restarting the bundled daemon`,
    );
    try {
      process.kill(verdict.claim.pid, "SIGTERM");
    } catch {
      // Already gone — the next spawn overwrites the stale claim.
    }
    await waitForClaimGone(dataDir);
  }

  const spawnEnv: NodeJS.ProcessEnv = { ...process.env };
  // The daemon resolves its own data dir from `--data-dir` (spawnDaemon passes it), so the
  // shell's RENNET_USER_DATA override must not double-apply from the inherited env.
  delete spawnEnv.RENNET_USER_DATA;
  spawnDaemon({
    dataDir,
    execPath: process.execPath,
    entryPath: resolveServerBundle(),
    serverVersion: app.getVersion(),
    env: spawnEnv,
  });
  const healthy = await waitForHealthy(dataDir);
  return healthy.identity.wsPort;
}
