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

export interface EnsureWindowDeps {
  /** A live (non-destroyed) window already exists. */
  readonly hasWindow: () => boolean;
  /** Bring the existing window forward. */
  readonly focusExisting: () => void;
  /** Restore the macOS Dock icon before recreating (no-op off darwin / when already shown). */
  readonly showDock: () => void;
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
  deps.showDock();
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
 * The tray image for a platform + update state. macOS uses TEMPLATE images (alpha-only,
 * recoloured to the menu-bar theme); the wide mark. Windows/Linux use the visible square
 * badge. Electron auto-loads the `@2x` sibling for HiDPI. The `Update` variants carry a dot.
 */
function trayImage(dir: string, platform: NodeJS.Platform, updateReady: boolean) {
  const file =
    platform === "darwin"
      ? updateReady
        ? "rennetUpdateTemplate.png"
        : "rennetTemplate.png"
      : updateReady
        ? "rennetUpdate.png"
        : "rennet.png";
  const image = nativeImage.createFromPath(join(dir, file));
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
  /** Read afresh on every menu build so the Quit label matches live daemon state. */
  readonly ownedDaemonRunning: () => boolean;
  readonly openWindow: () => void;
  readonly applyUpdate: () => void;
  readonly quitCompletely: () => void;
}

export interface TrayController {
  /** Flip the staged-update state: swaps the icon variant and rebuilds the menu. */
  setUpdateReady(ready: boolean): void;
  destroy(): void;
}

/**
 * Wire the Electron Tray. Thin: it owns the icon and the context menu, rebuilding both from
 * `buildTrayMenuTemplate` whenever the update state flips (the menu also re-reads the owned-
 * daemon state each build, so the Quit label stays truthful without extra plumbing).
 */
export function createTray(deps: CreateTrayDeps): TrayController {
  const dir = trayAssetDir(deps.baseDir, deps.resourcesPath, deps.isPackaged);
  let updateReady = false;
  const tray = new Tray(trayImage(dir, deps.platform, updateReady));
  tray.setToolTip("Rennet");

  const rebuild = () => {
    tray.setImage(trayImage(dir, deps.platform, updateReady));
    const template = buildTrayMenuTemplate(
      { ownedDaemonRunning: deps.ownedDaemonRunning(), updateReady, version: deps.version },
      {
        openWindow: deps.openWindow,
        applyUpdate: deps.applyUpdate,
        quitCompletely: deps.quitCompletely,
      },
    );
    tray.setContextMenu(Menu.buildFromTemplate(template));
  };
  rebuild();

  return {
    setUpdateReady(ready: boolean) {
      if (ready === updateReady) return;
      updateReady = ready;
      rebuild();
    },
    destroy() {
      tray.destroy();
    },
  };
}
