import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { app, autoUpdater, BrowserWindow, ipcMain } from "electron";
import { type IUpdateSource, UpdateSourceType, updateElectronApp } from "update-electron-app";

/** MAIN → renderer push AND renderer → MAIN invoke (replay) channel for readiness. */
export const UPDATE_READY_CHANNEL = "rennet:update-ready";
/** Renderer → MAIN one-way: the user confirmed the restart-into-update prompt. */
export const UPDATE_APPLY_CHANNEL = "rennet:update-apply";

export interface UpdateReadyInfo {
  /** Release name when the platform updater reported one; absent otherwise. */
  version?: string;
}

export interface UpdateReadiness {
  /** The cached downloaded-and-ready state, null until a download completes. */
  readonly ready: UpdateReadyInfo | null;
  /** Record a completed download and push it to every subscriber. */
  markDownloaded(releaseName?: unknown): void;
  /** Also notify this listener on each readiness change (the tray subscribes here). */
  subscribe(listener: (info: UpdateReadyInfo) => void): void;
}

/**
 * Testable readiness core: caches the downloaded release so late-loading (or
 * reloading) renderers can replay it, and broadcasts each transition. The badge
 * means READY — this only ever fires off a completed download, so the UI can
 * never claim an update it doesn't have (spec: desktop-update-notification).
 * The renderer badge rides the injected `broadcast`; the tray rides `subscribe` —
 * one store, two surfaces, no IPC hop between them.
 */
export function createUpdateReadiness(broadcast: (info: UpdateReadyInfo) => void): UpdateReadiness {
  let ready: UpdateReadyInfo | null = null;
  const listeners: Array<(info: UpdateReadyInfo) => void> = [];
  return {
    get ready() {
      return ready;
    },
    markDownloaded(releaseName?: unknown): void {
      const name = typeof releaseName === "string" ? releaseName.trim() : "";
      ready = name ? { version: name } : {};
      broadcast(ready);
      for (const listener of listeners) listener(ready);
    },
    subscribe(listener: (info: UpdateReadyInfo) => void): void {
      listeners.push(listener);
    },
  };
}

/** Numeric x.y.z compare; true when `a` is strictly newer than `b`. */
function semverGt(a: string, b: string): boolean {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  }
  return false;
}

/**
 * Squirrel.Windows stages a downloaded update as a SIBLING `app-<version>`
 * directory and, from then on, answers every later `checkForUpdates` with
 * "update-not-available" — the comparison runs against the newest STAGED
 * version, not the running one. So `update-downloaded` fires exactly once, in
 * whichever run performed the staging; if the badge push was missed there (a
 * wedged renderer, a crash, a headless run — all observed on the lancelot test
 * bed, 2026-08-19), no later event ever comes and the badge never shows.
 *
 * This detects that state at boot: when a sibling app dir carries a strictly
 * newer version than the running one, the update is already downloaded and
 * ready, and the readiness cache can say so without any updater event.
 * Returns the newest staged version, or null (non-Squirrel layouts, macOS —
 * where Squirrel.Mac applies on relaunch instead of staging siblings — and any
 * read failure: best-effort, never throws).
 */
export function stagedNewerVersion(
  execPath: string,
  runningVersion: string,
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (platform !== "win32") return null;
  try {
    const appDir = dirname(execPath);
    if (!/^app-\d+\.\d+\.\d+$/.test(basename(appDir))) return null;
    let best: string | null = null;
    for (const entry of readdirSync(resolve(appDir, ".."))) {
      const match = /^app-(\d+\.\d+\.\d+)$/.exec(entry);
      if (!match?.[1]) continue;
      const version = match[1];
      if (semverGt(version, runningVersion) && (best === null || semverGt(version, best))) {
        best = version;
      }
    }
    return best;
  } catch {
    return null;
  }
}

/**
 * Where the update check looks, per platform.
 *
 * win32 asks GitHub Releases DIRECTLY: Squirrel.Windows only needs `RELEASES` +
 * the nupkg at a base URL, and GitHub's `releases/latest/download/` redirect
 * serves exactly that — no intermediary, no update.electronjs.org cache (which
 * was observed serving a stale "no update" for ~87 minutes after a publish,
 * lancelot 2026-08-19). darwin stays on update.electronjs.org: Squirrel.Mac
 * needs the JSON feed that service derives, and macOS auto-update is a silent
 * no-op until builds are Developer-ID-signed (issue #42) anyway. Either way the
 * egress is GitHub-or-Electron infrastructure only — no Rennet backend.
 */
export function updateSourceFor(platform: NodeJS.Platform, repo: string): IUpdateSource {
  if (platform === "win32") {
    return {
      type: UpdateSourceType.StaticStorage,
      baseUrl: `https://github.com/${repo}/releases/latest/download`,
    };
  }
  return { type: UpdateSourceType.ElectronPublicUpdateService, repo };
}

/** How often the staged-sibling state is re-checked (matches the update-check cadence). */
export const STAGED_POLL_INTERVAL_MS = 5 * 60_000;

/** The public repository updates come from. */
export const UPDATE_REPO = "rbutera/rennet";

// Wire the Electron-maintained update client. `notifyUser: false`
// replaces the stock modal with the in-app badge flow: `update-downloaded` is
// cached + pushed to the renderer (badge on the Rennet logo), and the renderer's
// confirm calls back on UPDATE_APPLY_CHANNEL to restart into the new version.
// "5 minutes" is the library's documented minimum interval.
//
// The whole thing is best-effort. On an unsigned / ad-hoc-signed macOS build
// Squirrel.Mac's autoUpdater rejects with an error (code signing is mandatory
// there, blocked on the Developer ID cert, issue #42). We catch the throw AND
// attach a quiet "error" listener so that degrades to a silent no-op instead of a
// crash or a nag dialog: no download ever completes, so no badge ever shows.
/** What `startAutoUpdate` hands back so the tray shares the SAME readiness + apply path. */
export interface AutoUpdateHandle {
  /** The live readiness store (also pushed to the renderer badge) — read `.ready` for state. */
  readonly readiness: UpdateReadiness;
  /** Apply the staged update through the existing restart path (quitAndInstall / stub respawn). */
  readonly applyUpdate: () => void;
}

export function startAutoUpdate(
  isTrustedUrl: (value: string) => boolean,
  logger: Console = console,
  detectStaged: () => string | null = () => stagedNewerVersion(process.execPath, app.getVersion()),
): AutoUpdateHandle {
  // Whether THIS run saw the live update-downloaded event. When readiness was
  // seeded from a previously staged update instead, electron's quitAndInstall
  // may no-op (its internal downloaded flag is unset), so apply falls back to
  // respawning the Squirrel stub - which always launches the newest staged
  // version - and quitting.
  let liveDownloadSeen = false;
  const readiness = createUpdateReadiness((info) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.webContents.isDestroyed()) window.webContents.send(UPDATE_READY_CHANNEL, info);
    }
  });

  // The one apply path, shared by the renderer badge's confirm AND the tray's
  // "Restart Rennet to update" line — never applies without an explicit choice (spec).
  const applyUpdate = (): void => {
    if (!liveDownloadSeen && process.platform === "win32") {
      const stub = resolve(dirname(process.execPath), "..", basename(process.execPath));
      if (existsSync(stub)) {
        spawn(stub, [], { detached: true, stdio: "ignore" }).unref();
        app.quit();
        return;
      }
    }
    autoUpdater.quitAndInstall();
  };

  // Replay for late subscribers: the preload invokes this once on load, so a
  // renderer that mounts (or reloads) after the download still badges.
  ipcMain.handle(UPDATE_READY_CHANNEL, (event) => {
    if (!event.senderFrame || !isTrustedUrl(event.senderFrame.url)) return null;
    return readiness.ready;
  });

  // The update NEVER applies without the user choosing it (spec) — this only
  // fires from the renderer's explicit confirm.
  ipcMain.on(UPDATE_APPLY_CHANNEL, (event) => {
    if (!event.senderFrame || !isTrustedUrl(event.senderFrame.url)) return;
    applyUpdate();
  });

  autoUpdater.on("update-downloaded", (_event, _notes, releaseName) => {
    liveDownloadSeen = true;
    logger.error("[auto-update] update-downloaded:", releaseName);
    readiness.markDownloaded(releaseName);
  });
  // The badge is a DISK FACT, not an event hope. Electron's live
  // `update-downloaded` was observed not firing on real Windows installs
  // (lancelot, 2026-08-19: stagings performed live by the running app produced
  // no event/badge, while every boot-seeded instance badged instantly). So the
  // staged-sibling state is polled on the same cadence as the update checks —
  // boot AND every 5 minutes — and readiness seeds whenever a newer version
  // appears. Idempotent: re-seeding fires only on a version CHANGE, so a
  // standing badge never re-broadcasts into churn. The live event above stays
  // wired as the fast path for whenever it does fire.
  let lastSeeded: string | null = null;
  const seedFromDisk = (): void => {
    const staged = detectStaged();
    if (staged && staged !== lastSeeded) {
      lastSeeded = staged;
      readiness.markDownloaded(staged);
    }
  };
  seedFromDisk();
  const stagedPoll = setInterval(seedFromDisk, STAGED_POLL_INTERVAL_MS);
  // Never hold the process open past app quit.
  stagedPoll.unref?.();
  autoUpdater.on("error", (error) => {
    logger.error("[auto-update] updater error (ignored):", error?.message ?? error);
  });
  try {
    updateElectronApp({
      updateSource: updateSourceFor(process.platform, UPDATE_REPO),
      updateInterval: "5 minutes",
      notifyUser: false,
      logger,
    });
  } catch (error) {
    logger.error(
      "[auto-update] failed to initialise (ignored):",
      error instanceof Error ? error.message : error,
    );
  }
  return { readiness, applyUpdate };
}
