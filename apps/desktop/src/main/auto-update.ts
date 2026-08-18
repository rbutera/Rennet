import { autoUpdater, BrowserWindow, ipcMain } from "electron";
import { updateElectronApp } from "update-electron-app";

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
}

/**
 * Testable readiness core: caches the downloaded release so late-loading (or
 * reloading) renderers can replay it, and broadcasts each transition. The badge
 * means READY — this only ever fires off a completed download, so the UI can
 * never claim an update it doesn't have (spec: desktop-update-notification).
 */
export function createUpdateReadiness(broadcast: (info: UpdateReadyInfo) => void): UpdateReadiness {
  let ready: UpdateReadyInfo | null = null;
  return {
    get ready() {
      return ready;
    },
    markDownloaded(releaseName?: unknown): void {
      const name = typeof releaseName === "string" ? releaseName.trim() : "";
      ready = name ? { version: name } : {};
      broadcast(ready);
    },
  };
}

// Wire the Electron-maintained update client: update-electron-app polls
// update.electronjs.org, which resolves this repo's public GitHub Releases and
// serves the newest build. No Rennet backend is involved. `notifyUser: false`
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
export function startAutoUpdate(
  isTrustedUrl: (value: string) => boolean,
  logger: Console = console,
): void {
  const readiness = createUpdateReadiness((info) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.webContents.isDestroyed()) window.webContents.send(UPDATE_READY_CHANNEL, info);
    }
  });

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
    autoUpdater.quitAndInstall();
  });

  autoUpdater.on("update-downloaded", (_event, _notes, releaseName) => {
    readiness.markDownloaded(releaseName);
  });
  autoUpdater.on("error", (error) => {
    logger.error("[auto-update] updater error (ignored):", error?.message ?? error);
  });
  try {
    updateElectronApp({ updateInterval: "5 minutes", notifyUser: false, logger });
  } catch (error) {
    logger.error(
      "[auto-update] failed to initialise (ignored):",
      error instanceof Error ? error.message : error,
    );
  }
}
