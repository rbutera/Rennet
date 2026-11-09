import type { ElectronApplication, Page } from "@playwright/test";
import type { BrowserWindow } from "electron";

export interface WindowSize {
  width: number;
  height: number;
}

/**
 * Resize the REAL native window that owns `page` so its content area is exactly `size`,
 * and wait until the page itself reports that size.
 *
 * Why this exists, and why nothing in `e2e/` may use viewport emulation instead: the specs
 * used to call Playwright's `page.setViewportSize` (and the marketing capture a sized CDP
 * `Emulation.setDeviceMetricsOverride`). Both squeeze the page to a size INSIDE the Electron
 * window while the native window stays as it is. On a 4K display the window opened large,
 * the area outside the emulated viewport was never painted, and every re-squeeze strobed it
 * one frame white, one frame black, at the display's refresh rate. It gave the person
 * watching a headache. So the window is resized instead, the way a user resizes it, and the
 * lint config bans `setViewportSize` and sized device-metrics overrides under `apps/desktop/e2e`.
 *
 * In the main process, on the window Playwright maps to `page`, it:
 *   • leaves fullscreen first (a fullscreen window ignores a resize), waiting for the
 *     asynchronous macOS transition to finish;
 *   • unmaximizes;
 *   • lowers the window's minimum size when the request is under it (the product's
 *     980×640 floor would otherwise clamp the narrow layouts the specs check);
 *   • sets the CONTENT size, so `innerWidth`×`innerHeight` equal the request whatever the
 *     platform's frame adds.
 * A size larger than the screen needs `enableLargerThanScreen` on macOS, which the main
 * process sets when the harness launches it (`RENNET_E2E_WINDOW=1`, `launchRennet`).
 */
export async function resizeAppWindow(
  application: ElectronApplication,
  page: Page,
  size: WindowSize,
): Promise<void> {
  const windowHandle = await application.browserWindow(page);
  try {
    await windowHandle.evaluate(async (win: BrowserWindow, target: WindowSize) => {
      if (win.isFullScreen()) {
        await new Promise<void>((resolveLeave, rejectLeave) => {
          const timer = setTimeout(
            () => rejectLeave(new Error("the window did not leave fullscreen within 10s")),
            10_000,
          );
          win.once("leave-full-screen", () => {
            clearTimeout(timer);
            resolveLeave();
          });
          win.setFullScreen(false);
        });
      }
      if (win.isMaximized()) win.unmaximize();
      const [minimumWidth = 0, minimumHeight = 0] = win.getMinimumSize();
      if (target.width < minimumWidth || target.height < minimumHeight) {
        win.setMinimumSize(
          Math.min(minimumWidth, target.width),
          Math.min(minimumHeight, target.height),
        );
      }
      win.setContentSize(target.width, target.height);
    }, size);
  } finally {
    await windowHandle.dispose();
  }
  try {
    await page.waitForFunction(
      (target) => window.innerWidth === target.width && window.innerHeight === target.height,
      size,
      { timeout: 10_000 },
    );
  } catch (error) {
    const actual = await page.evaluate(() => `${window.innerWidth}×${window.innerHeight}`);
    throw new Error(
      `resizeAppWindow: asked for ${size.width}×${size.height}, the page reports ${actual}`,
      { cause: error },
    );
  }
}
