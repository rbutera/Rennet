import { autoUpdater } from "electron";
import { updateElectronApp } from "update-electron-app";

// Wire the Electron-maintained update client: update-electron-app polls
// update.electronjs.org, which resolves this repo's public GitHub Releases and
// serves the newest signed build. No Rennet backend is involved. The default
// download-then-restart prompt is fine (it is the product telling the user an
// update is ready, not a consent gate) — we add no settings toggle around it.
//
// The whole thing is best-effort. On an unsigned / ad-hoc-signed macOS build
// Squirrel.Mac's autoUpdater rejects with an error (code signing is mandatory
// there, blocked on the Developer ID cert, issue #42). We catch the throw AND
// attach a quiet "error" listener so that degrades to a silent no-op instead of a
// crash or a nag dialog. Windows works the moment Squirrel artifacts ship in a
// release; until macOS releases are Developer-ID-signed it simply does nothing.
export function startAutoUpdate(logger: Console = console): void {
  autoUpdater.on("error", (error) => {
    logger.error("[auto-update] updater error (ignored):", error?.message ?? error);
  });
  try {
    updateElectronApp({ updateInterval: "1 hour", logger });
  } catch (error) {
    logger.error(
      "[auto-update] failed to initialise (ignored):",
      error instanceof Error ? error.message : error,
    );
  }
}
