// The desktop shell's ambient presence (tray-presence): a menu-bar (macOS) / system-tray
// (Windows/Linux) icon that keeps Rennet reachable while window-less, offers the only
// complete-exit path, and surfaces a staged update. The MENU-TEMPLATE derivation is a pure
// function (exported, unit-tested across every state); the Electron wiring below it is thin.

import { join } from "node:path";
import type { MenuItemConstructorOptions } from "electron";
import { Menu, nativeImage, Tray } from "electron";

/** Live state the tray menu reflects — all truthful, computed from the running system. */
export interface TrayMenuState {
  /** An owned local daemon is running (claim present + alive) — decides the Quit label. */
  readonly ownedDaemonRunning: boolean;
  /** An update is staged and ready to apply — shows the update line and the dot icon. */
  readonly updateReady: boolean;
  /** The app version, shown on the (disabled) version line. */
  readonly version: string;
}

/** What the menu items do. Kept separate from state so the derivation stays pure/testable. */
export interface TrayMenuActions {
  readonly openWindow: () => void;
  readonly applyUpdate: () => void;
  readonly quitCompletely: () => void;
}

/**
 * The tray menu, exactly as the spec fixes it: Open Rennet; a "Restart Rennet to update"
 * line ONLY when an update is staged; a version line; and one Quit item whose label states
 * what it will do. Separators group the version/quit block visually — they are not menu
 * ENTRIES. Pure: no Electron, no I/O — the same state always yields the same template.
 */
export function buildTrayMenuTemplate(
  state: TrayMenuState,
  actions: TrayMenuActions,
): MenuItemConstructorOptions[] {
  const items: MenuItemConstructorOptions[] = [
    { label: "Open Rennet", click: () => actions.openWindow() },
  ];
  if (state.updateReady) {
    items.push({ label: "Restart Rennet to update", click: () => actions.applyUpdate() });
  }
  items.push(
    { type: "separator" },
    { label: `Rennet ${state.version}`, enabled: false },
    {
      label: state.ownedDaemonRunning ? "Quit Rennet and stop daemon" : "Quit Rennet",
      click: () => actions.quitCompletely(),
    },
  );
  return items;
}

export interface DockCoordinatorDeps {
  /** `app.dock.show()` — resolves once the Dock icon is actually back. */
  readonly show: () => Promise<void> | void;
  /** `app.dock.hide()`. */
  readonly hide: () => void;
  readonly now: () => number;
  readonly setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  readonly clearTimer: (handle: ReturnType<typeof setTimeout>) => void;
  /**
   * How long the Dock icon must stay visible before a hide takes effect. macOS silently
   * ignores `app.dock.hide()` within ~1s of a `show()`, so a too-soon hide is DEFERRED to
   * this boundary instead of being dropped. Default 1100ms (just past the documented window).
   */
  readonly minVisibleMs?: number;
}

export interface DockCoordinator {
  /** Show the Dock icon (cancelling any pending hide) and resolve once it is back. */
  show(): Promise<void>;
  /** Hide the Dock icon — deferred to the min-visible boundary if `show()` was too recent. */
  requestHide(): void;
}

/**
 * Coordinates macOS Dock show/hide so the tray-residency toggle never trips the documented
 * "hide is a no-op within ~1s of show" quirk (tray-presence, review finding 4). A hide that
 * arrives too soon after a show is deferred to the min-visible boundary; a subsequent show
 * cancels that pending hide, so a rapid close→reopen leaves the icon up. All timing is
 * injected, so the machine is unit-testable without a real clock or Dock.
 */
export function createDockCoordinator(deps: DockCoordinatorDeps): DockCoordinator {
  const minVisibleMs = deps.minVisibleMs ?? 1100;
  let shownAt = Number.NEGATIVE_INFINITY;
  let pendingHide: ReturnType<typeof setTimeout> | null = null;
  const cancelPending = () => {
    if (pendingHide !== null) {
      deps.clearTimer(pendingHide);
      pendingHide = null;
    }
  };
  return {
    async show() {
      cancelPending();
      await deps.show();
      shownAt = deps.now();
    },
    requestHide() {
      cancelPending();
      const elapsed = deps.now() - shownAt;
      if (elapsed >= minVisibleMs) {
        deps.hide();
        return;
      }
      pendingHide = deps.setTimer(() => {
        pendingHide = null;
        deps.hide();
      }, minVisibleMs - elapsed);
    },
  };
}

export interface EnsureWindowDeps {
  /** A live (non-destroyed) window already exists. */
  readonly hasWindow: () => boolean;
  /** Bring the existing window forward. */
  readonly focusExisting: () => void;
  /** Restore the macOS Dock icon before recreating (awaited — no-op off darwin). */
  readonly showDock: () => Promise<void> | void;
  /** Recreate a window through the normal window-creation path. */
  readonly recreate: () => Promise<void> | void;
}

/**
 * Focus-or-recreate, shared by the tray's "Open Rennet" and macOS `activate` (tray-presence):
 * if a window is live, focus it; otherwise show the Dock again and recreate one. The recreated
 * renderer re-attaches to the still-running daemon over the WS bridge, so a mid-stream review
 * repaints its current state.
 */
export async function ensureWindow(deps: EnsureWindowDeps): Promise<void> {
  if (deps.hasWindow()) {
    deps.focusExisting();
    return;
  }
  await deps.showDock();
  await deps.recreate();
}

/**
 * The `window-all-closed` behaviour under tray residency: closing the last window does NOT
 * quit and stops NOTHING — the daemon and every stream outlive it (the #379 invariant). On
 * macOS the Dock icon hides while window-less; `ensureWindow` shows it again on reopen.
 */
export function residencyOnAllWindowsClosed(deps: { readonly hideDock: () => void }): void {
  deps.hideDock();
}

export interface SingleInstanceDeps {
  /** `app.requestSingleInstanceLock()` — true for the first (primary) instance. */
  readonly requestLock: () => boolean;
  /** Quit this (losing) instance. */
  readonly quit: () => void;
  /** Runs only in the primary — e.g. wire `second-instance` to focus the existing window. */
  readonly onPrimary: () => void;
}

/**
 * Single-instance startup (tray-presence, review finding 3). Under close-to-tray a relaunch
 * (Windows Start menu, macOS reopen) would otherwise spin up a SECOND app + tray, and one
 * could stop the daemon out from under the other. The primary instance holds the lock and
 * wires its `second-instance` handler to surface the existing window; a later instance fails
 * to get the lock and quits immediately. Returns whether this instance is the primary.
 */
export function acquireSingleInstance(deps: SingleInstanceDeps): boolean {
  if (!deps.requestLock()) {
    deps.quit();
    return false;
  }
  deps.onPrimary();
  return true;
}

/**
 * Where the checked-in tray icons live at runtime. Packaged: copied beside the app via
 * forge `extraResource` (→ `<resources>/tray`). Dev/source: `brand/exports/tray` at the
 * repo root, reached from the compiled main's dir (`dist/main`), the same relative walk
 * `brandWindowIcon` uses.
 */
export function trayAssetDir(baseDir: string, resourcesPath: string, isPackaged: boolean): string {
  return isPackaged ? join(resourcesPath, "tray") : join(baseDir, "../../../../brand/exports/tray");
}

/**
 * The tray icon FILE for a platform + update state. macOS uses TEMPLATE PNGs (alpha-only,
 * recoloured to the menu-bar theme; the wide mark, `@2x` sibling auto-loaded for HiDPI).
 * Windows uses the multi-resolution `.ico` (the native tray format — the shell picks the
 * size per DPI). Linux uses the square PNG. The `Update` variants carry a dot.
 */
export function trayIconFile(platform: NodeJS.Platform, updateReady: boolean): string {
  if (platform === "darwin") return updateReady ? "rennetUpdateTemplate.png" : "rennetTemplate.png";
  if (platform === "win32") return updateReady ? "rennetUpdate.ico" : "rennet.ico";
  return updateReady ? "rennetUpdate.png" : "rennet.png";
}

function trayImage(dir: string, platform: NodeJS.Platform, updateReady: boolean) {
  const image = nativeImage.createFromPath(join(dir, trayIconFile(platform, updateReady)));
  if (platform === "darwin") image.setTemplateImage(true);
  return image;
}

export interface CreateTrayDeps {
  /** The compiled main's directory (`__dirname`) for dev asset resolution. */
  readonly baseDir: string;
  readonly resourcesPath: string;
  readonly isPackaged: boolean;
  readonly platform: NodeJS.Platform;
  readonly version: string;
  /**
   * Health-verify whether an owned daemon is running (drives the Quit LABEL). Async because a
   * truthful answer requires a `/healthz` probe, not just a live-pid check — a stale claim
   * whose pid was reused must not read as "running" (review finding 5). Its result is CACHED;
   * the tray re-probes on a low-frequency interval and whenever a lifecycle event calls
   * `refreshOwnership()`, so `rennet stop`, a crash, or a late spawn stops the label lying.
   */
  readonly probeOwnedDaemon: () => Promise<boolean>;
  readonly openWindow: () => void;
  readonly applyUpdate: () => void;
  readonly quitCompletely: () => void;
  /** How often to re-probe owned-daemon state for the label. Default 20s. */
  readonly ownershipRefreshMs?: number;
  readonly setInterval?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  readonly clearInterval?: (handle: ReturnType<typeof setInterval>) => void;
}

export interface TrayController {
  /** Flip the staged-update state: swaps the icon variant and rebuilds the menu. */
  setUpdateReady(ready: boolean): void;
  /** Re-probe owned-daemon state now (call on window lifecycle events / Windows tray click). */
  refreshOwnership(): Promise<void>;
  destroy(): void;
}

/**
 * Wire the Electron Tray. Thin: it owns the icon and the context menu, rebuilding both when a
 * signal that the menu reflects actually changes — the staged-update flip OR a change in the
 * CACHED, health-verified owned-daemon state. macOS `setContextMenu` has no pre-open hook, so
 * the label cannot be computed lazily on open; instead it is refreshed by a low-frequency
 * probe and by `refreshOwnership()` (wired to window lifecycle + the Windows tray click), and
 * a rebuild only happens when the probed value actually differs (review finding 5).
 */
export function createTray(deps: CreateTrayDeps): TrayController {
  const dir = trayAssetDir(deps.baseDir, deps.resourcesPath, deps.isPackaged);
  const schedule = deps.setInterval ?? setInterval;
  const unschedule = deps.clearInterval ?? clearInterval;
  let updateReady = false;
  let ownedRunning = false;
  const tray = new Tray(trayImage(dir, deps.platform, updateReady));
  tray.setToolTip("Rennet");

  const rebuild = () => {
    tray.setImage(trayImage(dir, deps.platform, updateReady));
    const template = buildTrayMenuTemplate(
      { ownedDaemonRunning: ownedRunning, updateReady, version: deps.version },
      {
        openWindow: deps.openWindow,
        applyUpdate: deps.applyUpdate,
        quitCompletely: deps.quitCompletely,
      },
    );
    tray.setContextMenu(Menu.buildFromTemplate(template));
  };
  rebuild();

  const refreshOwnership = async () => {
    const next = await deps.probeOwnedDaemon();
    if (next !== ownedRunning) {
      ownedRunning = next;
      rebuild();
    }
  };
  // Seed the label from a first probe, then keep it fresh on a low-frequency timer.
  void refreshOwnership();
  const timer = schedule(() => void refreshOwnership(), deps.ownershipRefreshMs ?? 20_000);

  return {
    setUpdateReady(ready: boolean) {
      if (ready === updateReady) return;
      updateReady = ready;
      rebuild();
    },
    refreshOwnership,
    destroy() {
      unschedule(timer);
      tray.destroy();
    },
  };
}
